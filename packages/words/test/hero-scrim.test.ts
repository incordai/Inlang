/**
 * hero `full` — the scrim over its visual, and how it strengthens on a phone
 * (hero-block-spec §8, §9, §10).
 *
 * The visual sits behind the type, and the header's own background sits
 * under the visual — so the scrim the type needs is a layer of its own,
 * between the two. It was missing: at the static tier the type sat straight
 * on the poster, 1:1 over a white one. Below 768px its lightest stop rises to
 * SCRIM.phoneTop, the smallest whole percent that holds 4.5:1 over ANY pixel
 * in every theme, plus two points of margin. test:visual (`over-media`)
 * measures the same thing in a browser at 375px.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES, rgbOf, contrastRatio, composite, CONTRAST_BODY, type Rgb } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { emit, SCRIM } from '../hero/emit.web.ts';

const WHITE: Rgb = [255, 255, 255];
const SCHEMES = ['light', 'dark'] as const;
const every = Object.values(THEMES).flatMap((theme) => SCHEMES.map((scheme) => ({ label: `${theme.name} ${scheme}`, c: resolve(theme, scheme).color })));

/** on-scrim over the scrim at `percent`, over a pure-white pixel: the worst any poster or scene can show light ink. */
const overWhite = (c: { scrim: string; 'on-scrim': string }, percent: number) =>
  contrastRatio(rgbOf(c['on-scrim']), composite(rgbOf(c.scrim), WHITE, percent / 100));

test('§10: the phone scrim holds 4.5:1 over a white pixel in every theme and scheme', () => {
  for (const { label, c } of every) {
    assert.ok(overWhite(c, SCRIM.phoneTop) >= CONTRAST_BODY, `${label}: ${overWhite(c, SCRIM.phoneTop)}:1 at ${SCRIM.phoneTop}%`);
    assert.ok(overWhite(c, SCRIM.bottom) >= CONTRAST_BODY, `${label}: bottom stop`);
  }
});

test('EDGE: three points lighter fails somewhere — phoneTop is the floor plus the margin, not a guess', () => {
  const failing = every.filter(({ c }) => overWhite(c, SCRIM.phoneTop - 3) < CONTRAST_BODY);
  assert.ok(failing.length > 0, `every theme holds at ${SCRIM.phoneTop - 3}% — the floor is lower than stated`);
});

test('CONTROL: the desktop top stop does not hold over white — why the phone needs its own', () => {
  assert.ok(every.some(({ c }) => overWhite(c, SCRIM.top) < CONTRAST_BODY));
});

const T = resolve(THEMES.midnight, 'light');
const context = (): EmitContext => ({
  theme: T as unknown as EmitContext['theme'],
  target: 'web', site: { name: 'aurora' }, slot: () => [], asset: (p) => p,
  ...actionsFor(T as unknown as EmitContext['theme']),
});
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const hero = (variant: string, modifiers: string[]): SpecBlock => ({
  word: 'hero', variant, modifiers, args: [], as: null, children: [],
  props: { title: 'Built in the dark', poster: './poster.webp' },
});
const scrimOf = (variant: string, modifiers: string[]) => {
  const root = emit(hero(variant, modifiers), context());
  return { root, nodes: walk(root), scrim: walk(root).find((n) => n.attrs?.class === 'az-hero-scrim') };
};

test('§8/§9: full 3d lays a gradient scrim over its visual, after it, under the type', () => {
  const { root, scrim } = scrimOf('full', ['3d']);
  assert.ok(scrim, 'no az-hero-scrim');
  const kids = (root.children ?? []).filter((k): k is EmittedNode => typeof k !== 'string');
  const at = (cls: string) => kids.findIndex((k) => k.attrs?.class === cls);
  assert.ok(at('az-hero-scrim') > at('az-hero-visual'), 'the scrim must paint over the visual');
  assert.equal(scrim.attrs?.['aria-hidden'], 'true');
  assert.equal(scrim.style?.position, 'absolute');
  assert.equal(scrim.style?.zIndex, T.layer.behind);
  assert.equal(scrim.style?.pointerEvents, 'none', 'the view under it keeps its drag');
  assert.match(String(scrim.style?.background), new RegExp(`${SCRIM.bottom}%.*${SCRIM.top}%`));
});

test('§10: below 768px the scrim strengthens to the phone stop', () => {
  const { scrim } = scrimOf('full', ['3d']);
  assert.match(String(scrim?.below?.sm?.background), new RegExp(`${SCRIM.bottom}%.*${SCRIM.phoneTop}%`));
});

test('§8: live, the header clears so the canvas shows through — the scrim layer covers it', () => {
  const { root } = scrimOf('full', ['3d']);
  assert.equal(root.states?.live?.background, 'transparent');
});

test('CONTROL: no visual, no scrim layer — flat-scrim full, and every other layout', () => {
  assert.equal(scrimOf('full', []).scrim, undefined);
  for (const v of ['center', 'split', 'stack', 'minimal']) assert.equal(scrimOf(v, ['3d']).scrim, undefined, v);
});
