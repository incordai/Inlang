/**
 * Inline SVG, sanitised — feature-block-spec §7.
 *
 * An icon is the author's own file, and it becomes part of the page: so it is
 * parsed here into an EmittedNode tree, element by element, and rendered by
 * the runtime like any other node. There is no raw-markup path — nothing the
 * file says is ever handed to the browser as HTML.
 *
 * The parser is strict and fails closed. It knows a small, plain subset of
 * XML: elements, quoted attributes, the five named entities and numeric
 * references, comments and an XML declaration. A DOCTYPE, an entity
 * declaration, CDATA, a processing instruction or anything malformed is an
 * error, not something to guess about. What survives is an allowlist:
 *
 *   - shape and grouping elements only; <script>, <style>, <foreignObject>,
 *     <image>, <a>, animation and text elements go, with their content
 *   - geometry and presentation attributes only; every `on*` and `style` goes
 *   - a reference may point only inside the file (`#id`, `url(#id)`); a
 *     <use> pointing anywhere else is removed (§7)
 *   - `width`/`height` come off the root; it gets aria-hidden and
 *     focusable="false" — the icon is decorative, the title names the item
 *   - every paint that is not `none` becomes `currentColor`, so the icon takes
 *     the theme's colour instead of shipping a hard-coded one
 */

import type { EmittedNode } from '../../core/src/emit-contract.ts';

export class SvgError extends Error {}

/** feature/word.json caps `icon` at 16384 bytes; the parser holds the same line. */
export const MAX_SVG_BYTES = 16384;

/** Elements an icon may keep. Anything else is removed with its content. */
const ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'use', 'symbol',
]);

/** Attributes an icon may keep: geometry, paint and structure. */
const ATTRIBUTES = new Set([
  'viewBox', 'preserveAspectRatio', 'id', 'transform', 'd', 'points',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity',
  'clip-path', 'clip-rule', 'mask', 'vector-effect', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'clipPathUnits', 'maskUnits', 'href',
]);

/** Paint attributes forced to `currentColor` unless they say `none`. */
const PAINT = new Set(['fill', 'stroke', 'stop-color']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value: string, file: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_m, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const named = NAMED[ref];
    if (named === undefined) throw new SvgError(`icon: '${file}' uses the entity &${ref}; — only the five XML entities are allowed`);
    return named;
  });
}

/** A value that could reach outside the file, or run anything, is dropped. */
const unsafeValue = (value: string) => /javascript:|data:|url\(\s*(?!#)/i.test(value);

interface Draft { tag: string; attrs: Record<string, string>; children: Draft[]; keep: boolean }

/** Parse and sanitise one SVG file into a node tree, or throw SvgError. */
export function sanitizeSvg(source: string, file: string): EmittedNode {
  if (new TextEncoder().encode(source).length > MAX_SVG_BYTES) {
    throw new SvgError(`icon: '${file}' is over ${MAX_SVG_BYTES} bytes — an icon is a few shapes`);
  }
  let text = source.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<\?/i.test(text)) {
    throw new SvgError(`icon: '${file}' has a DOCTYPE, entity, CDATA or processing instruction — export it as plain SVG`);
  }
  text = text.trim();

  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const root: Draft = { tag: '#root', attrs: {}, children: [], keep: true };
  const stack: Draft[] = [root];
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    const between = text.slice(at, lt < 0 ? text.length : lt);
    // Text is only whitespace in an icon; words live in <text>, which is removed.
    if (between.trim() !== '' && stack.every((d) => d.keep)) {
      throw new SvgError(`icon: '${file}' has text outside any element — it is not a plain SVG`);
    }
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(text);
    if (!m) throw new SvgError(`icon: '${file}' is not well-formed near "${text.slice(lt, lt + 24)}"`);
    at = tag.lastIndex;
    const [, closing, name, attrText, selfClosing] = m;
    const parent = stack[stack.length - 1];
    if (closing) {
      if (parent.tag !== name || stack.length === 1) throw new SvgError(`icon: '${file}' closes <${name}> that is not open`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(attr)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '', file);
    const node: Draft = { tag: name, attrs, children: [], keep: parent.keep && ELEMENTS.has(name) };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new SvgError(`icon: '${file}' leaves <${stack[stack.length - 1].tag}> open`);
  if (root.children.length !== 1 || root.children[0].tag !== 'svg') {
    throw new SvgError(`icon: '${file}' must be a single <svg> element`);
  }
  return finish(root.children[0], true);
}

function finish(draft: Draft, isRoot: boolean): EmittedNode {
  const attrs: Record<string, string> = {};
  for (const [name, raw] of Object.entries(draft.attrs)) {
    // xlink:href is the old spelling of href; one name, one rule.
    const key = name === 'xlink:href' ? 'href' : name;
    if (!ATTRIBUTES.has(key) || /^on/i.test(key)) continue;
    if (key === 'href' && !/^#[\w.-]+$/.test(raw)) continue;
    if (unsafeValue(raw)) continue;
    if (isRoot && (key === 'width' || key === 'height')) continue;
    attrs[key] = PAINT.has(key) && raw.trim() !== 'none' ? 'currentColor' : raw;
  }
  if (isRoot) {
    attrs['aria-hidden'] = 'true';
    attrs.focusable = 'false';
    // Unpainted shapes are black; the icon takes the theme's colour instead.
    attrs.fill ??= 'currentColor';
  }
  const children = draft.children
    .filter((c) => c.keep)
    // §7: a <use> that pointed outside the file lost its href above — the
    // element goes too, rather than rendering nothing in particular.
    .filter((c) => c.tag !== 'use' || /^#[\w.-]+$/.test(c.attrs.href ?? c.attrs['xlink:href'] ?? ''))
    .map((c) => finish(c, false));
  return { tag: draft.tag, attrs, children };
}
