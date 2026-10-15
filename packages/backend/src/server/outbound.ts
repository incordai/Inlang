/**
 * @az server outbound
 * Purpose: reading what another server answered, bounded: a body's chunks under a byte cap, cancelled the moment it is passed.
 * Spec: docs/backend-spec.md §6, §7 (and the chat block spec §4.3)
 * Exports: cappedChunks, readCapped, BodyTooLarge
 * Edit guide: every byte read counts; past the cap the reader is cancelled (the connection drops) before the error; no message quotes the body.
 * Tests: packages/backend/test/outbound.test.ts, packages/backend/test/security.test.ts, packages/backend/test/chat-adapters.test.ts
 */

/**
 * The backend calls out — a provider's discovery and tokens (oidc.ts), a
 * chat model's stream (chat-adapters.ts) — and an answer is input like any
 * other: one that never stops must not fill memory. Both read through
 * here: chunk by chunk, counting, and past the cap the read is cancelled,
 * which drops the connection, so the rest is never received.
 *
 * Copied into every generated server; imports nothing.
 */

/** A body passed its cap; the read was cancelled. Its message is fixed text, never the body's. */
export class BodyTooLarge extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`answered more than ${limit} bytes`);
    this.name = 'BodyTooLarge';
    this.limit = limit;
  }
}

/**
 * Each chunk of `body` while the bytes read stay within `limit`. Past it the
 * reader is cancelled and BodyTooLarge thrown; a consumer that stops early
 * (break, return, a throw) cancels the reader too.
 */
export const cappedChunks = async function* (body: ReadableStream<Uint8Array>, limit: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let size = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > limit) throw new BodyTooLarge(limit);
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

/** The whole body as text, read until `limit` bytes; decoded as response.json() does (UTF-8, a leading byte-order mark dropped). */
export async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  for await (const chunk of cappedChunks(response.body, limit)) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}
