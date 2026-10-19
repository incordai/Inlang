/**
 * The chat API as an app's client speaks it (chat-block-spec §4.2, §22.4): a
 * token only in the Authorization header, no cookie, the server's stream read
 * by the page's own reader, a refusal told by its code, a broken stream
 * `unavailable`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpTransport, type TransportEvent } from '../src/transport.ts';

const sse = (...events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const DONE = { tag: 'a'.repeat(43), left: 3, conversation: 'c'.repeat(22), text: 'Hello.' };

function fake(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { f, calls };
}
const stream = (body: string, type = 'text/event-stream') => new Response(body, { status: 200, headers: { 'content-type': type } });

async function ask(f: typeof fetch, base = 'https://chat.example.test/') {
  const t = httpTransport({ source: 'hosted', base, token: () => 'secret-token', fetch: f });
  const out: TransportEvent[] = [];
  for await (const e of t.send({ page: '/', conversation: null, history: [], question: 'Hi?', via: null, signal: new AbortController().signal })) out.push(e);
  return out;
}

test('a question is one POST to <base>/chat: the token in the header only, no cookie, its stream read', async () => {
  const { f, calls } = fake(() => stream(sse(['text', { s: 'Hello.\n' }], ['done', DONE])));
  const events = await ask(f);
  assert.deepEqual(events, [{ type: 'text', s: 'Hello.\n' }, { type: 'done', ...DONE, by: null }]);
  assert.equal(calls[0].url, 'https://chat.example.test/chat');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer secret-token');
  assert.doesNotMatch(calls[0].url + String(calls[0].init.body), /secret-token/, 'never in the URL or the body');
  assert.equal(JSON.parse(String(calls[0].init.body)).page, '/');
});

test('a refusal is its code; a body that is no code, a stream that is not one, or one that breaks off are not trusted', async () => {
  assert.deepEqual(await ask(fake(() => Response.json({ error: 'limit_reached' }, { status: 429 })).f), [{ type: 'error', code: 'limit_reached' }]);
  assert.deepEqual(await ask(fake(() => Response.json({ error: '<img src=x>' }, { status: 500 })).f), [{ type: 'error', code: 'unknown' }]);
  assert.deepEqual(await ask(fake(() => stream(sse(['done', DONE]), 'text/html')).f), [{ type: 'error', code: 'unknown' }]);
  assert.deepEqual(await ask(fake(() => stream(sse(['text', { s: 'Half' }]))).f), [{ type: 'text', s: 'Half' }, { type: 'error', code: 'unavailable' }]);
  assert.deepEqual(await ask((async () => { throw new TypeError('offline'); }) as typeof fetch), [{ type: 'error', code: 'unavailable' }]);
});

test('the base is https, or http on this machine only (a sidecar)', () => {
  assert.throws(() => httpTransport({ source: 'hosted', base: 'http://chat.example.test' }), TypeError);
  assert.throws(() => httpTransport({ source: 'local', base: 'http://127.0.0.1.example.test' }), TypeError);
  assert.throws(() => httpTransport({ source: 'local', base: 'javascript:alert(1)' }), TypeError);
  for (const base of ['http://127.0.0.1:4170', 'http://[::1]:4170/', 'http://localhost:4170', 'https://chat.example.test']) {
    assert.doesNotThrow(() => httpTransport({ source: 'local', base }), base);
  }
});
