/**
 * @az server chat-usage
 * Purpose: the chat's daily counters — the az_chat_usage table, one upsert per answer or blocked question, the 400-day sweep — and every chat table's migrations (az_chat_shares, chat-share.ts; az_chat_limits, chat-limits.ts).
 * Spec: docs/backend-spec.md §3, §5 (docs/chat-block-spec.md §6.5, §6.7)
 * Exports: CHAT_MIGRATIONS, migrateChat, createUsage, usageReport, utcDay, Usage, UsageDay, UsageReport, USAGE_KEEP_DAYS, REPORT_DAYS
 * Edit guide: counts only, never text or a person; one statement per answer (pooler-safe); append a step, never edit a shipped one; the report never reads a share's events or question.
 * Tests: packages/backend/test/chat-usage.test.ts, packages/backend/test/data-admin.test.ts, scripts/backend-db-chat.mjs
 */

/**
 * The budget must survive a restart (chat-block-spec §6.5), so what chat has
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
    {
      // chat-block-spec §20.7: one shared answer per row, under an unguessable
      // id; no column for who shared it. Read by id, swept by `expires`.
      version: 2,
      sql: {
        sqlite: [
          'CREATE TABLE az_chat_shares (id TEXT PRIMARY KEY, events TEXT NOT NULL, question TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, delete_hash TEXT NOT NULL)',
          'CREATE INDEX az_chat_shares_expires ON az_chat_shares (expires)',
        ],
        postgres: [
          'CREATE TABLE az_chat_shares (id VARCHAR(22) PRIMARY KEY, events TEXT NOT NULL, question TEXT, created BIGINT NOT NULL, expires BIGINT NOT NULL, delete_hash CHAR(64) NOT NULL)',
          'CREATE INDEX az_chat_shares_expires ON az_chat_shares (expires)',
        ],
        mysql: [
          `CREATE TABLE az_chat_shares (id VARCHAR(22) PRIMARY KEY, events MEDIUMTEXT NOT NULL, question TEXT, created BIGINT NOT NULL, expires BIGINT NOT NULL, delete_hash CHAR(64) NOT NULL) ${MYSQL}`,
          'CREATE INDEX az_chat_shares_expires ON az_chat_shares (expires)',
        ],
      },
    },
    {
      // Questions the moderation hook blocked (§6.8), counted per day beside the answers: a block spends no tokens.
      version: 3,
      sql: {
        sqlite: ['ALTER TABLE az_chat_usage ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0'],
        postgres: ['ALTER TABLE az_chat_usage ADD COLUMN blocked BIGINT NOT NULL DEFAULT 0'],
        mysql: ['ALTER TABLE az_chat_usage ADD COLUMN blocked BIGINT NOT NULL DEFAULT 0'],
      },
    },
    {
      // The chat's rate limits, shared by every instance on this database (chat-limits.ts): one counter per
      // (limit, slot, subject) under a keyed hash — never an address or an account in the clear. Swept by `expires`.
      version: 4,
      sql: {
        sqlite: [
          'CREATE TABLE az_chat_limits (id TEXT PRIMARY KEY, n INTEGER NOT NULL, expires INTEGER NOT NULL)',
          'CREATE INDEX az_chat_limits_expires ON az_chat_limits (expires)',
        ],
        postgres: [
          'CREATE TABLE az_chat_limits (id CHAR(43) PRIMARY KEY, n INTEGER NOT NULL, expires BIGINT NOT NULL)',
          'CREATE INDEX az_chat_limits_expires ON az_chat_limits (expires)',
        ],
        mysql: [
          `CREATE TABLE az_chat_limits (id CHAR(43) PRIMARY KEY, n INT NOT NULL, expires BIGINT NOT NULL) ${MYSQL}`,
          'CREATE INDEX az_chat_limits_expires ON az_chat_limits (expires)',
        ],
      },
    },
    {
      // chat-block-spec §19.11: the hash of the share tag that proved a share — one live share per tag, so a
      // tag replayed is refused. Shares made before this have none (NULL, which a unique index does not compare).
      version: 5,
      sql: {
        sqlite: ['ALTER TABLE az_chat_shares ADD COLUMN proof TEXT', 'CREATE UNIQUE INDEX az_chat_shares_proof ON az_chat_shares (proof)'],
        postgres: ['ALTER TABLE az_chat_shares ADD COLUMN proof CHAR(64)', 'CREATE UNIQUE INDEX az_chat_shares_proof ON az_chat_shares (proof)'],
        mysql: ['ALTER TABLE az_chat_shares ADD COLUMN proof CHAR(64)', 'CREATE UNIQUE INDEX az_chat_shares_proof ON az_chat_shares (proof)'],
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
  const cols = 'day, input_tokens, output_tokens, messages, dropped, blocked';
  if (dialect === 'mysql') {
    return `INSERT INTO az_chat_usage (${cols}) VALUES (?, ?, ?, 1, ?, 0) AS n ON DUPLICATE KEY UPDATE `
      + 'input_tokens = az_chat_usage.input_tokens + n.input_tokens, output_tokens = az_chat_usage.output_tokens + n.output_tokens, '
      + 'messages = az_chat_usage.messages + 1, dropped = az_chat_usage.dropped + n.dropped';
  }
  return `INSERT INTO az_chat_usage (${cols}) VALUES (?, ?, ?, 1, ?, 0) ON CONFLICT (day) DO UPDATE SET `
    + 'input_tokens = az_chat_usage.input_tokens + excluded.input_tokens, output_tokens = az_chat_usage.output_tokens + excluded.output_tokens, '
    + 'messages = az_chat_usage.messages + 1, dropped = az_chat_usage.dropped + excluded.dropped';
}

/** One blocked question, as one statement: the day's row made with nothing spent, or its `blocked` added to. */
function blockUpsert(dialect: Db['dialect']): string {
  const cols = 'day, input_tokens, output_tokens, messages, dropped, blocked';
  if (dialect === 'mysql') return `INSERT INTO az_chat_usage (${cols}) VALUES (?, 0, 0, 0, 0, 1) ON DUPLICATE KEY UPDATE blocked = az_chat_usage.blocked + 1`;
  return `INSERT INTO az_chat_usage (${cols}) VALUES (?, 0, 0, 0, 0, 1) ON CONFLICT (day) DO UPDATE SET blocked = az_chat_usage.blocked + 1`;
}

export interface Usage {
  /** Tokens (input + output) spent on `day`. */
  spent(day: string): Promise<number>;
  /** Count one answer on `day`. */
  add(day: string, input: number, output: number, dropped: number): Promise<void>;
  /** Count one question the moderation hook blocked on `day` (§6.8): no tokens, no message. */
  block(day: string): Promise<void>;
  /** The day's row, for a report: null when nothing was counted. */
  row(day: string): Promise<{ input: number; output: number; messages: number; dropped: number; blocked: number } | null>;
  /** Remove days older than USAGE_KEEP_DAYS before `now`; how many went. */
  sweep(now: number): Promise<number>;
}

export function createUsage(db: Db): Usage {
  const sql = upsert(db.dialect);
  const blocked = blockUpsert(db.dialect);
  return {
    async spent(day) {
      const r = await db.get('SELECT input_tokens, output_tokens FROM az_chat_usage WHERE day = ?', [day]);
      return r ? Number(r.input_tokens) + Number(r.output_tokens) : 0;
    },
    async add(day, input, output, dropped) {
      await db.run(sql, [day, input, output, dropped]);
    },
    async block(day) {
      await db.run(blocked, [day]);
    },
    async row(day) {
      const r = await db.get('SELECT input_tokens, output_tokens, messages, dropped, blocked FROM az_chat_usage WHERE day = ?', [day]);
      return r ? { input: Number(r.input_tokens), output: Number(r.output_tokens), messages: Number(r.messages), dropped: Number(r.dropped), blocked: Number(r.blocked) } : null;
    },
    sweep: (now) => db.run('DELETE FROM az_chat_usage WHERE day < ?', [utcDay(now - USAGE_KEEP_DAYS * DAY_MS)]),
  };
}

/** The days the operator's usage view covers, today included (chat-block-spec §11.4). */
export const REPORT_DAYS = 30;

/** One day's counts as the usage view shows them. */
export interface UsageDay {
  readonly day: string;
  readonly input: number;
  readonly output: number;
  readonly messages: number;
  readonly dropped: number;
  /** Questions the moderation hook blocked: the model was never asked, so they spent nothing. */
  readonly blocked: number;
  /** Shared answers made that day that are still kept (one past its expiry is gone, so it is not counted). */
  readonly shares: number;
}

/**
 * The operator's view of what chat spent (chat-block-spec §11.4): today and
 * the budget left, and every day of the last REPORT_DAYS with anything in
 * it, newest first; the shares kept now. Counts only — it reads no share's
 * events or question, and nothing in it names a person.
 */
export interface UsageReport {
  readonly today: string;
  readonly budget: { readonly daily: number; readonly spent: number; readonly left: number };
  readonly days: readonly UsageDay[];
  readonly shares: { readonly enabled: boolean; readonly kept: number };
}

/** A share's UTC day number from its `created` (ms): whole-number division on each engine. */
const dayNumber = (dialect: Db['dialect']) => (dialect === 'mysql' ? 'created DIV 86400000' : 'created / 86400000');

/** The usage report for the UTC day `now` falls on: three bounded reads, none of a share's text. */
export async function usageReport(db: Db, config: { readonly dailyTokens: number; readonly sharesEnabled: boolean }, now: number): Promise<UsageReport> {
  const today = utcDay(now);
  const from = utcDay(now - (REPORT_DAYS - 1) * DAY_MS);
  const rows = await db.all(
    'SELECT day, input_tokens, output_tokens, messages, dropped, blocked FROM az_chat_usage WHERE day >= ? AND day <= ? ORDER BY day DESC',
    [from, today],
  );
  // The shares still kept, by the day they were made: counted per day number, never read.
  const made = await db.all(
    `SELECT ${dayNumber(db.dialect)} AS n, COUNT(*) AS c FROM az_chat_shares WHERE expires > ? AND created >= ? GROUP BY ${dayNumber(db.dialect)}`,
    [now, Date.parse(`${from}T00:00:00Z`)],
  );
  const sharesOn = new Map(made.map((r) => [utcDay(Number(r.n) * DAY_MS), Number(r.c)]));
  const kept = await db.get('SELECT COUNT(*) AS c FROM az_chat_shares WHERE expires > ?', [now]);
  const byDay = new Map<string, UsageDay>();
  for (const r of rows) {
    const day = String(r.day);
    byDay.set(day, {
      day, input: Number(r.input_tokens), output: Number(r.output_tokens), messages: Number(r.messages), dropped: Number(r.dropped), blocked: Number(r.blocked),
      shares: sharesOn.get(day) ?? 0,
    });
  }
  // A day with shares made and no answer counted still shows (an answer's count and its share are separate writes).
  for (const [day, n] of sharesOn) {
    if (!byDay.has(day)) byDay.set(day, { day, input: 0, output: 0, messages: 0, dropped: 0, blocked: 0, shares: n });
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const todayRow = byDay.get(today);
  const spent = todayRow ? todayRow.input + todayRow.output : 0;
  return {
    today,
    budget: { daily: config.dailyTokens, spent, left: Math.max(0, config.dailyTokens - spent) },
    days,
    shares: { enabled: config.sharesEnabled, kept: Number(kept?.c ?? 0) },
  };
}
