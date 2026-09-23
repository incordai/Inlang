/**
 * gallery §5/§6/§8/§10 — the carousel's controls and the lightbox markup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { emit } from '../gallery/emit.web.ts';

const T = resolve(THEMES.midnight, 'dark');
const context = (): EmitContext => ({
  theme: T as unknown as EmitContext['theme'],
  target: 'web',
  site: { name: 'aurora' },
  slot: () => [],
  asset: (p) => `/sandboxed/${p}`,
  ...actionsFor(T as unknown as EmitContext['theme']),
});

const image = (src: string, props: Record<string, string>): SpecBlock => ({
  word: 'image', variant: null, modifiers: [], as: null, children: [],
  args: [{ kind: 'path', value: src }], props,
});
const SET = [
  image('./a.webp', { alt: 'An empty bench', caption: 'Day one' }),
  image('./b.webp', { alt: 'A welt being stitched' }),
  image('./c.webp', {}),
];
const gallery = (variant: string, modifiers: string[]): SpecBlock => ({
  word: 'gallery', variant, modifiers, args: [], as: null, props: { title: 'The workshop' }, children: SET,
});

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const text = (n: EmittedNode | string): string => typeof n === 'string' ? n : (n.children ?? []).map(text).join('');

test('§5/§8: with lightbox each image is a real button, named by caption, else alt', () => {
  const out = emit(gallery('grid', ['lightbox']), context());
  const opens = walk(out).filter((n) => n.tag === 'button' && n.attrs?.['data-az-index'] !== undefined);
  assert.equal(opens.length, 3);
  assert.deepEqual(opens.map((b) => b.attrs?.['aria-label']), ['Day one', 'A welt being stitched', 'Image 3']);
  assert.ok(opens.every((b) => b.attrs?.type === 'button' && b.attrs?.['aria-haspopup'] === 'dialog'));
  assert.ok(opens.every((b) => walk(b).some((n) => n.tag === 'img')), 'the button wraps the <img>');
  assert.equal(out.attrs?.['data-az-behaviour'], 'lightbox');
});

test('§8: one popup dialog per gallery, with a polite counter and no-wrap controls', () => {
  const dialogs = walk(emit(gallery('grid', ['lightbox']), context())).filter((n) => n.tag === 'dialog');
  assert.equal(dialogs.length, 1);
  const d = dialogs[0];
  assert.equal(d.attrs?.['data-az-overlay'], 'popup', 'the popup preset, not a new overlay');
  assert.equal(d.attrs?.['data-az-behaviour'], 'dialog');
  const counter = walk(d).find((n) => n.attrs?.['data-az-lightbox-counter'] !== undefined)!;
  assert.equal(counter.attrs?.['aria-live'], 'polite');
  assert.equal(text(counter), '1 of 3');
  const prev = walk(d).find((n) => n.attrs?.['data-az-step'] === '-1')!;
  assert.equal(prev.attrs?.['aria-disabled'], 'true', 'at the first image, previous is unavailable');
  const img = walk(d).find((n) => n.attrs?.['data-az-lightbox-image'] !== undefined)!;
  assert.equal(img.attrs?.loading, 'lazy', 'nothing downloads until the lightbox opens');
});

test('CONTROL: without lightbox — and on orbit — images are plain, with no dialog', () => {
  for (const [variant, mods] of [['grid', []], ['orbit', ['lightbox']]] as const) {
    const nodes = walk(emit(gallery(variant, [...mods]), context()));
    assert.equal(nodes.filter((n) => n.tag === 'dialog').length, 0, `${variant} ${mods.join(' ')}`);
    assert.equal(nodes.filter((n) => n.attrs?.['data-az-index'] !== undefined).length, 0);
  }
});

test('§6/§10: a carousel steps with named buttons, clipped on phones until focused', () => {
  const out = emit(gallery('carousel', []), context());
  const wrap = walk(out).find((n) => n.attrs?.['data-az-behaviour'] === 'carousel')!;
  assert.ok(walk(wrap).some((n) => n.attrs?.['data-az-track'] !== undefined), 'the track is marked');
  const controls = walk(wrap).find((n) => n.attrs?.class === 'az-gallery-controls')!;
  const steps = walk(controls).filter((n) => n.tag === 'button');
  assert.deepEqual(steps.map((b) => text(b)), ['Previous image', 'Next image'], 'real names');
  assert.equal(steps[0].attrs?.['aria-disabled'], 'true');
  assert.equal(controls.below?.sm?.clip, 'rect(0 0 0 0)', '§6: visually hidden on phones…');
  assert.equal(controls.states?.focusWithin?.clip, 'auto', '…and shown when an arrow takes focus');
});

test('CONTROL: a grid has no step controls; orbit has them only for its phone fallback', () => {
  assert.equal(walk(emit(gallery('grid', []), context())).filter((n) => n.attrs?.['data-az-step']).length, 0);
  const orbit = walk(emit(gallery('orbit', []), context())).find((n) => n.attrs?.class === 'az-gallery-controls')!;
  assert.equal(orbit.style?.display, 'none');
  assert.equal(orbit.below?.sm?.display, 'flex');
});
