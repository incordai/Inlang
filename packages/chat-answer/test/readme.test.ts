/**
 * The package README's example is real: shown exactly, and printing what the
 * README says it prints (readme-example.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exampleChecks, fenced } from './readme-example.ts';

const README = new URL('../README.md', import.meta.url);

exampleChecks(README, new URL('../examples/check-an-answer.ts', import.meta.url));

test('CONTROL: the comparison sees a README that drifted', () => {
  const md = readFileSync(README, 'utf8');
  assert.notEqual(fenced(md.replace('"paid",12', '"paid",13'), 'text')[0], fenced(md, 'text')[0]);
  assert.equal(fenced('no code here', 'ts').length, 0);
});
