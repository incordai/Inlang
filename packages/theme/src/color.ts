/**
 * @az module theme-color
 * Purpose: contrast maths over theme values — parse, composite, WCAG 2.1 ratio.
 * Spec: docs/theme-spec.md §6 (method and floors)
 * Exports: rgbOf, luminance, contrastRatio, composite, CONTRAST_BODY, CONTRAST_EDGE, Lch, lchOf,
 *   oklchMix, srgbMix, GamutMap
 * Edit guide: ratios are TRUNCATED, never rounded up; keep in step with theme/test/contrast.test.ts.
 *   The OKLab matrices are the published ones scripts/gen-ramps.mjs also uses.
 * Tests: packages/theme/test/accent.test.ts, packages/theme/test/pattern.test.ts, packages/theme/test/gradient.test.ts
 */

/** hero-spec §9 / theme-spec §6: body text. */
export const CONTRAST_BODY = 4.5;
/** Non-text UI and large text (WCAG 2.1 SC 1.4.11). */
export const CONTRAST_EDGE = 3;

export type Rgb = readonly [number, number, number];

/** A theme value (`hsl(H S% L%)`, the form every theme uses) as sRGB bytes. */
export function rgbOf(value: string): Rgb {
  const m = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(value);
  if (!m) throw new Error(`theme: '${value}' is not a theme colour value`);
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

/** WCAG 2.1 relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contrast ratio, truncated to two places — a printed 4.50 is truly at the floor. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  return Math.floor(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
}

/** `ink` laid over `ground` at `alpha` (0–1): what `color-mix(… ink a%, transparent)` paints. */
export function composite(ink: Rgb, ground: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => alpha * ink[i] + (1 - alpha) * ground[i]) as unknown as Rgb;
}

/* ---------------- OKLCH: what `linear-gradient(in oklch, …)` paints ---------------- */

/** Lightness 0–1, chroma, hue in degrees. */
export type Lch = readonly [number, number, number];

const toLinear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** sRGB bytes → OKLCH. */
export function lchOf([r, g, b]: Rgb): Lch {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, Bb), (Math.atan2(Bb, A) * 180 / Math.PI + 360) % 360];
}

/** OKLCH → linear sRGB, unclamped: a channel outside 0–1 is out of gamut. */
function linearOf([L, C, H]: Lch): [number, number, number] {
  const h = H * Math.PI / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** How an out-of-gamut colour reaches the screen: channel clipping, or chroma reduction at fixed L and H. */
export type GamutMap = 'clip' | 'chroma';

/** Smallest chroma step the reduction search resolves — far below a visible difference. */
const CHROMA_EPSILON = 1e-4;

const inGamut = (rgb: readonly number[]) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

const bytesOf = (rgb: readonly number[]): Rgb =>
  rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255)) as unknown as Rgb;

/** An OKLCH colour on screen, mapped into sRGB as `map` says. */
function render(c: Lch, map: GamutMap): Rgb {
  const direct = linearOf(c);
  if (map === 'clip' || inGamut(direct)) return bytesOf(direct);
  let lo = 0, hi = c[1];
  while (hi - lo > CHROMA_EPSILON) {
    const mid = (lo + hi) / 2;
    if (inGamut(linearOf([c[0], mid, c[2]]))) lo = mid; else hi = mid;
  }
  return bytesOf(linearOf([c[0], lo, c[2]]));
}

/**
 * The colour `t` (0–1) of the way from `a` to `b`, interpolated in OKLCH the
 * way CSS does it: lightness and chroma linearly, hue the SHORTER way round.
 */
export function oklchMix(a: Rgb, b: Rgb, t: number, map: GamutMap = 'clip'): Rgb {
  const [l1, c1, h1] = lchOf(a), [l2, c2, h2] = lchOf(b);
  let dh = h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return render([l1 + (l2 - l1) * t, c1 + (c2 - c1) * t, (h1 + dh * t + 360) % 360], map);
}

/** The colour `t` of the way from `a` to `b` in gamma-encoded sRGB — a gradient without an interpolation method. */
export function srgbMix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as unknown as Rgb;
}
