/**
 * @az module chat
 * Purpose: src/chat/runtime.tsx — connects every chat panel to the backend and the auth session, after the page renders.
 * Spec: docs/chat-block-spec.md §4.4, §7
 * Exports: CHAT_FILE, CHAT_RUNTIME_FILES, usesChat, chatTsx
 * Edit guide: generated only for a site with a chat block; the DOM work is the overlay runtime's chat.ts, not this file.
 * Tests: packages/target-web/test/chat.test.ts
 */

/**
 * A `chat` block ships as a pre-rendered shell (the chat word's emitter);
 * the runtime that runs it (overlay runtime chat.ts) is copied into the
 * site, and this generated module hands it the backend's address
 * (AZ_PUBLIC_BACKEND_URL, exactly as the auth adapter reads it) and the
 * auth adapter's session, so the panel knows whether its visitor may ask.
 * A site without a chat block gets none of it: no module, no runtime files.
 */

import { BACKEND_ENV, AUTH_DIR } from './auth.ts';
import { generated } from './generated.ts';
import type { Spec } from '../../core/src/spec.ts';

export const CHAT_FILE = 'src/chat/runtime.tsx';

/** The behaviour runtime's files that only a site with a chat block ships. */
export const CHAT_RUNTIME_FILES: readonly string[] = ['chat.ts', 'chat-logic.ts'];

/** Some page renders a chat block (C1: `chat panel`, a page block). */
export function usesChat(spec: Spec): boolean {
  return spec.pages.some((p) => p.blocks.some((b) => b.word === 'chat'));
}

/** The module's text; `runtimeDir` is where the behaviour runtime is copied (src/az). */
export function chatTsx(runtimeDir: string): string {
  const str = (v: string) => JSON.stringify(v);
  // All three directories sit under src/, so each is one level up from here.
  const runtime = `../${runtimeDir.replace(/^src\//, '')}/chat.ts`;
  const auth = `../${AUTH_DIR.replace(/^src\//, '')}/config.ts`;
  return `${generated('connects every chat panel to the backend and the auth session (chat-block-spec §7)')}import { useLayoutEffect } from "react";
import { attachChat } from ${str(runtime)};
import { adapter } from ${str(auth)};

/** The backend's base URL; the panel posts to <base>/chat. */
const BASE: string = import.meta.env.${BACKEND_ENV[0]} ?? "";

/** Whether the visitor is signed in, from the session the auth adapter reads once. */
async function signedIn(): Promise<boolean> {
  await adapter.ready?.();
  return adapter.session() !== null;
}

/** Runs the page's chat panels; renders nothing. A layout effect, so it never runs in a server render. */
export function ChatRuntime(): null {
  useLayoutEffect(() => attachChat(document, {
    base: BASE,
    signedIn,
    onSession: (fn) => adapter.onChange((session) => fn(session !== null)),
  }), []);
  return null;
}
`;
}
