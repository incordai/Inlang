/**
 * `theme accent` — PRD §6.1a. The floors themselves are proven for every
 * theme × accent × scheme in contrast.test.ts; this covers the mechanism.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from '../src/themes.ts';
import { ACCENT_NAMES, AccentUnavailable, accentTokens, withAccent } from '../src/accent.ts';
import { PATTERN_ORIGINS, PATTERN_SHAPES, type Theme } from '../src/tokens.ts';
import { contrastRatio, rgbOf } from '../src/color.ts';
import {
  ACCENT_HUES, PATTERN_ORIGIN_NAMES, PATTERN_SHAPE_NAMES, THEME_NAMES,
} from '../../core/src/link.ts';

test("core's closed sets equal the theme package's — the compiler offers exactly what exists", () => {
  assert.deepEqual(Object.keys(THEME_NAMES).sort(), Object.keys(THEMES).sort());
  assert.deepEqual(Object.keys(ACCENT_HUES).sort(), [...ACCENT_NAMES].sort());
  assert.deepEqual(Object.keys(PATTERN_SHAPE_NAMES).sort(), [...PATTERN_SHAPES].sort());
  assert.deepEqual(Object.keys(PATTERN_ORIGIN_NAMES).sort(), [...PATTERN_ORIGINS].sort());
});

test('no accent keeps the theme exactly as designed', () => {
  assert.equal(withAccent(THEMES.paper, null), THEMES.paper);
});

test('an accent changes only accent, accent-hover and accent-contrast — focus stays (theme-spec §6.1)', () => {
  const t = withAccent(THEMES.midnight, 'teal');
  for (const scheme of ['light', 'dark'] as const) {
    const before = THEMES.midnight.color[scheme] as unknown as Record<string, string>;
    const after = t.color[scheme] as unknown as Record<string, string>;
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]).sort();
    assert.deepEqual(changed, ['accent', 'accent-contrast', 'accent-hover'], scheme);
  }
});

test('hover moves away from the ground: higher contrast against bg than the accent', () => {
  for (const theme of Object.values(THEMES)) {
    for (const name of ACCENT_NAMES) {
      for (const scheme of ['light', 'dark'] as const) {
        const a = accentTokens(name, theme, scheme);
        const bg = rgbOf(theme.color[scheme].bg);
        assert.ok(contrastRatio(rgbOf(a['accent-hover']), bg) > contrastRatio(rgbOf(a.accent), bg),
          `${theme.name}/${name}/${scheme}`);
      }
    }
  }
});

test('DETERMINISM: the same theme and hue give the same tokens', () => {
  assert.deepEqual(accentTokens('rose', THEMES.signal, 'dark'), accentTokens('rose', THEMES.signal, 'dark'));
});

test('CONTROL: a hue that cannot meet the floors on a ground THROWS — never ships under its floor', () => {
  // A mid-grey ground: no step of any hue reaches 4.5:1 against it AND its veil extremes.
  const grey = 'hsl(0 0% 46%)';
  const muddy: Theme = {
    ...THEMES.paper,
    color: {
      ...THEMES.paper.color,
      light: { ...THEMES.paper.color.light, bg: grey, surface: grey, 'surface-alt': grey },
    },
  };
  assert.throws(() => accentTokens('violet', muddy, 'light'), AccentUnavailable);
});
