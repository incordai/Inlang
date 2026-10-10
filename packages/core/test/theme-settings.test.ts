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
import { ACCENT_PAIRS } from '../src/accent-pairs.ts';
import { lex } from '../src/lex.ts';
import { parse } from '../src/parse.ts';

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
  assert.ok(codes(site('paper', '    accent violet blue teal\n')).includes('AZ1406'));
  assert.ok(codes(site('paper', '    pattern glow top extra\n')).includes('AZ1406'));
  const r = compileOf(site('paper', '    accent teal\n    accent rose\n'));
  assert.ok(r.diagnostics.some((d) => d.code === 'AZ1203' && d.severity === 'warning'));
  assert.equal(r.spec?.site.accent, 'teal', 'the first is kept');
});

/* ---- theme-spec §13: an accent pair --------------------------------- */

test('a pair reaches the Spec as accent and accent2; one hue carries no accent2 key at all', () => {
  const r = compileOf(site('midnight', '    accent violet blue\n'));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.spec?.site.accent, 'violet');
  assert.equal(r.spec?.site.accent2, 'blue');
  const one = compileOf(site('midnight', '    accent violet\n'));
  assert.equal(Object.hasOwn(one.spec!.site, 'accent2'), false, 'a one-hue Spec serialises exactly as before');
});

test('a refused pair is AZ1423, at the second hue, naming the partners the first hue has on this theme', () => {
  const r = compileOf(site('midnight', '    accent violet indigo\n'));
  const d = r.diagnostics.find((x) => x.code === 'AZ1423');
  assert.ok(d, JSON.stringify(r.diagnostics));
  assert.equal(d.severity, 'error');
  assert.equal(r.ok, false);
  assert.equal(d.message, "theme: accent 'violet indigo' is not a pair on midnight — violet pairs with blue, teal, orange, rose");
  assert.equal(d.pos.line, 4);
  assert.equal(d.pos.col, 19, 'points at the second hue');
});

test('AZ1423 follows the theme: a pair one theme allows and another refuses', () => {
  // The generated table differs per theme (amber–green fails signal's hover chroma).
  assert.ok(ACCENT_PAIRS.paper.green.includes('amber') && !ACCENT_PAIRS.signal.green.includes('amber'));
  assert.deepEqual(codes(site('paper', '    accent green amber\n')), []);
  assert.ok(codes(site('signal', '    accent green amber\n')).includes('AZ1423'));
});

test('a hue paired with itself is refused; an unknown second hue is AZ1418', () => {
  assert.ok(codes(site('paper', '    accent rose rose\n')).includes('AZ1423'));
  const r = compileOf(site('paper', '    accent rose magenta\n'));
  const d = r.diagnostics.find((x) => x.code === 'AZ1418');
  assert.match(d?.message ?? '', /'magenta' is not a hue/);
});

test('CONTROL: every pair the table offers compiles clean, either way round, on its theme', () => {
  for (const [theme, table] of Object.entries(ACCENT_PAIRS)) {
    for (const [first, partners] of Object.entries(table)) {
      for (const second of partners) assert.deepEqual(codes(site(theme, `    accent ${first} ${second}\n`)), [], `${theme} ${first} ${second}`);
    }
  }
});

test('the lexer and parser read a pair as one accent line with two values', () => {
  const lexed = lex(site('midnight', '    accent violet blue\n'));
  assert.deepEqual(lexed.diagnostics, []);
  const parsed = parse(lexed.tokens, lexed.diagnostics);
  assert.deepEqual(parsed.diagnostics, []);
  const theme = parsed.file.body.find((s) => s.word === 'site')?.children.find((c) => c.word === 'theme');
  const accent = theme?.children.find((c) => c.word === 'accent');
  assert.deepEqual(accent?.args.map((a) => [a.kind, a.value]), [['word', 'violet'], ['word', 'blue']]);
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
