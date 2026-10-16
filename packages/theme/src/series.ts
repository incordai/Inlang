/**
 * @az module theme-series
 * Purpose: the six categorical colours a chart's series are drawn in, derived from the theme and proven, never hand-written.
 * Spec: docs/chat-block-spec.md §20.4 · docs/theme-spec.md §15 · docs/theme-spec.md §6 (floors)
 * Exports: SERIES_TOKENS, SeriesToken, SERIES_EDGE, SERIES_MIN_DISTANCE, SeriesUnavailable, seriesTokens, withSeries, oklabDistance
 * Edit guide: the rule's numbers are named constants here and stated in theme-spec §15; change both together.
 *   A theme where six series cannot clear every floor THROWS — never ship a series under its floor.
 * Tests: packages/theme/test/series.test.ts
 */

/**
 * A chart needs several colours that the theme never had to choose: the
 * theme has one accent (two with a pair). So the series colours are derived,
 * the way an accent is (accent.ts): from the closed hue ramps, each at the
 * step that clears the floor on this theme's grounds, in a fixed order.
 *
 * The rule, in order:
 *   1. series-1 is the theme's accent; series-2 is the pair's second hue
 *      when the site names a pair (theme-spec §13).
 *   2. Each further series is a hue ramp at the first step of the accent
 *      picker's preference order whose colour holds SERIES_EDGE against
 *      `bg`, `surface` and `surface-alt` — marks are graphics, so WCAG
 *      1.4.11's non-text 3:1 is the floor; their labels are text in
 *      `color.text` and hold their own floor already.
 *   3. Among those, the next is the hue farthest (OKLCH hue angle, the short
 *      way round) from every colour chosen so far; a tie goes to the ramp
 *      name, so the result is deterministic.
 *   4. Any two of the six stay at least SERIES_MIN_DISTANCE apart in OKLab,
 *      or the theme is refused — the build stops rather than draw two series
 *      nobody can tell apart.
 *
 * Colour is never the only signal (patterns, markers and labels carry each
 * series too, chat-block-spec §20.4); this rule makes the colour itself
 * legible and distinct, every theme × accent × scheme.
 */

import { ACCENT_RAMPS, type AccentName, type RampStep } from './ramps.ts';
import { CONTRAST_EDGE, contrastRatio, lchOf, rgbOf, type Rgb } from './color.ts';
import type { ColorTokens, Scheme, Theme } from './tokens.ts';

export const SERIES_TOKENS = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'] as const;
export type SeriesToken = (typeof SERIES_TOKENS)[number];

/** WCAG 1.4.11: a graphical object holds 3:1 against what is next to it. */
export const SERIES_EDGE = CONTRAST_EDGE;

/**
 * The closest two series of one set may be, in OKLab units. Measured on
 * 2026-10-15 over every theme × accent × scheme: the closest pair is 0.064
 * (chat-block-spec §20.4), so 0.06 is the floor that holds today's sets and
 * refuses any change that would bring two series closer.
 */
export const SERIES_MIN_DISTANCE = 0.06;

/** The accent picker's order (accent.ts PREFERENCE), the steps a series may take. */
const PREFERENCE: Record<Scheme, readonly RampStep[]> = {
  light: [600, 700, 500, 800],
  dark: [400, 300, 500, 200],
};

/** Raised when a theme cannot carry six series over every floor — the build stops. */
export class SeriesUnavailable extends Error {}

/** OKLab distance between two colours. */
export function oklabDistance(a: Rgb, b: Rgb): number {
  const lab = (c: Rgb) => {
    const [L, C, H] = lchOf(c);
    const h = (H * Math.PI) / 180;
    return [L, C * Math.cos(h), C * Math.sin(h)] as const;
  };
  const x = lab(a);
  const y = lab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** The short way round between two hue angles, in degrees. */
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

interface Pick { readonly value: string; readonly rgb: Rgb; readonly hue: number; readonly name: string }

const pick = (value: string, name: string): Pick => {
  const rgb = rgbOf(value);
  return { value, rgb, hue: lchOf(rgb)[2], name };
};

/** The six series colours for one scheme of `theme`, or throw. Deterministic. */
export function seriesTokens(theme: Theme, scheme: Scheme): Record<SeriesToken, string> {
  const c = theme.color[scheme];
  const grounds = [c.bg, c.surface, c['surface-alt']].map(rgbOf);
  const holds = (rgb: Rgb) => grounds.every((g) => contrastRatio(rgb, g) >= SERIES_EDGE);
  const chosen: Pick[] = [pick(c.accent, 'accent')];
  if (c.accent2 !== undefined) chosen.push(pick(c.accent2, 'accent2'));
  for (const p of chosen) {
    if (!holds(p.rgb)) {
      throw new SeriesUnavailable(`theme: ${p.name} on ${theme.name} ${scheme} is under ${SERIES_EDGE}:1 on a ground, so it cannot be series-1`);
    }
  }
  const pool: Pick[] = [];
  for (const name of Object.keys(ACCENT_RAMPS).sort() as AccentName[]) {
    const ramp = ACCENT_RAMPS[name] as Readonly<Record<RampStep, string>>;
    const step = PREFERENCE[scheme].find((s) => holds(rgbOf(ramp[s])));
    if (step !== undefined) pool.push(pick(ramp[step], `${name} ${step}`));
  }
  while (chosen.length < SERIES_TOKENS.length) {
    let best: Pick | null = null;
    let bestGap = -1;
    for (const p of pool) {
      if (chosen.some((q) => q.name === p.name || q.value === p.value)) continue;
      const gap = Math.min(...chosen.map((q) => hueGap(q.hue, p.hue)));
      if (gap > bestGap) {
        best = p;
        bestGap = gap;
      }
    }
    if (best === null) {
      throw new SeriesUnavailable(`theme: only ${chosen.length} series clear ${SERIES_EDGE}:1 on ${theme.name} ${scheme}`);
    }
    chosen.push(best);
  }
  for (let i = 0; i < chosen.length; i++) {
    for (let j = i + 1; j < chosen.length; j++) {
      const d = oklabDistance(chosen[i].rgb, chosen[j].rgb);
      if (d < SERIES_MIN_DISTANCE) {
        throw new SeriesUnavailable(
          `theme: series ${chosen[i].name} and ${chosen[j].name} are ${d.toFixed(3)} apart on ${theme.name} ${scheme}, under ${SERIES_MIN_DISTANCE}`);
      }
    }
  }
  return Object.fromEntries(SERIES_TOKENS.map((t, i) => [t, chosen[i].value])) as Record<SeriesToken, string>;
}

/** The theme with its series tokens added in both schemes — only for a site whose chat draws charts. */
export function withSeries(theme: Theme): Theme {
  const color = {} as Record<Scheme, ColorTokens>;
  for (const scheme of ['light', 'dark'] as const) {
    color[scheme] = { ...theme.color[scheme], ...seriesTokens(theme, scheme) };
  }
  return { ...theme, color };
}
