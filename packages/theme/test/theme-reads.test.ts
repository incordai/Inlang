/**
 * `themeReads` in word.json against the token paths the word's source reads
 * (theme-reads.ts). The repository's words are checked through `az lint`
 * (packages/cli/test/lint-migrate.test.ts); here every accessor form is
 * pinned, and a deliberately wrong list — one entry missing, one extra —
 * must fail, so a check that matched nothing could not pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkThemeReads, themeReadsIn } from '../src/theme-reads.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

const paths = (source: string) => themeReadsIn('emit.web.ts', source).map((r) => r.path);

const WORD = [
  "import type { ThemeLike } from '../../core/src/emit-contract.ts';",
  'export function emit(block, ctx) {',
  '  const t = ctx.theme;',
  "  return { tag: 'div', style: { color: t.color.text, padding: px(t.space[24]), maxWidth: t.size['measure-body'] } };",
  '}',
  '',
].join('\n');
const MANIFEST = (reads: string[]) => JSON.stringify({ name: 'badge', themeReads: reads }, null, 2) + '\n';
const RIGHT = ['color.text', 'size.measure-body', 'space.24'];

test('every accessor form is a read: alias, ctx.theme, quoted, numeric, typed parameter, typeSize', () => {
  assert.deepEqual(paths(WORD), RIGHT);
  assert.deepEqual(paths('const c = ctx.theme.color.accent;'), ['color.accent']);
  assert.deepEqual(paths('const f = ctx.theme.typeSize.sm;'), ['type.size.sm']);
  assert.deepEqual(paths("const w = (theme: ThemeLike) => theme.type[\"leading-body\"] + theme.radius.md;"),
    ['radius.md', 'type.leading-body']);
  assert.deepEqual(paths('const t = ctx.theme; const s = t.space[n] + t.layer.modal;'), ['layer.modal', 'space.*']);
});

test('prose, the site pattern and other objects are not reads', () => {
  assert.deepEqual(paths('// reads ctx.theme.color.accent\n/* t.color.bg */ const x = 1;'), []);
  assert.deepEqual(paths('/**\n * Every value arrives through `ctx.theme.color.muted`.\n */\n'), []);
  assert.deepEqual(paths('const t = ctx.theme; const p = t.pattern.image;'), []);
  assert.deepEqual(paths('const s = block.color.accent + other.t.color.bg;'), []);
  assert.deepEqual(paths("const url = 'https://x.test'; const c = ctx.theme.color.bg;"), ['color.bg'],
    'a // inside a string is not a comment');
});

test('a read is placed at its line and column', () => {
  const [first] = themeReadsIn('emit.web.ts', WORD);
  assert.deepEqual({ path: first.path, line: first.line, col: first.col }, { path: 'color.text', line: 4, col: 40 });
});

test('the declared list passes when it is exactly what the source reads', () => {
  assert.deepEqual(checkThemeReads('word.json', MANIFEST(RIGHT), RIGHT, [['emit.web.ts', WORD]]), []);
});

test('CONTROL: a deliberately wrong list fails — one read missing, one entry extra', () => {
  const wrong = ['color.accent', 'color.text', 'size.measure-body'];
  const found = checkThemeReads('word.json', MANIFEST(wrong), wrong, [['emit.web.ts', WORD]]);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line}:${f.col} ${f.rule} ${f.message}`), [
    "emit.web.ts:4:66 theme-reads 'space.24' is read here but missing from themeReads in word.json — add it",
    "word.json:4:5 theme-reads 'color.accent' is in themeReads but the word's source never reads it — remove it",
  ]);
});

test('CONTROL: a wildcard is what a computed read needs, and a wildcard nothing reads is extra', () => {
  const dynamic = 'const t = ctx.theme; const s = t.space[step];';
  assert.deepEqual(checkThemeReads('word.json', MANIFEST(['space.*']), ['space.*'], [['e.ts', dynamic]]), []);
  assert.equal(checkThemeReads('word.json', MANIFEST(['space.8']), ['space.8'], [['e.ts', dynamic]]).length, 2,
    'space.* missing and space.8 extra');
  assert.deepEqual(
    checkThemeReads('word.json', MANIFEST(['space.*']), ['space.*'], [['emit.web.ts', WORD]]).map((f) => f.message.split(' ')[0]),
    ["'color.text'", "'size.measure-body'", "'space.24'", "'space.*'"]);
});

test('CONTROL: a manifest with no themeReads is checked as an empty list', () => {
  assert.equal(checkThemeReads('word.json', '{}', [], [['emit.web.ts', WORD]]).length, RIGHT.length);
});

test("CONTROL: the repository's words read tokens at all, so the lint run is not vacuous", () => {
  const words = readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'emit.web.ts')));
  assert.ok(words.length >= 9, `only ${words.length} emitters found`);
  for (const w of words) {
    assert.ok(themeReadsIn('emit.web.ts', readFileSync(join(WORDS, w, 'emit.web.ts'), 'utf8')).length >= 5, w);
  }
});
