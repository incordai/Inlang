/**
 * The Node model bridge (chat-block-spec §22.4) is the built-in server's own
 * completions adapter: one fetch to <url>/chat/completions, the key in its
 * header, the deltas and usage read by that adapter, and an answer through it
 * runs the whole runtime.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeModelBridge } from '../src/node-bridge.ts';
import { createChatRuntime } from '../src/runtime.ts';
import { memoryBudgetStore, utcDay } from '../src/budget.ts';

const NOW = Date.UTC(2026, 9, 19);
const deltas = (...parts: string[]) => [
  ...parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 9 } })}\n\n`,
  'data: [DONE]\n\n',
].join('');

test('an answer through the bridge: the adapter\'s request, the runtime\'s checked events, the provider\'s counts spent', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(deltas('We open ', 'at nine.\n<script>x</script>\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const store = memoryBudgetStore();
  const chat = createChatRuntime({
    model: nodeModelBridge({ url: 'https://models.example.test/v1/', key: 'model-key', model: 'model-a', fetch: f }),
    instructions: { appName: 'Studio' }, checker: { components: [] }, budget: { store }, now: () => NOW,
  });
  let text = '';
  let done = false;
  let blocks = 0;
  for await (const e of chat.ask('conversation-0001', 'When?')) {
    if (e.type === 'text') text += e.s;
    if (e.type === 'done') done = true;
    if (e.type === 'block') blocks += 1;
  }
  assert.ok(done);
  assert.match(text, /^We open at nine\.\n/);
  assert.equal(blocks, 0, 'the model\'s markup is prose, which the renderer draws as text; it is never a component');
  assert.equal(calls[0].url, 'https://models.example.test/v1/chat/completions');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer model-key');
  const body = JSON.parse(String(calls[0].init.body)) as { model: string; messages: { role: string }[]; max_tokens: number };
  assert.equal(body.model, 'model-a');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.max_tokens, 600);
  assert.equal(await store.spent(utcDay(NOW)), 129);
});

test('the bridge\'s url is https, or http on this machine; a model is named', () => {
  assert.throws(() => nodeModelBridge({ url: 'http://models.example.test', key: '', model: 'm' }), TypeError);
  assert.throws(() => nodeModelBridge({ url: 'https://models.example.test', key: '', model: ' ' }), TypeError);
  assert.doesNotThrow(() => nodeModelBridge({ url: 'http://127.0.0.1:11434/v1', key: '', model: 'm' }), 'CONTROL: a model on this machine');
});
