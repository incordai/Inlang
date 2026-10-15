/**
 * @az runtime chat
 * Purpose: runs a `chat` panel: sends a question to the site's backend, reads the answer's event stream, writes it as text.
 * Spec: docs/chat-block-spec.md §4.2, §5.4, §7, §9
 * Exports: attachChat, ChatOptions
 * Edit guide: answers are textContent in copies of the shell's templates, never markup; each shell once (late content via MutationObserver); attachChat() returns full cleanup.
 * Tests: packages/overlay/test/chat.test.ts, scripts/chat-e2e.mjs
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
 *   - keeps the conversation in memory only (never storage): a reload, or
 *     another tab, starts fresh;
 *   - gives the status region whole sentences, at most one update every
 *     1.5 s, never tokens; the transcript itself is not a live region.
 *
 * Touches nothing at import time. The returned cleanup aborts every request
 * and timer, removes every listener and puts each shell back as it shipped.
 * Imports only its siblings.
 */

import {
  ANSWER_MAX, CHAT_TEXT, RETRYABLE, createEventReader, finishedSentences, leftCopy, parseChatConfig, problemCopy, visitorText,
  type ChatConfig, type ChatTurn,
} from './chat-logic.ts';

export interface ChatOptions {
  /** The backend's base URL (AZ_PUBLIC_BACKEND_URL); the panel posts to `<base>/chat`. */
  readonly base: string;
  /** Whether the visitor is signed in now — the auth adapter's session read. */
  readonly signedIn?: () => Promise<boolean>;
  /** Called whenever the visitor signs in or out; returns its unsubscribe. */
  readonly onSession?: (fn: (signedIn: boolean) => void) => () => void;
  /** The fetch to send with; the page's own by default. */
  readonly fetch?: typeof fetch;
}

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
  return {
    host, transcript, visitorTemplate, siteTemplate, form, input, send, stop, note, error, actions, retry, reset, status,
    asks: one<HTMLElement>('data-az-chat-asks'),
    signin: one<HTMLElement>('data-az-chat-signin'),
  };
}

/** The paragraphs of an answer's text: split at blank lines, an empty last one not drawn yet. */
function paragraphsOf(text: string): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, ''));
  if (paras.length > 1 && paras[paras.length - 1] === '') paras.pop();
  return paras;
}

/** Run one shell. Returns its cleanup. */
function runShell(p: Parts, config: ChatConfig, options: ChatOptions, signal: AbortSignal): Cleanup {
  const send = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const endpoint = `${options.base.replace(/\/+$/, '')}/chat`;
  const hideable: HTMLElement[] = [p.form, p.stop, p.send, p.error, p.actions, p.retry, p.reset,
    ...(p.asks ? [p.asks] : []), ...(p.signin ? [p.signin] : [])];
  const shipped = new Map(hideable.map((el) => [el, el.hidden] as const));
  const greeting = [...p.transcript.children].map((c) => c.cloneNode(true));

  let mode: Mode = 'checking';
  let history: ChatTurn[] = [];
  let conversation: string | null = null;
  /** The question being answered, until a tagged answer joins it to the history. */
  let pending: string | null = null;
  let streaming: AbortController | null = null;
  let stopping = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAnnounce = -Infinity;
  let queued = '';
  let live = true;
  /** Bumped by a new chat: a request from before it must not touch the panel after. */
  let generation = 0;

  const setState = (state: string) => p.host.setAttribute('data-az-chat-state', state);

  const flushAnnounce = () => {
    announceTimer = null;
    if (!live || queued === '') return;
    lastAnnounce = Date.now();
    p.status.textContent = '';
    p.status.textContent = queued;
    queued = '';
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

  const addMessage = (who: 'visitor' | 'site', text: string): HTMLElement => {
    const item = (who === 'visitor' ? p.visitorTemplate : p.siteTemplate).cloneNode(true) as HTMLElement;
    const para = item.querySelector('p');
    if (para) para.textContent = text;
    p.transcript.append(item);
    return item;
  };

  /** The answer's text as paragraphs: copies of the template's paragraph, each filled as text. */
  const draw = (item: HTMLElement, text: string) => {
    const paras = paragraphsOf(text);
    let nodes = [...item.querySelectorAll(':scope > p')] as HTMLElement[];
    const model = nodes[0];
    if (!model) return;
    while (nodes.length < paras.length) {
      const copy = model.cloneNode(false) as HTMLElement;
      item.append(copy);
      nodes = [...nodes, copy];
    }
    paras.forEach((t, i) => { if (nodes[i].textContent !== t) nodes[i].textContent = t; });
  };

  const settle = () => {
    streaming = null;
    p.stop.hidden = true;
    p.send.hidden = false;
  };

  /** A refusal or a failure, with the fixed copy for its code (never server text). */
  const fail = (code: string, answer: HTMLElement | null) => {
    answer?.remove();
    settle();
    if (code === 'signin_required') { pending = null; setMode('signin'); showError(''); announce(CHAT_TEXT.signin, true); return; }
    if (code === 'conversation_full') { pending = null; setMode('full'); showError(''); announce(CHAT_TEXT.full, true); return; }
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
    let answer: HTMLElement | null = null;
    let text = '';
    let said = 0;
    let finished = false;
    try {
      const res = await send(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-az-request': '1' },
        body: JSON.stringify({
          page: config.page, ...(conversation ? { conversation } : {}),
          messages: [...history, { role: 'visitor', text: question }],
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let code = 'unknown';
        try {
          const body = await res.json() as { error?: unknown };
          if (typeof body?.error === 'string') code = body.error;
        } catch { /* not a JSON refusal: the generic line */ }
        if (current()) fail(code, null);
        return;
      }
      if (!res.body || !/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) {
        if (current()) fail('unknown', null);
        return;
      }
      answer = addMessage('site', '');
      answer.setAttribute('aria-busy', 'true');
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
            if (text.length > ANSWER_MAX) { ac.abort(); break; }
            draw(answer, text);
            const s = finishedSentences(text, said);
            said = s.next;
            announce(s.said);
          } else if (e.type === 'done') {
            finished = true;
            history = [...history, { role: 'visitor', text: question }, { role: 'site', text, tag: e.tag }];
            conversation = e.conversation;
            pending = null;
            answer.setAttribute('aria-busy', 'false');
            announce(finishedSentences(text, said, true).said || CHAT_TEXT.answered, true);
            settle();
            const left = leftCopy(e.left);
            if (e.left <= 0) setMode('full');
            else { setState('idle'); p.note.textContent = left; }
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
        // but it has no tagged answer, so it is not sent again.
        answer?.setAttribute('aria-busy', 'false');
        pending = null;
        settle();
        setState('idle');
        p.note.textContent = CHAT_TEXT.stopped;
        announce(CHAT_TEXT.stopped, true);
      }
    }
  };

  const ask = (raw: string) => {
    if (mode !== 'ready' || streaming) return;
    const text = visitorText(raw);
    if (text === null) {
      if (raw.trim() !== '') showError(CHAT_TEXT.tooLong);
      return;
    }
    // A new question instead of Try again: the failed one stays on screen, unsent.
    if (pending !== null) showError('');
    pending = text;
    addMessage('visitor', text);
    p.input.value = '';
    if (p.asks) p.asks.hidden = true;
    void request();
  };

  const stopAnswer = () => {
    if (!streaming) return;
    stopping = true;
    streaming.abort();
  };

  const startOver = () => {
    // The answer in flight, if any, is abandoned: its request sees a new generation and leaves the panel alone.
    generation++;
    streaming?.abort();
    settle();
    history = [];
    conversation = null;
    pending = null;
    p.transcript.replaceChildren(...greeting.map((g) => g.cloneNode(true)));
    p.note.textContent = '';
    showError('');
    void begin();
  };

  const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) =>
    el.addEventListener(type, fn as EventListener, { signal });
  on(p.form, 'submit', (e) => { e.preventDefault(); ask(p.input.value); });
  on(p.input, 'keydown', (e) => {
    // Enter sends; Shift+Enter is a new line; an IME composition is never cut short.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(p.input.value); }
  });
  on(p.host, 'keydown', (e) => { if (e.key === 'Escape' && streaming) { e.preventDefault(); stopAnswer(); } });
  on(p.stop, 'click', () => { stopAnswer(); p.input.focus({ preventScroll: true }); });
  on(p.retry, 'click', () => { p.retry.hidden = true; void request(); });
  on(p.reset, 'click', () => { startOver(); p.input.focus({ preventScroll: true }); });
  for (const b of p.asks?.querySelectorAll<HTMLButtonElement>('[data-az-chat-ask]') ?? []) {
    on(b, 'click', () => ask(b.textContent ?? ''));
  }

  /** Who may ask, decided once the session is known (signed-in visitors only, by default). */
  const begin = async () => {
    if (config.allow === 'anyone' || !options.signedIn) { setMode('ready'); return; }
    setMode('checking');
    let ok = false;
    try { ok = await options.signedIn(); } catch { ok = false; }
    if (live) setMode(ok ? 'ready' : 'signin');
  };
  const unsubscribe = config.allow === 'signedin' && options.onSession
    ? options.onSession((ok) => { if (live && mode !== 'full' && !streaming) setMode(ok ? 'ready' : 'signin'); })
    : null;
  void begin();

  return () => {
    live = false;
    streaming?.abort();
    if (announceTimer !== null) clearTimeout(announceTimer);
    unsubscribe?.();
    // Back to the shell as it shipped, so attaching again starts again.
    p.transcript.replaceChildren(...greeting.map((g) => g.cloneNode(true)));
    for (const [el, hidden] of shipped) el.hidden = hidden;
    p.note.textContent = '';
    p.error.textContent = '';
    p.status.textContent = '';
    p.input.value = '';
    p.host.removeAttribute('aria-busy');
    setState('idle');
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
    const parts = partsOf(host);
    const config = parseChatConfig(host.getAttribute('data-az-chat'));
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
