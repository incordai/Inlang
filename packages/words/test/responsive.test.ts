/**
 * Each block spec's responsive table, one test per row that changes layout,
 * through the style contract's `below` — rendered from compiled source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFor, compile, formatDiagnostics, type Manifest, type SpecBlock } from '../../core/src/index.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import { WEB_EMITTERS } from '../registry.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const w of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}
const T = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;

/** Block lines unindented, children at full depth; extra pages for links. */
export function render(lines: string[], word: string, site: string[] = []): EmittedNode {
  const src = ['az 1', 'site aurora', ...site, 'page /', ...lines.map((l) => (l.startsWith(' ') ? l : `  ${l}`)),
    'page /a', 'page /b', 'page /signup', 'page /account', 'page /legal', ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  // Through blocksFor, so a site-level footer is found where it renders.
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b: SpecBlock) => b.word === word)!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
export const byClass = (n: EmittedNode, c: string) => walk(n).find((x) => x.attrs?.class?.split(' ').includes(c));
const ONE = 'minmax(0, 1fr)';
const tracks = (n: number) => `repeat(${n}, minmax(0, 1fr))`;
const GUTTER = `${T.size['gutter-sm']}px`;

/* ---- cta §6 ------------------------------------------------------------- */

const CTA = (variant: string, ...extra: string[]) =>
  render([`cta ${variant}`, '    title "Ready when you are"', '    cta "Reserve a pair" /a', '    alt "Ask a question" /b', ...extra], 'cta');

test('cta §6 band: below sm the padding drops a step, the buttons stack, the primary fills the row', () => {
  const out = CTA('band');
  assert.equal(out.below?.sm?.paddingBlock, `${T.space[64]}px`);
  assert.equal(out.style?.paddingBlock, `${T.space[96]}px`, 'CONTROL: the desktop padding');
  assert.deepEqual(byClass(out, 'az-cta-actions')?.below?.sm, { flexDirection: 'column', alignItems: 'stretch' });
  assert.deepEqual(byClass(out, 'az-action--primary')?.below?.sm, { width: '100%' });
});

test('cta §6 card: the inset drops to the mobile gutter', () => {
  assert.equal(CTA('card').below?.sm?.marginInline, GUTTER);
  assert.equal(CTA('card').style?.marginInline, `${T.size['gutter-lg']}px`, 'CONTROL: the desktop inset');
});

test('cta §6 split: restacks, and decorative media is dropped, informative kept', () => {
  const plain = CTA('split', '    media ./m.webp');
  assert.equal(plain.below?.sm?.gridTemplateColumns, ONE);
  assert.deepEqual(byClass(plain, 'az-cta-media')?.below?.sm, { display: 'none' });
  const described = CTA('split', '    media ./m.webp', '    describe "The bench, day one"');
  assert.equal(byClass(described, 'az-cta-media')?.below, undefined, 'informative media stays, below the text');
});

/* ---- faq §6 ------------------------------------------------------------- */

const FAQ = (variant: string) => render([`faq ${variant}`, '    title "Questions"',
  '    item "Do you ship?"', '      text "Yes."', '    item "Returns?"', '      text "30 days."',
  '    item "Handmade?"', '      text "Every pair."'], 'faq');

test('faq §6 columns: one column below sm, in declared order', () => {
  const items = byClass(FAQ('columns'), 'az-faq-items');
  assert.equal(items?.style?.gridTemplateColumns, tracks(2), 'CONTROL: two columns on a desktop');
  assert.equal(items?.below?.sm?.gridTemplateColumns, ONE);
  assert.equal(byClass(FAQ('list'), 'az-faq-items')?.below, undefined, 'CONTROL: list is unchanged');
});

/* ---- text §7 ------------------------------------------------------------ */

test('text §7 columns: collapses at md, not sm', () => {
  const body = byClass(render(['text columns', '    title "Our story"', '    body "Two people."'], 'text'), 'az-text-body');
  assert.deepEqual(body?.below, { md: { columnCount: 1 } });
  const prose = byClass(render(['text prose', '    title "Our story"', '    body "Two people."'], 'text'), 'az-text-body');
  assert.equal(prose?.below, undefined, 'CONTROL: prose is unchanged');
});

/* ---- feature §6 --------------------------------------------------------- */

const FEATURE = (variant: string, items: string[], columns = '3') =>
  render([`feature ${variant}`, '    title "Made properly"', ...(variant === 'grid' ? [`    columns ${columns}`] : []), ...items], 'feature');
const PROSE_ITEMS = ['    item "Hand-cut leather"', '      text "Cut by hand."', '    item "Sewn welt"', '      text "Replaceable sole."',
  '    item "Forty a month"', '      text "Two people."'];
const SPEC_ITEMS = ['    item "Waterproof"', '      icon drop', '    item "Resoleable"', '      icon tool', '    item "Two year warranty"', '      icon shield'];

test('feature §6 grid: one column below sm, and at most two below md', () => {
  const items = byClass(FEATURE('grid', PROSE_ITEMS), 'az-feature-items');
  assert.equal(items?.style?.gridTemplateColumns, tracks(3), 'CONTROL: three on a desktop');
  assert.equal(items?.below?.md?.gridTemplateColumns, tracks(2));
  assert.equal(items?.below?.sm?.gridTemplateColumns, tracks(1));
});

test('feature §6 grid: icon + short label with no text is a two-column spec sheet on a phone', () => {
  assert.equal(byClass(FEATURE('grid', SPEC_ITEMS), 'az-feature-items')?.below?.sm?.gridTemplateColumns, tracks(2));
});

test('feature §6 bento: a single column below sm', () => {
  assert.equal(byClass(FEATURE('bento', PROSE_ITEMS), 'az-feature-items')?.below?.sm?.gridTemplateColumns, tracks(1));
});

/* ---- theme-spec §1: the mobile gutter ----------------------------------- */

test('theme-spec §1: sections take gutter-sm below sm', () => {
  assert.equal(CTA('band').below?.sm?.paddingInline, GUTTER);
  assert.equal(FAQ('list').below?.sm?.paddingInline, GUTTER);
  assert.equal(render(['text prose', '    title "x"', '    body "y"'], 'text').below?.sm?.paddingInline, GUTTER);
  assert.equal(FEATURE('grid', PROSE_ITEMS).below?.sm?.paddingInline, GUTTER);
  assert.equal(FEATURE('grid', PROSE_ITEMS).style?.paddingInline, `${T.size['gutter-lg']}px`, 'CONTROL: gutter-lg on a desktop');
});

/* ---- gallery §6 --------------------------------------------------------- */

const IMAGES = ['    image ./a.webp', '      alt "Bench"', '    image ./b.webp', '      alt "Welt"',
  '    image ./c.webp', '      alt "Lasts"', '    image ./d.webp', '      alt "Hide"'];
const GALLERY = (variant: string, ...extra: string[]) =>
  render([`gallery ${variant}`, '    title "The workshop"', ...extra, ...IMAGES], 'gallery');

test('gallery §6 grid and masonry: two columns below sm (not one), at most three below md', () => {
  const grid = byClass(GALLERY('grid', '    columns 4'), 'az-gallery-items');
  assert.equal(grid?.style?.gridTemplateColumns, tracks(4), 'CONTROL: four on a desktop');
  assert.equal(grid?.below?.md?.gridTemplateColumns, tracks(3));
  assert.equal(grid?.below?.sm?.gridTemplateColumns, tracks(2));
  assert.equal(byClass(GALLERY('masonry'), 'az-gallery-items')?.below?.sm?.gridTemplateColumns, tracks(2));
});

test('gallery §6 orbit: falls back to a carousel below sm, and the ring poster goes', () => {
  const out = GALLERY('orbit', '    poster ./ring.webp');
  assert.deepEqual(byClass(out, 'az-gallery-items')?.below?.sm, { display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory' });
  assert.deepEqual(byClass(out, 'az-gallery-poster')?.below?.sm, { display: 'none' });
  assert.equal(byClass(out, 'az-gallery-item')?.below?.sm?.scrollSnapAlign, 'start');
});

test('gallery §6 carousel: keeps its row, slides peek space.24 of the next', () => {
  const out = GALLERY('carousel');
  assert.equal(byClass(out, 'az-gallery-items')?.below?.sm, undefined, 'the row itself is unchanged');
  assert.equal(byClass(out, 'az-gallery-item')?.below?.sm?.flex, `0 0 calc(100% - ${T.space[24]}px)`);
});

/* ---- footer §8 ---------------------------------------------------------- */

const FOOTER = (variant: string, ...groups: string[]) => render([], 'footer',
  [`  footer ${variant}`, ...groups, '    legal "Privacy" /legal', '    copyright "Aurora Studio"']);
const GROUPS = ['    group "Shop"', '      link "Shoes" /a', '      link "Bags" /b', '    group "Studio"', '      link "About" /a',
  '      link "Journal" /b', '    group "Help"', '      link "Returns" /a', '    group "Trade"', '      link "Wholesale" /b'];

test('footer §8 columns and mega: one column below sm, never two-across', () => {
  assert.deepEqual(byClass(FOOTER('columns', ...GROUPS), 'az-footer-columns')?.below?.sm, { flexDirection: 'column' });
  assert.deepEqual(byClass(FOOTER('mega', ...GROUPS), 'az-footer-columns')?.below?.sm, { gridTemplateColumns: ONE });
});

test('footer §8 minimal: the bottom row stacks centred', () => {
  assert.deepEqual(byClass(FOOTER('minimal'), 'az-footer-bottom')?.below?.sm,
    { flexDirection: 'column', alignItems: 'center', textAlign: 'center' });
  assert.equal(byClass(FOOTER('columns', ...GROUPS), 'az-footer-bottom')?.below, undefined, 'CONTROL: only minimal centres');
});

/* ---- scene §10 ---------------------------------------------------------- */

const SCENE = (variant: string, ratio: string) => render(['hero center', '    title "x"', `scene ${variant} 3d`,
  '    poster ./p.webp', '    alt "A shoe"', `    ratio ${ratio}`], 'scene');

test('scene §10 inline: full content width below sm', () => {
  const fig = byClass(SCENE('inline', '4:3'), 'az-scene-viewport');
  assert.equal(fig?.style?.maxWidth, `${T.size['measure-body']}ch`, 'CONTROL: the measure on a desktop');
  assert.deepEqual(fig?.below?.sm, { maxWidth: 'none' });
});

test('scene §10 full: ratio clamped to at most 4:3 — 1:1 becomes 4:3, wider ratios stay', () => {
  assert.deepEqual(byClass(SCENE('full', '1:1'), 'az-scene-viewport')?.below?.sm, { aspectRatio: '4 / 3' });
  assert.equal(byClass(SCENE('full', '16:9'), 'az-scene-viewport')?.below, undefined);
});

/* ---- auth §8 ------------------------------------------------------------ */

test('auth §8: a full-width card inside the gutter, with a full-width submit', () => {
  const out = render(['auth login', '    title "Welcome back"'], 'auth', ['  auth', '    adapter session']);
  assert.deepEqual(byClass(out, 'az-auth-form')?.below?.sm, { maxWidth: 'none' });
  assert.deepEqual(byClass(out, 'az-action--primary')?.below?.sm, { width: '100%' });
  assert.equal(out.below?.sm?.paddingInline, GUTTER);
});

test('theme-spec §1: gallery, footer and scene take gutter-sm below sm', () => {
  assert.equal(GALLERY('grid').below?.sm?.paddingInline, GUTTER);
  assert.equal(FOOTER('columns', ...GROUPS).below?.sm?.paddingInline, GUTTER);
  assert.equal(SCENE('inline', '4:3').below?.sm?.paddingInline, GUTTER);
});
