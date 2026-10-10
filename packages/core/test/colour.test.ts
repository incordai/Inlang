/**
 * The colour step's text (colour.ts) — what AZ.md and docs/WORDS.md print as
 * the legal colour values. It must be the compiler's own tables, so a theme,
 * hue, pair or shape added there appears here without a hand edit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME_NAME, colourChoicesMd, partnersOf, themeLinesAz } from '../src/colour.ts';
import { ACCENT_HUES, PATTERN_ORIGIN_NAMES, PATTERN_SHAPE_NAMES, THEME_NAMES } from '../src/link.ts';
import { ACCENT_PAIRS } from '../src/accent-pairs.ts';
import { SITE_DEFAULTS } from '../src/spec.ts';

test('the default theme is the one a Spec gets without a theme line', () => {
  assert.equal(DEFAULT_THEME_NAME, SITE_DEFAULTS.theme);
  assert.ok(Object.hasOwn(THEME_NAMES, DEFAULT_THEME_NAME));
});

test("partnersOf one theme is that theme's pair table, in ramp order", () => {
  for (const [theme, table] of Object.entries(ACCENT_PAIRS)) {
    for (const [hue, partners] of Object.entries(table)) assert.deepEqual(partnersOf(hue, [theme]), partners, `${theme} ${hue}`);
  }
});

test('partnersOf every theme names the themes that refuse a partner', () => {
  // signal and volt refuse green with amber (theme-spec §13.3); the others allow it.
  assert.deepEqual(partnersOf('green'), ['teal', 'amber (not signal/volt)']);
  assert.deepEqual(partnersOf('violet'), ['blue', 'teal', 'orange', 'rose']);
});

test('colourChoicesMd lists every theme, hue, origin and shape', () => {
  for (const theme of [null, ...Object.keys(THEME_NAMES)]) {
    const md = colourChoicesMd(theme).join('\n');
    for (const [t, text] of Object.entries(THEME_NAMES)) assert.ok(md.includes(`\`${t}\` — ${text}`), `${theme}: ${t}`);
    for (const h of Object.keys(ACCENT_HUES)) assert.ok(md.includes(`  - \`${h}\` with `), `${theme}: ${h}`);
    for (const o of Object.keys(PATTERN_ORIGIN_NAMES)) assert.ok(md.includes(`\`${o}\``), `${theme}: ${o}`);
    for (const [s, text] of Object.entries(PATTERN_SHAPE_NAMES)) assert.ok(md.includes(`\`${s}\` — ${text}`), `${theme}: ${s}`);
  }
});

test('CONTROL: the choices differ by theme where the pair tables differ', () => {
  assert.notDeepEqual(colourChoicesMd('signal'), colourChoicesMd('midnight'));
  assert.ok(colourChoicesMd('signal').includes('  - `green` with teal'));
  assert.ok(colourChoicesMd('midnight').includes('  - `green` with teal, amber'));
  assert.ok(colourChoicesMd(null).includes('  - `green` with teal, amber (not signal/volt)'));
});

test('themeLinesAz writes only the settings the site has', () => {
  assert.deepEqual(themeLinesAz({ site: 'a', theme: 'clay', accent: null, pattern: null }), ['site a', '  theme clay']);
  assert.deepEqual(themeLinesAz({ site: 'a', theme: 'clay', accent: 'rose', accent2: 'amber', pattern: 'dots center' }),
    ['site a', '  theme clay', '    accent rose amber', '    pattern dots center']);
});
