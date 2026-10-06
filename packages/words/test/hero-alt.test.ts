/**
 * hero `alt`, `describe` and `focus` — hero-block-spec §1, §5, §8, §9, §10.
 *
 * `alt "Label" <dest>` is the hero's SECONDARY button (§1, GRAMMAR §5.2).
 * It used to be declared as a string prop as well, and the linker turns a
 * child named after a prop into that prop — so the button was dropped without
 * a word, and its label became the poster's alt text. The poster's
 * description is now `describe`, the name cta-spec §11 already uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, blocksFor, type Manifest } from '../../core/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmittedNode } from '../../core/src/emit-contract.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../registry.ts';

const wordsDir = new URL('../', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const THEME = resolve(THEMES.midnight, 'dark') as unknown as Parameters<typeof emitBlock>[1];

function heroOf(lines: string[]) {
  const src = ['az 1', 'site aurora', 'page /', ...lines.map((l) => `  ${l}`)].join('\n') + '\n';
  const result = compile(src, { manifests });
  const spec = result.spec;
  const hero = spec ? blocksFor(spec, spec.pages[0]).find((b) => b.word === 'hero') : undefined;
  return { result, hero };
}

const render = (hero: SpecBlock) =>
  emitBlock(hero, THEME, WEB_EMITTERS, (p) => `/${p.replace(/^\.\//, '')}`, { name: 'aurora' });

const kids = (n: EmittedNode): EmittedNode[] =>
  (n.children ?? []).filter((c): c is EmittedNode => typeof c !== 'string');

function find(n: EmittedNode, pred: (e: EmittedNode) => boolean): EmittedNode | undefined {
  if (pred(n)) return n;
  for (const c of kids(n)) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

const TWO_BUTTONS = [
  'hero center',
  '  title "Built in the dark"',
  '  cta   "Reserve a pair"  /reserve',
  '  alt   "Call the studio" tel:+50412345678',
];

test('§1: `alt "Label" <dest>` reaches the Spec as the secondary button', () => {
  const { result, hero } = heroOf(TWO_BUTTONS);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const alt = hero?.children.find((c) => c.word === 'alt');
  assert.ok(alt, 'the secondary button must survive linking, not become a prop');
  assert.deepEqual(alt.args.map((a) => a.value), ['Call the studio', 'tel:+50412345678']);
  assert.equal(hero?.props.alt, undefined, 'its label must never become an image description');
});

test('§5: the secondary follows the primary in the same actions row', () => {
  const { hero } = heroOf(TWO_BUTTONS);
  const actions = find(render(hero!), (e) => e.attrs?.class === 'az-hero-actions');
  assert.ok(actions, 'the hero rendered an actions row');
  const classes = kids(actions).map((c) => c.attrs?.class);
  assert.deepEqual(classes, ['az-action-item az-action-item--cta', 'az-action-item az-action-item--alt']);
  const link = find(kids(actions)[1], (e) => e.tag === 'a');
  assert.equal(link?.attrs?.href, 'tel:+50412345678', 'the destination is kept as written');
  const text = (link?.children ?? []).filter((c) => typeof c === 'string');
  assert.deepEqual(text, ['Call the studio']);
  // buttons §1.6: a call is a TYPE, so its icon leads the label.
  const first = link?.children?.[0];
  assert.ok(typeof first !== 'string' && first?.tag === 'svg', 'the call icon leads');
});

test('CONTROL: a hero with only a primary renders one action', () => {
  const { hero } = heroOf(TWO_BUTTONS.slice(0, 3));
  const actions = find(render(hero!), (e) => e.attrs?.class === 'az-hero-actions');
  assert.equal(kids(actions!).length, 1);
});

test('§5: a second `alt` is refused — one secondary at most', () => {
  const { result } = heroOf([...TWO_BUTTONS, '  alt   "Or email us" mailto:studio@aurora.example']);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'AZ1209' && /alt/.test(d.message)),
    JSON.stringify(result.diagnostics));
});

const POSTER = [
  'hero split 3d',
  '  title    "Built in the dark"',
  '  poster   ./assets/shoe.webp',
  '  describe "A black leather boot on a workbench"',
];

test('§8/§9: a 3d hero renders its poster with `describe` as the alt text', () => {
  const { result, hero } = heroOf(POSTER);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const img = find(render(hero!), (e) => e.attrs?.class === 'az-hero-poster');
  assert.ok(img, 'the poster is emitted');
  assert.equal(img.tag, 'img');
  assert.equal(img.attrs?.src, '/assets/shoe.webp', 'the path goes through the asset resolver');
  assert.equal(img.attrs?.alt, 'A black leather boot on a workbench');
});

test('§8: the poster is not lazy and claims no fetch priority — the text is the LCP', () => {
  const { hero } = heroOf(POSTER);
  const img = find(render(hero!), (e) => e.attrs?.class === 'az-hero-poster');
  assert.equal(img?.attrs?.loading, undefined);
  assert.equal(img?.attrs?.fetchpriority, undefined);
  // Document order, whatever wraps them: split puts text and media in columns.
  const order = (n: EmittedNode): EmittedNode[] => [n, ...kids(n).flatMap(order)];
  const all = order(render(hero!));
  const h1 = all.findIndex((e) => e.tag === 'h1');
  const poster = all.findIndex((e) => e.attrs?.class === 'az-hero-poster');
  assert.ok(h1 >= 0 && h1 < poster, 'the headline comes before the media in source order');
});

test('CONTROL: without `3d` a poster renders nothing', () => {
  const { hero } = heroOf(['hero center', ...POSTER.slice(1)]);
  assert.equal(find(render(hero!), (e) => e.attrs?.class === 'az-hero-poster'), undefined);
});

test('§9: a 3d hero without a description is warned about, not silently shipped', () => {
  const { result } = heroOf(POSTER.slice(0, 3));
  assert.equal(result.ok, true, 'a warning, never a block');
  assert.ok(result.diagnostics.some((d) =>
    d.severity === 'warning' && /describe/.test(d.message)), JSON.stringify(result.diagnostics));
});

test('CONTROL: with a description the describe warning is gone', () => {
  const { result } = heroOf(POSTER);
  assert.ok(!result.diagnostics.some((d) => /describe/.test(d.message)),
    JSON.stringify(result.diagnostics));
});

test('§10: `focus` is the poster crop\'s focal point — object-position, centre by default', () => {
  const poster = (focus: string | null) => {
    const { result, hero } = heroOf([
      'hero full 3d',
      '  title "Built in the dark"',
      '  poster ./assets/still.webp',
      '  describe "A workbench under one lamp"',
      ...(focus ? [`  focus ${focus}`] : []),
    ]);
    assert.ok(hero, result.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
    const img = find(render(hero), (n) => n.tag === 'img');
    assert.ok(img, 'the poster is emitted');
    return img.style ?? {};
  };
  assert.equal(poster('top').objectPosition, 'top');
  assert.equal(poster('left').objectPosition, 'left');
  assert.equal(poster('top').objectFit, 'cover', 'the crop it positions');
  assert.equal(poster(null).objectPosition, undefined, 'CONTROL: no focus, the default centre');
  assert.equal(poster('center').objectPosition, undefined, 'CONTROL: centre is the default, written as nothing');
  const { result } = heroOf(['hero full', '  title "x"', '  focus middle']);
  assert.ok(result.diagnostics.some((d) => d.severity === 'error'), 'a value outside the enum is refused');
});
