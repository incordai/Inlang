/**
 * A chat window's headless state (chat-block-spec §22.5): each answer
 * streams into a new snapshot, one question at a time; a stop or a failure
 * ends the answer as failed; the operator's server is asked only after it
 * was offered; a kept conversation is drawn again from its stored events.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatSession, type SessionSnapshot } from '../src/session.ts';
import { createChatRuntime, type RuntimeEvent } from '../src/runtime.ts';
import type { ModelBridge } from '#chat-answer/model-stream.ts';
import type { ChatTransport } from '../src/transport.ts';

const ID = 'conversation-0001';
const BASE = { instructions: { appName: 'Studio', components: ['cta'] as const }, checker: { components: ['cta'] as const, destinations: ['/order'] } };
const model = (text: string): ModelBridge => ({ async *stream() { yield { text }; } });

test('an answer streams into new snapshots, then the session is free again', async () => {
  const chat = createChatRuntime({ ...BASE, model: model('We ship in two days.\n\ncta "Order" /order\n') });
  const s = createChatSession(chat, ID);
  const seen: SessionSnapshot[] = [];
  const off = s.subscribe(() => seen.push(s.getSnapshot()));
  assert.equal(await s.ask('  How fast?  '), true);
  off();
  const end = s.getSnapshot();
  assert.equal(end.busy, false);
  assert.equal(end.left, 19);
  assert.deepEqual(end.turns[0], { role: 'visitor', text: 'How fast?' });
  const answer = end.turns[1];
  assert.equal(answer.role, 'site');
  if (answer.role !== 'site') return;
  assert.equal(answer.ended, 'done');
  assert.equal(answer.source, 'direct');
  assert.deepEqual(answer.events.map((e) => e.type), ['text', 'block', 'done']);
  assert.ok(seen[0].busy && seen.length >= 3, 'busy first, then each event');
  assert.ok(new Set(seen).size === seen.length && seen.every((x, i) => i === 0 || x.turns !== seen[i - 1].turns || x.busy !== seen[i - 1].busy), 'every change a new snapshot');
});

test('one question at a time; an empty one is not asked (CONTROL: after the first, the next is)', async () => {
  let release!: () => void;
  const slow: ModelBridge = { async *stream() { await new Promise<void>((r) => { release = r; }); yield { text: 'Done.\n' }; } };
  const s = createChatSession(createChatRuntime({ ...BASE, model: slow }), ID);
  const first = s.ask('One?');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await s.ask('Two?'), false, 'refused while one is coming');
  release();
  assert.equal(await first, true);
  assert.equal(await s.ask('   '), false);
  assert.equal(s.getSnapshot().turns.length, 2);
});

test('a stop ends the answer as failed, never left coming', async () => {
  const stall: ModelBridge = { async *stream(req) { await new Promise<void>((r) => req.signal.addEventListener('abort', () => r(), { once: true })); } };
  const s = createChatSession(createChatRuntime({ ...BASE, model: stall }), ID);
  const asked = s.ask('Hello?');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.getSnapshot().busy, true);
  s.stop();
  await asked;
  const a = s.getSnapshot().turns[1];
  assert.deepEqual(a.role === 'site' ? a.ended : null, { error: 'stopped' });
  assert.equal(s.getSnapshot().busy, false);
});

test('an asker that throws or ends without done fails the answer as unavailable', async () => {
  for (const ask of [
    async function* (): AsyncGenerator<RuntimeEvent> { yield { type: 'text', s: 'Half' }; throw new Error('gone'); },
    async function* (): AsyncGenerator<RuntimeEvent> { yield { type: 'text', s: 'Half' }; },
  ]) {
    const s = createChatSession({ ask, load: async () => null }, ID);
    await s.ask('x');
    const a = s.getSnapshot().turns[1];
    assert.deepEqual(a.role === 'site' ? [a.ended, a.events.at(-1)] : null, [{ error: 'unavailable' }, { type: 'error', code: 'unavailable' }]);
  }
});

test('the operator\'s server is asked only after it was offered; then the same question goes to it', async () => {
  const sent: string[] = [];
  const hosted: ChatTransport = {
    source: 'hosted',
    async *send(r) { sent.push(r.question); yield { type: 'text', s: 'Hosted.\n' }; yield { type: 'done', tag: 't', left: 4, conversation: 'hosted-conv-0001', text: 'Hosted.', by: null }; },
  };
  const local: ChatTransport = { source: 'local', async *send() { yield { type: 'error', code: 'unavailable' }; } };
  const s = createChatSession(createChatRuntime({ transport: { local, hosted, prefer: 'local' } }), ID);
  assert.equal(await s.askHosted(), false, 'nothing offered yet');
  await s.ask('Prices?');
  assert.equal(s.getSnapshot().hostedOffered, true);
  assert.deepEqual(sent, []);
  assert.equal(await s.askHosted(), true);
  assert.deepEqual(sent, ['Prices?']);
  const a = s.getSnapshot().turns.at(-1)!;
  assert.equal(a.role === 'site' ? a.source : null, 'hosted');
  assert.equal(s.getSnapshot().hostedOffered, false);
});

test('a kept conversation is drawn again from its stored events', async () => {
  const chat = createChatRuntime({ ...BASE, model: model('Kept.\n') });
  await createChatSession(chat, ID).ask('Remember?');
  const again = createChatSession(chat, ID);
  await again.load();
  const turns = again.getSnapshot().turns;
  assert.deepEqual(turns[0], { role: 'visitor', text: 'Remember?' });
  assert.deepEqual(turns[1].role === 'site' ? turns[1].events : null, [{ type: 'text', s: 'Kept.\n' }, { type: 'done' }]);
});
