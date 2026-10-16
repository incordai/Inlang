/**
 * The chat's daily counters (chat-usage.ts) on SQLite in memory; the same
 * statements run on PostgreSQL and MySQL in `pnpm test:backend-db`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openSqlite } from '../src/server/db.ts';
import { CHAT_MIGRATIONS, createUsage, migrateChat, usageReport, USAGE_KEEP_DAYS, utcDay } from '../src/server/chat-usage.ts';
import { usageText } from '../src/server/chat-report.ts';
import { createShareStore } from '../src/server/chat-share.ts';
import { probeFor } from '../src/server/claim.ts';

const DAY = 24 * 60 * 60 * 1000;

test('the chat migration creates az_chat_usage once; a second run is a no-op; the auth migrations know nothing of it', async () => {
  const db = await openSqlite(':memory:');
  try {
    await migrate(db);
    assert.equal(await db.get("SELECT 1 AS x FROM sqlite_schema WHERE name = 'az_chat_usage'"), undefined, 'not part of the auth schema');
    assert.deepEqual(await migrateChat(db), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await migrateChat(db), []);
    assert.ok(await db.get("SELECT 1 AS x FROM sqlite_schema WHERE name = 'az_chat_usage'"));
  } finally { await db.close(); }
});

test('a server from before the blocked count upgrades in place: its days keep their counts and gain blocked 0', async () => {
  const db = await openSqlite(':memory:');
  try {
    // The database as C4 left it: steps 1 and 2 applied, a day counted.
    await db.run(CHAT_MIGRATIONS.table.sqlite);
    for (const step of CHAT_MIGRATIONS.steps.slice(0, 2)) {
      for (const sql of step.sql.sqlite) await db.run(sql);
      await db.run('INSERT INTO az_chat_migrations (version, claimed_at, applied_at) VALUES (?, 1, 1)', [step.version]);
    }
    await db.run("INSERT INTO az_chat_usage (day, input_tokens, output_tokens, messages, dropped) VALUES ('2026-10-15', 10, 2, 1, 0)");
    assert.deepEqual(await migrateChat(db), [3, 4, 5, 6]);
    const usage = createUsage(db);
    assert.deepEqual(await usage.row('2026-10-15'), { input: 10, cached: 0, output: 2, messages: 1, dropped: 0, blocked: 0 });
    await usage.block('2026-10-15');
    assert.equal((await usage.row('2026-10-15'))?.blocked, 1);
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
    await usage.add(day, 100, 20, 0, 0);
    await usage.add(day, 50, 5, 1, 40);
    // §19.15: the part of the input the provider read from its prompt cache, added up the same way.
    assert.deepEqual(await usage.row(day), { input: 150, cached: 40, output: 25, messages: 2, dropped: 1, blocked: 0 });
    // A blocked question adds to the same row, spending nothing and counting no message.
    await usage.block(day);
    await usage.block(day);
    assert.deepEqual(await usage.row(day), { input: 150, cached: 40, output: 25, messages: 2, dropped: 1, blocked: 2 });
    assert.equal(await usage.spent(day), 175);
    // A day whose first count is a block has its own row.
    await usage.block('2026-10-14');
    assert.deepEqual(await usage.row('2026-10-14'), { input: 0, cached: 0, output: 0, messages: 0, dropped: 0, blocked: 1 });
    assert.equal(await usage.spent(day), 175);
    // The rollover: a minute later is another day, with its own row.
    const next = utcDay(Date.UTC(2026, 9, 16, 0, 0));
    await usage.add(next, 1, 1, 0, 0);
    assert.equal(await usage.spent(next), 2);
    assert.equal(await usage.spent(day), 175);
    const columns = (await db.all('SELECT name FROM pragma_table_info(?)', ['az_chat_usage'])).map((r) => r.name);
    assert.deepEqual(columns, ['day', 'input_tokens', 'output_tokens', 'messages', 'dropped', 'blocked', 'cached_tokens']);
  } finally { await db.close(); }
});

test(`the sweep removes days older than ${USAGE_KEEP_DAYS}, and keeps the rest`, async () => {
  const db = await openSqlite(':memory:');
  try {
    await migrateChat(db);
    const usage = createUsage(db);
    const now = Date.UTC(2026, 9, 15);
    await usage.add(utcDay(now - (USAGE_KEEP_DAYS + 1) * DAY), 1, 1, 0, 0);
    await usage.add(utcDay(now - USAGE_KEEP_DAYS * DAY), 1, 1, 0, 0);
    await usage.add(utcDay(now), 1, 1, 0, 0);
    assert.equal(await usage.sweep(now), 1);
    assert.equal((await db.all('SELECT day FROM az_chat_usage')).length, 2);
  } finally { await db.close(); }
});

/* ---- the operator's usage view (chat-block-spec §11.4) ------------------ */

test('usage report: today against the budget, the last 30 days newest first, shares by the day made — counts only', async () => {
  const db = await openSqlite(':memory:');
  try {
    await migrate(db);
    await migrateChat(db);
    const now = Date.UTC(2026, 9, 16, 15, 30);
    const usage = createUsage(db);
    await usage.add('2026-10-16', 1000, 100, 2, 0);
    await usage.add('2026-10-16', 500, 50, 0, 0);
    await usage.add('2026-10-10', 10, 1, 0, 0);
    await usage.block('2026-10-16');
    await usage.block('2026-10-11');
    // The window's first day is 29 days back; the day before it is outside.
    await usage.add(utcDay(now - 29 * DAY), 7, 7, 0, 0);
    await usage.add(utcDay(now - 30 * DAY), 9, 9, 0, 0);
    const words = 'shared-words-never-read';
    const shares = createShareStore({ db, days: 30, max: 100, now: () => now });
    await shares.create(JSON.stringify([{ type: 'text', s: words }]), words);
    // Made on the 12th, still kept; made on the 1st and already expired: not counted.
    const at12 = createShareStore({ db, days: 30, max: 100, now: () => Date.UTC(2026, 9, 12, 23, 59) });
    await at12.create('[]', null);
    const old = createShareStore({ db, days: 1, max: 100, now: () => Date.UTC(2026, 9, 1) });
    await old.create('[]', null);
    const r = await usageReport(db, { dailyTokens: 2_000, sharesEnabled: false }, now);
    assert.deepEqual(r, {
      today: '2026-10-16',
      budget: { daily: 2_000, spent: 1_650, left: 350 },
      days: [
        { day: '2026-10-16', input: 1500, cached: 0, output: 150, messages: 2, dropped: 2, blocked: 1, shares: 1 },
        { day: '2026-10-12', input: 0, cached: 0, output: 0, messages: 0, dropped: 0, blocked: 0, shares: 1 },
        { day: '2026-10-11', input: 0, cached: 0, output: 0, messages: 0, dropped: 0, blocked: 1, shares: 0 },
        { day: '2026-10-10', input: 10, cached: 0, output: 1, messages: 1, dropped: 0, blocked: 0, shares: 0 },
        { day: utcDay(now - 29 * DAY), input: 7, cached: 0, output: 7, messages: 1, dropped: 0, blocked: 0, shares: 0 },
      ],
      shares: { enabled: false, kept: 2 },
    });
    assert.ok(!JSON.stringify(r).includes(words));
    // Past the budget, nothing is left — never a negative.
    await usage.add('2026-10-16', 5_000, 0, 0, 0);
    assert.deepEqual((await usageReport(db, { dailyTokens: 2_000, sharesEnabled: true }, now)).budget, { daily: 2_000, spent: 6_650, left: 0 });
    // An empty day: no rows, nothing spent.
    const empty = await usageReport(db, { dailyTokens: 2_000, sharesEnabled: true }, Date.UTC(2027, 5, 1));
    assert.deepEqual([empty.days, empty.budget.spent, empty.shares.kept], [[], 0, 0]);
  } finally { await db.close(); }
});

test('usage text: one line for today and the budget, one for the shares, a table of the days — no message', () => {
  const text = usageText({
    today: '2026-10-16',
    budget: { daily: 300_000, spent: 12_345, left: 287_655 },
    days: [{ day: '2026-10-16', input: 12_000, cached: 9_000, output: 345, messages: 9, dropped: 1, blocked: 3, shares: 2 }],
    shares: { enabled: true, kept: 4 },
  });
  assert.equal(text, [
    'chat usage — today is 2026-10-16 (UTC)',
    '  budget 300,000 tokens a day · spent today 12,345 · left 287,655',
    '  shared answers: on · 4 kept now',
    '  day         messages  input tokens  cached input  output tokens  dropped  blocked  shares',
    '  2026-10-16         9        12,000         9,000            345        1        3       2',
    '',
  ].join('\n'));
  assert.match(usageText({ today: '2026-10-16', budget: { daily: 1000, spent: 0, left: 1000 }, days: [], shares: { enabled: false, kept: 0 } }),
    /shared answers: off \(AZ_CHAT_SHARES=off\) · 0 kept now\n {2}nothing counted in the last 30 days\n$/);
});
