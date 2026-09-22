/**
 * nav `inverse` — the light logo for a transparent nav (nav-spec §4).
 *
 * A `solid` nav starts transparent over the hero and turns solid on scroll, so
 * one logo cannot serve both states. These tests pin the swap's shape: the
 * inverse is what shows at the top, the regular logo waits hidden, and a nav
 * that never goes transparent ignores the inverse entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { emit as emitNav } from '../nav/emit.web.ts';

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
    asset: (p) => p,
  };
}

const nav = (modifiers: string[], props: Record<string, string>): SpecBlock => ({
  word: 'nav', variant: 'split', modifiers, args: [], props, as: null, children: [],
});

/** The <img> elements inside the logo link, in document order. */
function logoImages(node: EmittedNode): EmittedNode[] {
  const link = (node.children ?? []).find(
    (c): c is EmittedNode => typeof c !== 'string' && c.attrs?.class === 'az-nav-logo');
  assert.ok(link, 'CONTROL: the nav emitted a logo link');
  return (link.children ?? []).filter((c): c is EmittedNode => typeof c !== 'string' && c.tag === 'img');
}

const LOGOS = { logo: './logo.svg', inverse: './logo-w.svg' };

test('nav-spec §4: a solid nav shows the inverse logo at the top', () => {
  const imgs = logoImages(emitNav(nav(['solid'], LOGOS), context()));
  assert.equal(imgs.length, 2, 'both logo versions are emitted so the runtime can swap');
  const visible = imgs.filter((i) => i.attrs?.hidden === undefined);
  assert.equal(visible.length, 1, 'exactly one logo is visible at a time');
  assert.equal(visible[0].attrs?.src, './logo-w.svg', 'the transparent top state shows the light inverse');
  assert.equal(visible[0].attrs?.['data-az-logo'], 'top');
});

test('nav-spec §4: the regular logo waits hidden for the solid state', () => {
  const imgs = logoImages(emitNav(nav(['solid'], LOGOS), context()));
  const regular = imgs.find((i) => i.attrs?.src === './logo.svg');
  assert.ok(regular, 'the regular logo is present');
  assert.equal(regular.attrs?.hidden, 'hidden');
  assert.equal(regular.attrs?.['data-az-logo'], 'solid');
});

test('the waiting logo is not displayed — an inline display would override `hidden`', () => {
  const imgs = logoImages(emitNav(nav(['solid'], LOGOS), context()));
  const regular = imgs.find((i) => i.attrs?.src === './logo.svg');
  const inverse = imgs.find((i) => i.attrs?.src === './logo-w.svg');
  assert.equal(regular?.style?.display, 'none', 'the hidden logo must not render');
  assert.equal(inverse?.style?.display, 'block', 'CONTROL: the visible logo still renders');
});

test('nav-spec §7: the swap never gives the logo link two accessible names', () => {
  // Both versions are the same mark; neither may add a second name to the link.
  for (const img of logoImages(emitNav(nav(['solid'], LOGOS), context()))) {
    assert.equal(img.attrs?.alt, '', `${img.attrs?.src} must not add a second name`);
  }
});

test('CONTROL: without `solid` the inverse is ignored — there is no transparent state', () => {
  const imgs = logoImages(emitNav(nav(['sticky'], LOGOS), context()));
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].attrs?.src, './logo.svg');
  assert.equal(imgs[0].attrs?.hidden, undefined);
});

test('CONTROL: `solid` without an inverse keeps the single regular logo', () => {
  // The linker warns about this (AZ1211); the emitter must still render.
  const imgs = logoImages(emitNav(nav(['solid'], { logo: './logo.svg' }), context()));
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].attrs?.src, './logo.svg');
});

test('the inverse path goes through the asset sandbox', () => {
  const seen: string[] = [];
  const ctx = { ...context(), asset: (p: string) => { seen.push(p); return p; } };
  emitNav(nav(['solid'], LOGOS), ctx);
  assert.ok(seen.includes('./logo-w.svg'), 'the inverse must be resolved via ctx.asset');
});
