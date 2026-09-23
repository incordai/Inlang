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
