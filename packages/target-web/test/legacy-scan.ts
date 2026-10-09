/**
 * The page scans as they were before the single-pass scanner (html-scan.ts):
 * regular expressions over the whole page, copied unchanged from csp.ts and
 * cli/src/audit.ts but for attribute decoding (below). Kept only as the
 * oracle the scanner is tested against — equivalence on real pages, and
 * the quadratic cost the scanner removes.
 * Nothing outside the tests and the build checks (scripts/verify-build.mjs,
 * scripts/visual.mjs) imports it.
 */

import { createHash } from 'node:crypto';
import { inlineScripts, inlineStyles, ownDigests, styleAttributes } from '../src/csp.ts';
import { decodeAttribute, startTags } from '../src/html-scan.ts';

const parsed = (html: string) => html.replace(/\r\n?/g, '\n');

const EXECUTED = /^(?:|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

/**
 * Values are decoded with the build's own decoder, not the old one: the
 * old one threw on a reference past U+10FFFF and read others unlike the
 * browser, and the decoding is not what the scanner replaced — this
 * oracle measures the tokenizing.
 */
const decode = decodeAttribute;

function attributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of text.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = a[1].toLowerCase();
    if (!out.has(name)) out.set(name, decode(a[2] ?? a[3] ?? a[4] ?? ''));
  }
  return out;
}

function rawText(html: string, element: 'script' | 'style'): { attrs: Map<string, string>; text: string }[] {
  const out: { attrs: Map<string, string>; text: string }[] = [];
  const text = parsed(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const m of text.matchAll(new RegExp(`<${element}\\b([^>]*)>([\\s\\S]*?)</${element}\\s*>`, 'gi'))) {
    out.push({ attrs: attributes(m[1]), text: m[2] });
  }
  return out;
}

export function legacyInlineScripts(html: string): string[] {
  return rawText(html, 'script')
    .filter((s) => !s.attrs.has('src') && EXECUTED.test((s.attrs.get('type') ?? '').trim()))
    .map((s) => s.text);
}

export function legacyInlineStyles(html: string): string[] {
  return rawText(html, 'style').map((s) => s.text);
}

export function legacyStyleAttributes(html: string): string[] {
  const markup = parsed(html).replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const out: string[] = [];
  for (const m of markup.matchAll(/<[a-zA-Z][^\s/>]*((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g)) {
    const style = attributes(m[1]).get('style');
    if (style !== undefined) out.push(style);
  }
  return out;
}

const sha256Source = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

export function legacyOwnDigests(html: string): string[] {
  return [...legacyInlineScripts(html), ...legacyInlineStyles(html), ...legacyStyleAttributes(html)].map((t) => sha256Source(t).slice(1, -1));
}

/** audit.ts `tags`: each start tag of one element, as its attributes. */
export function legacyTags(html: string, element: string): Map<string, string>[] {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const out: Map<string, string>[] = [];
  for (const m of text.matchAll(new RegExp(`<${element}\\b([^>]*)>`, 'gi'))) {
    const attrs = new Map<string, string>();
    for (const a of m[1].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = a[1].toLowerCase();
      if (!attrs.has(name)) attrs.set(name, decode(a[2] ?? a[3] ?? a[4] ?? ''));
    }
    out.push(attrs);
  }
  return out;
}

/** audit.ts's view of a page through the scanner: one element's tags, decoded as audit.ts decodes them. */
const scannedTags = (html: string, element: string) => startTags(html).filter((t) => t.name === element)
  .map((t) => new Map([...t.attrs].map(([k, v]) => [k, decode(v)])));

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
const entries = (tags: Map<string, string>[]) => tags.map((t) => [...t]);

/**
 * Every result the build and the audit read from a page where the scanner
 * and the old code differ, by name — empty when they agree: inline scripts,
 * inline styles, style attributes, digests, and the audit's <meta> and <a>
 * tags (attributes in order, decoded).
 */
export function scanDifferences(html: string): string[] {
  const out: string[] = [];
  if (!same(inlineScripts(html), legacyInlineScripts(html))) out.push('inline scripts');
  if (!same(inlineStyles(html), legacyInlineStyles(html))) out.push('inline styles');
  if (!same(styleAttributes(html), legacyStyleAttributes(html))) out.push('style attributes');
  if (!same(ownDigests(html), legacyOwnDigests(html))) out.push('digests');
  for (const element of ['meta', 'a']) {
    if (!same(entries(scannedTags(html, element)), entries(legacyTags(html, element)))) out.push(`<${element}> tags`);
  }
  return out;
}
