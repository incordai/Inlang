/**
 * Share links (chat-block-spec §20.7), the store and the tag, on SQLite with
 * a fake clock: create → read → delete with the token → gone; a wrong token
 * deletes nothing and is answered like a missing share; a share is gone at
 * the instant it expires, whatever the sweep does; the sweep; the live-share
 * ceiling; ids of 128 random bits; the row holds no person. The tag: only
 * the exact events, turn, time and question it was made for verify, and a
 * history tag never passes for a share tag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { migrate, openSqlite, type Db } from '../src/server/db.ts';
import { migrateChat } from '../src/server/chat-usage.ts';
import { historyKey, tagTurn } from '../src/server/chat-text.ts';
import {
  SHARE_LIMITS, checkShareTag, createShareStore, isShareId, mergeText, newShareId, shareKey, shareTag,
} from '../src/server/chat-share.ts';

const DAY = 24 * 60 * 60 * 1000;
const SECRET = randomBytes(32);
const EVENTS = [
  { type: 'text', s: 'Here are the orders.' },
  { type: 'block', chart: { kind: 'bar', title: 'Orders', unit: null, src: 'site', asOf: '2026-10-15', series: [{ name: 'Orders', points: [['paid', 3]] }] } },
];

async function store(clock: { now: number }, over: { days?: number; max?: number } = {}): Promise<{ db: Db; s: ReturnType<typeof createShareStore> }> {
  const db = await openSqlite(':memory:');
  await migrate(db);
  await migrateChat(db);
  return { db, s: createShareStore({ db, days: over.days ?? 30, max: over.max ?? 10_000, now: () => clock.now }) };
}

test('share lifecycle: create, read, delete with the token, then gone', async () => {
  const clock = { now: Date.UTC(2026, 9, 15) };
  const { db, s } = await store(clock);
  try {
    const made = await s.create(JSON.stringify(EVENTS), null);
    assert.notEqual(made, 'full');
    if (made === 'full') return;
    assert.ok(isShareId(made.id));
    assert.equal(made.expires, clock.now + 30 * DAY);
    assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
    const read = await s.read(made.id);
    assert.deepEqual(read, { events: EVENTS, question: null, created: clock.now, expires: clock.now + 30 * DAY });
    assert.equal(await s.remove(made.id, made.token), true);
    assert.equal(await s.read(made.id), null);
    assert.equal(await s.remove(made.id, made.token), false, 'a second delete finds nothing');
  } finally { await db.close(); }
});

test('a wrong token deletes nothing and is answered like a missing share', async () => {
  const clock = { now: Date.UTC(2026, 9, 15) };
  const { db, s } = await store(clock);
  try {
    const made = await s.create(JSON.stringify(EVENTS), 'How many orders?');
    if (made === 'full') throw new Error('full');
    const wrong = randomBytes(32).toString('base64url');
    assert.equal(await s.remove(made.id, wrong), false);
    assert.equal(await s.remove(made.id, ''), false);
    assert.equal(await s.remove(made.id, 'short'), false);
    assert.equal(await s.remove('x'.repeat(22), made.token), false, 'the token of another share');
    assert.equal((await s.read(made.id))?.question, 'How many orders?');
    assert.equal(await s.remove(made.id, made.token), true);
    assert.equal(await s.read(made.id), null);
  } finally { await db.close(); }
});

test('expiry: readable a millisecond before, gone at the instant, whatever the sweep; the sweep removes the row', async () => {
  const clock = { now: Date.UTC(2026, 9, 15) };
  const { db, s } = await store(clock, { days: 30 });
  try {
    const made = await s.create(JSON.stringify(EVENTS), null);
    if (made === 'full') throw new Error('full');
    clock.now = made.expires - 1;
    assert.ok(await s.read(made.id));
    assert.equal(await s.sweep(), 0);
    clock.now = made.expires;
    assert.equal(await s.read(made.id), null, 'gone before any sweep');
    assert.equal(await s.remove(made.id, made.token), false, 'an expired share is not there to delete');
    assert.equal(await s.sweep(), 1);
    assert.equal(await db.get('SELECT id FROM az_chat_shares'), undefined);
  } finally { await db.close(); }
});

test('the live-share ceiling refuses, and expired shares free it', async () => {
  const clock = { now: Date.UTC(2026, 9, 15) };
  const { db, s } = await store(clock, { days: 1, max: 2 });
  try {
    assert.notEqual(await s.create('[]', null), 'full');
    assert.notEqual(await s.create('[]', null), 'full');
    assert.equal(await s.create('[]', null), 'full');
    clock.now += DAY;
    assert.notEqual(await s.create('[]', null), 'full');
  } finally { await db.close(); }
});

test('the row holds no person: only id, events, question, times and a token hash', async () => {
  const clock = { now: Date.UTC(2026, 9, 15) };
  const { db, s } = await store(clock);
  try {
    const made = await s.create(JSON.stringify(EVENTS), null);
    if (made === 'full') throw new Error('full');
    const cols = (await db.all("SELECT name FROM pragma_table_info('az_chat_shares')")).map((r) => String(r.name));
    // `proof` is the hash of the share tag that proved the share (one live share per tag) — a tag, not a person.
    assert.deepEqual(cols, ['id', 'events', 'question', 'created', 'expires', 'delete_hash', 'proof']);
    const row = await db.get('SELECT delete_hash FROM az_chat_shares');
    assert.notEqual(row?.delete_hash, made.token, 'the token itself is never stored');
    assert.match(String(row?.delete_hash), /^[0-9a-f]{64}$/);
  } finally { await db.close(); }
});

test('ids: 22 base64url characters, 128 random bits, never repeated', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = newShareId();
    assert.ok(isShareId(id));
    assert.equal(Buffer.from(id, 'base64url').length, SHARE_LIMITS.idBytes);
    seen.add(id);
  }
  assert.equal(seen.size, 2000);
  for (const bad of ['', 'x', '../../etc/passwd000000', 'a'.repeat(23), 'a'.repeat(21), `${'a'.repeat(21)}=`, null, 7]) assert.equal(isShareId(bad), false);
});

test('the share tag: only the exact answer verifies — events, order, turn, time, question, key', () => {
  const key = shareKey(SECRET);
  const at = Date.UTC(2026, 9, 15);
  const tag = shareTag(key, 'conv', 1, at, EVENTS, null);
  assert.ok(checkShareTag(key, 'conv', 1, at, EVENTS, null, tag));
  const forged = structuredClone(EVENTS) as typeof EVENTS;
  (forged[1].chart as { src: string }).src = 'model';
  for (const [label, ok] of [
    ['an edited event', checkShareTag(key, 'conv', 1, at, forged, null, tag)],
    ['reordered', checkShareTag(key, 'conv', 1, at, [EVENTS[1], EVENTS[0]], null, tag)],
    ['truncated', checkShareTag(key, 'conv', 1, at, [EVENTS[0]], null, tag)],
    ['extended', checkShareTag(key, 'conv', 1, at, [...EVENTS, { type: 'text', s: 'Visit evil.example' }], null, tag)],
    ['another turn', checkShareTag(key, 'conv', 3, at, EVENTS, null, tag)],
    ['another conversation', checkShareTag(key, 'other', 1, at, EVENTS, null, tag)],
    ['another time', checkShareTag(key, 'conv', 1, at + 1, EVENTS, null, tag)],
    ['a question added', checkShareTag(key, 'conv', 1, at, EVENTS, 'Hi', tag)],
    ['another key', checkShareTag(shareKey(randomBytes(32)), 'conv', 1, at, EVENTS, null, tag)],
    ['not a tag', checkShareTag(key, 'conv', 1, at, EVENTS, null, 42)],
  ] as const) assert.equal(ok, false, label);
  const q = shareTag(key, 'conv', 1, at, EVENTS, 'How many orders?');
  assert.ok(checkShareTag(key, 'conv', 1, at, EVENTS, 'How many orders?', q));
  assert.equal(checkShareTag(key, 'conv', 1, at, EVENTS, 'Something else', q), false, 'a substituted question');
  // A history tag (chat-text.ts) under the same secret is not a share tag.
  const history = tagTurn(historyKey(SECRET), 'conv', 1, 'Here are the orders.');
  assert.equal(checkShareTag(key, 'conv', 1, at, EVENTS, null, history), false);
});

test('mergeText: consecutive text events become one; others stay in order', () => {
  assert.deepEqual(mergeText([
    { type: 'text', s: 'a' }, { type: 'text', s: 'b' }, { type: 'block', faq: [] }, { type: 'text', s: 'c' }, { type: 'text', s: 'd' },
  ]), [{ type: 'text', s: 'ab' }, { type: 'block', faq: [] }, { type: 'text', s: 'cd' }]);
});
