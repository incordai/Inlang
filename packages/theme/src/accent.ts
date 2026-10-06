/**
 * @az module theme-accent
 * Purpose: `theme accent <hue>` — regenerate accent tokens from a hue ramp, contrast-proven.
 * Spec: docs/PRD.md §6.1a · docs/theme-spec.md §6 (floors) · §6.1 (focus mechanism)
 * Exports: ACCENT_NAMES, accentTokens, withAccent, AccentUnavailable
 * Edit guide: change floors only with theme-spec §6; preference orders decide which step
 *   wins; a hue with no passing set THROWS — never ship a step under its floor.
 * Tests: packages/theme/test/accent.test.ts
 */

import { ACCENT_RAMPS, RAMP_STEPS, type AccentName, type RampStep } from './ramps.ts';
import { CONTRAST_BODY, CONTRAST_EDGE, composite, contrastRatio, rgbOf, type Rgb } from './color.ts';
import { VEIL_PERCENT, type ColorTokens, type Scheme, type Theme } from './tokens.ts';

export const ACCENT_NAMES = Object.keys(ACCENT_RAMPS) as AccentName[];

/** The three tokens an accent decides. `focus` stays the theme's own (theme-spec §6.1). */
export type AccentTokens = Pick<ColorTokens, 'accent' | 'accent-hover' | 'accent-contrast'>;

/** Raised when a hue cannot meet every floor on a theme's grounds — the build stops. */
export class AccentUnavailable extends Error {}

/**
 * Which step to try first. Light grounds want a mid-dark step, dark grounds a
 * mid-light one; the first that clears every floor wins, so the result is
 * as close to the hue's own vivid middle as legibility allows.
 */
const PREFERENCE: Record<Scheme, readonly RampStep[]> = {
  light: [600, 700, 500, 800, 900, 950],
  dark: [400, 300, 500, 200, 100, 50],
};

/** Pure white and pure black bound every pixel a live backdrop can show (scene-spec §6.5). */
const EXTREME_PIXELS: readonly Rgb[] = [[255, 255, 255], [0, 0, 0]];

/** The veil (`color.veil`) over a backdrop pixel: the ground an accent link may sit on. */
const veilOver = (bg: Rgb, pixel: Rgb): Rgb => composite(bg, pixel, VEIL_PERCENT / 100);

/** Every floor `accent` must clear on one scheme's grounds (theme-spec §6 rows). */
function accentPasses(a: Rgb, c: ColorTokens): boolean {
  const bg = rgbOf(c.bg);
  return contrastRatio(a, bg) >= CONTRAST_BODY
    && contrastRatio(a, rgbOf(c.surface)) >= CONTRAST_BODY
    // pricing §7.3: the highlighted plan's edge is accent on surface-alt.
    && contrastRatio(a, rgbOf(c['surface-alt'])) >= CONTRAST_EDGE
    // scene-spec §6.5: links stay legible on the veil over any backdrop.
    && EXTREME_PIXELS.every((px) => contrastRatio(a, veilOver(bg, px)) >= CONTRAST_BODY);
}

/** The accent-derived tokens for one theme scheme, or throw. Deterministic. */
export function accentTokens(name: AccentName, theme: Theme, scheme: Scheme): AccentTokens {
  const ramp = ACCENT_RAMPS[name] as Readonly<Record<RampStep, string>>;
  const c = theme.color[scheme];
  const bg = rgbOf(c.bg);
  const order = PREFERENCE[scheme];
  // Hover moves AWAY from the ground: darker on light, lighter on dark.
  const awayFromGround = scheme === 'light' ? [...RAMP_STEPS] : [...RAMP_STEPS].reverse();
  // The label on an accent fill: a ramp end, else the theme's own ground or ink.
  const labels = scheme === 'light'
    ? [ramp[50], ramp[950], c.bg, c.text]
    : [ramp[950], ramp[50], c.bg, c.text];

  for (const step of order) {
    const accent = ramp[step];
    const a = rgbOf(accent);
    if (!accentPasses(a, c)) continue;
    const base = contrastRatio(a, bg);
    for (const hoverStep of awayFromGround.slice(awayFromGround.indexOf(step) + 1)) {
      const hover = ramp[hoverStep];
      const h = rgbOf(hover);
      const hoverOnBg = contrastRatio(h, bg);
      if (hoverOnBg < CONTRAST_BODY || hoverOnBg <= base) continue;
      const label = labels.find((l) => {
        const lab = rgbOf(l);
        return contrastRatio(lab, a) >= CONTRAST_BODY && contrastRatio(lab, h) >= CONTRAST_BODY;
      });
      if (label) return { accent, 'accent-hover': hover, 'accent-contrast': label };
    }
  }
  throw new AccentUnavailable(
    `theme: accent '${name}' cannot meet every contrast floor on ${theme.name} ${scheme}`);
}

/** The theme with its accent tokens regenerated for `name`; null keeps the theme's own. */
export function withAccent(theme: Theme, name: AccentName | null): Theme {
  if (name === null) return theme;
  const color = {} as Record<Scheme, ColorTokens>;
  for (const scheme of ['light', 'dark'] as const) {
    color[scheme] = { ...theme.color[scheme], ...accentTokens(name, theme, scheme) };
  }
  return { ...theme, color };
}
