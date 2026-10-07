/**
 * @az module head
 * Purpose: what a page's <head> says about it beyond the title — its description, taken from its own lead copy.
 * Spec: docs/ASSUMPTIONS.md A6 (SEO) · docs/ROADMAP.md M5
 * Exports: pageDescription, DESCRIPTION_MAX
 * Edit guide: derived from the emitted tree, never from a word's name, so every word's copy counts alike; no copy, no tag.
 * Tests: packages/target-web/test/head.test.ts
 */

/**
 * A page's meta description.
 *
 * The grammar has no description to write, so the page's own lead copy
 * stands in: the first paragraph after the first heading of its content —
 * a hero's `sub` under its title, a text block's body. A paragraph is a
 * `p`, or a `div` holding nothing but text (a text block's inline body is
 * one). Before the heading sits an eyebrow, which labels rather than
 * describes, so it is passed over. Hidden subtrees (`hidden`,
 * `aria-hidden`) are skipped: the description says only what a visitor can
 * read. A page with no such paragraph gets no description rather than an
 * invented one.
 *
 * The caller passes the page's content only — the nav before it and the
 * footer after it are the site's, the same on every page.
 */

import type { EmittedNode } from '../../core/src/emit-contract.ts';

/** Search results show about this many characters; longer copy is cut at a word. */
export const DESCRIPTION_MAX = 160;

const HEADING = /^h[1-6]$/;

/** A `p`, or a `div` whose children are all text: a paragraph in all but its tag. */
const paragraph = (node: EmittedNode): boolean =>
  node.tag === 'p' || (node.tag === 'div' && (node.children ?? []).length > 0 && (node.children ?? []).every((c) => typeof c === 'string'));

const hidden = (node: EmittedNode): boolean =>
  node.attrs?.hidden !== undefined || node.attrs?.['aria-hidden'] === 'true';

/** The visible text of a node, whitespace collapsed. */
function textOf(node: EmittedNode): string {
  const parts: string[] = [];
  const walk = (n: EmittedNode | string): void => {
    if (typeof n === 'string') { parts.push(n); return; }
    if (hidden(n)) return;
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** `text` within DESCRIPTION_MAX, cut at the last word boundary that fits. */
function clamp(text: string): string {
  if (text.length <= DESCRIPTION_MAX) return text;
  const room = text.slice(0, DESCRIPTION_MAX - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > 0 ? room.slice(0, space) : room).replace(/[\s,;:.]+$/, '')}…`;
}

/** The description for a page whose content is `nodes`, or null when it has no lead paragraph. */
export function pageDescription(nodes: readonly EmittedNode[]): string | null {
  const state = { headed: false };
  const walk = (n: EmittedNode | string): string | null => {
    if (typeof n === 'string' || hidden(n)) return null;
    if (HEADING.test(n.tag)) { state.headed = true; return null; }
    if (state.headed && paragraph(n)) {
      const text = textOf(n);
      if (text) return text;
    }
    for (const c of n.children ?? []) {
      const found = walk(c);
      if (found !== null) return found;
    }
    return null;
  };
  for (const n of nodes) {
    const found = walk(n);
    if (found !== null) return clamp(found);
  }
  return null;
}
