/**
 * Ids are unique on every page — HTML requires it, and the runtime finds a
 * disclosure's panel with getElementById(aria-controls).
 *
 * Words build ids from their own content, so two blocks on one page — two
 * FAQs asking the same question, two pricing sections — produced the same
 * ids: the second FAQ's buttons opened the FIRST FAQ's answers, and two
 * pricing sections shared one radio group. The target sees the whole page,
 * so it keeps the first block's ids (deep links stay stable) and renames a
 * later block's duplicates together with every reference inside that block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import type { EmittedNode } from '../../core/src/emit-contract.ts';
import { emit } from '../src/emit.ts';
import { uniqueIds } from '../src/ids.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const faq = (title: string, extra = '') => `  faq list\n    title "${title}"\n${extra}` +
  ['How long does it take?', 'Do you ship abroad?', 'Can I track it?']
    .map((q) => `    item "${q}"\n      text "Answer."\n`).join('');
const pricing = (title: string) => `  pricing cards\n    title "${title}"\n    currency usd\n` +
  ['Studio', 'Practice'].map((p) => `    plan "${p}"\n      monthly 29\n      annual 290\n      cta "Start" /start\n`).join('');
const SOURCE = `az 1\nsite aurora\npage /\n  hero center\n    title "x"\n${faq('Shipping')}${faq('Repairs', '    schema off\n')}${pricing('Shoes')}${pricing('Repairs')}page /start\n`;

/** The home page's node tree, as the App ships it. */
function home(source: string): EmittedNode[] {
  const r = compile(source, { manifests });
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  const app = emit(r.spec!, { emitters: WEB_EMITTERS }).find((f) => f.path === 'src/App.tsx')!.content;
  // `const PAGES: … = [` … `\n];` — the array is written with two-space
  // indentation, so only the top level closes at the start of a line.
  const start = app.indexOf('= [', app.indexOf('const PAGES')) + 2;
  const pages = JSON.parse(app.slice(start, app.indexOf('\n];', start) + 2)) as { route: string; nodes: EmittedNode[] }[];
  return pages.find((p) => p.route === '/')!.nodes;
}

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const all = (nodes: EmittedNode[]) => nodes.flatMap(walk);
const ids = (nodes: EmittedNode[]) => all(nodes).map((n) => n.attrs?.id).filter((x): x is string => !!x);

test('no id appears twice on a page with two FAQs and two pricing sections', () => {
  const list = ids(home(SOURCE));
  const dupes = list.filter((id, i) => list.indexOf(id) !== i);
  assert.deepEqual(dupes, []);
});

test('every disclosure controls a panel inside its own block — the only one with that id', () => {
  // getElementById returns the FIRST match on the page, so a panel id that
  // also exists in an earlier block makes this button open that block's panel.
  const page = ids(home(SOURCE));
  for (const block of home(SOURCE).filter((n) => /az-faq/.test(n.attrs?.class ?? ''))) {
    const inside = new Set(ids([block]));
    for (const b of all([block]).filter((n) => n.attrs?.['aria-controls'])) {
      const target = b.attrs!['aria-controls'];
      assert.ok(inside.has(target), `${target} is not in its own FAQ`);
      assert.equal(page.filter((id) => id === target).length, 1, `${target} is not unique on the page`);
    }
  }
});

test('each pricing section has its own radio group', () => {
  const sections = home(SOURCE).filter((n) => /az-pricing/.test(n.attrs?.class ?? ''));
  const groups = sections.map((s) => [...new Set(all([s]).filter((n) => n.attrs?.type === 'radio').map((n) => n.attrs!.name))]);
  assert.equal(groups.length, 2);
  for (const g of groups) assert.equal(g.length, 1, 'one group per section');
  assert.notEqual(groups[0][0], groups[1][0], 'the two sections do not share a group');
});

test('CONTROL: the first block keeps its ids, so deep links stay stable', () => {
  const first = home(SOURCE).find((n) => /az-faq/.test(n.attrs?.class ?? ''))!;
  assert.ok(ids([first]).includes('faq-how-long-does-it-take'));
});

test('references are rewritten with their ids: for, aria-*, #href, list', () => {
  const a: EmittedNode = { tag: 'section', children: [
    { tag: 'label', attrs: { for: 'x' } },
    { tag: 'input', attrs: { id: 'x', list: 'opts', 'aria-describedby': 'x-hint other' } },
    { tag: 'datalist', attrs: { id: 'opts' } },
    { tag: 'p', attrs: { id: 'x-hint' } },
    { tag: 'a', attrs: { href: '#x' } },
  ] };
  const [first, second] = uniqueIds([structuredClone(a), structuredClone(a)]);
  assert.deepEqual(ids([first]), ['x', 'opts', 'x-hint'], 'the first copy is untouched');
  const s = all([second]);
  const input = s.find((n) => n.tag === 'input')!;
  assert.notEqual(input.attrs?.id, 'x');
  assert.equal(s.find((n) => n.tag === 'label')?.attrs?.for, input.attrs?.id);
  assert.equal(s.find((n) => n.tag === 'a')?.attrs?.href, `#${input.attrs?.id}`);
  assert.equal(input.attrs?.list, s.find((n) => n.tag === 'datalist')?.attrs?.id);
  assert.equal(input.attrs?.['aria-describedby'], `${s.find((n) => n.tag === 'p')?.attrs?.id} other`,
    'a reference to an id defined elsewhere is left alone');
  assert.equal(new Set(ids([first, second])).size, 6);
});
