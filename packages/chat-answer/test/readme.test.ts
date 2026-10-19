/**
 * The package README's example is real: the code it shows is the example
 * file, byte for byte, and what it says the example prints is what running
 * the file prints.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const EXAMPLE = fileURLToPath(new URL('../examples/check-an-answer.ts', import.meta.url));
/** One run of the example is a fraction of a second; a hang is a failure. */
const RUN_MS = 20_000;

/** The fenced blocks of `lang` in a markdown text, in order. */
const fenced = (md: string, lang: string): string[] =>
  [...md.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\`\\n`, 'g'))].map((m) => m[1]);

test('the README shows the example file exactly', () => {
  assert.equal(fenced(README, 'ts')[0], readFileSync(EXAMPLE, 'utf8'));
});

test('the example runs and prints what the README says it prints', () => {
  const r = spawnSync(process.execPath, [EXAMPLE], { encoding: 'utf8', timeout: RUN_MS });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fenced(README, 'text')[0]);
});

test('CONTROL: the comparison sees a README that drifted', () => {
  assert.notEqual(fenced(README.replace('"paid",12', '"paid",13'), 'text')[0], fenced(README, 'text')[0]);
  assert.equal(fenced('no code here', 'ts').length, 0);
});
