/**
 * CLI tests — build, dev, exit codes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, EXIT } from '../src/az.ts';
import { dev, devLine } from '../src/dev.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const GOOD = 'az 1\nsite aurora\npage /\n  hero center\n    title "Built in the dark"\n';

function project(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'az-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, source, 'utf8');
  return { dir, file, out: join(dir, 'out') };
}

test('build writes a runnable project', () => {
  const p = project(GOOD);
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  assert.equal(r.exit, EXIT.ok);
  for (const f of ['index.html', 'src/App.tsx', 'src/main.tsx']) {
    assert.ok(existsSync(join(p.out, f)), `missing ${f}`);
  }
});

test('a broken file fails with a non-zero exit and writes nothing', () => {
  const p = project('az 1\nsite a\npage /\n  hero center split\n    title "Hi"\n');
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false);
  assert.notEqual(r.exit, EXIT.ok);
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')), 'a failed build must not write output');
  assert.match(r.report, /AZ1202/);
});

test('the report names the file, line and column', () => {
  const p = project('az 1\nsite a\npage /\n  nonsense\n');
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.match(r.report, /site\.az:4:3/, r.report);
});

test('an asset path escaping the project is refused', () => {
  const p = project('az 1\nsite a\npage /\n  hero center 3d\n    title "Hi"\n    model ../../../etc/passwd\n');
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false, 'a path escape must not build');
});

test('DETERMINISM: two builds of one source write identical bytes', () => {
  const p = project(GOOD);
  build({ source: p.file, outDir: join(p.dir, 'a'), wordsDir: WORDS });
  build({ source: p.file, outDir: join(p.dir, 'b'), wordsDir: WORDS });
  for (const f of ['index.html', 'src/App.tsx', 'src/runtime.tsx']) {
    assert.equal(
      readFileSync(join(p.dir, 'a', f), 'utf8'),
      readFileSync(join(p.dir, 'b', f), 'utf8'),
      `${f} differs between builds`,
    );
  }
});

test('CONTROL: a changed source writes different bytes', () => {
  const p = project(GOOD);
  build({ source: p.file, outDir: join(p.dir, 'a'), wordsDir: WORDS });
  writeFileSync(p.file, GOOD.replace('Built in the dark', 'Made to last'), 'utf8');
  build({ source: p.file, outDir: join(p.dir, 'b'), wordsDir: WORDS });
  assert.notEqual(
    readFileSync(join(p.dir, 'a', 'src/App.tsx'), 'utf8'),
    readFileSync(join(p.dir, 'b', 'src/App.tsx'), 'utf8'),
  );
});

test('dev compiles once on start', () => {
  const p = project(GOOD);
  let calls = 0;
  const h = dev({ source: p.file, outDir: p.out, wordsDir: WORDS, onResult: () => calls++ });
  h.close();
  assert.equal(calls, 1, 'dev must build immediately, not only on the first change');
  assert.ok(existsSync(join(p.out, 'src/App.tsx')));
});

test('dev rebuilds and picks up the change', () => {
  const p = project(GOOD);
  const h = dev({ source: p.file, outDir: p.out, wordsDir: WORDS });
  writeFileSync(p.file, GOOD.replace('Built in the dark', 'Grown in the dark'), 'utf8');
  const r = h.rebuild();
  h.close();
  assert.equal(r.ok, true, r.report);
  assert.match(readFileSync(join(p.out, 'src/App.tsx'), 'utf8'), /Grown in the dark/);
});

test('a failed rebuild reports the error rather than silently keeping stale output', () => {
  const p = project(GOOD);
  const h = dev({ source: p.file, outDir: p.out, wordsDir: WORDS });
  writeFileSync(p.file, 'az 1\nsite a\npage /\n  hero center split\n    title "Hi"\n', 'utf8');
  const r = h.rebuild();
  h.close();
  assert.equal(r.ok, false, 'the failure must be reported');
  assert.match(devLine(r, 1), /AZ1202/, 'and it must reach the terminal line');
});

test('devLine reports the file count and timing on success', () => {
  const p = project(GOOD);
  const h = dev({ source: p.file, outDir: p.out, wordsDir: WORDS });
  const outcome = h.rebuild();
  const line = devLine(outcome, 12.3);
  h.close();
  // Assert the count REPORTED equals the count BUILT, rather than a literal.
  // Pinning it to 5 meant adding package.json/tsconfig/vite.config to the
  // scaffold broke a test that was never about how many files there are.
  assert.ok(line.includes(`${outcome.files.length} files in 12.3ms`), line);
  assert.ok(outcome.files.length > 1, 'CONTROL: a real project has several files');
});
