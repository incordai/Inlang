/**
 * `reveal` markup — feature-spec §9, the engine faq, cta, gallery, feature,
 * text and pricing share. Words only MARK: the block carries the rise
 * distance, staggered items their marker, and the elements that animate a
 * token transition that reduced motion removes. Nothing is hidden here — the
 * runtime hides by script, so the emitted page reads with JS off.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../../target-web/src/emit.ts';
import { WEB_EMITTERS } from '../registry.ts';

const wordsDir = new URL('../', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

function app(src: string): string {
  const r = compile(src, { manifests });
  assert.ok(r.spec, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  return emit(r.spec, { emitters: WEB_EMITTERS }).find((f) => f.path === 'src/App.tsx')!.content;
}

const HERO = '  hero center\n    title "Built in the dark"\n';
const site = (block: string, extra = '') => `az 1\nsite a\npage /\n${HERO}${block}${extra}`;
const items = (word: string, n: number) =>
  Array.from({ length: n }, (_, i) => `    ${word} "Point ${i + 1}"\n      text "Detail ${i + 1}."\n`).join('');

const BLOCKS: [string, string, boolean][] = [
  ['feature grid reveal', site(`  feature grid reveal\n    title "Why"\n${items('item', 3)}`), true],
  ['gallery grid reveal', site(`  gallery grid reveal\n    title "Work"\n${Array.from({ length: 3 }, (_, i) => `    image ./p${i}.webp\n      alt "Photo ${i}"\n`).join('')}`), true],
  ['pricing cards reveal', site(`  pricing cards reveal\n    title "Plans"\n    currency usd\n    plan "Studio"\n      monthly 29\n      cta "Choose" /\n    plan "Practice"\n      monthly 79\n      cta "Choose" /\n`), true],
  ['faq list reveal', site(`  faq list reveal\n    title "Questions"\n${items('item', 3).replace(/Point (\d)/g, 'Question $1?')}`), false],
  ['cta card reveal', site('  cta card reveal\n    title "Reserve"\n    cta "Go" /\n'), false],
  ['text centered reveal', site('  text centered reveal\n    title "Studio"\n    body "Two people, one room."\n'), false],
];

for (const [name, src, staggers] of BLOCKS) {
  test(`${name}: marked for the runtime, never hidden in the markup`, () => {
    const out = app(src);
    assert.match(out, /"data-az-reveal": "8"/, 'the block carries the rise distance (space.8)');
    if (staggers) assert.match(out, /"data-az-reveal-item": ""/, 'items stagger');
    assert.doesNotMatch(out, /"opacity": "?0"?[,}]/, 'nothing is hidden by the emitted page');
  });
}

test('CONTROL: without reveal there are no markers', () => {
  const out = app(site(`  feature grid\n    title "Why"\n${items('item', 3)}`));
  assert.doesNotMatch(out, /data-az-reveal/);
});

test('the animated elements get a transition that reduced motion removes', () => {
  const r = compile(BLOCKS[0][1], { manifests });
  assert.ok(r.spec);
  const css = emit(r.spec, { emitters: WEB_EMITTERS }).find((f) => f.path === 'src/az.css')!.content;
  assert.match(css, /transition: opacity 240ms cubic-bezier\(0\.16, 1, 0\.3, 1\), transform 240ms/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /transition: none/);
});
