/**
 * C3's runtime rules (chat-block-spec §3.2, §9), pure: when the transcript
 * counts as at its end (it follows only then), which overlay preset a float
 * opens as at a width — the modal sheet below the shell's narrow width, the
 * non-modal panel above — and the config key that carries that width. The
 * DOM half (open, trap, Escape, focus return, Jump to latest) runs in three
 * engines in scripts/chat-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { END_SLACK_PX, atEnd, floatPreset, parseChatConfig } from '../src/runtime/chat-logic.ts';
import { POLICY } from '../src/runtime/policy.ts';

test('atEnd: the end, within a line of it, and above it', () => {
  assert.equal(atEnd(600, 1000, 400), true, 'scrolled to the end');
  assert.equal(atEnd(600 - END_SLACK_PX, 1000, 400), true, 'a line short still counts');
  assert.equal(atEnd(600 - END_SLACK_PX - 1, 1000, 400), false, 'scrolled up: following stops');
  assert.equal(atEnd(0, 300, 400), true, 'a transcript too short to scroll is always at its end');
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
