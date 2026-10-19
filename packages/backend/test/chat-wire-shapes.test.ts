/**
 * The wire shapes beyond `completions` (chat-adapters.ts, chat-block-spec
 * §19.19): `messages`, `contents` and `local`, each against a local stub
 * server speaking its format as its publisher documents it (§18 R6, R12,
 * R13) — streaming, usage and cached counts, the cache marker, error
 * statuses, errors inside a stream, malformed, cut-off and oversized
 * streams, an unreachable server, abort, and the route's and the probe's
 * timeouts over each. No real provider is called: loopback only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  AdapterError, createAdapter, createContentsAdapter, createLocalAdapter, createMessagesAdapter, RESPONSE_MAX,
  type ChatAdapter, type ChatChunk, type ModelChoice,
} from '../src/server/chat-adapters.ts';
import { parseChatContext, systemParts, systemText } from '../src/server/chat.ts';
import { PROBE_QUESTIONS, probeChat } from '../src/server/chat-probe.ts';
import { copyServer } from './helpers.ts';

const KEY = `wire-key-${randomBytes(8).toString('hex')}`;
const CLI = fileURLToPath(new URL('../../cli/bin/az.js', import.meta.url));
const RUN_MS = 60_000;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A local model server; `seen` holds each request; `closed` counts connections dropped before the answer ended. */
async function stub(handler: Handler) {
  const seen: { headers: IncomingMessage['headers']; body: Record<string, unknown>; path: string }[] = [];
  const state = { closed: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ headers: req.headers, body: JSON.parse(body || '{}'), path: req.url ?? '' });
    res.on('close', () => { if (!res.writableFinished) state.closed++; });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { url, seen, state, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const ask = (adapter: ChatAdapter, o: { signal?: AbortSignal; system?: string; fixed?: number } = {}) => adapter.stream({
  system: o.system ?? 'SYSTEM', ...(o.fixed !== undefined ? { fixed: o.fixed } : {}),
  turns: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }, { role: 'user', text: 'Plans?' }],
  maxOutputTokens: 600, signal: o.signal ?? AbortSignal.timeout(10_000),
});

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

async function failure(it: AsyncIterable<ChatChunk>): Promise<AdapterError> {
  try {
    await collect(it);
  } catch (e) {
    assert.ok(e instanceof AdapterError, `expected AdapterError, got ${(e as Error).name}`);
    return e;
  }
  assert.fail('the stream did not fail');
}

// ——— the three shapes' frames, as their references show them ———

const event = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
const MSG = {
  start: (usage: Record<string, unknown> = { input_tokens: 25, output_tokens: 1 }) => event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: null, usage } }),
  blockStart: event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ping: event('ping', {}),
  text: (text: string) => event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  blockStop: event('content_block_stop', { index: 0 }),
  delta: (usage: Record<string, unknown> = { output_tokens: 15 }) => event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
  stop: event('message_stop', {}),
};
const candidate = (text: string, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }], ...extra })}\n\n`;
const finished = (text: string, usage: Record<string, unknown>) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage })}\n\n`;
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const piece = (content: string) => line({ model: 'm', message: { role: 'assistant', content }, done: false });
const last = (content = '') => line({ model: 'm', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 26, eval_count: 298 });

/** Each shape: its adapter, a stream of `Hel`, `lo.` with usage, and the frames each failure case needs. */
const SHAPES = {
  messages: {
    make: (c: ModelChoice) => createMessagesAdapter(c),
    good: [MSG.start(), MSG.blockStart, MSG.ping, MSG.text('Hel'), MSG.text('lo.'), MSG.blockStop, MSG.delta(), MSG.stop].join(''),
    usage: { input: 25, output: 15 },
    open: MSG.start() + MSG.blockStart + MSG.text('first'),
    cut: MSG.start() + MSG.text('half'),
    inStream: MSG.start() + MSG.text('a') + 'event: error\ndata: {"type": "error", "error": {"type": "overloaded_error", "message": "secret-provider-detail"}}\n\n',
    malformed: 'event: content_block_delta\ndata: {not json\n\n',
    filler: (n: number) => MSG.text('y'.repeat(n)),
    hugeLine: `event: content_block_delta\ndata: ${'x'.repeat(70 * 1024)}\n\n`,
    path: '/v1/messages',
  },
  contents: {
    make: (c: ModelChoice) => createContentsAdapter(c),
    good: candidate('Hel') + finished('lo.', { promptTokenCount: 25, candidatesTokenCount: 15, totalTokenCount: 40 }),
    usage: { input: 25, output: 15 },
    open: candidate('first'),
    cut: candidate('half'),
    inStream: candidate('a') + `data: ${JSON.stringify({ error: { code: 503, message: 'secret-provider-detail', status: 'UNAVAILABLE' } })}\n\n`,
    malformed: 'data: {not json\n\n',
    filler: (n: number) => candidate('y'.repeat(n)),
    hugeLine: `data: ${'x'.repeat(70 * 1024)}\n\n`,
    path: '/v1/models/model-a:streamGenerateContent?alt=sse',
  },
  local: {
    make: (c: ModelChoice) => createLocalAdapter(c),
    good: piece('Hel') + piece('lo.') + last(),
    usage: { input: 26, output: 298 },
    open: piece('first'),
    cut: piece('half'),
    inStream: piece('a') + line({ error: 'secret-provider-detail' }),
    malformed: '{not json\n',
    filler: (n: number) => piece('y'.repeat(n)),
    hugeLine: `${'x'.repeat(70 * 1024)}\n`,
    path: '/v1/api/chat',
  },
} as const;

const choice = (url: string, more: Partial<ModelChoice> = {}): ModelChoice => ({ url, key: KEY, model: 'model-a', ...more });

for (const [name, s] of Object.entries(SHAPES)) {
  test(`${name}: streams each piece of text as it arrives, then the usage, and stops at the shape's end`, async () => {
    const m = await stub((_q, res) => {
      res.writeHead(200);
      // Split anywhere, inside a frame: the reader keeps what is not whole yet.
      const half = Math.floor(s.good.length / 2);
      res.write(s.good.slice(0, half));
      res.end(s.good.slice(half));
    });
    try {
      assert.deepEqual(await collect(ask(s.make(choice(m.url, name === 'contents' ? { keyHeader: 'x-model-key' } : {})))), [{ text: 'Hel' }, { text: 'lo.' }, { usage: s.usage }]);
      assert.equal(m.seen[0].path, s.path);
    } finally { await m.close(); }
  });

  test(`${name}: a 4xx or 5xx fails with its status only — the provider's body is never in the error`, async () => {
    for (const status of [400, 401, 429, 500, 529]) {
      const m = await stub((_q, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"secret-provider-detail"}'); });
      try {
        const e = await failure(ask(s.make(choice(m.url))));
        assert.equal(e.message, `status ${status}`);
        assert.ok(!String(e.stack).includes('secret-provider-detail'));
      } finally { await m.close(); }
    }
  });

  test(`${name}: an error inside the stream, a malformed frame, a cut-off stream, an oversized line and too much in all each fail by kind`, async () => {
    const cases: [string, Handler, AdapterError['kind']][] = [
      ['in stream', (_q, res) => { res.writeHead(200); res.end(s.inStream); }, 'upstream'],
      ['malformed', (_q, res) => { res.writeHead(200); res.end(s.malformed); }, 'malformed'],
      ['cut off', (_q, res) => { res.writeHead(200); res.end(s.cut); }, 'malformed'],
      ['empty body', (_q, res) => { res.writeHead(200); res.end(); }, 'malformed'],
      ['huge line', (_q, res) => { res.writeHead(200); res.end(s.hugeLine); }, 'too_large'],
      ['too much', (_q, res) => {
        res.writeHead(200);
        const block = s.filler(1000).repeat(64);
        for (let sent = 0; sent <= RESPONSE_MAX; sent += block.length) res.write(block);
        res.end();
      }, 'too_large'],
    ];
    for (const [label, handler, kind] of cases) {
      const m = await stub(handler);
      try {
        const e = await failure(ask(s.make(choice(m.url))));
        assert.equal(e.kind, kind, label);
        assert.ok(!String(e.stack).includes('secret-provider-detail'), label);
      } finally { await m.close(); }
    }
  });

  test(`${name}: an unreachable server is a network failure`, async () => {
    const m = await stub(() => undefined);
    const url = m.url;
    await m.close();
    assert.equal((await failure(ask(s.make(choice(url))))).kind, 'network');
  });

  test(`${name}: aborting mid-stream closes the upstream connection`, async () => {
    const m = await stub((_q, res) => { res.writeHead(200); res.write(s.open); });
    try {
      const ac = new AbortController();
      const it = ask(s.make(choice(m.url)), { signal: ac.signal })[Symbol.asyncIterator]();
      assert.deepEqual((await it.next()).value, { text: 'first' });
      const pending = it.next();
      ac.abort();
      await assert.rejects(pending);
      const until = Date.now() + 5_000;
      while (m.state.closed === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      assert.equal(m.state.closed, 1, 'the model server saw the connection go');
    } finally { await m.close(); }
  });

  test(`${name}: the route's first-token and between-chunk bounds hold — a stream that stalls, or only keeps itself alive, times out (probe)`, async () => {
    const prompts = { 'prompt-1.txt': '# GENERATED BY AZ — test\nYou answer about Shop.\n' };
    const ctx = parseChatContext(JSON.stringify({
      site: { name: 'Shop' }, pages: [{ route: '/', blocks: [] }], routes: ['/'],
      chats: { '/': { allow: 'anyone', limit: 20, prompt: 'prompt-1.txt', show: [] } }, answer: { quotes: [], destinations: ['/'] },
    }));
    if (typeof ctx === 'string') throw new Error(ctx);
    const keepalive = name === 'messages' ? MSG.ping : name === 'contents' ? ': keep-alive\n\n' : '\n';
    const handlers: [string, Handler][] = [
      ['silent', (_q, res) => { res.writeHead(200); }],
      ['first piece, then nothing', (_q, res) => { res.writeHead(200); res.write(s.open); }],
      ['keep-alive only', (_q, res) => {
        res.writeHead(200);
        const t = setInterval(() => res.write(keepalive), 50);
        res.on('close', () => clearInterval(t));
      }],
    ];
    for (const [label, handler] of handlers) {
      const m = await stub(handler);
      try {
        const started = Date.now();
        const r = await probeChat({ adapter: s.make(choice(m.url)), prompts, context: ctx, maxOutputTokens: 600, timeoutMs: 10_000, timing: { firstMs: 300, betweenMs: 300 } });
        assert.equal(r.answers[0].outcome, 'timeout', label);
        assert.ok(Date.now() - started < 8_000, `${label}: ${Date.now() - started}ms`);
        const until = Date.now() + 5_000;
        while (m.state.closed === 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 20));
        assert.equal(m.state.closed, 1, `${label}: the stream was stopped upstream`);
      } finally { await m.close(); }
    }
  });
}

// ——— each shape's request and its own rules ———

test('messages: the request — path, x-api-key, the operator\'s headers, the turns — and the system text\'s fixed prefix carries the cache marker', async () => {
  const m = await stub((_q, res) => { res.writeHead(200); res.end(SHAPES.messages.good); });
  try {
    const system = 'FIXED PREFIX\nROWS FOR THIS QUESTION';
    await collect(ask(createMessagesAdapter(choice(m.url, { headers: [['x-version', '2024-01-01']] })), { system, fixed: 'FIXED PREFIX\n'.length }));
    const r = m.seen[0];
    assert.equal(r.path, '/v1/messages');
    assert.equal(r.headers['x-api-key'], KEY);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers['x-version'], '2024-01-01');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.deepEqual(r.body, {
      model: 'model-a', max_tokens: 600, stream: true,
      system: [
        { type: 'text', text: 'FIXED PREFIX\n', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'ROWS FOR THIS QUESTION' },
      ],
      messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }, { role: 'user', content: 'Plans?' }],
    });
    // Without a fixed length the whole text is the prefix; an empty system text sends none.
    await collect(ask(createMessagesAdapter(choice(m.url)), { system: 'ALL FIXED' }));
    assert.deepEqual(m.seen[1].body.system, [{ type: 'text', text: 'ALL FIXED', cache_control: { type: 'ephemeral' } }]);
    await collect(ask(createMessagesAdapter(choice(m.url, { key: '' })), { system: '' }));
    assert.equal('system' in m.seen[2].body, false);
    assert.equal(m.seen[2].headers['x-api-key'], undefined, 'no key, no key header');
    // The operator's own key header, when set.
    await collect(ask(createMessagesAdapter(choice(m.url, { keyHeader: 'x-model-key' }))));
    assert.equal(m.seen[3].headers['x-model-key'], KEY);
    assert.equal(m.seen[3].headers['x-api-key'], undefined);
  } finally { await m.close(); }
});

test('messages §19.16: the input is what came after the marker plus what was read from and written to the cache; cached is the part read; the last counts stand', async () => {
  const cases: [string, ChatChunk['usage'] | undefined][] = [
    [MSG.start({ input_tokens: 50, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 1 }) + MSG.text('x') + MSG.delta({ output_tokens: 15 }) + MSG.stop,
      { input: 100_050, output: 15, cached: 100_000 }],
    [MSG.start({ input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_900, output_tokens: 1 }) + MSG.text('x') + MSG.delta({ output_tokens: 9 }) + MSG.stop,
      { input: 1_940, output: 9, cached: 0 }],
    // message_delta's counts are cumulative and may carry the input too: the latest of each stands.
    [MSG.start({ input_tokens: 10, output_tokens: 1 }) + MSG.text('x') + MSG.delta({ output_tokens: 5 }) + MSG.delta({ input_tokens: 12, cache_read_input_tokens: 600, output_tokens: 20 }) + MSG.stop,
      { input: 612, output: 20, cached: 600 }],
    // No cache fields: no cached count. Counts that are not counts are none.
    [MSG.start() + MSG.text('x') + MSG.delta() + MSG.stop, { input: 25, output: 15 }],
    [MSG.start({ input_tokens: 25, output_tokens: 1 }) + MSG.text('x') + MSG.delta({ output_tokens: -1 }) + MSG.stop, { input: 25, output: 1 }],
    [MSG.start({ input_tokens: '25', output_tokens: 1 }) + MSG.text('x') + MSG.delta() + MSG.stop, undefined],
    [MSG.start({}) + MSG.text('x') + event('message_delta', { delta: {} }) + MSG.stop, undefined],
  ];
  for (const [i, [stream, want]] of cases.entries()) {
    const m = await stub((_q, res) => { res.writeHead(200); res.end(stream); });
    try {
      const chunks = await collect(ask(createMessagesAdapter(choice(m.url))));
      assert.deepEqual(chunks.find((c) => c.usage)?.usage, want, `case ${i}`);
      assert.deepEqual(chunks.filter((c) => c.text).map((c) => c.text), ['x']);
    } finally { await m.close(); }
  }
});

test('messages: thinking and other non-text deltas are not answer text; events a later version adds are skipped', async () => {
  const stream = MSG.start() + event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } })
    + event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } })
    + event('some_future_event', { anything: 1 }) + MSG.text('Answer.') + MSG.delta() + MSG.stop;
  const m = await stub((_q, res) => { res.writeHead(200); res.end(stream); });
  try {
    assert.deepEqual(await collect(ask(createMessagesAdapter(choice(m.url)))), [{ text: 'Answer.' }, { usage: { input: 25, output: 15 } }]);
  } finally { await m.close(); }
});

test('contents: the request — the model in the path, the operator\'s key header, system instruction, user and model turns, the output cap', async () => {
  const m = await stub((_q, res) => { res.writeHead(200); res.end(SHAPES.contents.good); });
  try {
    await collect(ask(createContentsAdapter(choice(m.url, { model: 'model-a.1_x', keyHeader: 'x-model-key', headers: [['x-tier', 'gold']] }))));
    const r = m.seen[0];
    assert.equal(r.path, '/v1/models/model-a.1_x:streamGenerateContent?alt=sse');
    assert.equal(r.headers['x-model-key'], KEY);
    assert.equal(r.headers.authorization, undefined, 'contents has no usual key header');
    assert.equal(r.headers['x-tier'], 'gold');
    assert.deepEqual(r.body, {
      systemInstruction: { parts: [{ text: 'SYSTEM' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }, { role: 'model', parts: [{ text: 'Hello.' }] }, { role: 'user', parts: [{ text: 'Plans?' }] }],
      generationConfig: { maxOutputTokens: 600 },
    });
    // Without a key header the key is sent nowhere: contents has no usual one (env.ts refuses that combination).
    await collect(ask(createContentsAdapter(choice(m.url))));
    assert.ok(!JSON.stringify(m.seen[1].headers).includes(KEY));
  } finally { await m.close(); }
});

test('contents: cached and thinking counts, the last usage standing; a thought part is not answer text; a refused prompt ends with no text', async () => {
  const cases: [string, ChatChunk[]][] = [
    [candidate('a', { usageMetadata: { promptTokenCount: 2_100, candidatesTokenCount: 1 } })
      + finished('b', { promptTokenCount: 2_100, candidatesTokenCount: 30, thoughtsTokenCount: 12, cachedContentTokenCount: 1_900, totalTokenCount: 2_142 }),
    [{ text: 'a' }, { text: 'b' }, { usage: { input: 2_100, output: 42, cached: 1_900 } }]],
    // A cached count past the prompt is no count.
    [finished('b', { promptTokenCount: 100, candidatesTokenCount: 3, cachedContentTokenCount: 101 }), [{ text: 'b' }, { usage: { input: 100, output: 3 } }]],
    [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'shown' }] }, finishReason: 'STOP' }] })}\n\n`, [{ text: 'shown' }]],
    [`data: ${JSON.stringify({ promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 8 } })}\n\n`, [{ usage: { input: 8, output: 0 } }]],
    // MAX_TOKENS is an end like any other.
    [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] })}\n\n`, [{ text: 'cut' }]],
  ];
  for (const [i, [stream, want]] of cases.entries()) {
    const m = await stub((_q, res) => { res.writeHead(200); res.end(stream); });
    try {
      assert.deepEqual(await collect(ask(createContentsAdapter(choice(m.url, { keyHeader: 'x-model-key' })))), want, `case ${i}`);
    } finally { await m.close(); }
  }
});

test('local: the request — path, bearer key when set, system then turns, the output cap — and a line split across reads', async () => {
  const m = await stub((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const text = SHAPES.local.good;
    // Byte by byte for the first line: a line is whole only at its newline.
    const first = text.indexOf('\n') + 1;
    for (const ch of text.slice(0, first)) res.write(ch);
    res.end(text.slice(first));
  });
  try {
    assert.deepEqual(await collect(ask(createLocalAdapter(choice(m.url)))), [{ text: 'Hel' }, { text: 'lo.' }, { usage: { input: 26, output: 298 } }]);
    const r = m.seen[0];
    assert.equal(r.path, '/v1/api/chat');
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(r.body, {
      model: 'model-a', stream: true, options: { num_predict: 600 },
      messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }, { role: 'user', content: 'Plans?' }],
    });
    await collect(ask(createLocalAdapter(choice(m.url, { key: '' }))));
    assert.equal(m.seen[1].headers.authorization, undefined, 'a local model server without a key gets no Authorization header');
  } finally { await m.close(); }
});

test('local: the last line may carry text; CRLF and blank lines are line ends; no counts, no usage', async () => {
  const stream = `${piece('a').replace('\n', '\r\n')}\n\n${line({ message: { content: 'b' }, done: true })}`;
  const m = await stub((_q, res) => { res.writeHead(200); res.end(stream); });
  try {
    assert.deepEqual(await collect(ask(createLocalAdapter(choice(m.url)))), [{ text: 'a' }, { text: 'b' }]);
  } finally { await m.close(); }
  // The last object without its newline still ends the answer.
  const n = await stub((_q, res) => { res.writeHead(200); res.end(piece('a') + last('z').trimEnd()); });
  try {
    assert.deepEqual(await collect(ask(createLocalAdapter(choice(n.url)))), [{ text: 'a' }, { text: 'z' }, { usage: { input: 26, output: 298 } }]);
  } finally { await n.close(); }
});

test('createAdapter: AZ_CHAT_API picks the shape, so each is asked at its own path', async () => {
  const m = await stub((req, res) => {
    res.writeHead(200);
    const url = req.url ?? '';
    res.end(url.endsWith('/messages') ? SHAPES.messages.good : url.includes(':streamGenerateContent') ? SHAPES.contents.good : url.endsWith('/api/chat') ? SHAPES.local.good
      : `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello.' } }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    for (const api of ['completions', 'messages', 'contents', 'local'] as const) {
      const adapter = await createAdapter({ api, url: m.url, key: KEY, model: 'model-a', keyHeader: api === 'contents' ? 'x-model-key' : '', headers: [], fakeFile: '' });
      const text = (await collect(ask(adapter))).map((c) => c.text ?? '').join('');
      assert.ok(text === 'Hello.', `${api}: ${text}`);
    }
    assert.deepEqual(m.seen.map((r) => r.path), ['/v1/chat/completions', '/v1/messages', '/v1/models/model-a:streamGenerateContent?alt=sse', '/v1/api/chat']);
  } finally { await m.close(); }
});

// ——— the system text's fixed prefix ———

test('§19.19 systemParts: the fixed length is where the per-question parts begin — the same prefix for every question, rows or not, pages chosen or not', () => {
  const prompt = '# GENERATED BY AZ — test\nYou answer about Shop.\n';
  const small = parseChatContext(JSON.stringify({
    site: { name: 'Shop' }, pages: [{ route: '/', blocks: [] }], routes: ['/'],
    chats: { '/': { allow: 'anyone', limit: 20, prompt: 'prompt-1.txt', show: [] } }, answer: { quotes: [], destinations: ['/'] },
  }));
  if (typeof small === 'string') throw new Error(small);
  const none = systemParts(prompt, small, '/');
  assert.equal(none.text, systemText(prompt, small, '/'));
  assert.equal(none.fixed, none.text.length, 'no rows and no chosen pages: all of it is fixed');
  const rows = systemParts(prompt, small, '/', '{"plan":"Team"}');
  assert.equal(rows.text.slice(0, rows.fixed), none.text);
  assert.match(rows.text.slice(rows.fixed), /^\nRows from the site's own tables/);
  // A large site's chosen pages are per question too: the prefix before them is the same for two different questions.
  const a = systemParts(prompt, small, '/', '', [], false, ['shipping'], true);
  const b = systemParts(prompt, small, '/', 'x', [], false, ['returns'], true);
  assert.equal(a.text.slice(0, a.fixed), b.text.slice(0, b.fixed));
});

test('§19.19 the probe asks a messages model with the production system text, its whole fixed prefix under the cache marker (the route: chat-knows.test.ts)', async () => {
  const prompts = { 'prompt-1.txt': '# GENERATED BY AZ — test\nYou answer about Shop.\n' };
  const ctx = parseChatContext(JSON.stringify({
    site: { name: 'Shop' }, pages: [{ route: '/', blocks: [] }], routes: ['/'],
    chats: { '/': { allow: 'anyone', limit: 20, prompt: 'prompt-1.txt', show: [] } }, answer: { quotes: [], destinations: ['/'] },
  }));
  if (typeof ctx === 'string') throw new Error(ctx);
  const m = await stub((_q, res) => { res.writeHead(200); res.end(SHAPES.messages.good); });
  try {
    const r = await probeChat({ adapter: createMessagesAdapter(choice(m.url)), prompts, context: ctx, maxOutputTokens: 600, timeoutMs: 10_000 });
    assert.equal(r.answers[0].outcome, 'ok');
    const system = m.seen[0].body.system as { text: string; cache_control?: unknown }[];
    assert.equal(system.length, 1);
    assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
    assert.equal(system[0].text, systemText(prompts['prompt-1.txt'], ctx, '/'));
    assert.equal((m.seen[0].body.messages as { content: string }[])[0].content, PROBE_QUESTIONS.prose);
  } finally { await m.close(); }
});

// ——— az backend probe, from a server folder, for a shape other than completions ———

test('az backend probe <server-dir> asks in the shape AZ_CHAT_API names, with the operator\'s headers — and never prints the key or a header value', async () => {
  const HEADER_VALUE = `hv-${randomBytes(6).toString('hex')}`;
  const m = await stub((_q, res) => { res.writeHead(200); res.end(SHAPES.messages.good); });
  const dir = mkdtempSync(join(tmpdir(), 'az-chat-wire-probe-'));
  try {
    copyServer(dir, true);
    writeFileSync(join(dir, 'az.config.json'), JSON.stringify({ siteName: 'Shop', database: 'sqlite', email: 'api', chat: true }));
    mkdirSync(join(dir, 'chat'));
    writeFileSync(join(dir, 'chat/prompt-1.txt'), '# GENERATED BY AZ — test\nAnswer about Shop.\n');
    writeFileSync(join(dir, 'chat/context.json'), JSON.stringify({
      site: { name: 'Shop' }, pages: [{ route: '/', blocks: [] }], routes: ['/'],
      chats: { '/': { allow: 'anyone', limit: 20, prompt: 'prompt-1.txt', show: [] } }, answer: { quotes: [], destinations: ['/'] },
    }));
    writeFileSync(join(dir, '.env'), [
      `AZ_SESSION_SECRET=${randomBytes(32).toString('base64url')}`, 'AZ_BACKEND_PUBLIC_URL=http://127.0.0.1:9', 'AZ_ALLOWED_ORIGINS=http://localhost:5173',
      `AZ_SQLITE_PATH=${join(dir, 'data/app.db')}`, 'AZ_EMAIL_FROM=Shop <no-reply@shop.test>', 'AZ_EMAIL_API_URL=https://mail.invalid/send', 'AZ_EMAIL_API_KEY=<PLACEHOLDER>',
      'AZ_CHAT_API=messages', `AZ_CHAT_URL=${m.url}`, `AZ_CHAT_KEY=${KEY}`, 'AZ_CHAT_MODEL=candidate-model', `AZ_CHAT_HEADERS=x-version=${HEADER_VALUE}`, '',
    ].join('\n'));
    const out = await new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [CLI, 'backend', 'probe', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
      let text = '';
      child.stdout.on('data', (c) => { text += c; });
      child.stderr.on('data', (c) => { text += c; });
      const timer = setTimeout(() => child.kill('SIGKILL'), RUN_MS);
      child.once('exit', (code) => { clearTimeout(timer); done({ code, out: text }); });
    });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^probe: messages model "candidate-model" at http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(out.out, /^PASS prose/m);
    assert.equal(m.seen[0].path, '/v1/messages');
    assert.equal(m.seen[0].headers['x-api-key'], KEY);
    assert.equal(m.seen[0].headers['x-version'], HEADER_VALUE);
    assert.ok(!out.out.includes(KEY) && !out.out.includes(HEADER_VALUE), 'neither the key nor a header value is printed');
  } finally {
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
