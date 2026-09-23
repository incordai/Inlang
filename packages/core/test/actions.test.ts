/**
 * Actions, the target-agnostic half — buttons-and-sections-spec §1.2–1.3,
 * GRAMMAR §4.3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, intentOf, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

test('GRAMMAR §4.3: intent is read from the destination', () => {
  const cases: [string, string, string | null][] = [
    ['route', '/reserve', 'go'], ['anchor', '#pricing', 'show'], ['path', './deck.pdf', 'download'],
    ['pair', 'tel:+50412345678', 'call'], ['pair', 'mailto:a@b.c', 'mail'], ['pair', 'video:intro', 'play'],
    ['pair', 'popup:news', 'play'], ['pair', 'copy:hello', 'copy'], ['pair', 'https://example.org', 'external'],
    ['pair', 'http://example.org', 'external'],
  ];
  for (const [kind, value, intent] of cases) assert.equal(intentOf({ kind, value }), intent, value);
});

test('CONTROL: something that is not a destination has no intent', () => {
  assert.equal(intentOf({ kind: 'string', value: 'Reserve' }), null);
  assert.equal(intentOf({ kind: 'pair', value: 'ftp:x' }), null);
  assert.equal(intentOf(undefined), null);
});

const hero = (...fills: string[]) =>
  compile(['az 1', 'site a', 'page /', '  hero center', '    title "x"', ...fills.map((f) => `    ${f}`), 'page /a', 'page /b', ''].join('\n'),
    { manifests });
const codes = (r: ReturnType<typeof compile>) => r.diagnostics.map((d) => d.code);

test('§1.2: `as` must name a button weight (AZ1220)', () => {
  const r = hero('cta "Reserve" /a as loud');
  assert.ok(codes(r).includes('AZ1220'), JSON.stringify(r.diagnostics));
  assert.ok(!codes(hero('cta "Reserve" /a as ghost')).includes('AZ1220'), 'CONTROL: a real weight is accepted');
});

test('§1.2: two primaries in one section warn (AZ1221)', () => {
  const r = hero('cta "Reserve" /a', 'alt "Or this" /b as primary');
  assert.ok(r.diagnostics.some((d) => d.code === 'AZ1221' && d.severity === 'warning'), JSON.stringify(r.diagnostics));
  assert.ok(!codes(hero('cta "Reserve" /a', 'alt "Or this" /b')).includes('AZ1221'), 'CONTROL: cta + alt is one primary');
});

test('play and copy warn that their behaviour is not built (AZ1222)', () => {
  const r = hero('cta "Watch the film" video:intro');
  assert.ok(r.diagnostics.some((d) => d.code === 'AZ1222' && d.severity === 'warning'), JSON.stringify(r.diagnostics));
  assert.ok(!codes(hero('cta "Reserve" /a')).includes('AZ1222'), 'CONTROL: a link has nothing missing');
});

test("CONTROL: a page's `cta` BLOCK is not an action of the page", () => {
  const r = compile('az 1\nsite a\npage /\n  hero center\n    title "x"\n  cta band\n    title "Ready?"\n    cta "Go" /a\npage /a\n', { manifests });
  assert.ok(!codes(r).includes('AZ1221') && !codes(r).includes('AZ1220'), JSON.stringify(r.diagnostics));
});
