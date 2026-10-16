/**
 * @az runtime chat-logic
 * Purpose: the chat runtime's pure rules: the shell's config, the event-stream reader, a visitor's text, finished sentences, fixed copy.
 * Spec: docs/chat-block-spec.md §4.2, §5.4, §7, §9
 * Exports: ChatConfig, ChatEvent, ChatBlock, ChatWord, ChatTurn, ShareTags, parseChatConfig, atEnd, floatPreset, END_SLACK_PX, createEventReader, linkKind, allowedDestination, blockCopy, visitorText, finishedSentences, problemCopy, leftCopy, mergeText, readShareLink, shareProblem, SHARED_PATH, SHARE_TEXT, RETRYABLE, CHAT_TEXT, CHAT_WORDS, RICH_BLOCKS, blockOf, BLOCK_LIMITS, EVENT_LINE_MAX, ANSWER_MAX
 * Edit guide: no DOM here; every event is checked against its closed shape and an unknown one is dropped, never guessed at.
 * Tests: packages/overlay/test/chat.test.ts
 */

/**
 * The page never parses what a model wrote: the server does, and sends a
 * CLOSED set of small events (chat-block-spec §4.2). This module reads
 * them — server-sent-event framing over a `fetch` body, because
 * `EventSource` can neither POST nor send the CSRF header — and checks each
 * against its shape: an unknown event, an unknown key's absence of a known
 * one, a wrong type, is dropped. Prose is only ever handed back as a string
 * for `textContent`.
 */

/** What the shell's `data-az-chat` holds (the chat word's config()). */
export interface ChatConfig {
  readonly page: string;
  readonly allow: 'signedin' | 'anyone';
  readonly limit: number;
  readonly signin: string | null;
  /** The components an answer may hold (`show`); empty, answers are prose only. */
  readonly show: readonly ChatWord[];
  /** The destinations an answer's call to action may use — the .az file's own (chat-block-spec §6.2). */
  readonly to: readonly string[];
  /** The build's shared-answer page (§20.7): shows one stored answer, read-only. */
  readonly shared: boolean;
  /** A float (§3.2): below this viewport width it opens as a sheet, at or above it as a side panel; null for a panel. */
  readonly narrow: number | null;
}

/**
 * How near the end of the transcript still counts as at its end (§9): a
 * rounding pixel or a line's leading must not stop it following. One line of
 * body text, in CSS pixels.
 */
export const END_SLACK_PX = 24;

/** The transcript is scrolled to its end — the visitor is reading the newest words (§9). */
export const atEnd = (scrollTop: number, scrollHeight: number, clientHeight: number): boolean =>
  scrollHeight - scrollTop - clientHeight <= END_SLACK_PX;

/**
 * The overlay preset a float opens as at this viewport width (chat-block-spec
 * §3.2): the bottom `sheet` below the float's narrow width — modal, focus
 * trapped, the page locked (overlays-spec §2) — and above it a side panel,
 * the `dropdown` policy's non-modal kind, whose focus returns but is not held.
 */
export const floatPreset = (width: number, narrow: number): 'sheet' | 'dropdown' => (width < narrow ? 'sheet' : 'dropdown');

/** The closed list `show` takes. */
export const CHAT_WORDS = ['pricing', 'faq', 'cta', 'feature', 'chart', 'table', 'stats', 'cards', 'dashboard'] as const;

/** The block keys of the rich components (§20) and their note, drawn by chat-draw.ts after its own checks. */
export const RICH_BLOCKS: readonly string[] = ['chart', 'table', 'stats', 'cards', 'dashboard', 'unavailable'];
export type ChatWord = (typeof CHAT_WORDS)[number];

/** One component of an answer, as the server validated it — and as this module validates it again. */
export type ChatBlock =
  | { readonly kind: 'quote'; readonly route: string; readonly n: number }
  | { readonly kind: 'faq'; readonly items: readonly { readonly q: string; readonly a: string }[] }
  | { readonly kind: 'cta'; readonly label: string; readonly to: string }
  | { readonly kind: 'feature'; readonly items: readonly { readonly title: string; readonly text: string }[] }
  | { readonly kind: 'rich'; readonly word: string; readonly data: unknown };

/** The share tags a finished answer carries when the server makes share links (§20.7). */
export interface ShareTags { readonly at: number; readonly tag: string; readonly tagq: string }

/** One event of the answer stream; anything else is dropped. */
export type ChatEvent =
  | { readonly type: 'text'; readonly s: string }
  | { readonly type: 'block'; readonly block: ChatBlock; readonly raw: Record<string, unknown> }
  | { readonly type: 'done'; readonly tag: string; readonly left: number; readonly conversation: string; readonly text: string; readonly share: ShareTags | null }
  | { readonly type: 'error'; readonly code: string };

/**
 * The caps a component's values keep (the server's answer parser holds the
 * same, chat-block-spec §5.3): one past them is not a component the server
 * sends, so it is dropped.
 */
export const BLOCK_LIMITS = { items: 6, question: 160, answer: 600, title: 80, text: 300, label: 40, record: 12_000 } as const;

/** One turn as the request carries it; a site turn carries its server tag. */
export interface ChatTurn {
  readonly role: 'visitor' | 'site';
  readonly text: string;
  readonly tag?: string;
}

/** A line of the stream longer than this is not one the server writes: the stream is broken. */
export const EVENT_LINE_MAX = 64 * 1024;

/** The most answer text one stream may add (the server caps prose at 4 000 characters). */
export const ANSWER_MAX = 20_000;

/** chat-block-spec §4.2: a visitor message, trimmed, is 1–1 000 characters. */
const VISITOR_MAX = 1000;

/** The panel's fixed copy (§7): never server text. */
export const CHAT_TEXT = {
  signin: 'Sign in to ask a question.',
  full: 'This chat is full — start a new chat to ask more.',
  stopped: 'Stopped.',
  answered: 'Answer finished.',
  /** The name an answer holding components takes when it becomes a stop in the Tab order (§9). */
  region: 'Answer',
  tooLong: `Keep your question under ${VISITOR_MAX.toLocaleString('en-US')} characters.`,
} as const;

/** One fixed line per refusal or failure (§7); an unknown code reads as the generic one. */
const PROBLEMS: Readonly<Record<string, string>> = {
  signin_required: CHAT_TEXT.signin,
  rate_limited: 'You have asked a lot of questions — try again later.',
  budget_exhausted: 'Chat has answered all it can for today — try again tomorrow.',
  disabled: 'Chat is not available right now.',
  busy: 'Chat is busy — try again in a moment.',
  unavailable: 'The answer could not be finished — try again.',
  /** The site's moderation hook refused the question (chat-block-spec §6.8). */
  blocked: 'This question can\u2019t be answered here — try asking it another way.',
  too_long: CHAT_TEXT.tooLong,
  conversation_full: CHAT_TEXT.full,
  unknown: 'Something went wrong — start a new chat.',
};

export const problemCopy = (code: string): string => (Object.hasOwn(PROBLEMS, code) ? PROBLEMS[code] : PROBLEMS.unknown);

/** The codes a visitor may simply try again after. */
export const RETRYABLE: ReadonlySet<string> = new Set(['unavailable', 'busy']);

/** What the note says once an answer is done: nothing until the conversation is nearly full. */
export function leftCopy(left: number): string {
  if (left <= 0) return CHAT_TEXT.full;
  if (left > 3) return '';
  return left === 1 ? '1 question left in this chat.' : `${left} questions left in this chat.`;
}

const isRoute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v.length <= 2048;

/** Anything a browser would read past: space, controls, a backslash (which a URL parser turns into a slash). */
const UNSAFE = /[\s\u0000-\u001F\u007F\\]/;

/**
 * How a destination is followed, which picks the call-to-action template it
 * fills: `route`, `https`, `mailto` or `tel` — or null for anything else
 * (another scheme, a protocol-relative `//host`, a stray character). The
 * chat word groups its templates by the same rule.
 */
export function linkKind(to: string): 'route' | 'https' | 'mailto' | 'tel' | null {
  if (to.length === 0 || to.length > 2048 || UNSAFE.test(to)) return null;
  if (to.startsWith('/')) return to.startsWith('//') ? null : 'route';
  const colon = to.indexOf(':');
  const scheme = colon > 0 ? to.slice(0, colon) : '';
  if (scheme === 'https') return to.startsWith('https://') && to.length > 'https://'.length ? 'https' : null;
  if (scheme === 'mailto' || scheme === 'tel') return to.length > colon + 1 ? scheme : null;
  return null;
}

/** Whether an answer may point at `to`: exactly one of the shell's own destinations, of a kind the page can follow. */
export const allowedDestination = (config: ChatConfig, to: string): boolean => linkKind(to) !== null && config.to.includes(to);

/** The shell's config, or null when it is not one the chat word wrote. */
export function parseChatConfig(raw: string | null): ChatConfig | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (!isRoute(c.page)) return null;
  if (c.allow !== 'signedin' && c.allow !== 'anyone') return null;
  if (typeof c.limit !== 'number' || !Number.isInteger(c.limit) || c.limit < 1 || c.limit > 50) return null;
  if (c.signin !== null && !isRoute(c.signin)) return null;
  // A prose-only chat writes neither; a listed one writes both.
  const show = c.show ?? [];
  const to = c.to ?? [];
  if (!Array.isArray(show) || !show.every((w) => (CHAT_WORDS as readonly unknown[]).includes(w)) || new Set(show).size !== show.length) return null;
  if (!Array.isArray(to) || !to.every((d) => typeof d === 'string' && linkKind(d) !== null)) return null;
  if (c.shared !== undefined && c.shared !== true) return null;
  if (c.narrow !== undefined && !(typeof c.narrow === 'number' && Number.isInteger(c.narrow) && c.narrow > 0 && c.narrow <= 10_000)) return null;
  return {
    page: c.page, allow: c.allow, limit: c.limit, signin: c.signin, show: show as ChatWord[], to: to as string[], shared: c.shared === true,
    narrow: typeof c.narrow === 'number' ? c.narrow : null,
  };
}

/** A string within `max` characters (and at least one when required). */
const text = (v: unknown, max: number, required = true): v is string =>
  typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0);

/** An object with exactly these keys — a key the server never sends drops the component. */
const exactly = (v: unknown, keys: readonly string[]): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v as object, k));

/** A list of 1–BLOCK_LIMITS.items objects of exactly `keys`. */
const items = (v: unknown, keys: readonly string[]): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= BLOCK_LIMITS.items && v.every((x) => exactly(x, keys));

/** A `block` event's data, checked against the closed shapes of chat-block-spec §4.2; anything else is null. */
function toBlock(d: Record<string, unknown>): ChatBlock | null {
  const L = BLOCK_LIMITS;
  if (exactly(d, ['quote', 'route', 'n'])) {
    const ok = d.quote === 'pricing' && isRoute(d.route) && typeof d.n === 'number' && Number.isInteger(d.n) && d.n >= 0 && d.n < 1000;
    return ok ? { kind: 'quote', route: d.route as string, n: d.n as number } : null;
  }
  if (exactly(d, ['faq'])) {
    const list = d.faq;
    if (!items(list, ['q', 'a']) || !list.every((i) => text(i.q, L.question) && text(i.a, L.answer))) return null;
    return { kind: 'faq', items: list.map((i) => ({ q: i.q as string, a: i.a as string })) };
  }
  if (exactly(d, ['cta'])) {
    const c = d.cta as Record<string, unknown>;
    if (!exactly(c, ['label', 'to']) || !text(c.label, L.label) || typeof c.to !== 'string' || linkKind(c.to) === null) return null;
    return { kind: 'cta', label: c.label, to: c.to };
  }
  if (exactly(d, ['feature'])) {
    const list = d.feature;
    if (!items(list, ['title', 'text']) || !list.every((i) => text(i.title, L.title) && text(i.text, L.text, false))) return null;
    return { kind: 'feature', items: list.map((i) => ({ title: i.title as string, text: i.text as string })) };
  }
  // A rich component: one known key; its value is checked whole where it is drawn (chat-chart.ts, chat-figures.ts).
  const keys = Object.keys(d);
  if (keys.length === 1 && RICH_BLOCKS.includes(keys[0])) return { kind: 'rich', word: keys[0], data: d[keys[0]] };
  return null;
}

/** A shared answer's block as stored: the same closed shapes as a stream's (§20.7). */
export const blockOf = (d: Record<string, unknown>): ChatBlock | null => toBlock(d);

/**
 * An answer's events as the share tag covers them (server chat-share.ts
 * mergeText): consecutive text joined, the rest as received, in order.
 */
export function mergeText(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === 'text' && last?.type === 'text' && typeof e.s === 'string' && typeof last.s === 'string') out[out.length - 1] = { type: 'text', s: last.s + e.s };
    else out.push(e);
  }
  return out;
}

/** What the status region says for a component: once, as a summary (§9). */
export function blockCopy(block: ChatBlock, plans = 0): string {
  switch (block.kind) {
    case 'quote': return plans > 0 ? `Pricing table, ${plans === 1 ? '1 plan' : `${plans} plans`}.` : 'Pricing table.';
    case 'faq': return block.items.length === 1 ? '1 question and answer.' : `${block.items.length} questions and answers.`;
    case 'cta': return `Link: ${block.label}.`;
    case 'feature': return block.items.length === 1 ? 'A list of 1 item.' : `A list of ${block.items.length} items.`;
    case 'rich': return '';
  }
}

/** Control characters a visitor's text may not carry (a newline it may). */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

/** A visitor's question as it is sent: trimmed, without control characters, or null when empty or too long. */
export function visitorText(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  if (text === '' || text.length > VISITOR_MAX) return null;
  return text;
}

/** One event from its name and data, checked against its closed shape. */
function toEvent(name: string, data: string): ChatEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (name === 'text') return typeof d.s === 'string' ? { type: 'text', s: d.s } : null;
  if (name === 'block') {
    const block = toBlock(d);
    return block ? { type: 'block', block, raw: d } : null;
  }
  if (name === 'done') {
    const ok = typeof d.tag === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(d.tag)
      && typeof d.conversation === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(d.conversation)
      && typeof d.left === 'number' && Number.isInteger(d.left) && d.left >= 0
      // The answer as it is sent back as history: the server's record, tagged.
      && typeof d.text === 'string' && d.text.length <= BLOCK_LIMITS.record;
    const s = d.share as Record<string, unknown> | undefined;
    const tag = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
    const share = s && typeof s === 'object' && Number.isSafeInteger(s.at) && tag(s.tag) && tag(s.tagq)
      ? { at: s.at as number, tag: s.tag as string, tagq: s.tagq as string } : null;
    return ok ? { type: 'done', tag: d.tag as string, left: d.left as number, conversation: d.conversation as string, text: d.text as string, share } : null;
  }
  if (name === 'error') return typeof d.code === 'string' && /^[a-z_]{1,40}$/.test(d.code) ? { type: 'error', code: d.code } : null;
  return null;
}

/**
 * The event-stream reader: text in as it arrives, events out as they
 * complete. A line is complete at CR, LF or CRLF; an event at a blank line.
 * `data:` lines join with a newline; comments (`:`) and unknown fields are
 * skipped. `broken` is set, and nothing more is read, when a line passes
 * EVENT_LINE_MAX — a stream the server would never write.
 */
export function createEventReader(): { push(text: string): ChatEvent[]; end(): ChatEvent[]; readonly broken: boolean } {
  let pending = '';
  let name = '';
  let data: string[] = [];
  let broken = false;
  let lastCR = false;

  const line = (l: string, out: ChatEvent[]) => {
    if (l === '') {
      if (data.length > 0) {
        const e = toEvent(name || 'message', data.join('\n'));
        if (e) out.push(e);
      }
      name = '';
      data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  };

  return {
    get broken() { return broken; },
    push(text: string): ChatEvent[] {
      const out: ChatEvent[] = [];
      if (broken) return out;
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        // The LF of a CRLF, even when the CR ended the previous chunk.
        if (ch === '\n' && lastCR) { lastCR = false; start = i + 1; continue; }
        lastCR = false;
        if (ch !== '\n' && ch !== '\r') continue;
        const whole = pending + text.slice(start, i);
        pending = '';
        start = i + 1;
        lastCR = ch === '\r';
        if (whole.length > EVENT_LINE_MAX) { broken = true; return out; }
        line(whole, out);
      }
      pending += text.slice(start);
      if (pending.length > EVENT_LINE_MAX) {
        broken = true;
        pending = '';
      }
      return out;
    },
    end(): ChatEvent[] {
      const out: ChatEvent[] = [];
      if (!broken && pending !== '') line(pending, out);
      pending = '';
      line('', out);
      return out;
    },
  };
}

/**
 * The sentences of `text` finished since `from`: up to and including the
 * last sentence end (. ! ? or a paragraph break, followed by space or the
 * end of a paragraph) — what the status region is given, so a screen reader
 * hears whole sentences, never tokens (§9). `next` is where the unread part
 * starts. `all` takes the rest too, at the end of an answer.
 */
export function finishedSentences(text: string, from: number, all = false): { readonly said: string; readonly next: number } {
  if (all) return { said: text.slice(from).trim(), next: text.length };
  let end = -1;
  for (let i = from; i < text.length - 1; i++) {
    const ch = text[i];
    if ((ch === '.' || ch === '!' || ch === '?' || ch === '\n') && /\s/.test(text[i + 1])) end = i + 1;
  }
  if (end < 0) return { said: '', next: from };
  return { said: text.slice(from, end).trim(), next: end };
}

/* ---- share links (chat-block-spec §20.7) ---- */

/** The build's shared-answer page (core chat.ts SHARED_ROUTE). */
export const SHARED_PATH = '/chat/shared';

export const SHARE_TEXT = {
  made: (until: string) => `This link works until ${until}. Anyone with it can see this answer.`,
  working: 'Making the link…',
  expired: 'This link has expired or was deleted.',
  deleted: 'This shared answer is deleted.',
  loading: 'Loading the shared answer…',
  until: (date: string) => `This link works until ${date}.`,
} as const;

const SHARE_PROBLEMS: Readonly<Record<string, string>> = {
  rate_limited: 'You have shared a lot — try again later.',
  shares_full: 'Sharing is full right now — try again later.',
  disabled: 'Sharing is off on this site.',
  signin_required: 'Sign in to share.',
  tampered: 'This answer can no longer be shared — ask again to share a new one.',
  too_large: 'This answer is too large to share.',
};
/** One fixed line per refusal; never server text. */
export const shareProblem = (code: string): string => (Object.hasOwn(SHARE_PROBLEMS, code) ? SHARE_PROBLEMS[code] : 'The link could not be made — try again.');

/** A share link's id, and the delete token when it is the delete link — or null when the fragment is neither. */
export function readShareLink(hash: string): { id: string; token: string | null } | null {
  const m = /^#([A-Za-z0-9_-]{22})(?:&([A-Za-z0-9_-]{43}))?$/.exec(hash);
  return m ? { id: m[1], token: m[2] ?? null } : null;
}
