/**
 * Claim-before-run (data-spec §6.3): several instances starting together
 * apply each migration once; a crashed instance's half-applied step resumes;
 * a live claim is never taken over; rows written before claims still count.
 * Two connections to one SQLite file stand in for two instances; the real
 * engines are exercised by scripts/backend-db.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openSqlite, type Db } from '../src/server/db.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { MigrationBusy, probeFor, runClaimed, type ClaimStore } from '../src/server/claim.ts';

const FAST = { waitMs: 400, staleMs: 150, heartbeatMs: 30, pollMs: 10 };
const file = () => join(mkdtempSync(join(tmpdir(), 'az-claim-')), 'db.sqlite');
const tables = async (db: Db) => (await db.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'az_%' ORDER BY name")).map((r) => r.name);
const ALL = MIGRATIONS.steps.map((s) => s.version);

test('every auth statement on every engine has a probe', () => {
  for (const step of MIGRATIONS.steps) {
    for (const engine of ['sqlite', 'postgres', 'mysql'] as const) {
      for (const statement of step.sql[engine]) assert.doesNotThrow(() => probeFor(statement), statement.slice(0, 60));
    }
  }
});

test('CONTROL: one instance applies every version once, then nothing', async () => {
  const db = await openSqlite(file());
  assert.deepEqual(await migrate(db), ALL);
  assert.deepEqual(await migrate(db), []);
  const rows = await db.all('SELECT version, applied_at FROM az_schema_migrations ORDER BY version');
  assert.ok(rows.every((r) => Number(r.applied_at) > 0));
  await db.close();
});

test('two instances starting together: each version applied exactly once, neither fails', async () => {
  const path = file();
  const [a, b] = [await openSqlite(path), await openSqlite(path)];
  const [ra, rb] = await Promise.all([migrate(a, Date.now, FAST), migrate(b, Date.now, FAST)]);
  assert.deepEqual([...ra, ...rb].sort(), ALL, `a ran ${ra}, b ran ${rb}`);
  assert.deepEqual(await tables(a), ['az_oauth_accounts', 'az_oauth_states', 'az_schema_migrations', 'az_sessions', 'az_tokens', 'az_users']);
  await a.close();
  await b.close();
});

test('a crashed instance: its stale claim is taken over and the step resumes past what landed', async () => {
  const path = file();
  const db = await openSqlite(path);
  await db.run(MIGRATIONS.table.sqlite);
  // The crashed instance claimed version 1 at t=1000 and ran two statements.
  await db.run('INSERT INTO az_schema_migrations (version, applied_at) VALUES (?, ?)', [1, -1000]);
  for (const s of MIGRATIONS.steps[0].sql.sqlite.slice(0, 2)) await db.run(s);
  const applied = await migrate(db, () => 1000 + FAST.staleMs + 1, FAST);
  assert.deepEqual(applied, ALL);
  assert.equal((await tables(db)).length, 6);
  await db.close();
});

test('a live claim is never taken over: the waiter stops with MigrationBusy', async () => {
  const db = await openSqlite(file());
  await db.run(MIGRATIONS.table.sqlite);
  let t = 5000;
  await db.run('INSERT INTO az_schema_migrations (version, applied_at) VALUES (?, ?)', [1, -t]);
  // The owner keeps refreshing: the claim is always younger than staleMs.
  const owner = setInterval(() => { void db.run('UPDATE az_schema_migrations SET applied_at = ? WHERE version = 1', [-(t += 10)]); }, 5);
  try {
    await assert.rejects(migrate(db, () => t, FAST), MigrationBusy);
  } finally {
    clearInterval(owner);
  }
  assert.deepEqual(await tables(db), ['az_schema_migrations'], 'nothing ran beside the owner');
  await db.close();
});

test('rows recorded before claims existed (positive applied_at) still count as applied', async () => {
  const db = await openSqlite(file());
  await db.run(MIGRATIONS.table.sqlite);
  for (const step of MIGRATIONS.steps) {
    for (const s of step.sql.sqlite) await db.run(s);
    await db.run('INSERT INTO az_schema_migrations (version, applied_at) VALUES (?, ?)', [step.version, 1_700_000_000_000]);
  }
  assert.deepEqual(await migrate(db), []);
  await db.close();
});

test('an owner whose claim was taken over while it worked is told so, not silently "done"', async () => {
  let claimedAt = 0;
  const store: ClaimStore = {
    read: async () => (claimedAt ? { claimedAt, applied: false } : null),
    claim: async (at) => { claimedAt = at; return true; },
    refresh: async () => false,
    finish: async () => false,
    release: async () => { claimedAt = 0; },
  };
  let t = 1;
  await assert.rejects(runClaimed(store, async () => { await new Promise((r) => setTimeout(r, 80)); }, 'unit', () => (t += 1), FAST), MigrationBusy);
});

test('work that fails gives its claim back, so a restart retries at once', async () => {
  const db = await openSqlite(file());
  await db.run(MIGRATIONS.table.sqlite);
  await db.run('CREATE VIEW az_sessions AS SELECT 1 AS x');
  // The probe sees no TABLE az_sessions, so version 1 runs its CREATE TABLE,
  // which fails on the view's name — and the claim must not stay behind.
  await assert.rejects(migrate(db, Date.now, FAST));
  assert.equal((await db.all('SELECT version FROM az_schema_migrations')).length, 0);
  await db.close();
});
