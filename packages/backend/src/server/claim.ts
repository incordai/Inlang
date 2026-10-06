/**
 * @az server claim
 * Purpose: claim-before-run schema changes: one of N starting servers applies each unit; probes make a crashed unit resumable.
 * Spec: docs/data-spec.md §6.3
 * Exports: runClaimed, ClaimStore, ClaimTiming, CLAIM_TIMING, MigrationBusy, Probe, probeDone, probeFor
 * Edit guide: one statement per query, no locks or transactions (the pooler rule); every wait is bounded.
 * Tests: packages/backend/test/claim.test.ts
 */

/**
 * Several instances starting at once must not apply the same schema change
 * twice. Advisory locks are excluded (they are session state, which a
 * transaction-mode pooler does not keep), so each unit is CLAIMED by
 * inserting its row before it runs: the primary key lets exactly one insert
 * win. The winner refreshes its claim while it works; a loser waits, bounded,
 * for the row to say "applied", and takes over only a claim whose owner has
 * stopped refreshing it (a crashed process).
 *
 * A takeover cannot know whether the crashed owner's last statement landed —
 * DDL is not transactional on MySQL. So every statement carries a PROBE: an
 * introspection query that says whether its effect is already present, and a
 * statement whose effect is present is recorded, not re-run.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { Db, Value } from './db.ts';

export interface ClaimTiming {
  /** How long a loser waits for the winner before giving up. */
  readonly waitMs: number;
  /** A claim not refreshed for this long belongs to a process that died. */
  readonly staleMs: number;
  /** How often the owner refreshes its claim. */
  readonly heartbeatMs: number;
  /** How often a loser re-reads the row. */
  readonly pollMs: number;
}

/** data-spec §6.3: a loser waits 30 s. The owner refreshes 3× per stale window. */
export const CLAIM_TIMING: ClaimTiming = { waitMs: 30_000, staleMs: 15_000, heartbeatMs: 5_000, pollMs: 250 };

/** Another live instance is still applying this unit; this one stops rather than wait without bound. */
export class MigrationBusy extends Error {}

/** One unit's row in a history table. */
export interface ClaimStore {
  /** The row: when it was last claimed, and whether it is applied. Null when there is none. */
  read(): Promise<{ readonly claimedAt: number; readonly applied: boolean } | null>;
  /** Insert the claim; false when another instance's row is already there. */
  claim(at: number): Promise<boolean>;
  /** Move the claim from `from` to `to` — only if nobody else moved it first. */
  refresh(from: number, to: number): Promise<boolean>;
  /** Mark it applied, only if this instance still holds the claim made at `held`. */
  finish(held: number, at: number): Promise<boolean>;
  /** Give up a claim whose work failed, so a restart retries at once instead of waiting it out. */
  release(held: number): Promise<void>;
}

/**
 * Run `work` once across every instance sharing the database. Returns
 * 'ran' when this instance applied it, 'done' when another had.
 */
export async function runClaimed(
  store: ClaimStore,
  work: () => Promise<void>,
  label: string,
  now: () => number = Date.now,
  timing: ClaimTiming = CLAIM_TIMING,
): Promise<'ran' | 'done'> {
  let held: number | null = null;
  const first = await store.read();
  if (first?.applied) return 'done';
  if (!first) {
    const t = now();
    if (await store.claim(t)) held = t;
  }
  const deadline = now() + timing.waitMs;
  while (held === null) {
    const row = await store.read();
    if (row?.applied) return 'done';
    const t = now();
    if (row === null) {
      // The row vanished (an operator cleared it): claim afresh.
      if (await store.claim(t)) held = t;
    } else if (t - row.claimedAt >= timing.staleMs) {
      const to = Math.max(t, row.claimedAt + 1);
      if (await store.refresh(row.claimedAt, to)) held = to;
    }
    if (held !== null) break;
    if (t >= deadline) {
      throw new MigrationBusy(`${label}: another instance is still applying it — this one stops; start it again once that finishes`);
    }
    await sleep(timing.pollMs);
  }

  // Refreshed while the work runs, so a slow statement is never taken over.
  // Refreshes run one after another, and the last settles before `finish`
  // reads the claim time it must match.
  let lost = false;
  let beating: Promise<void> = Promise.resolve();
  const beat = setInterval(() => {
    beating = beating.then(async () => {
      const from = held!;
      const to = Math.max(now(), from + 1);
      try {
        if (await store.refresh(from, to)) held = to; else lost = true;
      } catch {
        lost = true;
      }
    });
  }, timing.heartbeatMs);
  const stop = async () => {
    clearInterval(beat);
    await beating;
  };
  try {
    await work();
  } catch (e) {
    await stop();
    if (!lost) await store.release(held);
    throw e;
  }
  await stop();
  if (lost || !(await store.finish(held, Math.max(now(), held + 1)))) {
    throw new MigrationBusy(`${label}: this instance's claim was taken over while it worked — start it again`);
  }
  return 'ran';
}

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

/** Whether a statement's effect is already in the database. */
export interface Probe {
  readonly kind: 'table' | 'column' | 'index' | 'fk';
  /** The physical table (for an index on MySQL, and for a column or fk). */
  readonly table: string;
  /** The column, index or constraint name; absent for a table. */
  readonly name?: string;
  /** The effect is done when the object is present (create, add, rename) or absent (drop). */
  readonly done: 'present' | 'absent';
}

/** The introspection query per engine. Names are parameters, never SQL text. */
function probeQuery(db: Db, p: Probe): { sql: string; params: Value[] } {
  const schema = db.dialect === 'postgres' ? 'current_schema()' : 'DATABASE()';
  switch (p.kind) {
    case 'table':
      return db.dialect === 'sqlite'
        ? { sql: "SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = ?", params: [p.table] }
        : { sql: `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = ?`, params: [p.table] };
    case 'column':
      return db.dialect === 'sqlite'
        ? { sql: 'SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ?', params: [p.table, p.name!] }
        : { sql: `SELECT 1 AS x FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ? AND column_name = ?`, params: [p.table, p.name!] };
    case 'index':
      if (db.dialect === 'sqlite') return { sql: "SELECT 1 AS x FROM sqlite_schema WHERE type = 'index' AND name = ?", params: [p.name!] };
      if (db.dialect === 'postgres') return { sql: 'SELECT 1 AS x FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?', params: [p.name!] };
      return { sql: 'SELECT 1 AS x FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', params: [p.table, p.name!] };
    case 'fk':
      // SQLite foreign keys are part of their column; no unit adds one alone.
      if (db.dialect === 'sqlite') throw new Error('probe: SQLite has no separate foreign keys');
      return { sql: `SELECT 1 AS x FROM information_schema.table_constraints WHERE constraint_schema = ${schema} AND table_name = ? AND constraint_name = ? AND constraint_type = 'FOREIGN KEY'`, params: [p.table, p.name!] };
  }
}

/** True when the probed effect is already in place. */
export async function probeDone(db: Db, p: Probe): Promise<boolean> {
  const q = probeQuery(db, p);
  const present = (await db.get(q.sql, q.params)) !== undefined;
  return p.done === 'present' ? present : !present;
}

/**
 * The probe for one of the auth migrations' statements, read from its text:
 * they only ever create a table, create an index or add a column. A
 * statement of any other shape is a programming error, caught by the tests.
 */
export function probeFor(statement: string): Probe {
  const table = /^\s*CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(statement);
  if (table) return { kind: 'table', table: table[1], done: 'present' };
  const index = /^\s*CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)/i.exec(statement);
  if (index) return { kind: 'index', table: index[2], name: index[1], done: 'present' };
  const column = /^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(statement);
  if (column) return { kind: 'column', table: column[1], name: column[2], done: 'present' };
  throw new Error(`no probe for migration statement: ${statement.slice(0, 60)}`);
}
