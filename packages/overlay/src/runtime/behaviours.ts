/**
 * @az runtime behaviours
 * Purpose: what makes the emitted markup interactive: dialogs, dropdowns, nav scroll, faq, copy, billing, year, lightbox, carousel, reveal.
 * Spec: docs/overlays-spec.md · docs/nav-block-spec.md · docs/faq-block-spec.md
 * Exports: attach
 * Edit guide: wire by data-az-behaviour; each element once (late content via MutationObserver); attach() returns full cleanup.
 * Tests: packages/overlay/test/fixes.test.ts, scripts/visual/behaviours.mjs
 */

/**
 * The behaviour runtime — what makes the emitted markup do things.
 *
 * Words emit complete, correct markup and mark what needs behaviour with
 * `data-az-behaviour`. This file finds those marks and wires them. It runs
 * after the page renders, touches nothing at import time (so a server render
 * never reaches `window`), and `attach` returns a function that removes every
 * listener and state it added, so attaching twice is safe.
 *
 * Markup that arrives AFTER the first render is wired too: a page behind
 * <Protected> renders its content only once the session check resolves, so
 * `attach` watches the document and wires each new subtree as it is added.
 * Every element is wired at most once.
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
 *   billing   pricing's Monthly/Annual toggle (pricing §7.1)
 *   year      footer `year dynamic`: the rolling copyright year (footer §4)
 *   reveal    `reveal` blocks rise into view once (feature §9); hidden by script only
 */

import {
  billingAnnouncement, billingFrom, carouselEnds, copyText, counterText, lightboxImage, lightboxIndex, moveIndex, neighbours,
  offScreen, outsideBox, retractedAfter, revealDelay, revealsLater, rollingYear, safeDecode, samePageFragment, sheetDismissed,
  shrunkAfter, solidAfter, swipeOf, transitionMs, trapIndex, type Billing,
} from './logic.ts';
import { POLICY, isPreset } from './policy.ts';

type Cleanup = () => void;
type On = (target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) => void;

/** What a keyboard user can land on inside a modal. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * The root attribute that says the page is scroll-locked, holding the offset
 * it was locked at. While it is set `window.scrollY` reads 0, so anything
 * driven by scroll position — the nav's hide/solid state, the 3D backdrop —
 * reads this instead of reacting to the lock as if the reader had scrolled.
 */
const SCROLL_LOCK = 'data-az-scroll-lock';

/** How long the live region stays empty before a message, so a repeat is heard again. */
const ANNOUNCE_GAP_MS = 100;

/** An open modal: animate it closed, or close it at once (cleanup). */
interface Modal {
  close(after?: () => void): void;
  now(): void;
}

interface Ctx {
  readonly doc: Document;
  readonly win: Window | null;
  readonly on: On;
  readonly undo: Cleanup[];
  readonly modals: Map<HTMLDialogElement, Modal>;
  readonly dropdowns: Dropdown[];
  /** True the first time an element is seen under `role`; false after. */
  fresh(el: Element, role: string): boolean;
  /** Say `message` politely, without moving focus. */
  announce(message: string): void;
}

export function attach(doc: Document): Cleanup {
  const ac = new AbortController();
  const on: On = (target, type, fn, opts = {}) =>
    target.addEventListener(type, fn, { ...opts, signal: ac.signal });
  const undo: Cleanup[] = [];
  const win = doc.defaultView;
  const seen = new Map<string, WeakSet<Element>>();

  // One polite live region, created when first needed, outside the page
  // tree: a confirmation must be heard without moving focus (overlays-spec
  // §6, toasts never steal focus).
  let status: HTMLElement | null = null;
  let pending = 0;
  const announce = (message: string) => {
    if (!status) {
      status = doc.createElement('div');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.className = 'az-live';
      doc.body.append(status);
    }
    const region = status;
    // Emptied first, filled a moment later: the same text set twice in one
    // task is no change at all, and a second "Copied" would go unheard.
    region.textContent = '';
    if (pending) win?.clearTimeout(pending);
    pending = win?.setTimeout(() => { pending = 0; region.textContent = message; }, ANNOUNCE_GAP_MS) ?? 0;
  };
  undo.push(() => {
    if (pending) win?.clearTimeout(pending);
    status?.remove();
  });

  const ctx: Ctx = {
    doc, win, on, undo, modals: new Map(), dropdowns: [],
    fresh(el, role) {
      let set = seen.get(role);
      if (!set) { set = new WeakSet(); seen.set(role, set); }
      if (set.has(el)) return false;
      set.add(el);
      return true;
    },
    announce,
  };

  wireModalCleanup(ctx);
  wireDropdownsGlobal(ctx);
  const scan = (root: ParentNode) => {
    wireDialogs(ctx, root);
    wireLightboxes(ctx, root);
    wireCarousels(ctx, root);
    wireDropdowns(ctx, root);
    wireSolid(ctx, root);
    wireHideShrink(ctx, root);
    wireFaq(ctx, root);
    wireCopy(ctx, root);
    wireBilling(ctx, root);
    wireYear(ctx, root);
    wireReveal(ctx, root);
  };
  scan(doc);

  // Content rendered later — a protected page after its session check —
  // is wired as it arrives.
  const observer = win ? new win.MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n as Element);
  }) : null;
  observer?.observe(doc.body, { childList: true, subtree: true });

  return () => {
    observer?.disconnect();
    ac.abort();
    for (const u of undo.reverse()) u();
  };
}

/** Elements under `root` (itself included) matching `selector`. */
function find<T extends Element>(root: ParentNode, selector: string): T[] {
  const self = root instanceof Element && root.matches(selector) ? [root as T] : [];
  return [...self, ...root.querySelectorAll<T>(selector)];
}

/* ---- modal presets on <dialog> ------------------------------------------ */

/**
 * iOS keeps scrolling the page behind a modal under `overflow: hidden`
 * alone (overlays-spec §6): the body is fixed at its offset instead, and the
 * offset restored on close. One lock at a time: a second modal on top of the
 * first shares it.
 */
function lockScroll(doc: Document): Cleanup {
  const root = doc.documentElement;
  if (root.hasAttribute(SCROLL_LOCK)) return () => undefined;
  const win = doc.defaultView;
  const body = doc.body;
  const y = win?.scrollY ?? 0;
  const previous = body.getAttribute('style');
  root.setAttribute(SCROLL_LOCK, String(y));
  body.style.position = 'fixed';
  body.style.top = `${-y}px`;
  body.style.insetInline = '0';
  body.style.overflow = 'hidden';
  return () => {
    if (previous === null) body.removeAttribute('style');
    // Through the CSSOM, never setAttribute: the page's policy refuses a
    // style attribute written as markup (word-quality-gate §2 B).
    else body.style.cssText = previous;
    // Instant: the site smooth-scrolls, and a smooth restore would start at
    // the top the lock clamped the page to and glide down — or be cut short
    // by the next scroll and end somewhere else.
    win?.scrollTo({ top: y, left: 0, behavior: 'instant' });
    root.removeAttribute(SCROLL_LOCK);
  };
}

/**
 * Show `dialog` modally from `trigger`. Focus returns to `returnTo()` — the
 * trigger, unless the modal has moved on (a lightbox returns to the
 * thumbnail of the image it shows).
 */
function openModal(
  doc: Document, dialog: HTMLDialogElement, trigger: HTMLElement | null,
  returnTo: () => HTMLElement | null = () => trigger,
): Modal {
  const win = doc.defaultView;
  const unlock = lockScroll(doc);
  dialog.showModal();
  trigger?.setAttribute('aria-expanded', 'true');
  // A frame later, so the browser has the closed style to transition from.
  win?.requestAnimationFrame(() => { if (dialog.open) dialog.setAttribute('data-state', 'open'); });

  let closing = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.removeAttribute('data-state');
    if (dialog.open) dialog.close();
    unlock();
    trigger?.setAttribute('aria-expanded', 'false');
  };
  return {
    close(after) {
      if (closing || done) return;
      closing = true;
      dialog.removeAttribute('data-state');
      for (const media of dialog.querySelectorAll('video, audio')) (media as HTMLMediaElement).pause();
      const cs = win?.getComputedStyle(dialog);
      // Exit is faster than enter (overlays-spec §3); wait it out, then close.
      const wait = cs ? transitionMs(cs.transitionDuration, cs.transitionDelay) : 0;
      const end = () => {
        finish();
        // §6: return focus to the trigger, never to <body> — without letting
        // the focus scroll the page the unlock just restored.
        const back = returnTo();
        back?.focus({ preventScroll: true });
        if (after) after();
        // Only a trigger that is off screen is brought back: `nearest` counts
        // the page's scroll-padding, so a sticky bar's toggle — on screen, in
        // that padding — would otherwise pull the page up by the bar's height.
        else if (back && win && offScreen(back.getBoundingClientRect(), win.innerHeight)) {
          back.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
      };
      if (win) win.setTimeout(end, wait);
      else end();
    },
    now: finish,
  };
}

/** Cleanup with a modal open: close it at once and give the page its scroll back. */
function wireModalCleanup(ctx: Ctx): void {
  ctx.undo.push(() => {
    for (const m of ctx.modals.values()) m.now();
    ctx.modals.clear();
  });
}

/**
 * A same-page fragment, after the page is unlocked. Assigning the hash is a
 * real fragment navigation (`:target`, hashchange, scroll-padding); the same
 * hash again is no navigation, so its target is brought into view directly.
 */
function goToFragment(doc: Document, hash: string): void {
  const win = doc.defaultView;
  if (!win) return;
  if (win.location.hash !== hash) {
    win.location.hash = hash;
    return;
  }
  const id = safeDecode(hash.slice(1));
  (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView();
}

function wireDialogs(ctx: Ctx, root: ParentNode): void {
  const { doc, on, modals } = ctx;

  const openFrom = (dialog: HTMLDialogElement, trigger: HTMLElement | null) => {
    const preset = dialog.getAttribute('data-az-overlay');
    // A modal preset traps focus and makes the page inert — which showModal
    // gives natively: the top layer, inert background, contained focus.
    if (dialog.open || !isPreset(preset) || !POLICY[preset].modal) return;
    modals.set(dialog, openModal(doc, dialog, trigger));
  };
  const close = (dialog: HTMLDialogElement, after?: () => void) => modals.get(dialog)?.close(after);

  // Triggers: a button that controls a dialog (the nav toggle), or a play
  // button whose popup is its next sibling (the popup lives beside it). The
  // dialog is looked up on click, so a trigger wired before its dialog
  // rendered still finds it.
  for (const trigger of find<HTMLElement>(root, '[aria-controls], [data-az-behaviour="play"]')) {
    if (!ctx.fresh(trigger, 'trigger')) continue;
    on(trigger, 'click', () => {
      const dialog = trigger.getAttribute('data-az-behaviour') === 'play'
        ? trigger.nextElementSibling
        : doc.getElementById(trigger.getAttribute('aria-controls') ?? '');
      if (!(dialog instanceof HTMLDialogElement) || dialog.getAttribute('data-az-behaviour') !== 'dialog') return;
      openFrom(dialog, trigger);
    });
  }

  for (const dialog of find<HTMLDialogElement>(root, 'dialog[data-az-behaviour="dialog"]')) {
    if (!ctx.fresh(dialog, 'dialog')) continue;
    // Escape arrives as `cancel`: animate the close instead of snapping shut.
    on(dialog, 'cancel', (e) => { e.preventDefault(); close(dialog); });
    // The backdrop is outside the dialog's box. A click in the box's own
    // padding also targets the dialog, so the point decides, not the target.
    on(dialog, 'click', (e) => {
      if (e.target !== dialog) return;
      const m = e as MouseEvent;
      if (outsideBox(m.clientX, m.clientY, dialog.getBoundingClientRect())) close(dialog);
    });
    for (const x of dialog.querySelectorAll('[data-az-close]')) on(x, 'click', () => close(dialog));
    if (dialog.getAttribute('data-az-overlay') === 'sheet') wireSheetDrag(ctx, dialog, close);
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
      stops[trapIndex(stops.indexOf(doc.activeElement as HTMLElement), stops.length, k.shiftKey)].focus();
    });
    // A link in the menu: a fragment of this page cannot be reached while
    // the page is scroll-locked, so the jump waits until the menu has closed
    // and the page is unlocked. Any other link navigates away as usual.
    for (const link of dialog.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      on(link, 'click', (e) => {
        const here = doc.defaultView?.location;
        if (here && modals.has(dialog) && samePageFragment(link, here)) {
          e.preventDefault();
          close(dialog, () => goToFragment(doc, link.hash));
        } else {
          close(dialog);
        }
      });
    }
  }
}

/**
 * overlays-spec §2 `sheet`: drag the handle down to dismiss. The sheet follows
 * the pointer with no transition; released past the threshold it closes (the
 * exit continues from where it is), otherwise it springs back. Esc and the
 * close button remain for everyone who does not drag.
 */
function wireSheetDrag(
  ctx: Ctx, dialog: HTMLDialogElement, close: (d: HTMLDialogElement) => void,
): void {
  const handle = dialog.querySelector<HTMLElement>('[data-az-drag]');
  if (!handle) return;
  let start: number | null = null;
  let dy = 0;
  const release = () => {
    if (start === null) return;
    start = null;
    dialog.style.transition = '';
    dialog.style.transform = '';
    if (sheetDismissed(dy, dialog.getBoundingClientRect().height)) close(dialog);
    dy = 0;
  };
  ctx.on(handle, 'pointerdown', (e) => {
    const p = e as PointerEvent;
    start = p.clientY;
    dy = 0;
    handle.setPointerCapture?.(p.pointerId);
    dialog.style.transition = 'none';
  });
  ctx.on(handle, 'pointermove', (e) => {
    if (start === null) return;
    dy = Math.max(0, (e as PointerEvent).clientY - start);
    dialog.style.transform = `translateY(${dy}px)`;
  });
  ctx.on(handle, 'pointerup', release);
  ctx.on(handle, 'pointercancel', release);
  ctx.on(handle, 'lostpointercapture', release);
  ctx.undo.push(() => { dialog.style.transition = ''; dialog.style.transform = ''; });
}

/* ---- gallery lightbox ----------------------------------------------------- */

/**
 * gallery-spec §8. Each image is a <button data-az-index>; the gallery holds
 * one popup <dialog>. The runtime shows the chosen image, steps with the
 * arrow keys, Home and End WITHOUT wrapping, says "3 of 18" politely,
 * preloads the neighbours only, and returns focus to the thumbnail of the
 * image on show — not the one that opened it.
 */
function wireLightboxes(ctx: Ctx, root: ParentNode): void {
  const { doc, on, modals } = ctx;
  for (const box of find<HTMLElement>(root, '[data-az-behaviour="lightbox"]')) {
    if (!ctx.fresh(box, 'lightbox')) continue;
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
      if (img && source) {
        const shown = lightboxImage(source);
        for (const name of ['srcset', 'width', 'height'] as const) {
          const value = shown[name];
          if (value === null) img.removeAttribute(name);
          else img.setAttribute(name, value);
        }
        img.src = shown.src;
        img.alt = shown.alt;
      }
      if (caption) caption.textContent = thumbs[i].getAttribute('data-az-caption') ?? '';
      if (counter) counter.textContent = counterText(i, thumbs.length);
      // No wrap (§8): the end buttons say so — aria-disabled keeps a focused
      // button focused, where `disabled` would drop focus to the page.
      prev?.setAttribute('aria-disabled', String(i === 0));
      next?.setAttribute('aria-disabled', String(i === thumbs.length - 1));
      for (const n of neighbours(i, thumbs.length)) {
        const src = imageOf(n);
        if (!src) continue;
        // The file the lightbox will show: with a srcset, the one the
        // dialog's own `sizes` picks.
        const shown = lightboxImage(src);
        const pre = new Image();
        pre.fetchPriority = 'low';
        if (shown.srcset !== null && img) {
          pre.sizes = img.sizes;
          pre.srcset = shown.srcset;
        }
        pre.src = shown.src;
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
      else if (swipe === 'close') modals.get(dialog)?.close();
    });
  }
}

/* ---- gallery carousel ----------------------------------------------------- */

/**
 * gallery-spec §6/§10: the carousel's previous/next buttons scroll the track
 * by one slide and say when an end is reached (aria-disabled). Scrolling is
 * instant under reduced motion (§10: all carousel motion is off there).
 * The ends are read again whenever the track or a slide changes size, not
 * only on scroll and window resize: the runtime can attach before the
 * stylesheet applies (WebKit runs the module script ahead of a stylesheet
 * linked after it), when the unstyled track has nothing to scroll — and a
 * reading taken then would mark "next" unavailable for good.
 */
function wireCarousels(ctx: Ctx, root: ParentNode): void {
  const { on } = ctx;
  // The document's view, typed with its globals (ResizeObserver).
  const win = ctx.doc.defaultView;
  if (!win) return;
  for (const carousel of find<HTMLElement>(root, '[data-az-behaviour="carousel"]')) {
    if (!ctx.fresh(carousel, 'carousel')) continue;
    const track = carousel.querySelector<HTMLElement>('[data-az-track]');
    const buttons = [...carousel.querySelectorAll<HTMLButtonElement>('button[data-az-step]')];
    if (!track || buttons.length === 0) continue;
    const update = () => {
      const { atStart, atEnd } = carouselEnds(track.scrollLeft, track.clientWidth, track.scrollWidth);
      for (const b of buttons) b.setAttribute('aria-disabled', String(b.getAttribute('data-az-step') === '-1' ? atStart : atEnd));
    };
    for (const b of buttons) {
      on(b, 'click', () => {
        // Read from the layout as it is now: a size change is reported only
        // at the next frame, and a click can come before it.
        update();
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
    if (typeof win.ResizeObserver === 'function') {
      const sizes = new win.ResizeObserver(update);
      for (const el of [track, ...track.children]) sizes.observe(el);
      ctx.undo.push(() => sizes.disconnect());
    }
    update();
  }
}

/* ---- dropdowns ------------------------------------------------------------ */

interface Dropdown {
  readonly group: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly list: HTMLElement;
  /** The pending hide after the exit transition, if one is running. */
  timer: number;
}

const expanded = (p: Dropdown) => p.button.getAttribute('aria-expanded') === 'true';

/**
 * Close `p`: the state goes at once (aria-expanded, and the style's `open`),
 * and `hidden` follows once the exit transition has run — set at once, it
 * would take the list out of the layout before the exit could be seen.
 */
function closeDropdown(ctx: Ctx, p: Dropdown, focusButton = false): void {
  if (!expanded(p)) return;
  p.list.removeAttribute('data-state');
  p.button.setAttribute('aria-expanded', 'false');
  if (focusButton) p.button.focus();
  const win = ctx.win;
  const cs = win?.getComputedStyle(p.list);
  const wait = cs ? transitionMs(cs.transitionDuration, cs.transitionDelay) : 0;
  if (!win || wait <= 0) { p.list.hidden = true; return; }
  if (p.timer) win.clearTimeout(p.timer);
  p.timer = win.setTimeout(() => { p.timer = 0; p.list.hidden = true; }, wait);
}

/** The listeners every dropdown shares, once per page. */
function wireDropdownsGlobal(ctx: Ctx): void {
  const { doc, on, win } = ctx;
  on(doc, 'pointerdown', (e) => {
    for (const p of ctx.dropdowns) if (!p.group.contains(e.target as Node)) closeDropdown(ctx, p);
  });
  // §6: dropdowns close on scroll; an anchored list drifting off its trigger
  // is the classic broken look.
  if (win) on(win, 'scroll', () => { for (const p of ctx.dropdowns) closeDropdown(ctx, p); }, { passive: true });
  ctx.undo.push(() => {
    for (const p of ctx.dropdowns) if (p.timer) win?.clearTimeout(p.timer);
  });
}

function wireDropdowns(ctx: Ctx, root: ParentNode): void {
  const { doc, on } = ctx;
  const links = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('a[href]')];

  const open = (p: Dropdown, focusFirst: boolean) => {
    for (const other of ctx.dropdowns) if (other !== p) closeDropdown(ctx, other);
    if (p.timer) { ctx.win?.clearTimeout(p.timer); p.timer = 0; }
    p.list.hidden = false;
    p.button.setAttribute('aria-expanded', 'true');
    // Shift, not flip: a nav dropdown always has room below the bar, but one
    // near the right edge must not run off the screen (overlays-spec §1).
    const win = ctx.win;
    p.list.style.insetInlineStart = '';
    p.list.style.insetInlineEnd = '';
    if (win && p.list.getBoundingClientRect().right > win.innerWidth) {
      p.list.style.insetInlineStart = 'auto';
      p.list.style.insetInlineEnd = '0';
    }
    win?.requestAnimationFrame(() => { if (expanded(p)) p.list.setAttribute('data-state', 'open'); });
    // nav-spec §7: roving tabindex — one link in the tab order at a time, so
    // Tab leaves the list and carries on down the page (overlays-spec §2).
    const items = links(p.list);
    items.forEach((a, i) => a.setAttribute('tabindex', i === 0 ? '0' : '-1'));
    if (focusFirst) items[0]?.focus();
  };

  for (const group of find<HTMLElement>(root, '[data-az-behaviour="dropdown"]')) {
    if (!ctx.fresh(group, 'dropdown')) continue;
    const button = group.querySelector<HTMLButtonElement>('button[aria-controls]');
    const list = button ? doc.getElementById(button.getAttribute('aria-controls') ?? '') : null;
    if (!button || !list) continue;
    const p: Dropdown = { group, button, list, timer: 0 };
    ctx.dropdowns.push(p);

    on(p.button, 'click', () => (expanded(p) ? closeDropdown(ctx, p) : open(p, false)));
    on(p.button, 'keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'ArrowDown') { e.preventDefault(); open(p, true); }
      if (k === 'Escape') closeDropdown(ctx, p, true);
    });
    on(p.list, 'keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Escape') { e.preventDefault(); closeDropdown(ctx, p, true); return; }
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
      if (!to || !p.group.contains(to)) closeDropdown(ctx, p);
    });
  }
}

/* ---- the solid nav -------------------------------------------------------- */

const locked = (doc: Document) => doc.documentElement.hasAttribute(SCROLL_LOCK);

function wireSolid(ctx: Ctx, root: ParentNode): void {
  const { doc, win, on } = ctx;
  if (!win) return;
  for (const nav of find<HTMLElement>(root, '[data-az-behaviour="solid"]')) {
    if (!ctx.fresh(nav, 'solid')) continue;
    // The nav and each logo carry the state, so each can be styled by it:
    // the light logo shows at the top, the regular one once solid (§4).
    const marked = [nav, ...nav.querySelectorAll<HTMLElement>('[data-az-logo]')];
    let solid = false;
    const apply = () => {
      // A scroll lock reads as a jump to the top; the page has not moved.
      if (locked(doc)) return;
      const next = solidAfter(win.scrollY, solid);
      if (next === solid && nav.hasAttribute('data-scrolled')) return;
      solid = next;
      for (const el of marked) el.setAttribute('data-scrolled', String(solid));
    };
    apply();
    on(win, 'scroll', apply, { passive: true });
    ctx.undo.push(() => { for (const el of marked) el.removeAttribute('data-scrolled'); });
  }
}

/* ---- hide and shrink ------------------------------------------------------ */

function wireHideShrink(ctx: Ctx, root: ParentNode): void {
  const { doc, win, on } = ctx;
  if (!win) return;
  for (const nav of find<HTMLElement>(root, '[data-az-hide], [data-az-shrink]')) {
    if (!ctx.fresh(nav, 'hide-shrink')) continue;
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
      // While a modal holds the page, scrollY reads 0 and then jumps back on
      // close: neither is travel, so the lock is not measured at all.
      if (locked(doc)) return;
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
    ctx.undo.push(() => { for (const el of marked) { el.removeAttribute('data-shrunk'); el.removeAttribute('data-retracted'); } });
  }
}

/* ---- faq disclosures ------------------------------------------------------ */

function wireFaq(ctx: Ctx, root: ParentNode): void {
  const { doc, on } = ctx;
  for (const list of find<HTMLElement>(root, '[data-az-behaviour="faq"]')) {
    if (!ctx.fresh(list, 'faq')) continue;
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
    const hash = safeDecode(doc.defaultView?.location.hash.slice(1) ?? '');

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
    ctx.undo.push(() => { for (const b of buttons) set(b, true); });

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

function wireCopy(ctx: Ctx, root: ParentNode): void {
  for (const b of find<HTMLElement>(root, '[data-az-behaviour="copy"]')) {
    if (!ctx.fresh(b, 'copy')) continue;
    ctx.on(b, 'click', () => {
      const text = copyText(b.getAttribute('data-az-target') ?? '');
      const clipboard = ctx.win?.navigator.clipboard;
      if (!clipboard) { ctx.announce('Copy is not available in this browser'); return; }
      clipboard.writeText(text).then(() => ctx.announce('Copied'), () => ctx.announce('Could not copy'));
    });
  }
}

/* ---- pricing billing ------------------------------------------------------ */

/**
 * pricing-spec §7.1: the Monthly/Annual radio group swaps every price in its
 * section — both figures ship in the markup, so the toggle is a DOM update.
 * The query string is the state (`?billing=annual`), written with
 * replaceState so Back leaves the page; the change is announced as a mode,
 * once, not as four new numbers.
 */
function wireBilling(ctx: Ctx, root: ParentNode): void {
  const { win, on } = ctx;
  for (const group of find<HTMLElement>(root, '[data-az-behaviour="billing"]')) {
    if (!ctx.fresh(group, 'billing')) continue;
    const section = group.closest('section') ?? group.parentElement;
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    if (!section || radios.length === 0) continue;
    const originals = new Map<HTMLElement, string>();
    const apply = (mode: Billing) => {
      for (const price of section.querySelectorAll<HTMLElement>('[data-monthly]')) {
        if (!originals.has(price)) originals.set(price, price.textContent ?? '');
        const figure = mode === 'annual' ? price.getAttribute('data-annual') : price.getAttribute('data-monthly');
        if (figure) price.textContent = figure;
      }
      for (const r of radios) r.checked = r.value === mode;
      group.setAttribute('data-billing', mode);
    };
    apply(billingFrom(win?.location.search ?? '', group.getAttribute('data-billing') ?? 'monthly'));
    for (const r of radios) {
      on(r, 'change', () => {
        if (!r.checked || (r.value !== 'monthly' && r.value !== 'annual')) return;
        const mode = r.value;
        apply(mode);
        if (win) {
          const url = new URL(win.location.href);
          url.searchParams.set('billing', mode);
          win.history.replaceState(win.history.state, '', url);
        }
        ctx.announce(billingAnnouncement(mode));
      });
    }
    ctx.undo.push(() => { for (const [price, text] of originals) price.textContent = text; });
  }
}

/* ---- footer year ---------------------------------------------------------- */

/**
 * footer-spec §4 `year dynamic`: the build ships the `since` year (the bytes
 * must not depend on the date, CONVENTIONS §6); the client writes the range
 * to this year once it has moved on.
 */
/**
 * `reveal` (feature-spec §9). The hidden state is applied here, by script,
 * never by the stylesheet: with JS off, or before this runs, everything is
 * visible. Only a block that starts below the first viewport is hidden; it
 * rises into place once, when it enters view, and the observer disconnects.
 * Under reduced motion there is no observer at all — nothing is hidden.
 */
function wireReveal(ctx: Ctx, root: ParentNode): void {
  // The document's view, typed with its globals (IntersectionObserver).
  const win = ctx.doc.defaultView;
  if (!win || typeof win.IntersectionObserver !== 'function') return;
  if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const block of find<HTMLElement>(root, '[data-az-reveal]')) {
    if (!ctx.fresh(block, 'reveal')) continue;
    if (!revealsLater(block.getBoundingClientRect(), win.innerHeight)) continue;
    const items = [...block.querySelectorAll<HTMLElement>('[data-az-reveal-item]')];
    const targets = items.length > 0 ? items : [block];
    const distance = Number(block.dataset.azReveal) || 0;
    const show = () => {
      for (const el of targets) {
        // Back to the word's own transition, so the rise animates.
        el.style.transition = '';
        el.style.opacity = '';
        el.style.transform = '';
      }
    };
    // Hidden at once: the word's transition would otherwise play the hide
    // itself as a fade-out. The layout read flushes the instant style before
    // the transition returns.
    targets.forEach((el, i) => {
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = `translateY(${distance}px)`;
      el.style.transitionDelay = `${revealDelay(i)}ms`;
    });
    void block.offsetHeight;
    block.setAttribute('data-az-revealed', 'false');
    const io = new win.IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      show();
      block.setAttribute('data-az-revealed', 'true');
    });
    io.observe(block);
    ctx.undo.push(() => {
      io.disconnect();
      show();
      for (const el of targets) el.style.transitionDelay = '';
      block.removeAttribute('data-az-revealed');
    });
  }
}

function wireYear(ctx: Ctx, root: ParentNode): void {
  const now = new Date().getFullYear();
  for (const span of find<HTMLElement>(root, '[data-year="dynamic"]')) {
    if (!ctx.fresh(span, 'year')) continue;
    const fallback = span.textContent ?? '';
    const rolled = rollingYear(fallback, now);
    if (rolled === null) continue;
    span.textContent = rolled;
    ctx.undo.push(() => { span.textContent = fallback; });
  }
}
