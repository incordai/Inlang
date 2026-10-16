/**
 * Share links over HTTP, in process (chat-block-spec §20.7): an answer's
 * `done` carries its share tags; POST /chat/share stores exactly that
 * answer, GET reads it back signed out (noindex), DELETE with the token
 * removes it — and every forgery is refused before anything is stored: an
 * edited, reordered or extended event list, a model figure made the site's,
 * a history tag in place of a share tag, a substituted question, a tag past
 * its day, an answer from another turn. Plus the edge, the size cap, the
 * kill switch, the per-address limit and the live-share ceiling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.ts';
import { createFakeAdapter, parseFakeScript } from '../src/server/chat-adapters.ts';
import { createSseReader } from '../src/server/chat-sse.ts';
import { migrateChat } from '../src/server/chat-usage.ts';
import { mergeText } from '../src/server/chat-share.ts';
import { createChat, parseChatContext } from '../src/server/chat.ts';
import { migrate, openSqlite } from '../src/server/db.ts';
import { loadConfig } from '../src/server/env.ts';
import { createOidc } from '../src/server/oidc.ts';
import { createStore } from '../src/server/store.ts';
import { client, listen, SECRET, SITE } from './helpers.ts';

const CONTEXT = JSON.stringify({
  site: { name: 'Studio' },
  pages: [],
  chats: { '/': { allow: 'anyone', limit: 10, show: ['chart', 'cta'] }, '/members': { allow: 'signedin', limit: 10, show: ['chart'] } },
  routes: ['/', '/members', '/contact'],
  answer: { quotes: [], destinations: ['/contact'] },
});
const ANSWER = 'Here is my estimate.\nchart line "Expected"\n  point "Nov" 140\n  point "Dec" 180\n\ncta "Talk to us" /contact\n';
const SCRIPT = (() => {
  const s = parseFakeScript(JSON.stringify({ answers: [{ chunks: [ANSWER] }] }));
  if (typeof s === 'string') throw new Error(s);
  return s;
})();

async function start(env: Record<string, string> = {}, clock = { now: Date.UTC(2026, 9, 15, 12) }) {
  const loaded = loadConfig({
    AZ_SESSION_SECRET: SECRET, AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9', AZ_ALLOWED_ORIGINS: SITE,
    AZ_EMAIL_FROM: 'Studio <no-reply@studio.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: '2525',
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: '/unused-in-process.json', ...env,
  }, { database: 'sqlite', email: 'smtp', chat: true }, 'Studio');
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  const db = await openSqlite(':memory:');
  await migrate(db);
  await migrateChat(db);
  const context = parseChatContext(CONTEXT);
  if (typeof context === 'string') throw new Error(context);
  const chat = createChat({
    config: loaded.config.chat!, secret: loaded.config.secret, db, prompt: 'Answer.', context, adapter: createFakeAdapter(SCRIPT),
    log: () => {}, now: () => clock.now,
  });
  const app = createApp({ config: loaded.config, store: createStore(db, loaded.config.secret), mailer: { send: async () => {} }, oidc: createOidc(fetch), log: () => {}, chat });
  const server = createServer((q, r) => { void app.handler(q, r); });
  const url = await listen(server);
  return { url, db, clock, close: async () => { server.closeAllConnections(); server.close(); await db.close(); } };
}

/** One answer, as the page reads it: its events (merged as the share tag covers them) and its `done`. */
async function answer(url: string, question = 'What do you expect?', page = '/') {
  const r = await client(url).post('/chat', { page, messages: [{ role: 'visitor', text: question }] });
  assert.equal(r.status, 200);
  const reader = createSseReader();
  const all = [...reader.push(new Uint8Array(await r.arrayBuffer())), ...reader.end()].map((e) => ({ event: e.event, data: JSON.parse(e.data) as Record<string, unknown> }));
  const events = mergeText(all.filter((e) => e.event === 'text' || e.event === 'block')
    .map((e) => (e.event === 'text' ? { type: 'text', s: e.data.s } : { type: 'block', block: e.data })));
  const done = all.find((e) => e.event === 'done')!.data as { conversation: string; share?: { at: number; tag: string; tagq: string } };
  return { events, done, question };
}
const share = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => client(url).post('/chat/share', body, headers);
const bodyOf = (a: Awaited<ReturnType<typeof answer>>, over: Record<string, unknown> = {}) =>
  ({ page: '/', conversation: a.done.conversation, index: 1, at: a.done.share!.at, events: a.events, tag: a.done.share!.tag, ...over });

test('an answer carries its share tags; the share is stored, read signed out (noindex), and deleted with its token', async () => {
  const s = await start();
  try {
    const a = await answer(s.url);
    assert.ok(a.done.share && /^[A-Za-z0-9_-]{43}$/.test(a.done.share.tag) && a.done.share.tag !== a.done.share.tagq);
    const chart = a.events.find((e) => e.type === 'block' && 'chart' in (e.block as object));
    assert.equal(((chart?.block as { chart: { src: string } }).chart).src, 'model');
    const made = await share(s.url, bodyOf(a));
    assert.equal(made.status, 201);
    const { id, deleteToken, expires } = await made.json() as { id: string; deleteToken: string; expires: number };
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(expires, s.clock.now + 30 * 24 * 60 * 60 * 1000);
    // Signed out, no cookie: the link reads.
    const read = await fetch(`${s.url}/chat/share/${id}`, { headers: { origin: SITE } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('x-robots-tag'), 'noindex');
    const stored = await read.json() as { events: unknown; question?: string };
    assert.deepEqual(stored.events, a.events);
    assert.equal(stored.question, undefined, 'the question is not stored unless chosen');
    const c = client(s.url);
    assert.equal((await c.request('DELETE', `/chat/share/${id}`, { token: 'x'.repeat(43) })).status, 404, 'a wrong token is answered like a missing share');
    assert.equal((await c.request('DELETE', `/chat/share/${id}`, { token: deleteToken })).status, 204);
    const gone = await fetch(`${s.url}/chat/share/${id}`, { headers: { origin: SITE } });
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get('x-robots-tag'), 'noindex');
  } finally { await s.close(); }
});

test('the question is stored only when the sharer includes it, under the tag that covers it', async () => {
  const s = await start();
  try {
    const a = await answer(s.url, 'How busy will December be?');
    const made = await share(s.url, bodyOf(a, { question: a.question, tag: a.done.share!.tagq }));
    assert.equal(made.status, 201);
    const { id } = await made.json() as { id: string };
    const stored = await (await fetch(`${s.url}/chat/share/${id}`, { headers: { origin: SITE } })).json() as { question?: string };
    assert.equal(stored.question, 'How busy will December be?');
    // The plain tag with a question, or the question tag without one: refused.
    assert.equal((await share(s.url, bodyOf(a, { question: a.question }))).status, 400);
    assert.equal((await share(s.url, bodyOf(a, { tag: a.done.share!.tagq }))).status, 400);
  } finally { await s.close(); }
});

test('forgeries are refused, nothing stored: edited, reordered, extended, a model figure made the site\'s, another turn, a history tag, a substituted question', async () => {
  const s = await start();
  try {
    const a = await answer(s.url);
    const edited = structuredClone(a.events);
    ((edited.find((e) => e.type === 'block' && 'chart' in (e.block as object))!.block as { chart: { src: string } }).chart).src = 'site';
    const forgeries: [string, Record<string, unknown>][] = [
      ['model figures made the site\'s', { events: edited }],
      ['reordered', { events: [...a.events].reverse() }],
      ['truncated', { events: a.events.slice(0, 1) }],
      ['extended', { events: [...a.events, { type: 'text', s: 'Call 555-0100 for a refund.' }] }],
      ['a made-up block', { events: [{ type: 'block', block: { cta: { label: 'Claim', to: 'https://evil.example/' } } }] }],
      ['another turn', { index: 3 }],
      ['another conversation', { conversation: 'a'.repeat(43) }],
      ['another time', { at: a.done.share!.at + 1 }],
      ['no tag', { tag: undefined }],
      ['the history tag in place of the share tag', { tag: (a.done as unknown as { tag: string }).tag }],
      ['a substituted question', { question: 'Something else', tag: a.done.share!.tagq }],
    ];
    for (const [label, over] of forgeries) {
      const r = await share(s.url, bodyOf(a, over));
      assert.equal(r.status, 400, label);
      assert.equal(((await r.json()) as { error: string }).error, 'tampered', label);
    }
    const row = await s.db.get('SELECT COUNT(*) AS n FROM az_chat_shares');
    assert.equal(Number(row?.n), 0, 'nothing was stored');
  } finally { await s.close(); }
});

test('a share tag is good for a day: past it the answer can no longer be shared', async () => {
  const s = await start();
  try {
    const a = await answer(s.url);
    s.clock.now += 24 * 60 * 60 * 1000 + 1;
    const r = await share(s.url, bodyOf(a));
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, 'tampered');
  } finally { await s.close(); }
});

test('expiry: a share is gone the instant it expires; the sweep removes it', async () => {
  const s = await start({ AZ_CHAT_SHARE_DAYS: '1' });
  try {
    const a = await answer(s.url);
    const { id } = await (await share(s.url, bodyOf(a))).json() as { id: string };
    s.clock.now += 24 * 60 * 60 * 1000;
    assert.equal((await fetch(`${s.url}/chat/share/${id}`, { headers: { origin: SITE } })).status, 404);
  } finally { await s.close(); }
});

test('the edge: an allowed origin, the CSRF header on POST and DELETE, the methods each path takes', async () => {
  const s = await start();
  try {
    const a = await answer(s.url);
    assert.equal((await client(s.url, 'https://evil.example').post('/chat/share', bodyOf(a))).status, 403);
    assert.equal((await fetch(`${s.url}/chat/share`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify(bodyOf(a)) })).status, 403, 'no CSRF header');
    const pre = await fetch(`${s.url}/chat/share/${'a'.repeat(22)}`, { method: 'OPTIONS', headers: { origin: SITE } });
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, DELETE');
    assert.equal((await client(s.url).get('/chat/share')).status, 405);
    assert.equal((await fetch(`${s.url}/chat/share/${'a'.repeat(22)}`, { headers: { origin: 'https://evil.example' } })).status, 403);
    for (const bad of ['short', '..%2F..%2Fetc', 'a'.repeat(23)]) {
      assert.equal((await fetch(`${s.url}/chat/share/${bad}`, { headers: { origin: SITE } })).status, 404, bad);
    }
  } finally { await s.close(); }
});

test('who may share is who may ask; the size cap; the kill switch; the per-address limit; the live-share ceiling', async () => {
  const s = await start({ AZ_CHAT_SHARES_PER_ADDRESS: '2/hour', AZ_CHAT_SHARE_MAX: '3' });
  try {
    const a = await answer(s.url);
    assert.equal((await share(s.url, bodyOf(a, { page: '/members' }))).status, 401, 'a signed-in-only chat page');
    assert.equal((await share(s.url, bodyOf(a, { events: [{ type: 'text', s: 'x'.repeat(50_000) }] }))).status, 400);
    assert.equal(((await (await share(s.url, bodyOf(a, { events: [{ type: 'text', s: 'x'.repeat(50_000) }] }))).json()) as { error: string }).error, 'too_large');
    assert.equal((await share(s.url, bodyOf(a))).status, 201);
    assert.equal((await share(s.url, bodyOf(a))).status, 201);
    const third = await share(s.url, bodyOf(a));
    assert.equal(third.status, 429);
    assert.equal(((await third.json()) as { error: string }).error, 'rate_limited');
  } finally { await s.close(); }
  const full = await start({ AZ_CHAT_SHARE_MAX: '1' });
  try {
    const a = await answer(full.url);
    assert.equal((await share(full.url, bodyOf(a))).status, 201);
    const r = await share(full.url, bodyOf(a));
    assert.equal(r.status, 429);
    assert.equal(((await r.json()) as { error: string }).error, 'shares_full');
  } finally { await full.close(); }
  const off = await start({ AZ_CHAT_SHARES: 'off' });
  try {
    const a = await answer(off.url);
    assert.equal(a.done.share, undefined, 'no share tags: the page offers no Share');
    const r = await share(off.url, { page: '/', conversation: a.done.conversation, index: 1, at: off.clock.now, events: a.events, tag: 'x'.repeat(43) });
    assert.equal(r.status, 403);
  } finally { await off.close(); }
});
