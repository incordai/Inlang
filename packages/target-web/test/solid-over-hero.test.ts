/**
 * nav-spec §4: a `solid` nav sits TRANSPARENT OVER a full-bleed hero at the
 * top of the page, then turns solid on scroll.
 *
 * The nav was in normal flow, so the hero started below it: the "transparent"
 * bar showed the page background, and its light `inverse` logo sat on that —
 * the contrast problem §4 exists to prevent. On a page with a solid nav, a
 * `full` or 3D hero opening <main> is now pulled up under the nav by the
 * nav's height, and reserves that height inside itself. A backdrop opening
 * <main> is fixed behind the page, so the hero after it is the one pulled
 * up — never the backdrop itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}
const css = (nav: string) => {
  const r = compile(`az 1\nsite aurora\n  nav ${nav}\n    link "Work" /work\npage /\n  hero full\n    title "x"\npage /work\n`, { manifests });
  assert.ok(r.spec, JSON.stringify(r.diagnostics));
  return emit(r.spec, { emitters: WEB_EMITTERS }).find((f) => f.path === 'src/theme.css')!.content;
};

const RULE = /\.az-page:has\(\[data-az-behaviour="solid"\]\) > \.az-main > :is\(:first-child, \.az-scene--backdrop:first-child \+ \*\):is\(\.az-hero--full, \[data-az-3d-host\]\):not\(\.az-scene--backdrop\) \{\s*margin-top: calc\(-1 \* var\(--az-size-nav\)\);\s*border-top: var\(--az-size-nav\) solid transparent;/;

test('a solid nav pulls a full or 3D hero up under itself', () => {
  const sheet = css('bar solid');
  assert.match(sheet, RULE);
  assert.match(sheet, /--az-size-nav: \d+px;/, 'the nav height is one variable (§5)');
});

test('the pinned nav keeps the rule too', () => {
  assert.match(css('split sticky solid'), RULE);
});

test('CONTROL: a nav that is not solid leaves the hero where it is', () => {
  assert.doesNotMatch(css('bar'), /data-az-behaviour="solid"/);
});
