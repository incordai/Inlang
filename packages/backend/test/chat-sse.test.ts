/**
 * The chat's server-sent-event reader and writer (chat-sse.ts): the same
 * events whatever the chunking, a bounded line, linear work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseReader, sseEvent, SseLimitError, type SseEvent } from '../src/server/chat-sse.ts';

const enc = new TextEncoder();

/** Every event of `bytes` read in two chunks split at `at`. */
function readSplit(bytes: Uint8Array, at: number): SseEvent[] {
  const r = createSseReader();
  return [...r.push(bytes.subarray(0, at)), ...r.push(bytes.subarray(at)), ...r.end()];
}

const STREAM = 'event: text\r\ndata: {"s":"héllo — 你好 🙂"}\r\n\r\n: a comment\n'
  + 'data: line one\ndata: line two\n\n'
  + 'data:no-space\n\r'
  + 'event: done\ndata: {"tag":"x"}\n\n'
  + 'data: [DONE]\n\n';

const EXPECTED: SseEvent[] = [
  { event: 'text', data: '{"s":"héllo — 你好 🙂"}' },
  { event: 'message', data: 'line one\nline two' },
  { event: 'message', data: 'no-space' },
  { event: 'done', data: '{"tag":"x"}' },
  { event: 'message', data: '[DONE]' },
];

test('a stream gives the same events split at every byte offset, inside UTF-8 sequences and \\r\\n included', () => {
  const bytes = enc.encode(STREAM);
  for (let at = 0; at <= bytes.length; at++) assert.deepEqual(readSplit(bytes, at), EXPECTED, `split at ${at}`);
});

test('a stream read one byte at a time gives the same events', () => {
  const r = createSseReader();
  const out: SseEvent[] = [];
  for (const b of enc.encode(STREAM)) out.push(...r.push(Uint8Array.of(b)));
  out.push(...r.end());
  assert.deepEqual(out, EXPECTED);
});

test('a last event without its blank line is flushed at the end', () => {
  const r = createSseReader();
  assert.deepEqual([...r.push(enc.encode('data: tail')), ...r.end()], [{ event: 'message', data: 'tail' }]);
});

test('a line past the cap throws, before it is decoded; CONTROL: one at the cap passes', () => {
  const r = createSseReader(16);
  assert.throws(() => r.push(enc.encode(`data: ${'x'.repeat(11)}`)), SseLimitError);
  const ok = createSseReader(16);
  assert.deepEqual([...ok.push(enc.encode(`data: ${'x'.repeat(10)}\n\n`)), ...ok.end()], [{ event: 'message', data: 'x'.repeat(10) }]);
  // Split across pushes, a long line is still counted whole.
  const split = createSseReader(16);
  split.push(enc.encode('data: xxxxx'));
  assert.throws(() => split.push(enc.encode('xxxxxx')), SseLimitError);
  // …also when it began in a push where an earlier line ended: that line's end does not reset the count of the one after it.
  const after = createSseReader(16);
  after.push(enc.encode('event: x\ndata: xxxxx'));
  assert.throws(() => after.push(enc.encode('xxxxxx')), SseLimitError);
});

test('work is linear: a 4 MB stream of short events is read in bounded time', () => {
  const chunk = enc.encode('data: {"choices":[{"delta":{"content":"ab"}}]}\n\n'.repeat(1000));
  const r = createSseReader();
  const start = performance.now();
  let n = 0;
  for (let i = 0; i < 80; i++) n += r.push(chunk).length;
  assert.equal(n, 80_000);
  assert.ok(performance.now() - start < 3_000, `took ${Math.round(performance.now() - start)} ms`);
});

test('the writer frames one event as one JSON data line; a newline in text stays escaped', () => {
  assert.equal(sseEvent('text', { s: 'a\n\nb' }), 'event: text\ndata: {"s":"a\\n\\nb"}\n\n');
  const r = createSseReader();
  assert.deepEqual(r.push(enc.encode(sseEvent('done', { tag: 't', left: 3 }))), [{ event: 'done', data: '{"tag":"t","left":3}' }]);
});
