/**
 * The behaviour runtime's decisions added for the review's findings — pure,
 * so tested without a browser. The wiring they drive is checked in the
 * browser by scripts/visual/behaviours.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billingAnnouncement, billingFrom, offScreen, outsideBox, rollingYear, safeDecode, samePageFragment, trapIndex,
} from '../src/runtime/logic.ts';

test('a malformed fragment is used as written, never thrown', () => {
  assert.equal(safeDecode('%E0%A4'), '%E0%A4');
  assert.equal(safeDecode('100%'), '100%');
  assert.throws(() => decodeURIComponent('%E0%A4'), URIError, 'CONTROL: the platform decode throws on it');
  assert.equal(safeDecode('caf%C3%A9'), 'café', 'a valid one still decodes');
});

test('only a click outside the box is on the backdrop — padding is inside', () => {
  const box = { left: 0, top: 0, right: 300, bottom: 900 };
  assert.equal(outsideBox(150, 880, box), false, 'the empty lower part of a drawer');
  assert.equal(outsideBox(2, 2, box), false, 'the padding corner');
  assert.equal(outsideBox(301, 450, box), true, 'beside the drawer');
  assert.equal(outsideBox(150, 901, box), true);
});

test('Tab from outside the stops goes to the first, Shift+Tab to the LAST', () => {
  assert.equal(trapIndex(-1, 4, false), 0);
  assert.equal(trapIndex(-1, 4, true), 3, 'not the second-to-last');
  assert.equal(trapIndex(-1, 2, true), 1, 'with two stops, the last, not the first');
  assert.equal(trapIndex(3, 4, false), 0, 'CONTROL: wraps forwards');
  assert.equal(trapIndex(0, 4, true), 3, 'CONTROL: wraps backwards');
});

test('a same-page fragment is recognised; another page, query or origin is not', () => {
  const here = { origin: 'https://s.test', pathname: '/', search: '' };
  const link = (over: Partial<{ origin: string; pathname: string; search: string; hash: string }>) =>
    ({ origin: 'https://s.test', pathname: '/', search: '', hash: '#pricing', ...over });
  assert.equal(samePageFragment(link({}), here), true);
  assert.equal(samePageFragment(link({ pathname: '/work' }), here), false);
  assert.equal(samePageFragment(link({ search: '?a=1' }), here), false);
  assert.equal(samePageFragment(link({ origin: 'https://other.test' }), here), false);
  assert.equal(samePageFragment(link({ hash: '' }), here), false, 'no fragment, no jump');
  assert.equal(samePageFragment(link({ hash: '#' }), here), false, 'a bare # is not a target');
});

test('footer §4: the rolling year is a range once the year has moved on', () => {
  assert.equal(rollingYear('2019', 2026), '2019–2026');
  assert.equal(rollingYear('2026', 2026), null, 'the same year: the fallback stands');
  assert.equal(rollingYear('twenty', 2026), null, 'CONTROL: not a year, left alone');
});

test('pricing §7.1: the query string decides the period, the prop is the default', () => {
  assert.equal(billingFrom('?billing=annual', 'monthly'), 'annual');
  assert.equal(billingFrom('?billing=monthly', 'annual'), 'monthly');
  assert.equal(billingFrom('', 'annual'), 'annual');
  assert.equal(billingFrom('?billing=weekly', 'monthly'), 'monthly', 'an unknown period falls back');
  assert.match(billingAnnouncement('annual'), /annual pricing, billed yearly/);
  assert.doesNotMatch(billingAnnouncement('annual'), /\d/, 'the mode is announced, not the numbers');
});

test('focus returning to a trigger scrolls only when the trigger is off screen', () => {
  assert.equal(offScreen({ top: 12, bottom: 56 }, 900), false, 'a sticky toggle in view stays put');
  assert.equal(offScreen({ top: -300, bottom: -256 }, 900), true, 'a toggle scrolled away above');
  assert.equal(offScreen({ top: 950, bottom: 990 }, 900), true, 'a trigger below the fold');
  assert.equal(offScreen({ top: -20, bottom: 24 }, 900), false, 'partly on screen is on screen');
});
