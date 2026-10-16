/**
 * The input-moderation hook (chat-moderation.ts, chat-block-spec §6.8, Q7)
 * against a local HTTP server speaking its shape: allow, block, and every
 * way it fails closed — a timeout, an oversized reply, a non-2xx, a
 * malformed reply, a redirect, a connection refused — and what is sent:
 * the text and the bearer key, nothing else. Then the route (chat.ts): a
 * blocked question is `400 blocked` and an unanswered hook `503 unavailable`,
 * the model never asked; the log holds neither the words nor the key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createModeration, MODERATION_REPLY_MAX, MODERATION_TIMEOUT_MS } from '../src/server/chat-moderation.ts';
import { createApp } from '../src/server/app.ts';
import { createFakeAdapter, parseFakeScript } from '../src/server/chat-adapters.ts';
import { createUsage, migrateChat, utcDay } from '../src/server/chat-usage.ts';
import { createChat, parseChatContext } from '../src/server/chat.ts';
import { migrate, openSqlite } from '../src/server/db.ts';
import { loadConfig } from '../src/server/env.ts';
import { createOidc } from '../src/server/oidc.ts';
import { createStore } from '../src/server/store.ts';
import { client, listen, SECRET, SITE } from './helpers.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A local moderation endpoint; `seen` holds each request's headers, body and path. */
async function judge(handler: Handler) {
  const seen: { headers: IncomingMessage['headers']; body: string; path: string; method: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ headers: req.headers, body, path: req.url ?? '', method: req.method ?? '' });
    handler(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/check`;
  return { url, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const reply = (body: string, status = 200) => (_q: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

/** By the words: "block" in them is blocked, anything else allowed. */
const byWords: Handler = (_q, res, body) => {
  const { text } = JSON.parse(body) as { text: string };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ allow: !text.includes('block') }));
};

const never = new AbortController().signal;

test('allow and block: { "allow": true } lets the text through, { "allow": false } blocks it', async () => {
  const j = await judge(byWords);
  try {
    const m = createModeration({ url: j.url, key: '' });
    assert.deepEqual(await m.check('Which plan fits five people?', never), { verdict: 'allow' });
    assert.deepEqual(await m.check('please block this', never), { verdict: 'block' });
  } finally { await j.close(); }
});

test('what is sent: POST of { text } as JSON, the key as a bearer token, no cookie and no other field', async () => {
  const j = await judge(reply('{"allow":true}'));
  try {
    await createModeration({ url: j.url, key: 'judge-key-123' }).check('Hello there', never);
    const r = j.seen[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/check');
    assert.deepEqual(JSON.parse(r.body), { text: 'Hello there' });
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.headers.authorization, 'Bearer judge-key-123');
    assert.equal(r.headers.cookie, undefined);
    // CONTROL: no key, no Authorization header.
    await createModeration({ url: j.url, key: '' }).check('Hi', never);
    assert.equal(j.seen[1].headers.authorization, undefined);
  } finally { await j.close(); }
});

test('TIMEOUT: an endpoint that never answers fails closed at the timeout, bounded', async () => {
  const j = await judge(() => { /* never answers */ });
  try {
    const started = Date.now();
    const v = await createModeration({ url: j.url, key: '' }, { timeoutMs: 300 }).check('anything', never);
    assert.deepEqual(v, { verdict: 'failed', why: 'timeout' });
    assert.ok(Date.now() - started < 2_000, 'ended at the timeout');
    assert.equal(MODERATION_TIMEOUT_MS, 3_000, '§6.8: 3 s in production');
  } finally { await j.close(); }
});

test('TIMEOUT: a reply that starts and then stalls fails closed too — the bound covers the body', async () => {
  const j = await judge((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"allow":'); });
  try {
    assert.deepEqual(await createModeration({ url: j.url, key: '' }, { timeoutMs: 300 }).check('x', never), { verdict: 'failed', why: 'timeout' });
  } finally { await j.close(); }
});

test('an oversized reply fails closed, read no further than its cap', async () => {
  const j = await judge(reply(`{"allow":true,"pad":"${'x'.repeat(MODERATION_REPLY_MAX)}"}`));
  try {
    assert.deepEqual(await createModeration({ url: j.url, key: '' }).check('x', never), { verdict: 'failed', why: 'too_large' });
  } finally { await j.close(); }
});

test('every other answer fails closed: a non-2xx, a malformed reply, a truthy non-true, a redirect, no server', async () => {
  const cases: [Handler, string][] = [
    [reply('{"allow":true}', 500), 'status 500'],
    [reply('{"allow":true}', 403), 'status 403'],
    [reply('not json'), 'malformed'],
    [reply('{"allow":"true"}'), 'malformed'],
    [reply('{"allow":1}'), 'malformed'],
    [reply('[true]'), 'malformed'],
    [reply('{}'), 'malformed'],
    [reply('null'), 'malformed'],
    [(_q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }); res.end(); }, 'network'],
  ];
  for (const [handler, why] of cases) {
    const j = await judge(handler);
    try {
      assert.deepEqual(await createModeration({ url: j.url, key: '' }).check('x', never), { verdict: 'failed', why }, why);
    } finally { await j.close(); }
  }
  // A port nobody listens on.
  const gone = await judge(reply('{}'));
  await gone.close();
  assert.deepEqual(await createModeration({ url: gone.url, key: '' }).check('x', never), { verdict: 'failed', why: 'network' });
});

test('the visitor leaving aborts the check at once', async () => {
  const j = await judge(() => { /* never answers */ });
  try {
    const left = new AbortController();
    const started = Date.now();
    const pending = createModeration({ url: j.url, key: '' }, { timeoutMs: 10_000 }).check('x', left.signal);
    setTimeout(() => left.abort(), 50);
    assert.deepEqual(await pending, { verdict: 'failed', why: 'aborted' });
    assert.ok(Date.now() - started < 2_000);
  } finally { await j.close(); }
});

/* ---- the route ----------------------------------------------------------- */

const MARKER = `words-${randomBytes(6).toString('hex')}`;
const KEY = `judge-key-${randomBytes(6).toString('hex')}`;

async function startChat(moderationUrl: string) {
  const loaded = loadConfig({
    AZ_SESSION_SECRET: SECRET, AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9', AZ_ALLOWED_ORIGINS: SITE,
    AZ_EMAIL_FROM: 'Studio <no-reply@studio.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: '2525',
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: '/unused-in-process.json',
    AZ_CHAT_MODERATION_URL: moderationUrl, AZ_CHAT_MODERATION_KEY: KEY,
  }, { database: 'sqlite', email: 'smtp', chat: true }, 'Studio');
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  const { config } = loaded;
  const db = await openSqlite(':memory:');
  await migrate(db);
  await migrateChat(db);
  const log: string[] = [];
  const script = parseFakeScript(JSON.stringify({ answers: [{ chunks: ['Hello ', 'there.'] }] }));
  if (typeof script === 'string') throw new Error(script);
  const fake = createFakeAdapter(script);
  const context = parseChatContext(JSON.stringify({ site: { name: 'Studio' }, pages: [], chats: { '/': { allow: 'anyone', limit: 5, prompt: 'prompt-1.txt' } } }));
  if (typeof context === 'string') throw new Error(context);
  const chat = createChat({ config: config.chat!, secret: config.secret, db, prompts: { 'prompt-1.txt': 'You answer about Studio.\n' }, context, adapter: fake, log: (l) => log.push(l) });
  const app = createApp({ config, store: createStore(db, config.secret), mailer: { send: async () => {} }, oidc: createOidc(fetch), log: (l) => log.push(l), chat });
  const server = createServer((q, r) => { void app.handler(q, r); });
  const url = await listen(server);
  return { url, log, fake, db, close: async () => { server.closeAllConnections(); server.close(); await db.close(); } };
}

const say = (text: string) => ({ role: 'visitor', text });

test('route: a blocked question is 400 blocked; the model is never asked; the log says blocked, never the words or the key', async () => {
  const j = await judge(byWords);
  const s = await startChat(j.url);
  try {
    const r = await client(s.url).post('/chat', { page: '/', messages: [say(`please block ${MARKER}`)] });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'blocked' });
    assert.equal(s.fake.calls(), 0, 'the model was not asked');
    assert.deepEqual(JSON.parse(j.seen[0].body), { text: `please block ${MARKER}` });
    assert.ok(s.log.includes('chat: blocked by moderation'), s.log.join(' | '));
    // The block is counted in today's row: one blocked question, no message, no tokens.
    const today = utcDay(Date.now());
    assert.deepEqual(await createUsage(s.db).row(today), { input: 0, cached: 0, output: 0, messages: 0, dropped: 0, blocked: 1 });
    // CONTROL: an allowed question streams from the model, and is counted as a message, not a block.
    const ok = await client(s.url).post('/chat', { page: '/', messages: [say('Which plan?')] });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /event: done/);
    assert.equal(s.fake.calls(), 1);
    let row = await createUsage(s.db).row(today);
    // The answer's count is written just after its stream ends: wait for it, bounded.
    for (const until = Date.now() + 2_000; row?.messages !== 1 && Date.now() < until;) {
      await new Promise((res) => setTimeout(res, 20));
      row = await createUsage(s.db).row(today);
    }
    assert.equal(row?.messages, 1);
    assert.equal(row?.blocked, 1);
    const all = s.log.join('\n');
    assert.ok(!all.includes(MARKER) && !all.includes(KEY), all);
  } finally { await s.close(); await j.close(); }
});

test('route: a hook that is down or answers badly refuses the question as unavailable (fails closed), the model never asked', async () => {
  for (const handler of [reply('{"allow":true}', 503), reply('oops')]) {
    const j = await judge(handler);
    const s = await startChat(j.url);
    try {
      const r = await client(s.url).post('/chat', { page: '/', messages: [say('Which plan?')] });
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: 'unavailable' });
      assert.equal(s.fake.calls(), 0);
      assert.ok(s.log.some((l) => /^chat: moderation failed: (status 503|malformed) — the question was refused$/.test(l)), s.log.join(' | '));
    } finally { await s.close(); await j.close(); }
  }
});

test('route: every visitor turn the model would be given is judged, not only the latest — an untagged earlier turn included', async () => {
  const j = await judge(byWords);
  const s = await startChat(j.url);
  try {
    // A first answer, so the history is real.
    const first = await client(s.url).post('/chat', { page: '/', messages: [say('Hello?')] });
    const done = /event: done\ndata: (.*)\n/.exec(await first.text())![1];
    const { tag, conversation, text } = JSON.parse(done) as { tag: string; conversation: string; text: string };
    // The earlier visitor turn carries no tag: it is the visitor's to rewrite, so it is judged with the latest.
    const r = await client(s.url).post('/chat', {
      page: '/', conversation,
      messages: [say('please block it'), { role: 'site', text, tag }, say('And yearly?')],
    });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'blocked' });
    assert.deepEqual(JSON.parse(j.seen.at(-1)!.body), { text: 'please block it\n\nAnd yearly?' });
    assert.equal(s.fake.calls(), 1, 'only the first, allowed question reached the model');
  } finally { await s.close(); await j.close(); }
});
