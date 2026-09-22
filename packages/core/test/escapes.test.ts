/**
 * GRAMMAR §1.5: a string has exactly three escapes — \" \\ \n — and any other
 * is AZ1011. The lexer used to keep whatever followed a backslash, so `\n`
 * became a literal `n` and an inline paragraph break could not be written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lex.ts';

const strings = (line: string) => {
  const r = lex(`az 1\n${line}\n`);
  return { values: r.tokens.filter((t) => t.kind === 'string').map((t) => t.value), codes: r.diagnostics.map((d) => d.code) };
};

test('\\n is a newline', () => {
  assert.deepEqual(strings('x "One.\\n\\nTwo."').values, ['One.\n\nTwo.']);
});

test('\\" and \\\\ are the quote and the backslash', () => {
  assert.deepEqual(strings('x "a\\"b\\\\c"').values, ['a"b\\c']);
});

test('any other escape is AZ1011', () => {
  assert.deepEqual(strings('x "tab\\there"').codes, ['AZ1011']);
});

test('CONTROL: a string with no backslash is untouched and raises nothing', () => {
  assert.deepEqual(strings('x "plain text"'), { values: ['plain text'], codes: [] });
});
