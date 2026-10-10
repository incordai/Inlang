/**
 * Structure keywords are described, and explain() resolves terms in context.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { DESCRIPTION_MAX, STRUCTURE_DESCRIPTIONS, explain, type Manifest } from '../src/index.ts';
import { STRUCTURE, STRUCTURE_PROPS } from '../src/link.ts';
import { BACKEND_SETTINGS } from '../src/backend.ts';
import { ACCENT_PAIRS } from '../src/accent-pairs.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(f)) continue;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const within = (text: string) => text.length > 0 && text.length <= DESCRIPTION_MAX && !text.endsWith('.');

test('every structure keyword and every setting it takes is described', () => {
  for (const k of [...STRUCTURE, 'az']) {
    assert.ok(Object.hasOwn(STRUCTURE_DESCRIPTIONS, k), `keyword '${k}' has no description`);
    assert.ok(within(STRUCTURE_DESCRIPTIONS[k].description), k);
  }
  for (const [k, settings] of Object.entries(STRUCTURE_PROPS)) {
    for (const s of settings) assert.ok(STRUCTURE_DESCRIPTIONS[k].settings?.[s], `${k} ${s} has no description`);
  }
  for (const [s, values] of Object.entries(BACKEND_SETTINGS)) {
    for (const v of values) assert.ok(within(STRUCTURE_DESCRIPTIONS.backend.values?.[s]?.[v] ?? ''), `backend ${s} ${v}`);
  }
  for (const info of Object.values(STRUCTURE_DESCRIPTIONS)) {
    for (const t of Object.values(info.settings ?? {})) assert.ok(within(t), t);
  }
});

test('explain: word, variant, prop, value, slot and slot prop in context', () => {
  const r = explain(['pricing', 'cards', 'billing', 'annual', 'plan', 'highlight', 'on'], manifests);
  assert.deepEqual(r.lines.map((l) => `${l.of}|${l.term}|${l.kind}`), [
    '|pricing|word', 'pricing|cards|variant', 'pricing|billing|prop', 'pricing.billing|annual|value',
    'pricing|plan|slot', 'pricing.plan|highlight|prop', 'pricing.plan.highlight|on|value',
  ]);
  assert.deepEqual(r.unknown, []);
});

test('explain: site description and icon, and page description, are settings (GRAMMAR §4.4)', () => {
  const r = explain(['site', 'description', 'icon', 'page', 'description'], manifests);
  assert.deepEqual(r.lines.map((l) => `${l.of}|${l.term}|${l.kind}`), [
    '|site|keyword', 'site|description|setting', 'site|icon|setting', '|page|keyword', 'page|description|setting',
  ]);
  assert.deepEqual(r.unknown, []);
});

test('explain: a word name starts a new context', () => {
  const r = explain(['hero', 'split', 'nav', 'sticky'], manifests);
  assert.deepEqual(r.lines.map((l) => l.kind), ['word', 'variant', 'word', 'modifier']);
});

test('explain: an unknown term suggests only a plausible typo', () => {
  assert.deepEqual(explain(['galery'], manifests).unknown, [{ term: 'galery', suggestion: 'gallery' }]);
  assert.deepEqual(explain(['zzzzzzzz'], manifests).unknown, [{ term: 'zzzzzzzz', suggestion: null }]);
});

test('explain theme lists every theme, each within the limit; a theme after it is one line', () => {
  const listed = explain(['theme'], manifests).lines.filter((l) => l.kind === 'theme');
  assert.deepEqual(listed.map((l) => l.term), ['midnight', 'paper', 'signal', 'clay', 'petal', 'volt']);
  for (const l of listed) assert.ok(within(l.text), `${l.term}: '${l.text}' (${l.text.length} chars)`);
  const one = explain(['theme', 'volt'], manifests);
  assert.deepEqual(one.lines.map((l) => [l.term, l.kind]), [['theme', 'keyword'], ['volt', 'theme']]);
  assert.deepEqual(one.unknown, []);
  // Asked about a setting, the keyword does not list the themes first.
  assert.equal(explain(['theme', 'accent'], manifests).lines.some((l) => l.kind === 'theme'), false);
});

test('CONTROL: an inherited object key is not a term', () => {
  assert.deepEqual(explain(['constructor'], manifests).lines, []);
});

test('explain theme accent lists every hue with its pair partners (theme-spec §13), each line within the limit', () => {
  const r = explain(['theme', 'accent'], manifests);
  const pairs = r.lines.filter((l) => l.kind === 'pairs');
  assert.deepEqual(pairs.map((l) => l.term), Object.keys(ACCENT_PAIRS.midnight));
  for (const l of pairs) {
    assert.equal(l.of, 'theme.accent');
    assert.ok(within(l.text), `${l.term}: '${l.text}' (${l.text.length} chars)`);
  }
  // Every theme allows violet with blue; signal and volt refuse green with amber.
  assert.match(pairs.find((l) => l.term === 'violet')!.text, /^Pairs with blue, teal, orange, rose$/);
  assert.match(pairs.find((l) => l.term === 'green')!.text, /amber \(not signal\/volt\)/);
  // The hue after `accent` is still a value, and lists nothing more.
  const v = explain(['theme', 'accent', 'violet'], manifests).lines.at(-1);
  assert.deepEqual([v?.kind, v?.term], ['value', 'violet']);
});
