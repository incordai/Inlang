/**
 * The escape hatch at the link stage — PRD §6.6, GRAMMAR §3.3.
 *
 * `raw <path>` belongs in a page body or directly in a block; `slot <name>
 * <path>` directly in a block, naming one of its slots or an injection point
 * (`before` / `after`). The path is sandboxed and must be a component module.
 * Before this, all of it compiled silently: an undeclared slot, a path out of
 * the project, a stylesheet as a component.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const HERO = '  hero center\n    title "x"\n';
const codes = (src: string) => compile(src, { manifests }).diagnostics
  .filter((d) => d.severity === 'error').map((d) => d.code);
const page = (body: string) => `az 1\nsite aurora\npage /\n${body}`;

test('CONTROL: raw in a page, raw in a block, and slots by manifest name or injection point compile', () => {
  assert.deepEqual(codes(page(`${HERO}  raw ./custom/Badge.tsx\n`)), []);
  assert.deepEqual(codes(page(`${HERO}    raw ./custom/Inside.jsx\n`)), []);
  assert.deepEqual(codes(page(`${HERO}    slot after ./custom/Ticker.tsx\n    slot before ./a.ts\n    slot cta ./b.js\n`)), []);
});

test('AZ1217: raw outside a page or block, slot outside a block', () => {
  assert.deepEqual(codes('az 1\nsite aurora\n  raw ./x.tsx\npage /\n'), ['AZ1217']);
  assert.deepEqual(codes('az 1\nsite aurora\nraw ./x.tsx\npage /\n'), ['AZ1217']);
  assert.deepEqual(codes(page('  slot after ./x.tsx\n')), ['AZ1217']);
  // A slot fill is not a block: `item` inside feature cannot host one.
  assert.ok(codes(page('  feature grid\n    item "a"\n      slot after ./x.tsx\n    item "b"\n')).includes('AZ1217'));
});

test('AZ1218: a slot name the block does not have, with the ones it does', () => {
  const r = compile(page(`${HERO}    slot sidebar ./x.tsx\n`), { manifests });
  const d = r.diagnostics.find((x) => x.code === 'AZ1218');
  assert.ok(d, 'the unknown slot is reported');
  assert.match(d.message, /'sidebar' is not a slot of hero — try: before, after, cta, alt/);
});

test('AZ1219: the statement must be exactly a path (and a name, for slot)', () => {
  assert.deepEqual(codes(page('  raw\n')), ['AZ1219']);
  assert.deepEqual(codes(page('  raw ./a.tsx ./b.tsx\n')), ['AZ1219']);
  assert.deepEqual(codes(page('  raw "Badge.tsx"\n')), ['AZ1219']);
  assert.deepEqual(codes(page(`${HERO}    slot ./x.tsx\n`)), ['AZ1219']);
});

test('SECURITY: the path is sandboxed (AZ1210) and must be a component module (AZ1410)', () => {
  assert.ok(codes(page('  raw ../../outside/x.tsx\n')).includes('AZ1210'));
  assert.deepEqual(codes(page('  raw ./styles/site.css\n')), ['AZ1410']);
  assert.deepEqual(codes(page(`${HERO}    slot after ./notes.md\n`)), ['AZ1410']);
});

test('the Spec keeps each statement where it was written', () => {
  const r = compile(page(`${HERO}    slot after ./custom/Ticker.tsx\n  raw ./custom/Badge.tsx\n`), { manifests });
  assert.ok(r.spec);
  const [hero, raw] = r.spec.pages[0].blocks;
  assert.equal(raw.word, 'raw');
  assert.deepEqual(raw.args.map((a) => a.value), ['./custom/Badge.tsx']);
  const slot = hero.children.find((c) => c.word === 'slot');
  assert.deepEqual(slot?.args.map((a) => a.value), ['after', './custom/Ticker.tsx']);
});
