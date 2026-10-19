/**
 * @az runtime chat
 * Purpose: runs a `chat` panel: sends a question to the site's backend, reads the answer's event stream, writes it as text.
 * Spec: docs/chat-block-spec.md §3.2, §4.2, §5.4, §7, §9, §19.18, §20, §21.1, §21.3, §21.4
 * Exports: attachChat, ChatOptions, MapDrawer
 * Edit guide: answers are textContent in copies of the shell's templates, never markup; each shell once (late content via MutationObserver); attachChat() returns full cleanup.
 * Tests: packages/overlay/test/chat.test.ts, packages/overlay/test/chat-float.test.ts, scripts/chat-e2e.mjs
 */

/**
 * The runtime of a `chat` block (chat-block-spec §7).
 *
 * The page is pre-rendered with a shell the chat word made: the greeting, a
 * hidden form, hidden templates of a visitor message and an answer, a note,
 * an error line, the follow-up buttons and a polite status region. This
 * finds each shell, shows the form to whoever may ask (signed-in visitors
 * by default — the auth adapter says who is signed in), and on each
 * question:
 *
 *   - POSTs it with the conversation so far to `<backend>/chat` with the
 *     browser's cookie and the CSRF header — `fetch`, because `EventSource`
 *     can neither POST nor send a header;
 *   - reads the response body as server-sent events (chat-logic.ts) and
 *     writes each piece of prose with `textContent` into a copy of the
 *     answer template — nothing from the network is ever parsed as markup;
 *   - keeps the conversation in the visitor's own browser (C5,
 *     chat-history.ts): capped, expiring after 7 days, restored on the next
 *     visit; Clear history is offered once there is something kept, and
 *     the note on where it is kept sits behind an info control; where storage is
 *     refused it is kept in memory only, as before. It is bound to who read
 *     the session — a salted hash of the account, or the browser for a
 *     visitor nobody signed in — and cleared before anything is drawn when
 *     that changes; two tabs on one chat stay in step through `storage`
 *     events, and a tab that cannot keep its answer says so (§19.11);
 *   - sends a long conversation's latest whole exchanges that fit the
 *     server's request cap (`from`), and says once that older ones are not
 *     sent;
 *   - draws prose through the markdown subset (chat-markdown.ts read,
 *     chat-prose.ts drawn — fixed elements, text leaves) and an answer's
 *     follow-up questions as buttons that ask them;
 *   - gives the status region whole sentences, at most one update every
 *     1.5 s, never tokens; the transcript itself is not a live region;
 *   - shows that it is working (§19.18, chat-busy.ts): the answer's place at
 *     Send, holding dots until its first words, a caret while words arrive,
 *     a placeholder of a held component's shape (the server's `hold`); new
 *     messages move in — nothing moves under reduced motion; and ends each
 *     finished answer with its bar, Copy and Share (chat-bar.ts).
 *
 * A rich component (chat, table, stats, cards, dashboard — §20) is drawn by
 * chat-draw.ts into its templates, an explore (§21.3) by chat-explore-draw.ts,
 * whose controls recompute its views in the page and whose send form asks
 * through the same `ask` as typing; a map (§21.4) by the `drawMap` a site
 * that shows maps passes in (chat-map-draw.ts), so no other site carries any
 * map code; an answer whose `done` carries share
 * tags gets the Share control (chat-shared.ts). On the build's
 * shared-answer page the shell is read-only: it reads one stored answer by
 * the link's fragment and draws it the same way (runShared).
 *
 * The transcript follows the newest words only while the visitor is at its
 * end; scrolling away stops it and shows Jump to latest (§9) — but not over
 * the start of an answer that has just arrived. The input is one line and
 * grows with its text to a cap. An answer that
 * holds components becomes a stop in the Tab order. A `chat float`'s
 * launcher opens the panel in its dialog: below the shell's narrow width as
 * the overlay engine's sheet — modal, focus trapped, the page locked — and
 * above it as a side panel that does not trap; opening moves focus to the
 * input, Escape stops an answer and then closes, and closing returns focus
 * to the launcher.
 *
 * Touches nothing at import time. The returned cleanup aborts every request
 * and timer, removes every listener and puts each shell back as it shipped.
 * Imports only its siblings.
 */

import {
  ANSWER_MAX, BLOCK_LIMITS, CHAT_TEXT, RETRYABLE, SHARE_TAG_MAX_MS, allowedDestination, atEnd, blockCopy, blockOf, createEventReader, finishedSentences, floatPreset, inputRows, leftCopy, linkKind, mayFollow, offersLatest,
  mergeText, parseChatConfig, problemCopy, readShareLink, requestBody, SHARE_TEXT, visitorText, type ChatBlock, type ChatConfig, type ChatTurn, type ShareTags,
} from './chat-logic.ts';
import { FOCUSABLE, lockScroll, wireSheetDrag } from './behaviours.ts';
import { trapIndex } from './logic.ts';
import { POLICY } from './policy.ts';
import { drawRich, type RichDraw } from './chat-draw.ts';
import { drawExplore } from './chat-explore-draw.ts';
import { shareControl } from './chat-shared.ts';
import { spokenText } from './chat-markdown.ts';
import { followUps, proseTemplatesOf, proseWriter, type ProseTemplates } from './chat-prose.ts';
import { browserStorage, createHistory, historyKeyOf, turnsOf, type StoredChat, type StoredTurn } from './chat-history.ts';
import { busyKitOf, type BusyKit } from './chat-busy.ts';
import { answerBar, wireTips } from './chat-bar.ts';

export interface ChatOptions {
  /** The backend's base URL (AZ_PUBLIC_BACKEND_URL); the panel posts to `<base>/chat`. */
  readonly base: string;
  /**
   * The signed-in account's id, or null for nobody — the auth adapter's
   * session read. It decides who may ask, and whom the kept chat is bound to
   * (as a salted hash, chat-history.ts; the id itself is never stored).
   */
  readonly account?: () => Promise<string | null>;
  /** Called whenever the visitor signs in, out, or as someone else; returns its unsubscribe. */
  readonly onSession?: (fn: (account: string | null) => void) => () => void;
  /** The fetch to send with; the page's own by default. */
  readonly fetch?: typeof fetch;
  /**
   * Draws a map (§21.4, chat-map-draw.ts) — given only by a site whose chat
   * shows maps, so a site without them ships no map code; without it a map
   * is not drawn.
   */
  readonly drawMap?: MapDrawer;
}

/** What chat-map-draw.ts drawMap is to this module: a drawer, with what ends its map and how it speaks. */
export type MapDrawer = (d: RichDraw & { readonly signal: AbortSignal; readonly announce?: (text: string) => void }, data: unknown) => { el: HTMLElement; said: string } | null;

/** §9: the status region hears at most one update in this long. */
const ANNOUNCE_MS = 1500;
/** An answer the server has not finished by now is ended here (the server's own cap is 60 s by default). */
const ANSWER_DEADLINE_MS = 90_000;

type Cleanup = () => void;
type Mode = 'checking' | 'ready' | 'signin' | 'full';

interface Parts {
  readonly host: HTMLElement;
  readonly transcript: HTMLElement;
  readonly visitorTemplate: HTMLElement;
  readonly siteTemplate: HTMLElement;
  readonly asks: HTMLElement | null;
  readonly form: HTMLFormElement;
  readonly input: HTMLTextAreaElement;
  readonly send: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly note: HTMLElement;
  readonly error: HTMLElement;
  readonly actions: HTMLElement;
  readonly retry: HTMLButtonElement;
  readonly reset: HTMLButtonElement;
  readonly signin: HTMLElement | null;
  readonly status: HTMLElement;
  /** The hidden templates of the components answers may hold; null for a prose-only chat. */
  readonly components: HTMLElement | null;
  /** §9: Jump to latest, shown once the visitor scrolls away from the newest words. */
  readonly latest: HTMLButtonElement | null;
  /**
   * C5: the prose templates (null in a shell from before C5), and the history controls — Clear history, shown once
   * there is a kept chat, and the info control with the note it shows (null in a shell from before them).
   */
  readonly prose: ProseTemplates | null;
  readonly history: {
    readonly box: HTMLElement;
    readonly clear: HTMLButtonElement;
    readonly about: { readonly button: HTMLButtonElement; readonly note: HTMLElement } | null;
  } | null;
  /** A float's launcher, its dialog and the dialog's Close; null for a panel. */
  readonly float: { readonly launcher: HTMLButtonElement; readonly dialog: HTMLDialogElement; readonly close: HTMLButtonElement } | null;
  /** Issues #28, #30: the working signs and the answer bar's template (chat-busy.ts); null in a shell from before them. */
  readonly busy: BusyKit | null;
}

function partsOf(host: HTMLElement): Parts | null {
  const one = <T extends Element>(attr: string): T | null => host.querySelector<T>(`[${attr}]`);
  const templates = one<HTMLElement>('data-az-chat-templates');
  const transcript = one<HTMLElement>('data-az-chat-transcript');
  const form = one<HTMLFormElement>('data-az-chat-form');
  const input = one<HTMLTextAreaElement>('data-az-chat-input');
  const send = one<HTMLButtonElement>('data-az-chat-send');
  const stop = one<HTMLButtonElement>('data-az-chat-stop');
  const note = one<HTMLElement>('data-az-chat-note');
  const error = one<HTMLElement>('data-az-chat-error');
  const actions = one<HTMLElement>('data-az-chat-actions');
  const retry = one<HTMLButtonElement>('data-az-chat-retry');
  const reset = one<HTMLButtonElement>('data-az-chat-reset');
  const status = one<HTMLElement>('data-az-chat-status');
  const visitorTemplate = templates?.querySelector<HTMLElement>('.az-chat-message--visitor') ?? null;
  const siteTemplate = templates?.querySelector<HTMLElement>('.az-chat-message--site') ?? null;
  if (!transcript || !form || !input || !send || !stop || !note || !error || !actions || !retry || !reset || !status
      || !visitorTemplate || !siteTemplate) return null;
  const launcher = one<HTMLButtonElement>('data-az-chat-launcher');
  const dialog = host.querySelector('dialog');
  const close = one<HTMLButtonElement>('data-az-chat-close');
  const historyBox = one<HTMLElement>('data-az-chat-history');
  const clear = historyBox?.querySelector<HTMLButtonElement>('[data-az-chat-clear]') ?? null;
  const about = historyBox?.querySelector<HTMLButtonElement>('[data-az-chat-about]') ?? null;
  const privacy = one<HTMLElement>('data-az-chat-privacy');
  return {
    host, transcript, visitorTemplate, siteTemplate, form, input, send, stop, note, error, actions, retry, reset, status,
    asks: one<HTMLElement>('data-az-chat-asks'),
    signin: one<HTMLElement>('data-az-chat-signin'),
    components: one<HTMLElement>('data-az-chat-parts'),
    latest: one<HTMLButtonElement>('data-az-chat-latest'),
    prose: proseTemplatesOf(host),
    history: historyBox && clear ? { box: historyBox, clear, about: about && privacy ? { button: about, note: privacy } : null } : null,
    float: launcher && dialog && close ? { launcher, dialog, close } : null,
    busy: busyKitOf(host),
  };
}

/** An answer as it is drawn (live, restored or shared): prose and components in the order they came, then its follow-ups. */
interface AnswerDraw {
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
function answerDrawer(
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
function ready(copy: Element, suffix: string): void {
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
function suffixIds(root: Element, suffix: string): void {
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
function setDestination(anchor: Element, config: ChatConfig, to: string): boolean {
  if (anchor.tagName !== 'A' || !allowedDestination(config, to)) return false;
  anchor.setAttribute('href', to);
  return true;
}

/** A template part by what it is (and, for a quote, which block) — compared as strings, never built into a selector. */
function partFor(components: HTMLElement | null, key: string, quote: string | null = null): HTMLElement | null {
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
interface Place {
  readonly within: HTMLElement;
  readonly base: string;
  readonly signal: AbortSignal;
  readonly observe?: (el: Element, redraw: () => void) => () => void;
  readonly ask?: (q: string) => void;
  readonly announce?: (text: string) => void;
  /** The site's map drawer (ChatOptions.drawMap); absent, a map is not drawn. */
  readonly drawMap?: MapDrawer;
}

function drawBlock(doc: Document, p: Pick<Parts, 'components'>, config: ChatConfig, block: ChatBlock, suffix: string, place: Place): { el: HTMLElement; said: string } | null {
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

/** Run one shell. Returns its cleanup. */
function runShell(p: Parts, config: ChatConfig, options: ChatOptions, signal: AbortSignal): Cleanup {
  const send = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const endpoint = `${options.base.replace(/\/+$/, '')}/chat`;
  const hideable: HTMLElement[] = [p.form, p.stop, p.send, p.error, p.actions, p.retry, p.reset,
    ...(p.asks ? [p.asks] : []), ...(p.signin ? [p.signin] : []), ...(p.latest ? [p.latest] : []), ...(p.float ? [p.float.launcher] : []),
    ...(p.history ? [p.history.box, p.history.clear, ...(p.history.about ? [p.history.about.note] : [])] : [])];
  const shipped = new Map(hideable.map((el) => [el, el.hidden] as const));
  const greeting = [...p.transcript.children].map((c) => c.cloneNode(true));

  let mode: Mode = 'checking';
  let history: ChatTurn[] = [];
  /** C5 (§21.1.4): the conversation as kept in this browser — each answer with its events, to draw it again. */
  const kept = createHistory(browserStorage(p.host.ownerDocument.defaultView));
  const keptKey = historyKeyOf(config);
  let stored: StoredTurn[] = [];
  /** §19.11: the revision of the kept conversation this tab last drew or saved (0: none); whom the session last said was reading. */
  let rev = 0;
  let reader: string | null | undefined;
  /** §19.11: this conversation sends only its latest exchanges now (the visitor was told). */
  let trimmed = false;
  /** The kept conversation is read once, when the panel first lets the visitor ask. */
  let restoreDue = true;
  let conversation: string | null = null;
  /** The question being answered, until a tagged answer joins it to the history. */
  let pending: string | null = null;
  /** How the pending question was asked (§19.17): by a suggested question's button, by "Ask the AI instead", or typed. */
  let pendingVia: 'suggested' | 'model' | null = null;
  let streaming: AbortController | null = null;
  let stopping = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAnnounce = -Infinity;
  let queued = '';
  let live = true;
  /** Bumped by a new chat: a request from before it must not touch the panel after. */
  let generation = 0;
  /** Components drawn so far: each copy's ids get their own suffix. */
  let copies = 0;
  const doc = p.host.ownerDocument;
  const watch = observer(doc, signal);
  // A chart redrawn for its own width can change its height after the transcript last followed: it follows again (§9).
  const resizes = watch ? (el: Element, redraw: () => void) => watch(el, () => { redraw(); follow(); }) : undefined;
  const place = (within: HTMLElement): Place => ({
    within, base: options.base, signal, observe: resizes,
    // An explore's send form asks as a follow-up does; its summaries are said at once, it keeps them to one in 1.5 s itself.
    ask: (q) => ask(q), announce: (t) => announce(t, true),
    ...(options.drawMap ? { drawMap: options.drawMap } : {}),
  });

  const setState = (state: string) => p.host.setAttribute('data-az-chat-state', state);
  const win = doc.defaultView;
  const reduced = () => win?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;

  /* ---- §9: the transcript follows the newest words while the visitor is at its end ---- */
  let following = true;
  /** Where the transcript was at its last scroll event, or where following last put it (chat-logic mayFollow). */
  let known = 0;
  /** Jump to latest is scrolling there: the positions it passes are not the visitor scrolling up. */
  let jumping = false;
  /** Follow from wherever the transcript is now: the visitor asked, or the float opened. */
  const resume = () => {
    following = true;
    known = 0;
  };
  const follow = () => {
    if (!mayFollow(following, p.transcript.scrollTop, known)) return;
    p.transcript.scrollTop = p.transcript.scrollHeight;
    known = p.transcript.scrollTop;
  };
  /** Where the newest answer begins, from the transcript's visible top — null until one has arrived (chat-logic offersLatest). */
  const newestStart = (): number | null => {
    const last = p.transcript.lastElementChild;
    if (!last || !last.classList.contains('az-chat-message--site') || last.getAttribute('aria-busy') === 'true') return null;
    return last.getBoundingClientRect().top - p.transcript.getBoundingClientRect().top;
  };
  /** §9, issue #2: Jump to latest only away from the newest words — never over the start of an answer just arrived. */
  const placeLatest = (end: boolean) => {
    if (p.latest) p.latest.hidden = !offersLatest(end, newestStart(), p.transcript.clientHeight);
  };
  const onScroll = () => {
    known = p.transcript.scrollTop;
    const end = atEnd(p.transcript.scrollTop, p.transcript.scrollHeight, p.transcript.clientHeight);
    if (jumping && !end) return;
    jumping = false;
    following = end;
    placeLatest(end);
  };

  /** A flush already happened in this task: a screen reader hears the region as the task leaves it, so a second one joins it. */
  let flushedNow = false;
  const flushAnnounce = () => {
    announceTimer = null;
    if (!live || queued === '') return;
    lastAnnounce = Date.now();
    const text = flushedNow && p.status.textContent ? `${p.status.textContent} ${queued}` : queued;
    p.status.textContent = '';
    p.status.textContent = text;
    queued = '';
    if (!flushedNow) {
      flushedNow = true;
      queueMicrotask(() => { flushedNow = false; });
    }
  };
  /** §9: whole sentences, batched to at most one update per ANNOUNCE_MS; `now` skips the wait. */
  const announce = (text: string, now = false) => {
    if (text === '') return;
    queued = queued ? `${queued} ${text}` : text;
    if (announceTimer !== null) {
      if (!now) return;
      clearTimeout(announceTimer);
    }
    const wait = now ? 0 : Math.max(0, lastAnnounce + ANNOUNCE_MS - Date.now());
    if (wait === 0) flushAnnounce();
    else announceTimer = setTimeout(flushAnnounce, wait);
  };

  const showError = (text: string, follow: { retry?: boolean; reset?: boolean } = {}) => {
    p.error.textContent = text;
    p.error.hidden = text === '';
    p.retry.hidden = !follow.retry;
    p.reset.hidden = !follow.reset;
    p.actions.hidden = p.retry.hidden && p.reset.hidden && (p.signin?.hidden ?? true);
    if (text) announce(text, true);
  };

  const setMode = (next: Mode) => {
    mode = next;
    const asking = next === 'ready';
    p.form.hidden = !asking;
    if (p.asks) p.asks.hidden = !asking || history.length > 0 || pending !== null;
    if (p.signin) p.signin.hidden = next !== 'signin';
    p.note.textContent = next === 'signin' ? CHAT_TEXT.signin : next === 'full' ? CHAT_TEXT.full : '';
    if (next === 'full') { p.reset.hidden = false; p.retry.hidden = true; }
    p.actions.hidden = !(next === 'signin' && p.signin) && p.reset.hidden && p.retry.hidden;
    setState(next === 'ready' ? 'idle' : next);
    // Busy while the session is read: what the panel offers is not decided yet.
    if (next === 'checking') p.host.setAttribute('aria-busy', 'true');
    else p.host.removeAttribute('aria-busy');
  };

  /** A code block's Copy (§21.1.3): its text, never markup, to the clipboard; the status region says how it went. */
  const copyCode = (code: Element) => {
    const clip = win?.navigator.clipboard;
    const text = code.textContent ?? '';
    if (!clip) { announce(CHAT_TEXT.copyFailed, true); return; }
    clip.writeText(text).then(() => { if (live) announce(CHAT_TEXT.copied, true); }, () => { if (live) announce(CHAT_TEXT.copyFailed, true); });
  };
  /** A follow-up question's button: the same as typing it and pressing Send. */
  const askFollowUp = (q: string) => ask(q);
  const drawerFor = (item: HTMLElement) => answerDrawer(doc, item, p.prose, copyCode, signal, askFollowUp, follow, true);
  /** Issue #30: the answer bar's Copy — the answer's text form to the clipboard; the status region says how it went. */
  const copyAnswer = (text: string) => {
    const clip = win?.navigator.clipboard;
    if (!clip || text === '') { announce(CHAT_TEXT.answerCopyFailed, true); return; }
    clip.writeText(text).then(() => { if (live) announce(CHAT_TEXT.answerCopied, true); }, () => { if (live) announce(CHAT_TEXT.answerCopyFailed, true); });
  };
  /**
   * Issue #30: a finished answer's bar, appended last — after its follow-ups — so it never comes before the answer in Tab
   * order; the transcript follows it, as it does every line the answer adds.
   */
  const barFor = (item: HTMLElement) => {
    answerBar(p.busy?.bar ?? null, item, copyAnswer, signal);
    follow();
  };

  /** One message into the transcript; `moving`, it fades and rises in (issue #28) — never under reduced motion, nor when restored. */
  const addMessage = (who: 'visitor' | 'site', text: string, moving = false): HTMLElement => {
    const item = (who === 'visitor' ? p.visitorTemplate : p.siteTemplate).cloneNode(true) as HTMLElement;
    const para = item.querySelector('p');
    if (para) para.textContent = text;
    p.transcript.append(item);
    if (moving) p.busy?.enter(item, reduced(), true);
    // A question the visitor sends is one they mean to see answered: the transcript follows again.
    if (who === 'visitor') resume();
    follow();
    return item;
  };

  const settle = () => {
    streaming = null;
    p.stop.hidden = true;
    p.send.hidden = false;
  };

  /** Issue #2: the input is one line until its text needs more, then grows to INPUT_MAX_ROWS and scrolls. */
  const grow = () => {
    const el = p.input;
    el.rows = 1;
    const line = Number.parseFloat(win?.getComputedStyle(el).lineHeight ?? '');
    el.rows = inputRows(el.scrollHeight, el.clientHeight, 1, Number.isFinite(line) ? line : 0);
  };
  /** Issue #2: Clear history is offered only when this chat has something kept to clear. */
  const offerClear = () => {
    if (p.history) p.history.clear.hidden = stored.length === 0;
  };

  /** A refusal or a failure, with the fixed copy for its code (never server text). */
  const fail = (code: string, answer: HTMLElement | null) => {
    answer?.remove();
    settle();
    if (code === 'signin_required') { pending = null; setMode('signin'); showError(''); announce(CHAT_TEXT.signin, true); return; }
    if (code === 'conversation_full') { pending = null; setMode('full'); showError(''); announce(CHAT_TEXT.full, true); return; }
    // A kept conversation the server no longer accepts (its key was rotated, §21.1.4): it goes, and the panel starts over.
    if (code === 'tampered') {
      kept.remove(keptKey);
      forget();
      setState(mode === 'ready' ? 'idle' : mode);
      showError(problemCopy(code), { reset: false });
      return;
    }
    const retryable = RETRYABLE.has(code);
    if (!retryable) pending = null;
    setState(mode === 'ready' ? 'idle' : mode);
    showError(problemCopy(code), { retry: retryable, reset: !retryable });
  };

  const request = async () => {
    if (pending === null || streaming) return;
    const question = pending;
    const mine = generation;
    const current = () => live && mine === generation;
    const ac = new AbortController();
    streaming = ac;
    stopping = false;
    setState('streaming');
    p.send.hidden = true;
    p.stop.hidden = false;
    showError('');
    p.note.textContent = '';
    // §9: sending keeps focus in the input, wherever the question came from.
    p.input.focus({ preventScroll: true });
    const deadline = setTimeout(() => ac.abort(), ANSWER_DEADLINE_MS);
    // The answer's position in the messages the server tags it by, and its events as they arrive (§20.7).
    const index = history.length + 1;
    const received: Record<string, unknown>[] = [];
    let text = '';
    let said = 0;
    let finished = false;
    // §19.11: a long conversation sends only its latest whole exchanges that fit the request cap; the visitor is told once.
    const req = requestBody(config.page, conversation, history, question, pendingVia);
    if (req.from > 0 && !trimmed) {
      trimmed = true;
      announce(CHAT_TEXT.trimmed, true);
    }
    // Issue #28: the answer's place, at once — dots in it until its first words or component, said once in the status
    // region; a component the server is still reading stands as a placeholder of its shape. All of it is the answer's
    // until it settles: a refusal or a failure takes it away, a stop before anything arrived too.
    const answer: HTMLElement = addMessage('site', '', true);
    answer.setAttribute('aria-busy', 'true');
    const drawn = drawerFor(answer);
    let waiting: HTMLElement | null = p.busy?.thinking(reduced()) ?? null;
    if (waiting) {
      answer.append(waiting);
      // The dots are a line of the answer: the transcript follows them, or its next scroll event reads it as scrolled away.
      follow();
    }
    let held: HTMLElement | null = null;
    /** Something of the answer is drawn: a stopped answer keeps it (and its bar); with nothing, it goes. */
    let shown = false;
    const settleSigns = () => {
      if (!waiting && !held) return;
      p.busy?.remove(waiting);
      p.busy?.remove(held);
      waiting = null;
      held = null;
      // A placeholder taller than what replaces it lets the browser pull the transcript up: that move is the runtime's, not
      // the visitor scrolling away, so a transcript that was following goes on following (§9).
      if (following) known = Math.min(known, p.transcript.scrollTop);
    };
    announce(CHAT_TEXT.working, true);
    try {
      const res = await send(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-az-request': '1' },
        body: req.body,
        signal: ac.signal,
      });
      if (!res.ok) {
        let code = 'unknown';
        try {
          const body = await res.json() as { error?: unknown };
          if (typeof body?.error === 'string') code = body.error;
        } catch { /* not a JSON refusal: the generic line */ }
        if (current()) fail(code, answer);
        return;
      }
      if (!res.body || !/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) {
        if (current()) fail('unknown', answer);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const events = createEventReader();
      for (;;) {
        const { value, done } = await reader.read();
        const batch = done ? [...events.push(decoder.decode()), ...events.end()] : events.push(decoder.decode(value, { stream: true }));
        if (events.broken) { void reader.cancel(); break; }
        for (const e of batch) {
          if (finished || !current()) break;
          if (e.type === 'text') {
            text += e.s;
            received.push({ type: 'text', s: e.s });
            if (text.length > ANSWER_MAX) { ac.abort(); break; }
            // The first words take the dots' place; a caret follows the words while they arrive (none under reduced motion).
            settleSigns();
            drawn.text(e.s);
            shown = true;
            if (!reduced()) p.busy?.caret(answer);
            const s = finishedSentences(text, said);
            said = s.next;
            announce(spokenText(s.said));
          } else if (e.type === 'hold') {
            // Issue #28: the server is reading a component's figures — a placeholder of its shape stands at the end meanwhile.
            settleSigns();
            p.busy?.dropCaret();
            held = p.busy?.skeleton(e.word, reduced()) ?? null;
            if (held) {
              answer.append(held);
              follow();
            }
          } else if (e.type === 'block') {
            received.push({ type: 'block', block: e.raw });
            // A follow-up question waits for the end of the answer (§21.1.3).
            if (e.block.kind === 'ask') { drawn.ask(e.block.q); continue; }
            settleSigns();
            // A component the shell has no template for, or does not show, is not drawn.
            const made = drawBlock(doc, p, config, e.block, `c${++copies}`, place(answer));
            if (!made) continue;
            // The prose before it is finished: its last words are said first, then the component, once.
            announce(spokenText(finishedSentences(text, said, true).said));
            said = text.length;
            p.busy?.dropCaret();
            drawn.part(made.el);
            shown = true;
            p.busy?.enter(made.el, reduced(), false);
            announce(made.said);
          } else if (e.type === 'done') {
            finished = true;
            settleSigns();
            p.busy?.dropCaret();
            // What the server tagged — prose and the components' lines — is what goes back as history.
            history = [...history, { role: 'visitor', text: question }, { role: 'site', text: e.text, tag: e.tag }];
            conversation = e.conversation;
            // C5 (§21.1.4): kept in this browser, with the events to draw it again — consecutive text joined, as a share
            // holds them, so a model that streams word by word keeps one event per run — and its share tags, so the
            // restored answer can be shared while they last (§19.11); where storage is refused, nothing is.
            stored = [...stored, { role: 'visitor', text: question }, {
              role: 'site', text: e.text, tag: e.tag, events: mergeText(received), ...(e.share ? { share: e.share } : {}),
            }];
            const keptAs = kept.save(keptKey, e.conversation, stored, rev);
            if (keptAs.kept) rev = keptAs.rev;
            offerClear();
            // §19.11: another tab went on with this chat (or cleared it): its turns stand, and this answer is said not to be kept.
            const lost = !keptAs.kept && (keptAs.why === 'conflict' || keptAs.why === 'cleared');
            const follows = drawn.finish();
            // §19.17: an answer the site matched to the question may not be the one wanted — the same question, to the model.
            if (e.by === 'match') {
              const instead = followUps(p.prose, [CHAT_TEXT.askModel], () => ask(question, 'model'), signal);
              if (instead) answer.append(instead);
            }
            // Issue #30: the bar of small actions, last; §20.7: Share joins it when the server makes share links.
            barFor(answer);
            if (e.share && received.length > 0) offerShare(answer, e.conversation, index, e.share, received, question);
            pending = null;
            answer.setAttribute('aria-busy', 'false');
            // The answer has arrived: where the visitor is reading now decides Jump to latest.
            placeLatest(atEnd(p.transcript.scrollTop, p.transcript.scrollHeight, p.transcript.clientHeight));
            announce(spokenText(finishedSentences(text, said, true).said) || CHAT_TEXT.answered, true);
            if (follows > 0) announce(CHAT_TEXT.follows(follows), true);
            settle();
            const left = leftCopy(e.left);
            if (lost) announce(CHAT_TEXT.notKept, true);
            if (e.left <= 0) setMode('full');
            else { setState('idle'); p.note.textContent = [left, lost ? CHAT_TEXT.notKept : '', trimmed ? CHAT_TEXT.trimmed : ''].filter(Boolean).join(' '); }
          } else {
            finished = true;
            fail(e.code, answer);
          }
        }
        if (done || finished || !current()) break;
      }
      if (!finished && current() && !stopping) fail('unavailable', answer);
    } catch {
      if (!current()) return;
      if (stopping) return;
      fail('unavailable', answer);
    } finally {
      clearTimeout(deadline);
      if (current() && stopping && !finished) {
        // Stopped by the visitor: the exchange stays on screen as it was,
        // but it has no tagged answer, so it is not sent again. The working
        // signs go; an answer with nothing drawn yet goes with them, and one
        // with words keeps them, and its bar (Copy; it cannot be shared).
        settleSigns();
        p.busy?.dropCaret();
        if (shown) {
          answer.setAttribute('aria-busy', 'false');
          barFor(answer);
        } else answer.remove();
        pending = null;
        settle();
        setState('idle');
        p.note.textContent = CHAT_TEXT.stopped;
        announce(CHAT_TEXT.stopped, true);
      }
    }
  };

  const ask = (raw: string, via: 'suggested' | 'model' | null = null) => {
    if (mode !== 'ready' || streaming) return;
    const text = visitorText(raw);
    if (text === null) {
      if (raw.trim() !== '') showError(CHAT_TEXT.tooLong);
      return;
    }
    // A new question instead of Try again: the failed one stays on screen, unsent.
    if (pending !== null) showError('');
    pending = text;
    pendingVia = via;
    addMessage('visitor', text, true);
    p.input.value = '';
    grow();
    if (p.asks) p.asks.hidden = true;
    void request();
  };

  const stopAnswer = () => {
    if (!streaming) return;
    stopping = true;
    streaming.abort();
  };

  /** The Share control under an answer (§20.7) — a live one, or a restored one while its share tags last (§19.11). */
  function offerShare(answer: HTMLElement, conv: string, index: number, tags: ShareTags, events: readonly Record<string, unknown>[], question: string): void {
    const shareTemplate = p.components ? partFor(p.components, 'share')?.firstElementChild as HTMLElement | null : null;
    if (!shareTemplate || Date.now() - tags.at > SHARE_TAG_MAX_MS) return;
    const control = shareControl(doc, shareTemplate, {
      base: options.base, page: config.page, conversation: conv, index, tags,
      events, question, fetch: send, announce: (t) => announce(t, true), suffix: `s${++copies}`,
    }, signal);
    if (!control) return;
    // Issue #30: Share is an icon button in the answer's bar, its panel on a row of its own under it (a bar-less shell: the answer's end).
    (answer.querySelector(':scope > .az-chat-bar') ?? answer).append(control);
    wireTips(control, signal);
  }

  /** The conversation gone from the panel and from memory: the greeting alone, nothing pending. */
  function forget(): void {
    // The answer in flight, if any, is abandoned: its request sees a new generation and leaves the panel alone.
    generation++;
    streaming?.abort();
    settle();
    history = [];
    stored = [];
    conversation = null;
    pending = null;
    rev = 0;
    trimmed = false;
    restoreDue = false;
    p.transcript.replaceChildren(...greeting.map((g) => g.cloneNode(true)));
    p.note.textContent = '';
    if (p.asks) p.asks.hidden = mode !== 'ready';
    if (p.latest) p.latest.hidden = true;
    offerClear();
  }

  /** The panel asks again after a full conversation; who may ask is unchanged, so the session is not read again (focus stays put). */
  const reopen = () => { if (mode === 'full') setMode('ready'); };

  /** New chat: a new conversation, and this chat's kept one forgotten (§21.1.4). */
  const startOver = () => {
    kept.remove(keptKey);
    forget();
    showError('');
    reopen();
  };

  /** A kept conversation drawn into the transcript from its events, exactly as it was first drawn, and taken as this tab's. */
  const drawKept = (chat: StoredChat) => {
    stored = [...chat.turns];
    history = turnsOf(chat.turns);
    conversation = chat.conversation;
    rev = chat.rev;
    chat.turns.forEach((t, i) => {
      if (t.role === 'visitor') { addMessage('visitor', t.text); return; }
      const item = addMessage('site', '');
      item.setAttribute('aria-busy', 'false');
      const d = drawerFor(item);
      for (const e of t.events) {
        if (e.type === 'text' && typeof e.s === 'string') { d.text(e.s); continue; }
        const block = blockOf(e.block as Record<string, unknown>);
        if (!block) continue;
        if (block.kind === 'ask') { d.ask(block.q); continue; }
        const made = drawBlock(doc, p, config, block, `c${++copies}`, place(item));
        if (made) d.part(made.el);
      }
      d.finish();
      barFor(item);
      // Its position in the conversation is its index, as the server tagged it (§20.7, §19.11).
      if (t.share) offerShare(item, chat.conversation, i, t.share, t.events, chat.turns[i - 1].text);
    });
    if (p.asks) p.asks.hidden = true;
    offerClear();
    if (chat.turns.length / 2 >= config.limit) setMode('full');
  };

  /**
   * The conversation this browser kept for this chat (§21.1.4), drawn again
   * from its events exactly as it was first drawn — or nothing, when there is
   * none, it fails a check, it is someone else's, or the visitor has already
   * asked here.
   */
  const restore = () => {
    restoreDue = false;
    const chat = kept.load(keptKey);
    if (!chat || history.length > 0 || pending !== null) return;
    drawKept(chat);
    announce(CHAT_TEXT.restored, true);
  };

  /**
   * §19.11: another tab wrote the kept chats. A newer revision of this chat is
   * drawn here when this tab is idle (when busy, its next save finds it and
   * says so); this chat gone — cleared there, or by a sign-out — goes here too.
   */
  const fromElsewhere = () => {
    if (mode === 'checking' || mode === 'signin') return;
    const chat = kept.load(keptKey);
    if (!chat) {
      if (rev === 0) return;
      forget();
      showError('');
      reopen();
      announce(CHAT_TEXT.clearedElsewhere, true);
      return;
    }
    if (chat.rev <= rev) return;
    // Busy (answering, or a failed question waiting): left as it is — its next save finds the newer revision and says so.
    if (streaming || pending !== null) return;
    forget();
    showError('');
    reopen();
    drawKept(chat);
    announce(CHAT_TEXT.synced, true);
  };

  const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) =>
    el.addEventListener(type, fn as EventListener, { signal });
  on(p.transcript, 'scroll', onScroll);
  if (p.latest) {
    const latest = p.latest;
    on(latest, 'click', () => {
      following = true;
      jumping = true;
      // Reduced motion: the transcript jumps (§9); otherwise it glides there.
      p.transcript.scrollTo({ top: p.transcript.scrollHeight, behavior: reduced() ? 'instant' : 'smooth' });
      latest.hidden = true;
      p.input.focus({ preventScroll: true });
    });
  }

  /* ---- a float: the launcher opens the panel (§3.2, §9) ---- */
  let unlock: (() => void) | null = null;
  /** The float is open as the modal sheet (focus held), not the side panel. */
  let modal = false;
  /** An Escape the panel already acted on: the dialog's own `cancel` that may follow it is not a second one. */
  let escaped = false;
  const isOpen = () => p.float?.dialog.open === true;
  const settleClosed = () => {
    unlock?.();
    unlock = null;
    modal = false;
    p.float?.dialog.removeAttribute('data-state');
    p.float?.launcher.setAttribute('aria-expanded', 'false');
  };
  const openFloat = () => {
    const f = p.float;
    if (!f || f.dialog.open || !win || config.narrow === null) return;
    const preset = floatPreset(win.innerWidth, config.narrow);
    // The sheet below sm is the overlay engine's modal preset: the page inert and locked, focus held (overlays-spec §2).
    modal = POLICY[preset].modal;
    if (modal) {
      f.dialog.showModal();
      if (POLICY[preset].scroll === 'lock') unlock = lockScroll(doc);
    } else {
      f.dialog.show();
    }
    f.launcher.setAttribute('aria-expanded', 'true');
    // A frame later, so the browser has the closed style to move from.
    win.requestAnimationFrame(() => { if (f.dialog.open) f.dialog.setAttribute('data-state', 'open'); });
    resume();
    follow();
    (p.form.hidden ? f.close : p.input).focus({ preventScroll: true });
  };
  const closeFloat = () => {
    const f = p.float;
    if (!f || !f.dialog.open) return;
    f.dialog.close();
    settleClosed();
    f.launcher.focus({ preventScroll: true });
  };
  if (p.float) {
    const { launcher, dialog, close } = p.float;
    launcher.hidden = false;
    on(launcher, 'click', () => (dialog.open ? closeFloat() : openFloat()));
    on(close, 'click', closeFloat);
    // Escape on a modal dialog arrives as `cancel` too (and alone, from a device's back gesture).
    on(dialog, 'cancel', (e) => {
      e.preventDefault();
      if (escaped) { escaped = false; return; }
      if (streaming) stopAnswer();
      else closeFloat();
    });
    // Closed by the browser rather than by us: the page is given back all the same.
    on(dialog, 'close', settleClosed);
    on(dialog, 'keydown', (e) => {
      // overlays-spec §2: in the sheet, Tab cycles inside it — the page behind is inert, and the browser's own UI is not the page.
      if (e.key !== 'Tab' || !modal) return;
      const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (stops.length === 0) return;
      e.preventDefault();
      stops[trapIndex(stops.indexOf(doc.activeElement as HTMLElement), stops.length, e.shiftKey)].focus();
    });
    // overlays-spec §2: the sheet's handle (shown below sm only) drags it down to dismiss, through the engine's own wiring.
    const dragUndo: (() => void)[] = [];
    wireSheetDrag({
      on: (target, type, fn) => target.addEventListener(type, fn, { signal }),
      undo: dragUndo,
    }, dialog, () => closeFloat());
    signal.addEventListener('abort', () => { for (const u of dragUndo) u(); }, { once: true });
    // The sheet's backdrop is outside the dialog's box: a tap there closes it, as the overlay engine's modals do.
    on(dialog, 'click', (e) => {
      if (e.target !== dialog || !modal) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeFloat();
    });
  }

  on(p.form, 'submit', (e) => { e.preventDefault(); ask(p.input.value); });
  on(p.input, 'input', grow);
  on(p.input, 'keydown', (e) => {
    // Enter sends; Shift+Enter is a new line; an IME composition is never cut short.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(p.input.value); }
  });
  // §9: Escape stops an answer; with none streaming, it closes a float.
  on(p.host, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (streaming) { e.preventDefault(); stopAnswer(); }
    else if (isOpen()) { e.preventDefault(); closeFloat(); }
    else return;
    escaped = true;
    win?.setTimeout(() => { escaped = false; }, 0);
  });
  on(p.stop, 'click', () => { stopAnswer(); p.input.focus({ preventScroll: true }); });
  on(p.retry, 'click', () => { p.retry.hidden = true; void request(); });
  on(p.reset, 'click', () => { startOver(); p.input.focus({ preventScroll: true }); });
  // §21.1.4: shown only where this browser can keep the chat; it forgets every chat on the site and starts over.
  if (p.history) {
    p.history.box.hidden = !kept.available;
    offerClear();
    // The note on where the chat is kept, behind its info control (issue #2): shown and hidden again on request.
    const about = p.history.about;
    if (about) {
      on(about.button, 'click', () => {
        const open = about.note.hidden;
        about.note.hidden = !open;
        about.button.setAttribute('aria-expanded', String(open));
      });
    }
    on(p.history.clear, 'click', () => {
      kept.clear();
      forget();
      showError('');
      reopen();
      announce(CHAT_TEXT.cleared, true);
      p.input.focus({ preventScroll: true });
    });
  }
  for (const b of p.asks?.querySelectorAll<HTMLButtonElement>('[data-az-chat-ask]') ?? []) {
    // A suggested question says it was its button: the server may answer it with the author's own answer (§19.17).
    on(b, 'click', () => ask(b.textContent ?? '', 'suggested'));
  }

  /**
   * Who is reading, from the session: it decides who may ask (signed-in
   * visitors only, by default) and whom the kept chat is bound to (§19.11) —
   * nothing kept is drawn until the binding says it is this reader's. Signed
   * out on a signed-in chat: what this browser kept goes (§21.1.4).
   */
  const decide = async (account: string | null) => {
    reader = account;
    if (config.allow === 'signedin' && account === null) {
      kept.clear();
      setMode('signin');
      return;
    }
    await kept.bind(account);
    if (!live || reader !== account) return;
    setMode('ready');
    if (restoreDue) restore();
  };
  const begin = async () => {
    setMode('checking');
    let account: string | null = null;
    if (options.account) {
      try { account = await options.account(); } catch { account = null; }
    }
    if (live) await decide(account);
  };
  // Another person, or nobody, is reading now: this one's conversation leaves the panel at once (§19.11).
  const unsubscribe = options.onSession
    ? options.onSession((account) => {
      if (!live || account === reader) return;
      forget();
      showError('');
      restoreDue = true;
      void decide(account);
    })
    : null;
  // §19.11: the same chat in another tab of this browser.
  win?.addEventListener('storage', (e) => { if (live && kept.watches(e.key)) fromElsewhere(); }, { signal });
  void begin();

  return () => {
    live = false;
    streaming?.abort();
    if (announceTimer !== null) clearTimeout(announceTimer);
    unsubscribe?.();
    if (p.float?.dialog.open) p.float.dialog.close();
    settleClosed();
    // Back to the shell as it shipped, so attaching again starts again.
    p.transcript.replaceChildren(...greeting.map((g) => g.cloneNode(true)));
    for (const [el, hidden] of shipped) el.hidden = hidden;
    p.note.textContent = '';
    p.error.textContent = '';
    p.status.textContent = '';
    p.input.value = '';
    p.input.rows = 1;
    p.history?.about?.button.setAttribute('aria-expanded', 'false');
    p.host.removeAttribute('aria-busy');
    setState('idle');
  };
}

/** One ResizeObserver per shell for its charts: each redraws only when its own width moves (chat-draw.ts). */
function observer(doc: Document, signal: AbortSignal): ((el: Element, redraw: () => void) => () => void) | undefined {
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

/**
 * The shared-answer page (chat-block-spec §20.7): read the link's fragment,
 * fetch that one answer — no cookie, it is public — and draw it with the
 * same templates and checks as a live answer. With the delete link's token
 * it offers Delete. Returns its cleanup.
 */
function runShared(host: HTMLElement, config: ChatConfig, options: ChatOptions, signal: AbortSignal): Cleanup | null {
  const one = <T extends Element>(attr: string): T | null => host.querySelector<T>(`[${attr}]`);
  const transcript = one<HTMLElement>('data-az-chat-transcript');
  const templates = one<HTMLElement>('data-az-chat-templates');
  const note = one<HTMLElement>('data-az-chat-note');
  const error = one<HTMLElement>('data-az-chat-error');
  const status = one<HTMLElement>('data-az-chat-status');
  const del = one<HTMLButtonElement>('data-az-chat-delete');
  const components = one<HTMLElement>('data-az-chat-parts');
  const visitorTemplate = templates?.querySelector<HTMLElement>('.az-chat-message--visitor') ?? null;
  const siteTemplate = templates?.querySelector<HTMLElement>('.az-chat-message--site') ?? null;
  if (!transcript || !note || !error || !status || !del || !visitorTemplate || !siteTemplate) return null;
  const send = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const doc = host.ownerDocument;
  const intro = note.textContent ?? '';
  const resizes = observer(doc, signal);
  const say = (text: string) => { status.textContent = ''; status.textContent = text; };
  const problem = (text: string) => {
    transcript.removeAttribute('aria-busy');
    error.textContent = text;
    error.hidden = false;
    say(text);
  };
  const link = readShareLink(doc.location.hash);
  const base = options.base.replace(/\/+$/, '');
  const load = async () => {
    if (!link) { problem(SHARE_TEXT.expired); return; }
    say(SHARE_TEXT.loading);
    let res: Response;
    try {
      res = await send(`${base}/chat/share/${link.id}`, { credentials: 'omit', signal });
    } catch {
      if (!signal.aborted) problem(problemCopy('unavailable'));
      return;
    }
    if (res.status !== 200) { problem(SHARE_TEXT.expired); return; }
    let body: { events?: unknown; question?: unknown; expires?: unknown };
    try { body = await res.json() as typeof body; } catch { problem(SHARE_TEXT.expired); return; }
    if (!Array.isArray(body.events) || typeof body.expires !== 'number') { problem(SHARE_TEXT.expired); return; }
    if (typeof body.question === 'string' && body.question.length <= 1000) {
      const q = visitorTemplate.cloneNode(true) as HTMLElement;
      const para = q.querySelector('p');
      if (para) para.textContent = body.question;
      transcript.append(q);
    }
    const answer = siteTemplate.cloneNode(true) as HTMLElement;
    transcript.append(answer);
    // The same drawing as the live panel's (§21.1.3), with no follow-ups: there is no conversation to continue here.
    const copy = (code: Element) => {
      const clip = doc.defaultView?.navigator.clipboard;
      if (!clip) { say(CHAT_TEXT.copyFailed); return; }
      clip.writeText(code.textContent ?? '').then(() => say(CHAT_TEXT.copied), () => say(CHAT_TEXT.copyFailed));
    };
    const drawn = answerDrawer(doc, answer, proseTemplatesOf(host), copy, signal, null, () => undefined, false);
    const said: string[] = [];
    let n = 0;
    for (const raw of body.events.slice(0, 16)) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      if (e.type === 'text' && typeof e.s === 'string') {
        drawn.text(e.s);
      } else if (e.type === 'block' && e.block && typeof e.block === 'object' && !Array.isArray(e.block)) {
        const block = blockOf(e.block as Record<string, unknown>);
        const made = block && drawBlock(doc, { components }, config, block, `shared${++n}`, {
          within: answer, base: options.base, signal, announce: say, ...(resizes ? { observe: resizes } : {}), ...(options.drawMap ? { drawMap: options.drawMap } : {}),
        });
        if (!made) continue;
        drawn.part(made.el);
        said.push(made.said);
      }
    }
    transcript.removeAttribute('aria-busy');
    const until = new Intl.DateTimeFormat(doc.documentElement.lang || 'en', { dateStyle: 'medium' }).format(new Date(body.expires));
    note.textContent = `${intro} ${SHARE_TEXT.until(until)}`;
    say([...said, CHAT_TEXT.answered].filter(Boolean).join(' '));
    if (link.token) del.hidden = false;
  };
  del.addEventListener('click', async () => {
    if (!link?.token) return;
    try {
      const res = await send(`${base}/chat/share/${link.id}`, {
        method: 'DELETE', credentials: 'omit', signal,
        headers: { 'content-type': 'application/json', 'x-az-request': '1' },
        body: JSON.stringify({ token: link.token }),
      });
      if (res.status !== 204) { problem(SHARE_TEXT.expired); del.hidden = true; return; }
      transcript.replaceChildren();
      del.hidden = true;
      note.textContent = SHARE_TEXT.deleted;
      say(SHARE_TEXT.deleted);
      // The token's job is done: it leaves the address bar and this page's history entry.
      doc.defaultView?.history.replaceState(null, '', `${doc.location.pathname}`);
    } catch {
      if (!signal.aborted) problem(problemCopy('unavailable'));
    }
  }, { signal });
  void load();
  return () => {
    transcript.replaceChildren();
    transcript.setAttribute('aria-busy', 'true');
    note.textContent = intro;
    error.textContent = '';
    error.hidden = true;
    del.hidden = true;
    status.textContent = '';
  };
}

/**
 * Run every chat panel in `doc`. `options.base` is the backend's URL; the
 * generated src/chat/runtime.tsx passes it and the auth adapter's session.
 * Returns the cleanup.
 */
export function attachChat(doc: Document, options: ChatOptions): Cleanup {
  const win = doc.defaultView;
  const ac = new AbortController();
  const wired = new Map<HTMLElement, Cleanup>();

  const wire = (host: HTMLElement) => {
    if (wired.has(host)) return;
    const config = parseChatConfig(host.getAttribute('data-az-chat'));
    if (config?.shared) {
      const cleanup = runShared(host, config, options, ac.signal);
      if (cleanup) wired.set(host, cleanup);
      return;
    }
    const parts = partsOf(host);
    if (!parts || !config) return;
    wired.set(host, runShell(parts, config, options, ac.signal));
  };
  const scan = (root: ParentNode) => {
    if (root instanceof HTMLElement && root.hasAttribute('data-az-chat')) wire(root);
    for (const host of root.querySelectorAll<HTMLElement>('[data-az-chat]')) wire(host);
  };
  scan(doc);
  // A protected page renders its content once the session check resolves.
  const observer = win ? new win.MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n as Element);
  }) : null;
  observer?.observe(doc.body, { childList: true, subtree: true });

  return () => {
    observer?.disconnect();
    ac.abort();
    for (const cleanup of wired.values()) cleanup();
    wired.clear();
  };
}
