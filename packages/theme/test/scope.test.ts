/**
 * theme-spec §4 — where raw values are legal, as a check over the repository.
 *
 * Raw colours, font-family, off-scale px and z-index numbers are legal in the
 * theme's DATA (tokens.ts, themes.ts) and banned everywhere else: words,
 * targets, core, the CLI, and the theme's own logic. Word emitters are linted
 * in words.test.ts; this covers the rest of the table, which nothing checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSource, formatFindings } from '../src/lint.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx|mjs|js|css)$/.test(name) ? [path] : [];
  });
}

/** The theme's data files: the one place raw values are legal (§4). */
const THEME_DATA = new Set(['packages/theme/src/tokens.ts', 'packages/theme/src/themes.ts']);

const BANNED = [
  ...sources(join(ROOT, 'packages/target-web/src')),
  ...sources(join(ROOT, 'packages/core/src')),
  ...sources(join(ROOT, 'packages/cli/src')),
  ...sources(join(ROOT, 'packages/theme/src')),
].map((f) => relative(ROOT, f).replace(/\\/g, '/')).filter((f) => !THEME_DATA.has(f));

test('CONTROL: the scope covers every package and still excludes the theme data', () => {
  for (const pkg of ['target-web', 'core', 'cli', 'theme']) {
    assert.ok(BANNED.some((f) => f.startsWith(`packages/${pkg}/src/`)), `no sources found for ${pkg}`);
  }
  assert.ok(!BANNED.includes('packages/theme/src/themes.ts'));
});

test('theme-spec §4: no raw theme values outside the theme data', () => {
  // 'package': the value rules hold here; writing conditions is the
  // target's job (no-raw-condition is for word source).
  const findings = BANNED.flatMap((f) => lintSource(f, readFileSync(join(ROOT, f), 'utf8'), 'package'));
  assert.deepEqual(findings, [], formatFindings(findings));
});
