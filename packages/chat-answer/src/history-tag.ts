/**
 * @az module history-tag
 * Purpose: the history tag's one definition — what an answer's tag covers and how its key is derived — and a Web Crypto implementation for a browser, an app webview or Node.
 * Spec: docs/chat-block-spec.md §4.2, §19.16, §22.1
 * Exports: HISTORY_KEY_LABEL, tagMessage, HistoryTags, webCryptoTags, base64url, fromBase64url
 * Edit guide: the message and the label are the tag's wire format — a change invalidates every saved conversation; verify in constant time.
 * Tests: packages/chat-answer/test/history-tag.test.ts, packages/backend/test/chat-text.test.ts
 */

/**
 * A page keeps the conversation and sends it back each turn, so a visitor
 * could forge an earlier answer. Whoever answered tags each one: HMAC-SHA-256
 * over the conversation id, the answer's position and its exact history
 * text, under a key one HMAC step from the operator's secret — so a tag is
 * never a digest of the secret itself. An answer sent back without its tag
 * is refused.
 *
 * The built-in server tags with node:crypto (chat-text.ts) over exactly
 * this message and label; an app that answers in its own webview, or a
 * sidecar, uses webCryptoTags. Both give the same tag for the same secret,
 * which the tests hold them to, so a conversation moves between them.
 */

/** What the history key is derived with from the operator's secret. */
export const HISTORY_KEY_LABEL = 'az-chat-history-v1';

/** The exact text a tag covers: the conversation id, the answer's position, its history text — one field a line; only the last can hold a newline. */
export const tagMessage = (conversation: string, index: number, text: string): string => `${conversation}\n${index}\n${text}`;

/** Tags answers and checks the tags of answers sent back. */
export interface HistoryTags {
  tag(conversation: string, index: number, text: string): Promise<string>;
  /** Whether `tag` is this answer's tag; anything that is not a tag is false, never an error. */
  check(conversation: string, index: number, text: string, tag: unknown): Promise<boolean>;
}

/** Bytes as unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url as bytes, or null when it is not that. */
export function fromBase64url(s: string): Uint8Array | null {
  if (!B64URL.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

/** A SHA-256 HMAC is 32 bytes: a tag of another length is no tag. */
const TAG_BYTES = 32;

/**
 * History tags through Web Crypto (`crypto.subtle`), from the operator's
 * secret bytes. The secret never leaves this function's key objects, which
 * are not extractable.
 */
export async function webCryptoTags(secret: Uint8Array<ArrayBuffer>, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<HistoryTags> {
  const hmac = { name: 'HMAC', hash: 'SHA-256' } as const;
  const root = await subtle.importKey('raw', secret, hmac, false, ['sign']);
  const derived = new Uint8Array(await subtle.sign('HMAC', root, utf8(HISTORY_KEY_LABEL)));
  const key = await subtle.importKey('raw', derived, hmac, false, ['sign', 'verify']);
  derived.fill(0);
  return {
    async tag(conversation, index, text) {
      return base64url(new Uint8Array(await subtle.sign('HMAC', key, utf8(tagMessage(conversation, index, text)))));
    },
    async check(conversation, index, text, tag) {
      if (typeof tag !== 'string') return false;
      const bytes = fromBase64url(tag);
      if (bytes === null || bytes.length !== TAG_BYTES) return false;
      // verify compares in constant time.
      return subtle.verify('HMAC', key, new Uint8Array(bytes), utf8(tagMessage(conversation, index, text)));
    },
  };
}
