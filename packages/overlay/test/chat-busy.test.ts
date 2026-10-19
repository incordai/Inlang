/**
 * Issue #28: the answer's working signs — the motion tokens the chat word
 * writes are checked before anything moves, a held kind finds its
 * placeholder, and the caret sits only at the end of prose. Pure parts, so
 * tested without a browser; the dots, the caret and the entrance are watched
 * in three engines by scripts/chat-public-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretHost, motionOf, RICH_BLOCKS, SKELETON_OF } from '../src/runtime/chat-logic.ts';

const GOOD = { enter: 200, pulse: 240, slide: 6, ease: 'cubic-bezier(0.16, 1, 0.3, 1)' };

test('motionOf: the theme\'s motion tokens as the chat word writes them; anything else is refused, so nothing moves', () => {
  assert.deepEqual(motionOf(JSON.stringify(GOOD)), GOOD);
  assert.deepEqual(motionOf(JSON.stringify({ ...GOOD, ease: 'ease-out' })), { ...GOOD, ease: 'ease-out' });
  for (const bad of [
    null, '', '{', '[]', JSON.stringify({ ...GOOD, enter: -1 }), JSON.stringify({ ...GOOD, enter: 60_000 }), JSON.stringify({ ...GOOD, pulse: '240' }),
    JSON.stringify({ ...GOOD, slide: 500 }), JSON.stringify({ ...GOOD, ease: 'url(x)' }), JSON.stringify({ ...GOOD, ease: 'cubic-bezier(1, 2, 3)' }),
    JSON.stringify({ ...GOOD, ease: 'steps(4); color: red' }), JSON.stringify({ enter: 200 }),
  ]) {
    assert.equal(motionOf(bad), null, String(bad));
  }
});

test('every kind the server may hold has a placeholder of its shape — and nothing else does', () => {
  const held = RICH_BLOCKS.filter((w) => w !== 'unavailable');
  assert.deepEqual(Object.keys(SKELETON_OF).sort(), [...held].sort());
  assert.deepEqual([...new Set(Object.values(SKELETON_OF))].sort(), ['skeleton-figure', 'skeleton-map', 'skeleton-table', 'skeleton-tiles']);
  assert.equal(Object.hasOwn(SKELETON_OF, 'pricing'), false);
});

/** A tree of tag names, as caretHost walks it: children, siblings back from the last. */
interface Node { readonly tagName: string; readonly children: Node[]; previousElementSibling: Node | null; lastElementChild: Node | null }
function el(tagName: string, children: Node[] = []): Node {
  const n: Node = { tagName, children, previousElementSibling: null, lastElementChild: children.at(-1) ?? null };
  children.forEach((c, i) => { c.previousElementSibling = children[i - 1] ?? null; });
  return n;
}
const host = (item: Node, skip: (n: Node) => boolean = () => false) => caretHost(item, skip);

test('caretHost: the caret ends the last paragraph or the last list\'s last item — never a code block, a component or nothing', () => {
  const p = el('P');
  assert.equal(host(el('LI', [el('P'), p])), p);
  const li = el('LI');
  assert.equal(host(el('LI', [p, el('UL', [el('LI'), li])])), li);
  assert.equal(host(el('LI', [p, el('OL', [li])])), li);
  assert.equal(host(el('LI', [p, el('DIV', [el('PRE')])])), null, 'a code block or a component ends the answer: no caret');
  assert.equal(host(el('LI', [])), null);
  // The runtime's own elements (the caret itself) are passed over.
  const caret = el('SPAN');
  assert.equal(host(el('LI', [p, caret]), (n) => n === caret), p);
});
