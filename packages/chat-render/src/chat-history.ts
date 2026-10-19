/**
 * @az runtime chat-history
 * Purpose: keeps a chat's conversation in the visitor's own browser — bound to who is reading, capped, expiring, kept in step across tabs, checked on the way back in, cleared on request.
 * Spec: docs/chat-block-spec.md §21.1.4, §21.1.5, §19.11
 * Exports: createHistory, browserStorage, readHistory, historyKeyOf, turnsOf, sameTurns, HISTORY_KEY, HISTORY_LIMITS, BROWSER,
 *   ChatHistory, HistoryOptions, SaveOutcome, StoredChat, StoredTurn, StorageLike
 * Edit guide: storage is reached only through `browserStorage` and `access`, every call inside try/catch; nothing is read back
 *   until bind() has said who is reading, and nothing kept for anyone else is ever returned; a save never overwrites a newer
 *   revision it did not see; a saved conversation is re-checked turn by turn when read and dropped whole on any fault; no DOM.
 * Tests: packages/chat-render/test/chat-history.test.ts
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
 *
 * Who it is kept for (§19.11). A shared browser must never show the last
 * person's chat to the next: the key is bound to whoever read the session —
 * a salted SHA-256 of the account id (`a:<hash>`; the salt is random, kept
 * beside it, so the hash names no account anywhere else), or `browser` for
 * a visitor nobody signed in. bind() is called with the session's account
 * before anything is read; when the key is bound to anyone else, everything
 * kept is removed first. So a different account, a sign-out, and a sign-in
 * over a stranger's (`allow anyone`) chat each start empty. The raw id is
 * never stored.
 *
 * Two tabs (§19.11). Every conversation carries a revision that each save
 * raises by one. A save names the revision it last saw: one that finds a
 * newer revision whose turns are not the start of its own — another tab
 * answered meanwhile — keeps nothing and says `conflict`, and one that finds
 * the conversation gone says `cleared`; the page tells the visitor either
 * way, never overwriting the other tab's turns. A tab that hears of a newer
 * revision (a `storage` event, `watches`) while it is idle draws it.
 */

import { BLOCK_LIMITS, blockOf, visitorText, type ChatTurn, type ShareTags } from './chat-logic.ts';

/** The one storage key a site's chats share. */
export const HISTORY_KEY = 'az-chat:v1';

/** The binding of a visitor nobody signed in: the browser itself. */
export const BROWSER = 'browser';

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

/**
 * One turn as kept: the visitor's words, or an answer — its tagged record,
 * its tag, its events to draw it again, and its share tags when the server
 * gave them (a restored answer can be shared while the tags last).
 */
export type StoredTurn =
  | { readonly role: 'visitor'; readonly text: string }
  | { readonly role: 'site'; readonly text: string; readonly tag: string; readonly events: readonly Record<string, unknown>[]; readonly share?: ShareTags };

export interface StoredChat {
  readonly conversation: string;
  /** When it was last saved, epoch ms. */
  readonly saved: number;
  /** Raised by one on every save, in any tab. */
  readonly rev: number;
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
const SHARE_TAG = /^[A-Za-z0-9_-]{43}$/;
const SALT = /^[A-Za-z0-9_-]{22}$/;
/** How many times bind() hashes again when another tab made the key meanwhile, before it binds to nothing. */
const BIND_ATTEMPTS = 3;
const BOUND = /^(?:browser|a:[A-Za-z0-9_-]{43})$/;

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

/** An answer's share tags as the stream sent them (chat-logic toEvent), or null. */
function shareOf(v: unknown): ShareTags | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (Object.keys(s).length !== 3 || !Number.isSafeInteger(s.at) || typeof s.tag !== 'string' || !SHARE_TAG.test(s.tag)
    || typeof s.tagq !== 'string' || !SHARE_TAG.test(s.tagq)) return null;
  return { at: s.at as number, tag: s.tag, tagq: s.tagq };
}

/** A kept conversation, checked as the server and the stream would check it — or null at the first fault. */
function chatOf(v: unknown, now: number): StoredChat | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (Object.keys(c).length !== 4) return null;
  if (typeof c.conversation !== 'string' || !CONVERSATION.test(c.conversation)) return null;
  if (typeof c.saved !== 'number' || !Number.isFinite(c.saved)) return null;
  if (now - c.saved > HISTORY_LIMITS.maxAgeMs || c.saved - now > HISTORY_LIMITS.skewMs) return null;
  if (typeof c.rev !== 'number' || !Number.isSafeInteger(c.rev) || c.rev < 1) return null;
  if (!Array.isArray(c.turns) || c.turns.length === 0 || c.turns.length % 2 !== 0 || c.turns.length > HISTORY_LIMITS.turns) return null;
  const turns: StoredTurn[] = [];
  for (let i = 0; i < c.turns.length; i++) {
    const t = c.turns[i] as Record<string, unknown> | null;
    if (!t || typeof t !== 'object' || typeof t.text !== 'string') return null;
    if (i % 2 === 0) {
      if (t.role !== 'visitor' || Object.keys(t).length !== 2 || visitorText(t.text) !== t.text) return null;
      turns.push({ role: 'visitor', text: t.text });
    } else {
      const shared = t.share !== undefined;
      if (t.role !== 'site' || Object.keys(t).length !== (shared ? 5 : 4) || t.text.length > BLOCK_LIMITS.record) return null;
      if (typeof t.tag !== 'string' || !TAG.test(t.tag)) return null;
      const events = eventsOf(t.events);
      if (!events) return null;
      const share = shared ? shareOf(t.share) : null;
      if (shared && !share) return null;
      turns.push({ role: 'site', text: t.text, tag: t.tag, events, ...(share ? { share } : {}) });
    }
  }
  return { conversation: c.conversation, saved: c.saved, rev: c.rev, turns };
}

/** What the key holds, read. */
export interface HistoryRead {
  /** Every conversation that passed its checks, by its chat's key. */
  readonly chats: Map<string, StoredChat>;
  /** Set when anything stored did not pass: write back only what did, and the rest is never read again. */
  readonly stale: boolean;
  /** The salt the binding is hashed with, and whom the key is bound to; null when there is no valid key. */
  readonly salt: string | null;
  readonly bound: string | null;
}

/**
 * What the key holds, read: every conversation that passes its checks, by
 * its chat's key, and whom they are kept for. A value not this shape at
 * all — another version's, or no binding — is stale whole.
 */
export function readHistory(raw: string | null, now: number): HistoryRead {
  const chats = new Map<string, StoredChat>();
  const none = (stale: boolean): HistoryRead => ({ chats, stale, salt: null, bound: null });
  if (raw === null) return none(false);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return none(true);
  }
  const root = v as { v?: unknown; salt?: unknown; bound?: unknown; chats?: unknown } | null;
  if (!root || typeof root !== 'object' || root.v !== 2 || typeof root.salt !== 'string' || !SALT.test(root.salt)
    || typeof root.bound !== 'string' || !BOUND.test(root.bound)
    || !root.chats || typeof root.chats !== 'object' || Array.isArray(root.chats)) return none(true);
  let stale = false;
  for (const [key, value] of Object.entries(root.chats)) {
    const chat = /^(?:float|panel:\/\S{0,2047})$/.test(key) ? chatOf(value, now) : null;
    if (chat) chats.set(key, chat);
    else stale = true;
  }
  return { chats, stale, salt: root.salt, bound: root.bound };
}

/** A chat's key: a float is one conversation across the site's pages, a panel its page's own. */
export const historyKeyOf = (config: { readonly page: string; readonly narrow: number | null }): string =>
  (config.narrow !== null ? 'float' : `panel:${config.page}`);

/** Whether `a` is the start of `b` (or all of it): the same turns, in order, with the same tags. */
export const sameTurns = (a: readonly StoredTurn[], b: readonly StoredTurn[]): boolean =>
  a.length <= b.length && a.every((t, i) => t.role === b[i].role && t.text === b[i].text
    && (t.role === 'visitor' || (b[i].role === 'site' && t.tag === (b[i] as Extract<StoredTurn, { role: 'site' }>).tag)));

/** How a save went: kept as revision `rev`, or why nothing was kept. */
export type SaveOutcome =
  | { readonly kept: true; readonly rev: number }
  /**
   * `conflict` another tab saved turns this one has not; `cleared` another
   * tab (or a sign-out) removed what this one was continuing; `unbound` who
   * is reading is not known yet, or the key is another's; `storage` the
   * browser keeps nothing (refused, full, or one answer past the cap alone).
   */
  | { readonly kept: false; readonly why: 'conflict' | 'cleared' | 'unbound' | 'storage' };

export interface ChatHistory {
  /** Storage can be read and written here: the panel offers Clear history only then. */
  readonly available: boolean;
  /**
   * Bind to who is reading now — `subject` the account id the session read
   * gave, or null for nobody signed in (then BROWSER). Whatever is kept for
   * anyone else is removed first; true when something was. Nothing is read
   * back until this has resolved.
   */
  bind(subject: string | null): Promise<boolean>;
  /** The conversation kept for `key`, checked; null when none, when it fails a check (then it is removed), or when unbound. */
  load(key: string): StoredChat | null;
  /** Keep `turns` for `key` as the revision after `base` — the one this tab last loaded or saved, 0 for none. */
  save(key: string, conversation: string, turns: readonly StoredTurn[], base: number): SaveOutcome;
  /** Forget `key`'s conversation. */
  remove(key: string): void;
  /** Forget every conversation on this site. */
  clear(): void;
  /** Whether a `storage` event for `key` (null: the whole storage was cleared) concerns what is kept here. */
  watches(key: string | null): boolean;
}

/** A stored conversation as the history a request carries: tagged answers and the visitor's words. */
export const turnsOf = (turns: readonly StoredTurn[]): ChatTurn[] =>
  turns.map((t) => (t.role === 'visitor' ? { role: 'visitor', text: t.text } : { role: 'site', text: t.text, tag: t.tag }));

/** base64url of bytes, without padding. */
function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface HistoryOptions {
  readonly now?: () => number;
  /** SHA-256 of `text`, base64url — the page's own Web Crypto by default. */
  readonly digest?: (text: string) => Promise<string>;
  /** 16 random bytes, base64url, for a new salt — the page's own Web Crypto by default. */
  readonly salt?: () => string;
}

const webDigest = async (text: string): Promise<string> =>
  base64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
const webSalt = (): string => base64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/** The browser's history store, or one that keeps nothing when `storage` is null or refuses. */
export function createHistory(storage: StorageLike | null, o: HistoryOptions = {}): ChatHistory {
  const now = o.now ?? Date.now;
  const digest = o.digest ?? webDigest;
  const newSalt = o.salt ?? webSalt;
  /** The one way to storage: any throw — blocked, full, gone — is "could not". */
  const access = <T>(fn: (s: StorageLike) => T): { readonly ok: true; readonly value: T } | { readonly ok: false } => {
    if (!storage) return { ok: false };
    try {
      return { ok: true, value: fn(storage) };
    } catch {
      return { ok: false };
    }
  };
  /** Who this page reads for (set by bind), and the salt its hash was made with. */
  let bound: string | null = null;
  let salt: string | null = null;
  const serialise = (chats: Map<string, StoredChat>): string => JSON.stringify({ v: 2, salt, bound, chats: Object.fromEntries(chats) });
  /** The key written whole: this reader's binding and salt, and `chats` (none at all is still a claim on the key). */
  const write = (chats: Map<string, StoredChat>): boolean => access((s) => s.setItem(HISTORY_KEY, serialise(chats))).ok;
  /** The key as it is now, its stale parts written away; null when it cannot be read. */
  const read = (): HistoryRead | null => {
    const got = access((s) => s.getItem(HISTORY_KEY));
    if (!got.ok) return null;
    const r = readHistory(got.value, now());
    if (r.stale) {
      if (r.bound === null) access((s) => s.removeItem(HISTORY_KEY));
      else if (r.bound === bound) write(r.chats);
    }
    return r;
  };
  /** This page's conversations: only when bound, and only when the key is bound to the same reader. */
  const mine = (): Map<string, StoredChat> | null => {
    if (bound === null) return null;
    const r = read();
    if (!r) return null;
    return r.bound === null || r.bound === bound ? r.chats : null;
  };
  const probe = access((s) => {
    s.setItem(`${HISTORY_KEY}:probe`, '1');
    s.removeItem(`${HISTORY_KEY}:probe`);
    return true;
  });
  return {
    available: probe.ok,
    async bind(subject) {
      let r = read();
      let candidate = r?.salt ?? salt ?? newSalt();
      // Another tab may make the key while this one hashes: then it is hashed again with that key's salt (a few times at most).
      for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
        let who: string;
        try {
          who = subject === null ? BROWSER : `a:${await digest(`${candidate}\n${subject}`)}`;
        } catch {
          // No way to tell whose a kept chat is (no Web Crypto here): nothing is shown, and what was kept goes.
          bound = null;
          const had = r !== null && r.chats.size > 0;
          access((s) => s.removeItem(HISTORY_KEY));
          return had;
        }
        const seen = read();
        if (seen?.salt && seen.salt !== candidate) { candidate = seen.salt; r = seen; continue; }
        salt = candidate;
        bound = who;
        if (seen && seen.bound !== null && seen.bound !== who) {
          // Kept for someone else: all of it goes before anything is read, and the key is this reader's.
          write(new Map());
          return seen.chats.size > 0;
        }
        // The key claimed for this reader, salt and all, so every tab hashes the same reader the same way.
        if (!seen || seen.bound === null) write(new Map());
        return false;
      }
      bound = null;
      return false;
    },
    load(key) {
      return mine()?.get(key) ?? null;
    },
    save(key, conversation, turns, base) {
      if (bound === null) return { kept: false, why: 'unbound' };
      const r = read();
      if (!r) return { kept: false, why: 'storage' };
      // Another tab bound the key to someone else (they signed in there): theirs is not to be written over.
      if (r.bound !== null && r.bound !== bound) return { kept: false, why: 'unbound' };
      const chats = new Map(r.chats);
      const current = chats.get(key);
      if (!current && base > 0) return { kept: false, why: 'cleared' };
      if (current && current.rev !== base && !sameTurns(current.turns, turns)) return { kept: false, why: 'conflict' };
      chats.delete(key);
      if (turns.length === 0) return write(chats) ? { kept: true, rev: 0 } : { kept: false, why: 'storage' };
      // Another tab started the key over meanwhile (a Clear, then a new salt): this reader binds again first.
      if (r.salt !== null && r.salt !== salt) return { kept: false, why: 'unbound' };
      const rev = (current?.rev ?? 0) + 1;
      const fresh: StoredChat = { conversation, saved: now(), rev, turns };
      // Newest last: the oldest saved are dropped first.
      const others = [...chats.entries()].sort((a, b) => a[1].saved - b[1].saved).slice(-(HISTORY_LIMITS.chats - 1));
      const kept = new Map(others);
      kept.set(key, fresh);
      while (kept.size > 1 && serialise(kept).length > HISTORY_LIMITS.bytes) kept.delete(kept.keys().next().value!);
      // Alone and still too large: its longest prefix of whole exchanges that fits — a prefix of a tagged history is still valid.
      let cut = turns.length;
      while (cut > 0 && serialise(new Map([[key, { ...fresh, turns: turns.slice(0, cut) }]])).length > HISTORY_LIMITS.bytes) cut -= 2;
      if (cut === 0) {
        kept.delete(key);
        write(kept);
        return { kept: false, why: 'storage' };
      }
      if (cut < turns.length) kept.set(key, { ...fresh, turns: turns.slice(0, cut) });
      if (write(kept)) return { kept: true, rev };
      // The quota is smaller than the cap: this conversation alone, once more.
      return write(new Map([[key, kept.get(key)!]])) ? { kept: true, rev } : { kept: false, why: 'storage' };
    },
    remove(key) {
      const chats = mine();
      if (chats?.delete(key)) write(chats);
    },
    clear() {
      access((s) => s.removeItem(HISTORY_KEY));
    },
    watches: (key) => key === null || key === HISTORY_KEY,
  };
}
