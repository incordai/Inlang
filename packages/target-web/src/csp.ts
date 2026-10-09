/**
 * @az module csp
 * Purpose: each built page's Content-Security-Policy, from what the page needs and the markup it ships.
 * Spec: docs/word-quality-gate.md §2 B, §5.5 · docs/ARCHITECTURE.md §4.2
 * Exports: PageNeeds, CSP_META, PolicyError, pagePolicy, withPolicy, inlineScripts, inlineStyles, styleAttributes, sha256Source, ownDigests, originOf
 * Edit guide: imports only node:crypto and html-scan.ts — the CLI copies both (and the table html-scan.ts imports) verbatim into az-vite/, where build.mjs imports this file.
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
import { decodeAttribute, startTags, type StartTag } from './html-scan.ts';

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

/** What a page carries inline that its policy must allow, each in document order. */
interface Inline {
  readonly scripts: string[];
  readonly styles: string[];
  readonly attrs: string[];
}

/** An executed inline script: no `src`, and a type a browser runs. */
const executed = (tag: StartTag) =>
  !tag.attrs.has('src') && EXECUTED.test(decodeAttribute(tag.attrs.get('type') ?? '').trim());

/**
 * Everything inline in a page, read in one pass (html-scan.ts) over its text
 * as the browser's parser receives it — linear in the page's length, so no
 * page an author's component renders can hold the build.
 */
function inline(html: string): Inline {
  const out: Inline = { scripts: [], styles: [], attrs: [] };
  for (const tag of startTags(parsed(html))) {
    const style = tag.attrs.get('style');
    if (style !== undefined) out.attrs.push(decodeAttribute(style));
    if (tag.text === undefined) continue;
    if (tag.name === 'style') out.styles.push(tag.text);
    else if (executed(tag)) out.scripts.push(tag.text);
  }
  return out;
}

/** The text of every inline script a browser would run, byte for byte as the page carries it. */
export function inlineScripts(html: string): string[] {
  return inline(html).scripts;
}

/** The text of every inline <style> element. */
export function inlineStyles(html: string): string[] {
  return inline(html).styles;
}

/**
 * Every `style` attribute value in the markup, decoded. Script and style
 * bodies and comments are passed over: their text is not markup.
 */
export function styleAttributes(html: string): string[] {
  return inline(html).attrs;
}

/**
 * The digests a page's own policy pins — `sha256-…` of each inline script,
 * inline style and style attribute the text carries — as the secret scan
 * allows them (the generated build.mjs and az audit). Derived from the same
 * text, so a digest is allowed only where it is the hash of something that
 * file really holds; any other value is judged.
 */
export function ownDigests(html: string): string[] {
  const { scripts, styles, attrs } = inline(html);
  return [...scripts, ...styles, ...attrs].map((t) => sha256Source(t).slice(1, -1));
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
  const page = inline(html);
  const scripts = sorted(page.scripts.map(sha256Source));
  const attrs = sorted(page.attrs.map(sha256Source));
  const sheets = sorted(page.styles.map(sha256Source));
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
