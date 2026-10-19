/**
 * @az runtime chat-answer-view
 * Purpose: one answer drawn from its events — prose through the markdown subset, each component into a filled copy of its template, the working signs, follow-ups last.
 * Spec: docs/chat-block-spec.md §5.4, §9, §19.18, §20, §21.1, §21.3, §21.4, §22.3
 * Exports: resizeWatch, answerDrawer, AnswerDraw, drawBlock, Place, MapDrawer, AnswerConfig, ready, suffixIds, setDestination, partFor, liveAnswer, LiveAnswer, LiveAnswerOptions
 * Edit guide: answers are textContent in copies of the shell's templates, never markup; the one URL write is setDestination,
 *   right after the allow-list check; nothing here knows where the events came from.
 * Tests: packages/overlay/test/chat.test.ts, scripts/chat-e2e.mjs, scripts/chat-lib-e2e.mjs
 */

/**
 * The drawing an az site's panel did inside its controller (overlay chat.ts),
 * moved here so the panel, the shared-answer page, a kept conversation and
 * an app's <AzAnswer> all draw an answer with one code (chat-block-spec
 * §22.3). It reads only the shell's templates — the page's own, or one built
 * from a theme (chat-templates.ts) — and the events the answer checker sent.
 *
 * Imports only its siblings.
 */

import { BLOCK_LIMITS, CHAT_TEXT, allowedDestination, blockCopy, blockOf, linkKind, type ChatBlock, type ChatConfig } from './chat-logic.ts';
import { drawRich, type RichDraw } from './chat-draw.ts';
import { drawExplore } from './chat-explore-draw.ts';
import { followUps, proseWriter, type ProseTemplates } from './chat-prose.ts';
import type { BusyKit } from './chat-busy.ts';

/** What an answer's drawing needs of its chat: what it may show and the only destinations it may link to. */
export type AnswerConfig = Pick<ChatConfig, 'show' | 'to'>;

/** What chat-map-draw.ts drawMap is to this module: a drawer, with what ends its map and how it speaks. */
export type MapDrawer = (d: RichDraw & { readonly signal: AbortSignal; readonly announce?: (text: string) => void }, data: unknown) => { el: HTMLElement; said: string } | null;

/** An answer as it is drawn (live, restored or shared): prose and components in the order they came, then its follow-ups. */
export interface AnswerDraw {
  text(s: string): void;
  part(el: HTMLElement): void;
  ask(q: string): void;
  /** The answer is whole: its follow-up questions are drawn last, and how many there are is returned. */
  finish(): number;
}

/**
 * The drawing of one answer into `item`, a copy of the answer template. The
 * prose after the last component is the open piece, redrawn as it grows
 * through the markdown subset (chat-prose.ts); a component closes it.
 * `asking` is what a follow-up's button does — none on the shared page, which
 * has no conversation to continue. `focusable` makes an answer that holds
 * components a stop in the Tab order (§9).
 */
export function answerDrawer(
  doc: Document, item: HTMLElement, prose: ProseTemplates | null, copy: (code: Element) => void, signal: AbortSignal,
  asking: ((q: string) => void) | null, after: () => void, focusable: boolean,
): AnswerDraw {
  const model = item.querySelector(':scope > p')?.cloneNode(false) as HTMLElement | undefined;
  // The template's empty paragraph goes: an answer that opens with a component has no prose before it.
  item.replaceChildren();
  let piece = '';
  let writer = proseWriter(doc, item, model, prose, copy, signal);
  const asks: string[] = [];
  return {
    text(s) {
      piece += s;
      writer.update(piece);
      after();
    },
    part(el) {
      item.append(el);
      piece = '';
      writer = proseWriter(doc, item, model, prose, copy, signal);
      // §9: an answer with components is a stop in the Tab order, named as one.
      if (focusable && !item.hasAttribute('tabindex')) {
        item.tabIndex = 0;
        item.setAttribute('aria-label', CHAT_TEXT.region);
      }
      after();
    },
    ask(q) {
      if (asks.length < BLOCK_LIMITS.asks && !asks.includes(q)) asks.push(q);
    },
    finish() {
      const list = asking ? followUps(prose, asks, asking, signal) : null;
      if (!list) return 0;
      item.append(list);
      after();
      return asks.length;
    },
  };
}

/** The marker the chat word's templates carry where a value goes (core emit-contract fromMark). */
const mark = (prop: string) => `${prop}`;

/** Attributes holding ONE id, then a list of ids (target-web ids.ts, the same lists). */
const SINGLE = ['for', 'list', 'form', 'aria-controls', 'aria-activedescendant', 'aria-details', 'aria-errormessage'];
const LIST = ['aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-flowto', 'headers'];

/**
 * A filled copy made ready for the page: every id and radio group given
 * `suffix`, every reference rewritten with it, and the behaviour marks the
 * template parked put back — so the behaviour runtime's observer wires this
 * copy (an FAQ's disclosures, a pricing switch), never the template.
 */
export function ready(copy: Element, suffix: string): void {
  suffixIds(copy, suffix);
  restore(copy);
}

/** The behaviour marks a template parked, put back; the part's own marks taken off. */
function restore(copy: Element): void {
  for (const el of [copy, ...copy.querySelectorAll('[data-az-chat-behaviour]')]) {
    const behaviour = el.getAttribute('data-az-chat-behaviour');
    if (behaviour === null) continue;
    el.removeAttribute('data-az-chat-behaviour');
    el.setAttribute('data-az-behaviour', behaviour);
  }
  copy.removeAttribute('data-az-chat-part');
  copy.removeAttribute('data-az-chat-quote');
  copy.removeAttribute('data-az-chat-plans');
}

/** Every id inside `root` (and its radio groups) given `suffix`, and every reference to one rewritten. */
export function suffixIds(root: Element, suffix: string): void {
  const all = [root, ...root.querySelectorAll('*')];
  const ids = new Map<string, string>();
  for (const el of all) if (el.id) ids.set(el.id, `${el.id}-${suffix}`);
  for (const el of all) {
    if (el.id) el.id = ids.get(el.id)!;
    for (const a of SINGLE) {
      const v = el.getAttribute(a);
      if (v !== null && ids.has(v)) el.setAttribute(a, ids.get(v)!);
    }
    for (const a of LIST) {
      const v = el.getAttribute(a);
      if (v !== null) el.setAttribute(a, v.split(/\s+/).map((id) => ids.get(id) ?? id).join(' '));
    }
    if (el.getAttribute('type') === 'radio' && el.hasAttribute('name')) el.setAttribute('name', `${el.getAttribute('name')}-${suffix}`);
  }
}

/**
 * Each marker in `root` replaced by its value, as text. A marker with no
 * value takes its element with it when it was all that element held (a
 * list item's empty description). Values are only ever text nodes' data.
 */
function fillMarks(doc: Document, root: Element, values: Readonly<Record<string, string>>): void {
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes('')) found.push(n as Text);
  for (const node of found) {
    const prop = Object.keys(values).find((k) => node.data === mark(k));
    const value = prop === undefined ? '' : values[prop];
    const parent = node.parentElement;
    if (value === '' && parent && parent !== root && parent.childNodes.length === 1) parent.remove();
    else node.data = value;
  }
}

/** The one place a URL is written: a destination the shell's own allow-list holds, checked again right here. */
export function setDestination(anchor: Element, config: AnswerConfig, to: string): boolean {
  if (anchor.tagName !== 'A' || !allowedDestination(config, to)) return false;
  anchor.setAttribute('href', to);
  return true;
}

/** A template part by what it is (and, for a quote, which block) — compared as strings, never built into a selector. */
export function partFor(components: HTMLElement | null, key: string, quote: string | null = null): HTMLElement | null {
  if (!components) return null;
  for (const el of components.children) {
    if (el.getAttribute('data-az-chat-part') === key && (quote === null || el.getAttribute('data-az-chat-quote') === quote)) return el as HTMLElement;
  }
  return null;
}

/**
 * One component as a filled copy of its template, with what the status
 * region says of it — or null when the shell has no template for it, the
 * page does not show it, or (a call to action) its destination is not one
 * of the shell's own. Nothing here is markup from the network: values are
 * text, the one URL is a checked destination.
 */
/**
 * Where a drawn component sits and how its chart follows its width (rich components only); for an explore, what ends
 * its listeners, how its send form asks (none on the shared page) and how its summaries are said.
 */
export interface Place {
  readonly within: HTMLElement;
  readonly base: string;
  readonly signal: AbortSignal;
  readonly observe?: (el: Element, redraw: () => void) => () => void;
  readonly ask?: (q: string) => void;
  readonly announce?: (text: string) => void;
  /** The site's map drawer (ChatOptions.drawMap); absent, a map is not drawn. */
  readonly drawMap?: MapDrawer;
}

export function drawBlock(doc: Document, p: { readonly components: HTMLElement | null }, config: AnswerConfig, block: ChatBlock, suffix: string, place: Place): { el: HTMLElement; said: string } | null {
  const shows = (w: string) => (config.show as readonly string[]).includes(w);
  // A follow-up question is the answer's, drawn by its caller after the rest (answerDrawer).
  if (block.kind === 'ask') return null;
  if (block.kind === 'rich') {
    // A rich component the page shows (its note is the server's, for any of them); checked and drawn by chat-draw.ts.
    const shown = block.word === 'unavailable' ? config.show.some((w) => ['chart', 'table', 'stats', 'cards', 'dashboard', 'explore', 'map'].includes(w)) : shows(block.word);
    if (!shown || !p.components) return null;
    const draw = {
      doc, components: p.components, allowed: (to: string) => allowedDestination(config, to), link: (a: Element, to: string) => setDestination(a, config, to), backend: place.base,
      within: place.within, suffix, ...(place.observe ? { observe: place.observe } : {}), ...(place.announce ? { announce: place.announce } : {}),
    };
    const made = block.word === 'explore'
      ? drawExplore({ ...draw, signal: place.signal, ...(place.ask ? { ask: place.ask } : {}), ...(place.announce ? { announce: place.announce } : {}) }, block.data)
      : block.word === 'map'
        ? place.drawMap?.({ ...draw, signal: place.signal, ...(place.announce ? { announce: place.announce } : {}) }, block.data) ?? null
        : drawRich(draw, block.word, block.data);
    if (made) restore(made.el);
    return made;
  }
  if (block.kind === 'quote') {
    const template = shows('pricing') ? partFor(p.components, 'quote', `${block.route}#${block.n}`) : null;
    if (!template) return null;
    const plans = Number(template.getAttribute('data-az-chat-plans') ?? '0');
    const copy = template.cloneNode(true) as HTMLElement;
    ready(copy, suffix);
    return { el: copy, said: blockCopy(block, Number.isInteger(plans) ? plans : 0) };
  }
  if (block.kind === 'cta') {
    const kind = linkKind(block.to);
    const template = shows('cta') && kind ? partFor(p.components, `cta-${kind}`) : null;
    if (!template) return null;
    const copy = template.cloneNode(true) as HTMLElement;
    const anchor = copy.firstElementChild;
    if (!anchor || !setDestination(anchor, config, block.to)) return null;
    fillMarks(doc, copy, { label: block.label });
    ready(copy, suffix);
    return { el: copy, said: blockCopy(block) };
  }
  const template = shows(block.kind) ? partFor(p.components, block.kind) : null;
  const list = template?.firstElementChild;
  const item = list?.firstElementChild;
  if (!template || !list || !item) return null;
  const copy = template.cloneNode(false) as HTMLElement;
  const filled = list.cloneNode(false) as HTMLElement;
  const rows: Readonly<Record<string, string>>[] = block.kind === 'faq'
    ? block.items.map((i) => ({ question: i.q, text: i.a }))
    : block.items.map((i) => ({ title: i.title, text: i.text }));
  rows.forEach((values, i) => {
    const row = item.cloneNode(true) as HTMLElement;
    fillMarks(doc, row, values);
    // Each row its own ids: the template's item is one, an answer's rows are many.
    suffixIds(row, `${suffix}-${i + 1}`);
    filled.append(row);
  });
  copy.append(filled);
  restore(copy);
  return { el: copy, said: blockCopy(block) };
}

export interface LiveAnswerOptions {
  readonly doc: Document;
  /** The answer's item: a copy of the answer template, in the transcript. */
  readonly item: HTMLElement;
  readonly drawn: AnswerDraw;
  /** The shell's components, the chat's rules, and where each component sits. */
  readonly components: HTMLElement | null;
  readonly config: AnswerConfig;
  readonly place: Place;
  /** The working signs (chat-busy.ts); none in a shell from before them. */
  readonly kit: BusyKit | null;
  /** Each drawn component's own suffix for its ids. */
  readonly suffix: () => string;
  /** The visitor asked for less motion: no caret, no movement. */
  readonly reduced: () => boolean;
  /** Something was added at the answer's end: the transcript may follow it. */
  readonly after: () => void;
  /** The working signs went: a placeholder taller than what replaced it may have moved the transcript. */
  readonly settled?: () => void;
}

/** One answer as its events arrive: what each draws, and what the status region is to say of a component. */
export interface LiveAnswer {
  /** Its place shows that it is coming: dots until the first words or component. */
  begin(): void;
  text(s: string): void;
  /** A rich component is being read (issue #28): a placeholder of its shape at the end. */
  hold(word: string): void;
  /** A component's event: drawn, its status line returned; null when it is not drawn (a follow-up waits for the end). */
  block(raw: Record<string, unknown>): string | null;
  /** The answer is whole: the signs go, the follow-ups are drawn; how many there are. */
  finish(): number;
  /** It stopped before its end: the signs go. */
  stop(): void;
  /** Something of it is drawn — words or a component. */
  readonly shown: boolean;
}

/**
 * The live drawing of one answer (issues #28, #30; §21.1.3): the dots until
 * its first words, a caret while words arrive, a held component's
 * placeholder, then the component moving in — none of it moving under
 * reduced motion — and its follow-up questions after the rest.
 */
export function liveAnswer(o: LiveAnswerOptions): LiveAnswer {
  let waiting: HTMLElement | null = null;
  let held: HTMLElement | null = null;
  let shown = false;
  const settleSigns = () => {
    if (!waiting && !held) return;
    o.kit?.remove(waiting);
    o.kit?.remove(held);
    waiting = null;
    held = null;
    o.settled?.();
  };
  return {
    begin() {
      waiting = o.kit?.thinking(o.reduced()) ?? null;
      if (waiting) {
        o.item.append(waiting);
        // The dots are a line of the answer: the transcript follows them.
        o.after();
      }
    },
    text(s) {
      // The first words take the dots' place; a caret follows the words while they arrive (none under reduced motion).
      settleSigns();
      o.drawn.text(s);
      shown = true;
      if (!o.reduced()) o.kit?.caret(o.item);
    },
    hold(word) {
      settleSigns();
      o.kit?.dropCaret();
      held = o.kit?.skeleton(word, o.reduced()) ?? null;
      if (held) {
        o.item.append(held);
        o.after();
      }
    },
    block(raw) {
      const block = blockOf(raw);
      if (!block) return null;
      // A follow-up question waits for the end of the answer (§21.1.3).
      if (block.kind === 'ask') { o.drawn.ask(block.q); return null; }
      settleSigns();
      // A component the shell has no template for, or does not show, is not drawn.
      const made = drawBlock(o.doc, { components: o.components }, o.config, block, o.suffix(), o.place);
      if (!made) return null;
      o.kit?.dropCaret();
      o.drawn.part(made.el);
      shown = true;
      o.kit?.enter(made.el, o.reduced(), false);
      return made.said;
    },
    finish() {
      settleSigns();
      o.kit?.dropCaret();
      return o.drawn.finish();
    },
    stop() {
      settleSigns();
      o.kit?.dropCaret();
    },
    get shown() { return shown; },
  };
}

/** One ResizeObserver per shell for its charts: each redraws only when its own width moves (chat-draw.ts). */
export function resizeWatch(doc: Document, signal: AbortSignal): ((el: Element, redraw: () => void) => () => void) | undefined {
  const Observer = doc.defaultView?.ResizeObserver;
  if (!Observer) return undefined;
  const redraws = new Map<Element, () => void>();
  const ro = new Observer((entries) => { for (const e of entries) redraws.get(e.target)?.(); });
  signal.addEventListener('abort', () => ro.disconnect(), { once: true });
  return (el, redraw) => {
    redraws.set(el, redraw);
    ro.observe(el);
    return () => { ro.unobserve(el); redraws.delete(el); };
  };
}
