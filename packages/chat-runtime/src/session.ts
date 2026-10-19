/**
 * @az module session
 * Purpose: one conversation's state for a chat window — its turns, each answer's events as they stream, whether one is coming, and what the runtime noted or offered.
 * Spec: docs/chat-block-spec.md §22.5
 * Exports: createChatSession, ChatSession, SessionSnapshot, SessionTurn, SessionAnswer, SessionAsker
 * Edit guide: framework-free and DOM-free — a window (useAzChat, or any other) reads snapshots; each change is a new snapshot, nothing is
 *   changed in place; one question at a time; nothing here draws, so every string stays the renderer's to escape.
 * Tests: packages/chat-runtime/test/session.test.ts
 */

/**
 * `createChatSession(chat, conversation)` is the headless half of a chat
 * window: `ask(question)` streams the runtime's answer into the snapshot,
 * `stop()` ends it, `askHosted()` asks the last question again of the
 * operator's server after the runtime offered it, and `load()` draws a kept
 * conversation again from its stored events. A window subscribes and draws
 * each snapshot — `useAzChat` (`@az/chat-react`) is this, through
 * `useSyncExternalStore` — and draws each answer's `events` with
 * `<AzAnswer>` or `mountAnswer`. Imports only the runtime's types.
 */

import type { ChatRuntime, RuntimeEvent } from './runtime.ts';

/** What a session asks: a chat runtime, or anything that answers the same way. */
export type SessionAsker = Pick<ChatRuntime, 'ask' | 'load'>;

/** An answer as a window draws it: its events so far (the renderer's), and how it ended. */
export interface SessionAnswer {
  readonly role: 'site';
  readonly events: readonly Readonly<Record<string, unknown>>[];
  /** Whole (`done`), failed (an error code), or still coming (null). */
  readonly ended: 'done' | { readonly error: string } | null;
  readonly source: 'direct' | 'local' | 'hosted' | null;
}

export type SessionTurn = { readonly role: 'visitor'; readonly text: string } | SessionAnswer;

export interface SessionSnapshot {
  readonly turns: readonly SessionTurn[];
  /** An answer is coming. */
  readonly busy: boolean;
  /** The last answer came from the user's own provider because the operator's limit was reached. */
  readonly answeredLocally: boolean;
  /** The user's own provider failed and the operator's may answer: `askHosted()` asks it. */
  readonly hostedOffered: boolean;
  /** Questions the conversation may still hold, once one was answered. */
  readonly left: number | null;
}

export interface ChatSession {
  getSnapshot(): SessionSnapshot;
  /** Calls `listener` after each change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Asks one question; false while another is coming, or for an empty one. */
  ask(question: string, options?: { readonly via?: 'suggested' | 'model' | null }): Promise<boolean>;
  /** The last question again, of the operator's server, after it was offered. */
  askHosted(): Promise<boolean>;
  /** Ends the answer that is coming. */
  stop(): void;
  /** The kept conversation, drawn again from its stored events. */
  load(): Promise<void>;
}

const EMPTY: SessionSnapshot = { turns: [], busy: false, answeredLocally: false, hostedOffered: false, left: null };

export function createChatSession(chat: SessionAsker, conversation: string): ChatSession {
  let snap = EMPTY;
  let ac: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<SessionSnapshot>) => {
    snap = { ...snap, ...next };
    for (const l of [...listeners]) l();
  };
  /** The snapshot with its last turn — the answer coming — replaced. */
  const withAnswer = (a: SessionAnswer): readonly SessionTurn[] => [...snap.turns.slice(0, -1), a];

  async function run(question: string, via: 'suggested' | 'model' | null, mode: 'local' | 'hosted' | undefined): Promise<boolean> {
    if (snap.busy || question.trim() === '') return false;
    ac = new AbortController();
    let answer: SessionAnswer = { role: 'site', events: [], ended: null, source: null };
    set({ turns: [...snap.turns, { role: 'visitor', text: question }, answer], busy: true, answeredLocally: false, hostedOffered: false });
    const put = (a: SessionAnswer, more: Partial<SessionSnapshot> = {}) => { answer = a; set({ turns: withAnswer(a), ...more }); };
    try {
      for await (const e of chat.ask(conversation, question, { signal: ac.signal, via, ...(mode ? { mode } : {}) }) as AsyncIterable<RuntimeEvent>) {
        if (e.type === 'note') set({ answeredLocally: true });
        else if (e.type === 'offer') set({ hostedOffered: true });
        else if (e.type === 'done') put({ ...answer, events: [...answer.events, { type: 'done' }], ended: 'done', source: e.source }, { left: e.left });
        else if (e.type === 'error') put({ ...answer, events: [...answer.events, { type: 'error', code: e.code }], ended: { error: e.code } });
        else put({ ...answer, events: [...answer.events, e] });
      }
    } catch {
      put({ ...answer, events: [...answer.events, { type: 'error', code: 'unavailable' }], ended: { error: 'unavailable' } });
    } finally {
      // An answer that ended with neither is a failed one, never one left coming.
      if (answer.ended === null) put({ ...answer, events: [...answer.events, { type: 'error', code: 'unavailable' }], ended: { error: 'unavailable' } });
      ac = null;
      set({ busy: false });
    }
    return true;
  }

  return {
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    ask: (q, o = {}) => run(q.trim(), o.via ?? null, undefined),
    async askHosted() {
      if (!snap.hostedOffered || snap.busy) return false;
      const last = [...snap.turns].reverse().find((t) => t.role === 'visitor');
      if (!last || last.role !== 'visitor') return false;
      return run(last.text, null, 'hosted');
    },
    stop() { ac?.abort(); },
    async load() {
      if (snap.busy) return;
      const kept = await chat.load(conversation);
      if (!kept) return;
      set({
        turns: kept.turns.map((t): SessionTurn => (t.role === 'visitor'
          ? { role: 'visitor', text: t.text }
          : { role: 'site', events: [...t.events, { type: 'done' }], ended: 'done', source: t.source })),
      });
    },
  };
}
