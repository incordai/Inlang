/**
 * `reveal` timing — feature-spec §9: a 60ms stagger capped at 6 steps, and
 * nothing hidden that starts inside the first viewport.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVEAL_MAX_STEPS, REVEAL_STEP_MS, revealDelay, revealsLater } from '../src/runtime/logic.ts';

test('§9: items stagger by 60ms', () => {
  assert.deepEqual([0, 1, 2].map(revealDelay), [0, 60, 120]);
});

test('§9: past step 6 the delay stops accumulating', () => {
  assert.equal(revealDelay(REVEAL_MAX_STEPS), REVEAL_MAX_STEPS * REVEAL_STEP_MS);
  assert.equal(revealDelay(11), revealDelay(REVEAL_MAX_STEPS), 'item 12 does not wait 660ms');
  assert.equal(revealDelay(-1), 0);
});

test('§9: a block already in the first viewport is not hidden', () => {
  assert.equal(revealsLater({ top: 200 }, 900), false);
  assert.equal(revealsLater({ top: 899 }, 900), false);
});

test('CONTROL: a block below the first viewport is hidden for its reveal', () => {
  assert.equal(revealsLater({ top: 900 }, 900), true);
  assert.equal(revealsLater({ top: 2400 }, 900), true);
});
