/**
 * `theme accent <hue> <hue2>` — theme-spec §13. The pair table is GENERATED
 * from the proof (scripts/gen-pairs.mjs); this test regenerates it, then
 * re-proves every offered pair from the tokens it ships, sampling more
 * densely than the generator does, so a gap between the generator's samples
 * could not hide a failure. Known-bad pairs must be refused, each for its
 * own reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pairsSource } from '../../../scripts/gen-pairs.mjs';
import { THEMES } from '../src/themes.ts';
import { ACCENT_NAMES, withAccent } from '../src/accent.ts';
import { ACCENT_HUE_DEGREES, type AccentName } from '../src/ramps.ts';
import {
  GRADIENT_FALLBACK_STOPS, PAIR_CHROMA_FLOOR, PAIR_HUE_MAX, PAIR_HUE_MIN, PAIR_TOKENS, PairUnavailable,
  hueDistance, pairTable, pairVerdict, withAccentPair,
} from '../src/gradient.ts';
import { gradientCss, GRADIENT_REFERENCES, schemeCss } from '../src/css.ts';
import { contrastRatio, lchOf, oklchMix, rgbOf, srgbMix, type GamutMap, type Rgb } from '../src/color.ts';
import { lintSource } from '../src/lint.ts';
import type { Theme } from '../src/tokens.ts';
import { ACCENT_PAIRS } from '../../core/src/accent-pairs.ts';

const FILE = fileURLToPath(new URL('../../core/src/accent-pairs.ts', import.meta.url));
const SCHEMES = ['light', 'dark'] as const;
/** Four times the generator's density: the test samples between the generator's points too. */
const DENSE = 1024;

const offered = (theme: Theme): [AccentName, AccentName][] =>
  ACCENT_NAMES.flatMap((a) => (ACCENT_PAIRS[theme.name][a] as AccentName[]).map((b) => [a, b] as [AccentName, AccentName]));
/** Each offered pair once: the reverse paints the same points (checked below). */
const once = (theme: Theme) => offered(theme).filter(([a, b]) => ACCENT_NAMES.indexOf(a) < ACCENT_NAMES.indexOf(b));
/** One generator run, shared: it judges every pair on every theme. */
const SOURCE = pairsSource();

/** Every point a browser can paint for the gradient a → b, re-derived here at DENSE. */
function painted(a: Rgb, b: Rgb): { all: Rgb[]; chromatic: Rgb[] } {
  const ts = Array.from({ length: DENSE + 1 }, (_, i) => i / DENSE);
  const chromatic: Rgb[] = [];
  for (const map of ['clip', 'chroma'] as GamutMap[]) {
    chromatic.push(...ts.map((t) => oklchMix(a, b, t, map)));
    const stops = GRADIENT_FALLBACK_STOPS.map((t) => oklchMix(a, b, t, map));
    const n = stops.length - 1;
    chromatic.push(...ts.map((t) => {
      const k = Math.min(n - 1, Math.floor(t * n));
      return srgbMix(stops[k], stops[k + 1], t * n - k);
    }));
  }
  return { all: [...chromatic, ...ts.map((t) => srgbMix(a, b, t))], chromatic };
}

const low = (points: readonly Rgb[], against: Rgb) => Math.min(...points.map((p) => contrastRatio(p, against)));

test('accent-pairs.ts is exactly the generator output — no hand edits', () => {
  assert.equal(readFileSync(FILE, 'utf8'), SOURCE, 'regenerate with: node scripts/gen-pairs.mjs');
});

test('CONTROL: a hand-added pair makes the comparison fail', () => {
  assert.notEqual(SOURCE.replace("violet: ['blue',", "violet: ['indigo', 'blue',"), readFileSync(FILE, 'utf8'));
});

test('the table covers every theme and every hue, and is symmetric', () => {
  assert.deepEqual(Object.keys(ACCENT_PAIRS), Object.keys(THEMES));
  for (const theme of Object.values(THEMES)) {
    assert.deepEqual(Object.keys(ACCENT_PAIRS[theme.name]), [...ACCENT_NAMES], theme.name);
    for (const [a, b] of offered(theme)) {
      assert.ok(ACCENT_PAIRS[theme.name][b].includes(a), `${theme.name}: ${a}→${b} but not back`);
      // pairTable judges each pair once; the other way round must agree.
      assert.equal(pairVerdict(theme, a, b).ok, true, `${theme.name}: ${a} ${b}`);
    }
  }
});

test('DETERMINISM: the table and every verdict are the same on every run', () => {
  assert.equal(pairsSource(), SOURCE);
  assert.deepEqual(pairTable(THEMES.paper), pairTable(THEMES.paper));
  assert.deepEqual(pairVerdict(THEMES.signal, 'violet', 'rose'), pairVerdict(THEMES.signal, 'violet', 'rose'));
});

test('every offered pair sits inside the hue window', () => {
  for (const theme of Object.values(THEMES)) {
    for (const [a, b] of offered(theme)) {
      const d = hueDistance(a, b);
      assert.ok(d >= PAIR_HUE_MIN && d <= PAIR_HUE_MAX, `${a} ${b}: ${d}°`);
    }
  }
  assert.equal(hueDistance('rose', 'violet'), 360 - ACCENT_HUE_DEGREES.violet + ACCENT_HUE_DEGREES.rose, 'the short way round');
});

test('every offered pair holds every floor at every densely sampled point, in both schemes', () => {
  let checked = 0;
  for (const theme of Object.values(THEMES)) {
    for (const [first, second] of once(theme)) {
      const paired = withAccentPair(theme, first, second);
      for (const scheme of SCHEMES) {
        const c = paired.color[scheme];
        const where = `${theme.name} ${first} ${second} ${scheme}`;
        const rest = painted(rgbOf(c.accent), rgbOf(c.accent2!));
        const hover = painted(rgbOf(c['accent-hover']), rgbOf(c['accent2-hover']!));
        assert.ok(low(rest.all, rgbOf(c.bg)) >= 4.5, `${where}: fill on bg`);
        assert.ok(low(rest.all, rgbOf(c.surface)) >= 4.5, `${where}: fill on surface`);
        assert.ok(low(rest.all, rgbOf(c['surface-alt'])) >= 3, `${where}: edge on surface-alt`);
        assert.ok(low(hover.all, rgbOf(c.bg)) >= 4.5, `${where}: hover fill on bg`);
        const label = rgbOf(c['on-gradient']!);
        assert.ok(low([...rest.all, ...hover.all], label) >= 4.5, `${where}: on-gradient`);
        for (const [name, g, ends] of [['rest', rest, [c.accent, c.accent2!]], ['hover', hover, [c['accent-hover'], c['accent2-hover']!]]] as const) {
          const weaker = Math.min(...ends.map((e) => lchOf(rgbOf(e))[1]));
          const kept = Math.min(...g.chromatic.map((p) => lchOf(p)[1])) / weaker;
          assert.ok(kept >= PAIR_CHROMA_FLOOR - 0.01, `${where}: ${name} keeps ${kept.toFixed(3)} of its chroma`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'some pairs were actually proven');
});

test('a pair adds exactly its three tokens and changes nothing else', () => {
  const one = withAccent(THEMES.midnight, 'violet');
  const two = withAccentPair(THEMES.midnight, 'violet', 'blue');
  for (const scheme of SCHEMES) {
    const before = one.color[scheme] as unknown as Record<string, string>;
    const after = two.color[scheme] as unknown as Record<string, string>;
    assert.deepEqual(Object.keys(after).filter((k) => !(k in before)).sort(), [...PAIR_TOKENS].sort(), scheme);
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${scheme} ${k}`);
  }
});

test('one hue is exactly withAccent — no pair tokens, no gradient CSS', () => {
  for (const theme of Object.values(THEMES)) {
    for (const hue of [null, ...ACCENT_NAMES]) {
      const t = withAccentPair(theme, hue, null);
      assert.deepEqual(t, withAccent(theme, hue));
      assert.equal(schemeCss(t), schemeCss(withAccent(theme, hue)));
      assert.doesNotMatch(schemeCss(t), /accent2|on-gradient/);
    }
  }
  assert.equal(gradientCss(false), '');
});

test('known-bad pairs are refused, each for its own reason', () => {
  const reason = (a: AccentName, b: AccentName, t: Theme = THEMES.midnight) => {
    const v = pairVerdict(t, a, b);
    assert.equal(v.ok, false, `${a} ${b} was offered`);
    return v.ok ? '' : v.reason;
  };
  assert.match(reason('violet', 'violet'), /itself/);
  assert.match(reason('violet', 'indigo'), /17° apart — under 30°/);
  assert.match(reason('teal', 'rose'), /180° apart — over 120°/);
  // In the window, but the middle goes grey: the chroma floor refuses it.
  assert.match(reason('blue', 'green'), /keeps 0\.\d+ of its chroma, under 0\.8/);
  assert.throws(() => withAccentPair(THEMES.paper, 'blue', 'green'), PairUnavailable);
});

test('CONTROL: a ground no gradient can hold its floors on refuses every pair', () => {
  // A mid-grey ground: nothing reaches 4.5:1 on it, so no pair may be offered.
  const grey = 'hsl(0 0% 46%)';
  const muddy: Theme = {
    ...THEMES.paper,
    color: { ...THEMES.paper.color, light: { ...THEMES.paper.color.light, bg: grey, surface: grey, 'surface-alt': grey } },
  };
  assert.equal(pairVerdict(muddy, 'violet', 'blue').ok, false);
  assert.ok(Object.values(pairTable(muddy)).every((partners) => partners.length === 0));
});

test('the gradient CSS: sRGB, then OKLCH stops, then OKLCH — references only, no raw colour', () => {
  const css = gradientCss(true);
  const [plain, stops, oklch] = css.split('@supports');
  assert.match(plain, /--az-gradient-accent: linear-gradient\(to right, var\(--az-color-accent\), var\(--az-color-accent2\)\);/);
  assert.match(plain, /--az-gradient-accent-hover: linear-gradient\(to right, var\(--az-color-accent-hover\), var\(--az-color-accent2-hover\)\);/);
  assert.match(stops, /^ \(color: color-mix\(in oklch, transparent, transparent\)\)/);
  for (const p of [75, 50, 25]) {
    assert.match(stops, new RegExp(`color-mix\\(in oklch, var\\(--az-color-accent\\) ${p}%, var\\(--az-color-accent2\\)\\)`));
  }
  assert.match(oklch, /^ \(background-image: linear-gradient\(in oklch, transparent, transparent\)\)/);
  assert.match(oklch, /linear-gradient\(to right in oklch, var\(--az-color-accent\), var\(--az-color-accent2\)\)/);
  assert.deepEqual(lintSource('theme.css', css, 'package'), []);
  assert.deepEqual(Object.values(GRADIENT_REFERENCES), ['var(--az-gradient-accent)', 'var(--az-gradient-accent-hover)']);
});
