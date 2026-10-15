/**
 * @az server chat-adapters
 * Purpose: the model behind the chat, as thin adapters named by wire shape: `completions` over fetch, and `fake` from a scripted file.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §4.3)
 * Exports: ChatAdapter, ChatChunk, ChatStreamRequest, AdapterError, createCompletionsAdapter, createFakeAdapter, parseFakeScript, createAdapter, FakeScript, RESPONSE_MAX
 * Edit guide: no vendor names, no SDK; the body is read through outbound.ts cappedChunks against RESPONSE_MAX; an error's log form is its class and HTTP status only.
 * Tests: packages/backend/test/chat-adapters.test.ts
 */

/**
 * Provider adapters (chat-block-spec §4.3). One interface, and each adapter a
 * thin proxy that only moves text: the endpoint, key and model id come from
 * the server's .env, never from code, and no provider is named here.
 *
 * `completions` speaks the common chat-completions streaming shape: a POST
 * of `{ model, messages, stream, max_tokens }` answered by `data:` lines of
 * JSON deltas ending with `data: [DONE]`. Hosted APIs and local model
 * servers speak it. `fake` replays scripted answers for tests and local
 * development; the server refuses it outside a loopback deployment (env.ts).
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { readFile } from 'node:fs/promises';
import type { ChatConfig } from './env.ts';
import { createSseReader, SseLimitError } from './chat-sse.ts';
import { BodyTooLarge, cappedChunks } from './outbound.ts';

/** The most bytes read from one answer's response — far past a 2 000-token stream's framing. */
export const RESPONSE_MAX = 2 * 1024 * 1024;
/** The scripted-answers file's largest size. */
const FAKE_FILE_MAX = 1024 * 1024;
/** A scripted pause between chunks, at most. */
const FAKE_DELAY_MAX = 2_000;

export interface ChatChunk {
  readonly text?: string;
  readonly usage?: { readonly input: number; readonly output: number };
}

export interface ChatStreamRequest {
  /** The prompt and the site context (chat-block-spec §8.3). */
  readonly system: string;
  readonly turns: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  readonly maxOutputTokens: number;
  /** Aborted when the visitor leaves, a timeout passes, or a cap is reached. */
  readonly signal: AbortSignal;
}

export interface ChatAdapter {
  /** Streams the answer's text. Throws on a non-2xx, an abort, or a malformed or oversized stream. */
  stream(req: ChatStreamRequest): AsyncIterable<ChatChunk>;
}

/**
 * A model call that failed. Its message is fixed text this server wrote —
 * a kind and at most an HTTP status — so it is safe to log; a provider's
 * body never becomes part of one.
 */
export class AdapterError extends Error {
  readonly kind: 'status' | 'malformed' | 'too_large' | 'network';
  readonly status: number | null;
  constructor(kind: AdapterError['kind'], status: number | null = null) {
    super(status === null ? kind : `${kind} ${status}`);
    this.name = 'AdapterError';
    this.kind = kind;
    this.status = status;
  }
}

type Fetch = typeof fetch;

/** A non-negative whole count, or null. */
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The `completions` adapter: one fetch per answer, read as a stream of JSON deltas. */
export function createCompletionsAdapter(
  config: { readonly url: string; readonly key: string; readonly model: string }, fetchImpl: Fetch = (...a) => fetch(...a),
): ChatAdapter {
  return {
    async *stream(req) {
      let response: Response;
      try {
        response = await fetchImpl(`${config.url}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'system', content: req.system }, ...req.turns.map((t) => ({ role: t.role, content: t.text }))],
            stream: true,
            max_tokens: req.maxOutputTokens,
            stream_options: { include_usage: true },
          }),
          signal: req.signal,
          redirect: 'error',
        });
      } catch (e) {
        if (req.signal.aborted) throw e;
        throw new AdapterError('network');
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new AdapterError('status', response.status);
      }
      const sse = createSseReader();
      /** One event's chunks, or 'done' at `[DONE]`. */
      const take = (data: string): ChatChunk[] | 'done' => {
        if (data === '[DONE]') return 'done';
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new AdapterError('malformed');
        }
        if (!chunk || typeof chunk !== 'object') throw new AdapterError('malformed');
        const c = chunk as { choices?: unknown; usage?: unknown };
        const choice = Array.isArray(c.choices) ? c.choices[0] as { delta?: { content?: unknown } } | undefined : undefined;
        const text = choice?.delta?.content;
        const u = c.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined;
        const input = count(u?.prompt_tokens);
        const output = count(u?.completion_tokens);
        return [
          ...(typeof text === 'string' && text !== '' ? [{ text }] : []),
          ...(input !== null && output !== null ? [{ usage: { input, output } }] : []),
        ];
      };
      try {
        // Every byte counts against RESPONSE_MAX as it is read; past it the read is cancelled.
        for await (const bytes of cappedChunks(response.body, RESPONSE_MAX)) {
          for (const e of sse.push(bytes)) {
            const out = take(e.data);
            if (out === 'done') return;
            yield* out;
          }
        }
        for (const e of sse.end()) {
          const out = take(e.data);
          if (out === 'done') return;
          yield* out;
        }
      } catch (e) {
        if (e instanceof SseLimitError || e instanceof BodyTooLarge) throw new AdapterError('too_large');
        // A connection lost mid-answer is a network failure; an abort stays one.
        if (!(e instanceof AdapterError) && !req.signal.aborted) throw new AdapterError('network');
        throw e;
      }
      // A stream that ends without [DONE] was cut off, not finished.
      throw new AdapterError('malformed');
    },
  };
}

/** One scripted answer (AZ_CHAT_FAKE_FILE). */
export interface FakeAnswer {
  /** Chosen when this is a case-insensitive part of the latest visitor message; without it, the default. */
  readonly when?: string;
  readonly chunks: readonly string[];
  /** A pause before each chunk, ms. */
  readonly delayMs?: number;
  readonly usage?: { readonly input: number; readonly output: number };
  /** Fail as if the provider answered this HTTP status. */
  readonly fail?: number;
  /** Never answer — for timeout and disconnect checks. */
  readonly stall?: boolean;
}

export interface FakeScript { readonly answers: readonly FakeAnswer[] }

/** A scripted-answers file's text as a FakeScript, or the problem with it. */
export function parseFakeScript(text: string): FakeScript | string {
  if (text.length > FAKE_FILE_MAX) return `is larger than ${FAKE_FILE_MAX / 1024} KB`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'is not JSON';
  }
  const answers = (raw as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(answers) || answers.length === 0) return 'needs { "answers": [ … ] } with at least one answer';
  for (const [i, a] of answers.entries()) {
    const x = a as Partial<Record<keyof FakeAnswer, unknown>> | null;
    const where = `answer ${i + 1}`;
    if (!x || typeof x !== 'object') return `${where} is not an object`;
    if (x.when !== undefined && typeof x.when !== 'string') return `${where}: when must be text`;
    if (!Array.isArray(x.chunks) || !x.chunks.every((c) => typeof c === 'string')) return `${where}: chunks must be a list of text`;
    if (x.delayMs !== undefined && !(count(x.delayMs) !== null && (x.delayMs as number) <= FAKE_DELAY_MAX)) return `${where}: delayMs must be 0–${FAKE_DELAY_MAX}`;
    const u = x.usage as { input?: unknown; output?: unknown } | undefined;
    if (u !== undefined && (count(u?.input) === null || count(u?.output) === null)) return `${where}: usage must be { input, output } counts`;
    if (x.fail !== undefined && !(count(x.fail) !== null && (x.fail as number) >= 400 && (x.fail as number) <= 599)) return `${where}: fail must be an HTTP error status`;
    if (x.stall !== undefined && typeof x.stall !== 'boolean') return `${where}: stall must be true or false`;
  }
  return { answers: answers as FakeAnswer[] };
}

/** Wait `ms`, or reject at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(signal.reason);
    const t = setTimeout(() => { signal.removeEventListener('abort', stop); done(); }, ms);
    const stop = () => { clearTimeout(t); fail(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

/**
 * The `fake` adapter: the first answer whose `when` the latest visitor
 * message contains, else the first without one. `aborted` counts the
 * streams whose signal ended them, so a test can see upstream stopped.
 */
export function createFakeAdapter(script: FakeScript): ChatAdapter & { readonly aborted: () => number; readonly calls: () => number } {
  let aborted = 0;
  let calls = 0;
  return {
    aborted: () => aborted,
    calls: () => calls,
    async *stream(req) {
      calls++;
      const onAbort = () => { aborted++; };
      req.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const latest = [...req.turns].reverse().find((t) => t.role === 'user')?.text.toLowerCase() ?? '';
        const answer = script.answers.find((a) => a.when !== undefined && latest.includes(a.when.toLowerCase()))
          ?? script.answers.find((a) => a.when === undefined);
        if (!answer) throw new AdapterError('status', 404);
        if (answer.stall) {
          await new Promise((_, fail) => {
            if (req.signal.aborted) fail(req.signal.reason);
            req.signal.addEventListener('abort', () => fail(req.signal.reason), { once: true });
          });
        }
        if (answer.fail !== undefined) throw new AdapterError('status', answer.fail);
        for (const chunk of answer.chunks) {
          await pause(answer.delayMs ?? 0, req.signal);
          yield { text: chunk };
        }
        if (answer.usage) yield { usage: answer.usage };
      } finally {
        req.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** The adapter AZ_CHAT_API names; `fake` reads its file now, so a bad one stops the start. */
export async function createAdapter(config: ChatConfig): Promise<ChatAdapter> {
  if (config.api === 'completions') return createCompletionsAdapter(config);
  const script = parseFakeScript(await readFile(config.fakeFile, 'utf8'));
  if (typeof script === 'string') throw new Error(`AZ_CHAT_FAKE_FILE ${script}`);
  return createFakeAdapter(script);
}
