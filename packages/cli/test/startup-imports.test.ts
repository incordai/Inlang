/**
 * What `az build` and `az check` import: only what compiling needs. Every
 * module that one other command alone uses — az dev's watcher and servers,
 * az mcp, az doctor, az audit, az lint, az palette's page, az prompt — is
 * loaded by that command when it runs (az.ts `later`), so a cold build never
 * pays to load it (m1-exit's CPU budget). The list is read from the real
 * process through a load hook (loaded-modules.mjs), dynamic imports included.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT_URL = pathToFileURL(ROOT).href;
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const WORDS = join(ROOT, 'packages/words');
const LOADED = pathToFileURL(join(ROOT, 'packages/cli/test/loaded-modules.mjs')).href;
/** A build of the fixture takes about a second; far under this. */
const RUN_MS = 60_000;

/** Modules only other commands need: a path under packages/, or a node built-in. */
const OTHER_COMMANDS_ONLY = [
  'packages/cli/src/dev.ts', 'packages/cli/src/serve.ts', 'packages/cli/src/dev-backend.ts',
  'packages/cli/src/mcp.ts', 'packages/mcp/src/',
  'packages/cli/src/doctor.ts', 'packages/cli/src/doctor-checks.ts', 'packages/cli/src/doctor-compile.ts',
  'packages/cli/src/audit.ts', 'packages/cli/src/audit-site.ts',
  'packages/cli/src/lint.ts', 'packages/theme/src/theme-reads.ts',
  'packages/cli/src/palette-page.ts', 'packages/core/src/prompt.ts',
  'packages/backend/src/server/app.ts', 'packages/backend/src/server/http.ts', 'packages/backend/src/server/db.ts',
  'node:http', 'node:net', 'node:readline', 'node:worker_threads',
];

function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'az-imports-'));
  cpSync(join(ROOT, 'packages/core/test/fixture-site.az'), join(dir, 'site.az'));
  cpSync(join(ROOT, 'packages/core/test/fixture-assets'), dir, { recursive: true });
  return dir;
}

/** Every module `az <args>` loads: repository paths relative to the root, built-ins as `node:x`. */
function modulesOf(cwd: string, args: string[]): string[] {
  const list = join(mkdtempSync(join(tmpdir(), 'az-imports-list-')), 'modules.txt');
  const r = spawnSync(process.execPath, [...process.execArgv, '--import', LOADED, BIN, ...args], {
    cwd, encoding: 'utf8', timeout: RUN_MS,
    env: { ...process.env, AZ_WORDS: WORDS, AZ_TEST_MODULES: list },
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(list, 'utf8').trim().split('\n').map((u) => (u.startsWith(ROOT_URL) ? u.slice(ROOT_URL.length) : u));
}

const others = (modules: readonly string[]) =>
  modules.filter((m) => OTHER_COMMANDS_ONLY.some((o) => (o.endsWith('/') ? m.startsWith(o) : m === o)));

for (const cmd of ['build', 'check'] as const) {
  test(`az ${cmd} loads no module that only another command needs`, () => {
    const dir = fixtureProject();
    const args = cmd === 'build' ? ['build', 'site.az', '--out', 'out'] : ['check', 'site.az'];
    const modules = modulesOf(dir, args);
    assert.ok(modules.includes('packages/core/src/link.ts'), 'the compiler itself is listed');
    assert.deepEqual(others(modules), []);
  });
}

test('CONTROL: the list sees a module a command imports when it runs', () => {
  // az prompt imports prompt.ts on its first use; the hook must see it.
  const modules = modulesOf(fixtureProject(), ['prompt', '--compact']);
  assert.deepEqual(others(modules), ['packages/core/src/prompt.ts']);
});
