/**
 * feature items — spec §4, §6 and §7: the word renders its own items, and
 * `rows` alternates media sides on desktop and stacks media-first on phones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFor, compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
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

function feature(variant: string, items: string[]): EmittedNode {
  const src = ['az 1', 'site aurora', 'page /', '  hero center', '    title "x"',
    `  feature ${variant}`, '    title "Made properly"', ...items, 'page /a', ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b: SpecBlock) => b.word === 'feature')!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => `/${p}`, { name: 'aurora' });
}

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const text = (n: EmittedNode | string): string =>
  typeof n === 'string' ? n : (n.children ?? []).map(text).join('');
const byClass = (n: EmittedNode, c: string) => walk(n).filter((x) => x.attrs?.class?.split(' ').includes(c));

const ITEM = (title: string, extra: string[] = []) =>
  [`    item "${title}"`, '      text "Every panel is cut by hand."', ...extra];
const ROWS = [
  ...ITEM('Hand-cut leather', ['      media ./a.webp']),
  ...ITEM('Sewn, not glued', ['      media ./b.webp', '      link "How we do it" /a']),
  ...ITEM('Forty a month', ['      media ./c.webp']),
];

test('§6 rows: media beside text, alternating sides row by row', () => {
  const items = byClass(feature('rows', ROWS), 'az-feature-item');
  assert.equal(items.length, 3);
  for (const it of items) assert.equal(it.style?.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  const order = items.map((it) => byClass(it, 'az-feature-media')[0]?.style?.order);
  assert.deepEqual(order, [undefined, 1, undefined], 'every second row puts its media on the right');
});

test('§6 rows below sm: one column, media above the text, alternation dropped', () => {
  const items = byClass(feature('rows', ROWS), 'az-feature-item');
  for (const it of items) assert.equal(it.below?.sm?.gridTemplateColumns, 'minmax(0, 1fr)');
  assert.equal(byClass(items[1], 'az-feature-media')[0]?.below?.sm?.order, 0);
  assert.equal(walk(items[1]).findIndex((n) => n.tag === 'img') < walk(items[1]).findIndex((n) => n.tag === 'h3'), true,
    'media comes first in the DOM, so it sits above the text');
});

test('§7: icon and media are decorative images resolved through the sandbox, never path text', () => {
  const out = feature('rows', [...ITEM('Hand-cut leather', ['      media ./a.webp', '      icon ./i.svg']), ...ITEM('Sewn')]);
  const imgs = walk(out).filter((n) => n.tag === 'img');
  assert.deepEqual(imgs.map((i) => [i.attrs?.src, i.attrs?.alt]).sort(), [['/./a.webp', ''], ['/./i.svg', '']]);
  assert.doesNotMatch(text(out), /\.webp|\.svg/, 'a file path must never appear as page text');
});

test('§4: the item title is body type at bold weight, not the display face', () => {
  const h3 = byClass(feature('grid', [...ITEM('Hand-cut leather'), ...ITEM('Sewn')]), 'az-feature-item-title')[0];
  assert.equal(h3?.style?.fontFamily, T.type.body);
  assert.equal(h3?.style?.fontWeight, T.type['weight-bold']);
});

test('CONTROL: grid ignores media, and a lead flag never prints as text', () => {
  const grid = feature('grid', [...ITEM('A', ['      media ./a.webp']), ...ITEM('B')]);
  assert.equal(walk(grid).filter((n) => n.tag === 'img').length, 0);
  const bento = feature('bento', ['    item "Hand-cut leather" lead', '      text "Cut by hand."', ...ITEM('B'), ...ITEM('C')]);
  assert.doesNotMatch(text(bento), /\blead\b/);
  assert.equal(byClass(bento, 'az-feature-item--lead').length, 1, 'the flag still marks its item');
});
