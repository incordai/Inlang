/**
 * Chart series colours — chat-block-spec §20.4, theme-spec §15. The rule is
 * re-proven here on every theme × (own accent, every accent, every offered
 * pair) × scheme from the tokens it returns: six series, each 3:1 on bg,
 * surface and surface-alt, any two at least SERIES_MIN_DISTANCE apart in
 * OKLab, series-1 the accent (series-2 the pair's second hue), the same
 * answer twice, and nothing added to a theme that was not asked for series.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from '../src/themes.ts';
import { ACCENT_NAMES, withAccent } from '../src/accent.ts';
import { withAccentPair } from '../src/gradient.ts';
import { SERIES_EDGE, SERIES_MIN_DISTANCE, SERIES_TOKENS, SeriesUnavailable, oklabDistance, seriesTokens, withSeries } from '../src/series.ts';
import { contrastRatio, rgbOf } from '../src/color.ts';
import { schemeCss } from '../src/css.ts';
import type { AccentName } from '../src/ramps.ts';
import type { Theme } from '../src/tokens.ts';
import { ACCENT_PAIRS } from '../../core/src/accent-pairs.ts';

const SCHEMES = ['light', 'dark'] as const;

/** Every theme the build can make: own accent, each accent, each offered pair. */
function variants(): { label: string; theme: Theme }[] {
  const out: { label: string; theme: Theme }[] = [];
  for (const base of Object.values(THEMES) as Theme[]) {
    out.push({ label: `${base.name}`, theme: base });
    for (const a of ACCENT_NAMES) {
      out.push({ label: `${base.name} ${a}`, theme: withAccent(base, a) });
      for (const b of ACCENT_PAIRS[base.name][a] as AccentName[]) {
        out.push({ label: `${base.name} ${a} ${b}`, theme: withAccentPair(base, a, b) });
      }
    }
  }
  return out;
}

const ALL = variants();

test('series: six colours on every theme, accent and pair, both schemes, each 3:1 on every ground', () => {
  let cases = 0;
  for (const { label, theme } of ALL) {
    for (const scheme of SCHEMES) {
      const s = seriesTokens(theme, scheme);
      const c = theme.color[scheme];
      assert.deepEqual(Object.keys(s), [...SERIES_TOKENS], label);
      for (const token of SERIES_TOKENS) {
        for (const ground of ['bg', 'surface', 'surface-alt'] as const) {
          const r = contrastRatio(rgbOf(s[token]), rgbOf(c[ground]));
          assert.ok(r >= SERIES_EDGE, `${label} ${scheme}: ${token} is ${r}:1 on ${ground}`);
        }
      }
      cases++;
    }
  }
  // 6 themes × (own + 9 accents) × 2 schemes, plus every offered pair.
  assert.ok(cases >= 120, `only ${cases} cases`);
});

test('series: any two of one set are at least SERIES_MIN_DISTANCE apart in OKLab', () => {
  let closest = Infinity;
  for (const { label, theme } of ALL) {
    for (const scheme of SCHEMES) {
      const s = Object.values(seriesTokens(theme, scheme)).map(rgbOf);
      for (let i = 0; i < s.length; i++) {
        for (let j = i + 1; j < s.length; j++) {
          const d = oklabDistance(s[i], s[j]);
          closest = Math.min(closest, d);
          assert.ok(d >= SERIES_MIN_DISTANCE, `${label} ${scheme}: series ${i + 1} and ${j + 1} are ${d} apart`);
        }
      }
    }
  }
  assert.ok(Number.isFinite(closest));
});

test('series: series-1 is the accent, series-2 the pair\'s second hue', () => {
  for (const { label, theme } of ALL) {
    for (const scheme of SCHEMES) {
      const c = theme.color[scheme];
      const s = seriesTokens(theme, scheme);
      assert.equal(s['series-1'], c.accent, label);
      if (c.accent2 !== undefined) assert.equal(s['series-2'], c.accent2, label);
      assert.equal(new Set(Object.values(s)).size, SERIES_TOKENS.length, `${label} ${scheme}: a colour is used twice`);
    }
  }
});

test('series: deterministic, and only on a theme that asked for them', () => {
  const paper = THEMES.paper as Theme;
  assert.deepEqual(seriesTokens(paper, 'light'), seriesTokens(paper, 'light'));
  assert.equal(paper.color.light['series-1'], undefined);
  assert.doesNotMatch(schemeCss(paper), /--az-color-series-/);
  const css = schemeCss(withSeries(paper));
  for (const token of SERIES_TOKENS) assert.match(css, new RegExp(`--az-color-${token}: `));
  // Both schemes, so dark mode follows without a word knowing.
  assert.equal((css.match(/--az-color-series-1: /g) ?? []).length, 3);
});

test('series: a theme whose grounds leave too few hues is refused, never shipped under the floor', () => {
  const base = THEMES.paper as Theme;
  // A mid-grey ground no ramp step clears 3:1 against.
  const grey = 'hsl(0 0% 50%)';
  const broken: Theme = { ...base, color: { ...base.color, light: { ...base.color.light, bg: grey, surface: grey, 'surface-alt': grey } } };
  assert.throws(() => seriesTokens(broken, 'light'), SeriesUnavailable);
});
