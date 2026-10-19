/**
 * A chat package's README example is real (chat-block-spec §22): the code it
 * shows is the example file, byte for byte, and what it says the example
 * prints is what running the file prints. Each chat package's readme.test.ts
 * registers these checks for its own README and example.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One run of an example is a fraction of a second; a hang is a failure. */
const RUN_MS = 20_000;

/** The fenced blocks of `lang` in a markdown text, in order. */
export const fenced = (md: string, lang: string): string[] =>
  [...md.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\`\\n`, 'g'))].map((m) => m[1]);

/** The README's first `ts` block is the example; its first `text` block is what the example prints. */
export function exampleChecks(readme: URL, example: URL): void {
  const md = readFileSync(readme, 'utf8');
  const file = fileURLToPath(example);
  test('the README shows the example file exactly', () => {
    assert.equal(fenced(md, 'ts')[0], readFileSync(file, 'utf8'));
  });
  test('the example runs and prints what the README says it prints', () => {
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: RUN_MS });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, fenced(md, 'text')[0]);
  });
}
