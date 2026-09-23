/**
 * Every emitter produces structurally valid lists.
 *
 * Slot fills render as <li>. A word that put them in a <div> or a <p> made
 * invalid HTML — a <p> cannot contain an <li> at all, so the parser closes
 * it early and the rest of the section lands outside it. Checked for every
 * word and every variant, with every kind of slot child present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../registry.ts';
import { defaultChild } from '../../target-web/src/tree.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

const kid = (word: string, ...values: string[]): SpecBlock => ({
  word, variant: null, modifiers: [], as: null, children: [], props: {},
  args: values.map((value) => ({ kind: 'string', value })),
});

const CHILDREN = [
  kid('link', 'Work', '/work'), kid('cta', 'Reserve', '/reserve'), kid('alt', 'Call', 'tel:+1'),
  // An item with its own child: a fill's children are rendered inside it.
  { ...kid('item', 'Hand-cut leather'), children: [kid('link', 'How we do it', '/process')] },
  kid('plan', 'Studio'), kid('image', './a.webp'),
  kid('group', 'Shop'), kid('legal', 'Privacy', '/privacy'), kid('social', 'Notes', '/notes'),
];

function context(block: SpecBlock): EmitContext {
  const t = resolve(THEMES.midnight, 'dark');
  const ctx: EmitContext = {
    theme: t as unknown as EmitContext['theme'],
    target: 'web',
    site: { name: 'aurora' },
    // The real slot renderer, so the <li> it produces is what is checked.
    slot: (name) => block.children.filter((c) => c.word === name).map((c) => defaultChild(c, ctx)),
    asset: (p) => p,
    ...actionsFor(t as unknown as EmitContext['theme']),
  };
  return ctx;
}

/** Parents of every <li> that is not directly inside a list. */
function strayItems(node: EmittedNode, parent = 'root'): string[] {
  const here = node.tag === 'li' && !['ul', 'ol', 'menu'].includes(parent) ? [parent] : [];
  return [...here, ...(node.children ?? []).flatMap((c) =>
    typeof c === 'string' ? [] : strayItems(c, node.tag))];
}

test('CONTROL: an <li> inside a <div> is detected', () => {
  assert.deepEqual(strayItems({ tag: 'div', children: [{ tag: 'li', children: ['x'] }] }), ['div']);
});

for (const word of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  if (!WEB_EMITTERS[word]) continue;
  const m = JSON.parse(readFileSync(join(WORDS, word, 'word.json'), 'utf8')) as { variants?: string[] };
  for (const variant of [null, ...(m.variants ?? [])]) {
    test(`${word}${variant ? ` ${variant}` : ''}: every <li> sits in a list`, () => {
      const block: SpecBlock = {
        word, variant, modifiers: [], args: [], as: null, children: CHILDREN,
        props: { title: 'Built in the dark', body: 'Copy.', copyright: 'Aurora', logo: './l.svg' },
      };
      assert.deepEqual(strayItems(WEB_EMITTERS[word].emit(block, context(block))), []);
    });
  }
}
