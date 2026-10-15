/**
 * @az server chat-usage
 * Purpose: the chat's daily counters — the az_chat_usage table, its migrations, one upsert per answer, the 400-day sweep.
 * Spec: docs/backend-spec.md §3, §5 (the chat block spec §6.5, §6.7)
 * Exports: CHAT_MIGRATIONS, migrateChat, createUsage, utcDay, Usage, USAGE_KEEP_DAYS
 * Edit guide: counts only, never text or a person; one statement per answer (pooler-safe); append a step, never edit a shipped one.
 * Tests: packages/backend/test/chat-usage.test.ts
 */

/**
 * The budget must survive a restart (chat-spec §6.5), so what chat has
 * spent is a table: one row per UTC day with token and message counts. It
 * holds nothing about anyone — no address, no account, no text — so there
 * is nothing in it to erase for a person (§6.7).
 *
 * Only a site with chat gets the table. Its steps are versioned per engine
 * like the auth migrations (migrations.ts) but recorded in their own
 * history table, `az_chat_migrations`, and run through the same claim
 * (claim.ts): one of several starting instances applies each step, and a
 * statement already in effect is not run again.
 *
 * Copied into a generated server; imports only its siblings.
 */

import { probeDone, probeFor, runClaimed, type ClaimStore, type ClaimTiming } from './claim.ts';
import { isUniqueViolation, type Db } from './db.ts';

const MYSQL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows older than this many days are swept (§6.7). */
export const USAGE_KEEP_DAYS = 400;

type PerEngine<T> = { readonly sqlite: T; readonly postgres: T; readonly mysql: T };

export const CHAT_MIGRATIONS: {
  readonly table: PerEngine<string>;
  readonly steps: readonly { version: number; sql: PerEngine<readonly string[]> }[];
} = {
  table: {
    sqlite: 'CREATE TABLE IF NOT EXISTS az_chat_migrations (version INTEGER PRIMARY KEY, claimed_at INTEGER NOT NULL, applied_at INTEGER)',
    postgres: 'CREATE TABLE IF NOT EXISTS az_chat_migrations (version INTEGER PRIMARY KEY, claimed_at BIGINT NOT NULL, applied_at BIGINT)',
    mysql: `CREATE TABLE IF NOT EXISTS az_chat_migrations (version INT PRIMARY KEY, claimed_at BIGINT NOT NULL, applied_at BIGINT) ${MYSQL}`,
  },
  steps: [
    {
      version: 1,
      sql: {
        sqlite: ['CREATE TABLE az_chat_usage (day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, messages INTEGER NOT NULL, dropped INTEGER NOT NULL)'],
        postgres: ['CREATE TABLE az_chat_usage (day VARCHAR(10) PRIMARY KEY, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, messages BIGINT NOT NULL, dropped BIGINT NOT NULL)'],
        mysql: [`CREATE TABLE az_chat_usage (day VARCHAR(10) PRIMARY KEY, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, messages BIGINT NOT NULL, dropped BIGINT NOT NULL) ${MYSQL}`],
      },
    },
  ],
};

function chatClaim(db: Db, version: number): ClaimStore {
  return {
    async read() {
      const row = await db.get('SELECT claimed_at, applied_at FROM az_chat_migrations WHERE version = ?', [version]);
      return row ? { claimedAt: Number(row.claimed_at), applied: row.applied_at !== null } : null;
    },
    async claim(at) {
      try {
        await db.run('INSERT INTO az_chat_migrations (version, claimed_at, applied_at) VALUES (?, ?, NULL)', [version, at]);
        return true;
      } catch (e) {
        if (isUniqueViolation(e)) return false;
        throw e;
      }
    },
    refresh: async (from, to) =>
      (await db.run('UPDATE az_chat_migrations SET claimed_at = ? WHERE version = ? AND claimed_at = ? AND applied_at IS NULL', [to, version, from])) === 1,
    finish: async (held, at) =>
      (await db.run('UPDATE az_chat_migrations SET applied_at = ? WHERE version = ? AND claimed_at = ? AND applied_at IS NULL', [at, version, held])) === 1,
    release: async (held) => {
      await db.run('DELETE FROM az_chat_migrations WHERE version = ? AND claimed_at = ? AND applied_at IS NULL', [version, held]);
    },
  };
}

/** Apply every chat step not yet recorded; the versions this call applied. */
export async function migrateChat(db: Db, now: () => number = Date.now, timing?: ClaimTiming): Promise<number[]> {
  await db.run(CHAT_MIGRATIONS.table[db.dialect]);
  const applied: number[] = [];
  for (const m of CHAT_MIGRATIONS.steps) {
    const outcome = await runClaimed(chatClaim(db, m.version), async () => {
      for (const statement of m.sql[db.dialect]) {
        if (!(await probeDone(db, probeFor(statement)))) await db.run(statement);
      }
    }, `chat migration ${m.version}`, now, timing);
    if (outcome === 'ran') applied.push(m.version);
  }
  return applied;
}

/** The UTC day of a time, `YYYY-MM-DD` — the budget's unit; it rolls over at 00:00 UTC. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** One answer's counts, as one statement (§6.5): the day's row made or added to. */
function upsert(dialect: Db['dialect']): string {
  const cols = 'day, input_tokens, output_tokens, messages, dropped';
  if (dialect === 'mysql') {
    return `INSERT INTO az_chat_usage (${cols}) VALUES (?, ?, ?, 1, ?) AS n ON DUPLICATE KEY UPDATE `
      + 'input_tokens = az_chat_usage.input_tokens + n.input_tokens, output_tokens = az_chat_usage.output_tokens + n.output_tokens, '
      + 'messages = az_chat_usage.messages + 1, dropped = az_chat_usage.dropped + n.dropped';
  }
  return `INSERT INTO az_chat_usage (${cols}) VALUES (?, ?, ?, 1, ?) ON CONFLICT (day) DO UPDATE SET `
    + 'input_tokens = az_chat_usage.input_tokens + excluded.input_tokens, output_tokens = az_chat_usage.output_tokens + excluded.output_tokens, '
    + 'messages = az_chat_usage.messages + 1, dropped = az_chat_usage.dropped + excluded.dropped';
}

export interface Usage {
  /** Tokens (input + output) spent on `day`. */
  spent(day: string): Promise<number>;
  /** Count one answer on `day`. */
  add(day: string, input: number, output: number, dropped: number): Promise<void>;
  /** The day's row, for a report: null when nothing was spent. */
  row(day: string): Promise<{ input: number; output: number; messages: number; dropped: number } | null>;
  /** Remove days older than USAGE_KEEP_DAYS before `now`; how many went. */
  sweep(now: number): Promise<number>;
}

export function createUsage(db: Db): Usage {
  const sql = upsert(db.dialect);
  return {
    async spent(day) {
      const r = await db.get('SELECT input_tokens, output_tokens FROM az_chat_usage WHERE day = ?', [day]);
      return r ? Number(r.input_tokens) + Number(r.output_tokens) : 0;
    },
    async add(day, input, output, dropped) {
      await db.run(sql, [day, input, output, dropped]);
    },
    async row(day) {
      const r = await db.get('SELECT input_tokens, output_tokens, messages, dropped FROM az_chat_usage WHERE day = ?', [day]);
      return r ? { input: Number(r.input_tokens), output: Number(r.output_tokens), messages: Number(r.messages), dropped: Number(r.dropped) } : null;
    },
    sweep: (now) => db.run('DELETE FROM az_chat_usage WHERE day < ?', [utcDay(now - USAGE_KEEP_DAYS * DAY_MS)]),
  };
}
