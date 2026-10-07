/**
 * hero `full` — the scrim over its visual (hero-block-spec §8, §9, §10).
 *
 * The visual sits behind the type, and the header's own background sits
 * under the visual — so the scrim the type needs is a layer of its own,
 * between the two. It was missing: at the static tier the type sat straight
 * on the poster, 1:1 over a white one. Its lightest stop, SCRIM.top, is the
 * smallest whole percent that holds 4.5:1 over ANY pixel in every theme, plus
 * two points of margin, and it is the same at every width: a desktop top of
 * 55% read 3.54:1 over white in paper light. test:visual (`over-media`)
 * measures the same thing in a browser at 375, 768 and 1440px.
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

/** The desktop top stop before §10 derived it: what a lighter top reads over white. */
const OLD_DESKTOP_TOP = 55;

test('§10: both stops hold 4.5:1 over a white pixel in every theme and scheme', () => {
  for (const { label, c } of every) {
    assert.ok(overWhite(c, SCRIM.top) >= CONTRAST_BODY, `${label}: ${overWhite(c, SCRIM.top)}:1 at ${SCRIM.top}%`);
    assert.ok(overWhite(c, SCRIM.bottom) >= CONTRAST_BODY, `${label}: bottom stop`);
  }
});

test('§10: the gradient never falls below its top stop — text holds wherever it sits', () => {
  assert.ok(SCRIM.bottom >= SCRIM.top, `bottom ${SCRIM.bottom}% is lighter than top ${SCRIM.top}%`);
});

test('EDGE: three points lighter fails somewhere — top is the floor plus the margin, not a guess', () => {
  const failing = every.filter(({ c }) => overWhite(c, SCRIM.top - 3) < CONTRAST_BODY);
  assert.ok(failing.length > 0, `every theme holds at ${SCRIM.top - 3}% — the floor is lower than stated`);
});

test('CONTROL: the old desktop top (55%) does not hold over white — why it was re-derived', () => {
  const paper = every.find(({ label }) => label === 'paper light');
  assert.ok(paper, 'no paper light theme');
  assert.ok(overWhite(paper.c, OLD_DESKTOP_TOP) < CONTRAST_BODY, `${overWhite(paper.c, OLD_DESKTOP_TOP)}:1`);
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

test('§10: the scrim is the same at every width — no breakpoint weakens it', () => {
  const { scrim } = scrimOf('full', ['3d']);
  assert.ok(scrim, 'no az-hero-scrim');
  assert.equal(scrim.below, undefined);
});

test('§8: live, the header clears so the canvas shows through — the scrim layer covers it', () => {
  const { root } = scrimOf('full', ['3d']);
  assert.equal(root.states?.live?.background, 'transparent');
});

test('CONTROL: no visual, no scrim layer — flat-scrim full, and every other layout', () => {
  assert.equal(scrimOf('full', []).scrim, undefined);
  for (const v of ['center', 'split', 'stack', 'minimal']) assert.equal(scrimOf(v, ['3d']).scrim, undefined, v);
});
