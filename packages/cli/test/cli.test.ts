/**
 * CLI tests — build, dev, exit codes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync } from 'node:fs';
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

/** Resolve once `count` results have arrived, or fail after DEV_TIMEOUT_MS. */
function results(count: number, seen: () => number): Promise<void> {
  return new Promise((done, fail) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (seen() >= count) { clearInterval(tick); done(); }
      else if (Date.now() - started > DEV_TIMEOUT_MS) {
        clearInterval(tick);
        fail(new Error(`timed out waiting for ${count} builds; saw ${seen()}`));
      }
    }, 10);
  });
}

test('dev rebuilds after a save that renames a temp file over the source', async () => {
  // How vim and many IDEs save. A watch on the file itself follows the old
  // inode and never hears about the new one.
  const p = project(GOOD);
  let builds = 0;
  const h = dev({ source: p.file, outDir: p.out, wordsDir: WORDS, onResult: () => builds++ });
  try {
    await results(1, () => builds);
    for (const [n, title] of [[2, 'Made to last'], [3, 'Made again']] as const) {
      const tmp = join(p.dir, `.site.az.${n}.tmp`);
      writeFileSync(tmp, GOOD.replace('Built in the dark', title), 'utf8');
      renameSync(tmp, p.file);
      await results(n, () => builds);
      assert.match(readFileSync(join(p.out, 'src/App.tsx'), 'utf8'), new RegExp(title),
        `save ${n - 1} must be built`);
    }
  } finally {
    h.close();
  }
});

/* ---- the real binary: what a user actually types ---------------------- */

const BIN = join(ROOT, 'packages/cli/bin/az.js');
const DEV_TIMEOUT_MS = 10_000;

function runBin(args: string[]) {
  return spawnSync(process.execPath, [...process.execArgv, BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AZ_WORDS: WORDS },
  });
}

test('an unknown command fails instead of falling through to check', () => {
  const p = project(GOOD);
  const r = runBin(['biuld', p.file]);
  assert.equal(r.status, EXIT.config, r.stderr);
  assert.match(r.stderr, /unknown command "biuld"/);
  assert.doesNotMatch(r.stdout, /no problems found/, 'a typo must not read as success');
});

test('CONTROL: a known command still runs through the binary', () => {
  const p = project(GOOD);
  const r = runBin(['check', p.file]);
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.match(r.stdout, /no problems found/);
});

test('az dev builds, rebuilds on save, and exits cleanly on SIGINT', async () => {
  const p = project(GOOD);
  // --no-serve: this is the compile-and-watch loop; serving is test:dev's.
  const child = spawn(process.execPath, [...process.execArgv, BIN, 'dev', p.file, '--out', p.out, '--no-serve'], {
    env: { ...process.env, AZ_WORDS: WORDS },
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  const lines = (n: number) => new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`timed out waiting for ${n} builds; got:\n${stdout}`)), DEV_TIMEOUT_MS);
    const check = () => {
      if ((stdout.match(/files in/g) ?? []).length >= n) { clearTimeout(timer); done(); }
    };
    child.stdout.on('data', (chunk: string) => { stdout += chunk; check(); });
    check();
  });
  try {
    await lines(1);
    assert.ok(existsSync(join(p.out, 'src/App.tsx')), 'the first build must write output');
    writeFileSync(p.file, GOOD.replace('Built in the dark', 'Made to last'), 'utf8');
    await lines(2);
    assert.match(readFileSync(join(p.out, 'src/App.tsx'), 'utf8'), /Made to last/);
  } finally {
    const exited = new Promise<number | null>((done) => child.once('exit', done));
    child.kill('SIGINT');
    assert.equal(await exited, EXIT.ok, 'Ctrl-C must close the watcher and exit 0');
  }
});

/* ---- assets: referenced files reach the built project ----------------- */

const WITH_LOGO = 'az 1\nsite aurora\npage /\n  nav bar\n    logo ./assets/logo.svg\n  hero center\n    title "Built in the dark"\n';
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

function withAsset(source: string) {
  const p = project(source);
  mkdirSync(join(p.dir, 'assets'));
  writeFileSync(join(p.dir, 'assets/logo.svg'), LOGO_SVG, 'utf8');
  return p;
}

test('a referenced asset is copied into public/ and linked from the site root', () => {
  const p = withAsset(WITH_LOGO);
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  assert.deepEqual(r.assets, ['assets/logo.svg']);
  assert.equal(readFileSync(join(p.out, 'public/assets/logo.svg'), 'utf8'), LOGO_SVG);
  // Root-relative: a relative URL would break on every route below `/`.
  assert.match(readFileSync(join(p.out, 'src/App.tsx'), 'utf8'), /"\/assets\/logo\.svg"/);
});

test('CONTROL: a site with no assets writes no public/ directory', () => {
  const p = project(GOOD);
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  assert.deepEqual(r.assets, []);
  assert.ok(!existsSync(join(p.out, 'public')));
});

test('a missing asset fails the build and writes nothing', () => {
  const p = project(WITH_LOGO);
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false);
  assert.notEqual(r.exit, EXIT.ok);
  assert.match(r.report, /'\.\/assets\/logo\.svg' does not exist/);
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')), 'a failed build must not write output');
});

test('SECURITY: a symlinked asset that resolves outside the project is refused', (t) => {
  const p = project(WITH_LOGO);
  const outside = mkdtempSync(join(tmpdir(), 'az-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'do not publish', 'utf8');
  mkdirSync(join(p.dir, 'assets'));
  try {
    symlinkSync(join(outside, 'secret.txt'), join(p.dir, 'assets/logo.svg'));
  } catch (e) {
    // Creating symlinks needs a privilege some Windows accounts lack; without
    // one the attack this test models cannot be set up either.
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks not permitted here'); return; }
    throw e;
  }
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false, 'a symlink escape must not build');
  assert.match(r.report, /resolves outside the project/);
  assert.ok(!existsSync(join(p.out, 'public')), 'the outside file must not be copied');
});
