/**
 * The behaviour runtime's decisions — pure, so tested without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDE_TRAVEL, SOLID_AT, SWIPE_PX, TRANSPARENT_AT, carouselEnds, copyText, counterText, lightboxImage, lightboxIndex, moveIndex,
  neighbours, retractedAfter, shrunkAfter, solidAfter, swipeOf, transitionMs,
} from '../src/runtime/logic.ts';

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

test('nav §3 shrink: the same hysteresis as solid — no pumping at the threshold', () => {
  let shrunk = false;
  const seen: boolean[] = [];
  for (const y of [0, 79, 80, 60, 41, 40, 60, 80]) { shrunk = shrunkAfter(y, shrunk); seen.push(shrunk); }
  assert.deepEqual(seen, [false, false, true, true, true, false, false, true]);
});

test('nav §3 hide: retracts after a run of travel down, returns on a run up', () => {
  const bar = 72;
  assert.equal(retractedAfter(300, 300 + HIDE_TRAVEL, false, bar), true, 'down past the travel threshold');
  assert.equal(retractedAfter(500, 500 - HIDE_TRAVEL, true, bar), false, 'up past it');
  // Jitter smaller than the travel threshold changes nothing, either way.
  assert.equal(retractedAfter(300, 300 + HIDE_TRAVEL - 1, false, bar), false);
  assert.equal(retractedAfter(500, 500 - HIDE_TRAVEL + 1, true, bar), true);
});

test('CONTROL: the bar is never hidden while it still sits over its own spot', () => {
  assert.equal(retractedAfter(0, 72, false, 72), false, 'at bar height, even after travel down');
  assert.equal(retractedAfter(0, 73, false, 72), true, 'just past it, the rule applies');
  assert.equal(retractedAfter(400, 10, true, 72), false, 'near the top it always shows');
});

test('gallery §8: lightbox keys step, jump, and do NOT wrap at either end', () => {
  assert.equal(lightboxIndex('ArrowRight', 2, 5), 3);
  assert.equal(lightboxIndex('ArrowRight', 4, 5), 4, 'at the last image → does nothing');
  assert.equal(lightboxIndex('ArrowLeft', 0, 5), 0, 'at the first image ← does nothing');
  assert.equal(lightboxIndex('Home', 3, 5), 0);
  assert.equal(lightboxIndex('End', 0, 5), 4);
  assert.equal(lightboxIndex('Tab', 0, 5), null, 'CONTROL: other keys are left alone');
});

test('gallery §8: the counter is "N of M"; only the neighbours preload', () => {
  assert.equal(counterText(2, 18), '3 of 18');
  assert.deepEqual(neighbours(0, 5), [1]);
  assert.deepEqual(neighbours(2, 5), [1, 3]);
  assert.deepEqual(neighbours(4, 5), [3]);
});

test('gallery §8 + §7 rule 3: the enlarged image is the full-size file, with its srcset and its own size', () => {
  const thumb = (attrs: Record<string, string>) => ({
    // A thumbnail drawn from its 480w copy: currentSrc is the small file.
    src: 'https://site.test/assets/one.jpg', alt: 'One', currentSrc: 'https://site.test/az-img/a-480.webp',
    getAttribute: (name: string) => attrs[name] ?? null,
  });
  const shown = lightboxImage(thumb({ srcset: '/az-img/a-480.webp 480w, /az-img/a-768.webp 768w', width: '2400', height: '1600' }));
  assert.deepEqual(shown, {
    src: 'https://site.test/assets/one.jpg', alt: 'One',
    srcset: '/az-img/a-480.webp 480w, /az-img/a-768.webp 768w', width: '2400', height: '1600',
  }, 'never the thumbnail\'s currentSrc: that is the small copy the grid chose');
  assert.deepEqual(lightboxImage(thumb({})), { src: 'https://site.test/assets/one.jpg', alt: 'One', srcset: null, width: null, height: null },
    'an image without them removes the previous image\'s');
});

test('gallery §8 touch: sideways swipes step, a downward one closes, small moves do nothing', () => {
  assert.equal(swipeOf(-SWIPE_PX, 0), 'next');
  assert.equal(swipeOf(SWIPE_PX, 0), 'previous');
  assert.equal(swipeOf(0, SWIPE_PX), 'close');
  assert.equal(swipeOf(SWIPE_PX - 1, 0), null);
  assert.equal(swipeOf(0, -SWIPE_PX), null, 'CONTROL: upward is not a close');
});

test('a carousel track knows its ends, forgiving a subpixel', () => {
  assert.deepEqual(carouselEnds(0, 400, 1000), { atStart: true, atEnd: false });
  assert.deepEqual(carouselEnds(599.5, 400, 1000), { atStart: false, atEnd: true });
  assert.deepEqual(carouselEnds(0, 400, 400), { atStart: true, atEnd: true }, 'everything fits: nowhere to go');
});
