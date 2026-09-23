/**
 * Every word's buttons come from the action primitive — buttons-and-sections
 * §1.1. Rendered through the real target context, from compiled source.
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
const THEME = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;

function render(lines: string[], word: string): EmittedNode {
  // Block lines are written unindented; their children at full depth.
  const src = ['az 1', 'site aurora', 'page /', ...lines.map((l) => (l.startsWith(' ') ? l : `  ${l}`)),
    'page /a', 'page /b', 'page /signup', ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = r.spec.pages[0].blocks.find((b: SpecBlock) => b.word === word)!;
  return emitBlock(block, THEME, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const actionsIn = (n: EmittedNode) => walk(n).filter((x) => x.attrs?.class?.split(' ').includes('az-action'));
const weight = (a: EmittedNode) => a.attrs?.class?.split(' ').find((c) => /^az-action--(primary|secondary|ghost|link)$/.test(c));

const SECTION = ['    cta "See the collection" /a', '    alt "Our process" /b'];

for (const [word, head] of [
  ['feature', ['feature grid', '    title "Made properly"', '    item "Hand-cut"', '    item "Sewn"']],
  ['gallery', ['gallery grid', '    title "The workshop"', '    image ./a.webp', '      alt "Bench"', '    image ./b.webp', '      alt "Welt"']],
  ['text', ['text prose', '    title "Our story"', '    body "Two people, one room."']],
  ['cta', ['cta card', '    title "Ready?"']],
  ['hero', ['hero center', '    title "Built in the dark"']],
] as const) {
  test(`${word}: its section cta and alt render as primary and secondary buttons`, () => {
    const found = actionsIn(render([...head, ...SECTION], word));
    assert.deepEqual(found.map(weight), ['az-action--primary', 'az-action--secondary'],
      `${word} must render its actions, not drop them`);
    assert.deepEqual(found.map((a) => a.attrs?.href), ['/a', '/b']);
  });
}

test('CONTROL: a section without actions renders no action row', () => {
  assert.equal(actionsIn(render(['feature grid', '    title "x"', '    item "a"', '    item "b"'], 'feature')).length, 0);
});

test('cta band: its buttons invert against the band (cta-spec §3)', () => {
  const [primary] = actionsIn(render(['cta band', '    title "Ready?"', ...SECTION], 'cta'));
  assert.equal(primary.style?.background, THEME.color['accent-contrast']);
});

test('nav: its cta is a small primary button in the bar', () => {
  const [a] = actionsIn(render(['nav bar', '    link "Work" /a', '    cta "Reserve" /b'], 'nav'));
  assert.equal(weight(a), 'az-action--primary');
  assert.equal(a.style?.fontSize, THEME.typeSize.sm);
  assert.equal(a.style?.minHeight, `${THEME.size.tap}px`, 'the tap target holds at sm');
});

test('pricing §4: only the highlighted plan has the primary button', () => {
  const out = render(['pricing cards', '    title "Pricing"', '    currency usd',
    '    plan "Studio"', '      monthly 29', '      cta "Start" /a',
    '    plan "Practice"', '      highlight on', '      monthly 79', '      cta "Start" /b'], 'pricing');
  assert.deepEqual(actionsIn(out).map(weight), ['az-action--secondary', 'az-action--primary']);
});

test('auth: the flow submits through a primary button; alternatives are text links', () => {
  const src = ['az 1', 'site aurora', '  auth', '    adapter session', 'page /login', '  auth login',
    '    alt "Create an account" /signup', 'page /signup', ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const out = emitBlock(r.spec.pages[0].blocks[0], THEME, WEB_EMITTERS, (p) => p, { name: 'aurora' });
  const found = actionsIn(out);
  const submit = found.find((a) => a.tag === 'button');
  assert.equal(submit?.attrs?.type, 'submit');
  assert.equal(weight(submit!), 'az-action--primary');
  assert.equal(weight(found.find((a) => a.tag === 'a')!), 'az-action--link');
});
