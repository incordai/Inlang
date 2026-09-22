/**
 * word-quality-gate §1 item 10 — deps pinned exactly, no `^`, no `latest`.
 *
 * A range lets two builds of one source resolve different code, which ends
 * the determinism claim before a line of AZ runs (CONVENTIONS §6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

/** major.minor.patch with an optional prerelease — nothing that resolves. */
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

test('CONTROL: the pattern rejects every kind of range', () => {
  for (const bad of ['^1.2.3', '~1.2.3', '>=1.2.3', '1.2.x', '1.2', '*', 'latest', '1.2.3 || 2.0.0']) {
    assert.ok(!EXACT.test(bad), bad);
  }
  assert.ok(EXACT.test('0.170.0') && EXACT.test('1.0.0-rc.1'));
});

for (const w of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  test(`${w}: every dependency is an exact version`, () => {
    const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as { deps?: Record<string, string> };
    for (const [name, version] of Object.entries(m.deps ?? {})) {
      assert.match(version, EXACT, `${w} pins ${name} as '${version}' — write an exact version`);
    }
  });
}
