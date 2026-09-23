/**
 * @az runtime behaviour-logic
 * Purpose: the behaviour runtime's decisions as pure functions (thresholds, indices, parsing).
 * Spec: docs/nav-block-spec.md §4 · docs/overlays-spec.md
 * Exports: solidAfter, retractedAfter, trapIndex, safeDecode, billingFrom, rollingYear
 * Edit guide: keep pure (no DOM); every decision here has a unit test.
 * Tests: packages/overlay/test/logic.test.ts
 */

/**
 * The decisions the behaviour runtime makes, as pure functions.
 *
 * Kept apart from the DOM wiring so each can be tested without a browser,
 * and copied into every generated project alongside it. Imports nothing.
 */

/**
 * nav-block-spec §4: the switch to `solid` is hysteretic — solid at 80px
 * down, transparent again only at 40px up — so a reader resting at the
 * threshold does not make the bar flicker.
 */
export const SOLID_AT = 80;
export const TRANSPARENT_AT = 40;

export function solidAfter(scrollY: number, solid: boolean): boolean {
  if (solid) return scrollY > TRANSPARENT_AT;
  return scrollY >= SOLID_AT;
}

/**
 * nav-block-spec §3 `shrink`: the bar shrinks past a threshold. The same
 * hysteresis as `solid` — shrunk at 80px down, full height again only at
 * 40px up — so resting near the threshold cannot make the bar pump.
 */
export function shrunkAfter(scrollY: number, shrunk: boolean): boolean {
  return solidAfter(scrollY, shrunk);
}

/**
 * How far the reader must travel in one direction before `hide` reacts —
 * a trackpad's settle and a touch scroll's jitter are both smaller.
 */
export const HIDE_TRAVEL = 8;

/**
 * nav-block-spec §3 `hide`: hides while the reader scrolls down, reveals as
 * soon as they scroll up. Never hidden while the bar still covers its own
 * spot at the top of the page (`barHeight`), so the page never opens with
 * the nav missing. `fromY` is where the current run of travel began.
 */
export function retractedAfter(fromY: number, scrollY: number, retracted: boolean, barHeight: number): boolean {
  if (scrollY <= barHeight) return false;
  if (scrollY - fromY >= HIDE_TRAVEL) return true;
  if (fromY - scrollY >= HIDE_TRAVEL) return false;
  return retracted;
}

/**
 * Where a list-navigation key moves the active index: arrows wrap at the
 * ends, Home and End jump (nav-spec §7 dropdowns; faq-spec §8). Null means
 * the key is not a navigation key and must be left alone.
 */
export function moveIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown': return (index + 1 + count) % count;
    case 'ArrowUp': return (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** The text a `copy:` destination copies — everything after the scheme. */
export function copyText(destination: string): string {
  const colon = destination.indexOf(':');
  return colon >= 0 && destination.slice(0, colon).toLowerCase() === 'copy'
    ? destination.slice(colon + 1)
    : destination;
}

/**
 * The longest transition on an element, in ms, from its computed
 * `transition-duration` and `transition-delay` lists — how long a closing
 * overlay must stay in the DOM for its exit to be seen.
 */
export function transitionMs(durations: string, delays: string): number {
  const ms = (v: string) => {
    const n = parseFloat(v);
    if (Number.isNaN(n)) return 0;
    return v.trim().endsWith('ms') ? n : n * 1000;
  };
  const d = durations.split(',').map(ms);
  const l = delays.split(',').map(ms);
  return d.reduce((max, v, i) => Math.max(max, v + (l[i % l.length] ?? 0)), 0);
}

/**
 * gallery-spec §8: where a lightbox key moves the shown image. It does NOT
 * wrap — at the last image `→` does nothing, so a viewer can tell they have
 * seen everything. Null means the key is not the lightbox's.
 */
export function lightboxIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight': return Math.min(index + 1, count - 1);
    case 'ArrowLeft': return Math.max(index - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** gallery-spec §8: the counter — the only thing saying the set is finite. */
export const counterText = (index: number, count: number): string => `${index + 1} of ${count}`;

/**
 * The lightbox's neighbours to preload (§8: ±1 only — preloading the set
 * defeats the lazy-loading rules), in order, without the ends' overhang.
 */
export function neighbours(index: number, count: number): number[] {
  return [index - 1, index + 1].filter((i) => i >= 0 && i < count);
}

/**
 * How far a swipe must travel to count (§8: left/right is prev/next, down
 * closes) — well past a tap's wobble, well short of a deliberate drag.
 */
export const SWIPE_PX = 48;

export type Swipe = 'next' | 'previous' | 'close' | null;

export function swipeOf(dx: number, dy: number): Swipe {
  if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'next' : 'previous';
  if (dy >= SWIPE_PX && dy > Math.abs(dx)) return 'close';
  return null;
}

/** A carousel track's ends, allowing a pixel of subpixel rounding. */
export function carouselEnds(scrollLeft: number, clientWidth: number, scrollWidth: number): { atStart: boolean; atEnd: boolean } {
  return { atStart: scrollLeft <= 1, atEnd: scrollLeft + clientWidth >= scrollWidth - 1 };
}

/**
 * A URL fragment's text. A fragment is attacker-controlled and need not be
 * valid percent-encoding (`#100%`); a malformed one is used as written rather
 * than throwing — a throw here would leave the rest of the page unwired.
 */
export function safeDecode(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Whether a click landed OUTSIDE a box — on a modal's backdrop, not in its
 * padding. `e.target === dialog` is true for both, so the point decides.
 */
export function outsideBox(
  x: number, y: number, box: { left: number; top: number; right: number; bottom: number },
): boolean {
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

/**
 * Where Tab moves inside a modal: the next stop, wrapping round. From
 * somewhere that is not a stop (`at` -1: the dialog itself, or a control the
 * list omits) Tab goes to the first stop and Shift+Tab to the last.
 */
export function trapIndex(at: number, count: number, back: boolean): number {
  if (at < 0) return back ? count - 1 : 0;
  return (at + (back ? -1 : 1) + count) % count;
}

/**
 * Whether a link's target is a fragment of the page already shown — a jump
 * the browser makes in place, which a scroll-locked page cannot perform.
 */
export function samePageFragment(
  link: { origin: string; pathname: string; search: string; hash: string },
  here: { origin: string; pathname: string; search: string },
): boolean {
  return link.hash.length > 1 && link.origin === here.origin
    && link.pathname === here.pathname && link.search === here.search;
}

/**
 * footer-spec §4 `year dynamic`: the emitted `since` year is the fallback;
 * the client writes the range to the current year once that has moved on.
 * Null leaves the fallback as it is.
 */
export function rollingYear(since: string, now: number): string | null {
  const from = /^\d{4}$/.test(since.trim()) ? Number(since.trim()) : NaN;
  if (!Number.isFinite(from) || now <= from) return null;
  return `${from}–${now}`;
}

export type Billing = 'monthly' | 'annual';

/**
 * pricing-spec §7.1: the billing period's one source of truth is the query
 * string (`?billing=annual`), defaulting to the block's `billing` prop.
 */
export function billingFrom(search: string, fallback: string): Billing {
  const q = new URLSearchParams(search).get('billing');
  if (q === 'monthly' || q === 'annual') return q;
  return fallback === 'annual' ? 'annual' : 'monthly';
}

/** §7.1: one polite line naming the mode, not the numbers. */
export const billingAnnouncement = (mode: Billing): string =>
  mode === 'annual' ? 'showing annual pricing, billed yearly' : 'showing monthly pricing, billed monthly';

/**
 * Whether a box is wholly outside the viewport's height — the only case in
 * which returning focus to it should scroll the page.
 */
export function offScreen(box: { top: number; bottom: number }, viewportHeight: number): boolean {
  return box.bottom <= 0 || box.top >= viewportHeight;
}


/** feature-spec §9: the stagger between revealed items, in ms. */
export const REVEAL_STEP_MS = 60;
/** …and where it stops accumulating: "capped at 6 steps". */
export const REVEAL_MAX_STEPS = 6;

/** The delay of the `index`th item of one reveal — past step 6 it holds. */
export function revealDelay(index: number): number {
  return Math.min(Math.max(0, index), REVEAL_MAX_STEPS) * REVEAL_STEP_MS;
}

/**
 * Whether a block should be hidden for its reveal: only when it starts below
 * the first viewport. §9: "items already inside the first viewport render
 * visible, unanimated" — animating what the reader already sees is a flash.
 */
export function revealsLater(box: { top: number }, viewportHeight: number): boolean {
  return box.top >= viewportHeight;
}
