/**
 * The behaviour runtime — what makes the emitted markup do things.
 *
 * Words emit complete, correct markup and mark what needs behaviour with
 * `data-az-behaviour`. This file finds those marks and wires them. It runs
 * after the page renders, touches nothing at import time (so a server render
 * never reaches `window`), and `attach` returns a function that removes every
 * listener and state it added, so attaching twice is safe.
 *
 * Copied into every generated project; imports only its siblings.
 *
 *   dialog    a <dialog> preset (drawer, popup): overlays-spec §2 and §6
 *   dropdown  a nav group: <button aria-expanded> + a plain <ul> of links
 *   solid     a nav transparent at the top, solid after scrolling (nav §4)
 *   hide      a nav that retracts scrolling down, returns scrolling up (§3)
 *   shrink    a nav that shrinks past a threshold (§3)
 *   faq       independent disclosures, hidden="until-found" (faq §7)
 *   copy      clipboard, announced politely (buttons §1.3)
 *   play      opens the video popup next to the button
 *   carousel  a gallery track's previous/next buttons (gallery §6, §10)
 *   lightbox  a gallery's images open one popup and step through (§8)
 */

import {
  carouselEnds, copyText, counterText, lightboxIndex, moveIndex, neighbours, retractedAfter, shrunkAfter, solidAfter,
  swipeOf, transitionMs,
} from './logic.ts';
import { POLICY, isPreset } from './policy.ts';

type Cleanup = () => void;

/** What a keyboard user can land on inside a modal. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

export function attach(doc: Document): Cleanup {
  const ac = new AbortController();
  const on: On = (target, type, fn, opts = {}) =>
    target.addEventListener(type, fn, { ...opts, signal: ac.signal });
  const undo: Cleanup[] = [];

  // Every modal open right now and the function that closes it — shared, so
  // the generic dialog wiring (Escape, backdrop, Tab) closes a lightbox too.
  const modals = new Map<HTMLDialogElement, () => void>();
  wireDialogs(doc, on, undo, modals);
  wireLightboxes(doc, on, modals);
  wireCarousels(doc, on);
  wireDropdowns(doc, on);
  wireSolid(doc, on, undo);
  wireHideShrink(doc, on, undo);
  wireFaq(doc, on, undo);
  wireCopy(doc, on, undo);

  return () => {
    ac.abort();
    for (const u of undo.reverse()) u();
  };
}

type On = (target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) => void;

/* ---- modal presets on <dialog> ------------------------------------------ */

/**
 * iOS keeps scrolling the page behind a modal under `overflow: hidden`
 * alone (overlays-spec §6): the body is fixed at its offset instead, and the
 * offset restored on close.
 */
function lockScroll(doc: Document): Cleanup {
  const win = doc.defaultView;
  const body = doc.body;
  const y = win?.scrollY ?? 0;
  const previous = body.getAttribute('style');
  body.style.position = 'fixed';
  body.style.top = `${-y}px`;
  body.style.insetInline = '0';
  body.style.overflow = 'hidden';
  return () => {
    if (previous === null) body.removeAttribute('style');
    else body.setAttribute('style', previous);
    win?.scrollTo(0, y);
  };
}

/**
 * Show `dialog` modally from `trigger`, and the function that closes it.
 * Focus returns to `returnTo()` — the trigger, unless the modal has moved
 * on (a lightbox returns to the thumbnail of the image it shows).
 */
function openModal(
  doc: Document, dialog: HTMLDialogElement, trigger: HTMLElement | null,
  returnTo: () => HTMLElement | null = () => trigger,
): () => void {
  const unlock = lockScroll(doc);
  dialog.showModal();
  trigger?.setAttribute('aria-expanded', 'true');
  // A frame later, so the browser has the closed style to transition from.
  doc.defaultView?.requestAnimationFrame(() => dialog.setAttribute('data-state', 'open'));

  let closing = false;
  return () => {
    if (closing || !dialog.open) return;
    closing = true;
    dialog.removeAttribute('data-state');
    for (const media of dialog.querySelectorAll('video, audio')) (media as HTMLMediaElement).pause();
    const cs = doc.defaultView?.getComputedStyle(dialog);
    // Exit is faster than enter (overlays-spec §3); wait it out, then close.
    const wait = cs ? transitionMs(cs.transitionDuration, cs.transitionDelay) : 0;
    doc.defaultView?.setTimeout(() => {
      dialog.close();
      unlock();
      trigger?.setAttribute('aria-expanded', 'false');
      // §6: return focus to the trigger, never to <body>.
      const back = returnTo();
      back?.focus();
      back?.scrollIntoView({ block: 'nearest' });
    }, wait);
  };
}

function wireDialogs(doc: Document, on: On, undo: Cleanup[], current: Map<HTMLDialogElement, () => void>): void {
  undo.push(() => {
    for (const [dialog] of current) if (dialog.open) dialog.close();
    current.clear();
  });

  const openFrom = (dialog: HTMLDialogElement, trigger: HTMLElement | null) => {
    const preset = dialog.getAttribute('data-az-overlay');
    // A modal preset traps focus and makes the page inert — which showModal
    // gives natively: the top layer, inert background, contained focus.
    if (dialog.open || !isPreset(preset) || !POLICY[preset].modal) return;
    current.set(dialog, openModal(doc, dialog, trigger));
  };
  const close = (dialog: HTMLDialogElement) => current.get(dialog)?.();

  // Triggers: a button that controls a dialog (the nav toggle), or a play
  // button whose popup is its next sibling (the popup lives beside it).
  for (const trigger of doc.querySelectorAll<HTMLElement>('[aria-controls], [data-az-behaviour="play"]')) {
    const dialog = trigger.getAttribute('data-az-behaviour') === 'play'
      ? trigger.nextElementSibling
      : doc.getElementById(trigger.getAttribute('aria-controls') ?? '');
    if (!(dialog instanceof HTMLDialogElement) || dialog.getAttribute('data-az-behaviour') !== 'dialog') continue;
    on(trigger, 'click', () => openFrom(dialog, trigger));
  }

  for (const dialog of doc.querySelectorAll<HTMLDialogElement>('dialog[data-az-behaviour="dialog"]')) {
    // Escape arrives as `cancel`: animate the close instead of snapping shut.
    on(dialog, 'cancel', (e) => { e.preventDefault(); close(dialog); });
    // A click on the dialog box itself, not its content, is on the backdrop.
    on(dialog, 'click', (e) => { if (e.target === dialog) close(dialog); });
    for (const x of dialog.querySelectorAll('[data-az-close]')) on(x, 'click', () => close(dialog));
    // nav §6 / overlays §2: Tab cycles INSIDE the modal. showModal makes the
    // page inert, but Tab can still leave for the browser's own UI — past
    // the last control everywhere, and in WebKit from ANY control, because
    // it leaves links out of the Tab order by default. So every Tab in the
    // modal is placed here, through the modal's own stops, wrapping round.
    on(dialog, 'keydown', (e) => {
      const k = e as KeyboardEvent;
      if (k.key !== 'Tab') return;
      const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (stops.length === 0) return;
      k.preventDefault();
      const at = stops.indexOf(doc.activeElement as HTMLElement);
      const step = k.shiftKey ? -1 : 1;
      stops[(at + step + stops.length) % stops.length].focus();
    });
    // A link inside the menu navigates away; close first so nothing is left
    // locked if the navigation is to an anchor on this page.
    for (const link of dialog.querySelectorAll('a[href]')) on(link, 'click', () => close(dialog));
  }
}

/* ---- gallery lightbox ----------------------------------------------------- */

/**
 * gallery-spec §8. Each image is a <button data-az-index>; the gallery holds
 * one popup <dialog>. The runtime shows the chosen image, steps with the
 * arrow keys, Home and End WITHOUT wrapping, says "3 of 18" politely,
 * preloads the neighbours only, and returns focus to the thumbnail of the
 * image on show — not the one that opened it.
 */
function wireLightboxes(doc: Document, on: On, modals: Map<HTMLDialogElement, () => void>): void {
  for (const box of doc.querySelectorAll<HTMLElement>('[data-az-behaviour="lightbox"]')) {
    const dialog = box.querySelector<HTMLDialogElement>('dialog[data-az-behaviour="dialog"]');
    const thumbs = [...box.querySelectorAll<HTMLButtonElement>('button[data-az-index]')];
    if (!dialog || thumbs.length === 0) continue;
    const img = dialog.querySelector<HTMLImageElement>('[data-az-lightbox-image]');
    const caption = dialog.querySelector<HTMLElement>('[data-az-lightbox-caption]');
    const counter = dialog.querySelector<HTMLElement>('[data-az-lightbox-counter]');
    const prev = dialog.querySelector<HTMLButtonElement>('[data-az-step="-1"]');
    const next = dialog.querySelector<HTMLButtonElement>('[data-az-step="1"]');
    let index = 0;

    const imageOf = (i: number) => thumbs[i].querySelector('img');
    const show = (i: number) => {
      index = i;
      const source = imageOf(i);
      if (img && source) { img.src = source.currentSrc || source.src; img.alt = source.alt; }
      if (caption) caption.textContent = thumbs[i].getAttribute('data-az-caption') ?? '';
      if (counter) counter.textContent = counterText(i, thumbs.length);
      // No wrap (§8): the end buttons say so — aria-disabled keeps a focused
      // button focused, where `disabled` would drop focus to the page.
      prev?.setAttribute('aria-disabled', String(i === 0));
      next?.setAttribute('aria-disabled', String(i === thumbs.length - 1));
      for (const n of neighbours(i, thumbs.length)) {
        const src = imageOf(n);
        if (!src) continue;
        const pre = new Image();
        pre.fetchPriority = 'low';
        pre.src = src.currentSrc || src.src;
      }
    };
    const step = (to: number | null) => { if (to !== null && to !== index) show(to); };

    thumbs.forEach((thumb, i) => on(thumb, 'click', () => {
      if (dialog.open) return;
      show(i);
      modals.set(dialog, openModal(doc, dialog, thumb, () => thumbs[index]));
    }));
    on(dialog, 'keydown', (e) => {
      const k = e as KeyboardEvent;
      const to = lightboxIndex(k.key, index, thumbs.length);
      if (to === null) return;
      // Arrows must not scroll the page behind (§8), nor move focus.
      k.preventDefault();
      step(to);
    });
    if (prev) on(prev, 'click', () => step(lightboxIndex('ArrowLeft', index, thumbs.length)));
    if (next) on(next, 'click', () => step(lightboxIndex('ArrowRight', index, thumbs.length)));
    // §8 touch: left/right steps, down closes — as the sheet gesture does.
    let start: { x: number; y: number } | null = null;
    on(dialog, 'pointerdown', (e) => { const p = e as PointerEvent; if (p.pointerType !== 'mouse') start = { x: p.clientX, y: p.clientY }; });
    on(dialog, 'pointerup', (e) => {
      if (!start) return;
      const p = e as PointerEvent;
      const swipe = swipeOf(p.clientX - start.x, p.clientY - start.y);
      start = null;
      if (swipe === 'next') step(lightboxIndex('ArrowRight', index, thumbs.length));
      else if (swipe === 'previous') step(lightboxIndex('ArrowLeft', index, thumbs.length));
      else if (swipe === 'close') modals.get(dialog)?.();
    });
  }
}

/* ---- gallery carousel ----------------------------------------------------- */

/**
 * gallery-spec §6/§10: the carousel's previous/next buttons scroll the track
 * by one slide and say when an end is reached (aria-disabled). Scrolling is
 * instant under reduced motion (§10: all carousel motion is off there).
 */
function wireCarousels(doc: Document, on: On): void {
  const win = doc.defaultView;
  if (!win) return;
  for (const carousel of doc.querySelectorAll<HTMLElement>('[data-az-behaviour="carousel"]')) {
    const track = carousel.querySelector<HTMLElement>('[data-az-track]');
    const buttons = [...carousel.querySelectorAll<HTMLButtonElement>('button[data-az-step]')];
    if (!track || buttons.length === 0) continue;
    const update = () => {
      const { atStart, atEnd } = carouselEnds(track.scrollLeft, track.clientWidth, track.scrollWidth);
      for (const b of buttons) b.setAttribute('aria-disabled', String(b.getAttribute('data-az-step') === '-1' ? atStart : atEnd));
    };
    for (const b of buttons) {
      on(b, 'click', () => {
        if (b.getAttribute('aria-disabled') === 'true') return;
        const slide = track.querySelector('li');
        const gap = parseFloat(win.getComputedStyle(track).columnGap) || 0;
        const by = (slide?.getBoundingClientRect().width ?? track.clientWidth) + gap;
        const reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
        track.scrollBy({ left: Number(b.getAttribute('data-az-step')) * by, behavior: reduce ? 'instant' : 'smooth' });
      });
    }
    on(track, 'scroll', update, { passive: true });
    on(win, 'resize', update, { passive: true });
    update();
  }
}

/* ---- dropdowns ------------------------------------------------------------ */

function wireDropdowns(doc: Document, on: On): void {
  const groups = [...doc.querySelectorAll<HTMLElement>('[data-az-behaviour="dropdown"]')];
  const parts = groups.map((group) => {
    const button = group.querySelector<HTMLButtonElement>('button[aria-controls]');
    const list = button ? doc.getElementById(button.getAttribute('aria-controls') ?? '') : null;
    return button && list ? { group, button, list } : null;
  }).filter((p): p is { group: HTMLElement; button: HTMLButtonElement; list: HTMLElement } => p !== null);

  const links = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('a[href]')];

  const close = (p: (typeof parts)[number], focusButton = false) => {
    if (p.list.hidden) return;
    p.list.removeAttribute('data-state');
    p.list.hidden = true;
    p.button.setAttribute('aria-expanded', 'false');
    if (focusButton) p.button.focus();
  };
  const open = (p: (typeof parts)[number], focusFirst: boolean) => {
    for (const other of parts) if (other !== p) close(other);
    p.list.hidden = false;
    p.button.setAttribute('aria-expanded', 'true');
    // Shift, not flip: a nav dropdown always has room below the bar, but one
    // near the right edge must not run off the screen (overlays-spec §1).
    const win = doc.defaultView;
    p.list.style.insetInlineStart = '';
    p.list.style.insetInlineEnd = '';
    if (win && p.list.getBoundingClientRect().right > win.innerWidth) {
      p.list.style.insetInlineStart = 'auto';
      p.list.style.insetInlineEnd = '0';
    }
    win?.requestAnimationFrame(() => p.list.setAttribute('data-state', 'open'));
    // nav-spec §7: roving tabindex — one link in the tab order at a time, so
    // Tab leaves the list and carries on down the page (overlays-spec §2).
    const items = links(p.list);
    items.forEach((a, i) => a.setAttribute('tabindex', i === 0 ? '0' : '-1'));
    if (focusFirst) items[0]?.focus();
  };

  for (const p of parts) {
    on(p.button, 'click', () => (p.list.hidden ? open(p, false) : close(p)));
    on(p.button, 'keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'ArrowDown') { e.preventDefault(); open(p, true); }
      if (k === 'Escape') close(p, true);
    });
    on(p.list, 'keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Escape') { e.preventDefault(); close(p, true); return; }
      const items = links(p.list);
      const next = moveIndex(k, items.indexOf(doc.activeElement as HTMLElement), items.length);
      if (next === null) return;
      e.preventDefault();
      items.forEach((a, i) => a.setAttribute('tabindex', i === next ? '0' : '-1'));
      items[next].focus();
    });
    // Focus leaving the group — Tab onward, or a click elsewhere — closes it.
    // Leaving for nowhere counts: when Tab runs off the page (WebKit skips
    // the links that follow), focus goes to the browser and `relatedTarget`
    // is null.
    on(p.group, 'focusout', (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (!to || !p.group.contains(to)) close(p);
    });
  }
  on(doc, 'pointerdown', (e) => {
    for (const p of parts) if (!p.group.contains(e.target as Node)) close(p);
  });
  // §6: dropdowns close on scroll; an anchored list drifting off its trigger
  // is the classic broken look.
  if (doc.defaultView) on(doc.defaultView, 'scroll', () => { for (const p of parts) close(p); }, { passive: true });
}

/* ---- the solid nav -------------------------------------------------------- */

function wireSolid(doc: Document, on: On, undo: Cleanup[]): void {
  const win = doc.defaultView;
  if (!win) return;
  for (const nav of doc.querySelectorAll<HTMLElement>('[data-az-behaviour="solid"]')) {
    // The nav and each logo carry the state, so each can be styled by it:
    // the light logo shows at the top, the regular one once solid (§4).
    const marked = [nav, ...nav.querySelectorAll<HTMLElement>('[data-az-logo]')];
    let solid = false;
    const apply = () => {
      const next = solidAfter(win.scrollY, solid);
      if (next === solid && nav.hasAttribute('data-scrolled')) return;
      solid = next;
      for (const el of marked) el.setAttribute('data-scrolled', String(solid));
    };
    apply();
    on(win, 'scroll', apply, { passive: true });
    undo.push(() => { for (const el of marked) el.removeAttribute('data-scrolled'); });
  }
}

/* ---- hide and shrink ------------------------------------------------------ */

function wireHideShrink(doc: Document, on: On, undo: Cleanup[]): void {
  const win = doc.defaultView;
  if (!win) return;
  for (const nav of doc.querySelectorAll<HTMLElement>('[data-az-hide], [data-az-shrink]')) {
    const hides = nav.hasAttribute('data-az-hide');
    const shrinks = nav.hasAttribute('data-az-shrink');
    // The logos shrink with the bar, so they carry its state too.
    const marked = [nav, ...nav.querySelectorAll<HTMLElement>('[data-az-logo]')];
    // Where the bar sits at rest: hiding it any earlier would open a page
    // with the nav missing.
    const barHeight = nav.getBoundingClientRect().height;
    let shrunk = false;
    let retracted = false;
    let lastY = win.scrollY;
    let fromY = lastY;
    const mark = (name: string, value: boolean) => { for (const el of marked) el.setAttribute(name, String(value)); };
    const apply = () => {
      const y = win.scrollY;
      // A change of direction starts a new run of travel.
      if ((y > lastY) !== (lastY > fromY) && y !== lastY) fromY = lastY;
      lastY = y;
      if (shrinks) {
        const next = shrunkAfter(y, shrunk);
        if (next !== shrunk || !nav.hasAttribute('data-shrunk')) { shrunk = next; mark('data-shrunk', shrunk); }
      }
      if (hides) {
        // Never retract while something inside the bar is open or focused:
        // a keyboard user must not tab into an invisible nav.
        const busy = nav.contains(doc.activeElement) || nav.querySelector('[aria-expanded="true"]') !== null;
        const next = busy ? false : retractedAfter(fromY, y, retracted, barHeight);
        if (next !== retracted || !nav.hasAttribute('data-retracted')) { retracted = next; mark('data-retracted', retracted); }
      }
    };
    apply();
    on(win, 'scroll', apply, { passive: true });
    if (hides) on(nav, 'focusin', () => { retracted = false; mark('data-retracted', false); });
    undo.push(() => { for (const el of marked) { el.removeAttribute('data-shrunk'); el.removeAttribute('data-retracted'); } });
  }
}

/* ---- faq disclosures ------------------------------------------------------ */

function wireFaq(doc: Document, on: On, undo: Cleanup[]): void {
  for (const list of doc.querySelectorAll<HTMLElement>('[data-az-behaviour="faq"]')) {
    const single = list.getAttribute('data-single') === 'true';
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button[data-az-disclosure]')];
    const panelOf = (b: HTMLButtonElement) => doc.getElementById(b.getAttribute('aria-controls') ?? '');
    const set = (b: HTMLButtonElement, open: boolean) => {
      const panel = panelOf(b);
      if (!panel) return;
      // faq §7.3: hidden="until-found", never removed from the page, so
      // find-in-page still reaches every answer. §8: aria-expanded flips on
      // every change, and the chevron follows it.
      if (open) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', 'until-found');
      b.setAttribute('aria-expanded', String(open));
      const chevron = b.querySelector('[data-az-chevron]');
      if (open) chevron?.setAttribute('data-state', 'open');
      else chevron?.removeAttribute('data-state');
    };
    const hash = decodeURIComponent(doc.defaultView?.location.hash.slice(1) ?? '');

    // The markup ships every answer open (§8: with JS off every panel is
    // readable); collapse now, before first paint — except a deep-linked one,
    // which opens first and is scrolled to after (§7.4).
    let linked: HTMLButtonElement | null = null;
    for (const b of buttons) {
      const heading = b.closest('h3');
      const isLinked = hash !== '' && heading?.id === hash;
      set(b, isLinked);
      if (isLinked) linked = b;
    }
    if (linked) linked.closest('h3')?.scrollIntoView();
    undo.push(() => { for (const b of buttons) set(b, true); });

    for (const b of buttons) {
      on(b, 'click', () => {
        const open = b.getAttribute('aria-expanded') !== 'true';
        if (open && single) for (const other of buttons) if (other !== b) set(other, false);
        set(b, open);
      });
      on(b, 'keydown', (e) => {
        const next = moveIndex((e as KeyboardEvent).key, buttons.indexOf(b), buttons.length);
        if (next === null) return;
        e.preventDefault();
        buttons[next].focus();
      });
      // §7.3: find-in-page opens a hidden answer and fires `beforematch`.
      const panel = panelOf(b);
      if (panel) on(panel, 'beforematch', () => set(b, true));
    }
  }
}

/* ---- copy ----------------------------------------------------------------- */

function wireCopy(doc: Document, on: On, undo: Cleanup[]): void {
  const buttons = [...doc.querySelectorAll<HTMLElement>('[data-az-behaviour="copy"]')];
  if (buttons.length === 0) return;
  // One polite live region, outside the page tree: a confirmation must be
  // heard without moving focus (overlays-spec §6, toasts never steal focus).
  const status = doc.createElement('div');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.className = 'az-live';
  doc.body.append(status);
  undo.push(() => status.remove());

  for (const b of buttons) {
    on(b, 'click', () => {
      const text = copyText(b.getAttribute('data-az-target') ?? '');
      const clipboard = doc.defaultView?.navigator.clipboard;
      const say = (message: string) => { status.textContent = ''; status.textContent = message; };
      if (!clipboard) { say('Copy is not available in this browser'); return; }
      clipboard.writeText(text).then(() => say('Copied'), () => say('Could not copy'));
    });
  }
}
