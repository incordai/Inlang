/**
 * Every prop a word declares must change something.
 *
 * The variant test's argument, one level down. A manifest is a promise: it is
 * what `az` offers the author, what a future editor lists in a panel, and what
 * the error messages suggest. A declared prop that the emitter ignores is a
 * setting the author can type, that validates, that appears in the Spec — and
 * that does nothing at all. There is no feedback anywhere in the system to
 * tell them.
 *
 * A prop counts as implemented when TWO DIFFERENT VALUES produce two different
 * outputs. Not when the emitter reads it — reading a value and dropping it
 * looks identical to a source-text search, which is exactly how
 * word-coverage.mjs came to report finished work as outstanding.
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
    slot: (name) => [
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['one'] },
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['two'] },
    ],
    asset: (p) => p,
  };
}

interface PropSpec {
  readonly type: string;
  readonly values?: string[] | string;
  readonly min?: number;
  readonly max?: number;
}

/**
 * Two DIFFERENT values a prop can legally hold.
 *
 * Both must be valid, or the difference proves only that the emitter chokes on
 * nonsense. Enums use two of their own declared words; numbers use two inside
 * the declared range.
 */
function pairFor(spec: PropSpec): [string, string] | null {
  if (Array.isArray(spec.values) && spec.values.length >= 2) {
    return [spec.values[0], spec.values[1]];
  }
  switch (spec.type) {
    case 'int': {
      const lo = spec.min ?? 2;
      const hi = spec.max ?? lo + 1;
      return hi > lo ? [String(lo), String(hi)] : null;
    }
    case 'path':  return ['./one.svg', './two.svg'];
    case 'route': return ['/one', '/two'];
    case 'enum':  return spec.values === 'iso4217' ? ['usd', 'eur'] : null;
    case 'list':  return ['password', 'link'];
    default:      return ['Alpha value here', 'Beta value here'];
  }
}

/**
 * Per-word gates, for props that only act in the presence of another prop or
 * a modifier. Same reason as the footer baseline below: without the gate the
 * fixture measures itself. `cta.describe` is the alt text OF `media`, so it
 * has nothing to describe without one; `nav.inverse` is the logo shown over
 * the hero by a `solid` nav, so it needs both `solid` and a regular `logo`.
 * `hero.describe` is the alt text of the poster a `3d` hero shows, so it
 * needs both. `faq.schema` describes answered questions and emits nothing below three
 * (faq-spec §7.5), so the fixture carries three answered items.
 */
const answered = (question: string, text: string): SpecBlock => ({
  word: 'item', variant: null, modifiers: [], as: null, children: [],
  args: [{ kind: 'string', value: question }], props: { text },
});

const GATES: Record<string, {
  modifiers?: string[];
  props?: Record<string, string>;
  children?: SpecBlock[];
}> = {
  cta: { props: { media: './m.webp' } },
  hero: { modifiers: ['3d'], props: { poster: './p.webp' } },
  faq: {
    children: [
      answered('Do you ship abroad?', 'Yes, to most countries.'),
      answered('Can I return a pair?', 'Within thirty days.'),
      answered('Are they handmade?', 'Every pair, in the studio.'),
    ],
  },
  nav: { modifiers: ['solid'], props: { logo: './logo.svg' } },
};

const base = (word: string, variant: string | null): SpecBlock => {
  const arg = (value: string) => ({ kind: 'string', value });
  const kid = (w: string, ...values: string[]): SpecBlock => ({
    word: w, variant: null, modifiers: [], args: values.map(arg), props: {},
    as: null, children: [],
  });
  return {
    word, variant, modifiers: GATES[word]?.modifiers ?? [], args: [], as: null,
    // A baseline of content, so a prop that only affects how children are laid
    // out still has children to affect.
    //
    // Some props only matter in the presence of others, and a fixture that
    // omits the gate measures ITSELF rather than the code. footer is the clear
    // case and cost three passes to get right: the copyright row is gated on
    // `copyright`; `since` renders only when `year` is not its default `none`;
    // and `year` shows nothing without a `since` to print. All three have to
    // be present before either of the last two can be seen to do anything.
    props: {
      title: 'Built in the dark',
      body: 'A paragraph of body copy.',
      copyright: 'Aurora Studio',
      year: 'since',
      since: '2019',
      ...GATES[word]?.props,
    },
    children: [
      kid('link', 'Work', '/work'),
      kid('item', 'Hand-cut leather'),
      // The plan carries BOTH prices. `billing` chooses between them, so with
      // only a monthly figure there is nothing to toggle to and the prop is
      // correctly inert — the fixture would have been measuring itself again.
      { ...kid('plan', 'Studio'), props: { monthly: '29', annual: '290' } },
      kid('image', './a.webp'),
      kid('group', 'Shop'),
      ...GATES[word]?.children ?? [],
    ],
  };
};

/**
 * The output with one prop set to a given value.
 *
 * The value is deliberately NOT normalised away. An earlier version stripped
 * it — reasoning that a prop echoed into a data attribute changes the string
 * without changing the page — and that made both values collapse to the same
 * token, so every prop in the codebase read as inert, `hero.title` included.
 * The CONTROL below is what caught it.
 *
 * So the question this asks is the answerable one: does the value REACH the
 * output at all. Whether it reaches it as content or only as an attribute is
 * a separate, finer question, and conflating the two produced a test that
 * measured nothing.
 */
function shapeWith(word: string, variant: string | null, key: string, value: string): string {
  const block = base(word, variant);
  return JSON.stringify(WEB_EMITTERS[word].emit(
    { ...block, props: { ...block.props, [key]: value } }, context()));
}

const wordDirs = readdirSync(WORDS).filter((d) =>
  statSync(join(WORDS, d)).isDirectory() && existsSync(join(WORDS, d, 'word.json')));

/**
 * Props a word declares but does not act on yet.
 *
 * MEASURED. Checked in both directions, so an entry that starts working fails
 * too and the list shrinks as work lands.
 */
const KNOWN_INERT: Record<string, string[]> = {
  auth: ['impl', 'methods', 'redirect'],
  hero: ['model'],
  scene: ['camera', 'model'],
};

test('CONTROL: a prop KNOWN to work is detected as working', () => {
  // If the comparison were broken, every prop would look inert and the lists
  // below would be meaningless.
  assert.notEqual(
    shapeWith('hero', 'center', 'title', 'Alpha value here'),
    shapeWith('hero', 'center', 'title', 'Beta value here'),
    'hero.title demonstrably changes the output',
  );
});

for (const word of wordDirs) {
  if (!WEB_EMITTERS[word]) continue;
  const m = JSON.parse(readFileSync(join(WORDS, word, 'word.json'), 'utf8')) as
    { variants?: string[]; props?: Record<string, PropSpec> };
  const props = Object.entries(m.props ?? {});
  if (props.length === 0) continue;

  test(`${word}: every declared prop changes the output`, () => {
    const inert: string[] = [];

    for (const [key, spec] of props) {
      const pair = pairFor(spec);
      if (pair === null) continue;
      // Try under EVERY variant: a prop may only matter to one of them, and
      // testing the default alone would report it inert.
      const matters = [null, ...(m.variants ?? [])].some((v) =>
        shapeWith(word, v, key, pair[0]) !== shapeWith(word, v, key, pair[1]));
      if (!matters) inert.push(key);
    }

    inert.sort();
    const recorded = [...(KNOWN_INERT[word] ?? [])].sort();
    assert.deepEqual(inert, recorded,
      inert.length === 0
        ? `${word}: every prop now does something — remove it from KNOWN_INERT`
        : `${word}: inert props are now [${inert}], recorded as [${recorded}]`);
  });
}

test('KNOWN_INERT names only real words and real props', () => {
  for (const [word, keys] of Object.entries(KNOWN_INERT)) {
    assert.ok(wordDirs.includes(word), `unknown word '${word}'`);
    const declared = Object.keys((JSON.parse(
      readFileSync(join(WORDS, word, 'word.json'), 'utf8')) as
      { props?: Record<string, unknown> }).props ?? {});
    for (const k of keys) {
      assert.ok(declared.includes(k), `${word} declares no prop '${k}'`);
    }
  }
});
