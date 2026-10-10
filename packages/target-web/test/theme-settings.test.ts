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
import { THEMES, accentTokens, gradientCss, withAccentPair } from '../../theme/src/index.ts';
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

/* ---- theme-spec §13: an accent pair ----------------------------------- */

const paired = (settings: string) => `az 1\nsite aurora\n  theme midnight\n${settings}page /\n`
  + '  hero center\n    title "Built in the dark"\n    cta "Reserve" /reserve\n'
  + '  pricing cards\n    title "Pricing"\n    plan "Studio"\n      monthly 29\n      cta "Start" /reserve\n'
  + '    plan "Practice"\n      highlight on\n      monthly 79\n      cta "Start" /reserve\n'
  + 'page /reserve\n';

test('a pair declares accent2, its hover and on-gradient in both schemes, and the three gradient tiers', () => {
  const css = read(files(paired('    accent violet blue\n')), 'src/theme.css');
  for (const scheme of ['light', 'dark'] as const) {
    const want = withAccentPair(THEMES.midnight, 'violet', 'blue').color[scheme];
    for (const k of ['accent2', 'accent2-hover', 'on-gradient'] as const) {
      assert.ok(css.includes(`--az-color-${k}: ${want[k]};`), `${scheme} ${k}`);
    }
  }
  assert.ok(css.includes(gradientCss(true)), 'the gradient block, verbatim');
  assert.match(css, /linear-gradient\(to right in oklch, var\(--az-color-accent\), var\(--az-color-accent2\)\)/);
  assert.match(css, /linear-gradient\(to right, var\(--az-color-accent\), var\(--az-color-accent2\)\)/, 'the sRGB fallback');
});

test('a pair fills the primary action and the highlighted plan edge with the gradient — in az.css, never inline', () => {
  const fs = files(paired('    accent violet blue\n'));
  const css = read(fs, 'src/az.css');
  assert.match(css, /background-image: var\(--az-gradient-accent\);[^}]*color: var\(--az-color-on-gradient\)/);
  assert.match(css, /:hover[^{]*\{[^}]*background-image: var\(--az-gradient-accent-hover\)/);
  assert.match(css, /background: linear-gradient\(var\(--az-color-surface-alt\), var\(--az-color-surface-alt\)\) padding-box, var\(--az-gradient-accent\) border-box/);
  // The CSP stays strict: the gradient is a stylesheet rule. Markup and
  // components carry at most the var() reference a raw component reads.
  for (const f of fs.filter((x) => /\.(tsx|html)$/.test(x.path))) {
    assert.doesNotMatch(f.content, /linear-gradient|background-image|backgroundImage/, `${f.path}: a gradient must not ride inline`);
  }
  assert.match(read(fs, 'AZ.md'), /Accent: `violet blue` — a gradient pair/);
});

test('a pair with a glow pattern paints both hues; the hero still paints by reference', () => {
  const css = read(files(paired('    accent violet blue\n    pattern glow top\n')), 'src/theme.css');
  assert.match(css, /--az-pattern-image: radial-gradient\([^;]*var\(--az-color-accent\)[^;]*var\(--az-color-accent2\)/);
});

test('CONTROL: one hue declares no pair token, no gradient and paints no gradient', () => {
  const fs = files(paired('    accent violet\n    pattern glow top\n'));
  for (const p of ['src/theme.css', 'src/az.css']) {
    assert.doesNotMatch(read(fs, p), /accent2|on-gradient|--az-gradient/, p);
  }
});
