/**
 * @az module theme-pattern
 * Purpose: `theme pattern <shape> [origin]` — a background shape drawn in the accent.
 * Spec: docs/PRD.md §6.1a · ported from spike-m0/src/patterns.ts
 * Exports: patternLayers, PatternLayers
 * Edit guide: geometry and alphas are DATA in tokens.ts (PATTERN); this file only assembles
 *   CSS. The ink is a colour TOKEN, never a literal, so every shape follows theme and scheme.
 *   A second ink (an accent pair, theme-spec §13) joins only the focal shapes; without one the
 *   output is exactly the one-hue CSS.
 * Tests: packages/theme/test/pattern.test.ts
 */

import { PATTERN, type PatternOrigin, type PatternShape } from './tokens.ts';

/** What a pattern paints: the three background properties, as CSS values. */
export interface PatternLayers {
  readonly image: string;
  readonly size: string;
  readonly position: string;
}

/**
 * The CSS for a shape, or null for `none`.
 *
 * `color-mix` carries the alpha because the ink arrives as `var(--…)` whose
 * channels are unknown here — exactly what lets one shape work in any theme.
 * With `ink2` (an accent pair) the glow, spotlight and ramp pass from the
 * first ink to the second, at the same peak strength; the lattice shapes
 * stay one ink, since a hairline cannot show a gradient.
 */
export function patternLayers(
  shape: PatternShape, origin: PatternOrigin, ink: string, ink2: string | null = null,
): PatternLayers | null {
  if (shape === 'none') return null;
  const tintOf = (colour: string) => `color-mix(in oklab, ${colour} ${Math.round(PATTERN.alpha[shape] * 1000) / 10}%, transparent)`;
  const peak = tintOf(ink);
  // The second hue's stop, or nothing: one-hue CSS is unchanged byte for byte.
  const then = (at: string) => (ink2 === null ? '' : `${tintOf(ink2)} ${at}, `);
  const cover = { size: 'cover', position: '0 0' };
  switch (shape) {
    case 'glow':
      // A wide ellipse anchored to one edge: clear at the middle, ink at the rim.
      return {
        image: ink2 === null
          ? `radial-gradient(${PATTERN.glowEllipse} at ${PATTERN.at[origin]}, transparent ${PATTERN.glowStart}, ${peak} 100%)`
          : `radial-gradient(${PATTERN.glowEllipse} at ${PATTERN.at[origin]}, transparent ${PATTERN.glowStart}, ${peak} ${PATTERN.glowMid}, ${tintOf(ink2)} 100%)`,
        ...cover,
      };
    case 'spotlight':
      return { image: `radial-gradient(${PATTERN.spotEllipse} at ${PATTERN.at[origin]}, ${peak} 0%, ${then(PATTERN.spotMid)}transparent ${PATTERN.spotEnd})`, ...cover };
    case 'ramp':
      return { image: `linear-gradient(${PATTERN.toward[origin]}, ${peak} 0%, ${then(PATTERN.rampMid)}transparent ${PATTERN.rampEnd})`, ...cover };
    case 'grid':
      // Hairlines stay one line wide whatever the pitch — scaled lines read as stripes.
      return {
        image: `linear-gradient(0deg, ${peak} 0 ${PATTERN.hairline}, transparent ${PATTERN.hairline} 100%), `
          + `linear-gradient(90deg, ${peak} 0 ${PATTERN.hairline}, transparent ${PATTERN.hairline} 100%)`,
        size: `${PATTERN.pitch} ${PATTERN.pitch}, ${PATTERN.pitch} ${PATTERN.pitch}`,
        position: '0 0, 0 0',
      };
    case 'hatch':
      return {
        image: `repeating-linear-gradient(${PATTERN.hatchAngle}, ${peak} 0 ${PATTERN.hairline}, transparent ${PATTERN.hairline} ${PATTERN.pitch})`,
        size: 'auto',
        position: '0 0',
      };
    case 'dots':
      return {
        image: `radial-gradient(circle at 50% 50%, ${peak} 0 ${PATTERN.dot}, transparent ${PATTERN.dotFade})`,
        size: `${PATTERN.pitch} ${PATTERN.pitch}`,
        position: '0 0',
      };
  }
}
