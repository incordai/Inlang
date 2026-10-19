/**
 * @az module az-answer
 * Purpose: <AzAnswer> — one streaming answer drawn in React from the answer checker's events, with the az site's own renderer.
 * Spec: docs/chat-block-spec.md §22.3
 * Exports: AzAnswer, AzAnswerProps, ThemeName, THEME_NAMES, loadTheme
 * Edit guide: a thin wrapper — the drawing is the renderer core's (chat-render chat-answer-mount.ts); only new events are pushed,
 *   the drawing is redone only when what it is drawn under changes; unmount stops charts and maps.
 * Tests: packages/chat-react/test/az-answer.test.ts, scripts/chat-lib-e2e.mjs
 */

/**
 * ```ts
 * createElement(AzAnswer, { events, theme: 'midnight', components: ['faq', 'chart'], destinations: ['/contact'] })
 * ```
 *
 * `events` is the answer so far — the checker's events, or the chat API's —
 * and grows as the answer streams: each render pushes only the events not
 * drawn yet; a shorter list, or one whose first event differs, starts the
 * answer again. The theme
 * is a theme module of the renderer, or its name, loaded on first use; its
 * stylesheet (`@az/chat-render/themes/<name>.css`) is the app's to load, so
 * the page's policy needs no inline style. Maps load their library only
 * when one arrives.
 *
 * Written with createElement rather than JSX, so the package runs as
 * TypeScript with no build step, like every package here.
 */

import { createElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { mountAnswer, type AnswerWireEvent, type MountedAnswer, type MountOptions } from '#chat-render/chat-answer-mount.ts';
import type { ChatTheme } from '#chat-render/chat-templates.ts';

/** The renderer's six themes, by name. */
export const THEME_NAMES = ['midnight', 'paper', 'signal', 'clay', 'petal', 'volt'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/** A theme module by its name, loaded when first used — each a separate chunk to an app's bundler. */
export function loadTheme(name: ThemeName): Promise<ChatTheme> {
  switch (name) {
    case 'midnight': return import('#chat-render/themes/midnight.ts');
    case 'paper': return import('#chat-render/themes/paper.ts');
    case 'signal': return import('#chat-render/themes/signal.ts');
    case 'clay': return import('#chat-render/themes/clay.ts');
    case 'petal': return import('#chat-render/themes/petal.ts');
    case 'volt': return import('#chat-render/themes/volt.ts');
  }
}

export interface AzAnswerProps extends Omit<MountOptions, 'theme'> {
  /** The answer's events so far, in order. */
  readonly events: readonly AnswerWireEvent[];
  /** A theme module, or one of THEME_NAMES. */
  readonly theme: ChatTheme | ThemeName;
  /** The element's class, for the app's layout. */
  readonly className?: string;
}

export function AzAnswer(props: AzAnswerProps): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<ChatTheme | null>(typeof props.theme === 'string' ? null : props.theme);
  useEffect(() => {
    if (typeof props.theme !== 'string') { setTheme(props.theme); return undefined; }
    let live = true;
    void loadTheme(props.theme).then((t) => { if (live) setTheme(t); });
    return () => { live = false; };
  }, [props.theme]);
  // The callbacks as of the last render: the drawing calls the newest without being redone.
  const calls = useRef(props);
  calls.current = props;
  /** What the drawing is made under: a change starts it again; a new event alone never does. */
  const under = JSON.stringify([props.components, props.destinations ?? [], Object.entries(props.images ?? {}), props.scheme ?? null, props.backend ?? '', props.tiles ?? null]);
  const drawn = useRef<{ readonly m: MountedAnswer; first: string; count: number } | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!theme || !el) return undefined;
    const p = calls.current;
    const m = mountAnswer(el, {
      theme, components: p.components,
      ...(p.destinations ? { destinations: p.destinations } : {}),
      ...(p.images ? { images: p.images } : {}),
      ...(p.scheme ? { scheme: p.scheme } : {}),
      ...(p.backend ? { backend: p.backend } : {}),
      ...(p.tiles !== undefined ? { tiles: p.tiles } : {}),
      onAsk: (q) => calls.current.onAsk?.(q),
      onAnnounce: (t) => calls.current.onAnnounce?.(t),
      ...(p.onCopy ? { onCopy: (t: string) => calls.current.onCopy?.(t) } : {}),
    });
    drawn.current = { m, first: '', count: 0 };
    return () => {
      m.destroy();
      drawn.current = null;
    };
  }, [theme, under]);
  useLayoutEffect(() => {
    const d = drawn.current;
    if (!d) return;
    const events = props.events;
    // Another answer, or one that went back: drawn again from its start. The first event is compared by value, so a list
    // made again with the same events (from a store, or a message channel) is the same answer, not a new one.
    const first = events.length > 0 ? JSON.stringify(events[0]) : '';
    if (events.length < d.count || (d.count > 0 && first !== d.first)) {
      d.m.reset();
      d.count = 0;
    }
    d.first = first;
    for (let i = d.count; i < events.length; i++) d.m.push(events[i]);
    d.count = events.length;
  }, [props.events, theme, under]);
  return createElement('div', { ref: host, ...(props.className ? { className: props.className } : {}) });
}
