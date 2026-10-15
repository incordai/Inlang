/**
 * @az runtime chat-logic
 * Purpose: the chat runtime's pure rules: the shell's config, the event-stream reader, a visitor's text, finished sentences, fixed copy.
 * Spec: docs/chat-block-spec.md §4.2, §5.4, §7, §9
 * Exports: ChatConfig, ChatEvent, ChatTurn, parseChatConfig, createEventReader, visitorText, finishedSentences, problemCopy, leftCopy, RETRYABLE, CHAT_TEXT, EVENT_LINE_MAX, ANSWER_MAX
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
}

/** One event of the answer stream; anything else is dropped. */
export type ChatEvent =
  | { readonly type: 'text'; readonly s: string }
  | { readonly type: 'done'; readonly tag: string; readonly left: number; readonly conversation: string }
  | { readonly type: 'error'; readonly code: string };

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
  return { page: c.page, allow: c.allow, limit: c.limit, signin: c.signin };
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
  if (name === 'done') {
    const ok = typeof d.tag === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(d.tag)
      && typeof d.conversation === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(d.conversation)
      && typeof d.left === 'number' && Number.isInteger(d.left) && d.left >= 0;
    return ok ? { type: 'done', tag: d.tag as string, left: d.left as number, conversation: d.conversation as string } : null;
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
