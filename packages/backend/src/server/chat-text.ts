/**
 * @az server chat-text
 * Purpose: the chat's text rules: model output made inert prose, the visitor's request checked, earlier answers proven by HMAC tag.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §4.2, §5.3, §6.1)
 * Exports: cleanText, historyKey, tagTurn, checkTag, readChatRequest, trimHistory, ChatTurn, ChatAsk, VISITOR_MAX, HISTORY_TURNS, HISTORY_CHARS, CONVERSATION_ID
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
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.ts';

/** A visitor message, after trimming (chat-block-spec §6.5). */
export const VISITOR_MAX = 1_000;
/** The history sent on to the model: the last turns, at most this many characters (§4.2). */
export const HISTORY_TURNS = 8;
export const HISTORY_CHARS = 12_000;
/** An answer as a `site` turn: the most prose one answer may hold, with room for nothing else. */
const SITE_MAX = 4_000;
/** A conversation id: what randomToken makes, or a page's own of the same shape. */
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Characters that never reach the page from a model: C0/C1 controls except
 * \n, bidirectional embeddings, overrides and isolates, and zero-width
 * characters (a hidden instruction or a reordered route, chat-block-spec §6.1).
 */
const STRIPPED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Model text as inert prose: stripped and NFC-normalised. Entities stay as written — nothing is decoded. */
export function cleanText(text: string): string {
  return text.replace(STRIPPED, '').normalize('NFC');
}

/** The history key: one HMAC step away from the session secret, so a tag is never a token digest. */
export const historyKey = (secret: Buffer): Buffer => createHmac('sha256', secret).update('az-chat-history-v1').digest();

/** The tag of answer number `index` (its position in `messages`) in `conversation`. */
export function tagTurn(key: Buffer, conversation: string, index: number, text: string): string {
  return createHmac('sha256', key).update(`${conversation}\n${index}\n${text}`).digest('base64url');
}

export function checkTag(key: Buffer, conversation: string, index: number, text: string, tag: unknown): boolean {
  return typeof tag === 'string' && safeEqual(tagTurn(key, conversation, index, text), tag);
}

export interface ChatTurn { readonly role: 'user' | 'assistant'; readonly text: string }

/** A checked request: where the visitor is, which conversation, every turn, and how many the visitor has sent. */
export interface ChatAsk {
  readonly page: string;
  readonly conversation: string | null;
  readonly turns: readonly ChatTurn[];
  readonly visitorTurns: number;
}

type Refusal = { readonly error: 'bad_request' | 'too_long' | 'tampered' };

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/**
 * The request body as a ChatAsk, or the refusal. `limit` is the page's
 * conversation length (messages may hold up to 2·limit entries); a page
 * that is not a chat page is a bad request.
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
      if (m.text.length > SITE_MAX || typeof conversation !== 'string' || !checkTag(key, conversation, i, m.text, m.tag)) {
        return { error: 'tampered' };
      }
      turns.push({ role: 'assistant', text: m.text });
    }
  }
  return { page, conversation: typeof conversation === 'string' ? conversation : null, turns, visitorTurns: (messages.length + 1) / 2 };
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
