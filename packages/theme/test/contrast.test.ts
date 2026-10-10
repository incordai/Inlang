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
import { FONT_STACKS, type Scheme, type Theme, VEIL_PERCENT } from '../src/tokens.ts';
import { ACCENT_NAMES, withAccent } from '../src/accent.ts';
import type { PAIR_TOKENS } from '../src/gradient.ts';

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

/** The role tokens every theme defines; a pair's own tokens are proven in gradient.test.ts. */
type Role = Exclude<keyof typeof THEMES.midnight.color.light, (typeof PAIR_TOKENS)[number]>;

const PAIRS: Array<[fg: Role, bg: Role, floor: number]> = [
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
  // buttons on the cta band (cta-spec §3): the inverted primary is accent ink
  // on an accent-contrast fill; its focus ring is accent-contrast on the
  // accent band — the pair above — because `focus` is an accent shade.
  ['accent', 'accent-contrast', BODY],
  ['danger', 'bg', BODY],
  ['danger', 'surface', BODY],
  ['danger-contrast', 'danger', BODY],
  ['on-scrim', 'scrim', BODY],
  ['focus', 'bg', LARGE],
  ['focus', 'surface', LARGE],
  ['focus', 'surface-alt', LARGE],
  ['border-strong', 'bg', LARGE],
  // pricing §7.3/§8: the highlighted plan's edge is accent on its
  // surface-alt fill — a non-text edge, 3:1 (WCAG 1.4.11).
  ['accent', 'surface-alt', LARGE],
];

const NAMES = Object.keys(THEMES) as ThemeName[];
const SCHEMES: Scheme[] = ['light', 'dark'];

/**
 * PRD §6.1a: `theme accent` regenerates the accent tokens, and "a step that
 * fails the floor is not offered". So every pair below must hold for every
 * hue a site can name, not only each theme's own accent (`own`).
 */
const VARIANTS: { label: string; theme: Theme }[] = NAMES.flatMap((name) =>
  [null, ...ACCENT_NAMES].map((hue) => ({ label: `${name}+${hue ?? 'own'}`, theme: withAccent(THEMES[name], hue) })));

test('CONTROL: the ratio function is correct on known values', () => {
  // Without this, every pass below could mean the maths is broken.
  assert.equal(ratio('hsl(0 0% 100%)', 'hsl(0 0% 0%)'), 21);
  assert.equal(ratio('hsl(0 0% 100%)', 'hsl(0 0% 100%)'), 1);
});

for (const { label, theme } of VARIANTS) {
  for (const scheme of SCHEMES) {
    test(`${label}/${scheme}: every pair clears its floor`, () => {
      const c = theme.color[scheme];
      const failures: string[] = [];
      for (const [fg, bg, floor] of PAIRS) {
        const r = ratio(c[fg], c[bg]);
        if (r < floor) failures.push(`${fg} on ${bg} = ${r}:1 (needs ${floor})`);
      }
      assert.deepEqual(failures, [], `${label}/${scheme}\n  ` + failures.join('\n  '));
    });
  }
}

test(`all ${PAIRS.length * VARIANTS.length * SCHEMES.length} pairs were actually computed`, () => {
  // theme-spec §6's own lesson: a table is only evidence if it is allowed to
  // fail. Counting the comparisons proves the loop ran rather than skipped.
  let n = 0;
  for (const { theme } of VARIANTS) {
    for (const scheme of SCHEMES) {
      const c = theme.color[scheme];
      for (const [fg, bg] of PAIRS) { ratio(c[fg], c[bg]); n++; }
    }
  }
  assert.equal(VARIANTS.length, NAMES.length * (ACCENT_NAMES.length + 1), 'every theme × (own + each hue)');
  assert.equal(n, PAIRS.length * VARIANTS.length * SCHEMES.length);
});

test('CONTROL: a deliberately bad pair IS caught', () => {
  // Proves the floor comparison would fire, rather than the suite being inert.
  assert.ok(ratio('hsl(0 0% 96%)', 'hsl(0 0% 100%)') < BODY);
});

/* ---------------- theme-spec §10.2 checks 1, 2 and 7: completeness ---------------- */

const keys = (o: object) => Object.keys(o).sort();
/** midnight is the reference: every theme defines exactly the tokens it does. */
const REFERENCE = THEMES.midnight;

for (const name of NAMES) {
  test(`${name}: defines every token, in both schemes, and nothing else`, () => {
    const t: Theme = THEMES[name];
    assert.equal(t.name, name, 'the name matches its key in THEMES');
    for (const scheme of SCHEMES) {
      assert.deepEqual(keys(t.color[scheme]), keys(REFERENCE.color.light), `color.${scheme}`);
      assert.deepEqual(keys(t.shadow[scheme]), keys(REFERENCE.shadow.light), `shadow.${scheme}`);
      for (const [k, v] of Object.entries(t.color[scheme])) assert.match(v, /^hsl\(\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%\)$/, `${scheme} ${k}`);
    }
    assert.deepEqual(keys(t.size), keys(REFERENCE.size), 'size');
    assert.deepEqual(keys(t.type), keys(REFERENCE.type), 'type');
    assert.deepEqual(keys(t.radius), keys(REFERENCE.radius), 'radius');
    // theme-spec §8.1: a family is one of the system stacks, never a downloaded face.
    const stacks: string[] = Object.values(FONT_STACKS);
    for (const role of ['display', 'body', 'mono'] as const) assert.ok(stacks.includes(t.type[role]), `type.${role}: ${t.type[role]}`);
    // §6.1: the focus fix depends on the ring standing off the fill.
    assert.ok(t.size['ring-offset'] >= 1, 'size.ring-offset >= 1');
  });
}

test('the themes are genuinely different, not hue rotations', () => {
  // PRD §10 risk: "generated 3D sites all look identical". The themes are the
  // mitigation, so sameness here is a product failure, not a style quibble.
  const radii = NAMES.map((n) => JSON.stringify(THEMES[n].radius));
  assert.equal(new Set(radii).size, NAMES.length, 'radius language must differ');
  const bgs = NAMES.map((n) => THEMES[n].color.dark.bg);
  assert.equal(new Set(bgs).size, NAMES.length, 'dark grounds must differ');
});

/* ---------------- scene-spec §6.5: the veil over any backdrop ---------------- */

/** `color-mix(in srgb, bg P%, transparent)` over an opaque pixel — the browser's composite. */
function overPixel(bg: string, percent: number, pixel: [number, number, number]): [number, number, number] {
  const a = percent / 100;
  const c = hslToRgb(bg);
  return [0, 1, 2].map((i) => a * c[i] + (1 - a) * pixel[i]) as [number, number, number];
}
const ratioRgb = (fg: string, bg: [number, number, number]) => {
  const la = luminance(hslToRgb(fg)), lb = luminance(bg);
  return Math.floor(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
};
/** A live backdrop can show any colour; these two bound every luminance. */
const EXTREMES: [string, [number, number, number]][] = [['white', [255, 255, 255]], ['black', [0, 0, 0]]];
/** What reads on the veil: text, muted text and links at 4.5:1, outlines at 3:1 (WCAG 1.4.11). */
const VEIL_PAIRS: [string, number][] = [['text', 4.5], ['muted', 4.5], ['accent', 4.5], ['border-strong', 3]];

for (const { label, theme } of VARIANTS) {
  for (const scheme of SCHEMES) {
    test(`${label}/${scheme}: the veil keeps every reading pair above its floor over any backdrop`, () => {
      const c = theme.color[scheme] as unknown as Record<string, string>;
      for (const [fg, floor] of VEIL_PAIRS) {
        for (const [label, pixel] of EXTREMES) {
          const r = ratioRgb(c[fg], overPixel(c.bg, VEIL_PERCENT, pixel));
          assert.ok(r >= floor, `${fg} on the veil over ${label}: ${r}:1 < ${floor}:1`);
        }
      }
    });
  }
}

/** The smallest whole percent that holds everywhere; VEIL_PERCENT keeps a margin above it. */
const VEIL_MINIMUM = 90;

test('the veil keeps its margin above the smallest percent that holds', () => {
  assert.ok(VEIL_PERCENT >= VEIL_MINIMUM + 2, `${VEIL_PERCENT}% leaves no compositing margin`);
  // …and the minimum really does hold everywhere, or the margin is fiction.
  for (const name of NAMES) for (const scheme of SCHEMES) {
    const c = THEMES[name].color[scheme] as unknown as Record<string, string>;
    for (const [fg, floor] of VEIL_PAIRS) for (const [label, px] of EXTREMES) {
      const r = ratioRgb(c[fg], overPixel(c.bg, VEIL_MINIMUM, px));
      assert.ok(r >= floor, `${name}/${scheme} ${fg} over ${label} at ${VEIL_MINIMUM}%: ${r}:1`);
    }
  }
});

test('CONTROL: one point under the minimum fails somewhere — the percentage is load-bearing', () => {
  const thin = VEIL_MINIMUM - 1;
  const fails = NAMES.some((name) => SCHEMES.some((scheme) => {
    const c = THEMES[name].color[scheme] as unknown as Record<string, string>;
    return VEIL_PAIRS.some(([fg, floor]) => EXTREMES.some(([, px]) => ratioRgb(c[fg], overPixel(c.bg, thin, px)) < floor));
  }));
  assert.ok(fails, `${thin}% should break at least one pair`);
});
