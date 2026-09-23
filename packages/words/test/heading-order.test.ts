/**
 * The heading outline never skips a level — feature-spec §10, faq-spec §8,
 * pricing-spec §8.
 *
 * The hero owns the page's only <h1>. A section's `title` is an <h2> and its
 * items <h3>; with no title the items are the section's top level, so they
 * are <h2> (feature-spec §10 states it; faq and pricing require "no skipped
 * level"). An <h3> straight under the hero's <h1> skips a level, and screen
 * reader heading navigation reports the structure as broken.
 *
 * Checked through the real target (`emitBlock`), for every word and variant,
 * with and without a title.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../registry.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const THEME = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;

const kid = (word: string, props: Record<string, string>, ...values: string[]): SpecBlock => ({
  word, variant: null, modifiers: [], as: null, children: [], props,
  args: values.map((value) => ({ kind: 'string', value })),
});

// Items that carry a heading: faq questions with answers, feature items,
// plans with a price, and generic fills with a label and no destination.
const CHILDREN = [
  kid('item', { text: 'Within thirty days.' }, 'Can I return a pair?'),
  kid('item', { text: 'Yes.' }, 'Do you ship abroad?'),
  kid('item', { text: 'Every pair.' }, 'Are they handmade?'),
  { ...kid('plan', { monthly: '29', annual: '290' }, 'Studio'), children: [kid('feature', {}, 'Projects', '10'), kid('cta', {}, 'Start', '/start')] },
  { ...kid('plan', { monthly: '79', annual: '790' }, 'Practice'), children: [kid('feature', {}, 'Projects', '10'), kid('cta', {}, 'Start', '/start')] },
  kid('image', { alt: 'A bench' }, './a.webp'),
  kid('image', { alt: 'A welt' }, './b.webp'),
];

const levels = (n: EmittedNode | string): number[] => typeof n === 'string' ? [] : [
  ...(/^h[1-6]$/.test(n.tag) ? [Number(n.tag[1])] : []),
  ...(n.children ?? []).flatMap(levels),
];

/** The first skip in an outline that starts under the hero's <h1>, or null. */
function skip(outline: number[]): string | null {
  let previous = 1;
  for (const level of outline) {
    if (level > previous + 1) return `h${previous} → h${level}`;
    previous = level;
  }
  return null;
}

/* ---- the target's generic fill renderer ---------------------------------- */

// A stand-in word that lists its `item` fills through ctx.slot, titled or not.
const LISTER = {
  emit: (block: SpecBlock, ctx: { slot: (n: string) => EmittedNode[] }): EmittedNode => ({
    tag: 'section',
    children: [...(block.props.title ? [{ tag: 'h2', children: [block.props.title] }] : []), { tag: 'ul', children: ctx.slot('item') }],
  }),
};
const lister = (title: string | null): SpecBlock => ({
  word: 'lister', variant: null, modifiers: [], args: [], as: null,
  props: title ? { title } : {},
  // An item with a nested labelled child: one level further down.
  children: [{ ...kid('item', {}, 'Hand-cut leather'), children: [kid('item', {}, 'Welted')] }],
});
const listed = (title: string | null) =>
  levels(emitBlock(lister(title), THEME, { lister: LISTER } as never, (p) => p, { name: 'aurora' }));

test('generic fills: <h3> under a titled section, nested one level further', () => {
  assert.deepEqual(listed('Workshop'), [2, 3, 4]);
});

test('generic fills: <h2> in a section with no title, never a skip', () => {
  assert.deepEqual(listed(null), [2, 3]);
});

test('CONTROL: a skip is detected', () => {
  assert.equal(skip([3]), 'h1 → h3');
  assert.equal(skip([2, 3, 3, 2]), null);
});

for (const word of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  if (!WEB_EMITTERS[word] || word === 'hero') continue;
  const m = JSON.parse(readFileSync(join(WORDS, word, 'word.json'), 'utf8')) as { variants?: string[] };
  for (const variant of m.variants ?? [null]) {
    for (const titled of [true, false]) {
      test(`${word}${variant ? ` ${variant}` : ''} ${titled ? 'with' : 'without'} a title: no skipped heading level`, () => {
        const block: SpecBlock = {
          word, variant, modifiers: [], args: [], as: null, children: CHILDREN,
          props: { body: 'Copy.', currency: 'usd', ...(titled ? { title: 'Built in the dark' } : {}) },
        };
        const outline = levels(emitBlock(block, THEME, WEB_EMITTERS, (p) => p, { name: 'aurora' }));
        assert.equal(skip(outline), null, `outline ${outline.map((l) => `h${l}`).join(' ')}`);
      });
    }
  }
}
