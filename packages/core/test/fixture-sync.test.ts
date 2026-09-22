/**
 * The fixture IS the spec's example — not a copy of it.
 *
 * `fixture-site.az` is GRAMMAR §8's worked example, and three test files
 * compile it as proof the language works end to end. A hand-copied fixture
 * silently stops being the documented example the first time either changes:
 * the doc said `auth azbackend`, the fixture said `adapter azbackend` on the
 * block, and auth-block-spec §2 said neither. This asserts they are the same
 * bytes, so the next divergence fails here instead of being discovered later.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The fenced block in GRAMMAR.md carrying the §8 worked example. */
function grammarExample(): string | null {
  const lines = readFileSync(join(ROOT, 'docs/GRAMMAR.md'), 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('```')) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].startsWith('```'); j++) body.push(lines[j]);
    if (body.some((b) => b.includes('# Aurora'))) return body.join('\n') + '\n';
    i = j;
  }
  return null;
}

test('CONTROL: GRAMMAR §8 still contains the worked example', () => {
  // If the marker moved, the comparison below would compare against null and
  // the failure would look like a fixture problem rather than a doc one.
  const ex = grammarExample();
  assert.ok(ex && ex.includes('site aurora'), 'GRAMMAR §8 example not found');
});

test('fixture-site.az is byte-identical to GRAMMAR §8', () => {
  const fixture = readFileSync(join(ROOT, 'packages/core/test/fixture-site.az'), 'utf8');
  assert.equal(fixture.replace(/\r\n/g, '\n'), grammarExample(),
    'the fixture and the doc have drifted — update the doc, then regenerate');
});
