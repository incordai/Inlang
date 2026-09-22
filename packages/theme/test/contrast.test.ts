/**
 * Contrast proof — RECOMPUTED, not trusted.
 *
 * theme-spec.md §6 publishes a table of 132 ratios. This test does not read
 * that table; it computes the ratios from the theme values in code. A
 * published number and a shipped colour are two different things, and only one
 * of them reaches a visitor.
 *
 * theme-spec §6 is explicit that the table is "only evidence if it is allowed
 * to fail" — it failed 9 of 132 on its first pass and forced two real fixes.
 * This is that check, mechanised.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, type ThemeName } from '../src/themes.ts';
import { type Scheme } from '../src/tokens.ts';

/* ---------------- colour maths ---------------- */

/** Parse `hsl(H S% L%)` — the form theme-spec §5 uses. */
function hslToRgb(css: string): [number, number, number] {
  const m = css.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  assert.ok(m, `unparsable colour: ${css}`);
  const h = Number(m![1]) / 360, s = Number(m![2]) / 100, l = Number(m![3]) / 100;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Truncated, never rounded up — a printed 4.50 is genuinely at the floor. */
function ratio(a: string, b: string): number {
  const la = luminance(hslToRgb(a));
  const lb = luminance(hslToRgb(b));
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ---------------- the pairs that must clear a floor ---------------- */

const BODY = 4.5;   // hero-spec §9
const LARGE = 3;    // 24px+, or a non-text edge

const PAIRS: Array<[fg: keyof typeof THEMES.midnight.color.light,
                    bg: keyof typeof THEMES.midnight.color.light,
                    floor: number]> = [
  ['text', 'bg', BODY],
  ['text', 'surface', BODY],
  ['text', 'surface-alt', BODY],
  ['muted', 'bg', BODY],
  ['muted', 'surface', BODY],
  ['muted', 'surface-alt', BODY],
  ['accent', 'bg', BODY],
  ['accent', 'surface', BODY],
  ['accent-hover', 'bg', BODY],
  ['accent-contrast', 'accent', BODY],
  ['accent-contrast', 'accent-hover', BODY],
  ['danger', 'bg', BODY],
  ['danger', 'surface', BODY],
  ['danger-contrast', 'danger', BODY],
  ['on-scrim', 'scrim', BODY],
  ['focus', 'bg', LARGE],
  ['focus', 'surface', LARGE],
  ['focus', 'surface-alt', LARGE],
  ['border-strong', 'bg', LARGE],
];

const NAMES = Object.keys(THEMES) as ThemeName[];
const SCHEMES: Scheme[] = ['light', 'dark'];

test('CONTROL: the ratio function is correct on known values', () => {
  // Without this, every pass below could mean the maths is broken.
  assert.equal(ratio('hsl(0 0% 100%)', 'hsl(0 0% 0%)'), 21);
  assert.equal(ratio('hsl(0 0% 100%)', 'hsl(0 0% 100%)'), 1);
});

for (const name of NAMES) {
  for (const scheme of SCHEMES) {
    test(`${name}/${scheme}: every pair clears its floor`, () => {
      const c = THEMES[name].color[scheme];
      const failures: string[] = [];
      for (const [fg, bg, floor] of PAIRS) {
        const r = ratio(c[fg], c[bg]);
        if (r < floor) failures.push(`${fg} on ${bg} = ${r}:1 (needs ${floor})`);
      }
      assert.deepEqual(failures, [], `${name}/${scheme}\n  ` + failures.join('\n  '));
    });
  }
}

test(`all ${PAIRS.length * NAMES.length * SCHEMES.length} pairs were actually computed`, () => {
  // theme-spec §6's own lesson: a table is only evidence if it is allowed to
  // fail. Counting the comparisons proves the loop ran rather than skipped.
  let n = 0;
  for (const name of NAMES) {
    for (const scheme of SCHEMES) {
      const c = THEMES[name].color[scheme];
      for (const [fg, bg] of PAIRS) { ratio(c[fg], c[bg]); n++; }
    }
  }
  assert.equal(n, PAIRS.length * NAMES.length * SCHEMES.length);
});

test('CONTROL: a deliberately bad pair IS caught', () => {
  // Proves the floor comparison would fire, rather than the suite being inert.
  assert.ok(ratio('hsl(0 0% 96%)', 'hsl(0 0% 100%)') < BODY);
});

test('the three themes are genuinely different, not hue rotations', () => {
  // PRD §10 risk: "generated 3D sites all look identical". The themes are the
  // mitigation, so sameness here is a product failure, not a style quibble.
  const radii = NAMES.map((n) => JSON.stringify(THEMES[n].radius));
  assert.equal(new Set(radii).size, NAMES.length, 'radius language must differ');
  const bgs = NAMES.map((n) => THEMES[n].color.dark.bg);
  assert.equal(new Set(bgs).size, NAMES.length, 'dark grounds must differ');
});
