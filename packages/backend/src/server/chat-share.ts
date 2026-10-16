/**
 * @az server chat-share
 * Purpose: one answer kept under a link, only when its visitor presses Share — the tag that proves it is a real answer, the store, expiry and delete.
 * Spec: docs/chat-block-spec.md §20.7
 * Exports: SHARE_LIMITS, ShareStore, StoredShare, ShareRoutes, ShareRoutesOptions, shareKey, shareTag, checkShareTag, mergeText, newShareId,
 *   isShareId, createShareStore, createShareRoutes, shareableEvents
 * Edit guide: store only events this server tagged (the tag covers every event, the turn and the time); keep no person —
 *   no address, account or agent column. An expired, unknown or wrongly-tokened share is answered exactly like a missing one.
 * Tests: packages/backend/test/chat-share.test.ts
 */

/**
 * Nothing about a conversation is stored (chat-block-spec §6.7, Q6) — until
 * a visitor presses Share on one finished answer. Then the page sends back
 * that answer's events as it received them, and the share tag the `done`
 * event carried. The tag is an HMAC under a key of its own (derived from
 * AZ_SESSION_SECRET with the label `az-chat-share-v1`, so a history tag is
 * never a share tag) over the conversation, the turn, when the answer was
 * made, and a hash of every event; so a share can only ever be an answer
 * this server produced, unedited — never text someone chose to publish
 * under the site's name.
 *
 * The id is 128 random bits; the delete token 256, shown once, kept only
 * as its SHA-256. Reads and deletes compare in the statement or in constant
 * time, and answer "not found" alike for unknown, expired and wrong-token.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ChatRequest } from './app.ts';
import { ANSWER_LIMITS, ANSWER_WORDS } from './chat-answer.ts';
import { createRateLimits, DAY_MS, HOUR_MS } from './chat-limits.ts';
import { CONVERSATION_ID } from './chat-text.ts';
import type { Db } from './db.ts';
import type { ChatConfig } from './env.ts';
import { BodyError, createLimiter, send } from './http.ts';

export const SHARE_LIMITS = {
  /** The events JSON of one share, in UTF-8 bytes. */
  eventsBytes: 48 * 1024,
  /** A visitor's question, when included (chat-block-spec §4.2's message cap). */
  question: 1000,
  /** A share tag older than this is refused: share an answer the day it was given. */
  tagMaxAgeMs: 24 * 60 * 60 * 1000,
  idBytes: 16,
  tokenBytes: 32,
} as const;

const ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The share key: its own label, so no other tag under AZ_SESSION_SECRET verifies here. */
export const shareKey = (secret: Buffer): Buffer => createHmac('sha256', secret).update('az-chat-share-v1').digest();

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * An answer's events as both sides tag them: consecutive `text` events
 * merged into one, everything else as it was, in order. The page applies
 * the same rule before it sends a share, so the bytes hashed match.
 */
export function mergeText(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === 'text' && last?.type === 'text' && typeof e.s === 'string' && typeof last.s === 'string') {
      out[out.length - 1] = { type: 'text', s: last.s + e.s };
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * The tag over one answer: conversation, turn index, the time it was made,
 * a hash of its events (as JSON, in order) and — for the `shareq` tag — a
 * hash of the question it answered. Newlines separate fields none of which
 * can hold one (ids, integers, hex).
 */
export function shareTag(
  key: Buffer, conversation: string, index: number, at: number, events: readonly unknown[], question: string | null,
): string {
  const fields = ['v1', conversation, String(index), String(at), sha256(JSON.stringify(events)), question === null ? '-' : sha256(question)];
  return createHmac('sha256', key).update(fields.join('\n')).digest('base64url');
}

/** Whether `tag` is this answer's, compared in constant time. */
export function checkShareTag(
  key: Buffer, conversation: string, index: number, at: number, events: readonly unknown[], question: string | null, tag: unknown,
): boolean {
  if (typeof tag !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tag)) return false;
  const want = Buffer.from(shareTag(key, conversation, index, at, events, question));
  const got = Buffer.from(tag);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const newShareId = (): string => randomBytes(SHARE_LIMITS.idBytes).toString('base64url');
export const isShareId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

export interface StoredShare {
  readonly events: unknown[];
  readonly question: string | null;
  readonly created: number;
  readonly expires: number;
}

export interface ShareStore {
  /** Store one answer; the id, the delete token (shown once) and when it expires — or `full` past the live-share ceiling. */
  create(eventsJson: string, question: string | null): Promise<{ id: string; token: string; expires: number } | 'full'>;
  /** A live share, or null: unknown, malformed and expired alike. */
  read(id: string): Promise<StoredShare | null>;
  /** Delete with the sharer's token; false when there was nothing to delete (or the token is not its). */
  remove(id: string, token: string): Promise<boolean>;
  /** Delete every expired share; how many went. */
  sweep(): Promise<number>;
}

export interface ShareStoreOptions {
  readonly db: Db;
  /** AZ_CHAT_SHARE_DAYS. */
  readonly days: number;
  /** AZ_CHAT_SHARE_MAX: live shares at most. */
  readonly max: number;
  readonly now?: () => number;
}

export function createShareStore(o: ShareStoreOptions): ShareStore {
  const now = o.now ?? Date.now;
  const { db } = o;
  return {
    async create(eventsJson, question) {
      const at = now();
      const live = await db.get('SELECT COUNT(*) AS n FROM az_chat_shares WHERE expires > ?', [at]);
      if (Number(live?.n ?? 0) >= o.max) return 'full';
      const id = newShareId();
      const token = randomBytes(SHARE_LIMITS.tokenBytes).toString('base64url');
      const expires = at + o.days * DAY_MS;
      await db.run(
        'INSERT INTO az_chat_shares (id, events, question, created, expires, delete_hash) VALUES (?, ?, ?, ?, ?, ?)',
        [id, eventsJson, question, at, expires, sha256(token)],
      );
      return { id, token, expires };
    },
    async read(id) {
      if (!isShareId(id)) return null;
      const row = await db.get('SELECT events, question, created, expires FROM az_chat_shares WHERE id = ? AND expires > ?', [id, now()]);
      if (!row) return null;
      return {
        events: JSON.parse(String(row.events)) as unknown[],
        question: row.question === null || row.question === undefined ? null : String(row.question),
        created: Number(row.created),
        expires: Number(row.expires),
      };
    },
    async remove(id, token) {
      if (!isShareId(id) || !TOKEN.test(token)) return false;
      const row = await db.get('SELECT delete_hash FROM az_chat_shares WHERE id = ? AND expires > ?', [id, now()]);
      if (!row) return false;
      const want = Buffer.from(String(row.delete_hash).trim(), 'utf8');
      const got = Buffer.from(sha256(token), 'utf8');
      if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
      return (await db.run('DELETE FROM az_chat_shares WHERE id = ?', [id])) === 1;
    },
    sweep: () => db.run('DELETE FROM az_chat_shares WHERE expires <= ?', [now()]),
  };
}

/** The block keys an answer's events carry (chat-answer.ts AnswerBlock, chat-rich.ts resolveRich). */
const BLOCK_KEYS: ReadonlySet<string> = new Set(['quote', ...ANSWER_WORDS.filter((w) => w !== 'pricing'), 'ask', 'unavailable']);
/** Events in one answer: its components and follow-up questions (§21.1.2), and the text runs between them. */
const EVENTS_MAX = 2 * (ANSWER_LIMITS.components + ANSWER_LIMITS.asks) + 1;

/**
 * Whether `v` has the shape of an answer's events as the stream sent them:
 * text runs within the prose cap, blocks with one known key. The tag is the
 * proof they are this server's; this is the second check, so a fault in the
 * tag path still cannot store a shape the page was never sent.
 */
export function shareableEvents(v: unknown): v is Record<string, unknown>[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > EVENTS_MAX) return false;
  return v.every((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const x = e as Record<string, unknown>;
    const keys = Object.keys(x);
    if (x.type === 'text') return keys.length === 2 && typeof x.s === 'string' && x.s.length > 0 && x.s.length <= ANSWER_LIMITS.prose;
    if (x.type !== 'block' || keys.length !== 2 || !x.block || typeof x.block !== 'object' || Array.isArray(x.block)) return false;
    const bk = Object.keys(x.block);
    // A quote is `{ quote, route, n }`; every other block is one key.
    return bk.length >= 1 && BLOCK_KEYS.has(bk[0]) && (bk[0] === 'quote' || bk.length === 1);
  });
}

export interface ShareRoutes {
  /** POST /chat/share */
  create(req: ChatRequest, res: ServerResponse): Promise<void>;
  /** GET /chat/share/<id> — anyone with the link, no session needed. */
  read(id: string, req: ChatRequest, res: ServerResponse): Promise<void>;
  /** DELETE /chat/share/<id> with `{ token }`. */
  remove(id: string, req: ChatRequest, res: ServerResponse): Promise<void>;
  /** Forget old limiter keys. */
  sweep(): void;
}

export interface ShareRoutesOptions {
  readonly store: ShareStore;
  /** shareKey(AZ_SESSION_SECRET). */
  readonly key: Buffer;
  readonly config: ChatConfig['shares'];
  /** Who may chat on a chat page — the same may share from it; null for a page with no chat. */
  readonly allowOf: (page: string) => 'anyone' | 'signedin' | null;
  readonly now?: () => number;
}

/** chat-block-spec §20.7: a share body carries up to the events cap plus its fields (the DATA_BODY_LIMIT precedent). */
const SHARE_BODY_LIMIT = 64 * 1024;
const READS_PER_ADDRESS = 600;
const READ_WINDOW_MS = 10 * 60 * 1000;
const DELETES_PER_ADDRESS = 30;

export function createShareRoutes(o: ShareRoutesOptions): ShareRoutes {
  const now = o.now ?? Date.now;
  const creates = createRateLimits(o.config.perAddress, o.config.perAccount, now);
  const reads = createLimiter(READS_PER_ADDRESS, READ_WINDOW_MS, now);
  const deletes = createLimiter(DELETES_PER_ADDRESS, HOUR_MS, now);
  const refuse = (res: ServerResponse, req: ChatRequest, status: number, error: string) => send(res, status, { error }, req.cors);
  const noindex = (req: ChatRequest) => ({ ...req.cors, 'x-robots-tag': 'noindex' });

  return {
    async create(req, res) {
      if (!o.config.enabled) return refuse(res, req, 403, 'disabled');
      let body: Record<string, unknown>;
      try {
        body = await req.body(SHARE_BODY_LIMIT);
      } catch (e) {
        if (e instanceof BodyError) return refuse(res, req, 400, e.message === 'too large' ? 'too_large' : 'bad_request');
        throw e;
      }
      const { page, conversation, index, at, events, tag, question } = body;
      const allow = typeof page === 'string' ? o.allowOf(page) : null;
      if (allow === null || typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation)
        || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1
        || typeof at !== 'number' || !Number.isSafeInteger(at)
        || (question !== undefined && (typeof question !== 'string' || question.length < 1 || question.length > SHARE_LIMITS.question))) {
        return refuse(res, req, 400, 'bad_request');
      }
      const user = await req.user();
      if (allow === 'signedin' && user === null) return refuse(res, req, 401, 'signin_required');
      const json = JSON.stringify(events) ?? '';
      if (Buffer.byteLength(json, 'utf8') > SHARE_LIMITS.eventsBytes) return refuse(res, req, 400, 'too_large');
      const q = typeof question === 'string' ? question : null;
      // Only an answer this server gave, unedited, today: the tag covers every event, the turn, the time and the question.
      const fresh = at <= now() && now() - at <= SHARE_LIMITS.tagMaxAgeMs;
      if (!fresh || !shareableEvents(events) || !checkShareTag(o.key, conversation, index, at, events, q, tag)) {
        return refuse(res, req, 400, 'tampered');
      }
      if (!creates.take(req.ip, user)) return refuse(res, req, 429, 'rate_limited');
      const made = await o.store.create(json, q);
      if (made === 'full') return refuse(res, req, 429, 'shares_full');
      send(res, 201, { id: made.id, expires: made.expires, deleteToken: made.token }, req.cors);
    },
    async read(id, req, res) {
      if (!reads.take(req.ip)) return refuse(res, req, 429, 'rate_limited');
      const share = isShareId(id) ? await o.store.read(id) : null;
      // Unknown, malformed and expired alike: one answer, no oracle.
      if (!share) return send(res, 404, { error: 'not_found' }, noindex(req));
      send(res, 200, {
        events: share.events, created: share.created, expires: share.expires,
        ...(share.question !== null ? { question: share.question } : {}),
      }, noindex(req));
    },
    async remove(id, req, res) {
      if (!deletes.take(req.ip)) return refuse(res, req, 429, 'rate_limited');
      let body: Record<string, unknown>;
      try {
        body = await req.body();
      } catch (e) {
        if (e instanceof BodyError) return refuse(res, req, 400, 'bad_request');
        throw e;
      }
      const token = body.token;
      const gone = typeof token === 'string' && await o.store.remove(id, token);
      // A wrong token is answered like a missing share.
      if (!gone) return refuse(res, req, 404, 'not_found');
      send(res, 204, undefined, req.cors);
    },
    sweep() {
      creates.sweep();
      reads.sweep();
      deletes.sweep();
    },
  };
}
