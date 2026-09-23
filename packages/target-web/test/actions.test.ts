/**
 * The action primitive — buttons-and-sections-spec §1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { actionsFor } from '../src/actions.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';
import type { SpecBlock } from '../../core/src/spec-block.ts';

const T = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;
const { action, actions, submit } = actionsFor(T, { asset: (p) => `/sandboxed/${p}` });

const fill = (word: string, label: string, dest?: { kind: string; value: string }, as: string | null = null): SpecBlock => ({
  word, variant: null, modifiers: [], as, children: [], props: {},
  args: [{ kind: 'string', value: label }, ...(dest ? [dest] : [])],
});
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const text = (n: EmittedNode | string): string =>
  typeof n === 'string' ? n : (n.children ?? []).map(text).join('');

test('§1.2/§1.4: each intent gets its element and attributes', () => {
  const row = (kind: string, value: string) => action(fill('cta', 'Go', { kind, value }));
  assert.deepEqual([row('route', '/reserve').tag, row('route', '/reserve').attrs?.href], ['a', '/reserve']);
  assert.equal(row('anchor', '#pricing').attrs?.href, '#pricing');
  const ext = row('pair', 'https://example.org/x');
  assert.equal(ext.attrs?.target, '_blank');
  assert.equal(ext.attrs?.rel, 'noopener noreferrer');
  assert.match(text(ext), /\(opens in new tab\)/, 'a new tab is announced');
  assert.equal(row('path', './deck.pdf').attrs?.download, '');
  for (const value of ['video:intro', 'copy:hello']) {
    // A video action comes with its popup beside it; the action is the button.
    const b = walk(row('pair', value)).find((n) => n.attrs?.['data-az-behaviour'] !== undefined && n.tag !== 'dialog')!;
    assert.equal(b.tag, 'button', `${value} acts, so it is a <button> (§1.4)`);
    assert.equal(b.attrs?.type, 'button');
    assert.equal(b.attrs?.['data-az-behaviour'], value.startsWith('video') ? 'play' : 'copy');
  }
  assert.equal(row('route', '/a').attrs?.target, undefined, 'CONTROL: an internal link stays in the tab');
});

test('§1.6: a type icon leads, a direction icon trails, never both', () => {
  const kids = (value: string, kind = 'pair') => action(fill('cta', 'X', { kind, value })).children ?? [];
  const isIcon = (c: EmittedNode | string | undefined) => typeof c !== 'string' && c?.tag === 'svg';
  for (const v of ['tel:+1', 'mailto:a@b.c']) assert.ok(isIcon(kids(v)[0]) && !isIcon(kids(v).at(-1)), v);
  assert.ok(isIcon(kids('./deck.pdf', 'path')[0]));
  const ext = kids('https://example.org');
  assert.ok(!isIcon(ext[0]) && ext.filter(isIcon).length === 1, 'external: one trailing icon');
  assert.equal(kids('/a', 'route').filter(isIcon).length, 0, 'CONTROL: go has no icon');
  for (const c of walk(action(fill('cta', 'X', { kind: 'pair', value: 'tel:+1' })))) {
    if (c.tag === 'svg') assert.equal(c.attrs?.['aria-hidden'], 'true');
  }
});

test('§1.2: first cta is primary, the rest secondary, `as` overrides', () => {
  const block: SpecBlock = {
    word: 'hero', variant: null, modifiers: [], as: null, props: {}, args: [],
    children: [fill('cta', 'A', { kind: 'route', value: '/a' }), fill('cta', 'B', { kind: 'route', value: '/b' }),
      fill('alt', 'C', { kind: 'route', value: '/c' }), fill('alt', 'D', { kind: 'route', value: '/d' }, 'ghost')],
  };
  const weights = actions(block, ['cta', 'alt']).map((li) => (li.children?.[0] as EmittedNode).attrs?.class?.split(' ')[1]);
  assert.deepEqual(weights, ['az-action--primary', 'az-action--secondary', 'az-action--secondary', 'az-action--ghost']);
  assert.ok(actions(block, ['cta']).every((li) => li.tag === 'li'), 'each action is a list item');
});

test('§1.5: all six states, a 44px target, and no transform anywhere', () => {
  for (const h of ['primary', 'secondary', 'ghost', 'link'] as const) {
    const a = action(fill('cta', 'X', { kind: 'route', value: '/x' }), { hierarchy: h });
    assert.deepEqual(Object.keys(a.states ?? {}).sort(), ['active', 'disabled', 'focusVisible', 'hover', 'loading'], h);
    assert.equal(a.style?.minHeight, `${T.size.tap}px`);
    assert.match(String(a.states?.focusVisible?.outline), new RegExp(`${T.size.ring}px solid`));
    assert.equal(a.states?.focusVisible?.outlineOffset, `${T.size['ring-offset']}px`);
    assert.equal(a.states?.loading?.color, 'transparent', 'loading hides the label but keeps the width');
    const all = JSON.stringify(a);
    assert.doesNotMatch(all, /transform/, 'nothing moves, so reduced motion has nothing to undo');
  }
});

test('§3 of cta: on the accent band the ring is drawn in accent-contrast', () => {
  const page = action(fill('cta', 'X', { kind: 'route', value: '/x' }));
  const band = action(fill('cta', 'X', { kind: 'route', value: '/x' }), { tone: 'inverted' });
  assert.match(String(page.states?.focusVisible?.outline), new RegExp(T.color.focus.replace(/[()]/g, '\\$&')));
  assert.match(String(band.states?.focusVisible?.outline), new RegExp(T.color['accent-contrast'].replace(/[()]/g, '\\$&')));
  assert.equal(band.style?.background, T.color['accent-contrast']);
  assert.equal(band.style?.color, T.color.accent);
});

test('hero §5: compact below xs — primary fills the row, secondary becomes a link', () => {
  const primary = action(fill('cta', 'A', { kind: 'route', value: '/a' }), { compactBelow: 'xs' });
  const secondary = action(fill('alt', 'B', { kind: 'route', value: '/b' }), { compactBelow: 'xs' });
  assert.deepEqual(primary.below?.xs, { width: '100%' });
  assert.equal(secondary.below?.xs?.color, T.color.accent);
  assert.equal(secondary.below?.xs?.paddingInline, 0);
  assert.equal(action(fill('cta', 'A', { kind: 'route', value: '/a' })).below, undefined, 'CONTROL: not compact unless asked');
});

test('submit: a real submit button carrying its method, optionally skipping validation', () => {
  const s = submit('Sign in', { name: 'method', value: 'password' });
  assert.deepEqual([s.tag, s.attrs?.type, s.attrs?.name, s.attrs?.value], ['button', 'submit', 'method', 'password']);
  assert.equal(s.attrs?.formnovalidate, undefined);
  assert.equal(submit('Email me a link', { noValidate: true, hierarchy: 'secondary' }).attrs?.formnovalidate, 'formnovalidate');
});

test('PRD §6.6: a slot component naming an action slot joins the actions in order', () => {
  const custom = actionsFor(T, { component: (c) => ({ tag: '#component', attrs: { src: c.args[1]?.value ?? '' } }) });
  const block: SpecBlock = {
    word: 'hero', variant: null, modifiers: [], as: null, props: {}, args: [],
    children: [fill('cta', 'A', { kind: 'route', value: '/a' }),
      { ...fill('slot', 'cta'), args: [{ kind: 'word', value: 'cta' }, { kind: 'path', value: './custom/Extra.tsx' }] }],
  };
  const items = custom.actions(block, ['cta']);
  assert.deepEqual(items.map((li) => li.attrs?.class), ['az-action-item az-action-item--cta', 'az-action-item az-action-item--custom']);
  assert.equal(actions(block, ['cta']).length, 1, 'CONTROL: without the hook only the fill renders');
});

/* ---- play: the video popup (overlays-spec §4) ---------------------------- */

test('video: the play button opens a popup dialog beside it, with a close control', () => {
  const [li] = actions({ ...fill('hero', ''), children: [fill('cta', 'Watch the film', { kind: 'pair', value: 'video:./film.mp4' })] }, ['cta']);
  const [button, dialog] = (li.children ?? []) as EmittedNode[];
  assert.equal(button.tag, 'button');
  assert.equal(button.attrs?.['aria-haspopup'], 'dialog');
  assert.equal(button.attrs?.['aria-expanded'], 'false');
  assert.equal(dialog.tag, 'dialog', 'the runtime opens the button\'s next sibling');
  assert.equal(dialog.attrs?.['data-az-behaviour'], 'dialog');
  assert.equal(dialog.attrs?.['data-az-overlay'], 'popup');
  assert.equal(dialog.attrs?.['aria-label'], 'Watch the film');
  const x = walk(dialog).find((n) => n.attrs?.['data-az-close'] !== undefined);
  assert.equal(x?.attrs?.['aria-label'], 'Close video');
  const video = walk(dialog).find((n) => n.tag === 'video');
  assert.equal(video?.attrs?.src, '/sandboxed/./film.mp4', 'the file goes through the asset sandbox');
  assert.equal(video?.attrs?.preload, 'none', 'nothing loads until the reader asks');
  assert.equal(video?.attrs?.autoplay, undefined, 'hero §9: never autoplay');
});

test('video: a URL is used as written; popup: stays a button without a dialog', () => {
  const url = walk(action(fill('cta', 'Watch', { kind: 'pair', value: 'video:https://media.example.org/f.mp4' })));
  assert.equal(url.find((n) => n.tag === 'video')?.attrs?.src, 'https://media.example.org/f.mp4');
  const declared = action(fill('cta', 'Sizes', { kind: 'pair', value: 'popup:#sizes' }));
  assert.equal(declared.tag, 'button', 'CONTROL: declared popups are Phase 1.5 — no dialog yet');
  assert.equal(walk(declared).some((n) => n.tag === 'dialog'), false);
});

test('SECURITY: a video file outside the project is refused by the sandbox', () => {
  const sandboxed = actionsFor(T, { asset: (p) => { if (p.includes('..')) throw new Error('escape'); return p; } });
  assert.throws(() => sandboxed.action(fill('cta', 'X', { kind: 'pair', value: 'video:../../secret.mp4' })), /escape/);
});

test('no resolver means no silent bypass: a video action without one throws', () => {
  assert.throws(() => actionsFor(T).action(fill('cta', 'X', { kind: 'pair', value: 'video:./f.mp4' })), /no asset resolver/);
});
