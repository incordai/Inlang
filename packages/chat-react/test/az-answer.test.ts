/**
 * <AzAnswer>'s parts that need no browser (chat-block-spec §22.3): every
 * theme it names is one of the renderer's, loaded by name; the drawing
 * itself, streamed, in Chromium, Firefox and WebKit, is
 * scripts/chat-lib-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from '../../theme/src/index.ts';
import { loadTheme, THEME_NAMES } from '../src/az-answer.ts';

test('the theme names are the six themes, and each loads by name as the renderer\'s module for it', async () => {
  assert.deepEqual([...THEME_NAMES].sort(), Object.keys(THEMES).sort());
  for (const name of THEME_NAMES) {
    const t = await loadTheme(name);
    assert.equal(t.THEME, name);
    assert.equal(typeof t.SHELL, 'object');
  }
});
