/**
 * `theme accent` and `theme pattern` in the web target — PRD §6.1a.
 *
 * The accent regenerates the accent tokens in theme.css for both schemes;
 * the pattern is declared once as custom properties (ink = the accent token)
 * and painted on the hero. Neither reached the output before: both only
 * landed in unstyled data attributes on the site wrapper.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../src/emit.ts';
import { THEMES, accentTokens } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const hero = (variant: string) => `page /\n  hero ${variant}\n    title "Built in the dark"\n    sub "Handmade."\n`;
const site = (settings = '', variant = 'center') =>
  `az 1\nsite aurora\n  theme paper\n${settings}${hero(variant)}`;
const files = (src: string) => {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, JSON.stringify(r.diagnostics));
  return emit(r.spec, { emitters: WEB_EMITTERS });
};
const read = (fs: { path: string; content: string }[], p: string) => fs.find((f) => f.path === p)?.content ?? '';

test('accent teal writes its contrast-checked tokens into theme.css, both schemes', () => {
  const css = read(files(site('    accent teal\n')), 'src/theme.css');
  for (const scheme of ['light', 'dark'] as const) {
    const want = accentTokens('teal', THEMES.paper, scheme);
    assert.ok(css.includes(`--az-color-accent: ${want.accent};`), `${scheme} accent`);
    assert.ok(css.includes(`--az-color-accent-hover: ${want['accent-hover']};`), `${scheme} hover`);
    assert.ok(css.includes(`--az-color-accent-contrast: ${want['accent-contrast']};`), `${scheme} label`);
  }
});

test("CONTROL: without accent, theme.css carries the theme's own accent", () => {
  const css = read(files(site()), 'src/theme.css');
  assert.ok(css.includes(`--az-color-accent: ${THEMES.paper.color.light.accent};`));
});

test('a pattern is declared from the accent token and painted on the hero', () => {
  const fs = files(site('    pattern glow left\n'));
  const css = read(fs, 'src/theme.css');
  assert.match(css, /--az-pattern-image: radial-gradient\([^;]*at 8% 50%[^;]*var\(--az-color-accent\)/);
  assert.match(read(fs, 'src/az.css'), /background-image: var\(--az-pattern-image\)/);
  assert.match(read(fs, 'AZ.md'), /Pattern: `glow left`/);
});

test('a full hero keeps its scrim — no pattern painted under it', () => {
  const css = read(files(site('    pattern dots\n', 'full')), 'src/az.css');
  assert.doesNotMatch(css, /var\(--az-pattern-image\)/);
});

test('CONTROL: a site without a pattern declares and paints none', () => {
  const fs = files(site());
  assert.doesNotMatch(read(fs, 'src/theme.css'), /--az-pattern-/);
  assert.doesNotMatch(read(fs, 'src/az.css'), /--az-pattern-/);
});

test('the dead data attributes are gone from the site wrapper', () => {
  const app = read(files(site('    accent rose\n    pattern grid\n')), 'src/App.tsx');
  const runtime = read(files(site()), 'src/runtime.tsx');
  assert.doesNotMatch(app, /accent=|pattern=/);
  assert.doesNotMatch(runtime, /data-accent|data-pattern/);
});

test('DETERMINISM: one source, identical bytes', () => {
  const a = files(site('    accent amber\n    pattern hatch\n')).map((f) => f.path + f.content).join('\n');
  const b = files(site('    accent amber\n    pattern hatch\n')).map((f) => f.path + f.content).join('\n');
  assert.equal(a, b);
});
