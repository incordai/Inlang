/**
 * @az runtime chat-panel
 * Purpose: a chat window's core — the theme's chat section run as a window: its form, transcript, suggested questions, stop, retry, status line, and each answer drawn as its events arrive, whatever answers the questions.
 * Spec: docs/chat-block-spec.md §7, §9, §19.18, §21.1, §22.5
 * Exports: panelPartsOf, PanelParts, runPanel, Panel, PanelDriver, PanelAnswer, PanelMode, PanelVia
 * Edit guide: answers are textContent in copies of the shell's templates, never markup; nothing here knows where an answer comes
 *   from — the driver (the site's request, or an app's session) does; the returned teardown puts the shell back as it shipped.
 * Tests: scripts/chat-lib-e2e.mjs, scripts/chat-e2e.mjs, packages/overlay/test/chat.test.ts
 */

/**
 * The window an az site's panel is (overlay chat.ts runs it with the site's
 * request, its kept conversation, its float and its shares) and the one an
 * app's `<AzChat>` is (chat-react, over a chat session): one code for both
 * (chat-block-spec §22.5). It finds the shell's parts by the data attributes
 * the chat word writes, and runs them:
 *
 *   - the form: Enter sends, Shift+Enter is a new line, an IME composition is
 *     never cut short; the input is one line and grows to a cap; a suggested
 *     question's button asks it; the question is shown at once and the
 *     driver is asked to answer it (`answer`);
 *   - the answer, through `answer()`: its place at once with holding dots,
 *     its words with a caret, a held component's placeholder, each component,
 *     the follow-ups, the bar; Stop (and Escape) ends it, keeping what it drew;
 *     a failure says the fixed copy for its code and offers Try again when
 *     asking again may help;
 *   - the status region: whole sentences, at most one update every 1.5 s;
 *   - the transcript follows the newest words while the visitor is at its
 *     end; scrolling away stops it and offers Jump to latest (§9). Nothing
 *     moves under reduced motion.
 *
 * Touches nothing at import time; every listener ends with `signal`.
 *
 * Imports only its siblings.
 */

import { CHAT_TEXT, RETRYABLE, atEnd, blockOf, finishedSentences, inputRows, mayFollow, offersLatest, problemCopy, visitorText, type ChatConfig } from './chat-logic.ts';
import { answerDrawer, drawBlock, liveAnswer, resizeWatch, type LiveAnswer, type MapDrawer, type Place } from './chat-answer-view.ts';
import { spokenText } from './chat-markdown.ts';
import { followUps, proseTemplatesOf, type ProseTemplates } from './chat-prose.ts';
import { busyKitOf, type BusyKit } from './chat-busy.ts';
import { answerBar } from './chat-bar.ts';

/** §9: the status region hears at most one update in this long. */
const ANNOUNCE_MS = 1500;

/** Who may ask now: the session is being read, anyone may, someone must sign in first, or the conversation is full. */
export type PanelMode = 'checking' | 'ready' | 'signin' | 'full';

/** How a question was asked (§19.17): by a suggested question's button, by "Ask the AI instead", or typed. */
export type PanelVia = 'suggested' | 'model' | null;

/** The parts of a chat shell a window runs; null where a shell from before them has none. */
export interface PanelParts {
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
  /** Issues #28, #30: the working signs and the answer bar's template (chat-busy.ts); null in a shell from before them. */
  readonly busy: BusyKit | null;
}

/** The window's parts in a chat shell, or null when one it cannot run without is missing. */
export function panelPartsOf(host: HTMLElement): PanelParts | null {
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
    busy: busyKitOf(host),
  };
}

/** What answers the window's questions, and what it keeps: the site's request and kept conversation, or an app's session. */
export interface PanelDriver {
  /** Where row images and map tiles come from (the site's backend); empty for none. */
  readonly base: string;
  /** Draws a map (chat-map-draw.ts); without it a map is not drawn. */
  readonly drawMap?: MapDrawer;
  /**
   * Answer `question`: the window shows it (asked now, or still on screen for Try again) and nothing is coming. The driver
   * begins the answer with `panel.answer()` and draws its events there.
   */
  answer(question: string, via: PanelVia): void;
  /** End the answer coming (Stop, Escape): the driver ends its stream, then calls the answer's `stopped()`. */
  stop(): void;
  /** Some exchange was answered in this conversation: the suggested questions stay hidden. */
  answered(): boolean;
  /** There is a kept conversation for Clear history to clear. */
  kept(): boolean;
  /** Where the conversation can be kept: the history controls are shown. */
  readonly keeps: boolean;
  /** New chat: forget the kept conversation (the window then starts over). Without it, New chat is never offered. */
  readonly startOver?: () => void;
  /** Clear history: forget every kept conversation (the window then starts over). */
  readonly clear?: () => void;
  /** The window forgot the conversation: the driver's own state of it goes too, and an answer coming is abandoned. */
  readonly forgotten?: () => void;
  /** The server no longer accepts the kept conversation (`tampered`): the driver forgets it. */
  readonly tampered?: () => void;
}

/** One answer in the window, from `panel.answer()`: what the driver draws its events with. */
export interface PanelAnswer {
  /** The answer's item in the transcript. */
  readonly item: HTMLElement;
  /** Stop was asked for this answer. */
  readonly stopping: boolean;
  /** Words: drawn, with a caret; finished sentences said. */
  text(s: string): void;
  /** A component the answer is reading: a placeholder of its shape. */
  hold(word: string): void;
  /** A component, drawn and said once (a follow-up waits for the end); false when it is not drawn. */
  block(raw: Record<string, unknown>): boolean;
  /** The answer whole: its signs go, its follow-ups are drawn. Returns how many. */
  finish(): number;
  /** A follow-up under the answer asking something of the driver (§19.17 "Ask the AI instead"). */
  instead(label: string, ask: () => void): void;
  /** The answer's bar of small actions (Copy), last. */
  bar(): void;
  /** The answer has arrived: no longer busy, the rest of its words said, the window ready for the next question. */
  arrived(follows: number): void;
  /** Stopped: its signs go; with nothing drawn it goes, with words it keeps them and its bar. */
  stopped(): void;
}

/** The window, for its driver. */
export interface Panel {
  readonly mode: PanelMode;
  /** An answer is coming. */
  readonly busy: boolean;
  /** The question waiting for an answer, until one arrives. */
  readonly pending: string | null;
  setMode(next: PanelMode): void;
  /** `data-az-chat-state` on the shell. */
  setState(state: string): void;
  /** §9: whole sentences to the status region; `now` skips the wait. */
  announce(text: string, now?: boolean): void;
  /** The note under the form. */
  note(text: string): void;
  /** An error line, with Try again and New chat as asked. */
  showError(text: string, offer?: { readonly retry?: boolean; readonly reset?: boolean }): void;
  /** A question, as if typed and sent. */
  ask(raw: string, via?: PanelVia): void;
  /** The answer coming stopped, as Stop does. */
  stop(): void;
  /** The answer's place, at once: the driver draws its events into it. */
  answer(): PanelAnswer;
  /** A refusal or a failure, with the fixed copy for its code (never server text); `item` is the answer it takes away. */
  fail(code: string, item: HTMLElement | null): void;
  /** A kept turn drawn again, as it was first drawn: the visitor's question. */
  keptQuestion(text: string): void;
  /** A kept answer drawn again from its events, as it was first drawn. Returns its item. */
  keptAnswer(events: readonly Readonly<Record<string, unknown>>[]): HTMLElement;
  /** The suggested questions hidden: the conversation has begun. */
  hideAsks(): void;
  /** Clear history shown only when there is something kept. */
  offerClear(): void;
  /** The conversation gone from the window: the greeting alone, nothing pending. */
  forget(): void;
  /** Asking again after a full conversation. */
  reopen(): void;
  /** Follow the newest words from wherever the transcript is now (a float opened). */
  followNow(): void;
  /** A suffix for a copy's ids: `prefix` and the next number. */
  suffix(prefix: string): string;
  /** The shell as it shipped again. */
  teardown(): void;
}

/** Run one shell as a chat window. */
export function runPanel(p: PanelParts, config: ChatConfig, driver: PanelDriver, signal: AbortSignal): Panel {
  const hideable: HTMLElement[] = [p.form, p.stop, p.send, p.error, p.actions, p.retry, p.reset,
    ...(p.asks ? [p.asks] : []), ...(p.signin ? [p.signin] : []), ...(p.latest ? [p.latest] : []),
    ...(p.history ? [p.history.box, p.history.clear, ...(p.history.about ? [p.history.about.note] : [])] : [])];
  const shipped = new Map(hideable.map((el) => [el, el.hidden] as const));
  const greeting = [...p.transcript.children].map((c) => c.cloneNode(true));

  let mode: PanelMode = 'checking';
  /** The question being answered, until an answer arrives; how it was asked (§19.17). */
  let pending: string | null = null;
  let pendingVia: PanelVia = null;
  let busy = false;
  let stopping = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAnnounce = -Infinity;
  let queued = '';
  let live = true;
  /** Components drawn so far: each copy's ids get their own suffix. */
  let copies = 0;
  const doc = p.host.ownerDocument;
  const win = doc.defaultView;
  const watch = resizeWatch(doc, signal);
  // A chart redrawn for its own width can change its height after the transcript last followed: it follows again (§9).
  const resizes = watch ? (el: Element, redraw: () => void) => watch(el, () => { redraw(); follow(); }) : undefined;
  const place = (within: HTMLElement): Place => ({
    within, base: driver.base, signal, observe: resizes,
    // An explore's send form asks as a follow-up does; its summaries are said at once, it keeps them to one in 1.5 s itself.
    ask: (q) => ask(q), announce: (t) => announce(t, true),
    ...(driver.drawMap ? { drawMap: driver.drawMap } : {}),
  });

  const setState = (state: string) => p.host.setAttribute('data-az-chat-state', state);
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

  const showError = (text: string, offer: { readonly retry?: boolean; readonly reset?: boolean } = {}) => {
    p.error.textContent = text;
    p.error.hidden = text === '';
    p.retry.hidden = !offer.retry;
    p.reset.hidden = !offer.reset || !driver.startOver;
    p.actions.hidden = p.retry.hidden && p.reset.hidden && (p.signin?.hidden ?? true);
    if (text) announce(text, true);
  };

  const setMode = (next: PanelMode) => {
    mode = next;
    const asking = next === 'ready';
    p.form.hidden = !asking;
    if (p.asks) p.asks.hidden = !asking || driver.answered() || pending !== null;
    if (p.signin) p.signin.hidden = next !== 'signin';
    p.note.textContent = next === 'signin' ? CHAT_TEXT.signin : next === 'full' ? CHAT_TEXT.full : '';
    if (next === 'full') { p.reset.hidden = !driver.startOver; p.retry.hidden = true; }
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
    busy = false;
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
    if (p.history) p.history.clear.hidden = !driver.kept();
  };

  /** The conversation gone from the window and from the driver: the greeting alone, nothing pending. */
  const forget = () => {
    // The answer in flight, if any, is abandoned: the driver leaves the window alone after this.
    driver.forgotten?.();
    settle();
    pending = null;
    p.transcript.replaceChildren(...greeting.map((g) => g.cloneNode(true)));
    p.note.textContent = '';
    if (p.asks) p.asks.hidden = mode !== 'ready';
    if (p.latest) p.latest.hidden = true;
    offerClear();
  };

  /** The window asks again after a full conversation; who may ask is unchanged, so focus stays put. */
  const reopen = () => { if (mode === 'full') setMode('ready'); };

  const fail = (code: string, item: HTMLElement | null) => {
    item?.remove();
    settle();
    if (code === 'signin_required') { pending = null; setMode('signin'); showError(''); announce(CHAT_TEXT.signin, true); return; }
    if (code === 'conversation_full') { pending = null; setMode('full'); showError(''); announce(CHAT_TEXT.full, true); return; }
    // A kept conversation the server no longer accepts (its key was rotated, §21.1.4): it goes, and the window starts over.
    if (code === 'tampered') {
      driver.tampered?.();
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

  /** The answer's place, at once (issue #28): dots in it until its first words or component, said once in the status region. */
  const answer = (): PanelAnswer => {
    busy = true;
    stopping = false;
    setState('streaming');
    p.send.hidden = true;
    p.stop.hidden = false;
    showError('');
    p.note.textContent = '';
    // §9: sending keeps focus in the input, wherever the question came from.
    p.input.focus({ preventScroll: true });
    const item: HTMLElement = addMessage('site', '', true);
    item.setAttribute('aria-busy', 'true');
    // The answer drawn as its events arrive (chat-answer-view.ts): dots, words with a caret, a held component's placeholder,
    // each component, the follow-ups. The dots are a line of the answer: the transcript follows them, or its next scroll
    // event reads it as scrolled away.
    const drawing: LiveAnswer = liveAnswer({
      doc, item, drawn: drawerFor(item), components: p.components, config, place: place(item), kit: p.busy,
      suffix: () => `c${++copies}`, reduced, after: follow,
      // A placeholder taller than what replaces it lets the browser pull the transcript up: that move is the runtime's, not
      // the visitor scrolling away, so a transcript that was following goes on following (§9).
      settled: () => { if (following) known = Math.min(known, p.transcript.scrollTop); },
    });
    drawing.begin();
    announce(CHAT_TEXT.working, true);
    let text = '';
    let said = 0;
    return {
      item,
      get stopping() { return stopping; },
      text(s) {
        text += s;
        drawing.text(s);
        const next = finishedSentences(text, said);
        said = next.next;
        announce(spokenText(next.said));
      },
      hold(word) { drawing.hold(word); },
      block(raw) {
        // A follow-up question waits for the end of the answer; a component the shell cannot draw is not drawn.
        const drawnSaid = drawing.block(raw);
        if (drawnSaid === null) return false;
        // The prose before it is finished: its last words are said first, then the component, once.
        announce(spokenText(finishedSentences(text, said, true).said));
        said = text.length;
        announce(drawnSaid);
        return true;
      },
      finish: () => drawing.finish(),
      instead(label, run) {
        const offer = followUps(p.prose, [label], run, signal);
        if (offer) item.append(offer);
      },
      bar: () => barFor(item),
      arrived(follows) {
        pending = null;
        item.setAttribute('aria-busy', 'false');
        // The answer has arrived: where the visitor is reading now decides Jump to latest.
        placeLatest(atEnd(p.transcript.scrollTop, p.transcript.scrollHeight, p.transcript.clientHeight));
        announce(spokenText(finishedSentences(text, said, true).said) || CHAT_TEXT.answered, true);
        if (follows > 0) announce(CHAT_TEXT.follows(follows), true);
        settle();
      },
      stopped() {
        // Stopped by the visitor: the exchange stays on screen as it was, but it has no answer to send again. The working
        // signs go; an answer with nothing drawn yet goes with them, and one with words keeps them, and its bar.
        drawing.stop();
        if (drawing.shown) {
          item.setAttribute('aria-busy', 'false');
          barFor(item);
        } else item.remove();
        pending = null;
        settle();
        setState('idle');
        p.note.textContent = CHAT_TEXT.stopped;
        announce(CHAT_TEXT.stopped, true);
      },
    };
  };

  const ask = (raw: string, via: PanelVia = null) => {
    if (mode !== 'ready' || busy) return;
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
    driver.answer(text, via);
  };

  const stopAnswer = () => {
    if (!busy) return;
    stopping = true;
    driver.stop();
  };

  /** New chat: a new conversation, and the kept one forgotten (§21.1.4). */
  const startOver = () => {
    driver.startOver?.();
    forget();
    showError('');
    reopen();
  };

  const keptAnswer = (events: readonly Readonly<Record<string, unknown>>[]): HTMLElement => {
    const item = addMessage('site', '');
    item.setAttribute('aria-busy', 'false');
    const d = drawerFor(item);
    for (const e of events) {
      if (e.type === 'text' && typeof e.s === 'string') { d.text(e.s); continue; }
      if (e.type !== 'block' || !e.block || typeof e.block !== 'object' || Array.isArray(e.block)) continue;
      const block = blockOf(e.block as Record<string, unknown>);
      if (!block) continue;
      if (block.kind === 'ask') { d.ask(block.q); continue; }
      const made = drawBlock(doc, p, config, block, `c${++copies}`, place(item));
      if (made) d.part(made.el);
    }
    d.finish();
    barFor(item);
    return item;
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
  on(p.form, 'submit', (e) => { e.preventDefault(); ask(p.input.value); });
  on(p.input, 'input', grow);
  on(p.input, 'keydown', (e) => {
    // Enter sends; Shift+Enter is a new line; an IME composition is never cut short.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(p.input.value); }
  });
  // §9: Escape stops an answer (a driver's own listener after this one may close what holds the window).
  on(p.host, 'keydown', (e) => {
    if (e.key !== 'Escape' || !busy) return;
    e.preventDefault();
    stopAnswer();
  });
  on(p.stop, 'click', () => { stopAnswer(); p.input.focus({ preventScroll: true }); });
  on(p.retry, 'click', () => {
    p.retry.hidden = true;
    if (pending !== null && !busy) driver.answer(pending, pendingVia);
  });
  on(p.reset, 'click', () => { startOver(); p.input.focus({ preventScroll: true }); });
  // §21.1.4: shown only where the conversation can be kept; it forgets every kept chat and starts over.
  if (p.history) {
    p.history.box.hidden = !driver.keeps;
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
      driver.clear?.();
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

  return {
    get mode() { return mode; },
    get busy() { return busy; },
    get pending() { return pending; },
    setMode, setState, announce, showError, ask, answer, fail, offerClear, forget, reopen,
    stop: stopAnswer,
    note: (text) => { p.note.textContent = text; },
    keptQuestion: (text) => { addMessage('visitor', text); },
    keptAnswer,
    hideAsks: () => { if (p.asks) p.asks.hidden = true; },
    followNow: () => { resume(); follow(); },
    suffix: (prefix) => `${prefix}${++copies}`,
    teardown() {
      live = false;
      if (announceTimer !== null) clearTimeout(announceTimer);
      // Back to the shell as it shipped, so running it again starts again.
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
    },
  };
}
