/**
 * scene poster and ratio — scene-spec §4, §8, §12.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { emit } from '../scene/emit.web.ts';

const context = (): EmitContext => ({
  theme: resolve(THEMES.midnight, 'dark') as unknown as EmitContext['theme'],
  target: 'web',
  site: { name: 'aurora' },
  slot: () => [],
  asset: (p) => `/sandboxed/${p}`,
});

const scene = (variant: string, props: Record<string, string>): SpecBlock => ({
  word: 'scene', variant, modifiers: [], args: [], as: null, children: [],
  props: { alt: 'A shoe turning on a plinth', ...props },
});

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const figure = (n: EmittedNode) => walk(n).find((x) => x.tag === 'figure')!;

test('the poster goes through the asset sandbox, so the build ships it', () => {
  const out = emit(scene('inline', { poster: './assets/shoe.webp' }), context());
  assert.equal(figure(out).attrs?.['data-poster'], '/sandboxed/./assets/shoe.webp');
  const img = walk(out).find((x) => x.tag === 'img');
  assert.equal(img?.attrs?.src, '/sandboxed/./assets/shoe.webp');
});

test('§8/§9 static tier: the poster is shown and carries the scene alt', () => {
  const out = emit(scene('inline', { poster: './assets/shoe.webp' }), context());
  assert.equal(walk(out).find((x) => x.tag === 'img')?.attrs?.alt, 'A shoe turning on a plinth');
  // axe aria-allowed-role: a <figure> may not be role="img".
  assert.equal(figure(out).attrs?.role, undefined);
  assert.equal(figure(out).attrs?.['aria-label'], undefined, 'named once, by the image');
});

test('CONTROL: without a poster there is no image', () => {
  assert.equal(walk(emit(scene('inline', {}), context())).filter((x) => x.tag === 'img').length, 0);
});

test('ratio words become valid CSS aspect-ratio values', () => {
  for (const [ratio, css] of [['4:3', '4 / 3'], ['16:9', '16 / 9'], ['1:1', '1 / 1']]) {
    assert.equal(figure(emit(scene('full', { ratio }), context())).style?.aspectRatio, css);
  }
  assert.equal(figure(emit(scene('full', {}), context())).style?.aspectRatio, '4 / 3', 'manifest default');
});
