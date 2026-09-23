/**
 * nav and footer — the structural rules their specs make non-negotiable.
 *
 * These two words carry most of the page's accessibility surface, and almost
 * all of it is invisible when wrong: a footer whose columns are separate
 * landmarks, a skip link that is not first, a group heading that is an <h1>.
 * Nothing looks broken. It just is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { emit as emitNav } from '../nav/emit.web.ts';
import { emit as emitFooter } from '../footer/emit.web.ts';

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
    slot: () => [],
    asset: (p) => p,
    ...actionsFor(t as unknown as EmitContext['theme']),
  };
}

const block = (over: Partial<SpecBlock> = {}): SpecBlock => ({
  word: 'nav', variant: null, modifiers: [], args: [], props: {},
  as: null, children: [], ...over,
});

const child = (word: string, args: string[], kids: SpecBlock[] = []): SpecBlock =>
  block({ word, args: args.map((value) => ({ kind: 'string', value })), children: kids });

/** Every node in the tree, depth-first, in document order. */
function walk(node: EmittedNode): EmittedNode[] {
  const out: EmittedNode[] = [node];
  for (const c of node.children ?? []) {
    if (typeof c !== 'string') out.push(...walk(c));
  }
  return out;
}
const byTag = (n: EmittedNode, tag: string) => walk(n).filter((x) => x.tag === tag);
const cls = (n: EmittedNode) => String(n.attrs?.class ?? '');

/* ---------------------------- nav ---------------------------- */

const NAV = block({
  word: 'nav', variant: 'split', modifiers: ['sticky'],
  props: { logo: './logo.svg', mobile: 'drawer' },
  children: [
    child('link', ['Work', '/work']),
    child('group', ['Products'], [child('link', ['Shoes', '/shoes'])]),
    child('cta', ['Reserve', '/reserve']),
  ],
});

test('nav-spec §7: the skip link is the FIRST focusable element', () => {
  const node = emitNav(NAV, context());
  const focusable = walk(node).filter((n) => n.tag === 'a' || n.tag === 'button');
  assert.ok(focusable.length > 1, 'CONTROL: there are several focusable elements');
  assert.equal(cls(focusable[0]), 'az-skip-link', 'the skip link must come first');
});

test('nav-spec §7: the skip link is hidden by TRANSFORM, never display:none', () => {
  // display:none removes it from the focus order entirely, which makes the
  // whole thing decorative — it can never be reached to be skipped to.
  const skip = walk(emitNav(NAV, context())).find((n) => cls(n) === 'az-skip-link')!;
  assert.notEqual(skip.style?.display, 'none');
  assert.match(String(skip.style?.transform), /translate/);
});

test('nav-spec §7: the landmark carries an aria-label', () => {
  const node = emitNav(NAV, context());
  assert.equal(node.tag, 'nav');
  assert.ok(node.attrs?.['aria-label'], 'a page has more than one nav landmark');
});

test('nav-spec §6: the toggle is a <button> with aria-expanded and aria-controls', () => {
  const toggle = walk(emitNav(NAV, context())).find((n) => cls(n) === 'az-nav-toggle')!;
  assert.equal(toggle.tag, 'button', 'never a div with an onclick');
  assert.equal(toggle.attrs?.['aria-expanded'], 'false');
  assert.equal(toggle.attrs?.['aria-controls'], 'az-nav-panel');
  const panel = walk(emitNav(NAV, context())).find((n) => n.attrs?.id === 'az-nav-panel');
  assert.ok(panel, 'aria-controls must point at something that exists');
});

test('nav-spec §6: the CTA stays in the bar, not inside the mobile panel', () => {
  const node = emitNav(NAV, context());
  const panel = walk(node).find((n) => n.attrs?.id === 'az-nav-panel')!;
  const isCta = (n: EmittedNode) => cls(n).split(' ').includes('az-action');
  assert.equal(walk(panel).filter(isCta).length, 0);
  assert.equal(walk(node).filter(isCta).length, 1,
    'it is in the bar itself');
});

test('nav-spec §7: every interactive target clears 44px', () => {
  const t = resolve(THEMES.midnight, 'dark');
  assert.equal(t.size.tap, 44, 'CONTROL: the token really is the 44px floor');
  for (const n of walk(emitNav(NAV, context()))) {
    if (n.tag !== 'a' && n.tag !== 'button') continue;
    if (cls(n) === 'az-skip-link') continue;      // hidden until focused
    const h = String(n.style?.minHeight ?? n.style?.minWidth ?? '');
    assert.equal(h, '44px', `${cls(n) || n.tag} is ${h || 'unconstrained'}`);
  }
});

test('nav-spec §7: a group label is a button, not a hover-only link', () => {
  const label = walk(emitNav(NAV, context())).find((n) => cls(n) === 'az-nav-group-label')!;
  assert.equal(label.tag, 'button', 'a hover-only dropdown is a keyboard dead end');
});

/* --------------------------- footer --------------------------- */

const COLUMNS = block({
  word: 'footer', variant: 'columns',
  props: { tagline: 'Handmade in the dark.', copyright: 'Aurora Studio', since: '2019', year: 'dynamic' },
  children: [
    child('group', ['Shop'], [child('link', ['Shoes', '/shoes']), child('link', ['Bags', '/bags'])]),
    child('group', ['Studio'], [child('link', ['About', '/about'])]),
    child('legal', ['Privacy', '/privacy']),
  ],
});

test('footer-spec §9: all links live in ONE nav, not one per column', () => {
  const node = emitFooter(COLUMNS, context());
  const navs = byTag(node, 'nav');
  assert.equal(navs.length, 1, `${navs.length} footer navs — §9 says exactly one`);
  assert.equal(navs[0].attrs?.['aria-label'], 'Footer');
});

test('footer-spec §9: column headings are <h2>, and there is never an <h1>', () => {
  const node = emitFooter(COLUMNS, context());
  assert.equal(byTag(node, 'h1').length, 0, 'an <h1> here conflicts with the hero');
  const h2s = byTag(node, 'h2');
  assert.equal(h2s.length, 2, 'one per group');
  assert.deepEqual(h2s.map((h) => h.children?.[0]), ['Shop', 'Studio']);
});

test('footer-spec §9: legal links sit OUTSIDE the footer nav', () => {
  // They are not navigation. Inside the nav they inflate the landmark and
  // read as part of the site's IA.
  const node = emitFooter(COLUMNS, context());
  const nav = byTag(node, 'nav')[0];
  assert.equal(walk(nav).filter((n) => cls(n) === 'az-footer-legal').length, 0);
  assert.equal(walk(node).filter((n) => cls(n) === 'az-footer-legal').length, 1);
});

test('footer-spec §9: `minimal` with <=3 links emits NO nav — a bare <ul>', () => {
  const minimal = block({
    word: 'footer',
    children: [child('link', ['Pricing', '#pricing']), child('link', ['Privacy', '/legal'])],
  });
  const node = emitFooter(minimal, context());
  assert.equal(byTag(node, 'nav').length, 0, 'two links do not earn a landmark');
  assert.equal(byTag(node, 'ul').length, 1, 'but the links are still there');
});

test('CONTROL: the same footer WITH groups does get its nav', () => {
  // Without this, an emitter that never produced a <nav> would pass above.
  assert.equal(byTag(emitFooter(COLUMNS, context()), 'nav').length, 1);
});

test('footer-spec §5: `year dynamic` emits the SINCE literal, marked for the client', () => {
  // The emitted bytes must not contain today's date, or a build differs from
  // itself tomorrow and the determinism claim is gone.
  const node = emitFooter(COLUMNS, context());
  const span = walk(node).find((n) => n.attrs?.['data-year'] === 'dynamic')!;
  assert.ok(span, 'the client needs a hook to write the rolling year into');
  assert.equal(span.children?.[0], '2019', 'the fallback is the declared `since`');
  const thisYear = String(new Date().getFullYear());
  const rendered = JSON.stringify(node);
  assert.ok(!rendered.includes(thisYear) || thisYear === '2019',
    'the current year must never be baked into the output');
});

/* ---- the logo link has a name: nav-spec §7, footer-spec §9 ------------ */

/** The text a screen reader would read for a node: every string beneath it. */
const textOf = (n: EmittedNode | string): string =>
  typeof n === 'string' ? n : (n.children ?? []).map(textOf).join('');

const logoLink = (n: EmittedNode, klass: string) => {
  const link = walk(n).find((x) => cls(x) === klass);
  assert.ok(link, `CONTROL: a ${klass} link was emitted`);
  return link;
};

for (const [word, emitWord, klass] of [
  ['nav', emitNav, 'az-nav-logo'],
  ['footer', emitFooter, 'az-footer-logo'],
] as const) {
  test(`${word}: the logo link is named by the site, not left empty`, () => {
    const link = logoLink(emitWord(block({ word, props: { logo: './logo.svg' } }), context()), klass);
    assert.equal(textOf(link), 'aurora', 'the link text must be the site name');
    const img = walk(link).find((x) => x.tag === 'img');
    assert.equal(img?.attrs?.alt, '', 'the image stays decorative, so the name is not read twice');
  });

  test(`${word}: CONTROL — the name comes from the site, not a constant`, () => {
    const ctx = { ...context(), site: { name: 'Harbour Studio' } };
    const link = logoLink(emitWord(block({ word, props: { logo: './logo.svg' } }), ctx), klass);
    assert.equal(textOf(link), 'Harbour Studio');
  });
}

/* ---- `side` is a column beside the page, a bar on phones (§10 Q2, §6) ----- */

test('side: a sticky, scrollable column of full height on desktop', () => {
  const nav = emitNav(block({ variant: 'side' }), context());
  assert.equal(nav.style?.position, 'sticky');
  assert.equal(nav.style?.height, '100svh');
  assert.equal(nav.style?.overflowY, 'auto');
  assert.equal(nav.style?.flexDirection, 'column');
});

test('side: below sm the column becomes a bar', () => {
  const nav = emitNav(block({ variant: 'side' }), context());
  const sm = nav.below?.sm ?? {};
  assert.equal(sm.flexDirection, 'row');
  assert.equal(sm.height, 'auto');
  assert.equal(sm.width, 'auto');
});

test('CONTROL: a horizontal bar gets none of the column rules', () => {
  const nav = emitNav(block({ variant: 'bar' }), context());
  assert.equal(nav.style?.height, undefined);
  assert.equal(nav.below?.sm?.flexDirection, undefined);
});
