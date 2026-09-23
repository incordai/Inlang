/**
 * scripts/thumbnails.mjs — the variant substitution that turns a word's
 * preview.az into a source for each of its variants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withVariant } from '../../../scripts/thumbnails.mjs';

const PREVIEW = 'az 1\nsite aurora\npage /\n  hero center\n    title "x"\n  cta band\n    title "y"\n';

test('the variant on the word\'s own line is replaced', () => {
  const out = withVariant(PREVIEW, 'cta', 'card', ['band', 'card', 'split']);
  assert.match(out, /^  cta card$/m);
  assert.match(out, /^  hero center$/m, 'CONTROL: other words are untouched');
});

test('a line with no variant gains one after the word, modifiers kept', () => {
  const src = 'az 1\nsite a\n  nav sticky\n    link "W" /w\npage /\n';
  assert.match(withVariant(src, 'nav', 'mega', ['bar', 'mega']), /^  nav mega sticky$/m);
});

test('a modifier that is not a variant is not mistaken for one', () => {
  const src = 'az 1\nsite a\npage /\n  hero split 3d\n    title "x"\n';
  assert.match(withVariant(src, 'hero', 'stack', ['center', 'split', 'stack']), /^  hero stack 3d$/m);
});

test('a preview without the word is an error, not a silent no-op', () => {
  assert.throws(() => withVariant(PREVIEW, 'faq', 'list', ['list']), /has no faq line/);
});
