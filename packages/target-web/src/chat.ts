/**
 * @az module chat
 * Purpose: src/chat/runtime.tsx — connects every chat panel to the backend and the auth session, after the page renders.
 * Spec: docs/chat-block-spec.md §4.4, §7
 * Exports: CHAT_FILE, CHAT_RUNTIME_FILES, usesChat, chatTsx, withSharedPage, usesSeries, showsCards, SHARED_ROUTE
 * Edit guide: generated only for a site with a chat block; the DOM work is the overlay runtime's chat.ts, not this file.
 * Tests: packages/target-web/test/chat.test.ts
 */

/**
 * A `chat` block ships as a pre-rendered shell (the chat word's emitter);
 * the runtime that runs it (overlay runtime chat.ts) is copied into the
 * site, and this generated module hands it the backend's address
 * (AZ_PUBLIC_BACKEND_URL, exactly as the auth adapter reads it) and the
 * auth adapter's session — the account's id or nobody — so the panel knows
 * whether its visitor may ask, and whose the chat kept in the browser is.
 * A site without a chat block gets none of it: no module, no runtime files.
 */

import { BACKEND_ENV, AUTH_DIR } from './auth.ts';
import { generated } from './generated.ts';
import { blocksFor, type Spec, type SpecBlock } from '../../core/src/spec.ts';
import type { SpecChatAnswer } from '../../core/src/spec-block.ts';
import { SHARED_ROUTE } from '../../core/src/chat.ts';

export { SHARED_ROUTE };

export const CHAT_FILE = 'src/chat/runtime.tsx';

/** The behaviour runtime's files that only a site with a chat block ships. */
export const CHAT_RUNTIME_FILES: readonly string[] = ['chat.ts', 'chat-logic.ts', 'chat-chart.ts', 'chat-figures.ts', 'chat-draw.ts', 'chat-shared.ts', 'chat-markdown.ts', 'chat-prose.ts', 'chat-history.ts', 'chat-explore.ts', 'chat-explore-draw.ts', 'rows-logic.ts'];

/** Every page's chat — its own, or the site's float, as blocksFor resolves it (chat-block-spec §3.1). */
const chatsOf = (spec: Spec): SpecBlock[] => spec.pages.flatMap((p) => blocksFor(spec, p).filter((b) => b.word === 'chat'));

/** Some chat may draw a chart (chat-block-spec §20.4): the site's theme gets its series colours. */
export function usesSeries(spec: Spec): boolean {
  return chatsOf(spec).some((b) => (b.chat?.answer?.show ?? []).some((w) => w === 'chart' || w === 'stats' || w === 'dashboard' || w === 'explore'));
}

/** A page's chat may show image cards (§20.6): row images come from the backend, so its img-src names it. */
export function showsCards(blocks: readonly SpecBlock[]): boolean {
  return blocks.some((b) => b.word === 'chat' && (b.chat?.answer?.show ?? []).includes('cards'));
}

/** Two lists as one, in first-seen order, each value once. */
const union = <T>(a: readonly T[], b: readonly T[], key: (x: T) => string): T[] => {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)) && seen.add(key(x)))];
};

/**
 * The spec with the shared-answer page (chat-block-spec §20.7) a chat site
 * gets: one more page at SHARED_ROUTE holding a read-only chat shell whose
 * templates cover every chat's `show`, so any shared answer draws with the
 * same parts it was drawn with. A site without a chat — or whose chats
 * show nothing — is returned as it was.
 */
export function withSharedPage(spec: Spec): Spec {
  const chats = chatsOf(spec);
  const answers = chats.map((b) => b.chat?.answer).filter((a): a is SpecChatAnswer => a !== undefined);
  if (chats.length === 0 || answers.length === 0 || spec.pages.some((p) => p.route === SHARED_ROUTE)) return spec;
  const answer: SpecChatAnswer = answers.slice(1).reduce<SpecChatAnswer>((acc, a) => ({
    show: union(acc.show, a.show, String),
    quotes: union(acc.quotes, a.quotes, (q) => `${q.route}#${q.n}`),
    destinations: union(acc.destinations, a.destinations, String).sort(),
    ...(acc.images || a.images ? { images: union(acc.images ?? [], a.images ?? [], (i) => i.key) } : {}),
    ...(acc.tables || a.tables ? { tables: union(acc.tables ?? [], a.tables ?? [], (t) => t.name) } : {}),
  }), answers[0]);
  const first = chats[0];
  // A section on its own page, whichever chat it was made from (a float's launcher has nothing to open there).
  const shell: SpecBlock = {
    ...first, variant: 'panel', props: { ...first.props, allow: 'anyone' }, children: [],
    chat: { route: SHARED_ROUTE, signin: null, answer, shared: true },
  };
  return { ...spec, pages: [...spec.pages, { route: SHARED_ROUTE, blocks: [shell] }] };
}

/** Some page renders a chat block: its own panel or float, or the site's float. */
export function usesChat(spec: Spec): boolean {
  return chatsOf(spec).length > 0;
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

/**
 * The signed-in account's id, or null, from the session the auth adapter
 * reads once: who may ask, and whom the chat kept in this browser is bound
 * to (only a salted hash of it is ever stored, chat-block-spec §19.11).
 */
async function account(): Promise<string | null> {
  await adapter.ready?.();
  return adapter.session()?.user.id ?? null;
}

/** Runs the page's chat panels; renders nothing. A layout effect, so it never runs in a server render. */
export function ChatRuntime(): null {
  useLayoutEffect(() => attachChat(document, {
    base: BASE,
    account,
    onSession: (fn) => adapter.onChange((session) => fn(session?.user.id ?? null)),
  }), []);
  return null;
}
`;
}
