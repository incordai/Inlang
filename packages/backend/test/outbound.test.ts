/**
 * Reading another server's answer, bounded (outbound.ts): the cap counts
 * every byte, the reader is cancelled past it and when a consumer stops.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyTooLarge, cappedChunks, readCapped } from '../src/server/outbound.ts';

/** A body of `n` chunks of `size` bytes that records whether it was cancelled and how much was pulled. */
function body(n: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= n) { c.close(); return; }
      state.pulled++;
      c.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

test('under the cap the whole body is read and decoded, a byte-order mark dropped', async () => {
  assert.equal(await readCapped(new Response('﻿hello'), 64), 'hello');
  assert.equal(await readCapped(new Response(null), 64), '');
  const exact = body(4, 16);
  assert.equal((await readCapped(new Response(exact.stream), 64)).length, 64, 'exactly at the cap passes');
});

test('past the cap the read stops and is cancelled — the rest is never pulled', async () => {
  const b = body(1000, 1024);
  await assert.rejects(readCapped(new Response(b.stream), 4 * 1024), (e: unknown) => e instanceof BodyTooLarge && e.message === 'answered more than 4096 bytes');
  assert.ok(b.state.cancelled);
  assert.ok(b.state.pulled <= 6, `pulled ${b.state.pulled} of 1000 chunks`);
});

test('a consumer that stops early cancels the reader', async () => {
  const b = body(100, 10);
  for await (const chunk of cappedChunks(b.stream, 1_000_000)) {
    assert.equal(chunk.byteLength, 10);
    break;
  }
  assert.ok(b.state.cancelled);
  assert.ok(b.state.pulled <= 2);
});
