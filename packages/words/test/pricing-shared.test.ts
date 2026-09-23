/**
 * pricing-spec §6 ("in every plan") and §7.3 (the highlighted plan's edge).
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

function pricing(variant: string, plans: string[]): EmittedNode {
  const src = ['az 1', 'site aurora', 'page /', `  pricing ${variant}`, '    title "Simple pricing"',
    '    currency usd', ...plans, 'page /a', 'page /b', ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b: SpecBlock) => b.word === 'pricing')!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const text = (n: EmittedNode | string): string =>
  typeof n === 'string' ? n : (n.children ?? []).map(text).join('');
const byClass = (n: EmittedNode, c: string) => walk(n).filter((x) => x.attrs?.class?.split(' ').includes(c));

const PLAN = (name: string, projects: string, cta: string, ...extra: string[]) => [
  `    plan "${name}"`, '      monthly 29', `      feature "Projects" "${projects}"`,
  '      feature "Custom domain" "yes"', ...extra, `      cta "Start" ${cta}`,
];
const TWO = [...PLAN('Studio', '10', '/a'), ...PLAN('Practice', 'Unlimited', '/b', '      highlight on')];

test('§6 table: a row every plan shares is listed once, in an "in every plan" list', () => {
  const out = pricing('table', TWO);
  const shared = byClass(out, 'az-pricing-shared');
  assert.equal(shared.length, 1);
  assert.match(text(shared[0]), /In every plan/);
  assert.match(text(shared[0]), /Custom domain — yes/);
});

test('§6 table: the shared row leaves every plan cell and every phone panel', () => {
  const out = pricing('table', TWO);
  const inPlans = [...byClass(out, 'az-plan-features'), ...byClass(out, 'az-plan-rows')];
  assert.ok(inPlans.length >= 4, 'CONTROL: desktop cells and phone panels were both found');
  for (const list of inPlans) assert.doesNotMatch(text(list), /Custom domain/);
});

test('CONTROL: a row whose value differs between plans stays in each plan', () => {
  const out = pricing('table', TWO);
  assert.doesNotMatch(text(byClass(out, 'az-pricing-shared')[0]), /Projects/);
  assert.match(text(byClass(out, 'az-plan-rows')[0]), /Projects/);
});

test('CONTROL: `cards` keeps every card whole — no shared list', () => {
  assert.equal(byClass(pricing('cards', TWO), 'az-pricing-shared').length, 0);
});

test('§7.3: the highlighted plan edge is color.accent at the emphasis weight', () => {
  const cards = byClass(pricing('cards', TWO), 'az-plan');
  const highlight = cards.find((c) => c.attrs?.class?.includes('az-plan--highlight'));
  const plain = cards.find((c) => !c.attrs?.class?.includes('az-plan--highlight'));
  assert.equal(highlight?.style?.border, `${T.size['edge-emphasis']}px solid ${T.color.accent}`);
  assert.equal(plain?.style?.border, `1px solid ${T.color.border}`, 'CONTROL: the others keep the hairline');
});
