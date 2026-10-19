/**
 * @az server chat-adapters
 * Purpose: the model behind the chat, as thin adapters named by wire shape — `completions`, `messages`, `contents` and `local` over fetch, and `fake` from a scripted file — chosen at start from the operator's settings.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §4.3, §19.19)
 * Exports: ChatAdapter, ChatChunk, ChatStreamRequest, AdapterError, ModelChoice, WireApi, WIRE_PATHS, createCompletionsAdapter, createMessagesAdapter, createContentsAdapter, createLocalAdapter, createFakeAdapter, parseFakeScript, createAdapter, FakeScript, RESPONSE_MAX
 * Edit guide: no vendor names, no SDK; every body is read through outbound.ts cappedChunks against RESPONSE_MAX and framed under SSE_LINE_MAX; an error's log form is its class and HTTP status only; a stream that ends without its shape's end is malformed.
 * Tests: packages/backend/test/chat-adapters.test.ts, packages/backend/test/chat-wire-shapes.test.ts
 */

/**
 * Provider adapters (chat-block-spec §4.3, §19.19). One interface, and each
 * adapter a thin proxy that only moves text: the shape, endpoint, key and
 * model id come from the operator's settings (the server's .env, or an
 * app's own settings through ModelChoice), never from code, and no
 * provider is named here. Each shape's wire format was read from its
 * publisher's reference (chat-block-spec §18, R5, R6, R12, R13).
 *
 * - `completions`: a POST of `{ model, messages, stream, max_tokens }` to
 *   <url>/chat/completions, answered by `data:` lines of JSON deltas ending
 *   with `data: [DONE]`. Its common hosted form caches a long prompt
 *   prefix by itself (§19.16); `prompt_tokens_details.cached_tokens` is
 *   the input read from cache.
 * - `messages`: a POST of `{ model, max_tokens, system, messages, stream }`
 *   to <url>/messages, answered by named events (`message_start`,
 *   `content_block_delta`, `message_delta`, `message_stop`, `ping`,
 *   `error`). This shape caches only up to a marker, so the system text's
 *   fixed prefix (ChatStreamRequest.fixed) is sent as its own block with
 *   one; its usage counts the input after the marker, the input read from
 *   cache and the input written to it apart, and they are added up here.
 * - `contents`: a POST of `{ systemInstruction, contents, generationConfig }`
 *   to <url>/models/<model>:streamGenerateContent?alt=sse, answered by
 *   `data:` lines of candidates, the last with a `finishReason`.
 * - `local`: a POST of `{ model, messages, stream, options }` to
 *   <url>/api/chat, answered by one JSON object per line, the last with
 *   `done: true` — the shape local model servers speak.
 * - `fake` replays scripted answers for tests and local development; the
 *   server refuses it outside a loopback deployment (env.ts).
 *
 * The key goes in the shape's usual header — `Authorization: Bearer` for
 * `completions` and `local`, `x-api-key` for `messages` — or in the header
 * the operator names (AZ_CHAT_KEY_HEADER), which `contents` needs; any
 * other header a provider requires is the operator's (AZ_CHAT_HEADERS).
 * Timeouts are the caller's (chat.ts, chat-probe.ts): an adapter yields
 * text as it arrives and stops the moment the signal aborts.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { readFile } from 'node:fs/promises';
import { createSseReader, SSE_LINE_MAX, SseLimitError, type SseEvent } from './chat-sse.ts';
import { BodyTooLarge, cappedChunks } from './outbound.ts';
import type { ModelBridge, ModelChunk, ModelRequest } from '#chat-answer/model-stream.ts';

/** The most bytes read from one answer's response — far past a 2 000-token stream's framing. */
export const RESPONSE_MAX = 2 * 1024 * 1024;
/** The scripted-answers file's largest size. */
const FAKE_FILE_MAX = 1024 * 1024;
/** A scripted pause between chunks, at most. */
const FAKE_DELAY_MAX = 2_000;

/** A chunk of the model's stream, and what it is asked: the streaming contract's (chat-answer model-stream.ts, chat-block-spec §22.4). */
export type ChatChunk = ModelChunk;
export type ChatStreamRequest = ModelRequest;

/** Every adapter is a model bridge: it streams the answer's text, and throws on a non-2xx, an abort, an error the stream reports, or a malformed or oversized stream. */
export type ChatAdapter = ModelBridge;

/**
 * A model call that failed. Its message is fixed text this server wrote —
 * a kind and at most an HTTP status — so it is safe to log; a provider's
 * body never becomes part of one. `upstream` is an error the provider
 * reported inside a stream that had begun.
 */
export class AdapterError extends Error {
  readonly kind: 'status' | 'malformed' | 'too_large' | 'network' | 'upstream';
  readonly status: number | null;
  constructor(kind: AdapterError['kind'], status: number | null = null) {
    super(status === null ? kind : `${kind} ${status}`);
    this.name = 'AdapterError';
    this.kind = kind;
    this.status = status;
  }
}

type Fetch = typeof fetch;

/** The wire shapes a real model is asked in. */
export type WireApi = 'completions' | 'messages' | 'contents' | 'local';

/** What each shape adds to the base URL — so `az doctor` can see a URL that already ends in it. */
export const WIRE_PATHS: Readonly<Record<WireApi, string>> = {
  completions: '/chat/completions',
  messages: '/messages',
  contents: '/models',
  local: '/api/chat',
};

/**
 * Where and how one model is asked: the server's .env (env.ts ChatConfig)
 * or an app's own settings. `keyHeader` is '' for the shape's usual one;
 * `headers` are the operator's extra request headers, checked by env.ts.
 */
export interface ModelChoice {
  readonly url: string;
  readonly key: string;
  readonly model: string;
  readonly keyHeader?: string;
  readonly headers?: readonly (readonly [string, string])[];
}

/** A non-negative whole count, or null. */
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The request headers: the operator's first, so the server's own — content type, accept, the key — always win. */
function headersFor(choice: ModelChoice, accept: string, usual: 'bearer' | 'x-api-key' | 'none'): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(choice.headers ?? []);
  out['content-type'] = 'application/json';
  out.accept = accept;
  if (choice.key) {
    if (choice.keyHeader) out[choice.keyHeader] = choice.key;
    else if (usual === 'bearer') out.authorization = `Bearer ${choice.key}`;
    else if (usual === 'x-api-key') out['x-api-key'] = choice.key;
  }
  return out;
}

/**
 * One line-per-object reader (the `local` shape): `push` bytes, get the
 * lines they completed; `end` flushes the last one. A line longer than
 * `lineMax` bytes, counted before decoding, throws SseLimitError — the
 * same bound as an event stream's line.
 */
function createLineReader(lineMax: number = SSE_LINE_MAX) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let line = '';
  let lineBytes = 0;
  const split = (text: string): string[] => {
    const parts = (line + text).split('\n');
    line = parts.pop() ?? '';
    return parts.map((p) => p.replace(/\r$/, '')).filter((p) => p.trim() !== '');
  };
  return {
    push(bytes: Uint8Array): string[] {
      let since = lineBytes;
      for (const b of bytes) {
        if (b === 10) since = 0;
        else if (++since > lineMax) throw new SseLimitError('line too long');
      }
      lineBytes = since;
      return split(decoder.decode(bytes, { stream: true }));
    },
    end(): string[] {
      const out = split(`${decoder.decode()}\n`);
      line = '';
      return out;
    },
  };
}

/** A frame's JSON object, or malformed. */
function parseObject(data: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new AdapterError('malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError('malformed');
  return value as Record<string, unknown>;
}

/** A frame's chunks, or 'done' with the last of them when the shape's end arrives. */
type Taken = readonly ChatChunk[] | { readonly done: readonly ChatChunk[] };

/**
 * One answer, the same for every shape: POST `body` to `url`, refuse a
 * non-2xx by its status alone, then read the body under RESPONSE_MAX,
 * framed by `reader`, each frame handed to `take`. A stream that ends
 * before `take` says done was cut off: malformed.
 */
async function* streamFrom<F>(
  fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal,
  reader: { push(bytes: Uint8Array): F[]; end(): F[] }, take: (frame: F) => Taken,
): AsyncGenerator<ChatChunk> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new AdapterError('network');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new AdapterError('status', response.status);
  }
  try {
    // Every byte counts against RESPONSE_MAX as it is read; past it the read is cancelled.
    for await (const bytes of cappedChunks(response.body, RESPONSE_MAX)) {
      for (const frame of reader.push(bytes)) {
        const out = take(frame);
        if ('done' in out) { yield* out.done; return; }
        yield* out;
      }
    }
    for (const frame of reader.end()) {
      const out = take(frame);
      if ('done' in out) { yield* out.done; return; }
      yield* out;
    }
  } catch (e) {
    if (e instanceof SseLimitError || e instanceof BodyTooLarge) throw new AdapterError('too_large');
    // A connection lost mid-answer is a network failure; an abort stays one.
    if (!(e instanceof AdapterError) && !signal.aborted) throw new AdapterError('network');
    throw e;
  }
  // A stream that ends without its shape's end was cut off, not finished.
  throw new AdapterError('malformed');
}

/** Text as a chunk, when there is any. */
const textChunk = (text: unknown): ChatChunk[] => (typeof text === 'string' && text !== '' ? [{ text }] : []);

/** The `completions` adapter: one fetch per answer, read as a stream of JSON deltas. */
export function createCompletionsAdapter(choice: ModelChoice, fetchImpl: Fetch = (...a) => fetch(...a)): ChatAdapter {
  return {
    stream(req) {
      const take = (e: SseEvent): Taken => {
        if (e.data === '[DONE]') return { done: [] };
        const c = parseObject(e.data) as { choices?: unknown; usage?: unknown };
        const first = Array.isArray(c.choices) ? c.choices[0] as { delta?: { content?: unknown } } | undefined : undefined;
        const u = c.usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null } | null | undefined;
        const input = count(u?.prompt_tokens);
        const output = count(u?.completion_tokens);
        // A part of the input: a count past the input is no count.
        const cached = count(u?.prompt_tokens_details?.cached_tokens);
        return [
          ...textChunk(first?.delta?.content),
          ...(input !== null && output !== null ? [{ usage: { input, output, ...(cached !== null && cached <= input ? { cached } : {}) } }] : []),
        ];
      };
      return streamFrom(fetchImpl, `${choice.url}${WIRE_PATHS.completions}`, headersFor(choice, 'text/event-stream', 'bearer'), {
        model: choice.model,
        messages: [{ role: 'system', content: req.system }, ...req.turns.map((t) => ({ role: t.role, content: t.text }))],
        stream: true,
        max_tokens: req.maxOutputTokens,
        stream_options: { include_usage: true },
      }, req.signal, createSseReader(), take);
    },
  };
}

/**
 * The `messages` adapter. The system text goes as text blocks: its fixed
 * prefix with the cache marker, then the rest of it, if any — so every
 * question on a page reads the same cached prefix. Usage: the input is
 * what came after the marker plus what was read from and written to the
 * cache; `cached` is the part read. The counts in `message_delta` are the
 * whole answer's so far, so the last ones stand.
 */
export function createMessagesAdapter(choice: ModelChoice, fetchImpl: Fetch = (...a) => fetch(...a)): ChatAdapter {
  return {
    stream(req) {
      const cut = Math.max(0, Math.min(req.fixed ?? req.system.length, req.system.length));
      const fixed = req.system.slice(0, cut);
      const rest = req.system.slice(cut);
      const system = [
        ...(fixed !== '' ? [{ type: 'text', text: fixed, cache_control: { type: 'ephemeral' } }] : []),
        ...(rest !== '' ? [{ type: 'text', text: rest }] : []),
      ];
      const counts: { input: number | null; read: number | null; written: number | null; output: number | null } = { input: null, read: null, written: null, output: null };
      const note = (u: unknown) => {
        if (!u || typeof u !== 'object') return;
        const x = u as { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown; output_tokens?: unknown };
        counts.input = count(x.input_tokens) ?? counts.input;
        counts.read = count(x.cache_read_input_tokens) ?? counts.read;
        counts.written = count(x.cache_creation_input_tokens) ?? counts.written;
        counts.output = count(x.output_tokens) ?? counts.output;
      };
      const take = (e: SseEvent): Taken => {
        const d = parseObject(e.data) as { type?: unknown; message?: { usage?: unknown }; delta?: { type?: unknown; text?: unknown }; usage?: unknown };
        const type = typeof d.type === 'string' ? d.type : e.event;
        if (type === 'error') throw new AdapterError('upstream');
        if (type === 'message_start') note(d.message?.usage);
        else if (type === 'message_delta') note(d.usage);
        else if (type === 'content_block_delta' && d.delta?.type === 'text_delta') return textChunk(d.delta.text);
        else if (type === 'message_stop') {
          if (counts.input === null || counts.output === null) return { done: [] };
          const read = counts.read ?? 0;
          const input = counts.input + read + (counts.written ?? 0);
          return { done: [{ usage: { input, output: counts.output, ...(counts.read !== null ? { cached: read } : {}) } }] };
        }
        // `ping`, the block starts and stops, and any event a later version adds carry no text.
        return [];
      };
      return streamFrom(fetchImpl, `${choice.url}${WIRE_PATHS.messages}`, headersFor(choice, 'text/event-stream', 'x-api-key'), {
        model: choice.model,
        max_tokens: req.maxOutputTokens,
        ...(system.length > 0 ? { system } : {}),
        messages: req.turns.map((t) => ({ role: t.role, content: t.text })),
        stream: true,
      }, req.signal, createSseReader(), take);
    },
  };
}

/**
 * The `contents` adapter. The visitor is `user` and the answers `model`;
 * a part marked as the model's thinking is not answer text. Usage comes
 * with the chunks, the last count standing: the prompt (which includes
 * the part read from cache), and the candidates plus any thinking, both
 * billed as output. The answer ends at the first `finishReason`, or at a
 * `promptFeedback.blockReason` (refused before any text: an empty answer).
 */
export function createContentsAdapter(choice: ModelChoice, fetchImpl: Fetch = (...a) => fetch(...a)): ChatAdapter {
  return {
    stream(req) {
      let usage: ChatChunk['usage'] | null = null;
      const take = (e: SseEvent): Taken => {
        const d = parseObject(e.data) as { error?: unknown; candidates?: unknown; usageMetadata?: unknown; promptFeedback?: { blockReason?: unknown } };
        if (d.error !== undefined) throw new AdapterError('upstream');
        const u = d.usageMetadata as { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown; cachedContentTokenCount?: unknown } | undefined;
        const input = count(u?.promptTokenCount);
        if (input !== null) {
          const output = (count(u?.candidatesTokenCount) ?? 0) + (count(u?.thoughtsTokenCount) ?? 0);
          const cached = count(u?.cachedContentTokenCount);
          usage = { input, output, ...(cached !== null && cached <= input ? { cached } : {}) };
        }
        const candidate = Array.isArray(d.candidates) ? d.candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown } | undefined : undefined;
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts as { text?: unknown; thought?: unknown }[] : [];
        const text = parts.flatMap((p) => (p && typeof p === 'object' && p.thought !== true ? textChunk(p.text) : []));
        const finished = typeof candidate?.finishReason === 'string' || typeof d.promptFeedback?.blockReason === 'string';
        return finished ? { done: [...text, ...(usage ? [{ usage }] : [])] } : text;
      };
      return streamFrom(fetchImpl, `${choice.url}${WIRE_PATHS.contents}/${encodeURIComponent(choice.model)}:streamGenerateContent?alt=sse`, headersFor(choice, 'text/event-stream', 'none'), {
        ...(req.system !== '' ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents: req.turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
        generationConfig: { maxOutputTokens: req.maxOutputTokens },
      }, req.signal, createSseReader(), take);
    },
  };
}

/**
 * The `local` adapter: one JSON object per line, each with a piece of
 * `message.content`, the last `done: true` with the prompt's and the
 * answer's counts. Such a server keeps its own prompt cache and reports
 * no cached count.
 */
export function createLocalAdapter(choice: ModelChoice, fetchImpl: Fetch = (...a) => fetch(...a)): ChatAdapter {
  return {
    stream(req) {
      const take = (line: string): Taken => {
        const d = parseObject(line) as { error?: unknown; message?: { content?: unknown }; done?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
        if (d.error !== undefined) throw new AdapterError('upstream');
        const text = textChunk(d.message?.content);
        if (d.done !== true) return text;
        const input = count(d.prompt_eval_count);
        const output = count(d.eval_count);
        return { done: [...text, ...(input !== null && output !== null ? [{ usage: { input, output } }] : [])] };
      };
      return streamFrom(fetchImpl, `${choice.url}${WIRE_PATHS.local}`, headersFor(choice, 'application/x-ndjson', 'bearer'), {
        model: choice.model,
        messages: [{ role: 'system', content: req.system }, ...req.turns.map((t) => ({ role: t.role, content: t.text }))],
        stream: true,
        options: { num_predict: req.maxOutputTokens },
      }, req.signal, createLineReader(), take);
    },
  };
}

/** One scripted answer (AZ_CHAT_FAKE_FILE). */
export interface FakeAnswer {
  /** Chosen when this is a case-insensitive part of the latest visitor message; without it, the default. */
  readonly when?: string;
  /**
   * …and only when the system text the server sent holds this exactly — so a
   * test can see what the model was given (a `knows` row reached it; a
   * private value did not) without the adapter ever echoing it.
   */
  readonly system?: string;
  readonly chunks: readonly string[];
  /** A pause before each chunk, ms. */
  readonly delayMs?: number;
  readonly usage?: { readonly input: number; readonly output: number; readonly cached?: number };
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
    if (x.system !== undefined && (typeof x.system !== 'string' || x.system === '')) return `${where}: system must be text`;
    if (!Array.isArray(x.chunks) || !x.chunks.every((c) => typeof c === 'string')) return `${where}: chunks must be a list of text`;
    if (x.delayMs !== undefined && !(count(x.delayMs) !== null && (x.delayMs as number) <= FAKE_DELAY_MAX)) return `${where}: delayMs must be 0–${FAKE_DELAY_MAX}`;
    const u = x.usage as { input?: unknown; output?: unknown; cached?: unknown } | undefined;
    if (u !== undefined && (count(u?.input) === null || count(u?.output) === null)) return `${where}: usage must be { input, output } counts`;
    if (u?.cached !== undefined && !(count(u.cached) !== null && (u.cached as number) <= (u.input as number))) return `${where}: usage.cached must be a count no larger than input`;
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
 * message contains (and whose `system`, if it has one, the system text
 * holds), else the first without one. `aborted` counts the
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
        const told = (a: FakeAnswer) => a.system === undefined || req.system.includes(a.system);
        const answer = script.answers.find((a) => a.when !== undefined && latest.includes(a.when.toLowerCase()) && told(a))
          ?? script.answers.find((a) => a.when === undefined && told(a));
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

/** The adapter for each real shape, by its AZ_CHAT_API name. */
const WIRE_ADAPTERS: Readonly<Record<WireApi, (choice: ModelChoice) => ChatAdapter>> = {
  completions: (c) => createCompletionsAdapter(c),
  messages: (c) => createMessagesAdapter(c),
  contents: (c) => createContentsAdapter(c),
  local: (c) => createLocalAdapter(c),
};

/** The adapter AZ_CHAT_API names; `fake` reads its file now, so a bad one stops the start. */
export async function createAdapter(config: ModelChoice & { readonly api: WireApi | 'fake'; readonly fakeFile: string }): Promise<ChatAdapter> {
  if (config.api !== 'fake') return WIRE_ADAPTERS[config.api](config);
  const script = parseFakeScript(await readFile(config.fakeFile, 'utf8'));
  if (typeof script === 'string') throw new Error(`AZ_CHAT_FAKE_FILE ${script}`);
  return createFakeAdapter(script);
}
