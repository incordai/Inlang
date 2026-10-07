/**
 * `site icon` through the real build (GRAMMAR §4.4): the file is read
 * through the asset sandbox, its format from its bytes (AZ1421 otherwise),
 * copied with the assets and declared with its type on every page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/az.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

/** A PNG's signature and IHDR chunk header — what the sniff reads. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 64]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12"/></svg>\n';

function project(icon: string, files: Record<string, Uint8Array | string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-site-icon-'));
  writeFileSync(join(dir, 'site.az'), `az 1\nsite aurora\n  icon ${icon}\npage /\npage /about\n`, 'utf8');
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  return { dir, file: join(dir, 'site.az'), out: join(dir, 'out') };
}
const run = (p: { file: string; out: string }) => build({ source: p.file, outDir: p.out, wordsDir: WORDS, imageCache: null });

test('an SVG icon is copied with the assets and declared on every page, typed from its bytes', () => {
  const p = project('./brand/icon.svg', { 'brand/icon.svg': SVG });
  const r = run(p);
  assert.equal(r.ok, true, r.report);
  assert.equal(readFileSync(join(p.out, 'public/brand/icon.svg'), 'utf8'), SVG);
  for (const page of ['index.html', 'about/index.html']) {
    assert.match(readFileSync(join(p.out, page), 'utf8'), /<link rel="icon" type="image\/svg\+xml" href="\/brand\/icon\.svg" \/>/, page);
  }
});

test('a PNG icon is declared image/png', () => {
  const p = project('./icon.png', { 'icon.png': PNG });
  const r = run(p);
  assert.equal(r.ok, true, r.report);
  assert.match(readFileSync(join(p.out, 'index.html'), 'utf8'), /<link rel="icon" type="image\/png" href="\/icon\.png" \/>/);
});

test('AZ1421 at the icon line: a GIF named .png, an SVG named .png, a missing file — and nothing is written', () => {
  const cases: [string, Record<string, Uint8Array | string>, RegExp][] = [
    ['./icon.png', { 'icon.png': 'GIF89a\x01\x00\x01\x00' }, /is not a PNG or an SVG file/],
    ['./icon.png', { 'icon.png': SVG }, /is an SVG file — name it \.svg/],
    ['./icon.svg', {}, /can't be read/],
    ['./brand', { 'brand/x.txt': 'not an icon' }, /AZ1410 {2}site: 'brand' is not a icon file — use \.png, \.svg/],
  ];
  for (const [icon, files, message] of cases) {
    const p = project(icon, files);
    const r = run(p);
    assert.equal(r.ok, false, icon);
    assert.match(r.report, message, r.report);
    assert.ok(!existsSync(join(p.out, 'index.html')), 'a failed build writes nothing');
  }
  const r = run(project('./icon.png', { 'icon.png': 'GIF89a' }));
  assert.match(r.report, /site\.az:3:8 error AZ1421 {2}site: icon '\.\/icon\.png'/);
});

test('AZ1421 for a directory named like an icon — not a file, so not read', () => {
  const p = project('./icon.svg', { 'icon.svg/inner.txt': 'x' });
  const r = run(p);
  assert.equal(r.ok, false);
  assert.match(r.report, /AZ1421 {2}site: icon '\.\/icon\.svg' can't be read/);
});

test('SECURITY: an icon path that leaves the project is refused before anything is read (AZ1210)', () => {
  for (const icon of ['../outside.png', './brand/../../outside.png']) {
    const r = run(project(icon));
    assert.equal(r.ok, false, icon);
    assert.match(r.report, /AZ1210 {2}site: '[./a-z]+outside\.png' points outside the project/, r.report);
    assert.doesNotMatch(r.report, /AZ1421/, 'the reader is never reached');
  }
});
