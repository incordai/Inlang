/**
 * The emitted project's dependency pins match the verified table.
 *
 * stack-evaluation.md checked each version against the registry and recorded
 * it as VERIFIED. If the compiler emits a different number, one of the two is
 * wrong and nobody finds out until an install fails — or worse, succeeds with
 * something untested. This makes the document and the code the same fact.
 *
 * GLOBAL RULE 11 — never guess a version — as a test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS } from '../src/emit.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const doc = readFileSync(join(ROOT, 'docs/stack-evaluation.md'), 'utf8');

/**
 * Find a package's row in the tables and return its version if VERIFIED.
 *
 * Parsed by splitting on the table's own pipes rather than by building a
 * regex per package name: those names contain `/`, `@` and `-`, all of which
 * need escaping in a pattern, and getting that wrong fails as a lexer error
 * rather than as a wrong answer.
 */
function verifiedVersion(pkg: string): string | null {
  for (const raw of doc.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is the empty string before the leading pipe.
    if (cells[1] !== '`' + pkg + '`') continue;
    // A package can appear in several tables (a decision record, the
    // verified list); only its VERIFIED row is a pin.
    if (!cells.slice(2).some((c) => c.includes('VERIFIED'))) continue;
    const version = cells[2];
    return version.startsWith('`') && version.endsWith('`')
      ? version.slice(1, -1)
      : null;
  }
  return null;
}

test('CONTROL: the table is readable and marks versions VERIFIED', () => {
  // If the table format changed, every lookup below would return null and the
  // comparisons would silently pass against nothing.
  assert.equal(verifiedVersion('react'), '19.2.8', 'react row not found or not VERIFIED');
  assert.equal(verifiedVersion('vite'), '8.2.2', 'vite row not found or not VERIFIED');
  assert.equal(verifiedVersion('nosuchpackage'), null, 'a missing package must read as null');
});

test('every emitted pin matches its VERIFIED row', () => {
  assert.equal(PINS.react, verifiedVersion('react'));
  assert.equal(PINS.vite, verifiedVersion('vite'));
  assert.equal(PINS.three, verifiedVersion('three'));
});

test('scene-spec: every 3D word pins the three a site is built with — no drift', () => {
  // hero, scene and gallery (orbit) draw into one renderer; a page that
  // mixed two three versions would ship two copies of the library.
  const words = join(ROOT, 'packages/words');
  const pinned = ['hero', 'scene', 'gallery'].map((w) =>
    (JSON.parse(readFileSync(join(words, w, 'word.json'), 'utf8')) as { deps?: Record<string, string> }).deps ?? {});
  for (const deps of pinned) assert.deepEqual(deps, { three: PINS.three });
});

test('typescript is pinned to the version this repo actually uses', () => {
  // stack-evaluation.md has no typescript row, so the repo's own devDependency
  // is the source of truth rather than a number invented here.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as
    { devDependencies?: Record<string, string> };
  assert.equal(PINS.typescript, rootPkg.devDependencies?.typescript);
});

test('pins are EXACT — a range would break determinism', () => {
  for (const [name, version] of Object.entries(PINS)) {
    assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/,
      `${name} is '${version}' — a range lets two builds resolve differently`);
  }
});
