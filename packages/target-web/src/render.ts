/**
 * Emitted tree to markup.
 *
 * This is the ONE place user content is escaped. A word returns a tree of
 * plain strings; nothing downstream of here concatenates them into source.
 * Eleven words escaping their own content would be eleven chances to forget —
 * CONVENTIONS §6 is why the contract returns a tree at all.
 */

import type { BreakpointName, EmittedNode } from '../../core/src/emit-contract.ts';
import { compileStyles, declarations } from './stylesheet.ts';

/** HTML text/attribute escaping. The complete set, not a convenient subset. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Void elements take no closing tag — emitting one produces invalid HTML. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Serialise a style object.
 *
 * Keys are SORTED. Two builds of one source must produce identical bytes
 * (CONVENTIONS §6), and object insertion order is not a guarantee worth
 * resting the product's headline claim on.
 *
 * `undefined` values are DROPPED, which is how a word says "this layout does
 * not set that property" without assembling the object conditionally.
 */
export function styleString(
  style: Readonly<Record<string, string | number | undefined>>,
): string {
  // The stylesheet's own serialiser, so a value reads the same inline and in
  // az.css: numbers get px exactly where React would add it.
  return declarations(style).map(([p, v]) => `${p}:${v}`).join(';');
}

/**
 * Render trees the way the web target ships them: styles moved into
 * generated classes, returned alongside the stylesheet they need.
 */
export function renderStyled(
  nodes: readonly EmittedNode[], breakpoint: Readonly<Record<BreakpointName, number>>,
): { html: string; css: string } {
  const { value, css } = compileStyles(nodes, (ns, rewrite) => ns.map(rewrite), breakpoint);
  return { html: value.map(renderNode).join(''), css };
}

/** Render one emitted node to HTML. Recursive, and escaping at every leaf. */
export function renderNode(node: EmittedNode | string): string {
  if (typeof node === 'string') return escapeHtml(node);

  const attrs: string[] = [];
  for (const key of Object.keys(node.attrs ?? {}).sort()) {
    attrs.push(`${key}="${escapeHtml(String(node.attrs![key]))}"`);
  }
  if (node.style && Object.keys(node.style).length > 0) {
    attrs.push(`style="${escapeHtml(styleString(node.style))}"`);
  }

  const open = `<${node.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  if (VOID.has(node.tag)) return open;

  const inner = (node.children ?? []).map(renderNode).join('');
  return `${open}${inner}</${node.tag}>`;
}
