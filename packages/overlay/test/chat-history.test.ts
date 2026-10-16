/**
 * The conversation kept in the visitor's browser (overlay chat-history.ts,
 * chat-block-spec §21.1.4, §19.11): a round trip; who it is kept for — a
 * salted hash of the account, the browser for nobody, cleared when that
 * changes, the raw id never stored; two tabs on one chat — revisions, a
 * conflict refused, a clear elsewhere never undone; the size and count caps
 * and what goes first; the 7-day expiry on a fake clock; Clear; corrupt
 * storage of every kind read as nothing and removed; an accessor that throws
 * on every call, and no storage at all — the chat still works, keeping nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER, HISTORY_KEY, HISTORY_LIMITS, browserStorage, createHistory, historyKeyOf, readHistory, sameTurns, turnsOf,
  type HistoryOptions, type StorageLike, type StoredTurn,
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
const SHARE = { at: 1_000, tag: 'S'.repeat(43), tagq: 'Q'.repeat(43) };
const DAY = 24 * 60 * 60 * 1000;
const ACCOUNT = '7f1c2a90-5b1e-4c55-9d0e-6a1f3c2b8e11';

/** n whole exchanges, each answer `size` characters of prose with a follow-up. */
function exchanges(n: number, size = 20, from = 0): StoredTurn[] {
  const out: StoredTurn[] = [];
  for (let i = from; i < from + n; i++) {
    out.push({ role: 'visitor', text: `Question ${i}?` });
    const s = `Answer ${i}. `.padEnd(size, 'x');
    out.push({ role: 'site', text: `${s}\nask "More?"\n`, tag: TAG, events: [{ type: 'text', s }, { type: 'block', block: { ask: 'More?' } }] });
  }
  return out;
}

/** The conversations the key holds now, by chat key (none when it is absent or holds none). */
const keptKeys = (storage: { map: Map<string, string> }, now = 1_000_000) => [...readHistory(storage.map.get(HISTORY_KEY) ?? null, now).chats.keys()];

/** A history on `storage` already bound to `subject` (null: nobody signed in), with a fixed clock. */
async function bound(storage: StorageLike | null, subject: string | null = null, o: HistoryOptions = {}) {
  const h = createHistory(storage, { now: () => 1_000_000, ...o });
  await h.bind(subject);
  return h;
}

test('a conversation kept is the same conversation read back — with its revision and share tags — and the history a request carries', async () => {
  const storage = memoryStorage();
  const h = await bound(storage);
  assert.equal(h.available, true);
  const turns = exchanges(2);
  const shared: StoredTurn[] = [turns[0], { ...(turns[1] as Extract<StoredTurn, { role: 'site' }>), share: SHARE }, turns[2], turns[3]];
  assert.deepEqual(h.save('panel:/open', CONV, shared, 0), { kept: true, rev: 1 });
  const back = h.load('panel:/open');
  assert.deepEqual(back, { conversation: CONV, saved: 1_000_000, rev: 1, turns: shared });
  assert.deepEqual(turnsOf(back!.turns), [
    { role: 'visitor', text: 'Question 0?' }, { role: 'site', text: turns[1].text, tag: TAG },
    { role: 'visitor', text: 'Question 1?' }, { role: 'site', text: turns[3].text, tag: TAG },
  ]);
  // One key for the site; the probe left nothing behind.
  assert.deepEqual([...storage.map.keys()], [HISTORY_KEY]);
  // Another chat's key reads nothing.
  assert.equal(h.load('float'), null);
});

test('nothing is read or written before bind() says who is reading', () => {
  const storage = memoryStorage();
  const h = createHistory(storage, { now: () => 1 });
  assert.deepEqual(h.save('panel:/a', CONV, exchanges(1), 0), { kept: false, why: 'unbound' });
  assert.equal(storage.map.has(HISTORY_KEY), false);
  assert.equal(h.load('panel:/a'), null);
});

test('bound to the account as a salted hash — never the id; another account, a sign-out, or a sign-in over a stranger\'s chat each start empty', async () => {
  const storage = memoryStorage();
  const a = await bound(storage, ACCOUNT);
  a.save('panel:/a', CONV, exchanges(1), 0);
  const raw = storage.map.get(HISTORY_KEY)!;
  assert.ok(!raw.includes(ACCOUNT), 'the account id is never stored');
  const root = JSON.parse(raw) as { salt: string; bound: string };
  assert.match(root.salt, /^[A-Za-z0-9_-]{22}$/);
  assert.match(root.bound, /^a:[A-Za-z0-9_-]{43}$/);
  // The same account in a new page (a reload): its chat is there, nothing removed.
  const again = createHistory(storage, { now: () => 1_000_000 });
  assert.equal(await again.bind(ACCOUNT), false);
  assert.notEqual(again.load('panel:/a'), null);
  // Another account on this browser: everything kept goes before anything is read.
  const other = createHistory(storage, { now: () => 1_000_000 });
  assert.equal(await other.bind('another-account'), true);
  assert.equal(other.load('panel:/a'), null);
  assert.deepEqual(keptKeys(storage), [], 'the other account\'s chat is gone from storage');
  assert.notEqual(JSON.parse(storage.map.get(HISTORY_KEY)!).bound, root.bound, 'and the key is bound to the new reader');
  // A signed-in chat kept, then the page read signed out (an `allow anyone` chat, bound to the browser): gone.
  (await bound(storage, ACCOUNT)).save('float', CONV, exchanges(1), 0);
  const signedOut = createHistory(storage, { now: () => 1_000_000 });
  assert.equal(await signedOut.bind(null), true);
  assert.equal(signedOut.load('float'), null);
  // A stranger's chat on a chat open to anyone, then someone signs in: cleared at the sign-in.
  const stranger = await bound(storage, null);
  stranger.save('float', CONV, exchanges(1), 0);
  assert.equal(JSON.parse(storage.map.get(HISTORY_KEY)!).bound, BROWSER);
  const signedIn = createHistory(storage, { now: () => 1_000_000 });
  assert.equal(await signedIn.bind(ACCOUNT), true);
  assert.equal(signedIn.load('float'), null);
  // CONTROL: nobody signed in again, the same browser: its own chat stays.
  const s2 = await bound(storage, null);
  s2.save('float', CONV, exchanges(1), 0);
  const back = createHistory(storage, { now: () => 1_000_000 });
  assert.equal(await back.bind(null), false);
  assert.notEqual(back.load('float'), null);
});

test('the hash is salted: two browsers name the same account differently; a tab bound to someone else never writes over theirs', async () => {
  const one = memoryStorage();
  const two = memoryStorage();
  (await bound(one, ACCOUNT)).save('float', CONV, exchanges(1), 0);
  (await bound(two, ACCOUNT)).save('float', CONV, exchanges(1), 0);
  assert.notEqual(JSON.parse(one.map.get(HISTORY_KEY)!).bound, JSON.parse(two.map.get(HISTORY_KEY)!).bound);
  // A tab still bound to A, after another tab signed in as B and kept B's chat: A's save is refused, B's chat stands.
  const storage = memoryStorage();
  const tabA = await bound(storage, ACCOUNT);
  const tabB = createHistory(storage, { now: () => 1_000_000 });
  await tabB.bind('someone-else');
  tabB.save('float', CONV, exchanges(1, 20, 5), 0);
  assert.deepEqual(tabA.save('float', CONV, exchanges(1), 0), { kept: false, why: 'unbound' });
  assert.equal(tabA.load('float'), null, 'and A reads nothing of B\'s');
  assert.deepEqual(tabB.load('float')?.turns, exchanges(1, 20, 5));
});

test('no Web Crypto to hash with: nothing is shown, and what was kept goes', async () => {
  const storage = memoryStorage();
  (await bound(storage, ACCOUNT)).save('float', CONV, exchanges(1), 0);
  const h = createHistory(storage, { now: () => 1_000_000, digest: () => Promise.reject(new Error('no subtle crypto')) });
  assert.equal(await h.bind(ACCOUNT), true);
  assert.equal(h.load('float'), null);
  assert.equal(storage.map.has(HISTORY_KEY), false);
  assert.deepEqual(h.save('float', CONV, exchanges(1), 0), { kept: false, why: 'unbound' });
});

test('two tabs opened at once for one account hash it with one salt: the second tab\'s bind takes the first tab\'s', async () => {
  const storage = memoryStorage();
  // Both bind before either has kept anything: the second hashes again with the key the first made.
  const [one, two] = [createHistory(storage, { now: () => 1_000_000 }), createHistory(storage, { now: () => 1_000_000 })];
  await Promise.all([one.bind(ACCOUNT), two.bind(ACCOUNT)]);
  assert.deepEqual(one.save('float', CONV, exchanges(1), 0), { kept: true, rev: 1 });
  assert.deepEqual(two.load('float')?.rev, 1, 'the other tab reads it: the same reader');
  assert.deepEqual(two.save('float', CONV, exchanges(2), 1), { kept: true, rev: 2 });
});

test('two tabs on one chat: each save is the next revision; a newer revision this tab has not seen is never overwritten (conflict); a clear elsewhere is never undone', async () => {
  const storage = memoryStorage();
  const tabA = await bound(storage);
  const tabB = await bound(storage);
  // A answers first: revision 1. B, idle, draws it (the page does, on the storage event) and goes on: revision 2.
  assert.deepEqual(tabA.save('float', CONV, exchanges(1), 0), { kept: true, rev: 1 });
  const seen = tabB.load('float')!;
  assert.equal(seen.rev, 1);
  assert.deepEqual(tabB.save('float', CONV, exchanges(2), seen.rev), { kept: true, rev: 2 });
  // A, still at revision 1, answers on its own: its turns are not B's — refused, and B's stand.
  const mine = [...exchanges(1), ...exchanges(1, 20, 9)];
  assert.deepEqual(tabA.save('float', CONV, mine, 1), { kept: false, why: 'conflict' });
  assert.deepEqual(tabA.load('float')?.turns, exchanges(2), 'B\'s turns kept whole');
  // A tab that saw an older revision but whose turns extend the kept ones loses nothing by saving them.
  assert.deepEqual(tabA.save('float', CONV, exchanges(3), 1), { kept: true, rev: 3 });
  // Cleared in B (Clear history, or a sign-out): A's next save does not bring it back.
  tabB.clear();
  assert.deepEqual(tabA.save('float', CONV, exchanges(4), 3), { kept: false, why: 'cleared' });
  assert.equal(storage.map.has(HISTORY_KEY), false);
  // A new chat starts from no revision, and is kept.
  assert.deepEqual(tabA.save('float', 'n3w-conversation-0002', exchanges(1), 0), { kept: true, rev: 1 });
  assert.equal(tabA.watches(HISTORY_KEY), true);
  assert.equal(tabA.watches(null), true, 'the whole storage cleared');
  assert.equal(tabA.watches('another-key'), false);
});

test('sameTurns: the start of a conversation by role, text and tag', () => {
  assert.equal(sameTurns(exchanges(1), exchanges(2)), true);
  assert.equal(sameTurns(exchanges(2), exchanges(2)), true);
  assert.equal(sameTurns(exchanges(2), exchanges(1)), false);
  assert.equal(sameTurns(exchanges(1, 20, 1), exchanges(2)), false);
  const retagged = exchanges(1).map((t) => (t.role === 'site' ? { ...t, tag: 'ZzZzZzZzZzZzZzZzZzZzZz' } : t));
  assert.equal(sameTurns(retagged, exchanges(1)), false);
});

test('a float is one conversation across pages; a panel its page\'s own', () => {
  assert.equal(historyKeyOf({ page: '/a', narrow: 640 }), 'float');
  assert.equal(historyKeyOf({ page: '/b', narrow: 640 }), 'float');
  assert.equal(historyKeyOf({ page: '/a', narrow: null }), 'panel:/a');
});

test(`caps: ${HISTORY_LIMITS.chats} conversations, the least recently saved goes first`, async () => {
  let now = 1_000_000;
  const h = await bound(memoryStorage(), null, { now: () => now });
  for (let i = 0; i < HISTORY_LIMITS.chats + 2; i++) { now += 1000; h.save(`panel:/p${i}`, CONV, exchanges(1), 0); }
  assert.equal(h.load('panel:/p0'), null);
  assert.equal(h.load('panel:/p1'), null);
  for (let i = 2; i < HISTORY_LIMITS.chats + 2; i++) assert.notEqual(h.load(`panel:/p${i}`), null, `p${i}`);
});

test(`caps: ${HISTORY_LIMITS.bytes / 1024} KB — others go first, then the conversation keeps its longest prefix of whole exchanges`, async () => {
  const storage = memoryStorage();
  let now = 1_000_000;
  const h = await bound(storage, null, { now: () => now });
  // An answer of 10 000 characters is about 20 000 kept (its record and its events).
  h.save('panel:/old', CONV, exchanges(6, 10_000), 0);
  now += 1000;
  h.save('panel:/new', CONV, exchanges(8, 10_000), 0);
  // Both would pass the cap: the older conversation went.
  assert.equal(h.load('panel:/old'), null);
  assert.equal(h.load('panel:/new')?.turns.length, 16);
  // Alone and too large: a prefix, which is still a valid tagged history.
  now += 1000;
  assert.deepEqual(h.save('panel:/new', CONV, exchanges(16, 10_000), 1), { kept: true, rev: 2 });
  const kept = h.load('panel:/new')!;
  assert.ok(kept.turns.length < 32 && kept.turns.length >= 2 && kept.turns.length % 2 === 0, String(kept.turns.length));
  assert.deepEqual(kept.turns, exchanges(16, 10_000).slice(0, kept.turns.length));
  assert.ok(storage.map.get(HISTORY_KEY)!.length <= HISTORY_LIMITS.bytes);
  // One answer larger than the cap on its own: nothing is kept of it.
  assert.deepEqual(h.save('panel:/huge', CONV, exchanges(1, HISTORY_LIMITS.bytes + 1), 0), { kept: false, why: 'storage' });
  assert.equal(h.load('panel:/huge'), null);
});

test('a quota smaller than the cap: the conversation alone is tried once more, and failing that nothing breaks', async () => {
  const h = await bound(memoryStorage(30_000));
  h.save('panel:/a', CONV, exchanges(1, 9_000), 0);
  assert.deepEqual(h.save('panel:/b', CONV, exchanges(1, 9_000), 0), { kept: true, rev: 1 });
  assert.equal(h.load('panel:/a'), null, 'the other one made room');
  assert.notEqual(h.load('panel:/b'), null);
  assert.deepEqual((await bound(memoryStorage(10))).save('panel:/c', CONV, exchanges(1), 0), { kept: false, why: 'storage' });
});

test(`expiry: ${HISTORY_LIMITS.maxAgeMs / DAY} days after the last save it is gone, and removed`, async () => {
  const storage = memoryStorage();
  let now = 10 * DAY;
  const h = await bound(storage, null, { now: () => now });
  h.save('panel:/a', CONV, exchanges(1), 0);
  now += HISTORY_LIMITS.maxAgeMs;
  assert.notEqual(h.load('panel:/a'), null, 'at exactly 7 days it is still there');
  now += 1;
  assert.equal(h.load('panel:/a'), null);
  assert.deepEqual(keptKeys(storage, now), [], 'the expired conversation was removed');
  assert.ok(!storage.map.get(HISTORY_KEY)!.includes('Question 0'), 'its words too');
  // A saved time far in the future (a forged or broken clock) is not believed.
  const root = { v: 2, salt: 's'.repeat(22), bound: BROWSER };
  storage.setItem(HISTORY_KEY, JSON.stringify({ ...root, chats: { 'panel:/a': { conversation: CONV, saved: 3 * DAY, rev: 1, turns: exchanges(1) } } }));
  const later = await bound(storage, null, { now: () => 0 });
  assert.equal(later.load('panel:/a'), null);
});

test('clear forgets every chat on the site; remove forgets one; an empty save forgets it', async () => {
  const storage = memoryStorage();
  const h = await bound(storage);
  h.save('panel:/a', CONV, exchanges(1), 0);
  h.save('float', CONV, exchanges(1), 0);
  h.remove('panel:/a');
  assert.equal(h.load('panel:/a'), null);
  assert.notEqual(h.load('float'), null);
  h.save('float', CONV, [], 1);
  assert.deepEqual(keptKeys(storage), []);
  h.save('float', CONV, exchanges(1), 0);
  h.clear();
  assert.equal(storage.map.has(HISTORY_KEY), false);
  assert.equal(h.load('float'), null);
});

test('corrupt storage reads as nothing kept, and the bad value is removed — never half-restored', async () => {
  const good = { conversation: CONV, saved: 1, rev: 1, turns: exchanges(1) };
  const site = good.turns[1] as Extract<StoredTurn, { role: 'site' }>;
  const root = { v: 2, salt: 's'.repeat(22), bound: BROWSER };
  const one = (chat: unknown, key = 'panel:/a') => JSON.stringify({ ...root, chats: { [key]: chat } });
  const cases: Record<string, string> = {
    'not JSON': '{',
    'not an object': '[]',
    'the version before the binding': JSON.stringify({ v: 1, chats: { 'panel:/a': good } }),
    'no binding': JSON.stringify({ v: 2, salt: root.salt, chats: { 'panel:/a': good } }),
    'a binding that is no hash': JSON.stringify({ ...root, bound: ACCOUNT, chats: { 'panel:/a': good } }),
    'a bad salt': JSON.stringify({ ...root, salt: 'x', chats: { 'panel:/a': good } }),
    'chats not an object': JSON.stringify({ ...root, chats: [] }),
    'no revision': one({ conversation: CONV, saved: 1, turns: exchanges(1) }),
    'a revision of 0': one({ ...good, rev: 0 }),
    'a bad conversation id': one({ ...good, conversation: 'x' }),
    'a visitor turn with a control character': one({ ...good, turns: [{ role: 'visitor', text: 'hi\u0007' }, site] }),
    'a visitor turn too long': one({ ...good, turns: [{ role: 'visitor', text: 'q'.repeat(1001) }, site] }),
    'two visitor turns': one({ ...good, turns: [good.turns[0], good.turns[0]] }),
    'half an exchange': one({ ...good, turns: [good.turns[0]] }),
    'a tag of the wrong shape': one({ ...good, turns: [good.turns[0], { ...site, tag: 'x"><script>' }] }),
    'an extra key on a turn': one({ ...good, turns: [good.turns[0], { ...site, html: '<b>' }] }),
    'share tags of the wrong shape': one({ ...good, turns: [good.turns[0], { ...site, share: { ...SHARE, tag: 'short' } }] }),
    'share tags with an extra key': one({ ...good, turns: [good.turns[0], { ...site, share: { ...SHARE, url: 'https://x' } }] }),
    'an event of an unknown kind': one({ ...good, turns: [good.turns[0], { ...site, events: [{ type: 'html', s: '<img src=x onerror=alert(1)>' }] }] }),
    'a block of an unknown shape': one({ ...good, turns: [good.turns[0], { ...site, events: [{ type: 'block', block: { cta: { label: 'x', to: 'javascript:alert(1)' } } }] }] }),
    'a follow-up with a line break': one({ ...good, turns: [good.turns[0], { ...site, events: [{ type: 'block', block: { ask: 'a\nb' } }] }] }),
    'a record past the cap': one({ ...good, turns: [good.turns[0], { ...site, text: 'x'.repeat(12_001) }] }),
    'a key that is no chat\'s': one(good, 'panel:javascript:x'),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const storage = memoryStorage();
    storage.setItem(HISTORY_KEY, raw);
    const h = await bound(storage, null, { now: () => 1 });
    assert.equal(h.load('panel:/a'), null, name);
    assert.deepEqual(keptKeys(storage, 1), [], `${name}: removed`);
    assert.notEqual(storage.map.get(HISTORY_KEY), raw, `${name}: not left as it was`);
  }
  // One bad conversation goes; a good one beside it stays.
  const storage = memoryStorage();
  storage.setItem(HISTORY_KEY, JSON.stringify({ ...root, chats: { 'panel:/a': { ...good, conversation: 'x' }, 'panel:/b': good } }));
  const h = await bound(storage, null, { now: () => 1 });
  assert.notEqual(h.load('panel:/b'), null);
  assert.deepEqual([...readHistory(storage.map.get(HISTORY_KEY)!, 1).chats.keys()], ['panel:/b']);
});

test('storage that throws on every call, or none at all: nothing kept, nothing thrown, not offered', async () => {
  const throwing: StorageLike = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  for (const storage of [throwing, null]) {
    const h = createHistory(storage, { now: () => 1 });
    assert.equal(h.available, false);
    await assert.doesNotReject(h.bind(ACCOUNT));
    assert.equal(h.save('panel:/a', CONV, exchanges(1), 0).kept, false);
    assert.equal(h.load('panel:/a'), null);
    assert.doesNotThrow(() => { h.remove('panel:/a'); h.clear(); });
  }
  // Reading the property itself throws where site data is blocked.
  const blocked = { get localStorage(): StorageLike { throw new Error('SecurityError'); } };
  assert.equal(browserStorage(blocked), null);
  assert.equal(browserStorage(null), null);
});
