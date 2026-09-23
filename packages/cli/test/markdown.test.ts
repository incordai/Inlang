/**
 * `text` body files through the CLI — text-spec §5, §10: the file is read
 * through the project sandbox, its warnings reach the report, and its errors
 * stop the build before anything is written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/az.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

const SITE = `az 1
site bench
page /
  hero center
    title "Built slowly"
  text prose
    title "Why oak"
    body ./content/about.md
`;

function project(body: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'az-md-'));
  writeFileSync(join(dir, 'site.az'), SITE, 'utf8');
  mkdirSync(join(dir, 'content'), { recursive: true });
  if (body !== null) writeFileSync(join(dir, 'content/about.md'), body, 'utf8');
  return { dir, file: join(dir, 'site.az'), out: join(dir, 'out') };
}
const run = (p: { file: string; out: string }) => build({ source: p.file, outDir: p.out, wordsDir: WORDS });
const app = (p: { out: string }) => readFileSync(join(p.out, 'src/App.tsx'), 'utf8');

test('a .md body builds into the page, and its §10 warnings reach the report', () => {
  const p = project('# Our story\n\nOak, *slowly*. <b onclick="x()">bold</b>\n\n![A bench](bench.webp)\n');
  writeFileSync(join(p.dir, 'content/bench.webp'), 'x');
  const r = run(p);
  assert.equal(r.ok, true, r.report);
  assert.match(app(p), /"tag": "h3"/);
  assert.match(app(p), /Oak, /);
  assert.doesNotMatch(app(p), /onclick|about\.md/);
  assert.ok(existsSync(join(p.out, 'public/content/bench.webp')), 'the image shipped');
  assert.match(r.report, /warning: text: '# Our story' becomes an h3 — the page h1 belongs to the hero/);
  assert.match(r.report, /warning: text: html in 'about\.md' is stripped/);
});

test('SECURITY: a javascript: link stops the build and nothing is written', () => {
  const p = project('[Order](javascript:alert(1))\n');
  const r = run(p);
  assert.equal(r.ok, false);
  assert.match(r.report, /text: 'javascript:' link in 'about\.md' is not allowed/);
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')));
});

test('a missing body file stops the build with its path', () => {
  const r = run(project(null));
  assert.equal(r.ok, false);
  assert.match(r.report, /text: '\.\/content\/about\.md' does not exist/);
});

test('SECURITY: a body file symlinked outside the project is refused', (t) => {
  const p = project(null);
  const outside = mkdtempSync(join(tmpdir(), 'az-outside-'));
  writeFileSync(join(outside, 'secret.md'), 'secret words\n', 'utf8');
  try {
    symlinkSync(join(outside, 'secret.md'), join(p.dir, 'content/about.md'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks not permitted here'); return; }
    throw e;
  }
  const r = run(p);
  assert.equal(r.ok, false);
  assert.match(r.report, /outside the project/);
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')));
});
