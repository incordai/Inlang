/**
 * @az module history
 * Purpose: where an app keeps its conversations — the turns as the model is sent them back (stand-ins and notes), each answer's events to draw it again, and who answered it.
 * Spec: docs/chat-block-spec.md §19.16, §21.1.4, §22.4
 * Exports: HistoryStore, StoredConversation, StoredAnswer, ConversationTurn, AnswerSource, WebStorage, memoryHistory, webStorageHistory, HISTORY_STORE_LIMITS, isStoredConversation
 * Edit guide: what is read back is checked whole — a stored conversation of another shape is no conversation; never a key or a secret.
 * Tests: packages/chat-runtime/test/runtime.test.ts
 */

/**
 * The runtime keeps each conversation on the device (chat-block-spec §22.4):
 * every question, and every answer as its history text — the prose, a
 * stand-in per component and a note per drop, exactly what the answer
 * checker returned (§19.16) — with the events it was drawn from and who
 * answered it (`direct`: this runtime's own model; `local` or `hosted`: a
 * chat server). A server's tag is kept with its answer, so that server can
 * be sent it back; the runtime's own tag, when it has a tagger, guards a
 * stored conversation against an edit.
 *
 * Two stores: in memory, and the page's Web Storage (`localStorage` in a
 * plain web app or an app webview), capped and read back with every value
 * checked. An app that keeps its own (a desktop store, SQLite) implements
 * HistoryStore. Imports nothing.
 */

/** Who answered: this runtime's own model, or a chat server — the user's own (`local`) or the operator's (`hosted`). */
export type AnswerSource = 'direct' | 'local' | 'hosted';

/** An answer as kept: its history text, its tag (null when untagged), who answered, and its events to draw it again. */
export interface StoredAnswer {
  readonly role: 'site';
  readonly text: string;
  readonly tag: string | null;
  readonly source: AnswerSource;
  readonly events: readonly Readonly<Record<string, unknown>>[];
}

export type ConversationTurn = { readonly role: 'visitor'; readonly text: string } | StoredAnswer;

export interface StoredConversation {
  readonly id: string;
  /** A server's own id for this conversation, by source, once it has answered (its tags are bound to it). */
  readonly server: Readonly<Partial<Record<'local' | 'hosted', string>>>;
  readonly turns: readonly ConversationTurn[];
  /** When it last changed, ms since the epoch. */
  readonly at: number;
}

export interface HistoryStore {
  load(id: string): Promise<StoredConversation | null>;
  save(conversation: StoredConversation): Promise<void>;
  /** Every conversation kept, newest first: id, when, and its first question. */
  list(): Promise<readonly { readonly id: string; readonly at: number; readonly title: string }[]>;
  remove(id: string): Promise<void>;
}

/** What one store keeps at most: conversations, turns of one, and the characters of all of them in Web Storage. */
export const HISTORY_STORE_LIMITS = { conversations: 50, turns: 100, chars: 1_000_000, events: 64 } as const;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const SOURCES: readonly string[] = ['direct', 'local', 'hosted'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `v` is a conversation as this module writes one; anything else read back is dropped. */
export function isStoredConversation(v: unknown): v is StoredConversation {
  if (!isRecord(v) || typeof v.id !== 'string' || !ID.test(v.id) || typeof v.at !== 'number' || !Number.isFinite(v.at)) return false;
  if (!isRecord(v.server) || !Object.entries(v.server).every(([k, s]) => (k === 'local' || k === 'hosted') && typeof s === 'string' && ID.test(s))) return false;
  if (!Array.isArray(v.turns) || v.turns.length > HISTORY_STORE_LIMITS.turns) return false;
  return v.turns.every((t: unknown) => isRecord(t) && typeof t.text === 'string' && (t.role === 'visitor'
    || (t.role === 'site' && (t.tag === null || typeof t.tag === 'string') && SOURCES.includes(t.source as string)
      && Array.isArray(t.events) && t.events.length <= HISTORY_STORE_LIMITS.events && t.events.every(isRecord))));
}

const title = (c: StoredConversation): string => (c.turns.find((t) => t.role === 'visitor')?.text ?? '').slice(0, 80);

/** Conversations in memory: gone when the app closes. */
export function memoryHistory(): HistoryStore {
  const kept = new Map<string, StoredConversation>();
  return {
    async load(id) { return kept.get(id) ?? null; },
    async save(c) {
      kept.set(c.id, c);
      // The oldest go past the cap.
      const ids = [...kept.values()].sort((a, b) => b.at - a.at).map((x) => x.id);
      for (const id of ids.slice(HISTORY_STORE_LIMITS.conversations)) kept.delete(id);
    },
    async list() { return [...kept.values()].sort((a, b) => b.at - a.at).map((c) => ({ id: c.id, at: c.at, title: title(c) })); },
    async remove(id) { kept.delete(id); },
  };
}

/** The part of Web Storage the store uses: what `localStorage` offers. */
export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Conversations in Web Storage under one key (`az-chat-runtime:v1` by
 * default): the newest first, past HISTORY_STORE_LIMITS the oldest dropped;
 * a storage that refuses (private mode, a full quota) keeps nothing and
 * never throws. What is read back is checked whole.
 */
export function webStorageHistory(storage: WebStorage, key = 'az-chat-runtime:v1'): HistoryStore {
  const read = (): StoredConversation[] => {
    let raw: string | null;
    try { raw = storage.getItem(key); } catch { return []; }
    if (raw === null) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.filter(isStoredConversation) : [];
    } catch {
      return [];
    }
  };
  const write = (all: readonly StoredConversation[]): void => {
    let kept = [...all].sort((a, b) => b.at - a.at).slice(0, HISTORY_STORE_LIMITS.conversations);
    let text = JSON.stringify(kept);
    while (text.length > HISTORY_STORE_LIMITS.chars && kept.length > 0) {
      kept = kept.slice(0, -1);
      text = JSON.stringify(kept);
    }
    try { storage.setItem(key, text); } catch { /* a storage that refuses keeps nothing: the conversation goes on in memory */ }
  };
  return {
    async load(id) { return read().find((c) => c.id === id) ?? null; },
    async save(c) { write([c, ...read().filter((x) => x.id !== c.id)]); },
    async list() { return read().map((c) => ({ id: c.id, at: c.at, title: title(c) })); },
    async remove(id) { write(read().filter((x) => x.id !== id)); },
  };
}
