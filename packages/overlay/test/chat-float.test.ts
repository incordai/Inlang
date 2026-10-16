/**
 * C3's runtime rules (chat-block-spec §3.2, §9), pure: when the transcript
 * counts as at its end (it follows only then, and never over a scroll up
 * whose event is still to come), which overlay preset a float
 * opens as at a width — the modal sheet below the shell's narrow width, the
 * non-modal panel above — and the config key that carries that width. The
 * DOM half (open, trap, Escape, focus return, Jump to latest) runs in three
 * engines in scripts/chat-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { END_SLACK_PX, INPUT_MAX_ROWS, atEnd, floatPreset, inputRows, mayFollow, offersLatest, parseChatConfig } from '../src/runtime/chat-logic.ts';
import { POLICY } from '../src/runtime/policy.ts';

test('atEnd: the end, within a line of it, and above it', () => {
  assert.equal(atEnd(600, 1000, 400), true, 'scrolled to the end');
  assert.equal(atEnd(600 - END_SLACK_PX, 1000, 400), true, 'a line short still counts');
  assert.equal(atEnd(600 - END_SLACK_PX - 1, 1000, 400), false, 'scrolled up: following stops');
  assert.equal(atEnd(0, 300, 400), true, 'a transcript too short to scroll is always at its end');
});

test('mayFollow: a scroll up whose event is still to come wins over new words', () => {
  assert.equal(mayFollow(true, 600, 600), true, 'where following left it: follow');
  assert.equal(mayFollow(true, 600 - END_SLACK_PX, 600), true, 'a line above it still follows');
  assert.equal(mayFollow(true, 0, 600), false, 'scrolled to the top before the event ran: stay');
  assert.equal(mayFollow(false, 600, 600), false, 'the last event said scrolled up: stay');
  assert.equal(mayFollow(true, 0, 0), true, 'resumed (the visitor asked, the float opened): follow from anywhere');
});

test('offersLatest (issue #2): away from the newest words, but never over the start of an answer just arrived', () => {
  assert.equal(offersLatest(true, 0, 400), false, 'at the end: nothing to jump to');
  assert.equal(offersLatest(false, null, 400), true, 'scrolled up while the answer streams: offered');
  assert.equal(offersLatest(false, 0, 400), false, 'reading the arrived answer from its start: not offered');
  assert.equal(offersLatest(false, -END_SLACK_PX, 400), false, 'its start a line above the top still counts as its start');
  assert.equal(offersLatest(false, 300, 400), false, 'its start in view lower down: the reader sees where it begins');
  assert.equal(offersLatest(false, -END_SLACK_PX - 1, 400), true, 'scrolled into the middle of it: offered');
  assert.equal(offersLatest(false, 400 - END_SLACK_PX + 1, 400), true, 'scrolled up above it, its start below the view: offered');
});

test('inputRows (issue #2): one line until the text needs more, then a line per line, up to the cap', () => {
  assert.equal(inputRows(40, 42, 1, 24), 1, 'one line of text fits one row');
  assert.equal(inputRows(64, 42, 1, 24), 2, 'a second line');
  assert.equal(inputRows(88, 42, 1, 24), 3);
  assert.equal(inputRows(10_000, 42, 1, 24), INPUT_MAX_ROWS, 'never past the cap: the input scrolls instead');
  assert.equal(inputRows(64, 42, 1, 0), 1, 'no line height to measure by: left as it is');
  assert.ok(INPUT_MAX_ROWS >= 3 && INPUT_MAX_ROWS <= 6, 'room for a question, not an essay');
});

test('floatPreset: the sheet below the narrow width (modal, trapped, locked); the side panel at and above it (not modal)', () => {
  assert.equal(floatPreset(390, 768), 'sheet');
  assert.equal(floatPreset(767, 768), 'sheet');
  assert.equal(floatPreset(768, 768), 'dropdown');
  assert.equal(floatPreset(1440, 768), 'dropdown');
  assert.deepEqual(POLICY[floatPreset(390, 768)], { focus: 'trap', scroll: 'lock', modal: true }, 'the overlay engine\'s sheet, as nav uses it');
  assert.deepEqual(POLICY[floatPreset(1440, 768)], { focus: 'return', scroll: 'close', modal: false }, 'focus returns, nothing is held');
});

test('the config: a float carries its narrow width, a panel none; anything else refuses the config', () => {
  const base = { page: '/', allow: 'anyone', limit: 20, signin: null };
  assert.equal(parseChatConfig(JSON.stringify({ ...base, narrow: 768 }))?.narrow, 768);
  assert.equal(parseChatConfig(JSON.stringify(base))?.narrow, null);
  for (const narrow of [0, -1, 1.5, '768', 1e9, null]) {
    assert.equal(parseChatConfig(JSON.stringify({ ...base, narrow })), null, String(narrow));
  }
});

test('the float wiring decides modal from the policy table, never from a width written in the runtime', () => {
  const src = readFileSync(new URL('../src/runtime/chat.ts', import.meta.url), 'utf8');
  assert.match(src, /POLICY\[preset\]\.modal/);
  assert.match(src, /floatPreset\(win\.innerWidth, config\.narrow\)/);
  assert.doesNotMatch(src, /\b(?:767|768|1024)\b/, 'no breakpoint number in the runtime: the shell gives it');
  assert.doesNotMatch(src, /matchMedia\([^)]*width/, 'no width query: one source, the config');
});
