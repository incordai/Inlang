/**
 * @az runtime chat-history
 * Purpose: keeps a chat's conversation in the visitor's own browser — capped, expiring, checked on the way back in, cleared on request.
 * Spec: docs/chat-block-spec.md §21.1.4, §21.1.5
 * Exports: createHistory, browserStorage, readHistory, historyKeyOf, turnsOf, HISTORY_KEY, HISTORY_LIMITS, ChatHistory, StoredChat, StoredTurn, StorageLike
 * Edit guide: storage is reached only through `browserStorage` and `access`, every call inside try/catch; a saved conversation is
 *   re-checked turn by turn when read and dropped whole on any fault; nothing here touches the DOM.
 * Tests: packages/overlay/test/chat-history.test.ts
 */

/**
 * C5 keeps the conversation in the visitor's browser (chat-block-spec
 * §21.1.4) so a reload, or the next page under a float, carries on. Nothing
 * more is stored on the server: the server still proves every earlier answer
 * by its HMAC tag (§4.2), so what is kept here is only the visitor's copy —
 * an edited one is refused (`tampered`) exactly as an edited request is.
 *
 * One key per site origin, `az-chat:v1`, holding at most HISTORY_LIMITS.chats
 * conversations in HISTORY_LIMITS.bytes of JSON, each dropped 7 days after
 * it was last saved. Private windows, blocked site data, a full quota or an
 * accessor that throws all read as "nothing kept", and the chat works as it
 * did before C5.
 */

import { BLOCK_LIMITS, blockOf, visitorText, type ChatTurn } from './chat-logic.ts';

/** The one storage key a site's chats share. */
export const HISTORY_KEY = 'az-chat:v1';

export const HISTORY_LIMITS = {
  /** The key's JSON, in UTF-16 code units (what an engine's quota counts). */
  bytes: 256 * 1024,
  /** Conversations kept; the least recently saved goes first. */
  chats: 8,
  /** A conversation is dropped this long after it was last saved. */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** A clock this far ahead of a saved time is still believed (a device's clock moved). */
  skewMs: 24 * 60 * 60 * 1000,
  /** Events of one answer: its components and follow-ups and the text between them (server chat-share.ts EVENTS_MAX). */
  events: 2 * (BLOCK_LIMITS.components + BLOCK_LIMITS.asks) + 1,
  /** Turns of one conversation: a chat's `limit` is at most 50 questions. */
  turns: 100,
  /** Characters of one answer's text events (the page's ANSWER_MAX). */
  text: 20_000,
} as const;

/** One turn as kept: the visitor's words, or an answer — its tagged record, its tag, and its events to draw it again. */
export type StoredTurn =
  | { readonly role: 'visitor'; readonly text: string }
  | { readonly role: 'site'; readonly text: string; readonly tag: string; readonly events: readonly Record<string, unknown>[] };

export interface StoredChat {
  readonly conversation: string;
  /** When it was last saved, epoch ms. */
  readonly saved: number;
  /** Whole exchanges only: visitor, site, visitor, site… */
  readonly turns: readonly StoredTurn[];
}

/** The part of the Web Storage interface this needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser's local storage, or null when there is none or it may not be
 * used: reading the property itself throws where site data is blocked.
 */
export function browserStorage(win: { readonly localStorage?: StorageLike | null } | null): StorageLike | null {
  if (!win) return null;
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

const CONVERSATION = /^[A-Za-z0-9_-]{16,64}$/;
const TAG = /^[A-Za-z0-9_-]{16,128}$/;

/** One answer's events as the stream sent them: text runs and blocks of a shape the page draws — or null. */
function eventsOf(v: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(v) || v.length > HISTORY_LIMITS.events) return null;
  let chars = 0;
  for (const e of v) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const x = e as Record<string, unknown>;
    if (x.type === 'text') {
      if (Object.keys(x).length !== 2 || typeof x.s !== 'string') return null;
      chars += x.s.length;
      if (chars > HISTORY_LIMITS.text) return null;
    } else if (x.type === 'block') {
      if (Object.keys(x).length !== 2 || !x.block || typeof x.block !== 'object' || Array.isArray(x.block)) return null;
      if (blockOf(x.block as Record<string, unknown>) === null) return null;
    } else return null;
  }
  return v as Record<string, unknown>[];
}

/** A kept conversation, checked as the server and the stream would check it — or null at the first fault. */
function chatOf(v: unknown, now: number): StoredChat | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.conversation !== 'string' || !CONVERSATION.test(c.conversation)) return null;
  if (typeof c.saved !== 'number' || !Number.isFinite(c.saved)) return null;
  if (now - c.saved > HISTORY_LIMITS.maxAgeMs || c.saved - now > HISTORY_LIMITS.skewMs) return null;
  if (!Array.isArray(c.turns) || c.turns.length === 0 || c.turns.length % 2 !== 0 || c.turns.length > HISTORY_LIMITS.turns) return null;
  const turns: StoredTurn[] = [];
  for (let i = 0; i < c.turns.length; i++) {
    const t = c.turns[i] as Record<string, unknown> | null;
    if (!t || typeof t !== 'object' || typeof t.text !== 'string') return null;
    if (i % 2 === 0) {
      if (t.role !== 'visitor' || Object.keys(t).length !== 2 || visitorText(t.text) !== t.text) return null;
      turns.push({ role: 'visitor', text: t.text });
    } else {
      if (t.role !== 'site' || Object.keys(t).length !== 4 || t.text.length > BLOCK_LIMITS.record) return null;
      if (typeof t.tag !== 'string' || !TAG.test(t.tag)) return null;
      const events = eventsOf(t.events);
      if (!events) return null;
      turns.push({ role: 'site', text: t.text, tag: t.tag, events });
    }
  }
  return { conversation: c.conversation, saved: c.saved, turns };
}

/**
 * What the key holds, read: every conversation that passes its checks, by
 * its chat's key. `stale` is set when anything stored did not — a value not
 * this shape at all, or one conversation that is expired or fails a check —
 * so the caller writes back only what passed, and the rest is never read again.
 */
export function readHistory(raw: string | null, now: number): { readonly chats: Map<string, StoredChat>; readonly stale: boolean } {
  const chats = new Map<string, StoredChat>();
  if (raw === null) return { chats, stale: false };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { chats, stale: true };
  }
  const root = v as { v?: unknown; chats?: unknown } | null;
  if (!root || typeof root !== 'object' || root.v !== 1 || !root.chats || typeof root.chats !== 'object' || Array.isArray(root.chats)) return { chats, stale: true };
  let stale = false;
  for (const [key, value] of Object.entries(root.chats)) {
    const chat = /^(?:float|panel:\/\S{0,2047})$/.test(key) ? chatOf(value, now) : null;
    if (chat) chats.set(key, chat);
    else stale = true;
  }
  return { chats, stale };
}

/** A chat's key: a float is one conversation across the site's pages, a panel its page's own. */
export const historyKeyOf = (config: { readonly page: string; readonly narrow: number | null }): string =>
  (config.narrow !== null ? 'float' : `panel:${config.page}`);

export interface ChatHistory {
  /** Storage can be read and written here: the panel offers Clear history only then. */
  readonly available: boolean;
  /** The conversation kept for `key`, checked; null when none or when it fails a check (then it is removed). */
  load(key: string): StoredChat | null;
  /** Keep `turns` for `key`, within the caps; false when nothing could be kept. */
  save(key: string, conversation: string, turns: readonly StoredTurn[]): boolean;
  /** Forget `key`'s conversation. */
  remove(key: string): void;
  /** Forget every conversation on this site. */
  clear(): void;
}

/** A stored conversation as the history a request carries: tagged answers and the visitor's words. */
export const turnsOf = (turns: readonly StoredTurn[]): ChatTurn[] =>
  turns.map((t) => (t.role === 'visitor' ? { role: 'visitor', text: t.text } : { role: 'site', text: t.text, tag: t.tag }));

/** The browser's history store, or one that keeps nothing when `storage` is null or refuses. */
export function createHistory(storage: StorageLike | null, now: () => number = Date.now): ChatHistory {
  /** The one way to storage: any throw — blocked, full, gone — is "could not". */
  const access = <T>(fn: (s: StorageLike) => T): { readonly ok: true; readonly value: T } | { readonly ok: false } => {
    if (!storage) return { ok: false };
    try {
      return { ok: true, value: fn(storage) };
    } catch {
      return { ok: false };
    }
  };
  const read = (): Map<string, StoredChat> => {
    const got = access((s) => s.getItem(HISTORY_KEY));
    if (!got.ok) return new Map();
    const { chats, stale } = readHistory(got.value, now());
    if (stale) write(chats);
    return chats;
  };
  const write = (chats: Map<string, StoredChat>): boolean => {
    if (chats.size === 0) return access((s) => s.removeItem(HISTORY_KEY)).ok;
    return access((s) => s.setItem(HISTORY_KEY, serialise(chats))).ok;
  };
  const probe = access((s) => {
    s.setItem(`${HISTORY_KEY}:probe`, '1');
    s.removeItem(`${HISTORY_KEY}:probe`);
    return true;
  });
  return {
    available: probe.ok,
    load(key) {
      return read().get(key) ?? null;
    },
    save(key, conversation, turns) {
      const chats = read();
      chats.delete(key);
      if (turns.length === 0) return write(chats);
      const mine: StoredChat = { conversation, saved: now(), turns };
      // Newest last: the oldest saved are dropped first.
      const others = [...chats.entries()].sort((a, b) => a[1].saved - b[1].saved).slice(-(HISTORY_LIMITS.chats - 1));
      const kept = new Map(others);
      kept.set(key, mine);
      while (kept.size > 1 && serialise(kept).length > HISTORY_LIMITS.bytes) kept.delete(kept.keys().next().value!);
      // Alone and still too large: its longest prefix of whole exchanges that fits — a prefix of a tagged history is still valid.
      let cut = turns.length;
      while (cut > 0 && serialise(new Map([[key, { ...mine, turns: turns.slice(0, cut) }]])).length > HISTORY_LIMITS.bytes) cut -= 2;
      if (cut === 0) { kept.delete(key); write(kept); return false; }
      if (cut < turns.length) kept.set(key, { ...mine, turns: turns.slice(0, cut) });
      if (write(kept)) return true;
      // The quota is smaller than the cap: this conversation alone, once more.
      return write(new Map([[key, kept.get(key)!]]));
    },
    remove(key) {
      const chats = read();
      if (chats.delete(key)) write(chats);
    },
    clear() {
      access((s) => s.removeItem(HISTORY_KEY));
    },
  };
}

const serialise = (chats: Map<string, StoredChat>): string => JSON.stringify({ v: 1, chats: Object.fromEntries(chats) });
