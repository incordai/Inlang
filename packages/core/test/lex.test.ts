/**
 * Lexer tests. Every assertion that matters has a control proving it can fail.
 * Run: pnpm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, type Token } from '../src/lex.ts';

const kinds = (src: string) => lex(src).tokens.map((t) => t.kind);
const words = (src: string) => lex(src).tokens.filter((t) => t.kind === 'word').map((t) => t.value);
const errs = (src: string) => lex(src).diagnostics.map((d) => d.code);
const val = (ts: Token[], kind: string) => ts.filter((t) => t.kind === kind).map((t) => t.value);

test('a flat file produces words and newlines, no indents', () => {
  const k = kinds('az 1\nsite aurora\n');
  assert.ok(!k.includes('indent'), 'flat file must not open a block');
  assert.deepEqual(words('az 1\nsite aurora\n'), ['az', 'site', 'aurora']);
});

test('indentation opens and closes blocks', () => {
  const k = kinds('site aurora\n  theme midnight\n');
  assert.equal(k.filter((x) => x === 'indent').length, 1);
  assert.equal(k.filter((x) => x === 'dedent').length, 1, 'EOF must close open blocks');
});

test('blank and comment lines do NOT close a block', () => {
  // The classic indentation-parser bug: a blank line inside a block ends it.
  const src = 'site aurora\n  theme midnight\n\n  # a comment\n  font\n';
  const k = kinds(src);
  assert.equal(k.filter((x) => x === 'indent').length, 1, 'one block only');
  assert.equal(k.filter((x) => x === 'dedent').length, 1, 'closed once, at EOF');
});

test('CONTROL: a real dedent DOES close the block', () => {
  // Proves the test above is not passing because dedents never fire.
  const src = 'site aurora\n  theme midnight\npage /\n';
  const k = kinds(src);
  assert.equal(k.filter((x) => x === 'dedent').length, 1);
  const d = lex(src).tokens.findIndex((t) => t.kind === 'dedent');
  const p = lex(src).tokens.findIndex((t) => t.value === 'page');
  assert.ok(d < p, 'the dedent must precede the word that caused it');
});

test('value kinds are classified by shape', () => {
  const ts = lex('hero\n  title "Built in the dark"\n  model ./a.glb\n  link /work\n  jump #price\n  call tel:+504123\n  count 29\n').tokens;
  assert.deepEqual(val(ts, 'string'), ['Built in the dark']);
  assert.deepEqual(val(ts, 'path'), ['./a.glb']);
  assert.deepEqual(val(ts, 'route'), ['/work']);
  assert.deepEqual(val(ts, 'anchor'), ['#price']);
  assert.deepEqual(val(ts, 'pair'), ['tel:+504123']);
  assert.deepEqual(val(ts, 'number'), ['29']);
});

test('a # inside a quoted string is content, not a comment', () => {
  const ts = lex('hero\n  title "Save #1 today"\n').tokens;
  assert.deepEqual(val(ts, 'string'), ['Save #1 today']);
});

test('CONTROL: a bare # DOES start a comment', () => {
  const ts = lex('site aurora # this is a comment\n').tokens;
  assert.deepEqual(val(ts, 'word'), ['site', 'aurora'], 'comment text must not tokenise');
});

test('every token carries a 1-based position', () => {
  const ts = lex('site aurora\n  theme midnight\n').tokens;
  const theme = ts.find((t) => t.value === 'theme')!;
  assert.equal(theme.pos.line, 2);
  assert.equal(theme.pos.col, 3, 'two spaces of indent means column 3');
});

/* ---------------- indentation errors, GRAMMAR §2.7 ---------------- */

test('tabs are rejected', () => {
  assert.deepEqual(errs('site aurora\n\ttheme midnight\n'), ['AZ1001']);
});

test('odd indentation is rejected', () => {
  assert.deepEqual(errs('site aurora\n   theme midnight\n'), ['AZ1002']);
});

test('jumping two levels at once is rejected', () => {
  assert.deepEqual(errs('site aurora\n    theme midnight\n'), ['AZ1003']);
});

test('nesting deeper than four levels is rejected', () => {
  const src = 'a\n  b\n    c\n      d\n        e\n          f\n';
  assert.ok(errs(src).includes('AZ1004'), 'depth limit must fire');
});

test('a dedent to a column no block opened is rejected', () => {
  const src = 'site aurora\n    theme midnight\n  font\n';
  const codes = errs(src);
  assert.ok(codes.length > 0, 'misaligned dedent must be reported');
});

test('an unterminated string is reported', () => {
  assert.deepEqual(errs('hero\n  title "no closing quote\n'), ['AZ1006']);
});

test('uppercase and underscores are rejected in words', () => {
  assert.deepEqual(errs('site Aurora\n'), ['AZ1008']);
  assert.deepEqual(errs('site my_site\n'), ['AZ1008']);
});

test('CONTROL: a valid file produces NO diagnostics', () => {
  // Without this, every error test above could pass because the lexer errors
  // on everything.
  const src = 'az 1\nsite aurora\n  theme midnight\n  font\n    display serif\n\npage /\n  hero split\n    title "Hello"\n';
  assert.deepEqual(lex(src).diagnostics, [], 'a good file must be clean');
});

test('diagnostics are COLLECTED, not thrown on the first', () => {
  const src = 'site Aurora\n\ttheme midnight\n';
  assert.ok(lex(src).diagnostics.length >= 2, 'must report more than the first problem');
});
