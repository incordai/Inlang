/**
 * FONT_STACKS — the families a `font` role may name, theme-spec §8.1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONT_STACKS } from '../src/index.ts';
import { FONT_FAMILIES } from '../../core/src/link.ts';

test('every family the compiler accepts has a stack, and no stack is unreachable', () => {
  assert.deepEqual(Object.keys(FONT_STACKS).sort(), Object.keys(FONT_FAMILIES).sort());
});

test('each stack ends in a generic family and names no downloadable face', () => {
  for (const [family, stack] of Object.entries(FONT_STACKS)) {
    const parts = stack.split(',').map((p) => p.trim());
    assert.match(parts.at(-1) ?? '', /^(serif|sans-serif|monospace)$/, `${family} ends generic`);
    // Only CSS generic and system keywords: the build fetches no face.
    for (const p of parts) assert.match(p, /^(ui-[a-z]+|system-ui|serif|sans-serif|monospace)$/, `${family}: ${p}`);
  }
});
