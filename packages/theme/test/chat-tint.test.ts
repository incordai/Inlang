/**
 * The chat's visitor tint — theme-spec §16, chat-block-spec §9. Its floors
 * are proven in contrast.test.ts with every other chat pair; here, what it
 * adds to a theme and to the stylesheet, and nothing to a theme that has no
 * chat.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from '../src/themes.ts';
import { CHAT_TINT_PERCENT, CHAT_TOKENS, chatTint, withChat } from '../src/chat-tint.ts';
import { composite, rgbOf } from '../src/color.ts';
import { schemeCss, schemeReferences } from '../src/css.ts';

test('withChat adds the chat tokens in both schemes and changes nothing else', () => {
  for (const base of Object.values(THEMES)) {
    const chat = withChat(base);
    for (const scheme of ['light', 'dark'] as const) {
      const added = Object.keys(chat.color[scheme]).filter((k) => !(k in base.color[scheme]));
      assert.deepEqual(added, [...CHAT_TOKENS], `${base.name} ${scheme}`);
      for (const [k, v] of Object.entries(base.color[scheme])) assert.equal((chat.color[scheme] as unknown as Record<string, string>)[k], v, `${base.name} ${scheme} ${k}`);
    }
  }
});

test('a chat site declares the tint once per scheme block and words read it by reference; a site without a chat declares nothing new', () => {
  const css = schemeCss(withChat(THEMES.petal));
  assert.equal((css.match(/--az-color-chat-visitor: color-mix\(in srgb, var\(--az-color-accent\) \d+%, var\(--az-color-surface\)\);/g) ?? []).length, 3,
    'the default scheme, the OS preference and the explicit choice');
  assert.equal(schemeReferences(withChat(THEMES.petal)).color['chat-visitor'], 'var(--az-color-chat-visitor)');
  assert.ok(!schemeCss(THEMES.petal).includes('chat-visitor'));
  assert.equal(THEMES.petal.color.light['chat-visitor'], undefined);
});

test('the tint is the accent over surface at CHAT_TINT_PERCENT — what color-mix(in srgb …) paints', () => {
  const c = THEMES.clay.color.dark;
  assert.deepEqual(chatTint(THEMES.clay, 'dark'), composite(rgbOf(c.accent), rgbOf(c.surface), CHAT_TINT_PERCENT / 100));
});
