/**
 * cta `split` media — cta-block-spec.md §6, §9, §11.
 *
 * `media` is the one image a `split` pairs with the ask; `describe` is its alt
 * text. Without `describe` the image is decorative and gets `alt=""` — §9
 * allows no third option.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../registry.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';

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
      breakpoint: t.breakpoint as unknown as Record<string, number>,
      typeSize: t.typeSize as unknown as Record<string, string>,
    },
    target: 'web',
    slot: () => [],
    // Marks the path as resolved, so a test can tell it went through the resolver.
    asset: (p) => `resolved:${p}`,
  };
}

const cta = (variant: string, props: Record<string, string>): SpecBlock => ({
  word: 'cta', variant, modifiers: [], args: [], as: null,
  props: { title: 'Reserve a pair', ...props }, children: [],
});

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];

const emit = (block: SpecBlock) => WEB_EMITTERS.cta.emit(block, context());
const images = (block: SpecBlock) => walk(emit(block)).filter((n) => n.tag === 'img');

test('split: media renders one image through the asset resolver', () => {
  const imgs = images(cta('split', { media: './bench.webp' }));
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].attrs?.src, 'resolved:./bench.webp');
});

test('split: without describe the image is decorative — alt="" (§9)', () => {
  const root = emit(cta('split', { media: './bench.webp' }));
  const [img] = walk(root).filter((n) => n.tag === 'img');
  assert.equal(img.attrs?.alt, '');
  const wrap = walk(root).find((n) => n.attrs?.class === 'az-cta-media');
  assert.equal(wrap?.attrs?.['data-media'], 'decorative');
});

test('split: describe becomes the alt text and marks the media informative', () => {
  const root = emit(cta('split', { media: './bench.webp', describe: 'The bench, mid-stitch' }));
  const [img] = walk(root).filter((n) => n.tag === 'img');
  assert.equal(img.attrs?.alt, 'The bench, mid-stitch');
  const wrap = walk(root).find((n) => n.attrs?.class === 'az-cta-media');
  assert.equal(wrap?.attrs?.['data-media'], 'informative');
});

test('split: describe is an attribute, never visible prose', () => {
  const root = emit(cta('split', { media: './bench.webp', describe: 'The bench, mid-stitch' }));
  const prose = walk(root).flatMap((n) => (n.children ?? []).filter((c) => typeof c === 'string'));
  assert.ok(!prose.includes('The bench, mid-stitch'));
});

test('split: the media follows the text, so a restack puts it below (§6)', () => {
  const root = emit(cta('split', { media: './bench.webp' }));
  const order = (root.children ?? []).map((c) => (typeof c === 'string' ? c : c.attrs?.class));
  assert.deepEqual(order, ['az-cta-text', 'az-cta-media']);
});

test('band and card have no media column, even if media is set', () => {
  for (const v of ['band', 'card']) {
    assert.equal(images(cta(v, { media: './bench.webp' })).length, 0, v);
  }
});

test('CONTROL: split without media emits no image', () => {
  assert.equal(images(cta('split', {})).length, 0);
});
