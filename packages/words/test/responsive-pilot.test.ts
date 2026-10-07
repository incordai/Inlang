/**
 * The responsive and state pilot — hero-spec §5/§10, nav-spec §7.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { emit as hero } from '../hero/emit.web.ts';
import { emit as nav } from '../nav/emit.web.ts';

const THEME = resolve(THEMES.midnight, 'dark') as unknown as EmitContext['theme'];
const context = (): EmitContext => ({
  theme: THEME,
  ...actionsFor(THEME),
  target: 'web',
  site: { name: 'aurora' },
  slot: (name) => [{ tag: 'li', children: [name] }],
  asset: (p) => p,
});
const cta: SpecBlock = {
  word: 'cta', variant: null, modifiers: [], as: null, children: [], props: {},
  args: [{ kind: 'string', value: 'Reserve a pair' }, { kind: 'route', value: '/reserve' }],
};
const block = (word: string, variant: string, props: Record<string, string> = {}): SpecBlock => ({
  word, variant, modifiers: [], args: [], as: null, children: [cta], props: { title: 'Built in the dark', ...props },
});
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const byClass = (n: EmittedNode, c: string) => walk(n).find((x) => x.attrs?.class?.split(' ').includes(c));

test('hero-spec §10: split restacks to one column below sm', () => {
  const out = hero(block('hero', 'split'), context());
  assert.equal(out.style?.gridTemplateColumns, 'minmax(0, 1fr) minmax(0, 1fr)', 'CONTROL: two columns on a desktop');
  assert.equal(out.below?.sm?.gridTemplateColumns, 'minmax(0, 1fr)');
});

test('hero-spec §10: center, stack and minimal keep their layout below sm — only the gutter changes', () => {
  for (const v of ['center', 'stack', 'minimal']) {
    assert.deepEqual(hero(block('hero', v), context()).below, { sm: { paddingInline: `${THEME.size['gutter-sm']}px` } }, v);
  }
});

test('hero-spec §5: under xs the actions stack full-width', () => {
  const actions = byClass(hero(block('hero', 'center'), context()), 'az-hero-actions');
  assert.equal(actions?.style?.flexDirection, undefined, 'CONTROL: a row on wider screens');
  // alignSelf: a centred column shrinks the row to its buttons; it stretches back.
  assert.deepEqual(actions?.below?.xs, { flexDirection: 'column', alignItems: 'stretch', alignSelf: 'stretch' });
});

test('hero-spec §2: center and full centre their boxes on one axis, not only the text in them', () => {
  for (const v of ['center', 'full']) {
    const out = hero(block('hero', v), context());
    assert.equal(out.style?.flexDirection, 'column', v);
    assert.equal(out.style?.alignItems, 'center', v);
    assert.equal(out.style?.textAlign, 'center', v);
  }
  for (const v of ['stack', 'minimal']) {
    assert.equal(hero(block('hero', v), context()).style?.alignItems, undefined, `CONTROL: ${v} keeps the start edge`);
  }
});

test('nav-spec §7: the skip link is off-screen until focused, and shown when focused', () => {
  const skip = byClass(nav(block('nav', 'bar'), context()), 'az-skip-link');
  assert.equal(skip?.style?.transform, 'translateY(-200%)', 'CONTROL: hidden at rest');
  assert.deepEqual(skip?.states?.focusVisible, { transform: 'none' });
});

test('hero-spec §2: split gives the text one column and the media the other', () => {
  const out = hero({ ...block('hero', 'split', { sub: 'Handmade.', eyebrow: 'Limited run', poster: './p.webp' }),
    modifiers: ['3d'] }, context());
  const cols = (out.children ?? []).filter((c): c is EmittedNode => typeof c !== 'string');
  assert.deepEqual(cols.map((c) => c.attrs?.class), ['az-hero-text', 'az-hero-media'],
    'exactly two grid children, so nothing pairs across the columns');
  const textClasses = walk(cols[0]).map((x) => x.attrs?.class);
  for (const c of ['az-hero-eyebrow', 'az-hero-title', 'az-hero-sub', 'az-hero-actions']) {
    assert.ok(textClasses.includes(c), `${c} sits in the text column`);
  }
  assert.ok(walk(cols[1]).some((x) => x.attrs?.class === 'az-hero-poster'), 'the poster sits in the media column');
});

test('CONTROL: single-column variants are not wrapped', () => {
  const out = hero(block('hero', 'center', { sub: 'Handmade.' }), context());
  const classes = (out.children ?? []).map((c) => (typeof c === 'string' ? c : c.attrs?.class));
  assert.ok(classes.includes('az-hero-title') && !classes.includes('az-hero-text'));
});
