/**
 * @az server db
 * Purpose: one small interface over SQLite, PostgreSQL and MySQL, plus migrations.
 * Spec: docs/backend-spec.md §3
 * Exports: openSqlite, openPostgres, openMysql, migrate, Db, QueryTimeout, isUniqueViolation
 * Edit guide: parameterised queries only; unnamed statements (pooler-safe).
 * Tests: packages/backend/test/backend.test.ts, packages/backend/test/claim.test.ts
 */

/**
 * The database — one small interface over three engines (backend-spec §3).
 *
 * Every query is written once with `?` placeholders and parameters; values
 * are never spliced into SQL text. PostgreSQL's `$1`-style placeholders are
 * produced here, mechanically, from the `?`s.
 *
 * SQLite is Node's built-in `node:sqlite` (no package, no native build, no
 * install script). PostgreSQL and MySQL use their de facto drivers, loaded
 * only when chosen — a SQLite server never has them installed.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { probeDone, probeFor, runClaimed, type ClaimStore, type ClaimTiming } from './claim.ts';
import { loadDriver } from './drivers.ts';
import { MIGRATIONS } from './migrations.ts';
import type { Database } from './env.ts';

export type Value = string | number | null;
export type Row = Record<string, unknown>;

export interface Db {
  readonly dialect: Database;
  all(sql: string, params?: readonly Value[]): Promise<Row[]>;
  /**
   * A read the DATABASE abandons past `ms` — it cancels the statement, not
   * just stops waiting — throwing QueryTimeout. PostgreSQL: `SET LOCAL
   * statement_timeout` inside one read-only transaction on one connection;
   * MySQL: the `MAX_EXECUTION_TIME` hint on the SELECT. Neither leaves
   * session state, so both are pooler-safe. SQLite runs in this process and
   * node:sqlite has no way to interrupt a statement: there it is `all`, and
   * the bound is the table's size (data-spec §18).
   */
  allWithin(sql: string, params: readonly Value[], ms: number): Promise<Row[]>;
  /**
   * SQLite only: statements run as ONE transaction with foreign keys off
   * (a table rebuild, data-ddl.ts relink), checked with foreign_key_check
   * before commit. Returns the violations found — when any, nothing was
   * committed. The other engines never get a script.
   */
  script(statements: readonly string[]): Promise<number>;
  get(sql: string, params?: readonly Value[]): Promise<Row | undefined>;
  run(sql: string, params?: readonly Value[]): Promise<number>;
  close(): Promise<void>;
}

/** `?` → `$1, $2…` for PostgreSQL. Queries in this server hold no `?` in literals. */
export function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** The database cancelled a read that ran past its deadline (Db.allWithin). */
export class QueryTimeout extends Error {}

/** A deadline in whole milliseconds: written into SQL text, so checked here, never request input. */
function deadline(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 600_000) throw new Error(`allWithin: deadline ${ms} out of range`);
  return ms;
}

/** A unique-constraint violation, whichever engine raised it. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: unknown; errno?: unknown; errcode?: unknown; message?: unknown };
  return err?.code === '23505'                                   // PostgreSQL unique_violation
    || err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062        // MySQL
    || err?.errcode === 2067 || err?.errcode === 1555             // SQLite UNIQUE / PRIMARY KEY
    || (typeof err?.message === 'string' && /UNIQUE constraint failed/.test(err.message));
}

/** The minimal driver shapes this file uses — no type packages needed. */
interface SqliteStatement {
  all(...p: Value[]): Row[];
  get(...p: Value[]): Row | undefined;
  run(...p: Value[]): { changes: number | bigint };
}
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }
interface PgClient {
  query(sql: string, params?: readonly Value[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  /** `true` destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean): void;
}
interface PgPool {
  query(sql: string, params: readonly Value[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
interface MysqlPool {
  execute(sql: string, params: readonly Value[]): Promise<[unknown, unknown]>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}


export async function openSqlite(path: string): Promise<Db> {
  const { DatabaseSync } = await loadDriver('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDb };
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return {
    dialect: 'sqlite',
    all: async (sql, p = []) => db.prepare(sql).all(...p),
    allWithin: async (sql, p, ms) => {
      deadline(ms);
      return db.prepare(sql).all(...p);
    },
    get: async (sql, p = []) => db.prepare(sql).get(...p),
    run: async (sql, p = []) => Number(db.prepare(sql).run(...p).changes),
    script: async (statements) => {
      // A no-op inside a transaction, so set before BEGIN; this connection
      // is the server's only one, and it is set back in every case.
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const s of statements) db.exec(s);
          const broken = db.prepare('PRAGMA foreign_key_check').all().length;
          db.exec(broken > 0 ? 'ROLLBACK' : 'COMMIT');
          return broken;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    },
    close: async () => db.close(),
  };
}

/**
 * TLS for a database connection: the server certificate is always verified —
 * against the system's roots, or `ca` when the host publishes its own.
 */
const tlsOptions = (tls: boolean, ca?: string) =>
  (tls ? { ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } } : {});

/**
 * Pooler-safe by construction: every query is a single statement sent with
 * an UNNAMED prepared statement (`pool.query(text, params)`), no session
 * state (SET, advisory locks, LISTEN) and no multi-statement transaction
 * across calls — so a transaction-mode connection pooler in front of the
 * database is fine (backend-spec §3.1).
 */
export async function openPostgres(url: string, tls: boolean, ca?: string): Promise<Db> {
  const pg = await loadDriver('pg') as { default?: { Pool: new (o: object) => PgPool }; Pool?: new (o: object) => PgPool };
  const Pool = (pg.default?.Pool ?? pg.Pool)!;
  const pool = new Pool({ connectionString: url, max: 10, ...tlsOptions(tls, ca) });
  return {
    dialect: 'postgres',
    all: async (sql, p = []) => (await pool.query(numbered(sql), p)).rows,
    allWithin: async (sql, p, ms) => {
      const limit = deadline(ms);
      const c = await pool.connect();
      let broken = false;
      try {
        // One transaction on one connection: a transaction-mode pooler keeps
        // it on one server connection, and SET LOCAL ends with it.
        await c.query('BEGIN READ ONLY');
        await c.query(`SET LOCAL statement_timeout = ${limit}`);
        const { rows } = await c.query(numbered(sql), p);
        await c.query('COMMIT');
        return rows;
      } catch (e) {
        try {
          await c.query('ROLLBACK');
        } catch {
          broken = true;
        }
        // 57014 query_canceled: the statement_timeout fired.
        if ((e as { code?: unknown })?.code === '57014') throw new QueryTimeout(`read cancelled after ${limit} ms`);
        throw e;
      } finally {
        c.release(broken);
      }
    },
    get: async (sql, p = []) => (await pool.query(numbered(sql), p)).rows[0],
    script: async () => { throw new Error('script: SQLite only'); },
    run: async (sql, p = []) => (await pool.query(numbered(sql), p)).rowCount ?? 0,
    close: () => pool.end(),
  };
}

export async function openMysql(url: string, tls: boolean, ca?: string): Promise<Db> {
  const mysql = await loadDriver('mysql2/promise') as { createPool?: (o: object) => MysqlPool; default?: { createPool: (o: object) => MysqlPool } };
  const createPool = (mysql.createPool ?? mysql.default?.createPool)!;
  const pool = createPool({
    uri: url, connectionLimit: 10, supportBigNumbers: true, bigNumberStrings: false,
    ...tlsOptions(tls, ca),
  });
  return {
    dialect: 'mysql',
    all: async (sql, p = []) => (await pool.execute(sql, p))[0] as Row[],
    allWithin: async (sql, p, ms) => {
      const limit = deadline(ms);
      if (!/^SELECT /.test(sql)) throw new Error('allWithin: only a SELECT takes a deadline');
      try {
        return (await pool.execute(`SELECT /*+ MAX_EXECUTION_TIME(${limit}) */ ${sql.slice('SELECT '.length)}`, p))[0] as Row[];
      } catch (e) {
        // 3024 ER_QUERY_TIMEOUT: maximum statement execution time exceeded.
        if ((e as { errno?: unknown })?.errno === 3024) throw new QueryTimeout(`read cancelled after ${limit} ms`);
        throw e;
      }
    },
    get: async (sql, p = []) => ((await pool.execute(sql, p))[0] as Row[])[0],
    script: async () => { throw new Error('script: SQLite only'); },
    run: async (sql, p = []) => ((await pool.execute(sql, p))[0] as { affectedRows: number }).affectedRows,
    close: () => pool.end(),
  };
}

/**
 * A version's row in az_schema_migrations as a claim (claim.ts). The table
 * predates claims, so "in progress" is a NEGATIVE applied_at — minus the
 * claim time — and every row written before claims existed (positive) reads
 * as applied, unchanged.
 */
function authClaim(db: Db, version: number): ClaimStore {
  return {
    async read() {
      const row = await db.get('SELECT applied_at FROM az_schema_migrations WHERE version = ?', [version]);
      if (!row) return null;
      const at = Number(row.applied_at);
      return { claimedAt: -at, applied: at > 0 };
    },
    async claim(at) {
      try {
        await db.run('INSERT INTO az_schema_migrations (version, applied_at) VALUES (?, ?)', [version, -at]);
        return true;
      } catch (e) {
        if (isUniqueViolation(e)) return false;
        throw e;
      }
    },
    refresh: async (from, to) =>
      (await db.run('UPDATE az_schema_migrations SET applied_at = ? WHERE version = ? AND applied_at = ?', [-to, version, -from])) === 1,
    finish: async (held, at) =>
      (await db.run('UPDATE az_schema_migrations SET applied_at = ? WHERE version = ? AND applied_at = ?', [at, version, -held])) === 1,
    release: async (held) => {
      await db.run('DELETE FROM az_schema_migrations WHERE version = ? AND applied_at = ?', [version, -held]);
    },
  };
}

/**
 * Apply every migration not yet recorded, in order. Safe to run on every
 * start, and on several instances starting at once: each version is claimed
 * before it runs (data-spec §6.3), and a statement whose effect is already
 * present — a crashed instance's last one — is not run again.
 */
export async function migrate(db: Db, now: () => number = Date.now, timing?: ClaimTiming): Promise<number[]> {
  await db.run(MIGRATIONS.table[db.dialect]);
  const applied: number[] = [];
  for (const m of MIGRATIONS.steps) {
    const outcome = await runClaimed(authClaim(db, m.version), async () => {
      for (const statement of m.sql[db.dialect]) {
        if (!(await probeDone(db, probeFor(statement)))) await db.run(statement);
      }
    }, `migration ${m.version}`, now, timing);
    if (outcome === 'ran') applied.push(m.version);
  }
  return applied;
}
