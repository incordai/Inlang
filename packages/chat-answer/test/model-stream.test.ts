/**
 * The streaming contract (chat-block-spec §6.5, §22.4): the first chunk in
 * time, each next in time, either timer stopping the model; a stream that
 * was stopped ends in StoppedError, never as a finished answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHARS_PER_TOKEN, estimateTokens, MODEL_TIMING, StoppedError, timedChunks, type ModelChunk } from '../src/model-stream.ts';
import { CHAT_FIRST_TOKEN_MS, CHAT_IDLE_MS, CHAT_TIMING } from '../../backend/src/server/chat.ts';

const FAST = { firstMs: 40, betweenMs: 40 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chunks after the given delays; it stops when its signal is aborted, as an adapter does. */
function delayed(steps: readonly [number, ModelChunk][]) {
  return async function* (signal: AbortSignal): AsyncGenerator<ModelChunk> {
    for (const [ms, chunk] of steps) {
      await wait(ms);
      if (signal.aborted) return;
      yield chunk;
    }
  };
}

async function read(it: AsyncIterable<string>): Promise<{ text: string; error: unknown }> {
  let text = '';
  try {
    for await (const t of it) text += t;
  } catch (e) {
    return { text, error: e };
  }
  return { text, error: null };
}

test('the server\'s timers are the contract\'s', () => {
  assert.deepEqual(CHAT_TIMING, MODEL_TIMING);
  assert.equal(CHAT_FIRST_TOKEN_MS, 15_000);
  assert.equal(CHAT_IDLE_MS, 20_000);
  assert.equal(estimateTokens(7), Math.ceil(7 / CHARS_PER_TOKEN));
});

test('a stream in time is read whole, its usage reported, and nothing is aborted (CONTROL)', async () => {
  const controller = new AbortController();
  let usage: unknown = null;
  const r = await read(timedChunks(delayed([[5, { text: 'a' }], [5, { text: 'b' }], [5, { usage: { input: 3, output: 1 } }]]), { timing: FAST, controller, onUsage: (u) => { usage = u; } }));
  assert.deepEqual(r, { text: 'ab', error: null });
  assert.deepEqual(usage, { input: 3, output: 1 });
  await wait(FAST.firstMs + 20);
  assert.equal(controller.signal.aborted, false, 'the timers are cleared once it ends');
});

test('no first token in time: the model is stopped and the stream ends in StoppedError', async () => {
  const controller = new AbortController();
  const r = await read(timedChunks(delayed([[FAST.firstMs * 3, { text: 'late' }]]), { timing: FAST, controller }));
  assert.ok(r.error instanceof StoppedError);
  assert.equal(r.text, '');
  assert.equal(controller.signal.aborted, true);
});

test('a gap past the idle time after the first chunk stops it too', async () => {
  const controller = new AbortController();
  const r = await read(timedChunks(delayed([[5, { text: 'a' }], [FAST.betweenMs * 3, { text: 'b' }]]), { timing: FAST, controller }));
  assert.ok(r.error instanceof StoppedError);
  assert.equal(r.text, 'a');
});

test('the caller\'s stop is a StoppedError as well, never a finished answer', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const r = await read(timedChunks(delayed([[2, { text: 'a' }], [30, { text: 'b' }]]), { timing: { firstMs: 5_000, betweenMs: 5_000 }, controller }));
  assert.ok(r.error instanceof StoppedError);
});
