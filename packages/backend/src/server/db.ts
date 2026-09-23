/**
 * @az server db
 * Purpose: one small interface over SQLite, PostgreSQL and MySQL, plus migrations.
 * Spec: docs/backend-spec.md §3
 * Exports: openSqlite, openPostgres, openMysql, migrate, Db
 * Edit guide: parameterised queries only; unnamed statements (pooler-safe).
 * Tests: packages/backend/test/backend.test.ts
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
import { loadDriver } from './drivers.ts';
import { MIGRATIONS } from './migrations.ts';
import type { Database } from './env.ts';

export type Value = string | number | null;
export type Row = Record<string, unknown>;

export interface Db {
  readonly dialect: Database;
  all(sql: string, params?: readonly Value[]): Promise<Row[]>;
  get(sql: string, params?: readonly Value[]): Promise<Row | undefined>;
  run(sql: string, params?: readonly Value[]): Promise<number>;
  close(): Promise<void>;
}

/** `?` → `$1, $2…` for PostgreSQL. Queries in this server hold no `?` in literals. */
export function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
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
interface PgPool {
  query(sql: string, params: readonly Value[]): Promise<{ rows: Row[]; rowCount: number | null }>;
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
    get: async (sql, p = []) => db.prepare(sql).get(...p),
    run: async (sql, p = []) => Number(db.prepare(sql).run(...p).changes),
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
    get: async (sql, p = []) => (await pool.query(numbered(sql), p)).rows[0],
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
    get: async (sql, p = []) => ((await pool.execute(sql, p))[0] as Row[])[0],
    run: async (sql, p = []) => ((await pool.execute(sql, p))[0] as { affectedRows: number }).affectedRows,
    close: () => pool.end(),
  };
}

/** Apply every migration not yet recorded, in order. Safe to run on every start. */
export async function migrate(db: Db): Promise<number[]> {
  await db.run(MIGRATIONS.table[db.dialect]);
  const done = new Set((await db.all('SELECT version FROM az_schema_migrations')).map((r) => Number(r.version)));
  const applied: number[] = [];
  for (const m of MIGRATIONS.steps) {
    if (done.has(m.version)) continue;
    for (const statement of m.sql[db.dialect]) await db.run(statement);
    await db.run('INSERT INTO az_schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, Date.now()]);
    applied.push(m.version);
  }
  return applied;
}
