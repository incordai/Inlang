/**
 * Manifest rules keyed on prop VALUES and prop SHAPES — ARCHITECTURE §4.1.
 *
 * `requiresWhen` (a requirement triggered by an enum value), `list` props
 * (every item kept, checked, deduplicated, capped, deferred items refused)
 * and `route` props (must name a page of this site). Probed with small
 * manifests made here, so each rule is shown to be general rather than a
 * special case for the one word that first needed it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/index.ts';
import type { Manifest } from '../src/link.ts';

const probe: Manifest = {
  name: 'probe',
  kind: 'block',
  props: {
    mode: { type: 'enum', values: ['plain', 'fancy'] },
    extra: { type: 'string' },
    picks: { type: 'list', values: ['a', 'b', 'c', 'd'], max: 2, deferred: ['d'] },
    next: { type: 'route' },
  },
  requiresWhen: { mode: { fancy: ['extra'] } },
};
const manifests = new Map<string, Manifest>([['probe', probe]]);

const run = (lines: string, pages = '') =>
  compile(`az 1\nsite s\n\npage /\n  probe\n${lines}${pages}`, { manifests });
const codes = (lines: string, pages = '') => run(lines, pages).diagnostics.map((d) => d.code);
const probeProps = (lines: string) => run(lines).spec?.pages[0].blocks[0].props ?? {};

test('requiresWhen — the triggering value demands its prop (AZ1206)', () => {
  const r = run('    mode fancy\n');
  const d = r.diagnostics.find((x) => x.code === 'AZ1206');
  assert.ok(d, r.diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /mode 'fancy' needs extra — add: extra <value>/);
  assert.equal(d.pos.line, 6, 'reported at the value that triggered it');
});

test('CONTROL: requiresWhen is quiet for another value, and when satisfied', () => {
  assert.ok(!codes('    mode plain\n').includes('AZ1206'));
  assert.ok(!codes('    mode fancy\n    extra "here"\n').includes('AZ1206'));
});

test('list — every item is kept, not only the first', () => {
  assert.equal(probeProps('    picks a b\n').picks, 'a,b');
});

test('list — an unknown item is AZ1208, a deferred one AZ1214', () => {
  assert.ok(codes('    picks a zz\n').includes('AZ1208'));
  const r = run('    picks d\n');
  const d = r.diagnostics.find((x) => x.code === 'AZ1214');
  assert.ok(d, r.diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /picks 'd' is not available yet — use: a, b, c/);
});

test('list — a repeated item warns (AZ1203) and too many items is AZ1213', () => {
  const rep = run('    picks a a\n').diagnostics.find((x) => x.code === 'AZ1203');
  assert.equal(rep?.severity, 'warning');
  assert.ok(codes('    picks a b c\n').includes('AZ1213'));
});

test('CONTROL: a valid list compiles clean', () => {
  assert.deepEqual(run('    picks b a\n').diagnostics, []);
});

test('route — a route that is not a page is AZ1215', () => {
  const r = run('    next /nowhere\n');
  const d = r.diagnostics.find((x) => x.code === 'AZ1215');
  assert.ok(d, r.diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /'\/nowhere' is not a page in this site — add it or fix the next/);
});

test('CONTROL: a declared page, with or without a fragment, is accepted', () => {
  assert.ok(!codes('    next /done\n', '\npage /done\n').includes('AZ1215'));
  assert.ok(!codes('    next /done#top\n', '\npage /done\n').includes('AZ1215'));
  assert.ok(!codes('    next /\n').includes('AZ1215'));
});
