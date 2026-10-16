/**
 * The conversation kept in the visitor's browser (overlay chat-history.ts,
 * chat-block-spec §21.1.4): a round trip; the size and count caps and what
 * goes first; the 7-day expiry on a fake clock; Clear; corrupt storage of
 * every kind read as nothing and removed; an accessor that throws on every
 * call, and no storage at all — the chat still works, keeping nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_KEY, HISTORY_LIMITS, browserStorage, createHistory, historyKeyOf, readHistory, turnsOf, type StorageLike, type StoredTurn,
} from '../src/runtime/chat-history.ts';

/** An in-memory Storage, with a quota in UTF-16 units like an engine's. */
function memoryStorage(quota = 5 * 1024 * 1024) {
  const map = new Map<string, string>();
  const s: StorageLike & { map: Map<string, string> } = {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      const used = [...map].reduce((n, [key, val]) => n + (key === k ? 0 : key.length + val.length), 0);
      if (used + k.length + v.length > quota) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k) => { map.delete(k); },
  };
  return s;
}

const CONV = 'c0nversation-id-0001';
const TAG = 'AbCdEfGhIjKlMnOpQrStUv';
const DAY = 24 * 60 * 60 * 1000;

/** n whole exchanges, each answer `size` characters of prose with a follow-up. */
function exchanges(n: number, size = 20): StoredTurn[] {
  const out: StoredTurn[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'visitor', text: `Question ${i}?` });
    const s = `Answer ${i}. `.padEnd(size, 'x');
    out.push({ role: 'site', text: `${s}\nask "More?"\n`, tag: TAG, events: [{ type: 'text', s }, { type: 'block', block: { ask: 'More?' } }] });
  }
  return out;
}

test('a conversation kept is the same conversation read back, and the history a request carries', () => {
  const storage = memoryStorage();
  const h = createHistory(storage, () => 1_000_000);
  assert.equal(h.available, true);
  const turns = exchanges(2);
  assert.equal(h.save('panel:/open', CONV, turns), true);
  const back = h.load('panel:/open');
  assert.deepEqual(back, { conversation: CONV, saved: 1_000_000, turns });
  assert.deepEqual(turnsOf(back!.turns), [
    { role: 'visitor', text: 'Question 0?' }, { role: 'site', text: turns[1].text, tag: TAG },
    { role: 'visitor', text: 'Question 1?' }, { role: 'site', text: turns[3].text, tag: TAG },
  ]);
  // One key for the site; the probe left nothing behind.
  assert.deepEqual([...storage.map.keys()], [HISTORY_KEY]);
  // Another chat's key reads nothing.
  assert.equal(h.load('float'), null);
});

test('a float is one conversation across pages; a panel its page\'s own', () => {
  assert.equal(historyKeyOf({ page: '/a', narrow: 640 }), 'float');
  assert.equal(historyKeyOf({ page: '/b', narrow: 640 }), 'float');
  assert.equal(historyKeyOf({ page: '/a', narrow: null }), 'panel:/a');
});

test(`caps: ${HISTORY_LIMITS.chats} conversations, the least recently saved goes first`, () => {
  let now = 1_000_000;
  const h = createHistory(memoryStorage(), () => now);
  for (let i = 0; i < HISTORY_LIMITS.chats + 2; i++) { now += 1000; h.save(`panel:/p${i}`, CONV, exchanges(1)); }
  assert.equal(h.load('panel:/p0'), null);
  assert.equal(h.load('panel:/p1'), null);
  for (let i = 2; i < HISTORY_LIMITS.chats + 2; i++) assert.notEqual(h.load(`panel:/p${i}`), null, `p${i}`);
});

test(`caps: ${HISTORY_LIMITS.bytes / 1024} KB — others go first, then the conversation keeps its longest prefix of whole exchanges`, () => {
  const storage = memoryStorage();
  let now = 1_000_000;
  const h = createHistory(storage, () => now);
  // An answer of 10 000 characters is about 20 000 kept (its record and its events).
  h.save('panel:/old', CONV, exchanges(6, 10_000));
  now += 1000;
  h.save('panel:/new', CONV, exchanges(8, 10_000));
  // Both would pass the cap: the older conversation went.
  assert.equal(h.load('panel:/old'), null);
  assert.equal(h.load('panel:/new')?.turns.length, 16);
  // Alone and too large: a prefix, which is still a valid tagged history.
  now += 1000;
  assert.equal(h.save('panel:/new', CONV, exchanges(16, 10_000)), true);
  const kept = h.load('panel:/new')!;
  assert.ok(kept.turns.length < 32 && kept.turns.length >= 2 && kept.turns.length % 2 === 0, String(kept.turns.length));
  assert.deepEqual(kept.turns, exchanges(16, 10_000).slice(0, kept.turns.length));
  assert.ok(storage.map.get(HISTORY_KEY)!.length <= HISTORY_LIMITS.bytes);
  // One answer larger than the cap on its own: nothing is kept of it.
  assert.equal(h.save('panel:/huge', CONV, exchanges(1, HISTORY_LIMITS.bytes + 1)), false);
  assert.equal(h.load('panel:/huge'), null);
});

test('a quota smaller than the cap: the conversation alone is tried once more, and failing that nothing breaks', () => {
  const h = createHistory(memoryStorage(30_000), () => 1_000_000);
  h.save('panel:/a', CONV, exchanges(1, 9_000));
  assert.equal(h.save('panel:/b', CONV, exchanges(1, 9_000)), true);
  assert.equal(h.load('panel:/a'), null, 'the other one made room');
  assert.notEqual(h.load('panel:/b'), null);
  assert.equal(createHistory(memoryStorage(10), () => 1).save('panel:/c', CONV, exchanges(1)), false);
});

test(`expiry: ${HISTORY_LIMITS.maxAgeMs / DAY} days after the last save it is gone, and removed`, () => {
  const storage = memoryStorage();
  let now = 10 * DAY;
  const h = createHistory(storage, () => now);
  h.save('panel:/a', CONV, exchanges(1));
  now += HISTORY_LIMITS.maxAgeMs;
  assert.notEqual(h.load('panel:/a'), null, 'at exactly 7 days it is still there');
  now += 1;
  assert.equal(h.load('panel:/a'), null);
  assert.equal(storage.map.has(HISTORY_KEY), false, 'the expired conversation was removed');
  // A saved time far in the future (a forged or broken clock) is not believed.
  const later = createHistory(storage, () => 0);
  storage.setItem(HISTORY_KEY, JSON.stringify({ v: 1, chats: { 'panel:/a': { conversation: CONV, saved: 3 * DAY, turns: exchanges(1) } } }));
  assert.equal(later.load('panel:/a'), null);
});

test('clear forgets every chat on the site; remove forgets one; an empty save forgets it', () => {
  const storage = memoryStorage();
  const h = createHistory(storage, () => 1);
  h.save('panel:/a', CONV, exchanges(1));
  h.save('float', CONV, exchanges(1));
  h.remove('panel:/a');
  assert.equal(h.load('panel:/a'), null);
  assert.notEqual(h.load('float'), null);
  h.save('float', CONV, []);
  assert.equal(storage.map.has(HISTORY_KEY), false);
  h.save('float', CONV, exchanges(1));
  h.clear();
  assert.equal(storage.map.has(HISTORY_KEY), false);
  assert.equal(h.load('float'), null);
});

test('corrupt storage reads as nothing kept, and the bad value is removed — never half-restored', () => {
  const good = { conversation: CONV, saved: 1, turns: exchanges(1) };
  const site = good.turns[1] as Extract<StoredTurn, { role: 'site' }>;
  const cases: Record<string, string> = {
    'not JSON': '{',
    'not an object': '[]',
    'another version': JSON.stringify({ v: 2, chats: {} }),
    'chats not an object': JSON.stringify({ v: 1, chats: [] }),
    'a bad conversation id': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, conversation: 'x' } } }),
    'a visitor turn with a control character': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [{ role: 'visitor', text: 'hi\u0007' }, site] } } }),
    'a visitor turn too long': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [{ role: 'visitor', text: 'q'.repeat(1001) }, site] } } }),
    'two visitor turns': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0], good.turns[0]] } } }),
    'half an exchange': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0]] } } }),
    'a tag of the wrong shape': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0], { ...site, tag: 'x"><script>' }] } } }),
    'an extra key on a turn': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0], { ...site, html: '<b>' }] } } }),
    'an event of an unknown kind': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0], { ...site, events: [{ type: 'html', s: '<img src=x onerror=alert(1)>' }] }] } } }),
    'a block of an unknown shape': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0], { ...site, events: [{ type: 'block', block: { cta: { label: 'x', to: 'javascript:alert(1)' } } }] }] } } }),
    'a follow-up with a line break': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0], { ...site, events: [{ type: 'block', block: { ask: 'a\nb' } }] }] } } }),
    'a record past the cap': JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, turns: [good.turns[0], { ...site, text: 'x'.repeat(12_001) }] } } }),
    'a key that is no chat\'s': JSON.stringify({ v: 1, chats: { 'panel:javascript:x': good } }),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const storage = memoryStorage();
    storage.setItem(HISTORY_KEY, raw);
    const h = createHistory(storage, () => 1);
    assert.equal(h.load('panel:/a'), null, name);
    assert.equal(storage.map.has(HISTORY_KEY), false, `${name}: removed`);
  }
  // One bad conversation goes; a good one beside it stays.
  const storage = memoryStorage();
  storage.setItem(HISTORY_KEY, JSON.stringify({ v: 1, chats: { 'panel:/a': { ...good, conversation: 'x' }, 'panel:/b': good } }));
  const h = createHistory(storage, () => 1);
  assert.notEqual(h.load('panel:/b'), null);
  assert.deepEqual([...readHistory(storage.map.get(HISTORY_KEY)!, 1).chats.keys()], ['panel:/b']);
});

test('storage that throws on every call, or none at all: nothing kept, nothing thrown, not offered', () => {
  const throwing: StorageLike = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  for (const storage of [throwing, null]) {
    const h = createHistory(storage, () => 1);
    assert.equal(h.available, false);
    assert.equal(h.save('panel:/a', CONV, exchanges(1)), false);
    assert.equal(h.load('panel:/a'), null);
    assert.doesNotThrow(() => { h.remove('panel:/a'); h.clear(); });
  }
  // Reading the property itself throws where site data is blocked.
  const blocked = { get localStorage(): StorageLike { throw new Error('SecurityError'); } };
  assert.equal(browserStorage(blocked), null);
  assert.equal(browserStorage(null), null);
});
