/**
 * The behaviour runtime's decisions — pure, so tested without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOLID_AT, TRANSPARENT_AT, copyText, moveIndex, solidAfter, transitionMs } from '../src/runtime/logic.ts';

test('nav §4: solid at 80px down, transparent again only at 40px up', () => {
  assert.equal(solidAfter(SOLID_AT - 1, false), false);
  assert.equal(solidAfter(SOLID_AT, false), true);
  // Hysteresis: between the thresholds the state holds, whichever it is.
  assert.equal(solidAfter(60, true), true);
  assert.equal(solidAfter(60, false), false);
  assert.equal(solidAfter(TRANSPARENT_AT, true), false);
});

test('CONTROL: a reader resting at the threshold does not flicker', () => {
  let solid = false;
  const seen: boolean[] = [];
  for (const y of [79, 80, 79, 81, 78, 80, 79]) { solid = solidAfter(y, solid); seen.push(solid); }
  assert.deepEqual(seen, [false, true, true, true, true, true, true]);
});

test('list keys wrap at the ends and jump with Home/End; other keys are left alone', () => {
  assert.equal(moveIndex('ArrowDown', 2, 3), 0);
  assert.equal(moveIndex('ArrowUp', 0, 3), 2);
  assert.equal(moveIndex('ArrowDown', -1, 3), 0, 'from nothing focused, down is the first');
  assert.equal(moveIndex('Home', 2, 3), 0);
  assert.equal(moveIndex('End', 0, 3), 2);
  assert.equal(moveIndex('Tab', 0, 3), null);
  assert.equal(moveIndex('Escape', 0, 3), null, 'faq §8: Escape does nothing in a disclosure list');
  assert.equal(moveIndex('ArrowDown', 0, 0), null);
});

test('copy: the text is everything after the scheme, colons and all', () => {
  assert.equal(copyText('copy:hello@aurora.example'), 'hello@aurora.example');
  assert.equal(copyText('copy:a:b'), 'a:b');
  assert.equal(copyText('COPY:x'), 'x');
  assert.equal(copyText('plain'), 'plain', 'CONTROL: no scheme, nothing stripped');
});

test('the exit wait is the longest duration plus its delay, in ms', () => {
  assert.equal(transitionMs('0.12s', '0s'), 120);
  assert.equal(transitionMs('120ms, 0.24s', '0s, 10ms'), 250);
  assert.equal(transitionMs('0s', '0s'), 0);
  assert.equal(transitionMs('', ''), 0, 'CONTROL: nothing computed, no wait');
});
