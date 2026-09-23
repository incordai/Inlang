/**
 * Colour schemes as custom properties — theme-spec §3.2 and §3.3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, schemeCss, schemeReferences, type Theme } from '../src/index.ts';

const blocks = (css: string) => ({
  base: css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')) + 1),
  media: css.slice(css.indexOf('@media'), css.indexOf(':root[data-scheme')),
  explicit: css.slice(css.indexOf(':root[data-scheme'), css.indexOf('body {')),
});

const tokenCount = (t: Theme) =>
  Object.keys(t.color.light).length + Object.keys(t.shadow.light).length;

for (const theme of Object.values(THEMES) as Theme[]) {
  const css = schemeCss(theme);
  const base = theme.defaultScheme ?? 'light';
  const other = base === 'light' ? 'dark' : 'light';

  test(`${theme.name}: every token is declared on bare :root with the ${base} value`, () => {
    const { base: root } = blocks(css);
    assert.equal((root.match(/--az-/g) ?? []).length, tokenCount(theme));
    assert.ok(root.includes(`--az-color-bg: ${theme.color[base].bg};`));
    // §3.2: no token may exist only inside a media or [data-scheme] block.
  });

  test(`${theme.name}: the ${other} scheme follows the OS unless ${base} was chosen, and wins when chosen`, () => {
    const { media, explicit } = blocks(css);
    assert.ok(media.includes(`@media (prefers-color-scheme: ${other})`));
    assert.ok(media.includes(`:root:not([data-scheme="${base}"])`));
    assert.ok(explicit.includes(`:root[data-scheme="${other}"]`));
    for (const block of [media, explicit]) {
      assert.equal((block.match(/--az-/g) ?? []).length, tokenCount(theme));
      assert.ok(block.includes(`--az-color-bg: ${theme.color[other].bg};`));
    }
  });

  test(`${theme.name}: the body paints the scheme background`, () => {
    assert.match(css, /body \{ background: var\(--az-color-bg\); color: var\(--az-color-text\); \}/);
  });
}

test('CONTROL: a dark-native theme and a light one put different schemes on :root', () => {
  assert.equal(THEMES.midnight.defaultScheme, 'dark');
  assert.equal(THEMES.paper.defaultScheme ?? 'light', 'light');
  assert.ok(blocks(schemeCss(THEMES.midnight)).base.includes(THEMES.midnight.color.dark.bg));
  assert.ok(blocks(schemeCss(THEMES.paper)).base.includes(THEMES.paper.color.light.bg));
});

test('words read references, never colours (§3.3)', () => {
  const refs = schemeReferences(THEMES.signal);
  assert.equal(refs.color.accent, 'var(--az-color-accent)');
  assert.equal(refs.shadow.md, 'var(--az-shadow-md)');
  for (const v of [...Object.values(refs.color), ...Object.values(refs.shadow)]) {
    assert.match(v, /^var\(--az-(color|shadow)-[a-z-]+\)$/);
  }
});

test('DETERMINISM: the stylesheet is identical across calls', () => {
  assert.equal(schemeCss(THEMES.midnight), schemeCss(THEMES.midnight));
});

test('the theme\'s breakpoints are exactly the contract\'s names (ARCHITECTURE §4.3)', async () => {
  const { BREAKPOINT } = await import('../src/tokens.ts');
  const { BREAKPOINT_NAMES } = await import('../../core/src/emit-contract.ts');
  assert.deepEqual(Object.keys(BREAKPOINT).sort(), [...BREAKPOINT_NAMES].sort());
});
