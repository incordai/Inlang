/**
 * faq-spec §3 and §6: rows are divided by a hairline, and below 768px their
 * padding grows rather than shrinks — the row is the tap target.
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

function faq(variant: string): EmittedNode {
  const items = ['Do you ship abroad?', 'Can I return a pair?', 'Are they handmade?']
    .flatMap((q) => [`    item "${q}"`, '      text "Yes, within thirty days."']);
  const src = ['az 1', 'site aurora', 'page /', '  hero center', '    title "x"',
    `  faq ${variant}`, '    title "Questions"', ...items, ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b: SpecBlock) => b.word === 'faq')!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const rows = (n: EmittedNode) => walk(n).filter((x) => x.attrs?.class?.split(' ').includes('az-faq-item'));

for (const variant of ['list', 'columns']) {
  test(`§6 ${variant}: below sm each row's padding grows from space.16 to space.24`, () => {
    const all = rows(faq(variant));
    assert.equal(all.length, 3, 'CONTROL: every item is a row');
    for (const r of all) {
      assert.equal(r.style?.paddingBlock, `${T.space[16]}px`);
      assert.equal(r.below?.sm?.paddingBlock, `${T.space[24]}px`);
      assert.ok(T.space[24] > T.space[16], 'grows, never shrinks');
    }
  });
}

test('§3: rows are divided by a hairline, not boxed', () => {
  for (const r of rows(faq('list'))) {
    assert.equal(r.style?.borderBottom, `1px solid ${T.color.border}`);
    assert.equal(r.style?.borderRadius, undefined, 'dividers, not cards');
  }
});
