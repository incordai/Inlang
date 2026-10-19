/**
 * @az module use-az-chat
 * Purpose: useAzChat — a chat window's state in React: the conversation's turns, each answer's events as they stream, and ask, stop and askHosted.
 * Spec: docs/chat-block-spec.md §22.5
 * Exports: useAzChat, AzChatState
 * Edit guide: a thin wrapper — the state is chat-runtime's session (session.ts), read through useSyncExternalStore; nothing here draws.
 * Tests: packages/chat-react/test/use-az-chat.test.ts, packages/chat-runtime/test/session.test.ts
 */

/**
 * ```ts
 * const chat = useAzChat(runtime, conversationId);
 * chat.turns.map((t) => t.role === 'site' ? createElement(AzAnswer, { events: t.events, theme, components }) : t.text);
 * chat.ask(question); chat.stop(); if (chat.hostedOffered) chat.askHosted();
 * ```
 *
 * The headless half of a chat window: the app draws its own window and each
 * answer with `<AzAnswer>`. `runtime` is `createChatRuntime`'s — in a page,
 * one over a transport (the sidecar or the operator's server), since a key
 * is never in browser code. The kept conversation is loaded on mount; a new
 * runtime or conversation id starts a new session.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createChatSession, type ChatSession, type SessionAsker, type SessionSnapshot } from '#chat-runtime/session.ts';

export interface AzChatState extends SessionSnapshot {
  readonly ask: ChatSession['ask'];
  readonly askHosted: ChatSession['askHosted'];
  readonly stop: ChatSession['stop'];
}

export function useAzChat(runtime: SessionAsker, conversation: string): AzChatState {
  const session = useMemo(() => createChatSession(runtime, conversation), [runtime, conversation]);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    void session.load();
    return () => session.stop();
  }, [session]);
  return useMemo(() => ({ ...snap, ask: session.ask, askHosted: session.askHosted, stop: session.stop }), [snap, session]);
}
