/**
 * The chat's message windows and its answer queue (chat-limits.ts), with a
 * fake clock where time matters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, createRateLimits, DAY_MS, HOUR_MS } from '../src/server/chat-limits.ts';
import { parseRate } from '../src/server/env.ts';
import { rateKey } from '../src/server/http.ts';

test('parseRate: hour, day, both; anything else refused', () => {
  assert.deepEqual(parseRate('20/hour,60/day'), { hour: 20, day: 60 });
  assert.deepEqual(parseRate('100/day'), { day: 100 });
  assert.deepEqual(parseRate(' 5/hour '), { hour: 5 });
  for (const bad of ['', '0/day', '5/minute', '5/hour,6/hour', '1/hour,2/day,3/day', 'x/day', '5 per day']) {
    assert.equal(parseRate(bad), null, bad);
  }
});

test('per address: the hour window, then the day window; an hour later the hour resets but not the day', () => {
  const clock = { t: 0 };
  const limits = createRateLimits({ hour: 2, day: 3 }, { day: 100 }, () => clock.t);
  assert.ok(limits.take('a', null));
  assert.ok(limits.take('a', null));
  assert.ok(!limits.take('a', null), 'third in the hour');
  assert.ok(limits.take('b', null), 'another address is unaffected');
  clock.t += HOUR_MS;
  assert.ok(limits.take('a', null), 'a new hour');
  assert.ok(!limits.take('a', null), 'the day allows three');
  clock.t += DAY_MS;
  assert.ok(limits.take('a', null), 'a new day');
});

test('per address counts an IPv6 /64 as one address', () => {
  const limits = createRateLimits({ hour: 1 }, { day: 100 }, () => 0);
  assert.ok(limits.take(rateKey('2001:db8:1:2::1'), null));
  assert.ok(!limits.take(rateKey('2001:db8:1:2:ffff::9'), null), 'same /64');
  assert.ok(limits.take(rateKey('2001:db8:1:3::1'), null), 'another /64');
});

test('per account: a signed-in account is limited across addresses; signed out, only the address counts', () => {
  const limits = createRateLimits({ hour: 100 }, { day: 2 }, () => 0);
  assert.ok(limits.take('a1', 'u1'));
  assert.ok(limits.take('a2', 'u1'));
  assert.ok(!limits.take('a3', 'u1'), 'the account is over its day');
  assert.ok(limits.take('a3', 'u2'), 'another account');
  assert.ok(limits.take('a3', null), 'signed out');
});

test('a flood of addresses never holds more than the key bound per window', () => {
  const limits = createRateLimits({ hour: 5, day: 10 }, { day: 10 }, () => 0, 1_000);
  for (let i = 0; i < 5_000; i++) limits.take(`10.0.${i >> 8}.${i & 255}`, null);
  assert.ok(limits.sizes().every((n) => n <= 1_000), limits.sizes().join(','));
});

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
