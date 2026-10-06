/**
 * `theme pattern` — PRD §6.1a. A pattern sits under the hero's type, so its
 * strength is a contrast question: at its peak, accent ink over the ground
 * must leave text, muted and accent at 4.5:1 and border-strong at 3:1, for
 * every theme × accent × scheme.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from '../src/themes.ts';
import { ACCENT_NAMES, withAccent } from '../src/accent.ts';
import { PATTERN, PATTERN_MAX_ALPHA, PATTERN_ORIGINS, PATTERN_SHAPES } from '../src/tokens.ts';
import { composite, contrastRatio, rgbOf } from '../src/color.ts';
import { patternLayers } from '../src/pattern.ts';
import { lintSource } from '../src/lint.ts';

const READING: [string, number][] = [['text', 4.5], ['muted', 4.5], ['accent', 4.5], ['border-strong', 3]];

/** The first failure at `alpha`, or null when every pair holds everywhere. */
function failureAt(alpha: number): string | null {
  for (const base of Object.values(THEMES)) {
    for (const hue of [null, ...ACCENT_NAMES]) {
      const theme = withAccent(base, hue);
      for (const scheme of ['light', 'dark'] as const) {
        const c = theme.color[scheme] as unknown as Record<string, string>;
        const ground = composite(rgbOf(c.accent), rgbOf(c.bg), alpha);
        for (const [fg, floor] of READING) {
          const r = contrastRatio(rgbOf(c[fg]), ground);
          if (r < floor) return `${base.name}+${hue ?? 'own'}/${scheme}: ${fg} ${r}:1 < ${floor}`;
        }
      }
    }
  }
  return null;
}

/** The largest whole percent at which every pair holds. */
const holdsUpTo = (() => {
  let p = 0;
  while (p < 100 && failureAt((p + 1) / 100) === null) p++;
  return p;
})();

test('every shape peaks at or under the cap', () => {
  for (const [shape, alpha] of Object.entries(PATTERN.alpha)) {
    assert.ok(alpha <= PATTERN_MAX_ALPHA, `${shape} ${alpha} > ${PATTERN_MAX_ALPHA}`);
  }
});

test('reading pairs hold at the cap for every theme × accent × scheme', () => {
  assert.equal(failureAt(PATTERN_MAX_ALPHA), null);
});

test('the cap keeps a two-point margin under the largest percent that holds', () => {
  assert.ok(Math.round(PATTERN_MAX_ALPHA * 100) + 2 <= holdsUpTo,
    `cap ${PATTERN_MAX_ALPHA * 100}% vs holds up to ${holdsUpTo}%`);
});

test("CONTROL: the spike's original 55% glow fails — the cap is load-bearing", () => {
  assert.notEqual(failureAt(0.55), null);
  assert.notEqual(failureAt((holdsUpTo + 1) / 100), null, 'one point over the measured limit fails');
});

test('none paints nothing; every other shape is built from the ink token alone', () => {
  assert.equal(patternLayers('none', 'top', 'var(--ink)'), null);
  for (const shape of PATTERN_SHAPES.filter((s) => s !== 'none')) {
    const layers = patternLayers(shape, 'top', 'var(--ink)');
    assert.ok(layers, shape);
    assert.match(layers.image, /color-mix\(in oklab, var\(--ink\) [\d.]+%, transparent\)/, shape);
    const css = `${layers.image}; ${layers.size}; ${layers.position}`;
    assert.deepEqual(lintSource('pattern.css', css).filter((f) => f.rule === 'no-colour-function' || f.rule === 'no-hex'), [],
      `${shape} must carry no raw colour`);
  }
});

test('the origin moves the light for focal shapes', () => {
  const positions = PATTERN_ORIGINS.map((o) => patternLayers('glow', o, 'var(--ink)')!.image);
  assert.equal(new Set(positions).size, PATTERN_ORIGINS.length);
  assert.notEqual(patternLayers('ramp', 'top', 'x')!.image, patternLayers('ramp', 'left', 'x')!.image);
});
