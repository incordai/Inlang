/**
 * @az server chat-moderation
 * Purpose: the optional input-moderation hook — each question judged by an HTTP endpoint of the operator's before the model sees it; it fails closed.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §6.8, Q7)
 * Exports: createModeration, Moderation, ModerationVerdict, MODERATION_TIMEOUT_MS, MODERATION_REPLY_MAX
 * Edit guide: fetch only, no SDK, no vendor names; the reply is read through outbound.ts readCapped; anything but an exact { "allow": true } is not an allow; a failure's log form is its kind and HTTP status only — never the text, never the key.
 * Tests: packages/backend/test/chat-moderation.test.ts, packages/backend/test/chat-route.test.ts
 */

/**
 * The hook is generic by construction, like `email api` (backend-spec §7):
 * the server POSTs `{ "text": "…" }` as JSON to AZ_CHAT_MODERATION_URL —
 * with `Authorization: Bearer <AZ_CHAT_MODERATION_KEY>` when a key is set —
 * and expects `{ "allow": true }` or `{ "allow": false }` within
 * MODERATION_TIMEOUT_MS. Any classifier, or a small relay in front of one,
 * that speaks that shape works.
 *
 * It **fails closed**: a network error, a non-2xx status, a redirect, no
 * answer in time, a reply past MODERATION_REPLY_MAX bytes, or a reply that
 * is not exactly that shape, is `failed` — and the route refuses the
 * question as it would an unavailable model. Only `{ "allow": true }` lets a
 * question through.
 *
 * Nothing about the visitor is sent: no cookie, address, account or user
 * agent — only the text the model would be given.
 *
 * Copied into a generated server with a chat; imports only its siblings and node built-ins.
 */

import { BodyTooLarge, readCapped } from './outbound.ts';

/** chat-block-spec §6.8: the endpoint answers within this, or the question is refused. */
export const MODERATION_TIMEOUT_MS = 3_000;
/** A verdict is a few bytes; a reply past this is not one. */
export const MODERATION_REPLY_MAX = 4 * 1024;

/**
 * What the hook decided: `allow`, `block`, or `failed` with why — a fixed
 * kind and at most an HTTP status, safe to log.
 */
export type ModerationVerdict =
  | { readonly verdict: 'allow' }
  | { readonly verdict: 'block' }
  | { readonly verdict: 'failed'; readonly why: string };

export interface Moderation {
  /** Judge `text`; `signal` aborts when the visitor leaves. Never throws. */
  check(text: string, signal: AbortSignal): Promise<ModerationVerdict>;
}

type Fetch = typeof fetch;

/** The hook for AZ_CHAT_MODERATION_URL and its key. `timeoutMs` is MODERATION_TIMEOUT_MS outside tests. */
export function createModeration(
  config: { readonly url: string; readonly key: string },
  options: { readonly fetch?: Fetch; readonly timeoutMs?: number } = {},
): Moderation {
  const fetchImpl: Fetch = options.fetch ?? ((...a) => fetch(...a));
  const timeoutMs = options.timeoutMs ?? MODERATION_TIMEOUT_MS;
  return {
    async check(text, signal) {
      // One bound for the whole exchange: the request, the status and the reply's last byte.
      const deadline = AbortSignal.timeout(timeoutMs);
      const both = AbortSignal.any([deadline, signal]);
      const late = () => (deadline.aborted ? 'timeout' : 'aborted');
      let response: Response;
      try {
        response = await fetchImpl(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
          },
          body: JSON.stringify({ text }),
          signal: both,
          redirect: 'error',
        });
      } catch {
        return { verdict: 'failed', why: both.aborted ? late() : 'network' };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { verdict: 'failed', why: `status ${response.status}` };
      }
      let body: string;
      try {
        body = await readCapped(response, MODERATION_REPLY_MAX);
      } catch (e) {
        if (e instanceof BodyTooLarge) return { verdict: 'failed', why: 'too_large' };
        return { verdict: 'failed', why: both.aborted ? late() : 'network' };
      }
      let reply: unknown;
      try {
        reply = JSON.parse(body);
      } catch {
        return { verdict: 'failed', why: 'malformed' };
      }
      const allow = reply !== null && typeof reply === 'object' && !Array.isArray(reply) ? (reply as { allow?: unknown }).allow : undefined;
      if (allow === true) return { verdict: 'allow' };
      if (allow === false) return { verdict: 'block' };
      return { verdict: 'failed', why: 'malformed' };
    },
  };
}
