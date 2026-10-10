/**
 * `az lint` and `az migrate` through the real binary — ROADMAP M2/M3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, GRAMMAR_VERSION } from '../src/migrate.ts';
import { compile } from '../../core/src/index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');

const az = (...args: string[]) =>
  spawnSync(process.execPath, [...process.execArgv, BIN, ...args], { encoding: 'utf8' });

const manifest = (themeReads: string[]) => JSON.stringify({ name: 'badge', variants: ['plain'], themeReads }, null, 2);
const BAD = "export const emit = () => ({ tag: 'span', style: { color: '#ff0066', padding: '13px' } });\n";
const GOOD = "export const emit = (b, ctx) => ({ tag: 'span', style: { color: ctx.theme.color.accent, padding: '12px' } });\n";

/** A words directory with one pack, `badge`; its themeReads default to what the source reads. */
function wordsWith(source: string, themeReads: string[] = source === GOOD ? ['color.accent'] : []) {
  const dir = mkdtempSync(join(tmpdir(), 'az-lint-'));
  mkdirSync(join(dir, 'badge'));
  writeFileSync(join(dir, 'badge/word.json'), manifest(themeReads), 'utf8');
  writeFileSync(join(dir, 'badge/emit.web.ts'), source, 'utf8');
  return dir;
}

/* ---- lint ---------------------------------------------------------------- */

test('A7: az lint fails a deliberately non-compliant word pack', () => {
  const r = az('lint', wordsWith(BAD));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /badge\/emit\.web\.ts:1:\d+ error no-hex/);
  assert.match(r.stderr, /error no-off-scale-px/);
  assert.match(r.stderr, /2 theme violations in 1 word$/m);
});

test('A7 CONTROL: the same word written with tokens passes', () => {
  const r = az('lint', wordsWith(GOOD));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 word, no theme violations/);
});

test('az lint fails a word whose themeReads is not what its source reads', () => {
  const r = az('lint', wordsWith(GOOD, ['color.text']));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /badge\/emit\.web\.ts:1:\d+ error theme-reads {2}'color\.accent' is read here but missing/);
  assert.match(r.stderr, /badge\/word\.json:\d+:\d+ error theme-reads {2}'color\.text' is in themeReads but the word's source never reads it/);
  assert.match(r.stderr, /2 theme violations in 1 word$/m);
});

test('az lint reports a word.json that is not JSON instead of crashing', () => {
  const dir = wordsWith(GOOD);
  writeFileSync(join(dir, 'badge/word.json'), '{ "name": ', 'utf8');
  const r = az('lint', dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /badge\/word\.json:1:1 error theme-reads {2}word\.json is not valid JSON/);
});

test('a folder without word.json is not a word pack and is not linted', () => {
  const dir = wordsWith(GOOD);
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes/scratch.ts'), BAD, 'utf8');
  const r = az('lint', dir);
  assert.equal(r.status, 0, r.stderr);
});

test('a single word pack can be linted directly', () => {
  const r = az('lint', join(wordsWith(BAD), 'badge'));
  assert.equal(r.status, 1);
});

test('a directory with no word packs is an error, not a silent pass', () => {
  const r = az('lint', mkdtempSync(join(tmpdir(), 'az-empty-')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no word packs/);
});

test("the repository's own words pass az lint", () => {
  const r = az('lint', join(ROOT, 'packages/words'));
  assert.equal(r.status, 0, r.stderr);
});

/* ---- migrate ------------------------------------------------------------- */

const CURRENT = 'az 1\nsite aurora\npage /\n';

test('GRAMMAR_VERSION is the version the compiler accepts', () => {
  assert.ok(compile(`az ${GRAMMAR_VERSION}\nsite a\npage /\n`, { manifests: new Map() }).diagnostics
    .every((d) => d.code !== 'AZ1021'));
  assert.ok(compile(`az ${GRAMMAR_VERSION + 1}\nsite a\npage /\n`, { manifests: new Map() }).diagnostics
    .some((d) => d.code === 'AZ1021'), 'CONTROL: the next version is rejected');
});

test('az migrate on a current file is a no-op and leaves it untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-mig-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, CURRENT, 'utf8');
  const r = az('migrate', file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already az 1 — nothing to migrate/);
  assert.equal(readFileSync(file, 'utf8'), CURRENT);
});

test('az migrate refuses a file with no marker or a newer grammar', () => {
  assert.deepEqual(migrate('site aurora\n'),
    { ok: false, message: 'no version marker — the first line must be: az 1' });
  const newer = migrate('az 7\nsite aurora\n');
  assert.equal(newer.ok, false);
  assert.match(newer.ok ? '' : newer.message, /written for az 7, newer than this compiler/);
});

test('steps apply in order from the file version to the target', () => {
  const steps = [
    { from: 1, migrate: (s: string) => s.replace('az 1', 'az 2').replace('hue', 'accent') },
    { from: 2, migrate: (s: string) => s.replace('az 2', 'az 3') + '# migrated\n' },
  ];
  const r = migrate('az 1\nsite a\n  theme midnight\n    hue violet\n', steps, 3);
  assert.deepEqual(r, {
    ok: true, from: 1, changed: true,
    source: 'az 3\nsite a\n  theme midnight\n    accent violet\n# migrated\n',
  });
});

test('CONTROL: a gap in the chain is reported, not skipped', () => {
  const r = migrate('az 1\nsite a\n', [{ from: 2, migrate: (s: string) => s }], 3);
  assert.deepEqual(r, { ok: false, message: 'no migration from az 1 to az 2' });
});
