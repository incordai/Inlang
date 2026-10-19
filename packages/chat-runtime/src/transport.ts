/**
 * @az module transport
 * Purpose: the chat API as an app's client speaks it — one request to a chat server (the user's own sidecar, or the operator's), its answer's events read and checked.
 * Spec: docs/chat-block-spec.md §4.2, §22.4
 * Exports: ChatTransport, TransportRequest, TransportEvent, TransportSource, HttpTransportOptions, httpTransport, REQUEST_ERRORS
 * Edit guide: a token rides in the Authorization header and nowhere else; no cookie is sent; every event is checked by the page's own
 *   reader (chat-render chat-logic.ts) — a server's text is never trusted to be well-formed.
 * Tests: packages/chat-runtime/test/transport.test.ts
 */

/**
 * Both of an app's modes speak the same chat API (epic #32): `POST
 * <base>/chat` with the page, the conversation and its tagged history, and
 * the answer as server-sent events — `text`, `hold`, `block`, `done`,
 * `error` — exactly what an az site's panel receives (chat-block-spec §4.2).
 * Only the base URL and the token change: the user's own sidecar on
 * 127.0.0.1 with its per-launch token (`local`), or the operator's server
 * with the account's token (`hosted`). A refusal before the stream is the
 * server's `{ error }` code (`limit_reached`, `budget_exhausted`, …), told as
 * an `error` event; a stream that breaks off is `unavailable`.
 *
 * Imports only the chat renderer's event reader and request rules (#chat-render).
 */

import { createEventReader, requestBody, type ChatTurn } from '#chat-render/chat-logic.ts';

/** Which server answers: the user's own (`local`, a sidecar) or the operator's (`hosted`). */
export type TransportSource = 'local' | 'hosted';

export interface TransportRequest {
  /** The chat's page, as the server's context names it. */
  readonly page: string;
  /** The server's own conversation id, once it has answered one; null for a new one. */
  readonly conversation: string | null;
  /** The exchanges this server answered, its tags with them. */
  readonly history: readonly ChatTurn[];
  readonly question: string;
  /** How the question was asked: a suggested question's button, "ask the AI instead", or typed (null). */
  readonly via: 'suggested' | 'model' | null;
  readonly signal: AbortSignal;
}

/** One event of an answer from a server, checked. */
export type TransportEvent =
  | { readonly type: 'text'; readonly s: string }
  | { readonly type: 'hold'; readonly word: string }
  | { readonly type: 'block'; readonly block: Record<string, unknown> }
  | { readonly type: 'done'; readonly tag: string; readonly left: number; readonly conversation: string; readonly text: string; readonly by: 'suggested' | 'match' | null }
  | { readonly type: 'error'; readonly code: string };

export interface ChatTransport {
  readonly source: TransportSource;
  /** One question: its answer's events, a `done` or an `error` last. Never throws: a failure is an `error` event. */
  send(request: TransportRequest): AsyncIterable<TransportEvent>;
}

export interface HttpTransportOptions {
  readonly source: TransportSource;
  /** The server's base URL: https, or http on the machine itself (a sidecar). */
  readonly base: string;
  /** The bearer token: the sidecar's per-launch token, or the account's. Never logged, never in a URL. */
  readonly token?: () => string | null;
  readonly fetch?: typeof fetch;
}

/** The codes a request can end with that are not the server's own: the network, or a stream that is not one. */
export const REQUEST_ERRORS = { unavailable: 'unavailable', unknown: 'unknown' } as const;

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?(?:\/|$)/;

/** A chat server over HTTP: one fetch per question, its stream read as the panel reads it. */
export function httpTransport(o: HttpTransportOptions): ChatTransport {
  const base = o.base.replace(/\/+$/, '');
  if (!base.startsWith('https://') && !LOOPBACK.test(base)) {
    throw new TypeError('httpTransport: the base is https, or http on this machine only');
  }
  const send = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    source: o.source,
    async *send(r) {
      const { body } = requestBody(r.page, r.conversation, r.history, r.question, r.via);
      const token = o.token?.() ?? null;
      let res: Response;
      try {
        res = await send(`${base}/chat`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json', 'x-az-request': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body,
          signal: r.signal,
        });
      } catch {
        yield { type: 'error', code: REQUEST_ERRORS.unavailable };
        return;
      }
      if (!res.ok) {
        let code: string = REQUEST_ERRORS.unknown;
        try {
          const j = await res.json() as { error?: unknown };
          if (typeof j?.error === 'string' && /^[a-z_]{1,40}$/.test(j.error)) code = j.error;
        } catch {
          await res.body?.cancel().catch(() => undefined);
        }
        yield { type: 'error', code };
        return;
      }
      if (!res.body || !/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) {
        await res.body?.cancel().catch(() => undefined);
        yield { type: 'error', code: REQUEST_ERRORS.unknown };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const events = createEventReader();
      let ended = false;
      try {
        while (!ended) {
          const { value, done } = await reader.read();
          const batch = done ? [...events.push(decoder.decode()), ...events.end()] : events.push(decoder.decode(value, { stream: true }));
          if (events.broken) break;
          for (const e of batch) {
            if (e.type === 'block') yield { type: 'block', block: e.raw };
            else if (e.type === 'done') { yield { type: 'done', tag: e.tag, left: e.left, conversation: e.conversation, text: e.text, by: e.by }; ended = true; break; }
            else if (e.type === 'error') { yield e; ended = true; break; }
            else yield e;
          }
          if (done) break;
        }
      } catch {
        if (!ended) { yield { type: 'error', code: REQUEST_ERRORS.unavailable }; ended = true; }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (!ended) yield { type: 'error', code: REQUEST_ERRORS.unavailable };
    },
  };
}
