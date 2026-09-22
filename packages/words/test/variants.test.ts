/**
 * Every variant a word advertises must actually change something.
 *
 * This is the DSL's central promise: the author selects a WORD and the task is
 * done. A word that offers `split` and `stack` and renders them identically is
 * not an unfinished feature — it is a lie in the vocabulary, and the author
 * has no way to discover it except by looking at the result and wondering
 * whether they typed it wrong.
 *
 * The comparison ignores the `az-<word>--<variant>` class, because that token
 * differs by construction and would make every variant look implemented.
 *
 * Variants not yet implemented are listed in KNOWN_IDENTICAL. That list is
 * checked to be ACCURATE in both directions: an entry that starts differing
 * fails too, so the list shrinks as work lands instead of rotting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../registry.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext } from '../../core/src/emit-contract.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

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
    site: { name: 'aurora' },
    // Slots must return SOMETHING. A word that lays its slot children out
    // differently per variant — most of them — renders an empty container
    // either way when this returns [], and every such variant reads as
    // unimplemented when it is merely unexercised.
    slot: (name) => [
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['one'] },
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['two'] },
    ],
    asset: (p) => p,
  };
}

/**
 * Content rich enough that a layout has something to lay out.
 *
 * An empty block renders the same under every variant for a legitimate
 * reason — there is nothing there — so a thin fixture would report the whole
 * vocabulary as broken.
 */
const fixture = (word: string, variant: string): SpecBlock => {
  const arg = (value: string) => ({ kind: 'string', value });
  const kid = (w: string, ...values: string[]): SpecBlock => ({
    word: w, variant: null, modifiers: [], args: values.map(arg), props: {},
    as: null, children: [],
  });
  return {
    word,
    variant,
    modifiers: [],
    args: [],
    props: {
      title: 'Built in the dark', sub: 'Handmade.', eyebrow: 'Limited run',
      columns: '3', logo: './logo.svg', copyright: 'Aurora', since: '2019',
      body: 'A paragraph long enough that a column count has something to divide.',
      tagline: 'Handmade in the dark.', monthly: '29', adapter: 'session',
    },
    as: null,
    children: [
      kid('link', 'Work', '/work'),
      kid('cta', 'Reserve', '/reserve'),
      kid('item', 'Hand-cut leather'),
      kid('item', 'Sewn, not glued'),
      kid('plan', 'Studio'),
      kid('image', './a.webp'),
      kid('group', 'Shop'),
      kid('legal', 'Privacy', '/privacy'),
    ],
  };
};

/**
 * The emitted tree as a string, with every mention of the variant NAME removed.
 *
 * Not just the `az-<word>--<variant>` class: `scene` also writes the name into
 * `data-variant`, which made three unimplemented variants look distinct. A
 * word must not be able to pass this by echoing its own variant name — the
 * question is whether the OUTPUT differs, not whether the label does.
 *
 * Safe because no fixture value below contains a variant name.
 */
function shapeOf(word: string, variant: string): string {
  const node = WEB_EMITTERS[word].emit(fixture(word, variant), context());
  return JSON.stringify(node).split(variant).join('VARIANT');
}

const wordDirs = readdirSync(WORDS).filter((d) =>
  statSync(join(WORDS, d)).isDirectory() && existsSync(join(WORDS, d, 'word.json')));

/**
 * Groups of variants that currently render identically to each other.
 *
 * MEASURED, not guessed, and recorded as GROUPS rather than a flat list —
 * "which one is the duplicate" depends on declaration order, so a flat list
 * says something different depending on how the manifest is sorted.
 *
 * Each group is real outstanding work, not an exemption.
 */
const KNOWN_IDENTICAL: Record<string, string[][]> = {
  // Empty, and kept rather than deleted: this is where a regression lands.
  // When it was written it held eight words — auth, cta, footer, gallery,
  // hero, nav, scene, text — every one of which advertised layouts that
  // rendered the same markup.
};

/** Variants that render the same, grouped. */
function identicalGroups(word: string, variants: string[]): string[][] {
  const byShape = new Map<string, string[]>();
  for (const v of variants) {
    const shape = shapeOf(word, v);
    const group = byShape.get(shape);
    if (group) group.push(v);
    else byShape.set(shape, [v]);
  }
  return [...byShape.values()].filter((g) => g.length > 1);
}

const asKey = (groups: string[][]) =>
  groups.map((g) => [...g].sort().join('=')).sort().join(' ');

test('CONTROL: there are words and variants to compare', () => {
  assert.ok(Object.keys(WEB_EMITTERS).length >= 11,
    `only ${Object.keys(WEB_EMITTERS).length} emitters`);
});

for (const word of wordDirs) {
  const manifest = JSON.parse(readFileSync(join(WORDS, word, 'word.json'), 'utf8')) as
    { variants?: string[] };
  const variants = manifest.variants ?? [];
  if (variants.length < 2 || !WEB_EMITTERS[word]) continue;

  test(`${word}: every implemented variant renders differently`, () => {
    const actual = asKey(identicalGroups(word, variants));
    const recorded = asKey(KNOWN_IDENTICAL[word] ?? []);

    // Checked in BOTH directions on purpose. A new duplicate fails, and so
    // does a group that has been implemented and left on the list — otherwise
    // the record rots into a list of things that used to be broken.
    assert.equal(actual, recorded,
      actual === ''
        ? `${word}: all variants now render distinctly — remove it from KNOWN_IDENTICAL`
        : `${word}: identical variants are now [${actual}], recorded as [${recorded}]`);
  });
}

test('KNOWN_IDENTICAL names only real words and real variants', () => {
  // A typo here would silently exempt nothing while looking like a record of
  // outstanding work.
  for (const [word, variants] of Object.entries(KNOWN_IDENTICAL)) {
    assert.ok(wordDirs.includes(word), `KNOWN_IDENTICAL names unknown word '${word}'`);
    const declared = (JSON.parse(readFileSync(join(WORDS, word, 'word.json'), 'utf8')) as
      { variants?: string[] }).variants ?? [];
    for (const v of variants.flat()) {
      assert.ok(declared.includes(v), `${word} has no variant '${v}'`);
    }
  }
});
