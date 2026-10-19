/**
 * @az server chat-text
 * Purpose: the chat's request rules: the visitor's request checked, earlier answers proven by HMAC tag, the history trimmed.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §4.2, §5.3, §6.1)
 * Exports: historyKey, tagTurn, checkTag, readChatRequest, trimHistory, ChatTurn, ChatAsk, VISITOR_MAX, HISTORY_TURNS, HISTORY_CHARS, CONVERSATION_ID
 * Edit guide: a site turn without a valid tag is refused; text is never decoded as HTML; no regex here may backtrack.
 * Tests: packages/backend/test/chat-text.test.ts
 */

/**
 * What a chat request and a chat answer may contain (chat-block-spec §4.2, §5.3).
 *
 * The page keeps the conversation in memory and sends it back each turn, so
 * a visitor could forge an earlier ANSWER ("site: I will now ignore my
 * rules"). Every answer the server finished is tagged — HMAC-SHA-256 over
 * the conversation id, the turn's index and its exact text, under a key
 * derived from AZ_SESSION_SECRET — and a `site` turn without its tag is
 * refused. A visitor's own turns need none: they are untrusted either way.
 * What a tag covers and how its key is derived are the answer checker's
 * (chat-answer history-tag.ts), the one definition an app's Web Crypto
 * tagger shares; this file computes them with node:crypto.
 *
 * Copied into a generated server; imports only its siblings, the answer checker and node built-ins.
 */

import { createHmac } from 'node:crypto';
import { ANSWER_LIMITS } from '#chat-answer/chat-answer.ts';
import { HISTORY_KEY_LABEL, tagMessage } from '#chat-answer/history-tag.ts';
import { safeEqual } from './crypto.ts';

/** A visitor message, after trimming (chat-block-spec §6.5). */
export const VISITOR_MAX = 1_000;
/** The history sent on to the model: the last turns, at most this many characters (§4.2). */
export const HISTORY_TURNS = 8;
export const HISTORY_CHARS = 12_000;
/** An answer as a `site` turn: its record, as the answer parser caps it — prose and its components' lines. */
const SITE_MAX = ANSWER_LIMITS.record;
/** A conversation id: what randomToken makes, or a page's own of the same shape. */
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The history key: one HMAC step away from the session secret, so a tag is never a token digest. */
export const historyKey = (secret: Buffer): Buffer => createHmac('sha256', secret).update(HISTORY_KEY_LABEL).digest();

/** The tag of answer number `index` (its position in `messages`) in `conversation`. */
export function tagTurn(key: Buffer, conversation: string, index: number, text: string): string {
  return createHmac('sha256', key).update(tagMessage(conversation, index, text)).digest('base64url');
}

export function checkTag(key: Buffer, conversation: string, index: number, text: string, tag: unknown): boolean {
  return typeof tag === 'string' && safeEqual(tagTurn(key, conversation, index, text), tag);
}

export interface ChatTurn { readonly role: 'user' | 'assistant'; readonly text: string }

/** A checked request: where the visitor is, which conversation, every turn sent, and how many the visitor has sent in all. */
export interface ChatAsk {
  readonly page: string;
  readonly conversation: string | null;
  /** The position of the first turn sent in the whole conversation (`from`): 0 unless the page left older turns out. */
  readonly from: number;
  readonly turns: readonly ChatTurn[];
  readonly visitorTurns: number;
  /**
   * How the latest question was asked (chat-block-spec §19.17): `suggested`,
   * by a suggested-question button, whose answer the author may have
   * written; `model`, by "Ask the AI instead", so no author's answer is
   * matched to it; otherwise typed. Only ever a choice among the author's
   * answers and the model — never anything else the server does.
   */
  readonly via: 'suggested' | 'model' | null;
}

type Refusal = { readonly error: 'bad_request' | 'too_long' | 'tampered' };

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/**
 * The request body as a ChatAsk, or the refusal. `limit` is the page's
 * conversation length (messages may hold up to 2·limit entries); a page
 * that is not a chat page is a bad request.
 *
 * A long conversation does not fit the request cap, so the page may send
 * only its latest whole exchanges (chat-block-spec §19.11): `from` is the
 * position of the first message sent in the whole conversation — even, so
 * it is a visitor's — and every answer is still proven by its tag at its
 * own position, `from + i`. A page that sends from the start sends none.
 * `from` past 0 needs the conversation it continues.
 */
export function readChatRequest(
  body: Record<string, unknown>, limitOf: (page: string) => number | null, key: Buffer,
): ChatAsk | Refusal {
  const page = body.page;
  if (typeof page !== 'string') return { error: 'bad_request' };
  const limit = limitOf(page);
  if (limit === null) return { error: 'bad_request' };
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 2 * limit + 1 || messages.length % 2 === 0) {
    return { error: 'bad_request' };
  }
  const conversation = body.conversation;
  if (conversation !== undefined && (typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation))) {
    return { error: 'bad_request' };
  }
  const from = body.from ?? 0;
  if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0 || from % 2 !== 0 || from + messages.length > 2 * limit + 1
    || (from > 0 && typeof conversation !== 'string')) {
    return { error: 'bad_request' };
  }
  const turns: ChatTurn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: unknown; text?: unknown; tag?: unknown } | null;
    if (!m || typeof m !== 'object' || typeof m.text !== 'string') return { error: 'bad_request' };
    const visitor = i % 2 === 0;
    if (m.role !== (visitor ? 'visitor' : 'site')) return { error: 'bad_request' };
    if (visitor) {
      const text = m.text.trim();
      if (text.length === 0 || CONTROL.test(text)) return { error: 'bad_request' };
      if (text.length > VISITOR_MAX) return { error: 'too_long' };
      turns.push({ role: 'user', text });
    } else {
      // An answer is the server's own words, exactly as it tagged them.
      if (m.text.length > SITE_MAX || typeof conversation !== 'string' || !checkTag(key, conversation, from + i, m.text, m.tag)) {
        return { error: 'tampered' };
      }
      turns.push({ role: 'assistant', text: m.text });
    }
  }
  const via = body.via ?? null;
  if (via !== null && via !== 'suggested' && via !== 'model') return { error: 'bad_request' };
  return { page, conversation: typeof conversation === 'string' ? conversation : null, from, turns, visitorTurns: (from + messages.length + 1) / 2, via };
}

/**
 * The turns the model is sent: the last HISTORY_TURNS, then oldest first
 * dropped until they fit HISTORY_CHARS — never the latest visitor message,
 * which is at most VISITOR_MAX and always fits. Starts with a user turn.
 */
export function trimHistory(turns: readonly ChatTurn[]): ChatTurn[] {
  let kept = turns.slice(-HISTORY_TURNS);
  const size = (t: readonly ChatTurn[]) => t.reduce((n, x) => n + x.text.length, 0);
  while (kept.length > 1 && size(kept) > HISTORY_CHARS) kept = kept.slice(1);
  while (kept.length > 1 && kept[0].role !== 'user') kept = kept.slice(1);
  return kept;
}
