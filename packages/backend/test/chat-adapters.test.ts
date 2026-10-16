/**
 * The model adapters (chat-adapters.ts): `completions` against a local fake
 * HTTP server speaking the chat-completions streaming shape, and the
 * scripted `fake`. Deterministic — no model, no network beyond loopback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  AdapterError, createCompletionsAdapter, createFakeAdapter, parseFakeScript, RESPONSE_MAX, type ChatAdapter, type ChatChunk,
} from '../src/server/chat-adapters.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A local model server; `seen` holds each request's headers and parsed body; `closed` counts dropped connections. */
async function modelServer(handler: Handler) {
  const seen: { headers: IncomingMessage['headers']; body: Record<string, unknown>; path: string }[] = [];
  const state = { closed: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ headers: req.headers, body: JSON.parse(body || '{}'), path: req.url ?? '' });
    res.on('close', () => { if (!res.writableFinished) state.closed++; });
    handler(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { url, seen, state, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const ask = (adapter: ChatAdapter, signal = AbortSignal.timeout(10_000)) =>
  adapter.stream({ system: 'SYSTEM', turns: [{ role: 'user', text: 'Hi' }], maxOutputTokens: 600, signal });

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test('completions: posts the shape with the bearer key, streams deltas and usage until [DONE]', async () => {
  const m = await modelServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(delta('Hel'));
    res.write(`${delta('lo.')}data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  try {
    const chunks = await collect(ask(createCompletionsAdapter({ url: m.url, key: 'test-key', model: 'model-a' })));
    assert.deepEqual(chunks, [{ text: 'Hel' }, { text: 'lo.' }, { usage: { input: 120, output: 7 } }]);
    const r = m.seen[0];
    assert.equal(r.path, '/v1/chat/completions');
    assert.equal(r.headers.authorization, 'Bearer test-key');
    assert.deepEqual(r.body, {
      model: 'model-a', stream: true, max_tokens: 600, stream_options: { include_usage: true },
      messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'Hi' }],
    });
  } finally { await m.close(); }
});

test('completions §19.15: the input read from the provider\'s prompt cache is reported as part of the input; the request asks for no cache', async () => {
  const usage = (u: Record<string, unknown>) => (_q: unknown, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`${delta('x')}data: ${JSON.stringify({ choices: [], usage: u })}\n\ndata: [DONE]\n\n`);
  };
  const cases: [Record<string, unknown>, ChatChunk['usage']][] = [
    [{ prompt_tokens: 2100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1920 } }, { input: 2100, output: 40, cached: 1920 }],
    [{ prompt_tokens: 2100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } }, { input: 2100, output: 40, cached: 0 }],
    // A count past the input, or not a count, is no count of the cache; the input and output still stand.
    [{ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 101 } }, { input: 100, output: 4 }],
    [{ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: '90' } }, { input: 100, output: 4 }],
    [{ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: null }, { input: 100, output: 4 }],
    [{ prompt_tokens: 100, completion_tokens: 4 }, { input: 100, output: 4 }],
  ];
  for (const [u, want] of cases) {
    const m = await modelServer(usage(u));
    try {
      const chunks = await collect(ask(createCompletionsAdapter({ url: m.url, key: 'k', model: 'm' })));
      assert.deepEqual(chunks.at(-1), { usage: want }, JSON.stringify(u));
      // The common shape caches a long prefix by itself: nothing about a cache is sent.
      assert.deepEqual(Object.keys(m.seen[0].body as object).sort(), ['max_tokens', 'messages', 'model', 'stream', 'stream_options']);
    } finally { await m.close(); }
  }
});

test('completions: no key, no Authorization header (a local model server)', async () => {
  const m = await modelServer((_q, res) => { res.writeHead(200); res.end(`${delta('x')}data: [DONE]\n\n`); });
  try {
    await collect(ask(createCompletionsAdapter({ url: m.url, key: '', model: 'm' })));
    assert.equal(m.seen[0].headers.authorization, undefined);
  } finally { await m.close(); }
});

/** The AdapterError a stream ends with. */
async function failure(adapter: ChatAdapter): Promise<AdapterError> {
  try {
    await collect(ask(adapter));
  } catch (e) {
    assert.ok(e instanceof AdapterError, `expected AdapterError, got ${(e as Error).name}`);
    return e;
  }
  assert.fail('the stream did not fail');
}

test('completions: a 500 fails with its status only — the provider body is never in the error', async () => {
  const m = await modelServer((_q, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"secret-provider-detail"}'); });
  try {
    const e = await failure(createCompletionsAdapter({ url: m.url, key: 'k', model: 'm' }));
    assert.equal(e.message, 'status 500');
    assert.ok(!String(e.stack).includes('secret-provider-detail'));
  } finally { await m.close(); }
});

test('completions: a malformed line, a cut-off stream and an oversized one each fail', async () => {
  const cases: [string, Handler, string][] = [
    ['malformed', (_q, res) => { res.writeHead(200); res.end('data: {not json\n\n'); }, 'malformed'],
    ['cut off', (_q, res) => { res.writeHead(200); res.end(delta('half')); }, 'malformed'],
    ['huge line', (_q, res) => { res.writeHead(200); res.end(`data: ${'x'.repeat(70 * 1024)}\n\n`); }, 'too_large'],
    ['too much', (_q, res) => {
      res.writeHead(200);
      const block = delta('y'.repeat(1000)).repeat(64);
      for (let sent = 0; sent <= RESPONSE_MAX; sent += block.length) res.write(block);
      res.end('data: [DONE]\n\n');
    }, 'too_large'],
  ];
  for (const [name, handler, kind] of cases) {
    const m = await modelServer(handler);
    try {
      assert.equal((await failure(createCompletionsAdapter({ url: m.url, key: 'k', model: 'm' }))).kind, kind, name);
    } finally { await m.close(); }
  }
});

test('completions: an unreachable server is a network failure', async () => {
  const m = await modelServer(() => undefined);
  const url = m.url;
  await m.close();
  assert.equal((await failure(createCompletionsAdapter({ url, key: '', model: 'm' }))).kind, 'network');
});

test('completions: aborting mid-stream closes the upstream connection', async () => {
  const m = await modelServer((_q, res) => { res.writeHead(200); res.write(delta('first')); /* then nothing */ });
  try {
    const ac = new AbortController();
    const it = ask(createCompletionsAdapter({ url: m.url, key: '', model: 'm' }), ac.signal)[Symbol.asyncIterator]();
    assert.deepEqual((await it.next()).value, { text: 'first' });
    const pending = it.next();
    ac.abort();
    await assert.rejects(pending);
    const until = Date.now() + 5_000;
    while (m.state.closed === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(m.state.closed, 1, 'the model server saw the connection go');
  } finally { await m.close(); }
});

test('fake: a script is validated; the matching answer streams; abort is seen', async () => {
  for (const bad of ['nope', '{}', '{"answers":[]}', '{"answers":[{"chunks":[1]}]}', '{"answers":[{"chunks":[],"delayMs":5000}]}',
    '{"answers":[{"chunks":[],"fail":200}]}', '{"answers":[{"chunks":[],"usage":{"input":-1,"output":1}}]}']) {
    assert.equal(typeof parseFakeScript(bad), 'string', bad);
  }
  const script = parseFakeScript(JSON.stringify({ answers: [
    { when: 'PRICE', chunks: ['Plans ', 'start at 9.'], usage: { input: 10, output: 4 } },
    { when: 'broken', chunks: [], fail: 503 },
    { when: 'wait', chunks: [], stall: true },
    { chunks: ['Default.'] },
  ] }));
  assert.ok(typeof script !== 'string');
  const fake = createFakeAdapter(script);
  const turns = (text: string) => [{ role: 'user' as const, text }];
  const run = (text: string, signal = AbortSignal.timeout(5_000)) => collect(fake.stream({ system: '', turns: turns(text), maxOutputTokens: 600, signal }));
  assert.deepEqual(await run('What is the price?'), [{ text: 'Plans ' }, { text: 'start at 9.' }, { usage: { input: 10, output: 4 } }]);
  assert.deepEqual(await run('hello'), [{ text: 'Default.' }]);
  await assert.rejects(run('this is broken'), (e: AdapterError) => e.status === 503);
  const ac = new AbortController();
  const stalled = run('please wait', ac.signal);
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(stalled);
  assert.equal(fake.aborted(), 1);
  assert.equal(fake.calls(), 4);
});

test('fake: an answer with `system` is chosen only when the system text holds it — so a test sees what the model was given', async () => {
  assert.equal(typeof parseFakeScript('{"answers":[{"chunks":[],"system":""}]}'), 'string', 'an empty system is refused');
  const script = parseFakeScript(JSON.stringify({ answers: [
    { when: 'warranty', system: 'private-mark', chunks: ['LEAKED'] },
    { when: 'warranty', system: 'Lifetime warranty', chunks: ['Grounded.'] },
    { when: 'warranty', chunks: ['Not grounded.'] },
  ] }));
  assert.ok(typeof script !== 'string');
  const fake = createFakeAdapter(script);
  const run = (system: string) => collect(fake.stream({ system, turns: [{ role: 'user', text: 'The warranty?' }], maxOutputTokens: 600, signal: AbortSignal.timeout(5_000) }));
  assert.deepEqual(await run('<site-rows table="guides">\n{"body":"Lifetime warranty on every lamp."}\n</site-rows>'), [{ text: 'Grounded.' }]);
  assert.deepEqual(await run('nothing about it'), [{ text: 'Not grounded.' }]);
  assert.deepEqual(await run('Lifetime warranty, private-mark'), [{ text: 'LEAKED' }], 'CONTROL: the probe does fire when the text is there');
});
