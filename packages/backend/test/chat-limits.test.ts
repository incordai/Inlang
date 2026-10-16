/**
 * The chat's rate-limit windows (chat-limits.ts) — kept in the database, so
 * every instance on it counts the same — and its answer queue, with a fake
 * clock where time matters. The same statements run on PostgreSQL and MySQL,
 * from two connections at once, in `pnpm test:backend-db`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createQueue, createRateLimits, createWindows, DAY_MS, HOUR_MS, WINDOW_SLOTS } from '../src/server/chat-limits.ts';
import { migrateChat } from '../src/server/chat-usage.ts';
import { openSqlite, type Db } from '../src/server/db.ts';
import { parseRate } from '../src/server/env.ts';
import { rateKey } from '../src/server/http.ts';

const SECRET = randomBytes(32);

/** A chat database with its migrations applied, closed after `fn`. */
async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await openSqlite(':memory:');
  try {
    await migrateChat(db);
    await fn(db);
  } finally { await db.close(); }
}

test('parseRate: hour, day, both; anything else refused', () => {
  assert.deepEqual(parseRate('20/hour,60/day'), { hour: 20, day: 60 });
  assert.deepEqual(parseRate('100/day'), { day: 100 });
  assert.deepEqual(parseRate(' 5/hour '), { hour: 5 });
  for (const bad of ['', '0/day', '5/minute', '5/hour,6/hour', '1/hour,2/day,3/day', 'x/day', '5 per day']) {
    assert.equal(parseRate(bad), null, bad);
  }
});

test('per address: the hour window, then the day window; an hour later the hour resets but not the day', () => withDb(async (db) => {
  const clock = { t: Date.UTC(2026, 9, 16) };
  const limits = createRateLimits(createWindows(db, SECRET, { now: () => clock.t }), 'chat', { hour: 2, day: 3 }, { day: 100 });
  assert.ok(await limits.take('a', null));
  assert.ok(await limits.take('a', null));
  assert.ok(!(await limits.take('a', null)), 'third in the hour');
  assert.ok(await limits.take('b', null), 'another address is unaffected');
  clock.t += HOUR_MS + HOUR_MS / WINDOW_SLOTS;
  assert.ok(await limits.take('a', null), 'a new hour');
  assert.ok(!(await limits.take('a', null)), 'the day allows three');
  clock.t += DAY_MS + DAY_MS / WINDOW_SLOTS;
  assert.ok(await limits.take('a', null), 'a new day');
}));

test('two server instances on one database share one allowance (each instance its own windows object)', () => withDb(async (db) => {
  const clock = { t: Date.UTC(2026, 9, 16, 9) };
  // Two instances: each makes its own limits from the same database, as two processes behind one proxy do.
  const one = createRateLimits(createWindows(db, SECRET, { now: () => clock.t }), 'chat', { hour: 3 }, { day: 100 });
  const two = createRateLimits(createWindows(db, SECRET, { now: () => clock.t }), 'chat', { hour: 3 }, { day: 100 });
  assert.ok(await one.take('192.0.2.1', null));
  assert.ok(await two.take('192.0.2.1', null));
  assert.ok(await one.take('192.0.2.1', null));
  assert.equal(await two.take('192.0.2.1', null), false, 'the fourth is refused whichever instance it reaches');
  assert.equal(await one.take('192.0.2.1', null), false);
  // Thirty attempts at once over both instances: exactly the allowance gets through.
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? one : two).take('192.0.2.9', null)));
  assert.equal(results.filter(Boolean).length, 3);
  // A scope is its own: the same address's share creates are not its messages.
  assert.ok(await createRateLimits(createWindows(db, SECRET, { now: () => clock.t }), 'share', { hour: 3 }, {}).take('192.0.2.1', null));
}));

test('no window of an hour ever holds more than the limit: the oldest overlapping slot counts whole', () => withDb(async (db) => {
  const slot = HOUR_MS / WINDOW_SLOTS;
  const start = Date.UTC(2026, 9, 16, 10);
  const clock = { t: start + slot - 1 };
  const limits = createRateLimits(createWindows(db, SECRET, { now: () => clock.t }), 'chat', { hour: 2 }, {});
  // Two at the end of the first slot.
  assert.ok(await limits.take('a', null));
  assert.ok(await limits.take('a', null));
  // An hour after the start of that slot, the slot still overlaps the hour that ends now: refused.
  clock.t = start + HOUR_MS + 1;
  assert.equal(await limits.take('a', null), false);
  // Once a whole hour has passed after that slot ended, it no longer counts.
  clock.t = start + slot + HOUR_MS;
  assert.ok(await limits.take('a', null));
}));

test('per address counts an IPv6 /64 as one address', () => withDb(async (db) => {
  const limits = createRateLimits(createWindows(db, SECRET, { now: () => 0 }), 'chat', { hour: 1 }, { day: 100 });
  assert.ok(await limits.take(rateKey('2001:db8:1:2::1'), null));
  assert.ok(!(await limits.take(rateKey('2001:db8:1:2:ffff::9'), null)), 'same /64');
  assert.ok(await limits.take(rateKey('2001:db8:1:3::1'), null), 'another /64');
}));

test('per account: a signed-in account is limited across addresses; signed out, only the address counts', () => withDb(async (db) => {
  const limits = createRateLimits(createWindows(db, SECRET, { now: () => 0 }), 'chat', { hour: 100 }, { day: 2 });
  assert.ok(await limits.take('a1', 'u1'));
  assert.ok(await limits.take('a2', 'u1'));
  assert.ok(!(await limits.take('a3', 'u1')), 'the account is over its day');
  assert.ok(await limits.take('a3', 'u2'), 'another account');
  assert.ok(await limits.take('a3', null), 'signed out');
}));

test('the table holds no address and no account, only keyed hashes; spent slots are swept', () => withDb(async (db) => {
  const clock = { t: Date.UTC(2026, 9, 16, 12) };
  const windows = createWindows(db, SECRET, { now: () => clock.t });
  const limits = createRateLimits(windows, 'chat', { hour: 5, day: 10 }, { day: 10 });
  await limits.take('203.0.113.77', 'account-7f3e');
  const rows = await db.all('SELECT id, n, expires FROM az_chat_limits');
  assert.equal(rows.length, 3, 'the hour and the day for the address, the day for the account');
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes('203.0.113') && !dump.includes('account-7f3e'), dump);
  assert.ok(rows.every((r) => /^[A-Za-z0-9_-]{43}$/.test(String(r.id))));
  // Another secret names other rows: the ids are not a plain hash anyone could recompute.
  await createRateLimits(createWindows(db, randomBytes(32), { now: () => clock.t }), 'chat', { hour: 5 }, {}).take('203.0.113.77', null);
  assert.equal((await db.all('SELECT id FROM az_chat_limits')).length, 4);
  assert.equal(await windows.sweep(), 0, 'nothing has expired yet');
  clock.t += 2 * DAY_MS;
  assert.equal(await windows.sweep(), 4);
}));

test('bounded: past the row cap a subject new to its slot is refused (fail closed) until the sweep frees room; known subjects still count', () => withDb(async (db) => {
  const clock = { t: Date.UTC(2026, 9, 16, 12) };
  const windows = createWindows(db, SECRET, { now: () => clock.t, maxRows: 3 });
  const limits = createRateLimits(windows, 'chat', { hour: 5 }, {});
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.ok(await limits.take(ip, null), ip);
  // The sweep counts the table: at the cap, a flood of new addresses writes no more rows and is refused.
  assert.equal(await windows.sweep(), 0);
  assert.equal(await limits.take('198.51.100.4', null), false, 'a new subject past the cap');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM az_chat_limits'))?.n), 3, 'no row written for it');
  assert.ok(await limits.take('198.51.100.1', null), 'CONTROL: a subject with a row in its slot still counts as before');
  // An hour and a slot later every row has expired: the sweep frees room, and new subjects are counted again.
  clock.t += 60 * 60 * 1000 + 10 * 60 * 1000;
  assert.equal(await windows.sweep(), 3);
  assert.ok(await limits.take('198.51.100.4', null));
}));

test('a window that is not whole slots, or a limit under 1, is a programming error', () => withDb(async (db) => {
  const windows = createWindows(db, SECRET, { now: () => 0 });
  await assert.rejects(windows.take('x', 1, 7, 'a'), /whole number of slots/);
  await assert.rejects(windows.take('x', 0, HOUR_MS, 'a'), /limit at least 1/);
}));

test('queue: N run, M wait, the next is refused; a released slot goes to the first waiter', async () => {
  const q = createQueue(2, 1, 5_000);
  const signal = new AbortController().signal;
  const a = await q.enter(signal);
  const b = await q.enter(signal);
  assert.ok(a && b);
  const waiting = q.enter(signal);
  assert.equal(await q.enter(signal), null, 'queue full → busy');
  assert.equal(q.waiting(), 1);
  a!();
  const c = await waiting;
  assert.ok(c, 'the waiter got the slot');
  assert.equal(q.running(), 2);
  b!(); c!(); c!();          // a second release is a no-op
  assert.equal(q.running(), 0);
});

test('queue: a waiter gives up after the wait, or when its visitor leaves', async () => {
  const q = createQueue(1, 4, 50);
  const hold = await q.enter(new AbortController().signal);
  const start = Date.now();
  assert.equal(await q.enter(new AbortController().signal), null, 'timed out');
  assert.ok(Date.now() - start >= 45);
  const ac = new AbortController();
  const leaving = q.enter(ac.signal);
  ac.abort();
  assert.equal(await leaving, null);
  assert.equal(q.waiting(), 0);
  hold!();
  assert.equal(q.running(), 0);
});
