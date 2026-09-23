/**
 * The markup the behaviour runtime wires — nav-block-spec §4, §6, §7;
 * faq-block-spec §7, §8; overlays-spec §2, §6.
 *
 * The runtime is proven in real browsers (scripts/visual.mjs). These prove
 * the emitted structure it depends on, through the real compiler and target.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFor, compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import { WEB_EMITTERS } from '../registry.ts';
import { questionIds } from '../faq/emit.web.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const w of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}
const T = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;

function emitted(word: string, lines: string[], site: string[] = []): EmittedNode {
  const src = ['az 1', 'site aurora', ...site, 'page /', '  hero center', '    title "x"', ...lines,
    'page /work', 'page /shoes', 'page /bags', 'page /reserve', ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b) => b.word === word)!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const byClass = (n: EmittedNode, c: string) => walk(n).filter((x) => x.attrs?.class?.split(' ').includes(c));
const text = (n: EmittedNode | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(text).join(''));

/* ---- nav ------------------------------------------------------------------ */

const NAV = ['  nav bar sticky solid', '    link "Work" /work',
  '    group "Products"', '      link "Shoes" /shoes', '      link "Bags" /bags', '    cta "Reserve" /reserve'];
const nav = () => emitted('nav', NAV);

test('§6: the drawer is a modal <dialog> the toggle controls, holding every link', () => {
  const n = nav();
  const toggle = byClass(n, 'az-nav-toggle')[0];
  const drawer = walk(n).find((x) => x.tag === 'dialog')!;
  assert.equal(toggle.tag, 'button');
  assert.equal(toggle.attrs?.['aria-controls'], drawer.attrs?.id);
  assert.equal(toggle.attrs?.['aria-expanded'], 'false');
  assert.equal(drawer.attrs?.['data-az-behaviour'], 'dialog');
  assert.equal(drawer.attrs?.['data-az-overlay'], 'drawer');
  assert.equal(drawer.attrs?.['aria-label'], 'Menu');
  assert.deepEqual(walk(drawer).filter((x) => x.tag === 'a').map((a) => a.attrs?.href), ['/work', '/shoes', '/bags']);
  const close = walk(drawer).find((x) => x.attrs?.['data-az-close'] !== undefined);
  assert.equal(close?.attrs?.['aria-label'], 'Close menu', 'overlays §2: Esc, outside, and X');
});

test('§6: the links collapse into the drawer below sm, and only then is the toggle shown', () => {
  const n = nav();
  const barItems = byClass(n, 'az-nav-items')[0];
  const toggle = byClass(n, 'az-nav-toggle')[0];
  assert.equal(barItems.below?.sm?.display, 'none');
  assert.equal(toggle.style?.display, 'none', 'no menu button beside the links on desktop');
  assert.equal(toggle.below?.sm?.display, 'inline-flex');
  const cta = walk(n).find((x) => x.tag === 'a' && text(x) === 'Reserve');
  assert.ok(cta && !walk(walk(n).find((x) => x.tag === 'dialog')!).includes(cta), '§6: the CTA stays in the bar');
});

test('CONTROL: `minimal` has no bar links, so its menu button shows at every size', () => {
  const n = emitted('nav', ['  nav minimal', '    link "Work" /work']);
  const toggle = byClass(n, 'az-nav-toggle')[0];
  assert.equal(toggle.style?.display, 'inline-flex');
  assert.equal(toggle.below, undefined);
});

test('CONTROL: a nav without links has no toggle and no drawer', () => {
  const n = emitted('nav', ['  nav bar', '    cta "Reserve" /reserve']);
  assert.equal(byClass(n, 'az-nav-toggle').length, 0);
  assert.equal(walk(n).some((x) => x.tag === 'dialog'), false);
});

test('overlays §6: a nav group is a <button aria-expanded> and a plain <ul>, never a menu', () => {
  const group = byClass(nav(), 'az-nav-group')[0];
  const [button, list] = (group.children ?? []) as EmittedNode[];
  assert.equal(group.attrs?.['data-az-behaviour'], 'dropdown');
  assert.equal(button.tag, 'button');
  assert.equal(button.attrs?.['aria-controls'], list.attrs?.id);
  assert.equal(list.tag, 'ul');
  assert.equal(list.attrs?.hidden, 'hidden');
  assert.equal(list.attrs?.['data-az-overlay'], 'dropdown');
  assert.equal(walk(nav()).some((x) => x.attrs?.role === 'menu' || x.attrs?.role === 'menuitem'), false);
});

test('§4: a solid nav is marked for the runtime and turns solid when scrolled', () => {
  const n = nav();
  assert.equal(n.attrs?.['data-az-behaviour'], 'solid');
  assert.equal(n.style?.background, 'transparent');
  assert.equal(n.states?.scrolled?.background, T.color.bg);
  const plain = emitted('nav', ['  nav bar', '    link "Work" /work']);
  assert.equal(plain.attrs?.['data-az-behaviour'], undefined, 'CONTROL: no solid, no scroll behaviour');
});

/* ---- faq ------------------------------------------------------------------ */

const faq = (items: string[], modifiers = '') => emitted('faq', [`  faq list${modifiers}`, '    title "Questions"',
  ...items.flatMap((q) => [`    item "${q}"`, '      text "Yes, within thirty days."'])]);
const THREE = ['Do you ship abroad?', 'Can I return a pair?', 'Are they handmade?'];

test('faq §7.1: the button sits inside the <h3> and controls the answer panel', () => {
  const n = faq(THREE);
  const h3 = walk(n).find((x) => x.tag === 'h3')!;
  const button = (h3.children ?? [])[0] as EmittedNode;
  const panel = walk(n).find((x) => x.attrs?.id === `${h3.attrs?.id}-panel`)!;
  assert.equal(h3.attrs?.id, 'faq-do-you-ship-abroad', '§7.4: a stable, readable anchor');
  assert.equal(button.tag, 'button');
  assert.equal(button.attrs?.['aria-controls'], panel.attrs?.id);
  assert.equal(panel.attrs?.role, 'region');
  assert.equal(panel.attrs?.['aria-labelledby'], button.attrs?.id);
});

test('faq §8: with JS off every answer is in the page and open', () => {
  const n = faq(THREE);
  for (const b of walk(n).filter((x) => x.attrs?.['data-az-disclosure'] !== undefined)) {
    assert.equal(b.attrs?.['aria-expanded'], 'true');
  }
  assert.equal(walk(n).some((x) => x.attrs?.hidden !== undefined), false, 'the runtime collapses them');
  assert.match(text(n), /Yes, within thirty days\./);
});

test('faq §7.1: past six items the answers stop being landmarks', () => {
  const seven = Array.from({ length: 7 }, (_, i) => `Question number ${i + 1}?`);
  const panels = walk(faq(seven)).filter((x) => x.attrs?.class === 'az-faq-answer');
  assert.equal(panels.length, 7);
  assert.ok(panels.every((p) => p.attrs?.role === undefined));
});

test('faq §7.2: `single` opts in to one open at a time; the default is independent', () => {
  const list = (n: EmittedNode) => walk(n).find((x) => x.attrs?.['data-az-behaviour'] === 'faq')!;
  assert.equal(list(faq(THREE)).attrs?.['data-single'], 'false');
  assert.equal(list(faq(THREE, ' single')).attrs?.['data-single'], 'true');
});

test('faq §7.4: ids are slugs, collisions numbered, deterministic', () => {
  assert.deepEqual(questionIds(['Can I return them?', 'Can I return them!', '???']),
    ['faq-can-i-return-them', 'faq-can-i-return-them-2', 'faq-question']);
  assert.deepEqual(questionIds(THREE), questionIds(THREE));
});

test('faq §7.4: a numbered collision never lands on a slug already taken', () => {
  // "A 2" slugs to faq-a-2 — exactly the id the second "A" was given.
  const ids = questionIds(['A', 'A', 'A 2']);
  assert.equal(new Set(ids).size, ids.length, ids.join(' '));
  assert.deepEqual(ids, ['faq-a', 'faq-a-2', 'faq-a-2-2']);
});
