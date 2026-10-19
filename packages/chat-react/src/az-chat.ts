/**
 * @az module az-chat
 * Purpose: <AzChat> — a whole chat window in React: the theme's chat section run by the site panel's own core over a chat session, with the app's title, greeting and suggested questions.
 * Spec: docs/chat-block-spec.md §22.5
 * Exports: AzChat, AzChatProps, sessionWindow, SessionWindow, WindowPanel
 * Edit guide: the window is the renderer's (chat-render chat-panel.ts runPanel) — this file builds its shell from a theme, writes the
 *   app's own strings in as text, and feeds the session's snapshots to it; nothing is styled here, the layout is the host's.
 * Tests: packages/chat-react/test/az-chat.test.ts, scripts/chat-lib-e2e.mjs
 */

/**
 * ```ts
 * createElement(AzChat, { runtime, conversation: 'support', theme: 'midnight', components: ['faq', 'chart'],
 *   title: 'Ask Acme', greeting: 'Hi! Ask me about orders.', suggestions: ['How fast do you ship?'] })
 * ```
 *
 * The window an az site's chat panel is — its form, transcript, suggested
 * questions, Stop, Try again and status region, keyboard, screen reader and
 * reduced motion included — run by the same code (chat-render
 * chat-panel.ts), asking `runtime` through a chat session
 * (`@az/chat-runtime` session.ts). It fills the box the app gives it: the
 * app sizes the element (`className`), the transcript scrolls in what the
 * rest leaves. The theme's stylesheet is the app's to load, so the page's
 * policy needs no inline style.
 *
 * The session is read imperatively, not through useAzChat: a window draws
 * each event as it arrives without a React render per word. Its kept
 * conversation is loaded on mount; an answer coming is stopped on unmount.
 *
 * Written with createElement rather than JSX, so the package runs as
 * TypeScript with no build step, like every package here.
 */

import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { RICH_BLOCKS, leftCopy, parseChatConfig } from '#chat-render/chat-logic.ts';
import { panelPartsOf, runPanel, type Panel, type PanelAnswer, type PanelDriver } from '#chat-render/chat-panel.ts';
import { chatShell, hostImages, type ChatTheme } from '#chat-render/chat-templates.ts';
import { suffixIds, type MapDrawer } from '#chat-render/chat-answer-view.ts';
import { drawMap } from '#chat-render/chat-map-draw.ts';
import type { MountOptions } from '#chat-render/chat-answer-mount.ts';
import { createChatSession, type ChatSession, type SessionAsker } from '#chat-runtime/session.ts';
import { loadTheme, type ThemeName } from './az-answer.ts';

/** What a session's window needs of the panel. */
export type WindowPanel = Pick<Panel, 'answer' | 'fail' | 'keptQuestion' | 'keptAnswer' | 'hideAsks' | 'note' | 'setMode' | 'setState'>;

/** A session's side of a window: the driver the panel runs with, and the session's snapshots drawn into the panel. */
export interface SessionWindow {
  readonly driver: PanelDriver;
  /** Draws the session into `panel` from now on; returns the unsubscribe. */
  start(panel: WindowPanel): () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The window over a session: a question the panel shows is asked of the session, and each snapshot's new events are drawn
 * into the answer the panel began; turns the window did not ask for (a kept conversation loaded) are drawn as they were.
 * `limit` is the conversation's questions: a kept one that holds them all leaves the window full.
 */
export function sessionWindow(session: ChatSession, o: { readonly base: string; readonly limit: number; readonly drawMap?: MapDrawer }): SessionWindow {
  let panel: WindowPanel | null = null;
  /** How many of the session's turns the window shows. */
  let drawn = 0;
  /** The answer the window asked for: its turn in the session, and how many of its events are drawn. */
  let coming: { readonly at: number; readonly answer: PanelAnswer; pushed: number } | null = null;

  const sync = () => {
    const p = panel;
    if (!p) return;
    const snap = session.getSnapshot();
    const turns = snap.turns;
    if (coming) {
      const c = coming;
      const t = turns[c.at];
      if (!t || t.role !== 'site') return;
      for (; c.pushed < t.events.length; c.pushed++) {
        const e = t.events[c.pushed];
        if (e.type === 'text' && typeof e.s === 'string') c.answer.text(e.s);
        else if (e.type === 'hold' && typeof e.word === 'string' && RICH_BLOCKS.includes(e.word)) c.answer.hold(e.word);
        else if (e.type === 'block' && isRecord(e.block)) c.answer.block(e.block);
      }
      if (t.ended === null) return;
      coming = null;
      drawn = turns.length;
      if (t.ended === 'done') {
        const follows = c.answer.finish();
        c.answer.bar();
        c.answer.arrived(follows);
        if (snap.left !== null && snap.left <= 0) p.setMode('full');
        else if (snap.left !== null) { p.setState('idle'); p.note(leftCopy(snap.left)); }
      } else if (c.answer.stopping) c.answer.stopped();
      else p.fail(t.ended.error, c.answer.item);
      return;
    }
    // Turns the window did not ask for — a kept conversation, loaded — drawn as they were first drawn, once nothing is coming.
    if (snap.busy || turns.length <= drawn) return;
    let shown = false;
    for (const t of turns.slice(drawn)) {
      if (t.role === 'visitor') { p.keptQuestion(t.text); shown = true; } else if (t.ended === 'done') p.keptAnswer(t.events);
    }
    drawn = turns.length;
    if (shown) p.hideAsks();
    if (turns.filter((t) => t.role === 'visitor').length >= o.limit) p.setMode('full');
  };

  const driver: PanelDriver = {
    base: o.base,
    ...(o.drawMap ? { drawMap: o.drawMap } : {}),
    answer(question, via) {
      if (!panel) return;
      const at = session.getSnapshot().turns.length + 1;
      coming = { at, answer: panel.answer(), pushed: 0 };
      void session.ask(question, { via }).then((asked) => {
        // Refused before it began (another answer coming, or nothing to ask): the answer's place goes.
        if (asked || coming?.at !== at) return;
        const c = coming;
        coming = null;
        panel?.fail('unavailable', c.answer.item);
      });
    },
    stop: () => session.stop(),
    answered: () => session.getSnapshot().turns.some((t) => t.role === 'site' && t.ended === 'done'),
    kept: () => false,
    keeps: false,
  };

  return {
    driver,
    start(p) {
      panel = p;
      const unsubscribe = session.subscribe(sync);
      sync();
      return () => {
        unsubscribe();
        panel = null;
        coming = null;
      };
    },
  };
}

export interface AzChatProps extends Omit<MountOptions, 'theme' | 'onAsk' | 'onAnnounce' | 'onCopy'> {
  /** What answers: `createChatRuntime`'s — in a page, one over a transport, since a key is never in browser code. */
  readonly runtime: SessionAsker;
  /** The conversation's id: a kept one is drawn again; another id is another window's conversation. */
  readonly conversation: string;
  /** A theme module, or one of THEME_NAMES; its stylesheet (`@az/chat-render/themes/<name>.css`) is the app's to load. */
  readonly theme: ChatTheme | ThemeName;
  /** The window's heading; the theme's own by default. */
  readonly title?: string;
  /** The window's first message; the theme's own by default. */
  readonly greeting?: string;
  /** Suggested questions, each a button that asks it; none by default. */
  readonly suggestions?: readonly string[];
  /** The questions a conversation may hold (1–50, 20 by default): then the window says it is full. */
  readonly limit?: number;
  /** The element's class: the app's layout gives the window its size. */
  readonly className?: string;
}

/** The questions a conversation holds unless the app says otherwise: the chat word's own default. */
const LIMIT = 20;

/** Windows on the page so far: each one's ids get their own suffix, so two windows never share one. */
let windows = 0;

/** The theme's shell with the app's own strings, as text: its heading, its greeting, its suggested questions (or none). */
function dress(shell: HTMLElement, p: AzChatProps): void {
  const title = shell.querySelector('.az-chat-title');
  if (title && p.title !== undefined) title.textContent = p.title;
  const greeting = shell.querySelector('[data-az-chat-transcript] .az-chat-text');
  if (greeting && p.greeting !== undefined) greeting.textContent = p.greeting;
  const asks = shell.querySelector('[data-az-chat-asks]');
  const item = asks?.firstElementChild;
  if (!asks || !item) return;
  const suggestions = (p.suggestions ?? []).filter((s) => s.trim() !== '');
  if (suggestions.length === 0) { asks.remove(); return; }
  asks.replaceChildren(...suggestions.map((s) => {
    const copy = item.cloneNode(true) as Element;
    const button = copy.querySelector('[data-az-chat-ask]');
    if (button) button.textContent = s;
    return copy;
  }));
}

export function AzChat(props: AzChatProps): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<ChatTheme | null>(typeof props.theme === 'string' ? null : props.theme);
  useEffect(() => {
    if (typeof props.theme !== 'string') { setTheme(props.theme); return undefined; }
    let live = true;
    void loadTheme(props.theme).then((t) => { if (live) setTheme(t); });
    return () => { live = false; };
  }, [props.theme]);
  const session = useMemo(() => createChatSession(props.runtime, props.conversation), [props.runtime, props.conversation]);
  const latest = useRef(props);
  latest.current = props;
  /** What the window is made under: a change makes it again; the session's turns are drawn again into it. */
  const under = JSON.stringify([props.components, props.destinations ?? [], Object.entries(props.images ?? {}), props.scheme ?? null,
    props.backend ?? '', props.tiles ?? null, props.title ?? null, props.greeting ?? null, props.suggestions ?? [], props.limit ?? LIMIT]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!theme || !el) return undefined;
    const p = latest.current;
    const limit = p.limit ?? LIMIT;
    const config = parseChatConfig(JSON.stringify({ page: '/', allow: 'anyone', limit, signin: null, show: p.components, to: p.destinations ?? [] }));
    if (!config) throw new TypeError('AzChat: components the chat shows, destinations it may link to and a limit of 1–50 questions');
    const { root, shell } = chatShell(el.ownerDocument, theme, p.scheme ?? null);
    root.setAttribute('data-az-chat-window', '');
    shell.setAttribute('data-az-chat', JSON.stringify({ page: config.page, allow: config.allow, limit: config.limit, signin: null, show: config.show, to: config.to }));
    if (p.images) hostImages(shell, p.images);
    dress(shell, p);
    suffixIds(root, `w${++windows}`);
    const parts = panelPartsOf(shell);
    if (!parts) throw new Error('AzChat: the theme has no chat window');
    el.append(root);
    const ac = new AbortController();
    const tiles = p.tiles ?? null;
    const w = sessionWindow(session, { base: p.backend ?? '', limit, drawMap: (d, data) => drawMap({ ...d, tiles }, data) });
    const panel = runPanel(parts, config, w.driver, ac.signal);
    panel.setMode('ready');
    const stop = w.start(panel);
    return () => {
      stop();
      ac.abort();
      panel.teardown();
      root.remove();
    };
  }, [theme, session, under]);
  useEffect(() => {
    void session.load();
    return () => session.stop();
  }, [session]);
  return createElement('div', { ref: host, ...(props.className ? { className: props.className } : {}) });
}
