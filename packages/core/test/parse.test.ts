/**
 * Parser tests — GRAMMAR §3.1 and §7.
 * Run: pnpm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lex.ts';
import { parse, type Statement } from '../src/parse.ts';

const run = (src: string) => {
  const { tokens, diagnostics } = lex(src);
  return parse(tokens, diagnostics);
};
const codes = (src: string) => run(src).diagnostics.map((d) => d.code);
const find = (body: Statement[], word: string): Statement | undefined => {
  for (const s of body) {
    if (s.word === word) return s;
    const hit = find(s.children, word);
    if (hit) return hit;
  }
  return undefined;
};

const GOOD = `az 1
site aurora
  theme midnight
  width wide
  font
    display serif
    body sans
  nav split sticky
    link "Work" /work
    group "Products" as dropdown
      link "Shoes" /shoes
    cta "Reserve" /reserve

page /
  hero split 3d scroll
    title "Built in the dark"
    height peek
    model ./assets/shoe.glb
`;

test('a whole file parses with no diagnostics', () => {
  const r = run(GOOD);
  assert.deepEqual(r.diagnostics, [], JSON.stringify(r.diagnostics, null, 1));
  assert.equal(r.file.version, '1');
});

test('nesting produces a tree, not a flat list', () => {
  const r = run(GOOD);
  const site = r.file.body.find((s) => s.word === 'site')!;
  assert.equal(site.args[0].value, 'aurora');
  const nav = site.children.find((s) => s.word === 'nav')!;
  assert.deepEqual(nav.args.map((a) => a.value), ['split', 'sticky']);
  const group = nav.children.find((s) => s.word === 'group')!;
  assert.equal(group.children.length, 1, 'group holds its own link');
  assert.equal(group.children[0].word, 'link');
});

test('`as` is captured as an override, not an argument', () => {
  const g = find(run(GOOD).file.body, 'group')!;
  assert.equal(g.as, 'dropdown');
  assert.deepEqual(g.args.map((a) => a.value), ['Products'],
    'the as-clause must not leak into args');
});

test('argument kinds survive to the AST for the link stage', () => {
  const hero = find(run(GOOD).file.body, 'hero')!;
  const title = hero.children.find((s) => s.word === 'title')!;
  assert.equal(title.args[0].kind, 'string');
  const model = hero.children.find((s) => s.word === 'model')!;
  assert.equal(model.args[0].kind, 'path');
  const link = find(run(GOOD).file.body, 'link')!;
  assert.equal(link.args[1].kind, 'route');
});

test('positions survive parsing', () => {
  const theme = find(run(GOOD).file.body, 'theme')!;
  assert.equal(theme.pos.line, 3);
  assert.equal(theme.pos.col, 3);
});

/* ---------------- the five parse failures, §7.1 ---------------- */

test('AZ1101 — `as` with nothing after it', () => {
  assert.ok(codes('az 1\nnav bar\n  group "P" as\n').includes('AZ1101'));
});

test('AZ1102 — a line starting with a string', () => {
  assert.ok(codes('az 1\n"Work" /work\n').includes('AZ1102'));
});

test('AZ1103 — two `as` clauses', () => {
  assert.ok(codes('az 1\nnav bar\n  group "P" as dropdown as mega\n').includes('AZ1103'));
});

test('AZ1105 — the version marker takes no body', () => {
  assert.ok(codes('az 1\n  site aurora\n').includes('AZ1105'));
});

test('a missing version marker is reported', () => {
  assert.ok(codes('site aurora\n').includes('AZ1108'));
});

test('an unsupported version is reported', () => {
  assert.ok(codes('az 2\nsite aurora\n').includes('AZ1107'));
});

/* ---------------- recovery, §7.2 ---------------- */

test('rule 2 — a bad argument keeps the statement AND its body', () => {
  const r = run('az 1\nnav bar\n  group "P" as\n    link "Shoes" /shoes\n');
  const group = find(r.file.body, 'group');
  assert.ok(group, 'the statement must survive a bad argument');
  assert.equal(group!.children.length, 1, 'its body must still parse');
  assert.equal(group!.children[0].word, 'link');
});

test('rule 3 — a bad WORD discards its orphaned body, with one summary', () => {
  const r = run('az 1\n"Work" /work\n  link "a" /a\n  link "b" /b\npage /\n');
  const cs = r.diagnostics.map((d) => d.code);
  assert.ok(cs.includes('AZ1102'), 'the bad line is reported');
  assert.ok(cs.includes('AZ1106'), 'the orphaned body gets ONE summary diagnostic');
  assert.ok(find(r.file.body, 'page'), 'the rest of the file still parses');
});

test('CONTROL: a good file produces neither recovery diagnostic', () => {
  // Without this, the recovery tests could pass because those codes always fire.
  const cs = codes(GOOD);
  assert.ok(!cs.includes('AZ1102'));
  assert.ok(!cs.includes('AZ1106'));
});

test('diagnostics accumulate — one bad line does not stop the file', () => {
  const r = run('az 1\nnav bar\n  group "P" as\n  group "Q" as dropdown as mega\n');
  assert.ok(r.diagnostics.length >= 2, 'both bad lines must be reported');
  assert.ok(find(r.file.body, 'nav'), 'the file still produces a tree');
});

test('a quoted "as" is a value, not the keyword', () => {
  const r = run('az 1\nhero center\n  title "as"\n');
  const title = find(r.file.body, 'title')!;
  assert.equal(title.as, null, 'a quoted as must not be read as the keyword');
  assert.equal(title.args[0].value, 'as');
});

test('lexer diagnostics are carried through, not dropped', () => {
  const cs = codes('az 1\nsite Aurora\n');
  assert.ok(cs.includes('AZ1008'), 'a lex error must reach the parse result');
});
