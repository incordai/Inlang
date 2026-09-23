/**
 * The escape hatch through the CLI — ROADMAP M3.
 *
 * `raw` / `slot` modules are copied into the generated project through the
 * same sandbox as assets, and `az eject` hands a word to the project: the
 * build then uses the project's copy, edits and all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, EXIT } from '../src/az.ts';
import { eject } from '../src/words.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const COMPONENT = 'export default function Badge() { return null; }\n';

function project(source: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-m3-'));
  writeFileSync(join(dir, 'site.az'), source, 'utf8');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text, 'utf8');
  }
  return { dir, file: join(dir, 'site.az'), out: join(dir, 'out') };
}

const SITE = 'az 1\nsite aurora\npage /\n  hero center\n    title "Built in the dark"\n    slot after ./custom/Ticker.tsx\n  raw ./custom/Badge.tsx\n';

/* ---- components are copied, sandboxed ---------------------------------- */

test('raw and slot modules are copied where the App imports them', () => {
  const p = project(SITE, { 'custom/Badge.tsx': COMPONENT, 'custom/Ticker.tsx': COMPONENT });
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  for (const m of ['custom/Badge.tsx', 'custom/Ticker.tsx']) {
    assert.equal(readFileSync(join(p.out, 'src/user', m), 'utf8'), COMPONENT);
  }
});

test('a missing component fails the build and writes nothing', () => {
  const p = project(SITE, { 'custom/Badge.tsx': COMPONENT });
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false);
  assert.match(r.report, /component: '\.\/custom\/Ticker\.tsx' does not exist/);
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')));
});

test('SECURITY: a symlinked component that resolves outside the project is refused', (t) => {
  const p = project(SITE, { 'custom/Ticker.tsx': COMPONENT });
  const outside = mkdtempSync(join(tmpdir(), 'az-outside-'));
  writeFileSync(join(outside, 'steal.tsx'), 'export default () => null;\n', 'utf8');
  try {
    symlinkSync(join(outside, 'steal.tsx'), join(p.dir, 'custom/Badge.tsx'));
  } catch (e) {
    // Symlinks need a privilege some Windows accounts lack; without one the
    // attack this models cannot be set up either.
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks not permitted here'); return; }
    throw e;
  }
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false);
  assert.match(r.report, /component: '\.\/custom\/Badge\.tsx' resolves outside the project/);
  assert.ok(!existsSync(join(p.out, 'src/user')), 'nothing is copied');
});

/* ---- az eject ------------------------------------------------------------ */

const HERO_SITE = 'az 1\nsite aurora\npage /\n  hero center\n    title "Built in the dark"\n';
const app = (out: string) => readFileSync(join(out, 'src/App.tsx'), 'utf8');

test('eject copies the word with its imports pointed at a carried copy of the contract', () => {
  const p = project(HERO_SITE);
  const r = eject('hero', p.dir, WORDS);
  assert.ok(r.ok, r.ok ? '' : r.message);
  const emitter = readFileSync(join(p.dir, 'words/hero/emit.web.ts'), 'utf8');
  assert.match(emitter, /from '\.\.\/_az\/emit-contract\.ts'/);
  assert.match(emitter, /from '\.\.\/_az\/spec-block\.ts'/);
  assert.doesNotMatch(emitter, /\.\.\/\.\.\/core\//, 'no import still reaches into the compiler');
  for (const f of ['words/hero/word.json', 'words/_az/emit-contract.ts', 'words/_az/spec-block.ts']) {
    assert.ok(existsSync(join(p.dir, f)), f);
  }
});

test('the ejected word still builds, and it is the one the build uses', () => {
  const p = project(HERO_SITE);
  const control = build({ source: p.file, outDir: join(p.dir, 'before'), wordsDir: WORDS });
  assert.equal(control.ok, true, control.report);
  // The class attribute also carries the generated style class (az.css).
  assert.match(app(join(p.dir, 'before')), /"az-hero-title[ "]/, 'CONTROL: the bundled hero before eject');

  assert.ok(eject('hero', p.dir, WORDS).ok);
  const copy = join(p.dir, 'words/hero/emit.web.ts');
  writeFileSync(copy, readFileSync(copy, 'utf8').replace(/'az-hero-title'/g, "'studio-title'"), 'utf8');

  const after = build({ source: p.file, outDir: join(p.dir, 'after'), wordsDir: WORDS });
  assert.equal(after.ok, true, after.report);
  assert.match(app(join(p.dir, 'after')), /"studio-title[ "]/, 'the edit to the ejected copy is what renders');
  assert.doesNotMatch(app(join(p.dir, 'after')), /"az-hero-title[ "]/);
});

test('eject refuses to overwrite, an unknown word, and a name that is a path', () => {
  const p = project(HERO_SITE);
  assert.ok(eject('hero', p.dir, WORDS).ok);
  const again = eject('hero', p.dir, WORDS);
  assert.ok(!again.ok && /already exists/.test(again.message));
  const unknown = eject('carousel', p.dir, WORDS);
  assert.ok(!unknown.ok && /there is no word 'carousel'/.test(unknown.message));
  const path = eject('../hero', p.dir, WORDS);
  assert.ok(!path.ok && /is not a word name/.test(path.message));
});

test('az eject says, loudly, that it is one-way — and the ejected word passes az lint', () => {
  const p = project(HERO_SITE);
  const r = spawnSync(process.execPath, [...process.execArgv, BIN, 'eject', 'hero', '--dir', p.dir],
    { encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS } });
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.match(r.stdout, /This is ONE-WAY\./);
  assert.match(r.stdout, /wrote words\/hero\/emit\.web\.ts/);
  const lint = spawnSync(process.execPath, [...process.execArgv, BIN, 'lint', join(p.dir, 'words')],
    { encoding: 'utf8' });
  assert.equal(lint.status, EXIT.ok, lint.stderr);
});
