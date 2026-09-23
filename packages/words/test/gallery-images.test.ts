/**
 * gallery images — spec §7 and §10.
 *
 * An `image ./x.webp` child used to reach the page through the generic slot
 * renderer, which prints the first argument as a heading: every gallery
 * showed its file paths as <h3> text and no photographs at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { emit } from '../gallery/emit.web.ts';

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
    // The slot path is what printed paths as headings; images must not use it.
    slot: () => [{ tag: 'h3', children: ['from the slot path'] }],
    asset: (p) => `/resolved/${p}`,
    ...actionsFor(t as unknown as EmitContext['theme']),
  };
}

const image = (src: string, props: Record<string, string> = {}): SpecBlock => ({
  word: 'image', variant: null, modifiers: [], as: null, children: [],
  args: [{ kind: 'path', value: src }], props,
});

const gallery = (variant: string, children: SpecBlock[], props: Record<string, string> = {}): SpecBlock => ({
  word: 'gallery', variant, modifiers: [], args: [], as: null,
  props: { ratio: '3:2', columns: '2', ...props }, children,
});

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const imgs = (n: EmittedNode) => walk(n).filter((x) => x.tag === 'img');
const text = (n: EmittedNode | string): string =>
  typeof n === 'string' ? n : (n.children ?? []).map(text).join('');

const SET = [
  image('./a.webp', { alt: 'The bench, empty' }),
  image('./b.webp', { alt: 'Welting by hand' }),
  image('./c.webp'),
];

test('every image renders as an <img> resolved through the asset sandbox', () => {
  const out = emit(gallery('grid', SET), context());
  assert.deepEqual(imgs(out).map((i) => i.attrs?.src),
    ['/resolved/./a.webp', '/resolved/./b.webp', '/resolved/./c.webp']);
  assert.doesNotMatch(text(out), /\.webp/, 'a file path must never appear as page text');
  assert.doesNotMatch(text(out), /from the slot path/, 'images must not go through the generic slot');
});

test('alt is the author\'s; without one the image is decorative (alt="")', () => {
  const [a, , c] = imgs(emit(gallery('grid', SET), context()));
  assert.equal(a.attrs?.alt, 'The bench, empty');
  assert.equal(c.attrs?.alt, '');
});

test('§7: the first row loads eagerly, the rest lazily, none with a priority hint', () => {
  const all = imgs(emit(gallery('grid', SET), context()));
  assert.deepEqual(all.map((i) => i.attrs?.loading), ['eager', 'eager', 'lazy'], 'columns 2 = two eager');
  assert.ok(all.every((i) => i.attrs?.fetchpriority === undefined));
});

test('§10: captions give <figure> + <figcaption>; the caption is not the alt', () => {
  const out = emit(gallery('grid', [image('./a.webp', { caption: 'Day one', alt: '' }), image('./b.webp')]), context());
  const figures = walk(out).filter((x) => x.tag === 'figure');
  assert.equal(figures.length, 2, 'once any image has a caption, every item is a figure');
  const captions = walk(out).filter((x) => x.tag === 'figcaption');
  assert.deepEqual(captions.map(text), ['Day one']);
  assert.equal(imgs(out)[0].attrs?.alt, '');
});

test('CONTROL: no captions, no figures', () => {
  const out = emit(gallery('grid', SET), context());
  assert.equal(walk(out).filter((x) => x.tag === 'figure').length, 0);
});

test('ratio words become valid CSS; auto keeps the intrinsic shape', () => {
  const ratioOf = (ratio: string) => imgs(emit(gallery('grid', SET, { ratio }), context()))[0].style?.aspectRatio;
  assert.equal(ratioOf('3:2'), '3 / 2');
  assert.equal(ratioOf('16:9'), '16 / 9');
  assert.equal(ratioOf('square'), '1 / 1');
  assert.equal(ratioOf('auto'), undefined);
});

test('§7: focus moves the crop focal point', () => {
  const [top, centre] = imgs(emit(gallery('grid', [image('./a.webp', { focus: 'top' }), image('./b.webp')]), context()));
  assert.equal(top.style?.objectPosition, 'top');
  assert.equal(centre.style?.objectPosition, undefined, 'CONTROL: center is the default, nothing to set');
});

test('orbit caps the set at 16 images', () => {
  const many = Array.from({ length: 20 }, (_, i) => image(`./${i}.webp`, { alt: `Photo ${i}` }));
  assert.equal(imgs(emit(gallery('orbit', many), context())).length, 16);
  assert.equal(imgs(emit(gallery('grid', many), context())).length, 20, 'CONTROL: grid does not cap');
});

test('§10: a scrolling track is a named list the keyboard can reach', () => {
  const track = (variant: string, props: Record<string, string> = {}) =>
    walk(emit(gallery(variant, SET, props), context())).find((x) => x.tag === 'ul')!;
  for (const v of ['carousel', 'orbit']) {
    const t = track(v, { title: 'The workshop' });
    assert.equal(t.attrs?.role, undefined, `${v}: stays a list, so its items are list items`);
    assert.equal(t.attrs?.['aria-label'], 'The workshop', v);
    assert.equal(t.attrs?.tabindex, '0', v);
  }
  assert.equal(track('carousel').attrs?.['aria-label'], 'Gallery', 'a title-less track is still named');
  assert.equal(track('grid').attrs?.tabindex, undefined, 'CONTROL: a grid does not scroll and is no tab stop');
});
