/**
 * CLI hardening — findings from the independent CLI/MCP review, each with
 * the input that broke it and a control that must keep working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, specOf } from '../src/az.ts';
import { compile } from '../../core/src/index.ts';
import { dev } from '../src/dev.ts';
import { serve } from '../src/serve.ts';
import { initBackendEnv } from '../src/backend-init.ts';
import { eject } from '../src/words.ts';
import { MANIFEST, writeProblem } from '../src/output.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const GOOD = 'az 1\nsite aurora\npage /\n  hero center\n    title "Built in the dark"\n';
const WITH_LOGO = 'az 1\nsite aurora\npage /\n  nav bar\n    logo ./assets/logo.svg\n  hero center\n    title "t"\n';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
/** Time for closed handles to leave the event loop's resource list. */
const SETTLE_MS = 200;

function project(source = GOOD) {
  const dir = mkdtempSync(join(tmpdir(), 'az-hard-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, source, 'utf8');
  return { dir, file, out: join(dir, 'out') };
}

const az = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv, BIN, ...args], {
  encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, timeout: 20_000,
});

/* ---- output: never overwrite what az did not write (#2, #12, #3) ---------- */

test('a build refuses to overwrite a file az did not generate, and writes nothing', () => {
  const p = project();
  mkdirSync(p.out);
  writeFileSync(join(p.out, 'package.json'), '{"name":"the-authors-own"}\n');
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false);
  assert.match(r.report, /'package\.json' exists and az did not generate it/);
  assert.equal(readFileSync(join(p.out, 'package.json'), 'utf8'), '{"name":"the-authors-own"}\n');
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')), 'nothing else was written either');
});

test('CONTROL: rebuilding az\'s own output replaces its files freely', () => {
  const p = project();
  assert.equal(build({ source: p.file, outDir: p.out, wordsDir: WORDS }).ok, true);
  writeFileSync(p.file, GOOD.replace('Built in the dark', 'Made to last'));
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  assert.match(readFileSync(join(p.out, 'src/App.tsx'), 'utf8'), /Made to last/);
  assert.ok(JSON.parse(readFileSync(join(p.out, MANIFEST), 'utf8')).files.includes('src/App.tsx'));
});

test('CONTROL: output written before manifests existed is still az\'s to rebuild', () => {
  const p = project();
  assert.equal(build({ source: p.file, outDir: p.out, wordsDir: WORDS }).ok, true);
  rmSync(join(p.out, MANIFEST));
  writeFileSync(p.file, GOOD.replace('Built in the dark', 'Made to last'));
  assert.equal(build({ source: p.file, outDir: p.out, wordsDir: WORDS }).ok, true);
});

test('a file az generated before and no longer does is removed; others are kept', () => {
  const p = project(WITH_LOGO);
  mkdirSync(join(p.dir, 'assets'));
  writeFileSync(join(p.dir, 'assets/logo.svg'), SVG);
  assert.equal(build({ source: p.file, outDir: p.out, wordsDir: WORDS }).ok, true);
  assert.ok(existsSync(join(p.out, 'public/assets/logo.svg')));
  writeFileSync(join(p.out, 'notes.txt'), 'mine');
  writeFileSync(p.file, GOOD);
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  assert.ok(!existsSync(join(p.out, 'public/assets/logo.svg')), 'the dropped asset no longer ships');
  assert.equal(readFileSync(join(p.out, 'notes.txt'), 'utf8'), 'mine', 'a file az never wrote is never deleted');
});

test('SECURITY: a build does not write through a symbolic link inside the output folder', (t) => {
  const p = project(WITH_LOGO);
  mkdirSync(join(p.dir, 'assets'));
  writeFileSync(join(p.dir, 'assets/logo.svg'), SVG);
  const outside = mkdtempSync(join(tmpdir(), 'az-elsewhere-'));
  mkdirSync(join(p.out, 'public'), { recursive: true });
  try {
    symlinkSync(outside, join(p.out, 'public/assets'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks not permitted here'); return; }
    throw e;
  }
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false);
  assert.match(r.report, /symbolic link/);
  assert.ok(!existsSync(join(outside, 'logo.svg')), 'nothing was copied outside');
});

test('SECURITY: a path outside the output folder is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'az-root-'));
  assert.match(writeProblem(root, '../escape') ?? '', /outside the output folder/);
  assert.match(writeProblem(root, join(tmpdir(), 'abs')) ?? '', /outside the output folder/);
  assert.equal(writeProblem(root, 'src/App.tsx'), null, 'CONTROL');
});

test('SECURITY: eject does not write through a linked words/ folder', (t) => {
  const p = project();
  const outside = mkdtempSync(join(tmpdir(), 'az-elsewhere-'));
  try {
    symlinkSync(outside, join(p.dir, 'words'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks not permitted here'); return; }
    throw e;
  }
  const r = eject('hero', p.dir, WORDS);
  assert.equal(r.ok, false);
  assert.ok(!existsSync(join(outside, 'hero')), 'nothing was written outside');
});

/* ---- az spec on a broken file (#10) --------------------------------------- */

test('az spec prints no Spec for a file with errors, and says why', () => {
  const p = project('az 1\nsite a\npage /\n  nonsense\n');
  assert.equal(specOf({ source: p.file, wordsDir: WORDS }).json, null);
  const r = az('spec', p.file);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /AZ12/);
});

test('CONTROL: az spec prints the Spec of a clean file', () => {
  const p = project();
  const r = az('spec', p.file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).site.name, 'aurora');
});

/* ---- az dev failure paths (#5) --------------------------------------------- */

test('az dev on a missing file reports it and exits, instead of hanging', () => {
  const r = az('dev', join(tmpdir(), 'no-such-site.az'), '--no-serve');
  assert.equal(r.error, undefined, 'it must exit on its own');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
});

test('--out with no folder is refused', () => {
  const p = project();
  const r = az('build', p.file, '--out');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out needs a folder/);
});

test('a rebuild after the source vanished is a failed build, not a crash', () => {
  const p = project();
  const h = dev({ source: p.file, outDir: p.out, wordsDir: WORDS, debounceMs: 1 });
  try {
    rmSync(p.file);
    const outcome = h.rebuild();
    assert.equal(outcome.ok, false);
    assert.match(outcome.report, /ENOENT|no such file/);
  } finally {
    h.close();
  }
});

/* ---- serving stops what it started when a later step fails (#6) --------- */

test('a failed dev start leaves no server listening', async () => {
  const p = project();
  mkdirSync(join(p.dir, '.az-dev'), { recursive: true });
  // A provider named but not configured: the dev backend refuses to start —
  // after the mailbox is already listening.
  writeFileSync(join(p.dir, '.az-dev/backend.env'), 'AZ_OAUTH_PROVIDERS=broken\n');
  const listening = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length;
  const before = listening();
  await assert.rejects(serve({
    source: p.file, outDir: p.out, sitePort: 0, open: false, backend: { siteName: 'aurora' }, print: () => {},
  }));
  // A closed handle leaves the list on a later turn of the event loop.
  await new Promise((settled) => setTimeout(settled, SETTLE_MS));
  assert.equal(listening(), before, `the mailbox was closed; open: ${process.getActiveResourcesInfo().join(', ')}`);
});

/* ---- migrate and the compiler agree on the version marker (#19) --------- */

test('az migrate does not read `az 01` as version 1 — the compiler refuses it', () => {
  const p = project('az 01\nsite a\npage /\n');
  const r = az('migrate', p.file);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /already az 1/);
  assert.ok(compile('az 01\nsite a\npage /\n', { manifests: new Map() }).diagnostics
    .some((d) => d.code === 'AZ1021'), 'CONTROL: the compiler refuses it');
});

/* ---- backend init on a corrupt config (#18) -------------------------------- */

test('backend init on a corrupt az.config.json explains, instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-server-'));
  writeFileSync(join(dir, 'az.config.json'), '{ not json');
  const r = initBackendEnv(dir);
  assert.equal(r.ok, false);
  assert.ok(!existsSync(join(dir, '.env')));
});

test('CLI commands on bad paths answer with a message, not a stack trace', () => {
  const missing = join(tmpdir(), 'no-such-site.az');
  for (const args of [['migrate', missing], ['lint', missing], ['mcp', '--root', join(tmpdir(), 'no-such-dir')]]) {
    const r = az(...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.doesNotMatch(r.stderr, /\n\s+at /, `${args.join(' ')} printed a stack trace:\n${r.stderr}`);
  }
});
