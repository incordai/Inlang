/**
 * @az module theme-color
 * Purpose: contrast maths over theme values — parse, composite, WCAG 2.1 ratio.
 * Spec: docs/theme-spec.md §6 (method and floors)
 * Exports: rgbOf, luminance, contrastRatio, composite, CONTRAST_BODY, CONTRAST_EDGE
 * Edit guide: ratios are TRUNCATED, never rounded up; keep in step with theme/test/contrast.test.ts.
 * Tests: packages/theme/test/accent.test.ts, packages/theme/test/pattern.test.ts
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
