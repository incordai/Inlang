/**
 * `az build` refuses to write a project whose environment would inline a
 * service key — auth-block-spec §4 rule 1, before the generated build's own
 * guard runs. Unsuppressible: build() takes no option for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/az.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const SITE = 'az 1\nsite a\npage /\n  hero center\n    title "x"\n';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'az-secret-'));
  writeFileSync(join(dir, 'site.az'), SITE);
  return { dir, source: join(dir, 'site.az'), out: join(dir, 'out') };
}

/** Run with extra environment variables, restoring the process env after. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const before = { ...process.env };
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
}

test('a service key in the environment fails the build and writes nothing', () => {
  const p = project();
  const r = withEnv({ AZ_PUBLIC_SERVICE_KEY: 'x'.repeat(40) }, () => build({ source: p.source, outDir: p.out, wordsDir: WORDS }));
  assert.equal(r.ok, false);
  assert.match(r.report, /'AZ_PUBLIC_SERVICE_KEY' is a service key and would be readable in the shipped bundle/);
  assert.ok(!r.report.includes('x'.repeat(40)), 'the value itself is never printed');
  assert.ok(!existsSync(p.out));
});

test('a service key in the .env Vite loads — the generated project\'s own — fails the build too', () => {
  const p = project();
  // The output folder is the generated project, Vite's root, so its .env
  // files are the ones a build inlines from.
  mkdirSync(p.out, { recursive: true });
  writeFileSync(join(p.out, '.env.production'), 'AZ_PUBLIC_SECRET_TOKEN="abc"\n');
  const r = build({ source: p.source, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, false);
  assert.match(r.report, /'AZ_PUBLIC_SECRET_TOKEN' is a service key/);
});

test('CONTROL: a .env beside the source is never read by the build, so it does not block it', () => {
  const p = project();
  writeFileSync(join(p.dir, '.env.production'), 'AZ_PUBLIC_SECRET_TOKEN="abc"\n');
  const r = build({ source: p.source, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
});

test('CONTROL: a private variable WITHOUT the public prefix is not inlined, so it passes', () => {
  const p = project();
  const r = withEnv({ SERVICE_KEY: 'x'.repeat(40) }, () => build({ source: p.source, outDir: p.out, wordsDir: WORDS }));
  assert.equal(r.ok, true, r.report);
  // Every site carries the guard, and the scanner it imports.
  assert.equal(readFileSync(join(p.out, 'az-vite/secrets.ts'), 'utf8'),
    readFileSync(join(ROOT, 'packages/core/src/secrets.ts'), 'utf8'));
  // And the walk the guard reads its output back with — az audit's own.
  assert.equal(readFileSync(join(p.out, 'az-vite/shipped.ts'), 'utf8'),
    readFileSync(join(ROOT, 'packages/cli/src/shipped.ts'), 'utf8'));
  // And the page policy, with the page scanner it imports and the scanner's table.
  for (const f of ['csp.ts', 'html-scan.ts', 'named-references.ts']) {
    assert.equal(readFileSync(join(p.out, `az-vite/${f}`), 'utf8'), readFileSync(join(ROOT, `packages/target-web/src/${f}`), 'utf8'), f);
  }
  assert.ok(!existsSync(join(p.out, 'src/az-auth')), 'no auth runtime for a site without auth');
});
