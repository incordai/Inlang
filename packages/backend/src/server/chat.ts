/**
 * @az server chat
 * Purpose: POST /chat — checks, limits, budget and queue, then the model's answer parsed into typed events and streamed to the page.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §4.2, §5.3, §6.5, §6.7)
 * Exports: createChat, parseChatContext, rulesFor, systemText, ChatContext, ChatOptions, ChatTiming, CHAT_TIMING, CHAT_FIRST_TOKEN_MS, CHAT_IDLE_MS
 * Edit guide: every limit is the server's, never the request's; nothing the model wrote reaches the page but chat-answer.ts's events; abort upstream whenever the answer stops; logs carry codes and counts, never text.
 * Tests: packages/backend/test/chat-route.test.ts, packages/backend/test/chat-main.test.ts, packages/backend/test/chat-attacks.test.ts
 */

/**
 * The chat route (chat-block-spec §4). The edge — Origin, CORS, the CSRF header —
 * is app.ts's, as for /data. From there:
 *
 *   kill switch → body → who may chat → conversation length → address and
 *   account limits → the day's budget → a slot in the queue → the stream.
 *
 * Refusals before the stream are JSON `{ error }`. Once the stream starts
 * every event is one of `text`, `block`, `done`, `error`: the model's text
 * goes through the answer parser (chat-answer.ts), which sends prose as
 * `text` and each component that passes every rule as one `block` — the
 * page never receives a byte the parser did not produce. The finished
 * answer's record (its prose and its components' canonical lines) is
 * tagged, so the page can send it back as history.
 *
 * The upstream request is aborted the moment the answer stops for any
 * reason — the visitor left, a timeout, a cap — so an abandoned answer
 * stops costing tokens. Nothing is stored but the day's counts.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import type { ServerResponse } from 'node:http';
import type { ChatRequest, ChatRoutes } from './app.ts';
import type { ChatAdapter } from './chat-adapters.ts';
import { ANSWER_WORDS, createAnswerParser, type AnswerEvent, type AnswerQuote, type AnswerRules, type AnswerWord } from './chat-answer.ts';
import { createQueue, createRateLimits } from './chat-limits.ts';
import { sseEvent } from './chat-sse.ts';
import { historyKey, readChatRequest, tagTurn, trimHistory } from './chat-text.ts';
import { createUsage, utcDay } from './chat-usage.ts';
import { randomToken } from './crypto.ts';
import type { Db } from './db.ts';
import type { ChatConfig } from './env.ts';
import { BodyError, send, SECURITY_HEADERS } from './http.ts';

/** Characters per token when a provider reports no usage — a conservative estimate (§6.5, INFERENCE). */
const CHARS_PER_TOKEN = 3;

/** The model's first token must arrive within this (§6.5). */
export const CHAT_FIRST_TOKEN_MS = 15_000;
/** …and each next chunk within this of the one before. The whole answer's bound is AZ_CHAT_TIMEOUT_SECONDS. */
export const CHAT_IDLE_MS = 20_000;

/** When the model must answer: its first token and each next one — the constants above, replaceable in tests. */
export interface ChatTiming { readonly firstMs: number; readonly betweenMs: number }
export const CHAT_TIMING: ChatTiming = { firstMs: CHAT_FIRST_TOKEN_MS, betweenMs: CHAT_IDLE_MS };

/** server/chat/context.json, as the route reads it. */
export interface ChatContext {
  /** Each page with a chat: who may send, how many messages a conversation holds, what an answer may show. */
  readonly chats: Readonly<Record<string, { readonly allow: 'signedin' | 'anyone'; readonly limit: number; readonly show: readonly AnswerWord[] }>>;
  /** The blocks answers may quote, and every destination a cta may point at (chat-block-spec §5.3, §6.2). */
  readonly quotes: readonly AnswerQuote[];
  readonly destinations: readonly string[];
  /** Everything else in the file: the site's public content, sent to the model as data. */
  readonly content: unknown;
}

const isRoute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v.length <= 2048;

/** context.json's text as a ChatContext, or the problem with it. */
export function parseChatContext(text: string): ChatContext | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'is not JSON';
  }
  const r = raw as { chats?: unknown; site?: unknown; pages?: unknown; answer?: unknown } | null;
  if (!r || typeof r.chats !== 'object' || r.chats === null) return 'has no chats';
  const chats: Record<string, { allow: 'signedin' | 'anyone'; limit: number; show: AnswerWord[] }> = {};
  for (const [route, c] of Object.entries(r.chats as Record<string, unknown>)) {
    const x = c as { allow?: unknown; limit?: unknown; show?: unknown } | null;
    if (!x || (x.allow !== 'signedin' && x.allow !== 'anyone') || !Number.isInteger(x.limit) || (x.limit as number) < 1 || (x.limit as number) > 50) {
      return `chats['${route}'] is not { allow, limit }`;
    }
    const show = x.show ?? [];
    if (!Array.isArray(show) || !show.every((w) => (ANSWER_WORDS as readonly unknown[]).includes(w))) {
      return `chats['${route}'].show is not a list of ${ANSWER_WORDS.join(', ')}`;
    }
    chats[route] = { allow: x.allow, limit: x.limit as number, show: show as AnswerWord[] };
  }
  // Present when a chat may show components; without it answers are prose only.
  const answer = (r.answer ?? { quotes: [], destinations: [] }) as { quotes?: unknown; destinations?: unknown };
  const quotes = answer.quotes;
  if (!Array.isArray(quotes) || !quotes.every((q) => {
    const x = q as Partial<AnswerQuote> | null;
    return !!x && x.word === 'pricing' && isRoute(x.route) && Number.isInteger(x.n) && (x.n as number) >= 0;
  })) return 'answer.quotes is not a list of { word, route, n }';
  const destinations = answer.destinations;
  if (!Array.isArray(destinations) || !destinations.every((d) => typeof d === 'string' && d.length > 0 && d.length <= 2048)) {
    return 'answer.destinations is not a list of destinations';
  }
  return { chats, quotes: quotes as AnswerQuote[], destinations: destinations as string[], content: { site: r.site, pages: r.pages } };
}

/** What one chat page's answers may show: its own `show`, the site's quotes and destinations. */
export function rulesFor(context: ChatContext, page: string): AnswerRules {
  const show = Object.hasOwn(context.chats, page) ? context.chats[page].show : [];
  return { show, quotes: context.quotes, destinations: context.destinations };
}

/** A quote as the model writes it: `show pricing /pricing`, `#2` for a page's second. */
const quoteLine = (q: AnswerQuote) => `show ${q.word} ${q.route}${q.n > 0 ? `#${q.n + 1}` : ''}`;

/**
 * What the model is told (chat-block-spec §8.3): the fixed prompt, then the
 * site's public content in a section marked as data, then the page the
 * visitor is on and what an answer there may hold. Nothing about the
 * visitor — no cookie, address or account.
 */
export function systemText(prompt: string, context: ChatContext, page: string): string {
  const rules = rulesFor(context, page);
  const lines = [`The visitor is on the page ${JSON.stringify(page)}.`];
  if (rules.show.length === 0) {
    lines.push('On this page an answer is prose only: write no component.');
  } else {
    lines.push(`On this page an answer may hold these components and no other: ${rules.show.join(', ')}.`);
    if (rules.show.includes('pricing')) {
      const quotes = rules.quotes.filter((q) => q.word === 'pricing').map(quoteLine);
      lines.push(quotes.length > 0 ? `The pricing blocks you may show: ${quotes.join(' · ')}.` : 'There is no pricing block to show.');
    }
    if (rules.show.includes('cta')) lines.push(`The destinations a cta may use, written exactly so: ${rules.destinations.join(' ')}.`);
  }
  // prompt.txt opens with the generated-file line, which is for the operator, not the model.
  return `${prompt.replace(/^# GENERATED BY AZ[^\n]*\n/, '').trimEnd()}\n\n<site-content>\n${JSON.stringify(context.content)}\n</site-content>\n\n${lines.join('\n')}\n`;
}

export interface ChatOptions {
  readonly config: ChatConfig;
  /** AZ_SESSION_SECRET, from which the history key is derived. */
  readonly secret: Buffer;
  readonly db: Db;
  readonly prompt: string;
  readonly context: ChatContext;
  readonly adapter: ChatAdapter;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly timing?: ChatTiming;
}

/** A whole-number token estimate for `chars` characters. */
const estimate = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** One parsed event as the page receives it. */
const wire = (e: AnswerEvent): string => (e.type === 'text' ? sseEvent('text', { s: e.s }) : sseEvent('block', e.block));

export function createChat(o: ChatOptions): ChatRoutes {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const timing = o.timing ?? CHAT_TIMING;
  const key = historyKey(o.secret);
  const usage = createUsage(o.db);
  const limits = createRateLimits(o.config.perAddress, o.config.perAccount, now);
  const queue = createQueue(o.config.concurrency);
  /** The day the budget last ran out, so it is logged once per day. */
  let exhaustedOn = '';

  async function stream(req: ChatRequest, res: ServerResponse, page: string, conversation: string, turns: Parameters<typeof trimHistory>[0], index: number, left: number): Promise<void> {
    const started = now();
    const system = systemText(o.prompt, o.context, page);
    const sent = trimHistory(turns);
    const ac = new AbortController();
    const stop = () => ac.abort();
    req.closed.addEventListener('abort', stop, { once: true });
    let idle = setTimeout(stop, timing.firstMs);
    const whole = setTimeout(stop, o.config.timeoutMs);
    res.writeHead(200, {
      ...SECURITY_HEADERS, ...req.cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    // The page learns at once that its answer is coming, before the first token.
    res.flushHeaders();
    const parser = createAnswerParser(rulesFor(o.context, page));
    // Nothing is written to a connection the visitor already closed.
    const write = (events: readonly AnswerEvent[]) => { if (!res.destroyed) for (const e of events) res.write(wire(e)); };
    let reported: { input: number; output: number } | null = null;
    let outcome: 'done' | 'capped' | 'unavailable' | 'gone' | 'empty' = 'done';
    try {
      for await (const chunk of o.adapter.stream({ system, turns: sent, maxOutputTokens: o.config.maxOutputTokens, signal: ac.signal })) {
        clearTimeout(idle);
        idle = setTimeout(stop, timing.betweenMs);
        if (chunk.usage) reported = chunk.usage;
        if (!chunk.text) continue;
        write(parser.push(chunk.text));
        // A cap passed (prose, components): stop reading, and stop the model.
        if (parser.ended) {
          outcome = 'capped';
          ac.abort();
          break;
        }
      }
      if (ac.signal.aborted && outcome !== 'capped') outcome = req.closed.aborted ? 'gone' : 'unavailable';
    } catch (e) {
      outcome = req.closed.aborted ? 'gone' : 'unavailable';
      if (!ac.signal.aborted) log(`chat: model failed: ${(e as Error)?.name === 'AdapterError' ? (e as Error).message : (e as Error)?.name ?? 'Error'}`);
      ac.abort();
    } finally {
      clearTimeout(idle);
      clearTimeout(whole);
      req.closed.removeEventListener('abort', stop);
    }
    // The last line and any component still open, once the answer is whole.
    if (outcome === 'done' || outcome === 'capped') write(parser.end());
    const record = parser.record;
    if ((outcome === 'done' || outcome === 'capped') && record.trim() === '') outcome = 'empty';
    // A connection the visitor closed has nobody left to tell.
    if (!res.destroyed) {
      const last = outcome === 'done' || outcome === 'capped'
        ? sseEvent('done', { tag: tagTurn(key, conversation, index, record), left, conversation, text: record })
        : outcome === 'gone' ? '' : sseEvent('error', { code: 'unavailable' });
      res.end(last);
    }
    // Spent whatever happened: the provider's count when it gave one, else an estimate.
    const input = reported?.input ?? estimate(system.length + sent.reduce((n, t) => n + t.text.length, 0));
    const output = reported?.output ?? estimate(record.length);
    const dropped = parser.dropped;
    await usage.add(utcDay(started), input, output, dropped.length);
    // Codes and counts only: why components were dropped, never what they said.
    log(`chat: ${outcome} ${now() - started}ms tokens ${input}/${output}${dropped.length > 0 ? ` dropped ${dropped.length} (${[...new Set(dropped)].sort().join(',')})` : ''}`);
  }

  async function handle(req: ChatRequest, res: ServerResponse): Promise<void> {
    const refuse = (status: number, error: string) => send(res, status, { error }, req.cors);
    if (!o.config.enabled) return refuse(403, 'disabled');
    let body: Record<string, unknown>;
    try {
      body = await req.body();
    } catch (e) {
      if (e instanceof BodyError) return refuse(400, 'bad_request');
      throw e;
    }
    const ask = readChatRequest(body, (page) => (Object.hasOwn(o.context.chats, page) ? o.context.chats[page].limit : null), key);
    if ('error' in ask) return refuse(400, ask.error);
    const chat = o.context.chats[ask.page];
    const user = await req.user();
    if (chat.allow === 'signedin' && user === null) return refuse(401, 'signin_required');
    if (ask.visitorTurns > chat.limit) {
      res.writeHead(200, { ...SECURITY_HEADERS, ...req.cors, 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(sseEvent('error', { code: 'conversation_full' }));
      return;
    }
    if (!limits.take(req.ip, user)) return refuse(429, 'rate_limited');
    // The budget is a ceiling: a request whose largest cost would cross it is refused before it is sent.
    const day = utcDay(now());
    const system = systemText(o.prompt, o.context, ask.page);
    const most = estimate(system.length + trimHistory(ask.turns).reduce((n, t) => n + t.text.length, 0)) + o.config.maxOutputTokens;
    if ((await usage.spent(day)) + most > o.config.dailyTokens) {
      if (exhaustedOn !== day) {
        exhaustedOn = day;
        log(`chat: the daily budget of ${o.config.dailyTokens} tokens is spent — chat is off until 00:00 UTC`);
      }
      return refuse(429, 'budget_exhausted');
    }
    const release = await queue.enter(req.closed);
    if (!release) return req.closed.aborted ? undefined : refuse(503, 'busy');
    try {
      if (req.closed.aborted) return;
      await stream(req, res, ask.page, ask.conversation ?? randomToken(), ask.turns, ask.turns.length, chat.limit - ask.visitorTurns);
    } finally {
      release();
    }
  }

  return {
    handle,
    sweep: () => limits.sweep(),
    prune: () => usage.sweep(now()),
  };
}
