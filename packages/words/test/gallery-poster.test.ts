/**
 * `gallery orbit` — the poster (gallery-block-spec §9).
 *
 * The poster is what the static tier, reduced motion and the loading state
 * show in place of the ring. It must reach the output as a real image, only
 * under `orbit`, without displacing the image list that carries the content.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { emit } from '../gallery/emit.web.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';

const POSTER = './ring.webp';
const RESOLVED = '/assets/ring.webp';

function context(): EmitContext {
  const t = resolve(THEMES.midnight, 'dark');
  return {
    theme: {
      color: t.color as unknown as Record<string, string>,
      size: t.size as unknown as Record<string, number>,
      type: t.type as unknown as Record<string, string | number>,
      radius: t.radius as unknown as Record<string, number>,
      shadow: t.shadow as unknown as Record<string, string>,
      space: t.space as unknown as Record<string, number>,
      motion: t.motion as unknown as Record<string, string | number>,
      layer: t.layer as unknown as Record<string, number>,
      breakpoint: t.breakpoint,
      typeSize: t.typeSize as unknown as Record<string, string>,
    },
    target: 'web',
    site: { name: 'aurora' },
    slot: (name) => [
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['one'] },
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['two'] },
    ],
    // Resolve visibly, so the test proves the path went THROUGH ctx.asset
    // (the sandboxed gate) rather than being echoed raw.
    asset: (p) => (p === POSTER ? RESOLVED : p),
  };
}

const image = (src: string): SpecBlock => ({
  word: 'image', variant: null, modifiers: [], as: null, children: [],
  args: [{ kind: 'path', value: src }], props: {},
});

const block = (variant: string, props: Record<string, string> = {}): SpecBlock => ({
  word: 'gallery', variant, modifiers: [], args: [], as: null,
  props: { title: 'The workshop', ...props },
  children: [image('./a.webp'), image('./b.webp')],
});

function find(node: EmittedNode | string, match: (n: EmittedNode) => boolean): EmittedNode[] {
  if (typeof node === 'string') return [];
  return [...(match(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => find(c, match))];
}

const posters = (n: EmittedNode) => find(n, (x) => x.attrs?.class === 'az-gallery-poster');

test('orbit emits the poster as an <img> resolved through ctx.asset', () => {
  const [img, ...rest] = posters(emit(block('orbit', { poster: POSTER }), context()));
  assert.ok(img, 'orbit with a poster must emit it');
  assert.equal(rest.length, 0, 'exactly one poster');
  assert.equal(img.tag, 'img');
  assert.equal(img.attrs?.src, RESOLVED, 'the path must pass through the sandboxed resolver');
});

test('the poster is decorative, lazy, and never claims fetch priority (§7, §9)', () => {
  const [img] = posters(emit(block('orbit', { poster: POSTER }), context()));
  assert.equal(img.attrs?.alt, '', 'the images below carry the content; the poster must not repeat it');
  assert.equal(img.attrs?.loading, 'lazy');
  assert.equal(img.attrs?.fetchpriority, undefined);
});

test('the poster reserves the canvas box at the gallery ratio', () => {
  const [byDefault] = posters(emit(block('orbit', { poster: POSTER }), context()));
  const [custom] = posters(emit(block('orbit', { poster: POSTER, ratio: 'square' }), context()));
  // The manifest's words, as valid CSS: `3:2` itself is dropped by browsers.
  assert.equal(byDefault.style?.aspectRatio, '3 / 2');
  assert.equal(custom.style?.aspectRatio, '1 / 1');
});

test('the image list still carries the content beside the poster (§9)', () => {
  const out = emit(block('orbit', { poster: POSTER }), context());
  const lists = find(out, (x) => x.attrs?.class === 'az-gallery-items');
  assert.equal(lists.length, 1, 'every image must still exist in the DOM');
  assert.equal(lists[0].children?.length, 2);
});

test('CONTROL: no poster is emitted for a non-orbit variant, or without the prop', () => {
  for (const v of ['grid', 'masonry', 'carousel']) {
    assert.equal(posters(emit(block(v, { poster: POSTER }), context())).length, 0,
      `${v} has no canvas, so it has no poster`);
  }
  assert.equal(posters(emit(block('orbit'), context())).length, 0);
});
