/**
 * @az server chat
 * Purpose: POST /chat — checks, limits, budget and queue, then the model's answer parsed into typed events and streamed to the page.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §4.2, §5.3, §6.5, §6.7, §8.2, §8.3, §19.17, §20.5, §20.7, §21.2, §21.4)
 * Exports: createChat, parseChatContext, rulesFor, systemText, systemParts, fixedTokens, underCacheMinimum, cacheLine, PREFIX_CHARS_PER_TOKEN, ChatContext, ContextAsk, ChatOptions, ChatTiming, CHAT_TIMING, CHAT_FIRST_TOKEN_MS, CHAT_IDLE_MS, CHARS_PER_TOKEN
 * Edit guide: every limit is the server's, never the request's; nothing the model wrote reaches the page but chat-answer.ts's events; abort upstream whenever the answer stops; logs carry codes and counts, never text.
 * Tests: packages/backend/test/chat-route.test.ts, packages/backend/test/chat-main.test.ts, packages/backend/test/chat-attacks.test.ts, packages/backend/test/chat-knows.test.ts, packages/backend/test/chat-moderation.test.ts,
 *   packages/backend/test/chat-tools-route.test.ts, packages/backend/test/chat-site-answers.test.ts, packages/backend/test/chat-match.test.ts
 */

/**
 * The chat route (chat-block-spec §4). The edge — Origin, CORS, the CSRF header —
 * is app.ts's, as for /data. From there:
 *
 *   kill switch → body → who may chat → conversation length → address and
 *   account limits → [an answer of the site's own] → the moderation hook,
 *   when one is set → the day's budget → a slot in the queue → the stream.
 *
 * An answer of the site's own (§19.17) is a suggested question's own answer
 * when the page says its button was pressed, or the one preset or faq item
 * a typed question clearly asks for (chat-match.ts, AZ_CHAT_MATCH); it is
 * streamed through the same parser, resolution, caps, tag and count as a
 * model's, from the author's text instead of the model, and spends nothing.
 *
 * Refusals before the stream are JSON `{ error }`. Once the stream starts
 * every event is one of `text`, `block`, `hold`, `done`, `error`: the model's text
 * goes through the answer parser (chat-answer.ts), which sends prose as
 * `text` and each component that passes every rule as one `block` — the
 * page never receives a byte the parser did not produce. The finished
 * answer's history — its prose, a one-line stand-in for each component and
 * a note for each one dropped (§19.16) — is tagged, so the page can send it
 * back: the tag covers exactly the text the model is sent next time, and
 * the page draws from the events it kept.
 *
 * A rich component (§20) is resolved before it is written — announced first
 * by a `hold` event that names only its kind (`{ word }`, issue #28), so the
 * page shows a placeholder of its shape while a query, a tool or a lookup
 * runs; a hold is not part of the answer (neither shared nor kept): numbers the
 * model wrote are marked `src: model`; each `from` request is answered by
 * the server's own read of a public table (`figures`, chat-query.ts) and
 * marked `src: site`; each `from tool` request by one of the operator's
 * declared tools (`tools`, chat-tools.ts), marked `src: tool` with its
 * label — its rows go to the page only, never into what the model reads
 * (§21.2.4). A map's `place` is looked up by the operator's geocoder
 * (`geocoder`, chat-geocode.ts) when AZ_GEOCODER_URL is set, marked `src:
 * geocoded`; the model never reads what it found (§21.4.2). When shares are on, `done` also carries the share tag
 * over the answer's events as sent (chat-share.ts), so the page can keep
 * exactly this answer under a link if the visitor asks.
 *
 * The moderation hook (§6.8, chat-moderation.ts) judges the visitor's words
 * the model would be given — every visitor turn sent, since a visitor turn
 * carries no tag and an earlier one could be one never judged — and fails
 * closed: a block is `400 blocked`, a hook that errs or is late is
 * `503 unavailable`, and the model is never asked.
 *
 * A chat that `knows` tables (§8.2) is told, with each question, rows of
 * them read as a signed-out visitor reads them (`knows`, chat-knows.ts),
 * after the site content and labelled as data; they count in the budget's
 * estimate like the rest of the input.
 *
 * The upstream request is aborted the moment the answer stops for any
 * reason — the visitor left, a timeout, a cap — so an abandoned answer
 * stops costing tokens. Nothing is stored but the day's counts.
 *
 * Copied into a generated server; imports only its siblings, the answer checker (#chat-answer), the
 * instructions (#chat-instructions) and node built-ins.
 */

import type { ServerResponse } from 'node:http';
import type { ChatRequest, ChatRoutes } from './app.ts';
import type { ChatAdapter } from './chat-adapters.ts';
import type { KnowsRun } from './chat-knows.ts';
import { ANSWER_LIMITS, ANSWER_WORDS, QUOTE_WORDS, type AnswerPreset, type AnswerQuote, type AnswerRules, type AnswerWord } from '#chat-answer/chat-answer.ts';
import type { FiguresRun } from '#chat-answer/chat-rich.ts';
import { createAnswerChecker, type CheckerDone, type SentEvent } from '#chat-answer/checker.ts';
import type { Tools } from './chat-tools.ts';
import { siteOutline, type SiteOutline } from '#chat-instructions/chat-outline.ts';
import { bestMatch, matchCandidates, type MatchCandidate } from '#chat-instructions/chat-match.ts';
import { CONTENT_LIMITS, PAGES_HEADING, systemText as assembleSystem, usesTools, type InstructionTable, type SystemText } from '#chat-instructions/system-text.ts';
import type { Geocoder } from './chat-geocode.ts';
import { createShareRoutes, createShareStore, mergeText, shareKey, shareTag, SHARE_LIMITS } from './chat-share.ts';
import { createQueue, createRateLimits, createWindows, type Windows } from './chat-limits.ts';
import { sseEvent } from './chat-sse.ts';
import { historyKey, readChatRequest, tagTurn, trimHistory } from './chat-text.ts';
import { createModeration, type Moderation } from './chat-moderation.ts';
import { createUsage, utcDay } from './chat-usage.ts';
import { randomToken } from './crypto.ts';
import type { Db } from './db.ts';
import type { ChatConfig } from './env.ts';
import type { ChatToolShape } from '#chat-answer/tool-shape.ts';
import { CHARS_PER_TOKEN, estimateTokens, MODEL_TIMING, timedChunks, type ModelTiming } from '#chat-answer/model-stream.ts';
import { BodyError, send, SECURITY_HEADERS } from './http.ts';

/** Characters per token when a provider reports no usage (chat-answer model-stream.ts, §6.5). */
export { CHARS_PER_TOKEN };

/** The model's first token must arrive within this (§6.5)… */
export const CHAT_FIRST_TOKEN_MS = MODEL_TIMING.firstMs;
/** …and each next chunk within this of the one before. The whole answer's bound is AZ_CHAT_TIMEOUT_SECONDS. */
export const CHAT_IDLE_MS = MODEL_TIMING.betweenMs;

/** When the model must answer: its first token and each next one — the streaming contract's (model-stream.ts), replaceable in tests. */
export type ChatTiming = ModelTiming;
export const CHAT_TIMING: ChatTiming = MODEL_TIMING;

/** server/chat/context.json, as the route reads it. */
export interface ChatContext {
  /** Each page with a chat: who may send, how many messages a conversation holds, what an answer may show, and its chat's prompt file. */
  readonly chats: Readonly<Record<string, {
    readonly allow: 'signedin' | 'anyone'; readonly limit: number; readonly show: readonly AnswerWord[]; readonly knows: readonly string[]; readonly prompt: string;
    /** The chat's answer presets (§19.16), the author's and the build's (§19.17), each name, body and keywords; none when absent. */
    readonly presets: readonly AnswerPreset[];
    /** The suggested questions that answer without the model (§19.17): each as the page sends it, and its one answer line. */
    readonly asks: readonly ContextAsk[];
  }>>;
  /** The blocks answers may quote, and every destination a cta may point at (chat-block-spec §5.3, §6.2). */
  readonly quotes: readonly AnswerQuote[];
  readonly destinations: readonly string[];
  /** The build images an image card may name, by key, with the author's alt (§20.6). */
  readonly images: readonly { readonly key: string; readonly alt: string }[];
  /** The tables an answer may ask figures of, as the model is told them (§20.5): public fields only. */
  readonly tables: readonly ContextTable[];
  /** The tables some chat knows (§8.2), each with the public fields the build will send. */
  readonly knows: readonly ContextTable[];
  /** Everything else in the file: the site's public content, sent to the model as data. */
  readonly content: unknown;
  /** That content as the model reads it (chat-outline.ts): each page's summary and its full text. */
  readonly outline: SiteOutline;
}

/** A queryable table as context.json lists it: each public field's name and type, its choices or currency, a money field's digits (chat-instructions). */
export type ContextTable = InstructionTable;

const NAME = /^[a-z][a-z0-9]*$/;
/** A chat's prompt file in server/chat/, as the build names it (chat-context.ts promptFileName). */
const PROMPT_FILE = /^prompt-[1-9][0-9]{0,3}\.txt$/;
/** A preset's name (core chat.ts PRESET_NAME: words joined by one hyphen, at most 32), and the most one chat holds (the `answer` slot's max). */
const PRESET_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PRESET_NAME_MAX = 32;
const PRESETS_MAX = 8;
/** A preset's keywords (core chat.ts KEYWORDS_MAX): at most twelve, each one line of at most 40 characters. */
const KEYWORDS_MAX = 12;
const KEYWORD_LENGTH = 40;
/** The most suggested questions a chat has (the chat word's AZ2224). */
const ASKS_MAX = 4;
/** A suggested question's answer line at its longest: `show`, a word, a route of at most 2 048 characters and an item. */
const ASK_ANSWER_MAX = 2_100;

/** A suggested question that answers without the model: its text exactly as the page sends it, and its answer line. */
export interface ContextAsk { readonly text: string; readonly answer: string }

const CONTROL = /[\u0000-\u001f\u007f]/;

/** context.json's `chats[…].presets`, or null when malformed: names unique, each body one answer's record at most, keywords one line each. */
function contextPresets(v: unknown): AnswerPreset[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > PRESETS_MAX) return null;
  const out: AnswerPreset[] = [];
  for (const p of v) {
    const x = p as { name?: unknown; text?: unknown; keywords?: unknown } | null;
    if (!x || typeof x.name !== 'string' || x.name.length > PRESET_NAME_MAX || !PRESET_NAME.test(x.name) || out.some((o) => o.name === x.name)) return null;
    if (typeof x.text !== 'string' || x.text === '' || x.text.length > ANSWER_LIMITS.record) return null;
    const keywords = x.keywords ?? [];
    if (!Array.isArray(keywords) || keywords.length > KEYWORDS_MAX
      || !keywords.every((k) => typeof k === 'string' && k.trim() !== '' && k.length <= KEYWORD_LENGTH && !CONTROL.test(k))) return null;
    out.push({ name: x.name, text: x.text, ...(keywords.length > 0 ? { keywords: keywords as string[] } : {}) });
  }
  return out;
}

/**
 * context.json's `chats[…].asks`, or null when malformed: at most four, each
 * question one line within the `ask` key's cap, each answer `use <a preset
 * of this chat>` or one `show` line. The answer is read by the answer
 * parser under the page's rules when it is asked, like a model's.
 */
function contextAsks(v: unknown, presets: readonly AnswerPreset[]): ContextAsk[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > ASKS_MAX) return null;
  const out: ContextAsk[] = [];
  for (const a of v) {
    const x = a as { text?: unknown; answer?: unknown } | null;
    if (!x || typeof x.text !== 'string' || x.text.trim() === '' || x.text.length > ANSWER_LIMITS.ask || CONTROL.test(x.text)) return null;
    if (typeof x.answer !== 'string' || x.answer.length > ASK_ANSWER_MAX || CONTROL.test(x.answer)) return null;
    const words = x.answer.split(' ');
    const ok = words[0] === 'use' ? words.length === 2 && presets.some((p) => p.name === words[1])
      : words[0] === 'show' && (words.length === 3 || words.length === 4) && QUOTE_WORDS.includes(words[1] as AnswerWord) && isRoute(words[2]);
    if (!ok || out.some((o) => o.text === x.text)) return null;
    out.push({ text: x.text, answer: x.answer });
  }
  return out;
}

/** context.json's `answer.tables`, or null when malformed. */
function contextTables(v: unknown): ContextTable[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: ContextTable[] = [];
  for (const t of v) {
    const x = t as { name?: unknown; fields?: unknown } | null;
    if (!x || typeof x.name !== 'string' || !NAME.test(x.name) || !Array.isArray(x.fields)) return null;
    const fields: ContextTable['fields'][number][] = [];
    for (const f of x.fields) {
      const y = f as { name?: unknown; type?: unknown; choices?: unknown; currency?: unknown; digits?: unknown; search?: unknown } | null;
      if (!y || typeof y.name !== 'string' || !NAME.test(y.name) || typeof y.type !== 'string' || !NAME.test(y.type)) return null;
      if (y.search !== undefined && y.search !== true) return null;
      if (y.choices !== undefined && !(Array.isArray(y.choices) && y.choices.every((c) => typeof c === 'string'))) return null;
      if (y.currency !== undefined && (typeof y.currency !== 'string' || !/^[a-z]{3}$/.test(y.currency))) return null;
      if (y.digits !== undefined && !(Number.isInteger(y.digits) && (y.digits as number) >= 0 && (y.digits as number) <= 4)) return null;
      fields.push({
        name: y.name, type: y.type, ...(y.choices ? { choices: y.choices as string[] } : {}),
        ...(y.currency ? { currency: y.currency } : {}), ...(y.digits !== undefined ? { digits: y.digits as number } : {}),
        ...(y.search === true ? { search: true as const } : {}),
      });
    }
    out.push({ name: x.name, fields });
  }
  return out;
}

/** context.json's `answer.images`, or null when malformed. */
function contextImages(v: unknown): { key: string; alt: string }[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const ok = v.every((i) => {
    const x = i as { key?: unknown; alt?: unknown } | null;
    return !!x && typeof x.key === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(x.key) && typeof x.alt === 'string' && x.alt.length <= 300;
  });
  return ok ? (v as { key: string; alt: string }[]).map((i) => ({ key: i.key, alt: i.alt })) : null;
}

const isRoute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v.length <= 2048;

/** One of context.json's quotable blocks: a pricing block, or an faq or feature list (§19.16) — its word, page, place and title. */
function isQuote(q: unknown): boolean {
  const x = q as { word?: unknown; route?: unknown; n?: unknown; label?: unknown } | null;
  return !!x && QUOTE_WORDS.includes(x.word as AnswerWord) && isRoute(x.route) && Number.isInteger(x.n) && (x.n as number) >= 0
    && (x.label === undefined || (typeof x.label === 'string' && x.label.length <= 200)) && Object.keys(x).every((k) => ['word', 'route', 'n', 'label'].includes(k));
}

/**
 * A quotable list's items, from the page content context.json holds (the
 * build writes them once, there): an faq's questions and answers, a feature
 * list's titles and texts, as `{ title, text }`. Null when the page or its
 * n-th list of the word is not there.
 */
function listItems(pages: unknown, q: AnswerQuote): { title: string; text: string }[] | null {
  if (!Array.isArray(pages)) return null;
  const page = pages.find((p) => (p as { route?: unknown } | null)?.route === q.route) as { blocks?: unknown } | undefined;
  if (!page || !Array.isArray(page.blocks)) return null;
  const list = page.blocks.filter((b) => (b as { block?: unknown } | null)?.block === q.word)[q.n] as { questions?: unknown; items?: unknown } | undefined;
  const raw = q.word === 'faq' ? list?.questions : list?.items;
  if (!Array.isArray(raw)) return null;
  const items: { title: string; text: string }[] = [];
  for (const i of raw) {
    const x = i as Record<string, unknown> | null;
    const title = q.word === 'faq' ? x?.question : x?.title;
    const text = (q.word === 'faq' ? x?.answer : x?.text) ?? '';
    if (typeof title !== 'string' || typeof text !== 'string') return null;
    items.push({ title, text });
  }
  return items;
}

/** context.json's text as a ChatContext, or the problem with it. */
export function parseChatContext(text: string): ChatContext | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'is not JSON';
  }
  const r = raw as { chats?: unknown; site?: unknown; pages?: unknown; answer?: unknown; knows?: unknown } | null;
  if (!r || typeof r.chats !== 'object' || r.chats === null) return 'has no chats';
  const knows = contextTables(r.knows);
  if (knows === null) return 'knows is not a list of { name, fields }';
  const chats: Record<string, { allow: 'signedin' | 'anyone'; limit: number; show: AnswerWord[]; knows: string[]; prompt: string; presets: AnswerPreset[]; asks: ContextAsk[] }> = {};
  for (const [route, c] of Object.entries(r.chats as Record<string, unknown>)) {
    const x = c as { allow?: unknown; limit?: unknown; show?: unknown; knows?: unknown; prompt?: unknown; presets?: unknown; asks?: unknown } | null;
    if (!x || (x.allow !== 'signedin' && x.allow !== 'anyone') || !Number.isInteger(x.limit) || (x.limit as number) < 1 || (x.limit as number) > 50) {
      return `chats['${route}'] is not { allow, limit }`;
    }
    const show = x.show ?? [];
    if (!Array.isArray(show) || !show.every((w) => (ANSWER_WORDS as readonly unknown[]).includes(w))) {
      return `chats['${route}'].show is not a list of ${ANSWER_WORDS.join(', ')}`;
    }
    const known = x.knows ?? [];
    if (!Array.isArray(known) || !known.every((n) => typeof n === 'string' && knows.some((t) => t.name === n))) {
      return `chats['${route}'].knows is not a list of the tables in knows`;
    }
    if (typeof x.prompt !== 'string' || !PROMPT_FILE.test(x.prompt)) return `chats['${route}'].prompt is not a prompt file (prompt-<n>.txt)`;
    const presets = contextPresets(x.presets);
    if (presets === null) return `chats['${route}'].presets is not a list of { name, text, keywords? }`;
    const asks = contextAsks(x.asks, presets);
    if (asks === null) return `chats['${route}'].asks is not a list of { text, answer }`;
    chats[route] = { allow: x.allow, limit: x.limit as number, show: show as AnswerWord[], knows: known as string[], prompt: x.prompt, presets, asks };
  }
  // Present when a chat may show components; without it answers are prose only.
  const answer = (r.answer ?? { quotes: [], destinations: [] }) as { quotes?: unknown; destinations?: unknown; tables?: unknown; images?: unknown };
  const quotes = answer.quotes;
  if (!Array.isArray(quotes) || !quotes.every(isQuote)) return 'answer.quotes is not a list of { word, route, n, label?, items? }';
  const destinations = answer.destinations;
  if (!Array.isArray(destinations) || !destinations.every((d) => typeof d === 'string' && d.length > 0 && d.length <= 2048)) {
    return 'answer.destinations is not a list of destinations';
  }
  const tables = contextTables(answer.tables);
  if (tables === null) return 'answer.tables is not a list of { name, fields }';
  const images = contextImages(answer.images);
  if (images === null) return 'answer.images is not a list of { key, alt }';
  // A list is quoted from the page content beside it; one the pages do not hold is a context the build did not write.
  const resolved: AnswerQuote[] = [];
  for (const q of quotes as AnswerQuote[]) {
    if (q.word === 'pricing') { resolved.push(q); continue; }
    const items = listItems(r.pages, q);
    if (items === null) return `answer.quotes names ${q.word} ${q.route}#${q.n + 1}, which the pages do not hold`;
    resolved.push({ ...q, items });
  }
  const content = { site: r.site, pages: r.pages };
  return { chats, quotes: resolved, destinations: destinations as string[], images, tables, knows, content, outline: siteOutline(content) };
}

/**
 * What one chat page's answers may show: its own `show`, the site's quotes
 * and destinations, the tools when it may use them, and whether a map's
 * `place` may be looked up (a geocoder is set and the page shows maps).
 */
export function rulesFor(context: ChatContext, page: string, tools: readonly ChatToolShape[] = [], geocoder = false): AnswerRules {
  const show = Object.hasOwn(context.chats, page) ? context.chats[page].show : [];
  const presets = Object.hasOwn(context.chats, page) ? context.chats[page].presets : [];
  return {
    show, quotes: context.quotes, destinations: context.destinations, images: context.images.map((i) => i.key),
    ...(presets.length > 0 ? { presets } : {}),
    ...(usesTools(show) && tools.length > 0 ? { tools } : {}),
    ...(geocoder && show.includes('map') ? { geocoder: true } : {}),
  };
}

/**
 * What the model is told (chat-block-spec §8.3), ordered for the provider's
 * prompt cache (§19.16) — what changes least first, so the long prefix is
 * byte-identical from one question to the next: the chat's fixed prompt,
 * then the site's public content in a section marked as data, then the page
 * the visitor is on and what its components may use, then the operator's
 * tools and the geocoder's place line (generated from their declarations,
 * §21.2.2 — never their URLs, keys or anything one answered), then — on a
 * site past CONTENT_LIMITS.whole — the pages `asked` (the visitor's latest
 * turns, newest first) needs in full, and last the rows of the tables the
 * page's chat knows, read for this question (chat-knows.ts, labelled data
 * too). Nothing about the visitor — no cookie, address or account.
 * `select` says whether pages are chosen; by default, past the size.
 */
export function systemText(...args: Parameters<typeof systemParts>): string {
  return systemParts(...args).text;
}

/**
 * systemText, and how many of its characters are the same for every
 * question on the page (§19.16, §19.19): all but the chosen pages and the
 * rows. A wire shape that caches only up to a marker puts its marker there.
 */
export function systemParts(
  prompt: string, context: ChatContext, page: string, rows = '', tools: readonly ChatToolShape[] = [], geocoder = false, asked: readonly string[] = [],
  select = context.outline.pages.reduce((n, p) => n + p.full.length + 1, 0) > CONTENT_LIMITS.whole,
): SystemText {
  const rules = rulesFor(context, page, tools, geocoder);
  // A prompt file opens with the generated-file line, which is for the operator, not the model.
  return assembleSystem({
    fixed: prompt.replace(/^# GENERATED BY AZ[^\n]*\n/, ''), outline: context.outline, page,
    show: rules.show, quotes: rules.quotes, destinations: rules.destinations, tables: context.tables, images: context.images,
    ...(rules.tools ? { tools: rules.tools } : {}), geocoder: rules.geocoder === true, rows, asked, select,
  });
}

/**
 * Characters a token of the fixed system text is, for the cache check
 * (§19.17): `pnpm bench:tokens` measures 3.9 to 4.3 on the fixtures'
 * prompts and system texts. Not the budget's CHARS_PER_TOKEN, which is
 * meant to over-count: here an over-count would hide a prefix too short.
 */
export const PREFIX_CHARS_PER_TOKEN = 4;

/**
 * About how many tokens a page's chat sends before anything a question
 * changes — the prefix a provider's prompt cache can keep (§19.16, §19.17):
 * the system text without rows, cut before the pages a large site chooses
 * per question.
 */
export function fixedTokens(prompt: string, context: ChatContext, page: string, tools: readonly ChatToolShape[] = [], geocoder = false): number {
  const text = systemText(prompt, context, page, '', tools, geocoder);
  const cut = text.indexOf(`\n${PAGES_HEADING}`);
  return Math.ceil((cut < 0 ? text : text.slice(0, cut)).length / PREFIX_CHARS_PER_TOKEN);
}

/**
 * The chat pages whose fixed system text is under the provider's cache
 * minimum (AZ_CHAT_CACHE_MIN_TOKENS, §19.17), with about how many tokens
 * each sends — a question there is billed whole, every time. None when the
 * minimum is 0.
 */
export function underCacheMinimum(
  prompts: Readonly<Record<string, string>>, context: ChatContext, min: number, tools: readonly ChatToolShape[] = [], geocoder = false,
): { readonly page: string; readonly tokens: number }[] {
  if (min <= 0) return [];
  return Object.keys(context.chats).sort().flatMap((page) => {
    const prompt = prompts[context.chats[page].prompt];
    if (prompt === undefined) return [];
    const tokens = fixedTokens(prompt, context, page, tools, geocoder && context.chats[page].show.includes('map'));
    return tokens < min ? [{ page, tokens }] : [];
  });
}

/** The cache check as one line a person reads (az doctor, az backend probe), or null when every page reaches the minimum. */
export function cacheLine(under: readonly { readonly page: string; readonly tokens: number }[], pages: number, min: number): string | null {
  if (under.length === 0) return null;
  const tokens = under.map((u) => u.tokens);
  const range = Math.min(...tokens) === Math.max(...tokens) ? `about ${tokens[0]}` : `about ${Math.min(...tokens)}–${Math.max(...tokens)}`;
  const shown = under.slice(0, 5).map((u) => u.page).join(', ');
  return `${under.length} of ${pages} chat ${pages === 1 ? 'page sends' : 'pages send'} a fixed system text of ${range} tokens, under the provider's prompt-cache minimum of ${min} (AZ_CHAT_CACHE_MIN_TOKENS): ${shown}${under.length > 5 ? ', …' : ''} — each question there is billed whole; a cached prefix is cheaper only at or past the minimum`;
}

export interface ChatOptions {
  readonly config: ChatConfig;
  /** AZ_SESSION_SECRET, from which the history key is derived. */
  readonly secret: Buffer;
  readonly db: Db;
  /** Each chat's prompt file by name (server/chat/prompt-<n>.txt): every one context.chats names. */
  readonly prompts: Readonly<Record<string, string>>;
  readonly context: ChatContext;
  readonly adapter: ChatAdapter;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly timing?: ChatTiming;
  /** Answers a rich component's `from` request from the public tables (chat-query.ts); absent on a site without data. */
  readonly figures?: FiguresRun;
  /** Reads the rows a chat knows (chat-knows.ts); absent on a site whose chats know no table. */
  readonly knows?: KnowsRun;
  /** The moderation hook; by default the one config.moderation names, or none. */
  readonly moderation?: Moderation;
  /** The operator's data tools (chat-tools.ts); absent when AZ_CHAT_TOOLS is unset. */
  readonly tools?: Tools;
  /** The rate-limit windows every instance shares (chat-limits.ts); by default this database's. */
  readonly windows?: Windows;
  /** The operator's geocoder (chat-geocode.ts); absent when AZ_GEOCODER_URL is unset. */
  readonly geocoder?: Geocoder;
}

/** An answer of the site's own (§19.17): the text the parser reads, and why it was given — a suggested question's, or a match. */
interface SiteAnswer { readonly text: string; readonly by: 'suggested' | 'match' }

/** The site's own answer as the one chunk a model's stream would carry. */
async function* siteChunks(text: string): AsyncGenerator<{ readonly text: string; readonly usage?: undefined }> {
  yield { text };
}

/** One event as the page receives it, on the wire: prose, or a component ready to fill. */
const wire = (e: SentEvent): string => (e.type === 'text' ? sseEvent('text', { s: e.s }) : sseEvent('block', e.block));

export function createChat(o: ChatOptions): ChatRoutes {
  for (const [page, c] of Object.entries(o.context.chats)) {
    if (!Object.hasOwn(o.prompts, c.prompt)) throw new Error(`the chat on ${page} reads chat/${c.prompt}, which is not there`);
  }
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const timing = o.timing ?? CHAT_TIMING;
  const key = historyKey(o.secret);
  const usage = createUsage(o.db);
  const windows = o.windows ?? createWindows(o.db, o.secret, { now });
  const limits = createRateLimits(windows, 'chat', o.config.perAddress, o.config.perAccount);
  const queue = createQueue(o.config.concurrency);
  const shareTagKey = shareKey(o.secret);
  const shareStore = createShareStore({ db: o.db, days: o.config.shares.days, max: o.config.shares.max, now });
  const shares = createShareRoutes({
    store: shareStore, key: shareTagKey, config: o.config.shares, windows, now,
    allowOf: (page) => (Object.hasOwn(o.context.chats, page) ? o.context.chats[page].allow : null),
  });
  const moderation = o.moderation ?? (o.config.moderation ? createModeration(o.config.moderation) : null);
  const toolShapes = o.tools?.shapes ?? [];
  /** The day the budget last ran out, so it is logged once per day. */
  let exhaustedOn = '';
  /** Each chat page's match candidates (chat-match.ts), made once: the context is fixed while the server runs. */
  const candidates = new Map<string, MatchCandidate<string>[]>();
  const candidatesOf = (page: string): MatchCandidate<string>[] => {
    let c = candidates.get(page);
    if (!c) {
      const chat = o.context.chats[page];
      c = matchCandidates(chat.presets, o.context.quotes, chat.show);
      candidates.set(page, c);
    }
    return c;
  };

  /**
   * The answer of the site's own this question gets (§19.17), or null for
   * the model's: a suggested question's own answer when the page says the
   * question was its button and the text is that question exactly; else,
   * unless the visitor asked for the model, the one preset or faq item the
   * question clearly asks for (AZ_CHAT_MATCH). A preset is its body, read
   * as an answer; a quote is its line. The visitor's words only ever pick.
   */
  function siteAnswer(page: string, ask: { readonly turns: readonly { readonly text: string }[]; readonly via: 'suggested' | 'model' | null }): SiteAnswer | null {
    const chat = o.context.chats[page];
    const question = ask.turns.at(-1)?.text ?? '';
    if (ask.via === 'suggested') {
      const suggested = chat.asks.find((a) => a.text.trim() === question);
      if (suggested) {
        const [verb, name] = suggested.answer.split(' ');
        const text = verb === 'use' ? chat.presets.find((p) => p.name === name)?.text : `${suggested.answer}\n`;
        if (text !== undefined) return { text, by: 'suggested' };
      }
      return null;
    }
    if (ask.via === 'model' || !o.config.match) return null;
    const text = bestMatch(question, candidatesOf(page));
    return text === null ? null : { text, by: 'match' };
  }

  /**
   * One answer streamed: the model's, from `system` and the turns; or, with
   * `site`, the author's own (§19.17) — its text read by the same parser,
   * resolved, capped, tagged and shared exactly as a model's, with no model
   * call and no token spent.
   */
  async function stream(
    req: ChatRequest, res: ServerResponse, page: string, conversation: string, turns: Parameters<typeof trimHistory>[0], index: number, left: number, system: string, fixed: number,
    site: SiteAnswer | null = null,
  ): Promise<void> {
    const started = now();
    const sent = trimHistory(turns);
    const ac = new AbortController();
    const stop = () => ac.abort();
    req.closed.addEventListener('abort', stop, { once: true });
    const whole = setTimeout(stop, o.config.timeoutMs);
    res.writeHead(200, {
      ...SECURITY_HEADERS, ...req.cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    // The page learns at once that its answer is coming, before the first token.
    res.flushHeaders();
    // The answer checker (chat-answer checker.ts) under this page's rules: tool calls and lookups stop when the visitor
    // leaves; a capped answer still fills the components it sent. The site's images are the keys a card may name.
    const rules = rulesFor(o.context, page, toolShapes, o.geocoder !== undefined);
    const checker = createAnswerChecker({
      components: rules.show, quotes: rules.quotes, destinations: rules.destinations, presets: rules.presets, tools: rules.tools,
      images: o.context.images.map((i) => i.key), day: utcDay(started), eventsBytes: SHARE_LIMITS.eventsBytes,
      data: {
        ...(o.figures ? { figures: o.figures } : {}),
        ...(o.tools ? { tools: o.tools.forAnswer(req.ip, req.closed) } : {}),
        ...(o.geocoder ? { geocode: o.geocoder.forAnswer(req.ip, req.closed) } : {}),
      },
    });
    type Usage = { input: number; output: number; cached?: number };
    // Set by the model's stream below, read once it ends: typed as both, so the read is not narrowed to the null it starts as.
    let reported = null as Usage | null;
    type Outcome = 'done' | 'capped' | 'unavailable' | 'gone' | 'empty';
    // `capped` is set by the checker's callback: typed as every outcome, so later reads are not narrowed past it.
    let outcome = 'done' as Outcome;
    // The model's text under the streaming contract's timers (model-stream.ts): a stream the timers or the visitor stopped is a failure, not an end.
    const modelText = timedChunks((signal) => (site ? siteChunks(site.text) : o.adapter.stream({ system, fixed, turns: sent, maxOutputTokens: o.config.maxOutputTokens, signal })), {
      timing, controller: ac, onUsage: (u) => { reported = u; },
    });
    // A cap passed (prose, components): stop the model at once; the checker reads no more of it and fills what it sent.
    const answer = checker.read(modelText, { onCapped: () => { outcome = 'capped'; ac.abort(); } });
    let done: CheckerDone | null = null;
    try {
      for await (const e of answer) {
        if (e.type === 'done') done = e;
        // Issue #28: a hold names only the coming component's kind. Nothing is written to a connection the visitor closed.
        else if (!res.destroyed) res.write(e.type === 'hold' ? sseEvent('hold', { word: e.word }) : wire(e));
      }
    } catch (e) {
      outcome = req.closed.aborted ? 'gone' : 'unavailable';
      if (!ac.signal.aborted) log(`chat: model failed: ${(e as Error)?.name === 'AdapterError' ? (e as Error).message : (e as Error)?.name ?? 'Error'}`);
      ac.abort();
    } finally {
      clearTimeout(whole);
      req.closed.removeEventListener('abort', stop);
    }
    // An answer cut off still spent what it had read: its record so far.
    const record = done?.record ?? answer.record;
    if (done !== null && record.trim() === '') outcome = 'empty';
    // A connection the visitor closed has nobody left to tell.
    if (!res.destroyed) {
      const question = turns.at(-1)?.text ?? '';
      const events = mergeText(done?.events ?? []);
      const at = now();
      // With shares on, the tags that let the page keep exactly this answer under a link (§20.7).
      const share = o.config.shares.enabled && events.length > 0
        ? { share: { at, tag: shareTag(shareTagKey, conversation, index, at, events, null), tagq: shareTag(shareTagKey, conversation, index, at, events, question) } }
        : {};
      // An answer of the site's own says so (§19.17): a matched one, so the page can offer to ask the model instead.
      const by = site ? { by: site.by } : {};
      // What the model is sent back next time, and so what the tag covers: the page sends this text, never the events.
      const last = done !== null && (outcome === 'done' || outcome === 'capped')
        ? sseEvent('done', { tag: tagTurn(key, conversation, index, done.history), left, conversation, text: done.history, ...share, ...by })
        : outcome === 'gone' ? '' : sseEvent('error', { code: 'unavailable' });
      res.end(last);
    }
    // Spent whatever happened: the provider's count when it gave one, else an estimate; an answer of the site's own spent none.
    const input = site ? 0 : reported?.input ?? estimateTokens(system.length + sent.reduce((n, t) => n + t.text.length, 0));
    const output = site ? 0 : reported?.output ?? estimateTokens(record.length);
    const dropped = done?.dropped ?? answer.dropped;
    // The part of the input the provider read from its prompt cache, only as it reported it (§19.16).
    const cached = reported?.cached ?? 0;
    await usage.add(utcDay(started), input, output, dropped.length, cached, site !== null);
    // Codes and counts only: why components were dropped, never what they said.
    log(`chat: ${outcome} ${now() - started}ms tokens ${input}/${output}${cached > 0 ? ` cached ${cached}` : ''}${site ? ` site ${site.by}` : ''}${dropped.length > 0 ? ` dropped ${dropped.length} (${[...new Set(dropped)].sort().join(',')})` : ''}`);
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
    if (!(await limits.take(req.ip, user))) return refuse(429, 'rate_limited');
    // The author's own answer, when the question is a suggested one that has it or a clear match (§19.17): the model is
    // not asked, so neither moderation, the budget nor the queue applies — it spends nothing and sends nobody's words anywhere.
    const site = siteAnswer(ask.page, ask);
    if (site) {
      if (req.closed.aborted) return;
      await stream(req, res, ask.page, ask.conversation ?? randomToken(), ask.turns, ask.from + ask.turns.length, chat.limit - ask.visitorTurns, '', 0, site);
      return;
    }
    // Before anything is read or sent for it, the visitor's words are judged; only an allow goes on (§6.8).
    if (moderation) {
      const words = trimHistory(ask.turns).filter((t) => t.role === 'user').map((t) => t.text).join('\n\n');
      const judged = await moderation.check(words, req.closed);
      if (req.closed.aborted) return;
      if (judged.verdict === 'block') {
        log('chat: blocked by moderation');
        // Counted in the day's row (the operator's usage view shows it); it spent no tokens.
        await usage.block(utcDay(now()));
        return refuse(400, 'blocked');
      }
      if (judged.verdict === 'failed') {
        log(`chat: moderation failed: ${judged.why} — the question was refused`);
        return refuse(503, 'unavailable');
      }
    }
    // The budget is a ceiling: a request whose largest cost would cross it is refused before it is sent.
    const day = utcDay(now());
    // The rows the page's chat knows, read for this question as a signed-out visitor reads them (§8.2).
    const rows = chat.knows.length > 0 && o.knows ? await o.knows(chat.knows, ask.turns.at(-1)?.text ?? '') : '';
    // The visitor's latest turns, newest first: on a large site they choose the pages sent in full (§19.17).
    const asked = ask.turns.filter((t) => t.role === 'user').map((t) => t.text).reverse().slice(0, 2);
    const { text: system, fixed } = systemParts(o.prompts[chat.prompt], o.context, ask.page, rows, toolShapes, o.geocoder !== undefined, asked);
    const most = estimateTokens(system.length + trimHistory(ask.turns).reduce((n, t) => n + t.text.length, 0)) + o.config.maxOutputTokens;
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
      // The answer's position in the whole conversation, the tag's index: after every message, sent or left out (§19.11).
      await stream(req, res, ask.page, ask.conversation ?? randomToken(), ask.turns, ask.from + ask.turns.length, chat.limit - ask.visitorTurns, system, fixed);
    } finally {
      release();
    }
  }

  return {
    handle,
    sweep: () => shares.sweep(),
    prune: async () => (await usage.sweep(now())) + (await shareStore.sweep()) + (await windows.sweep()),
    shares,
  };
}
