/**
 * @az module csp
 * Purpose: each built page's Content-Security-Policy, from what the page needs and the markup it ships.
 * Spec: docs/word-quality-gate.md §2 B, §5.5 · docs/ARCHITECTURE.md §4.2
 * Exports: PageNeeds, CSP_META, PolicyError, pagePolicy, withPolicy, inlineScripts, inlineStyles, styleAttributes, sha256Source, ownDigests, originOf
 * Edit guide: dependency-free besides node:crypto — the CLI copies this file verbatim into az-vite/, where build.mjs imports it.
 *   A source is added only for something a page really does; never 'unsafe-inline' or 'unsafe-eval'.
 * Tests: packages/target-web/test/csp.test.ts
 */

/**
 * A static host sends no per-request nonce, so every inline thing a page
 * carries is allowed by its hash instead, computed from the page as built:
 * after the pre-render (az-vite/build.mjs), when its markup is final.
 *
 * What the page loads beyond its own files comes from `PageNeeds`, which the
 * emitter derives from the page's nodes — not from its markup, because a
 * page behind <Protected> renders its content only in the browser. Origins
 * come from the build's PUBLIC environment only (the `AZ_PUBLIC_` values
 * Vite inlines), never from anything private.
 *
 * Delivered as a <meta>, so `frame-ancestors`, `report-uri` and `sandbox`
 * cannot be set here (CSP3 §6.4.1 ignores them in a meta, and browsers log
 * an error for each): the host must send `frame-ancestors` as a header.
 */

import { createHash } from 'node:crypto';

/** What one page needs beyond its own files — written by the emitter into build.mjs. */
export interface PageNeeds {
  /** The page declares no icon file: its `<link rel="icon" href="data:,">` is a data: image. */
  readonly dataIcon: boolean;
  /** Public variables whose URL origin the page calls (the auth adapter's, the backend's). */
  readonly connect: readonly string[];
  /** Public variables whose URL origin serves images the page shows (uploaded images). */
  readonly images: readonly string[];
  /**
   * The page shows a 3D model, which may be compressed: the decoder compiles
   * WebAssembly ('wasm-unsafe-eval') in a worker made from a blob: URL, and
   * the loader fetches a model's embedded textures from blob: URLs
   * (connect-src). It decodes them with createImageBitmap, never an <img>,
   * in every tested engine, so img-src needs no blob: (test:3d measures both).
   */
  readonly decoder: boolean;
}

/** The tag build.mjs writes, right after the page's charset. */
export const CSP_META = 'Content-Security-Policy';

const CHARSET = '<meta charset="utf-8" />';

/** `'sha256-…'` of a text's UTF-8 bytes — what a browser compares an inline script, style or attribute against. */
export function sha256Source(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** The text as a browser's parser receives it: every CR LF and lone CR is a LF (HTML §13.2.3.5). */
const parsed = (html: string) => html.replace(/\r\n?/g, '\n');

/** Script types a browser executes (HTML §4.12.1.1); every other type is a data block, which CSP does not govern. */
const EXECUTED = /^(?:|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

/** The attributes of one start tag's text, by lowercased name; the first of a name wins, as in HTML. */
function attributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of text.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = a[1].toLowerCase();
    if (!out.has(name)) out.set(name, decode(a[2] ?? a[3] ?? a[4] ?? ''));
  }
  return out;
}

/** An attribute value as the browser reads it: character references decoded. */
function decode(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi, (_m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    if (dec !== undefined) return String.fromCodePoint(parseInt(dec, 10));
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[(name ?? '').toLowerCase()] ?? '';
  });
}

/** Each `<element …>…</element>` of a raw-text element (script, style): its attributes and its exact text. */
function rawText(html: string, element: 'script' | 'style'): { attrs: Map<string, string>; text: string }[] {
  const out: { attrs: Map<string, string>; text: string }[] = [];
  const text = parsed(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const m of text.matchAll(new RegExp(`<${element}\\b([^>]*)>([\\s\\S]*?)</${element}\\s*>`, 'gi'))) {
    out.push({ attrs: attributes(m[1]), text: m[2] });
  }
  return out;
}

/** The text of every inline script a browser would run, byte for byte as the page carries it. */
export function inlineScripts(html: string): string[] {
  return rawText(html, 'script')
    .filter((s) => !s.attrs.has('src') && EXECUTED.test((s.attrs.get('type') ?? '').trim()))
    .map((s) => s.text);
}

/** The text of every inline <style> element. */
export function inlineStyles(html: string): string[] {
  return rawText(html, 'style').map((s) => s.text);
}

/**
 * Every `style` attribute value in the markup, decoded. Script and style
 * bodies and comments are passed over: their text is not markup.
 */
export function styleAttributes(html: string): string[] {
  const markup = parsed(html).replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const out: string[] = [];
  for (const m of markup.matchAll(/<[a-zA-Z][^\s/>]*((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g)) {
    const style = attributes(m[1]).get('style');
    if (style !== undefined) out.push(style);
  }
  return out;
}

/**
 * The digests a page's own policy pins — `sha256-…` of each inline script,
 * inline style and style attribute the text carries — as the secret scan
 * allows them (the generated build.mjs and az audit). Derived from the same
 * text, so a digest is allowed only where it is the hash of something that
 * file really holds; any other value is judged.
 */
export function ownDigests(html: string): string[] {
  return [...inlineScripts(html), ...inlineStyles(html), ...styleAttributes(html)].map((t) => sha256Source(t).slice(1, -1));
}

/** An error in the build's public settings that a policy cannot be made from. */
export class PolicyError extends Error {}

/**
 * The origin of a public URL setting, or null when it is unset. A value
 * that is not an http(s) URL is refused: a policy must not guess.
 */
export function originOf(name: string, value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PolicyError(`csp: ${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new PolicyError(`csp: ${name} is not an http(s) URL`);
  return url.origin;
}

/** Sorted and once each, so two builds write the same policy. */
const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/**
 * The policy for one built page: its needs, its final markup, and the
 * build's public environment (only the variables `needs` names are read).
 */
export function pagePolicy(needs: PageNeeds, html: string, env: Readonly<Record<string, string | undefined>>): string {
  const origins = (names: readonly string[]) =>
    sorted(names.map((n) => originOf(n, env[n])).filter((o): o is string => o !== null));
  const scripts = sorted(inlineScripts(html).map(sha256Source));
  const attrs = sorted(styleAttributes(html).map(sha256Source));
  const sheets = sorted(inlineStyles(html).map(sha256Source));
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...(needs.decoder ? ["'wasm-unsafe-eval'"] : []), ...scripts]],
    // 'unsafe-hashes' lets a hash match a style attribute, and only an exact
    // value the build hashed: an injected attribute is still refused.
    ['style-src', ["'self'", ...(attrs.length > 0 ? ["'unsafe-hashes'"] : []), ...sorted([...attrs, ...sheets])]],
    ['img-src', ["'self'", ...(needs.dataIcon ? ['data:'] : []), ...origins(needs.images)]],
    ['connect-src', ["'self'", ...(needs.decoder ? ['blob:'] : []), ...origins(needs.connect)]],
    ...(needs.decoder ? [['worker-src', ["'self'", 'blob:']] as [string, string[]]] : []),
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

/** The page with its policy as the first thing after its charset, before any script or stylesheet it loads. */
export function withPolicy(html: string, policy: string): string {
  const at = html.indexOf(CHARSET);
  if (at < 0) throw new PolicyError(`csp: the page has no ${CHARSET} to place its policy after`);
  const content = policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const end = at + CHARSET.length;
  return `${html.slice(0, end)}\n    <meta http-equiv="${CSP_META}" content="${content}" />${html.slice(end)}`;
}
