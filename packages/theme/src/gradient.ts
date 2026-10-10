/**
 * @az module theme-gradient
 * Purpose: `theme accent <hue> <hue2>` — which hue pairs are allowed, their tokens, and the proof behind both.
 * Spec: docs/theme-spec.md §13 · docs/PRD.md §6.1a · docs/theme-spec.md §6 (floors)
 * Exports: PAIR_HUE_MIN, PAIR_HUE_MAX, PAIR_CHROMA_FLOOR, GRADIENT_SAMPLES, GRADIENT_FALLBACK_STOPS, PAIR_TOKENS,
 *   PairTokens, PairVerdict, PairUnavailable, hueDistance, gradientSamples, pairVerdict, pairTable, withAccentPair
 * Edit guide: the rule's numbers are named constants here and stated in theme-spec §13; change both together,
 *   then rerun scripts/gen-pairs.mjs. A pair that fails any floor in any scheme is REFUSED, never shipped.
 * Tests: packages/theme/test/gradient.test.ts, packages/theme/test/pattern.test.ts
 */

/**
 * A pair is two hues from the closed set, drawn as one gradient. The
 * contrast of a gradient is not the contrast of its two ends: the middle is
 * a third colour nobody chose. So a pair is offered only when every point
 * along it is proven, the way theme-spec §6 proves a single accent — never
 * "usually" (theme-spec §11: no palette the proof cannot cover).
 *
 * The rule, in order:
 *   1. two different hues, PAIR_HUE_MIN to PAIR_HUE_MAX degrees apart on the
 *      OKLCH wheel — closer reads as one colour, further as a rainbow;
 *   2. every rendering of the gradient (below) keeps PAIR_CHROMA_FLOOR of
 *      its weaker end's chroma at its weakest point — the middle may not go
 *      grey or muddy;
 *   3. at every sampled point, in both schemes: the fill holds 4.5:1 on
 *      `bg` and `surface` and 3:1 on `surface-alt` (the pricing edge), the
 *      hover gradient 4.5:1 on `bg`, and one label — `on-gradient` — holds
 *      4.5:1 against every point of the rest AND hover gradients;
 *   4. the two-hue pattern (glow, spotlight, ramp) leaves the hero's reading
 *      pairs at their floors, as tokens.ts PATTERN_MAX_ALPHA requires of one hue.
 *
 * A gradient reaches a visitor in one of three renderings, so each is sampled:
 * `linear-gradient(in oklch, …)` where the engine has it; a stop list of
 * `color-mix(in oklch, …)` points, interpolated in sRGB, where it has
 * color-mix but not gradient interpolation; and the two ends in plain sRGB
 * where it has neither (contrast is proven there too; chroma is not promised).
 * Out-of-gamut OKLCH points are sampled both clipped and chroma-reduced, as
 * engines differ.
 */

import { ACCENT_HUE_DEGREES, type AccentName } from './ramps.ts';
import { ACCENT_NAMES, AccentUnavailable, accentTokens, withAccent, type AccentTokens } from './accent.ts';
import {
  CONTRAST_BODY, CONTRAST_EDGE, composite, contrastRatio, lchOf, oklchMix, rgbOf, srgbMix, type GamutMap, type Rgb,
} from './color.ts';
import { PATTERN_MAX_ALPHA, type ColorTokens, type Scheme, type Theme } from './tokens.ts';

/** Closest two hues may sit, in OKLCH degrees: nearer, the gradient reads as one flat colour. */
export const PAIR_HUE_MIN = 30;
/** Furthest two hues may sit: past a third of the wheel the path sweeps through hues nobody chose. */
export const PAIR_HUE_MAX = 120;
/** The weakest point keeps this share of the weaker end's chroma, or the middle reads as grey. */
export const PAIR_CHROMA_FLOOR = 0.8;
/** Points sampled along each rendering of each gradient. */
export const GRADIENT_SAMPLES = 256;
/** Where the fallback stop list puts its OKLCH points (fractions of the way from accent to accent2). */
export const GRADIENT_FALLBACK_STOPS = [0, 0.25, 0.5, 0.75, 1] as const;

/** The colour tokens a pair adds, in both schemes. */
export const PAIR_TOKENS = ['accent2', 'accent2-hover', 'on-gradient'] as const;
export type PairTokens = { readonly [K in (typeof PAIR_TOKENS)[number]]: string };

export type PairVerdict =
  | { readonly ok: true; readonly tokens: Readonly<Record<Scheme, PairTokens>> }
  | { readonly ok: false; readonly reason: string };

/** Raised when a refused pair reaches the build — the compiler should have stopped it (AZ1423). */
export class PairUnavailable extends Error {}

/** Shortest angle between two hues on the OKLCH wheel, in degrees. */
export function hueDistance(a: AccentName, b: AccentName): number {
  const d = Math.abs(ACCENT_HUE_DEGREES[a] - ACCENT_HUE_DEGREES[b]) % 360;
  return d > 180 ? 360 - d : d;
}

type Rendering = 'oklch' | 'stops' | 'two-stop';
const RENDERINGS: readonly Rendering[] = ['oklch', 'stops', 'two-stop'];
const MAPS: readonly GamutMap[] = ['clip', 'chroma'];

/** One rendering's points from `a` to `b`, GRADIENT_SAMPLES + 1 of them, ends included. */
function rendered(a: Rgb, b: Rgb, rendering: Rendering, map: GamutMap): Rgb[] {
  const ts = Array.from({ length: GRADIENT_SAMPLES + 1 }, (_, i) => i / GRADIENT_SAMPLES);
  if (rendering === 'oklch') return ts.map((t) => oklchMix(a, b, t, map));
  if (rendering === 'two-stop') return ts.map((t) => srgbMix(a, b, t));
  const stops = GRADIENT_FALLBACK_STOPS.map((t) => oklchMix(a, b, t, map));
  const last = stops.length - 1;
  return ts.map((t) => {
    const k = Math.min(last - 1, Math.floor(t * last));
    return srgbMix(stops[k], stops[k + 1], t * last - k);
  });
}

/**
 * Every point the gradient from `a` to `b` can paint, per rendering — what
 * the proof samples. `chromaBearing` leaves out the two-stop fallback, whose
 * grey middle is the reason the other two exist.
 */
export function gradientSamples(a: Rgb, b: Rgb, chromaBearing = false): Rgb[][] {
  return RENDERINGS.filter((r) => !chromaBearing || r !== 'two-stop')
    .flatMap((r) => (r === 'two-stop' ? [rendered(a, b, r, 'clip')] : MAPS.map((m) => rendered(a, b, r, m))));
}

const worst = (points: readonly Rgb[], against: Rgb): number =>
  Math.min(...points.map((p) => contrastRatio(p, against)));

/** The weakest chroma along every chroma-bearing rendering, as a share of the weaker end's. */
function chromaKept(a: Rgb, b: Rgb): number {
  const ends = Math.min(lchOf(a)[1], lchOf(b)[1]);
  const low = Math.min(...gradientSamples(a, b, true).flat().map((p) => lchOf(p)[1]));
  return Math.floor((low / ends) * 100) / 100;
}

/** The reading pairs a hero's type makes over its pattern — pattern.test.ts, with both hues. */
const READING: readonly (readonly [keyof ColorTokens, number])[] = [
  ['text', CONTRAST_BODY], ['muted', CONTRAST_BODY], ['accent', CONTRAST_BODY], ['accent2', CONTRAST_BODY],
  ['border-strong', CONTRAST_EDGE],
];
/** Fractions of the cap the pattern check samples, as the ink fades to the ground. */
const PATTERN_STRENGTHS = [0.25, 0.5, 0.75, 1] as const;

/** One scheme's verdict: the pair tokens, or the first floor that failed. */
function schemeVerdict(a: AccentTokens, b: AccentTokens, c: ColorTokens): PairTokens | string {
  const A = rgbOf(a.accent), B = rgbOf(b.accent);
  const AH = rgbOf(a['accent-hover']), BH = rgbOf(b['accent-hover']);
  for (const [name, from, to] of [['rest', A, B], ['hover', AH, BH]] as const) {
    const kept = chromaKept(from, to);
    if (kept < PAIR_CHROMA_FLOOR) return `the ${name} gradient keeps ${kept} of its chroma, under ${PAIR_CHROMA_FLOOR}`;
  }
  const rest = gradientSamples(A, B).flat();
  const hover = gradientSamples(AH, BH).flat();
  const grounds: [string, Rgb[], keyof ColorTokens, number][] = [
    ['rest', rest, 'bg', CONTRAST_BODY], ['rest', rest, 'surface', CONTRAST_BODY],
    ['rest', rest, 'surface-alt', CONTRAST_EDGE], ['hover', hover, 'bg', CONTRAST_BODY],
  ];
  for (const [name, points, ground, floor] of grounds) {
    const r = worst(points, rgbOf(c[ground] as string));
    if (r < floor) return `the ${name} gradient falls to ${r}:1 on ${ground}, under ${floor}`;
  }
  const both = [...rest, ...hover];
  const label = [a['accent-contrast'], b['accent-contrast'], c.bg, c.text]
    .find((l) => worst(both, rgbOf(l)) >= CONTRAST_BODY);
  if (!label) return `no label holds ${CONTRAST_BODY}:1 along the gradient`;
  const pair = { ...c, accent: a.accent, accent2: b.accent } as ColorTokens;
  const bg = rgbOf(c.bg);
  for (const strength of PATTERN_STRENGTHS) {
    for (const ink of rendered(A, B, 'two-stop', 'clip')) {
      const ground = composite(ink, bg, PATTERN_MAX_ALPHA * strength);
      for (const [fg, floor] of READING) {
        const r = contrastRatio(rgbOf(pair[fg] as string), ground);
        if (r < floor) return `${fg} falls to ${r}:1 over the two-hue pattern, under ${floor}`;
      }
    }
  }
  return { accent2: b.accent, 'accent2-hover': b['accent-hover'], 'on-gradient': label };
}

/** Whether `first second` is an allowed pair on `theme`, and its tokens when it is. Deterministic. */
export function pairVerdict(theme: Theme, first: AccentName, second: AccentName): PairVerdict {
  if (first === second) return { ok: false, reason: 'a hue does not pair with itself' };
  const d = hueDistance(first, second);
  if (d < PAIR_HUE_MIN) return { ok: false, reason: `${d}° apart — under ${PAIR_HUE_MIN}°, the two read as one colour` };
  if (d > PAIR_HUE_MAX) return { ok: false, reason: `${d}° apart — over ${PAIR_HUE_MAX}°, the middle is a third hue` };
  const tokens = {} as Record<Scheme, PairTokens>;
  for (const scheme of ['light', 'dark'] as const) {
    let verdict: PairTokens | string;
    try {
      verdict = schemeVerdict(accentTokens(first, theme, scheme), accentTokens(second, theme, scheme), theme.color[scheme]);
    } catch (e) {
      if (!(e instanceof AccentUnavailable)) throw e;
      verdict = e.message;
    }
    if (typeof verdict === 'string') return { ok: false, reason: `${theme.name} ${scheme}: ${verdict}` };
    tokens[scheme] = verdict;
  }
  return { ok: true, tokens };
}

/**
 * Every hue's allowed partners on `theme`, in ramp order — what
 * scripts/gen-pairs.mjs writes. A verdict is the same either way round (the
 * two directions paint the same points and offer the same labels), so each
 * unordered pair is judged once; gradient.test.ts checks the reverse.
 */
export function pairTable(theme: Theme): Record<AccentName, AccentName[]> {
  const allowed = new Set<string>();
  ACCENT_NAMES.forEach((first, i) => {
    for (const second of ACCENT_NAMES.slice(i + 1)) {
      if (pairVerdict(theme, first, second).ok) allowed.add(`${first} ${second}`).add(`${second} ${first}`);
    }
  });
  const out = {} as Record<AccentName, AccentName[]>;
  for (const first of ACCENT_NAMES) out[first] = ACCENT_NAMES.filter((second) => allowed.has(`${first} ${second}`));
  return out;
}

/**
 * The theme with `first` as its accent and, when `second` is given, the pair
 * tokens added in both schemes. Without `second` this IS withAccent, so a
 * one-hue site is unchanged; a refused pair throws rather than ship.
 */
export function withAccentPair(theme: Theme, first: AccentName | null, second: AccentName | null): Theme {
  const accented = withAccent(theme, first);
  if (second === null) return accented;
  if (first === null) throw new PairUnavailable(`theme: accent pair needs a first hue before '${second}'`);
  const verdict = pairVerdict(theme, first, second);
  if (!verdict.ok) throw new PairUnavailable(`theme: accent '${first} ${second}' is not a pair — ${verdict.reason}`);
  const color = {} as Record<Scheme, ColorTokens>;
  for (const scheme of ['light', 'dark'] as const) {
    color[scheme] = { ...accented.color[scheme], ...verdict.tokens[scheme] };
  }
  return { ...accented, color };
}
