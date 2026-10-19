/**
 * @az runtime chat-answer-mount
 * Purpose: the renderer core for an app — one answer drawn from the checker's events into a theme's shell, with no framework and no build.
 * Spec: docs/chat-block-spec.md §22.3
 * Exports: mountAnswer, MountedAnswer, MountOptions, AnswerWireEvent, WIRE_EVENTS
 * Edit guide: every event is checked again here before it is drawn (the page is the second check, as on a site); nothing from an
 *   event becomes an element, an attribute or a URL but through the answer view's own checks; destroy() leaves nothing running.
 * Tests: scripts/chat-lib-e2e.mjs, packages/overlay/test/chat.test.ts
 */

/**
 * What <AzAnswer> (packages/chat-react) and any other host draw an answer
 * with (chat-block-spec §22.3): the theme's shell (chat-templates.ts) inside
 * the renderer's root, hidden, holding the templates; a list showing one
 * answer item; and the answer view (chat-answer-view.ts) the site's own
 * panel draws with. Events arrive as the answer checker sent them —
 * `text`, `hold`, `block`, `done` — or as the chat API streams them; each is
 * checked by shape here and each component again by the drawing.
 *
 * Its charts redraw when their width changes; a map loads its library only
 * when one arrives (chat-map-draw.ts); destroy() aborts both and takes the
 * root out of the page.
 *
 * Imports only its siblings.
 */

import { CHAT_TEXT, RICH_BLOCKS } from './chat-logic.ts';
import { proseTemplatesOf } from './chat-prose.ts';
import { busyKitOf } from './chat-busy.ts';
import { answerBar } from './chat-bar.ts';
import { answerDrawer, liveAnswer, resizeWatch, type AnswerConfig, type LiveAnswer, type Place } from './chat-answer-view.ts';
import { drawMap } from './chat-map-draw.ts';
import { chatShell, hostImages, type ChatTheme, type HostImage } from './chat-templates.ts';

/** An answer's event as the answer checker sends it, or the chat API streams it. */
export type AnswerWireEvent =
  | { readonly type: 'text'; readonly s: string }
  | { readonly type: 'hold'; readonly word: string }
  | { readonly type: 'block'; readonly block: Record<string, unknown> }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly code: string };

/** The event types an answer is drawn from; any other is ignored. */
export const WIRE_EVENTS: readonly string[] = ['text', 'hold', 'block', 'done', 'error'];

export interface MountOptions {
  /** A theme module (themes/<name>.ts); its stylesheet (themes/<name>.css) is the host's to load. */
  readonly theme: ChatTheme;
  /** What the answers may show (the checker's components) and the only destinations they may link to. */
  readonly components: readonly string[];
  readonly destinations?: readonly string[];
  /** The app's images a card may name, by key. */
  readonly images?: Readonly<Record<string, HostImage>>;
  /** Light or dark; by default the theme's, or the visitor's preference. */
  readonly scheme?: 'light' | 'dark';
  /** Where row images and map tiles come from (a site's backend); none by default. */
  readonly backend?: string;
  /** A tile archive's URL for maps, instead of the backend's. */
  readonly tiles?: string | null;
  /** A follow-up question, or an explore's form, asks this. */
  readonly onAsk?: (question: string) => void;
  /** What the status region would say: whole sentences and one line per component. */
  readonly onAnnounce?: (text: string) => void;
  /** The answer's Copy (its bar): its text form. Without it, the answer has no bar. */
  readonly onCopy?: (text: string) => void;
}

export interface MountedAnswer {
  /** The renderer's root, in `container`. */
  readonly root: HTMLElement;
  /** The answer's item. */
  readonly answer: HTMLElement;
  /** One event, drawn as it arrives. */
  push(event: AnswerWireEvent): void;
  /** Back to an empty answer, for another stream. */
  reset(): void;
  /** Everything stopped and taken out of the page. */
  destroy(): void;
  /** The answer is whole (`done` drawn) or failed. */
  readonly ended: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Mount one answer's drawing in `container`. */
export function mountAnswer(container: HTMLElement, o: MountOptions): MountedAnswer {
  const doc = container.ownerDocument;
  const { root, shell } = chatShell(doc, o.theme, o.scheme ?? null);
  // The panel is the templates' holder only; the answer is shown in a list of its own.
  shell.hidden = true;
  if (o.images) hostImages(shell, o.images);
  const components = shell.querySelector<HTMLElement>('[data-az-chat-parts]');
  const transcript = shell.querySelector<HTMLElement>('[data-az-chat-transcript]');
  const template = shell.querySelector<HTMLElement>('[data-az-chat-templates] .az-chat-message--site');
  if (!transcript || !template) throw new Error('mountAnswer: the theme has no transcript or answer template');
  const list = transcript.cloneNode(false) as HTMLElement;
  list.removeAttribute('data-az-chat-transcript');
  list.removeAttribute('tabindex');
  list.setAttribute('aria-label', CHAT_TEXT.region);
  root.append(list);
  container.append(root);
  const config: AnswerConfig = { show: o.components as AnswerConfig['show'], to: o.destinations ?? [] };
  const prose = proseTemplatesOf(shell);
  const kit = busyKitOf(shell);
  const reduced = () => doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
  let ac = new AbortController();
  let copies = 0;
  let answer = template.cloneNode(true) as HTMLElement;
  let live: LiveAnswer;
  let ended = false;
  const copyCode = (code: Element) => o.onCopy?.(code.textContent ?? '');
  const start = () => {
    const signal = ac.signal;
    const watch = resizeWatch(doc, signal);
    const place: Place = {
      within: answer, base: o.backend ?? '', signal,
      ...(watch ? { observe: watch } : {}),
      ...(o.onAsk ? { ask: o.onAsk } : {}),
      ...(o.onAnnounce ? { announce: o.onAnnounce } : {}),
      drawMap: (d, data) => drawMap({ ...d, tiles: o.tiles ?? null }, data),
    };
    answer.setAttribute('aria-busy', 'true');
    list.replaceChildren(answer);
    const drawn = answerDrawer(doc, answer, prose, copyCode, signal, o.onAsk ?? null, () => undefined, true);
    live = liveAnswer({ doc, item: answer, drawn, components, config, place, kit, suffix: () => `m${++copies}`, reduced, after: () => undefined });
    live.begin();
  };
  start();
  return {
    root,
    get answer() { return answer; },
    get ended() { return ended; },
    push(e) {
      if (ended || !isRecord(e) || !WIRE_EVENTS.includes(e.type)) return;
      if (e.type === 'text') {
        if (typeof e.s === 'string') live.text(e.s);
      } else if (e.type === 'hold') {
        if (typeof e.word === 'string' && RICH_BLOCKS.includes(e.word)) live.hold(e.word);
      } else if (e.type === 'block') {
        if (!isRecord(e.block)) return;
        const said = live.block(e.block);
        if (said) o.onAnnounce?.(said);
      } else if (e.type === 'done') {
        ended = true;
        const follows = live.finish();
        answer.setAttribute('aria-busy', 'false');
        if (o.onCopy) answerBar(kit?.bar ?? null, answer, o.onCopy, ac.signal);
        o.onAnnounce?.(follows > 0 ? `${CHAT_TEXT.answered} ${CHAT_TEXT.follows(follows)}` : CHAT_TEXT.answered);
      } else {
        // A failed answer keeps what it drew; its signs go.
        ended = true;
        live.stop();
        answer.setAttribute('aria-busy', 'false');
      }
    },
    reset() {
      ac.abort();
      ac = new AbortController();
      ended = false;
      answer = template.cloneNode(true) as HTMLElement;
      start();
    },
    destroy() {
      ac.abort();
      root.remove();
    },
  };
}
