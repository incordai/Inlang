/**
 * `theme` and its settings — PRD §6.1a, GRAMMAR theme-decl.
 *
 * The linker returned `theme` with no children, so `accent` and `pattern`
 * never reached the Spec: every site compiled to the defaults, an unknown
 * setting or value passed silently, and so did an unknown theme name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Manifest } from '../src/index.ts';

const manifests = new Map<string, Manifest>();
const site = (theme: string, settings = '') => `az 1\nsite aurora\n  theme ${theme}\n${settings}page /\n`;
const compileOf = (src: string) => compile(src, { manifests });
const codes = (src: string) => compileOf(src).diagnostics.map((d) => d.code);

test('accent and pattern reach the Spec', () => {
  const r = compileOf(site('paper', '    accent teal\n    pattern dots center\n'));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.spec?.site.accent, 'teal');
  assert.equal(r.spec?.site.pattern, 'dots');
  assert.equal(r.spec?.site.patternOrigin, 'center');
});

test('CONTROL: no settings keep the theme as designed — own accent, no pattern', () => {
  const r = compileOf(site('paper'));
  assert.equal(r.spec?.site.accent, null);
  assert.equal(r.spec?.site.pattern, 'none');
  assert.equal(r.spec?.site.patternOrigin, 'top');
});

test('a pattern without an origin lights from the top', () => {
  assert.equal(compileOf(site('signal', '    pattern glow\n')).spec?.site.patternOrigin, 'top');
});

test('an unknown theme name is AZ1417, naming the themes', () => {
  const r = compileOf(site('purple'));
  const d = r.diagnostics.find((x) => x.code === 'AZ1417');
  assert.ok(d, JSON.stringify(r.diagnostics));
  assert.match(d.message, /'purple' is not a theme — use midnight, paper, signal/);
  assert.equal(r.ok, false);
});

test('an unknown theme setting is AZ1405', () => {
  assert.ok(codes(site('paper', '    sparkle on\n')).includes('AZ1405'));
});

test('an unknown accent hue is AZ1418; an unknown shape or origin is AZ1419', () => {
  assert.ok(codes(site('paper', '    accent magenta\n')).includes('AZ1418'));
  assert.ok(codes(site('paper', '    pattern swirl\n')).includes('AZ1419'));
  assert.ok(codes(site('paper', '    pattern glow sideways\n')).includes('AZ1419'));
});

test('a setting with no value is AZ1205; extra values are AZ1406; a repeat warns AZ1203', () => {
  assert.ok(codes(site('paper', '    accent\n')).includes('AZ1205'));
  assert.ok(codes(site('paper', '    accent teal rose\n')).includes('AZ1406'));
  assert.ok(codes(site('paper', '    pattern glow top extra\n')).includes('AZ1406'));
  const r = compileOf(site('paper', '    accent teal\n    accent rose\n'));
  assert.ok(r.diagnostics.some((d) => d.code === 'AZ1203' && d.severity === 'warning'));
  assert.equal(r.spec?.site.accent, 'teal', 'the first is kept');
});

test('CONTROL: every valid hue, shape and origin compiles clean', () => {
  for (const hue of ['violet', 'indigo', 'blue', 'teal', 'green', 'lime', 'amber', 'orange', 'rose']) {
    assert.deepEqual(codes(site('midnight', `    accent ${hue}\n`)), [], hue);
  }
  for (const shape of ['none', 'glow', 'spotlight', 'ramp', 'grid', 'hatch', 'dots']) {
    for (const origin of ['top', 'bottom', 'left', 'right', 'center']) {
      assert.deepEqual(codes(site('midnight', `    pattern ${shape} ${origin}\n`)), [], `${shape} ${origin}`);
    }
  }
});
