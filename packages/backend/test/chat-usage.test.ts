/**
 * The chat's daily counters (chat-usage.ts) on SQLite in memory; the same
 * statements run on PostgreSQL and MySQL in `pnpm test:backend-db`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openSqlite } from '../src/server/db.ts';
import { CHAT_MIGRATIONS, createUsage, migrateChat, USAGE_KEEP_DAYS, utcDay } from '../src/server/chat-usage.ts';
import { probeFor } from '../src/server/claim.ts';

const DAY = 24 * 60 * 60 * 1000;

test('the chat migration creates az_chat_usage once; a second run is a no-op; the auth migrations know nothing of it', async () => {
  const db = await openSqlite(':memory:');
  try {
    await migrate(db);
    assert.equal(await db.get("SELECT 1 AS x FROM sqlite_schema WHERE name = 'az_chat_usage'"), undefined, 'not part of the auth schema');
    assert.deepEqual(await migrateChat(db), [1]);
    assert.deepEqual(await migrateChat(db), []);
    assert.ok(await db.get("SELECT 1 AS x FROM sqlite_schema WHERE name = 'az_chat_usage'"));
  } finally { await db.close(); }
});

test('every chat migration statement has a probe (a crashed step resumes)', () => {
  for (const step of CHAT_MIGRATIONS.steps) {
    for (const engine of ['sqlite', 'postgres', 'mysql'] as const) {
      for (const s of step.sql[engine]) assert.doesNotThrow(() => probeFor(s), `${engine}: ${s.slice(0, 40)}`);
    }
  }
});

test('one row per UTC day, added to by one statement per answer; counts only', async () => {
  const db = await openSqlite(':memory:');
  try {
    await migrateChat(db);
    const usage = createUsage(db);
    const day = utcDay(Date.UTC(2026, 9, 15, 23, 59));
    assert.equal(day, '2026-10-15');
    assert.equal(await usage.spent(day), 0);
    await usage.add(day, 100, 20, 0);
    await usage.add(day, 50, 5, 1);
    assert.deepEqual(await usage.row(day), { input: 150, output: 25, messages: 2, dropped: 1 });
    assert.equal(await usage.spent(day), 175);
    // The rollover: a minute later is another day, with its own row.
    const next = utcDay(Date.UTC(2026, 9, 16, 0, 0));
    await usage.add(next, 1, 1, 0);
    assert.equal(await usage.spent(next), 2);
    assert.equal(await usage.spent(day), 175);
    const columns = (await db.all('SELECT name FROM pragma_table_info(?)', ['az_chat_usage'])).map((r) => r.name);
    assert.deepEqual(columns, ['day', 'input_tokens', 'output_tokens', 'messages', 'dropped']);
  } finally { await db.close(); }
});

test(`the sweep removes days older than ${USAGE_KEEP_DAYS}, and keeps the rest`, async () => {
  const db = await openSqlite(':memory:');
  try {
    await migrateChat(db);
    const usage = createUsage(db);
    const now = Date.UTC(2026, 9, 15);
    await usage.add(utcDay(now - (USAGE_KEEP_DAYS + 1) * DAY), 1, 1, 0);
    await usage.add(utcDay(now - USAGE_KEEP_DAYS * DAY), 1, 1, 0);
    await usage.add(utcDay(now), 1, 1, 0);
    assert.equal(await usage.sweep(now), 1);
    assert.equal((await db.all('SELECT day FROM az_chat_usage')).length, 2);
  } finally { await db.close(); }
});
