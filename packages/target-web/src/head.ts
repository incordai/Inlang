/**
 * @az module head
 * Purpose: what a page's <head> says about it beyond the title — its description (written, else its lead copy) and its icon.
 * Spec: docs/GRAMMAR.md §4.4 · docs/ASSUMPTIONS.md A6 (SEO) · docs/ROADMAP.md M5
 * Exports: pageDescription, iconType, IconError, DESCRIPTION_MAX
 * Edit guide: derived from the emitted tree, never from a word's name, so every word's copy counts alike; no copy, no tag.
 *   An icon's type comes from its bytes, never its name.
 * Tests: packages/target-web/test/head.test.ts
 */

import type { EmittedNode } from '../../core/src/emit-contract.ts';
import { ICON_FORMATS, META_DESCRIPTION_MAX, iconFormat } from '../../core/src/index.ts';

/**
 * A page's derived meta description — the fallback when neither the page
 * nor the site writes a `description` (GRAMMAR §4.4).
 *
 * The page's own lead copy stands in: the first paragraph after the first
 * heading of its content — a hero's `sub` under its title, a text block's
 * body. A paragraph is a `p`, or a `div` holding nothing but text (a text
 * block's inline body is one). Before the heading sits an eyebrow, which labels rather than
 * describes, so it is passed over. Hidden subtrees (`hidden`,
 * `aria-hidden`) are skipped: the description says only what a visitor can
 * read. A page with no such paragraph gets no description rather than an
 * invented one.
 *
 * The caller passes the page's content only — the nav before it and the
 * footer after it are the site's, the same on every page.
 */

/** Search results show about this many characters; longer copy is cut at a word. */
export const DESCRIPTION_MAX = META_DESCRIPTION_MAX;

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

/** The icon file is not what the page would declare it to be — compile() reports this first (AZ1421). */
export class IconError extends Error {}

/**
 * The media type a page declares for its `site icon`, read from the file's
 * first bytes — never from its name. `bytes` undefined means the build has
 * no reader (unit tests, a playground): the type is left off (null) and the
 * browser reads the file itself. A file that cannot be read, is neither PNG
 * nor SVG, or is not the format its name says (a host serves it by name) is
 * refused rather than declared wrongly.
 */
export function iconType(raw: string, bytes: Uint8Array | null | undefined): string | null {
  if (bytes === undefined) return null;
  const format = bytes === null ? null : iconFormat(bytes);
  if (format === null || !raw.toLowerCase().endsWith(ICON_FORMATS[format].ext)) {
    throw new IconError(`icon: '${raw}' is not the PNG or SVG file its name says — check the file`);
  }
  return ICON_FORMATS[format].type;
}
