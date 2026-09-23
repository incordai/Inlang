/**
 * `glass` — nav-spec §3, cta-spec §5, footer-spec §7, auth-spec §8, hero.
 *
 * The base style is the solid fallback; `translucent` makes the surface the
 * veil, blurred, only where the browser blurs (`@supports backdrop-filter`)
 * and the visitor has not asked for reduced transparency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../src/emit.ts';
import { compileStyles } from '../src/stylesheet.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';
import { THEMES } from '../../theme/src/index.ts';
import type { EmittedNode } from '../../core/src/emit-contract.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const BREAKPOINTS = { xs: 480, sm: 768, md: 1024, lg: 1440 };
const BACKDROP = '  scene backdrop 3d\n    poster ./fog.webp\n    alt "Slow fog"\n';

function css(src: string): string {
  const r = compile(src, { manifests });
  assert.ok(r.spec, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  return emit(r.spec, { emitters: WEB_EMITTERS }).find((f) => f.path === 'src/az.css')!.content;
}

/** The glass block of a stylesheet: everything inside the @supports rule. */
const glassBlock = (sheet: string) => {
  const at = sheet.indexOf('@supports (backdrop-filter: blur(1px))');
  return at < 0 ? '' : sheet.slice(at);
};

test('the compiler puts translucent styles behind @supports and reduced-transparency', () => {
  const node: EmittedNode = {
    tag: 'div', style: { background: 'var(--az-color-surface)' },
    translucent: { style: { background: 'var(--az-color-veil)', backdropFilter: 'blur(16px)' } },
  };
  const { css: sheet } = compileStyles([node], (n, rw) => n.map(rw), BREAKPOINTS);
  const glass = glassBlock(sheet);
  assert.match(glass, /@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)/);
  assert.match(glass, /@media not \(prefers-reduced-transparency: reduce\)/);
  assert.match(glass, /backdrop-filter: blur\(16px\)/);
  // The solid fallback is the base rule, outside the guarded block.
  assert.match(sheet.slice(0, sheet.indexOf('@supports')), /background: var\(--az-color-surface\)/);
});

test('a translucent state uses that state\'s selector inside the guard', () => {
  const node: EmittedNode = {
    tag: 'nav', style: { background: 'transparent' },
    states: { scrolled: { background: 'var(--az-color-bg)' } },
    translucent: { states: { scrolled: { background: 'var(--az-color-veil)' } } },
  };
  const { css: sheet } = compileStyles([node], (n, rw) => n.map(rw), BREAKPOINTS);
  assert.match(glassBlock(sheet), /\[data-scrolled="true"\] \{ background: var\(--az-color-veil\); \}/);
});

test('CONTROL: no glass, no @supports block', () => {
  const sheet = css('az 1\nsite a\n  nav bar sticky\n    link "Work" /work\npage /\n  hero center\n    title "T"\npage /work\n');
  assert.equal(glassBlock(sheet), '');
});

const WORDS: [string, string][] = [
  ['nav bar sticky glass', 'az 1\nsite a\n  nav bar sticky glass\n    link "Work" /work\npage /\n  hero center\n    title "T"\npage /work\n'],
  ['nav solid glass (scrolled)', 'az 1\nsite a\n  nav bar sticky solid glass\n    link "Work" /work\npage /\n  hero full\n    title "T"\npage /work\n'],
  ['hero center glass (over a backdrop)', `az 1\nsite a\n${BACKDROP}page /\n  hero center glass\n    title "T"\n`],
  ['cta card glass', `az 1\nsite a\n${BACKDROP}page /\n  hero center\n    title "T"\n  cta card glass\n    title "R"\n    cta "Go" /\n`],
  ['footer glass', `az 1\nsite a\n${BACKDROP}page /\n  hero center\n    title "T"\n  footer minimal glass\n`],
  ['auth login glass', 'az 1\nsite a\n  auth\n    adapter session\npage /login\n  auth login glass\n'],
];

for (const [name, src] of WORDS) {
  test(`${name}: renders the blurred veil where blur is supported`, () => {
    const glass = glassBlock(css(src));
    assert.match(glass, /background: var\(--az-color-veil\)/, 'the veil, not a new colour');
    assert.match(glass, /backdrop-filter: blur\(16px\)/, 'midnight blurs 16px');
    assert.match(glass, /-webkit-backdrop-filter: blur\(16px\)/);
  });
}

test('nav solid glass is clear at the top: glass only in the scrolled state', () => {
  const glass = glassBlock(css(WORDS[1][1]));
  assert.match(glass, /\[data-scrolled="true"\]/);
});

test('glass does nothing where the spec says it cannot: cta band, hero full', () => {
  assert.equal(glassBlock(css(`az 1\nsite a\n${BACKDROP}page /\n  hero center\n    title "T"\n  cta band glass\n    title "R"\n    cta "Go" /\n`)), '');
  assert.equal(glassBlock(css(`az 1\nsite a\npage /\n  hero full glass\n    title "T"\n`)), '');
});

test('signal draws glass unblurred — its zero-blur rule (theme-spec §5.3)', () => {
  assert.equal(THEMES.signal.size['glass-blur'], 0);
  assert.ok(THEMES.midnight.size['glass-blur'] > 0 && THEMES.paper.size['glass-blur'] > 0);
});
