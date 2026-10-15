/**
 * `az dev`'s preview of a partial file, at the CLI (docs/partial-preview.md):
 * the banner, the control that `az build` and `az check` are unchanged, and
 * a watch loop that keeps compiling while the file keeps changing. The
 * browser run is scripts/dev-e2e.mjs (`pnpm test:dev`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, EXIT } from '../src/az.ts';
import { dev, devLine } from '../src/dev.ts';
import { PREVIEW_ATTR, bannerHtml } from '../src/preview-banner.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const FULL = `az 1
site studio
  footer
    link "Work" /work

page /
  hero center
    title "Made by hand"

  text
    title "The bench"
    body  "Every pair, one bench."

page /work
  text
    title "Work"
    body  "Selected pieces."
`;
/** Cut in the second section: its body is not written yet. */
const PARTIAL = FULL.slice(0, FULL.indexOf('    body  "Every'));
const STORM_MS = 1_200;
const STORM_EVERY_MS = 10;
/**
 * A debounce longer than the gap between the storm's change events, however
 * the platform batches them, so every event restarts it: the case the cap
 * exists for. Without it, nothing compiled until the saves stopped.
 */
const STORM_DEBOUNCE_MS = 300;
const WAIT_MS = 10_000;

function project(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'az-preview-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, source, 'utf8');
  return { dir, file, out: join(dir, 'out') };
}

/** Every file under `dir`, relative, with its bytes. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

const runBin = (args: string[]) => spawnSync(process.execPath, [...process.execArgv, BIN, ...args], {
  encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS },
});

test('a preview build renders the whole blocks, and every page says it is still being written', () => {
  const p = project(PARTIAL);
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS, preview: true });
  assert.equal(r.ok, false, 'a preview is not a successful build');
  assert.ok(r.preview, r.report);
  assert.equal(r.preview.cutLine, 10, 'stops before the unfinished text block');
  assert.equal(r.preview.errors, 2, r.report);
  const app = readFileSync(join(p.out, 'src/App.tsx'), 'utf8');
  assert.match(app, /Made by hand/, 'the finished hero renders');
  assert.doesNotMatch(app, /The bench/, 'the unfinished text block does not');
  const html = readFileSync(join(p.out, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`<aside ${PREVIEW_ATTR} role="status"`));
  assert.match(html, /Still writing — 2 problems · preview stops before line 10/);
  assert.match(html, /site\.az:10:3 AZ1207 text: &#39;body&#39; is required/, 'each problem with its file:line');
  assert.match(html, /site\.az:4:\d+ AZ2081/, 'the link to the page not written yet is listed');
  assert.match(devLine(r, 1), /^az: still writing — 2 problems · preview stops before line 10; first: .*site\.az:4:\d+ error AZ2081/);
});

test('the banner escapes diagnostic text — it quotes the author', () => {
  const p = project(`${FULL.slice(0, FULL.indexOf('page /work'))}page /work\n  "<img src=x onerror=alert(1)>"\n`);
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS, preview: true });
  assert.ok(r.preview, r.report);
  const html = readFileSync(join(p.out, 'index.html'), 'utf8');
  assert.match(r.report, /<img src=x onerror=alert\(1\)>/, 'CONTROL: the message quotes the raw input');
  assert.doesNotMatch(html, /<img/, 'no author markup reaches the page');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const banner = bannerHtml([{ code: 'AZ1', message: '</aside><script>x</script>', pos: { line: 1, col: 1 }, severity: 'error' }], 'a"b.az', 2);
  assert.doesNotMatch(banner, /<script|<\/aside><|a"b/);
});

test('a complete file builds byte-identically with or without preview, and carries no banner', () => {
  const p = project(FULL);
  const strict = build({ source: p.file, outDir: join(p.dir, 'strict'), wordsDir: WORDS });
  const preview = build({ source: p.file, outDir: join(p.dir, 'preview'), wordsDir: WORDS, preview: true });
  assert.equal(strict.ok, true, strict.report);
  assert.deepEqual(preview, strict, 'the same outcome');
  assert.deepEqual(tree(join(p.dir, 'preview')), tree(join(p.dir, 'strict')), 'the same bytes');
  assert.doesNotMatch(readFileSync(join(p.dir, 'preview', 'index.html'), 'utf8'), new RegExp(PREVIEW_ATTR));
});

test('CONTROL: az build and az check on a partial file fail exactly as before and write nothing', () => {
  const p = project(PARTIAL);
  const plain = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(plain.ok, false);
  assert.equal(plain.preview, undefined);
  assert.equal(plain.files.length, 0);
  for (const cmd of ['build', 'check']) {
    const r = runBin([cmd, p.file, '--out', p.out]);
    assert.equal(r.status, EXIT.missing, `${cmd}: ${r.stderr}`);
    assert.equal(r.stderr, `${plain.report}\n`, `${cmd}: the strict report, unchanged`);
    assert.doesNotMatch(r.stdout + r.stderr, /still writing/);
  }
  assert.equal(existsSync(p.out), false, 'nothing written');
});

test('dev keeps compiling while the file keeps changing, and the last compile is the last save', async () => {
  const p = project(FULL);
  const seen: number[] = [];
  const h = dev({
    source: p.file, outDir: p.out, wordsDir: WORDS, debounceMs: STORM_DEBOUNCE_MS,
    onResult: () => seen.push(performance.now()),
  });
  const started = performance.now();
  let n = 0;
  try {
    // Saves every 10ms for 1.2s, as an AI writing in chunks saves.
    while (performance.now() - started < STORM_MS) {
      writeFileSync(p.file, FULL.replace('Made by hand', `Made by hand ${++n}`), 'utf8');
      await new Promise((r) => setTimeout(r, STORM_EVERY_MS));
    }
    const during = seen.filter((t) => t > started && t <= started + STORM_MS).length;
    assert.ok(during >= 3, `${during} compiles during ${STORM_MS}ms of saves`);
    const until = performance.now() + WAIT_MS;
    while (!readFileSync(join(p.out, 'src/App.tsx'), 'utf8').includes(`Made by hand ${n}"`) && performance.now() < until) {
      await new Promise((r) => setTimeout(r, STORM_EVERY_MS));
    }
    assert.match(readFileSync(join(p.out, 'src/App.tsx'), 'utf8'), new RegExp(`Made by hand ${n}"`), 'latest wins');
  } finally {
    h.close();
  }
});
