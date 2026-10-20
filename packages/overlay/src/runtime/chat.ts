/**
 * @az runtime chat
 * Purpose: runs a `chat` panel: sends a question to the site's backend, reads the answer's event stream, writes it as text.
 * Spec: docs/chat-block-spec.md §3.2, §4.2, §5.4, §7, §9, §19.18, §20, §21.1, §21.3, §21.4, §22.5
 * Exports: attachChat, ChatOptions
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
 * The window itself — the form, the transcript and its following, the
 * suggested questions, Stop, Try again, the status region and each answer's
 * drawing — is the chat renderer's (chat-render chat-panel.ts), the code an
 * app's <AzChat> runs too (chat-block-spec §22.5); this file gives it the
 * site's request, the kept conversation, the session, the float and Share.
 *
 * Touches nothing at import time. The returned cleanup aborts every request
 * and timer, removes every listener and puts each shell back as it shipped.
 * Imports only its siblings and the chat renderer (#chat-render).
 */

import {
  ANSWER_MAX, CHAT_TEXT, SHARE_TAG_MAX_MS, blockOf, createEventReader, floatPreset, leftCopy,
  mergeText, parseChatConfig, problemCopy, readShareLink, requestBody, SHARE_TEXT, type ChatConfig, type ChatTurn, type ShareTags,
} from '#chat-render/chat-logic.ts';
import { FOCUSABLE, lockScroll, wireSheetDrag } from './behaviours.ts';
import { trapIndex } from './logic.ts';
import { POLICY } from './policy.ts';
import { answerDrawer, drawBlock, partFor, resizeWatch, type MapDrawer } from '#chat-render/chat-answer-view.ts';
import { panelPartsOf, runPanel, type PanelParts, type PanelVia } from '#chat-render/chat-panel.ts';
import { shareControl } from './chat-shared.ts';
import { proseTemplatesOf } from '#chat-render/chat-prose.ts';
import { browserStorage, createHistory, historyKeyOf, turnsOf, type StoredChat, type StoredTurn } from '#chat-render/chat-history.ts';
import { wireTips } from '#chat-render/chat-bar.ts';

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

/** An answer the server has not finished by now is ended here (the server's own cap is 60 s by default). */
const ANSWER_DEADLINE_MS = 90_000;

type Cleanup = () => void;

interface Parts extends PanelParts {
  /** A float's launcher, its dialog and the dialog's Close; null for a panel. */
  readonly float: { readonly launcher: HTMLButtonElement; readonly dialog: HTMLDialogElement; readonly close: HTMLButtonElement } | null;
}

function partsOf(host: HTMLElement): Parts | null {
  const panel = panelPartsOf(host);
  if (!panel) return null;
  const launcher = host.querySelector<HTMLButtonElement>('[data-az-chat-launcher]');
  const dialog = host.querySelector('dialog');
  const close = host.querySelector<HTMLButtonElement>('[data-az-chat-close]');
  return { ...panel, float: launcher && dialog && close ? { launcher, dialog, close } : null };
}

/** Run one shell: the window (chat-render chat-panel.ts) with the site's request, its kept conversation, its float and its shares. Returns its cleanup. */
function runShell(p: Parts, config: ChatConfig, options: ChatOptions, signal: AbortSignal): Cleanup {
  const send = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const endpoint = `${options.base.replace(/\/+$/, '')}/chat`;
  const launcherShipped = p.float?.launcher.hidden ?? null;

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
  /** The latest answer's request: Stop and a forgotten conversation end it. */
  let streaming: AbortController | null = null;
  let live = true;
  /** Bumped by a new chat: a request from before it must not touch the panel after. */
  let generation = 0;
  const doc = p.host.ownerDocument;
  const win = doc.defaultView;

  /** The site's answers: the question POSTed to the backend, its event stream read and drawn into the window. */
  const request = async (question: string, via: PanelVia) => {
    const mine = generation;
    const current = () => live && mine === generation;
    const ac = new AbortController();
    streaming = ac;
    const deadline = setTimeout(() => ac.abort(), ANSWER_DEADLINE_MS);
    // The answer's position in the messages the server tags it by, and its events as they arrive (§20.7).
    const index = history.length + 1;
    const received: Record<string, unknown>[] = [];
    let text = '';
    let finished = false;
    // §19.11: a long conversation sends only its latest whole exchanges that fit the request cap; the visitor is told once.
    const req = requestBody(config.page, conversation, history, question, via);
    if (req.from > 0 && !trimmed) {
      trimmed = true;
      panel.announce(CHAT_TEXT.trimmed, true);
    }
    // Issue #28: the answer's place, at once. All of it is the answer's until it settles: a refusal or a failure takes it
    // away, a stop before anything arrived too.
    const answer = panel.answer();
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
        if (current()) panel.fail(code, answer.item);
        return;
      }
      if (!res.body || !/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) {
        if (current()) panel.fail('unknown', answer.item);
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
            answer.text(e.s);
          } else if (e.type === 'hold') {
            // Issue #28: the server is reading a component's figures — a placeholder of its shape stands at the end meanwhile.
            answer.hold(e.word);
          } else if (e.type === 'block') {
            received.push({ type: 'block', block: e.raw });
            answer.block(e.raw);
          } else if (e.type === 'done') {
            finished = true;
            const follows = answer.finish();
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
            panel.offerClear();
            // §19.11: another tab went on with this chat (or cleared it): its turns stand, and this answer is said not to be kept.
            const lost = !keptAs.kept && (keptAs.why === 'conflict' || keptAs.why === 'cleared');
            // §19.17: an answer the site matched to the question may not be the one wanted — the same question, to the model.
            if (e.by === 'match') answer.instead(CHAT_TEXT.askModel, () => panel.ask(question, 'model'));
            // Issue #30: the bar of small actions, last; §20.7: Share joins it when the server makes share links.
            answer.bar();
            if (e.share && received.length > 0) offerShare(answer.item, e.conversation, index, e.share, received, question);
            answer.arrived(follows);
            const left = leftCopy(e.left);
            if (lost) panel.announce(CHAT_TEXT.notKept, true);
            if (e.left <= 0) panel.setMode('full');
            else { panel.setState('idle'); panel.note([left, lost ? CHAT_TEXT.notKept : '', trimmed ? CHAT_TEXT.trimmed : ''].filter(Boolean).join(' ')); }
          } else {
            finished = true;
            panel.fail(e.code, answer.item);
          }
        }
        if (done || finished || !current()) break;
      }
      if (!finished && current() && !answer.stopping) panel.fail('unavailable', answer.item);
    } catch {
      if (!current()) return;
      if (answer.stopping) return;
      panel.fail('unavailable', answer.item);
    } finally {
      clearTimeout(deadline);
      // Stopped by the visitor: it has no tagged answer, so it is not sent again.
      if (current() && answer.stopping && !finished) answer.stopped();
    }
  };

  const panel = runPanel(p, config, {
    base: options.base,
    ...(options.drawMap ? { drawMap: options.drawMap } : {}),
    answer: (question, via) => { void request(question, via); },
    stop: () => streaming?.abort(),
    answered: () => history.length > 0,
    kept: () => stored.length > 0,
    keeps: kept.available,
    startOver: () => kept.remove(keptKey),
    clear: () => kept.clear(),
    forgotten: () => {
      // The answer in flight, if any, is abandoned: its request sees a new generation and leaves the panel alone.
      generation++;
      streaming?.abort();
      history = [];
      stored = [];
      conversation = null;
      rev = 0;
      trimmed = false;
      restoreDue = false;
    },
    tampered: () => kept.remove(keptKey),
  }, signal);

  /** The Share control under an answer (§20.7) — a live one, or a restored one while its share tags last (§19.11). */
  function offerShare(answer: HTMLElement, conv: string, index: number, tags: ShareTags, events: readonly Record<string, unknown>[], question: string): void {
    const shareTemplate = p.components ? partFor(p.components, 'share')?.firstElementChild as HTMLElement | null : null;
    if (!shareTemplate || Date.now() - tags.at > SHARE_TAG_MAX_MS) return;
    const control = shareControl(doc, shareTemplate, {
      base: options.base, page: config.page, conversation: conv, index, tags,
      events, question, fetch: send, announce: (t) => panel.announce(t, true), suffix: panel.suffix('s'),
    }, signal);
    if (!control) return;
    // Issue #30: Share is an icon button in the answer's bar, its panel on a row of its own under it (a bar-less shell: the answer's end).
    (answer.querySelector(':scope > .az-chat-bar') ?? answer).append(control);
    wireTips(control, signal);
  }

  /** A kept conversation drawn into the transcript from its events, exactly as it was first drawn, and taken as this tab's. */
  const drawKept = (chat: StoredChat) => {
    stored = [...chat.turns];
    history = turnsOf(chat.turns);
    conversation = chat.conversation;
    rev = chat.rev;
    chat.turns.forEach((t, i) => {
      if (t.role === 'visitor') { panel.keptQuestion(t.text); return; }
      const item = panel.keptAnswer(t.events);
      // Its position in the conversation is its index, as the server tagged it (§20.7, §19.11).
      if (t.share) offerShare(item, chat.conversation, i, t.share, t.events, chat.turns[i - 1].text);
    });
    panel.hideAsks();
    panel.offerClear();
    if (chat.turns.length / 2 >= config.limit) panel.setMode('full');
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
    if (!chat || history.length > 0 || panel.pending !== null) return;
    drawKept(chat);
    panel.announce(CHAT_TEXT.restored, true);
  };

  /**
   * §19.11: another tab wrote the kept chats. A newer revision of this chat is
   * drawn here when this tab is idle (when busy, its next save finds it and
   * says so); this chat gone — cleared there, or by a sign-out — goes here too.
   */
  const fromElsewhere = () => {
    if (panel.mode === 'checking' || panel.mode === 'signin') return;
    const chat = kept.load(keptKey);
    if (!chat) {
      if (rev === 0) return;
      panel.forget();
      panel.showError('');
      panel.reopen();
      panel.announce(CHAT_TEXT.clearedElsewhere, true);
      return;
    }
    if (chat.rev <= rev) return;
    // Busy (answering, or a failed question waiting): left as it is — its next save finds the newer revision and says so.
    if (panel.busy || panel.pending !== null) return;
    panel.forget();
    panel.showError('');
    panel.reopen();
    drawKept(chat);
    panel.announce(CHAT_TEXT.synced, true);
  };

  const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) =>
    el.addEventListener(type, fn as EventListener, { signal });

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
    panel.followNow();
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
      if (panel.busy) panel.stop();
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

  // §9: Escape stops an answer (the window's own listener, which runs first and marks the key handled); with none
  // coming, it closes a float. The mark decides, not whether an answer is still busy: a stop can end it at once.
  on(p.host, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.defaultPrevented) { /* the window stopped an answer */ } else if (isOpen()) { e.preventDefault(); closeFloat(); } else return;
    escaped = true;
    win?.setTimeout(() => { escaped = false; }, 0);
  });

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
      panel.setMode('signin');
      return;
    }
    await kept.bind(account);
    if (!live || reader !== account) return;
    panel.setMode('ready');
    if (restoreDue) restore();
  };
  const begin = async () => {
    panel.setMode('checking');
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
      panel.forget();
      panel.showError('');
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
    unsubscribe?.();
    if (p.float?.dialog.open) p.float.dialog.close();
    settleClosed();
    if (p.float && launcherShipped !== null) p.float.launcher.hidden = launcherShipped;
    panel.teardown();
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
  const resizes = resizeWatch(doc, signal);
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
