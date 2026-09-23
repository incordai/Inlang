/**
 * nav-block-spec §3 `hide` and `shrink`, and §5's scroll padding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { emit as emitNav } from '../nav/emit.web.ts';

const T = resolve(THEMES.midnight, 'dark');
const context = (): EmitContext => ({
  theme: T as unknown as EmitContext['theme'],
  target: 'web',
  site: { name: 'aurora' },
  slot: () => [],
  asset: (p) => p,
  ...actionsFor(T as unknown as EmitContext['theme']),
});

const nav = (modifiers: string[]): SpecBlock => ({
  word: 'nav', variant: 'bar', modifiers, args: [], props: { logo: './logo.svg' }, as: null,
  children: [{ word: 'link', variant: null, modifiers: [], args: [{ kind: 'string', value: 'Work' }, { kind: 'route', value: '/work' }], props: {}, as: null, children: [] }],
});

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const barOf = (root: EmittedNode) => walk(root).find((n) => n.tag === 'nav')!;

test('§3 hide: the bar pins, is marked for the runtime, and retracts by transform', () => {
  const bar = barOf(emitNav(nav(['hide']), context()));
  assert.equal(bar.attrs?.['data-az-hide'], '');
  assert.equal(bar.style?.position, 'sticky', 'hiding only means something for a bar that stays on screen');
  assert.equal(bar.states?.retracted?.transform, 'translateY(-100%)');
  assert.equal(bar.reducedMotion?.transition, 'none', '"must be instant under reduced-motion"');
});

test('§3 shrink: a frame reserves the full height; the bar and logo shrink inside it', () => {
  const root = emitNav(nav(['shrink']), context());
  assert.equal(root.tag, 'div', 'a frame around the bar');
  assert.equal(root.style?.position, 'sticky');
  assert.equal(root.style?.minHeight, `${T.size.nav}px`, 'the full height is held in the page — no layout shift');
  const bar = barOf(root);
  assert.equal(bar.attrs?.['data-az-shrink'], '');
  assert.equal(bar.style?.position, 'static', 'the frame pins it');
  assert.equal(bar.states?.shrunk?.minHeight, `${T.size['nav-shrink']}px`);
  const logo = walk(bar).find((n) => n.tag === 'img')!;
  assert.equal(logo.states?.shrunk?.height, `${T.space[24]}px`);
});

test('CONTROL: a plain sticky bar has no frame, no marks and no scroll states', () => {
  const root = emitNav(nav(['sticky']), context());
  assert.equal(root.tag, 'nav');
  assert.equal(root.style?.position, 'sticky');
  assert.equal(root.attrs?.['data-az-hide'], undefined);
  assert.equal(root.attrs?.['data-az-shrink'], undefined);
  assert.equal(root.states, undefined);
  assert.equal(emitNav(nav([]), context()).style?.position, 'static', 'and an unpinned bar stays in the flow');
});
