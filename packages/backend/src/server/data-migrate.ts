/**
 * @az server data-migrate
 * Purpose: apply the data schema's steps on start: one recorded, claimed, probed statement at a time; destructive steps only when confirmed.
 * Spec: docs/data-spec.md §6.3
 * Exports: migrateData, DataStep, DataUnit, Guard, Param, DestructivePending, GuardFailed, DATA_HISTORY, AUDIT_STEP
 * Edit guide: never run a destructive step without its confirmation; a guard reports a count, never values.
 * Tests: packages/backend/test/data-ddl.test.ts
 */

/**
 * The data tables' history is its own table, `az_data_migrations`, so the
 * auth schema and the data schema never share version numbers. Every unit
 * (one statement, or one guard) has its own row: MySQL cannot roll DDL back,
 * so a failure resumes at the unit that failed instead of leaving a step
 * half-applied forever. Each unit is claimed before it runs (claim.ts), so
 * one of several starting instances applies it.
 *
 * Copied into a generated server only when the site declares data; imports
 * only its siblings and node built-ins.
 */

import { isUniqueViolation, type Db } from './db.ts';
import { probeDone, runClaimed, type ClaimStore, type ClaimTiming, type Probe } from './claim.ts';
import type { Database } from './env.ts';

export type Param = string | number | null;

/** A query that must count zero rows before the unit's change runs. */
export interface Guard {
  readonly sql: string;
  readonly params: readonly Param[];
  /** Said with the count when the guard fails — never the values. */
  readonly message: string;
}

/** One statement, or one guard. */
export interface DataUnit {
  readonly sql?: string;
  readonly params?: readonly Param[];
  readonly probe?: Probe;
  readonly guard?: Guard;
}

export interface DataStep {
  readonly version: number;
  /** Loses data or may be refused: applied only when confirmed (data-spec §6.3). */
  readonly destructive: boolean;
  readonly summary: readonly string[];
  readonly units: { readonly [D in Database]: readonly DataUnit[] };
}

const MYSQL_TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

export const DATA_HISTORY: { readonly [D in Database]: string } = {
  sqlite: 'CREATE TABLE IF NOT EXISTS az_data_migrations (version INTEGER NOT NULL, step INTEGER NOT NULL, claimed_at INTEGER NOT NULL, applied_at INTEGER, PRIMARY KEY (version, step))',
  postgres: 'CREATE TABLE IF NOT EXISTS az_data_migrations (version INTEGER NOT NULL, step INTEGER NOT NULL, claimed_at BIGINT NOT NULL, applied_at BIGINT, PRIMARY KEY (version, step))',
  mysql: `CREATE TABLE IF NOT EXISTS az_data_migrations (version INT NOT NULL, step INT NOT NULL, claimed_at BIGINT NOT NULL, applied_at BIGINT, PRIMARY KEY (version, step)) ${MYSQL_TABLE}`,
};

/**
 * The admin audit table (data-spec §11): who wrote what row, when — never a
 * value. A system step, version 0, ahead of the site's own steps (which
 * start at 1); applied once, claimed like any other unit.
 */
export const AUDIT_STEP: DataStep = {
  version: 0,
  destructive: false,
  summary: ['create the admin audit table az_data_audit'],
  units: {
    sqlite: [
      { sql: 'CREATE TABLE IF NOT EXISTS az_data_audit (id TEXT PRIMARY KEY, admin TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL)' },
      { sql: 'CREATE INDEX IF NOT EXISTS az_data_audit_at ON az_data_audit (at, id)' },
    ],
    postgres: [
      { sql: 'CREATE TABLE IF NOT EXISTS az_data_audit (id TEXT PRIMARY KEY, admin TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, at BIGINT NOT NULL)' },
      { sql: 'CREATE INDEX IF NOT EXISTS az_data_audit_at ON az_data_audit (at, id)' },
    ],
    mysql: [
      { sql: `CREATE TABLE IF NOT EXISTS az_data_audit (id VARCHAR(36) PRIMARY KEY, admin VARCHAR(36) NOT NULL, tbl VARCHAR(63) NOT NULL, row_id VARCHAR(36) NOT NULL, action VARCHAR(8) NOT NULL, at BIGINT NOT NULL, INDEX az_data_audit_at (at, id)) ${MYSQL_TABLE}` },
    ],
  },
};

/** Destructive steps are pending and not confirmed: the server must not start. */
export class DestructivePending extends Error {
  readonly steps: readonly DataStep[];
  constructor(steps: readonly DataStep[]) {
    super(`data: step${steps.length === 1 ? '' : 's'} ${steps.map((s) => s.version).join(', ')} would lose data (${steps.flatMap((s) => s.summary).join('; ')}). `
      + `Back up the database, then run: node src/main.ts --migrate --confirm ${steps[steps.length - 1].version}`);
    this.steps = steps;
  }
}

/** A guard found rows the destructive change would break. */
export class GuardFailed extends Error {}

function unitClaim(db: Db, version: number, step: number): ClaimStore {
  const key = [version, step] as const;
  return {
    async read() {
      const row = await db.get('SELECT claimed_at, applied_at FROM az_data_migrations WHERE version = ? AND step = ?', key);
      return row ? { claimedAt: Number(row.claimed_at), applied: row.applied_at !== null } : null;
    },
    async claim(at) {
      try {
        await db.run('INSERT INTO az_data_migrations (version, step, claimed_at, applied_at) VALUES (?, ?, ?, NULL)', [...key, at]);
        return true;
      } catch (e) {
        if (isUniqueViolation(e)) return false;
        throw e;
      }
    },
    refresh: async (from, to) =>
      (await db.run('UPDATE az_data_migrations SET claimed_at = ? WHERE version = ? AND step = ? AND claimed_at = ? AND applied_at IS NULL', [to, ...key, from])) === 1,
    finish: async (held, at) =>
      (await db.run('UPDATE az_data_migrations SET applied_at = ? WHERE version = ? AND step = ? AND claimed_at = ? AND applied_at IS NULL', [at, ...key, held])) === 1,
    release: async (held) => {
      await db.run('DELETE FROM az_data_migrations WHERE version = ? AND step = ? AND claimed_at = ? AND applied_at IS NULL', [...key, held]);
    },
  };
}

export interface MigrateDataOptions {
  /** Destructive steps up to this version may run (`--migrate --confirm N`; `az dev` passes Infinity). */
  readonly confirm?: number;
  readonly now?: () => number;
  readonly timing?: ClaimTiming;
}

/**
 * Apply every data step not yet applied, in order. Stops before the first
 * unconfirmed destructive step — throwing DestructivePending, having applied
 * the safe steps before it — so the server refuses to start and says how to
 * go on. Returns the versions this instance applied units of.
 */
export async function migrateData(db: Db, steps: readonly DataStep[], options: MigrateDataOptions = {}): Promise<number[]> {
  await db.run(DATA_HISTORY[db.dialect]);
  const done = new Map<number, number>();
  for (const row of await db.all('SELECT version, COUNT(*) AS n FROM az_data_migrations WHERE applied_at IS NOT NULL GROUP BY version')) {
    done.set(Number(row.version), Number(row.n));
  }
  const pending = [AUDIT_STEP, ...steps].filter((s) => (done.get(s.version) ?? 0) < s.units[db.dialect].length);
  const blocked = pending.filter((s) => s.destructive && s.version > (options.confirm ?? 0));
  const applied: number[] = [];
  for (const step of pending) {
    if (blocked.length > 0 && step.version >= blocked[0].version) throw new DestructivePending(blocked);
    let ran = false;
    const units = step.units[db.dialect];
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const outcome = await runClaimed(unitClaim(db, step.version, i + 1), async () => {
        if (unit.sql !== undefined && unit.probe && (await probeDone(db, unit.probe))) return;
        const guard = unit.guard;
        const counted = async () => {
          if (!guard) return;
          const n = Number((await db.get(guard.sql, guard.params))?.n ?? 0);
          if (n > 0) throw new GuardFailed(`data step ${step.version}: ${guard.message} — ${n} row${n === 1 ? '' : 's'}; change them first`);
        };
        await counted();
        if (unit.sql === undefined) return;
        try {
          await db.run(unit.sql, unit.params ?? []);
        } catch (e) {
          // A row written between the count and a unique index: count again,
          // and say how many. The driver's own message is never passed on —
          // some engines quote the duplicated value in it.
          if (!guard || !isUniqueViolation(e)) throw e;
          await counted();
          throw new GuardFailed(`data step ${step.version}: ${guard.message} — rows changed while it ran; start the server again`);
        }
      }, `data step ${step.version}.${i + 1}`, options.now, options.timing);
      if (outcome === 'ran') ran = true;
    }
    // The audit table (version 0) is the server's own; only the site's steps are reported.
    if (ran && step.version > 0) applied.push(step.version);
  }
  return applied;
}
