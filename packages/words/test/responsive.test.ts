/**
 * Each block spec's responsive table, one test per row that changes layout,
 * through the style contract's `below` — rendered from compiled source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, formatDiagnostics, type Manifest, type SpecBlock } from '../../core/src/index.ts';
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
  const page = r.spec.pages[0];
  const block = page.blocks.find((b: SpecBlock) => b.word === word)!;
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
