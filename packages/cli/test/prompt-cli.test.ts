/**
 * `az prompt` through the real binary: the Markdown on stdout and its size on
 * stderr, --json, --compact, --words, --budget, and the usage errors (exit 2).
 * The minimal site it prints passes `az check` as written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
/** The prompt compiles each example and error case — well under a second; far under this. */
const RUN_MS = 60_000;
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [...process.execArgv, BIN, ...args], { cwd, encoding: 'utf8', timeout: RUN_MS });
const az = (cwd: string, ...args: string[]) => run(cwd, 'prompt', ...args);
const scratch = () => mkdtempSync(join(tmpdir(), 'az-prompt-'));

test('az prompt prints the Markdown on stdout and its size on stderr, and writes nothing', () => {
  const dir = scratch();
  const r = az(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# Writing \.az files\n/);
  for (const h of ['## Order of work', '## Syntax', '## Colour (choose first)', '## Words (blocks)', '### `hero`', '## Common errors']) {
    assert.ok(r.stdout.includes(h), h);
  }
  const size = /az: prompt is (\d+) characters, about (\d+) tokens \(approximate tokens = characters \/ 4, rounded up\)\n$/.exec(r.stderr);
  assert.ok(size, r.stderr);
  assert.equal(Number(size[1]), r.stdout.length);
  assert.equal(Number(size[2]), Math.ceil(r.stdout.length / 4));
  assert.deepEqual(readdirSync(dir), [], 'nothing written');
  assert.equal(az(dir).stdout, r.stdout, 'the same bytes every run');
});

test('--json carries the same prompt with its size; --compact and --words are smaller', () => {
  const dir = scratch();
  const plain = az(dir).stdout;
  const j = az(dir, '--json');
  assert.equal(j.status, 0, j.stderr);
  const json = JSON.parse(j.stdout);
  assert.equal(json.prompt, plain);
  assert.equal(json.chars, plain.length);
  assert.deepEqual(json.dropped, []);
  const compact = JSON.parse(az(dir, '--compact', '--json').stdout);
  assert.ok(compact.chars < json.chars / 2);
  assert.deepEqual(compact.dropped.map((d: { part: string }) => d.part), json.trimOrder);
  const words = JSON.parse(az(dir, '--words', 'hero,cta', '--json').stdout);
  assert.deepEqual(words.words, ['cta', 'hero']);
  assert.ok(!words.prompt.includes('### `nav`'));
});

test('--budget fits the prompt in that many tokens, dropping in the stated order', () => {
  const dir = scratch();
  const full = JSON.parse(az(dir, '--json').stdout);
  const r = az(dir, '--budget', String(full.tokens - 1), '--json');
  assert.equal(r.status, 0, r.stderr);
  const fitted = JSON.parse(r.stdout);
  assert.ok(fitted.tokens < full.tokens);
  assert.equal(fitted.dropped[0].part, full.trimOrder[0]);
  const text = az(dir, '--budget', String(full.tokens - 1));
  assert.match(text.stderr, new RegExp(`left out: ${full.trimOrder[0]}\\n$`));
});

test('the minimal site in the prompt passes az check as written', () => {
  const dir = scratch();
  const md = az(dir).stdout;
  const site = /A whole site that compiles with no diagnostics:\n\n```az\n([\s\S]*?)\n```/.exec(md);
  assert.ok(site, 'the minimal example is in the prompt');
  writeFileSync(join(dir, 'site.az'), `${site[1]}\n`);
  const r = run(dir, 'check', 'site.az');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no problems found/);
  assert.equal(r.stderr, '', 'not even a warning');
});

for (const [args, why] of [
  [['--bogus'], /unexpected '--bogus'/],
  [['--budget'], /--budget needs a value/],
  [['--budget', 'lots'], /budget 'lots' is not a whole number/],
  [['--budget', '0'], /is not a whole number of tokens above 0/],
  [['--budget', '10'], /the smallest prompt is \d+ tokens .* over the budget of 10/],
  [['--words'], /--words needs a value/],
  [['--words', 'heros'], /'heros' is not a word .*did you mean 'hero'/],
  [['--words', 'hero', '--words', 'cta'], /--words given twice/],
] as const) {
  test(`az prompt ${args.join(' ')} is a usage error: exit 2, nothing on stdout`, () => {
    const r = az(scratch(), ...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, why);
    assert.match(r.stderr, /az prompt --budget N/, 'the usage follows');
  });
}

test('CONTROL: az prompt --help exits 0 with the usage on stdout', () => {
  const r = az(scratch(), '--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dropping in order: examples, rules, info, data, errors/);
});
