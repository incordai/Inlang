/**
 * shipped.ts — the scan the build guard and `az audit` share
 * (word-quality-gate §4 rule 2, §5.5): every text file on disk, `public/`
 * copies and byte-read assets included; a package's published file judged by
 * key shape only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { scanText } from '../../core/src/secrets.ts';
import { removeOutput, shippedSecrets, walkShipped } from '../src/shipped.ts';

/** Shaped like a service key the guard refuses — planted, never real. */
const PLANTED = `sk_live_${'Q7w'.repeat(12)}`;
/** Dense like a compiled decoder: the entropy rule fires on it. */
const DENSE = 'aZ3kQ9pL2mX7vB4nC8rT1yU6wE5sD0fGhJkLzXcVbNmQwErTyUiOp';

/** A project folder: `dist` files and `node_modules` files, as given. */
function project(dist: Record<string, string>, packages: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-shipped-'));
  for (const [base, files] of [['dist', dist], ['node_modules', packages]] as const) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, base, path, '..'), { recursive: true });
      writeFileSync(join(dir, base, path), content);
    }
  }
  return dir;
}

async function scan(dir: string) {
  const tree = await walkShipped(join(dir, 'dist'));
  assert.ok(tree, 'dist is a folder');
  const r = await shippedSecrets(tree.files, join(dir, 'node_modules'), (text) => scanText(text));
  return { tree, ...r, where: r.hits.map((h) => `${h.path} (${h.finding.rule})`) };
}

test('a key in a file Vite copied from public/ is found, by path and shape', async () => {
  const dir = project({ 'index.html': '<p>hi</p>', 'assets/index-AbCd1234.js': 'console.log(1);', 'assets/notes.txt': `token ${PLANTED}\n` });
  const r = await scan(dir);
  assert.deepEqual(r.where, ['assets/notes.txt (secret-prefix)']);
});

test('a key in an asset Vite reads as bytes (a .js worker or decoder) is found', async () => {
  const dir = project({ 'assets/worker-AbCd1234.js': `self.k="${PLANTED}";` });
  assert.deepEqual((await scan(dir)).where, ['assets/worker-AbCd1234.js (secret-prefix)']);
});

test('CONTROL: a clean build has no finding; binary formats are not read', async () => {
  const dir = project({ 'index.html': '<p>hi</p>', 'assets/index-AbCd1234.js': 'console.log(1);', 'assets/a.png': PLANTED });
  const r = await scan(dir);
  assert.deepEqual(r.where, []);
  assert.deepEqual(r.tree.files.map((f) => f.path), ['assets/index-AbCd1234.js', 'index.html']);
});

test('a package\'s published file, shipped byte-for-byte, is judged by key shape only', async () => {
  const decoder = `var d="${DENSE}";`;
  const dir = project({ 'assets/draco_decoder-AbCd1234.js': decoder }, { 'pkg/libs/draco_decoder.js': decoder });
  const r = await scan(dir);
  assert.deepEqual(r.where, [], 'the entropy rule does not judge a published file');
  assert.deepEqual([...r.published], ['assets/draco_decoder-AbCd1234.js']);
});

test('a node_modules that is a link to a shared install is read through it, as the gate\'s sites use one', async () => {
  const decoder = `var d="${DENSE}";`;
  const shared = project({}, { 'pkg/libs/draco_decoder.js': decoder });
  const dir = project({ 'assets/draco_decoder-AbCd1234.js': decoder });
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  symlinkSync(join(shared, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const r = await scan(dir);
  assert.deepEqual(r.where, [], 'the published copy is found through the linked folder');
  // CONTROL: no install at all — the entropy rule judges it.
  rmSync(join(dir, 'node_modules'));
  assert.deepEqual((await scan(dir)).where, ['assets/draco_decoder-AbCd1234.js (entropy)']);
});

test('a planted key shape in a vendored decoder copy is still caught — byte-identical or not', async () => {
  const decoder = `var d="${DENSE}";var k="${PLANTED}";`;
  const same = project({ 'assets/draco_decoder-AbCd1234.js': decoder }, { 'pkg/libs/draco_decoder.js': decoder });
  assert.deepEqual((await scan(same)).where, ['assets/draco_decoder-AbCd1234.js (secret-prefix)']);
  // An edited copy is no package's file: every rule applies.
  const edited = project({ 'assets/draco_decoder-AbCd1234.js': decoder }, { 'pkg/libs/draco_decoder.js': `var d="${DENSE}";` });
  assert.deepEqual((await scan(edited)).where.sort(), ['assets/draco_decoder-AbCd1234.js (entropy)', 'assets/draco_decoder-AbCd1234.js (secret-prefix)']);
});

/* ---- a refused build's output ------------------------------------------- */

test('removeOutput: a refused build\'s output folder inside the project is removed, the project kept', async () => {
  const dir = project({ 'index.html': '<p>hi</p>', 'assets/notes.txt': `token ${PLANTED}\n` }, { 'pkg/index.js': '' });
  assert.equal(await removeOutput(dir, join(dir, 'dist')), null);
  assert.equal(existsSync(join(dir, 'dist')), false, 'the output folder is gone');
  assert.ok(existsSync(join(dir, 'node_modules/pkg/index.js')), 'CONTROL: the rest of the project is untouched');
  assert.equal(await removeOutput(dir, join(dir, 'dist')), null, 'an output folder never written is nothing to remove');
});

test('removeOutput: the project root itself, or a folder outside it, is never removed', async () => {
  const dir = project({ 'index.html': '<p>hi</p>' });
  const outside = project({ 'index.html': '<p>other</p>' });
  assert.match(await removeOutput(dir, dir) ?? '', /was left in place: it is not inside the project/);
  assert.match(await removeOutput(join(dir, 'dist'), join(dir, 'dist', '..')) ?? '', /was left in place: it is not inside the project/);
  assert.match(await removeOutput(dir, join(dir, '..', basename(outside), 'dist')) ?? '', /was left in place: it is not inside the project/);
  assert.ok(existsSync(join(dir, 'dist/index.html')) && existsSync(join(outside, 'dist/index.html')), 'nothing was removed');
});
