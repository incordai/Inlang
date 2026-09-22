/**
 * The spec's own worked example must PARSE.
 *
 * GRAMMAR §8 publishes a complete file as the reference for what an author
 * writes. If the compiler cannot read it, either the example or the grammar is
 * wrong — and a spec whose own example is invalid is worse than no example.
 *
 * This fixture is extracted verbatim from the document, so the two cannot
 * drift apart silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lex } from '../src/lex.ts';
import { parse } from '../src/parse.ts';

const src = readFileSync(new URL('./fixture-site.az', import.meta.url), 'utf8');

test("the spec's worked example parses with zero diagnostics", () => {
  const { tokens, diagnostics } = lex(src);
  const r = parse(tokens, diagnostics);
  assert.deepEqual(
    r.diagnostics.map((d) => `${d.code} ${d.pos.line}:${d.pos.col} ${d.message}`),
    [],
  );
  assert.equal(r.file.version, '1');
});

test('it produces the structure the spec describes', () => {
  const r = parse(...(() => { const l = lex(src); return [l.tokens, l.diagnostics] as const; })());
  const site = r.file.body.find((s) => s.word === 'site');
  assert.ok(site, 'a site statement');
  const pages = r.file.body.filter((s) => s.word === 'page');
  assert.ok(pages.length >= 1, 'at least one page');
  const nav = site!.children.find((s) => s.word === 'nav');
  assert.ok(nav, 'nav nested under site — the inheritance shape (nav-spec §8)');
});

test('CONTROL: a deliberately broken copy DOES produce diagnostics', () => {
  // Otherwise "zero diagnostics" might mean the checker is inert.
  const broken = src.replace('site aurora', 'site Aurora');
  const { tokens, diagnostics } = lex(broken);
  const r = parse(tokens, diagnostics);
  assert.ok(r.diagnostics.length > 0, 'a broken file must report something');
});
