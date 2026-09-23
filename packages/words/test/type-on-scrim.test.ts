/**
 * Two defects the every-variant browser gate found:
 * - nav links (and the skip link) set no typeface, so they fell back to the
 *   browser's serif beside the theme's sans group button;
 * - hero `full` set its eyebrow and sub in `muted` on the scrim — a page
 *   colour on a dark band, 2.4:1 in the light scheme (axe color-contrast).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { emit as emitNav } from '../nav/emit.web.ts';
import { emit as emitHero } from '../hero/emit.web.ts';

const T = resolve(THEMES.midnight, 'light');
const context = (): EmitContext => ({
  theme: T as unknown as EmitContext['theme'],
  target: 'web', site: { name: 'aurora' }, slot: () => [], asset: (p) => p,
  ...actionsFor(T as unknown as EmitContext['theme']),
});
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const kid = (word: string, ...values: string[]): SpecBlock => ({
  word, variant: null, modifiers: [], as: null, children: [], props: {},
  args: values.map((value) => ({ kind: 'string', value })),
});

test('nav links and the skip link carry the theme body typeface', () => {
  const nav: SpecBlock = { word: 'nav', variant: 'bar', modifiers: [], args: [], props: {}, as: null, children: [kid('link', 'Work', '/work')] };
  const nodes = walk(emitNav(nav, context()));
  const links = nodes.filter((n) => n.attrs?.class === 'az-nav-link');
  assert.ok(links.length > 0);
  for (const a of links) assert.equal(a.style?.fontFamily, T.type.body);
  assert.equal(nodes.find((n) => n.attrs?.class === 'az-skip-link')?.style?.fontFamily, T.type.body);
});

const hero = (variant: string): SpecBlock => ({
  word: 'hero', variant, modifiers: [], args: [], as: null, children: [],
  props: { eyebrow: 'Limited run', title: 'Built in the dark', sub: 'Handmade.' },
});
const colourOf = (variant: string, cls: string) =>
  walk(emitHero(hero(variant), context())).find((n) => n.attrs?.class?.split(' ').includes(cls))?.style?.color;

test('hero full: eyebrow and sub sit on the scrim in its own text colour', () => {
  assert.equal(colourOf('full', 'az-hero-eyebrow'), T.color['on-scrim']);
  assert.equal(colourOf('full', 'az-hero-sub'), T.color['on-scrim']);
});

test('CONTROL: on the page background they stay muted', () => {
  assert.equal(colourOf('center', 'az-hero-eyebrow'), T.color.muted);
  assert.equal(colourOf('center', 'az-hero-sub'), T.color.muted);
});

/* ---- actions on the scrim: the `scrim` tone ---------------------------- */

const actionsOf = (variant: string) => {
  const block: SpecBlock = { ...hero(variant), children: [kid('cta', 'Reserve a pair', '/reserve'), kid('alt', 'Watch the film', '/film')] };
  return walk(emitHero(block, context())).filter((n) => n.attrs?.class?.split(' ').includes('az-action'));
};

test('hero full: its actions draw in the scrim\'s ink — outline, text link and focus ring', () => {
  const [, secondary] = actionsOf('full');
  // Page ink on the scrim was the scrim's own colour: invisible (1:1).
  assert.equal(secondary.style?.color, T.color['on-scrim']);
  assert.match(String(secondary.style?.border), new RegExp(T.color['on-scrim'].replace(/[()]/g, '\\$&')));
  assert.equal(secondary.below?.xs?.color, T.color['on-scrim'], 'below xs it is a text link — on-scrim, not accent');
  assert.match(String(secondary.states?.focusVisible?.outline), new RegExp(T.color['on-scrim'].replace(/[()]/g, '\\$&')));
});

test('CONTROL: on the page the secondary keeps page ink, the link accent, the ring focus', () => {
  const [, secondary] = actionsOf('center');
  assert.equal(secondary.style?.color, T.color.text);
  assert.equal(secondary.below?.xs?.color, T.color.accent);
  assert.match(String(secondary.states?.focusVisible?.outline), new RegExp(T.color.focus.replace(/[()]/g, '\\$&')));
});
