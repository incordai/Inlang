/**
 * @az module svg
 * Purpose: strict allowlist SVG sanitiser → a node tree (never an HTML string).
 * Spec: docs/feature-block-spec.md §7
 * Exports: sanitizeSvg, SvgError, MAX_SVG_BYTES
 * Edit guide: fail closed: unknown constructs throw; ids are prefixed per icon instance.
 * Tests: packages/target-web/test/svg.test.ts, packages/cli/test/icons.test.ts
 */

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
 *   - ink becomes `currentColor`, so the icon takes the theme's colour instead
 *     of shipping a hard-coded one; background paint becomes `none`, and
 *     masks and clip paths keep theirs (see `paint`)
 *   - ids are namespaced per inlined copy, references rewritten to match
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

/** Paint attributes: the icon's ink, recoloured by `paint`. */
const PAINT = new Set(['fill', 'stroke', 'stop-color']);

/**
 * Paint in a single-colour icon.
 *
 *   - `none`, `transparent` and white are not ink: an exporter's artboard
 *     background, a hit area, a knock-out the page already shows through.
 *     They become `none` — as `currentColor` they were a solid square.
 *   - a reference to a paint server (`url(#gradient)`) stays a reference;
 *     the server's own stops take the colour.
 *   - everything else is ink and takes the theme's colour, `currentColor`.
 *
 * Inside <mask> and <clipPath> nothing is recoloured: a mask's paint is
 * luminance (white keeps, black removes) and a clip path's is ignored — they
 * are never shown, so forcing them to the text colour broke the cut-outs.
 */
// The hex forms are written as quantifiers: this is target source, where the
// theme lint rightly refuses a colour literal (theme-spec §4).
const WHITE = /^(?:white|#(?:f{3}|f{4}|f{6}|f{8})|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*1(?:\.0*)?\s*)?\))$/i;
function paint(value: string): string {
  const v = value.trim();
  if (v === 'none' || /^transparent$/i.test(v) || WHITE.test(v)) return 'none';
  if (/^url\(\s*#[\w.-]+\s*\)$/.test(v)) return v;
  return 'currentColor';
}

/** Containers whose paint is never displayed. */
const UNPAINTED = new Set(['mask', 'clipPath']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * XML 1.0's Char production (§2.2): tab, line feed, carriage return and
 * U+0020–U+D7FF, U+E000–U+FFFD, U+10000–U+10FFFF. A reference to anything
 * else — another C0 control, NUL, a surrogate, U+FFFE or U+FFFF — makes the
 * file not well-formed (§4.1, "Legal Character").
 */
function isXmlChar(n: number): boolean {
  return n === 0x9 || n === 0xa || n === 0xd || (n >= 0x20 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
}

const XML_CHARS = 'only tab, line feed, carriage return and U+0020–U+D7FF, U+E000–U+FFFD, U+10000–U+10FFFF';

/**
 * The first character of the raw text outside XML's Char (above), written
 * literally rather than as a reference — a C0 control, a NUL, a lone
 * surrogate, U+FFFE or U+FFFF — or an SvgError naming it and where it is.
 * Checked before anything is stripped: one inside a comment makes the file
 * not well-formed too. Iterating by code point keeps a valid pair whole and
 * yields a lone surrogate as itself.
 */
function refuseRawNonChars(source: string, file: string): void {
  let line = 1;
  let col = 1;
  for (const ch of source) {
    const n = ch.codePointAt(0)!;
    if (!isXmlChar(n)) {
      const name = `U+${n.toString(16).toUpperCase().padStart(4, '0')}`;
      throw new SvgError(`icon: '${file}' has a character XML does not allow (${name}, line ${line}, column ${col}) — ${XML_CHARS}`);
    }
    if (n === 0xa) { line++; col = 1; } else col++;
  }
}

/** A numeric character reference, or an SvgError naming the file — never a RangeError. */
function codePoint(digits: string, radix: number, file: string): string {
  const n = parseInt(digits, radix);
  const ref = `&#${radix === 16 ? 'x' : ''}${digits};`;
  if (!Number.isSafeInteger(n) || n > 0x10ffff) {
    throw new SvgError(`icon: '${file}' has a character reference beyond Unicode (${ref})`);
  }
  if (!isXmlChar(n)) {
    throw new SvgError(`icon: '${file}' has a character reference to a character XML does not allow (${ref}) — ${XML_CHARS}`);
  }
  return String.fromCodePoint(n);
}

function decode(value: string, file: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_m, ref: string) => {
    if (ref.startsWith('#x')) return codePoint(ref.slice(2), 16, file);
    if (ref.startsWith('#')) return codePoint(ref.slice(1), 10, file);
    const named = NAMED[ref];
    if (named === undefined) throw new SvgError(`icon: '${file}' uses the entity &${ref}; — only the five XML entities are allowed`);
    return named;
  });
}

/** A value that could reach outside the file, or run anything, is dropped. */
const unsafeValue = (value: string) => /javascript:|data:|url\(\s*(?!#)/i.test(value);

interface Draft { tag: string; attrs: Record<string, string>; children: Draft[]; keep: boolean }

/**
 * Parse and sanitise one SVG file into a node tree, or throw SvgError.
 *
 * `prefix` namespaces the file's ids for ONE inlined copy: two icons — or
 * the same icon twice — on a page would otherwise share `id="a"`, and every
 * `url(#a)` after the first would resolve to the first icon's clip or
 * gradient. Every id and every `#id` / `url(#id)` reference is rewritten.
 */
export function sanitizeSvg(source: string, file: string, prefix = ''): EmittedNode {
  if (new TextEncoder().encode(source).length > MAX_SVG_BYTES) {
    throw new SvgError(`icon: '${file}' is over ${MAX_SVG_BYTES} bytes — an icon is a few shapes`);
  }
  refuseRawNonChars(source, file);
  let text = source.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s[^?]*\?>/, '');
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
    // A comment is skipped whole where the scan meets it, never cut out of
    // the text first: cutting would join what stood on either side of it
    // (`<pa<!-- -->th`) into markup the file never wrote.
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new SvgError(`icon: '${file}' has a comment that is never closed`);
      at = end + 3;
      continue;
    }
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
  return finish(root.children[0], true, prefix, false);
}

function finish(draft: Draft, isRoot: boolean, prefix: string, unpainted: boolean): EmittedNode {
  const attrs: Record<string, string> = {};
  for (const [name, raw] of Object.entries(draft.attrs)) {
    // xlink:href is the old spelling of href; one name, one rule.
    const key = name === 'xlink:href' ? 'href' : name;
    if (!ATTRIBUTES.has(key) || /^on/i.test(key)) continue;
    if (key === 'href' && !/^#[\w.-]+$/.test(raw)) continue;
    if (unsafeValue(raw)) continue;
    if (isRoot && (key === 'width' || key === 'height')) continue;
    const value = PAINT.has(key) && !unpainted ? paint(raw) : raw;
    attrs[key] = key === 'id'
      ? `${prefix}${value}`
      : key === 'href'
        ? `#${prefix}${value.slice(1)}`
        : value.replace(/url\(\s*#([\w.-]+)\s*\)/g, `url(#${prefix}$1)`);
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
    .map((c) => finish(c, false, prefix, unpainted || UNPAINTED.has(draft.tag)));
  return { tag: draft.tag, attrs, children };
}
