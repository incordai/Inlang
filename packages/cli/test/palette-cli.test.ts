/**
 * `az palette` through the real binary: the page it writes, --list, --json,
 * the filters, and the usage errors (exit 2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES } from '../../theme/src/index.ts';
import { ACCENT_PAIRS } from '../../core/src/accent-pairs.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
/** A full gallery proves every pair it paints (a few seconds); far under this. */
const RUN_MS = 120_000;
const az = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [...process.execArgv, BIN, 'palette', ...args], { cwd, encoding: 'utf8', timeout: RUN_MS });
const scratch = () => mkdtempSync(join(tmpdir(), 'az-palette-'));

test('with no arguments it writes the gallery into the build folder, every theme in it', () => {
  const dir = scratch();
  const r = az(dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, '.az-build/.palette/index.html');
  assert.match(r.stdout, /wrote \.az-build\/\.palette\/index\.html/);
  const html = readFileSync(file, 'utf8');
  for (const name of Object.keys(THEMES)) assert.ok(html.includes(`id="theme-${name}"`), name);
  assert.ok(existsSync(join(dir, '.az-build/.palette/.az-manifest.json')), 'the folder records what az wrote');
  // A second run writes the same bytes.
  assert.equal(az(dir).status, 0);
  assert.equal(readFileSync(file, 'utf8'), html);
});

test('--out and the filters: one theme, one hue and its pairs', () => {
  const dir = scratch();
  const r = az(dir, '--theme', 'clay', '--accent', 'violet', '--out', 'gallery');
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(dir, 'gallery/index.html'), 'utf8');
  assert.ok(html.includes('id="theme-clay"') && !html.includes('id="theme-volt"'));
  assert.ok(html.includes('id="clay-accent-violet"') && !html.includes('id="clay-accent-rose"'));
  for (const partner of ACCENT_PAIRS.clay.violet) assert.ok(html.includes(`id="clay-pair-violet-${partner}"`), partner);
});

test('--list prints every theme, hue, pair, shape and origin for a terminal', () => {
  const r = az(scratch(), '--list');
  assert.equal(r.status, 0, r.stderr);
  for (const name of Object.keys(THEMES)) assert.match(r.stdout, new RegExp(`^theme ${name} `, 'm'));
  assert.match(r.stdout, /^ {2}accent {10}violet indigo blue teal green lime amber orange rose$/m);
  assert.match(r.stdout, /^pattern {11}none glow spotlight ramp grid hatch dots$/m);
  assert.match(r.stdout, /^pattern origin {4}top bottom left right center$/m);
  for (const line of r.stdout.split('\n')) assert.ok(line.length <= 80, line);
});

test('--json gives tools each choice with its .az line; filters apply', () => {
  const r = az(scratch(), '--json', '--theme', 'signal', '--accent', 'green');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.themes.map((t: { name: string }) => t.name), ['signal']);
  assert.deepEqual(j.themes[0].accents, [{ name: 'green', az: 'accent green' }]);
  assert.deepEqual(j.themes[0].pairs.map((p: { az: string }) => p.az), ACCENT_PAIRS.signal.green.map((h) => `accent green ${h}`));
  assert.ok(j.patterns.some((p: { name: string; az: string[] }) => p.name === 'glow' && p.az.includes('pattern glow top')));
});

test('usage errors exit 2: a bad flag, a missing value, an unknown name, --list with --json or --out', () => {
  const dir = scratch();
  for (const args of [['--bogus'], ['extra'], ['--theme'], ['--theme', 'clai'], ['--accent', 'magenta'],
    ['--list', '--json'], ['--list', '--out', 'x']]) {
    const r = az(dir, ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^az: palette: /);
  }
  assert.match(az(dir, '--theme', 'clai').stderr, /did you mean 'clay'/);
  assert.ok(!existsSync(join(dir, '.az-build')), 'a usage error writes nothing');
});

test('--help prints the command\'s usage and exits 0', () => {
  const r = az(scratch(), '--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /az palette --list/);
});

test('a file az did not write is never replaced: exit 1, the file kept', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'mine'));
  writeFileSync(join(dir, 'mine/index.html'), 'my own page');
  const r = az(dir, '--theme', 'paper', '--out', 'mine');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exists and az did not generate it/);
  assert.equal(readFileSync(join(dir, 'mine/index.html'), 'utf8'), 'my own page');
});
