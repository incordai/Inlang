/**
 * @az module head-order
 * Purpose: every built page links its stylesheets before any script in its head.
 * Spec: HTML §4.2.4 (link), §4.12.1 (script)
 * Exports: stylesFirst
 * Edit guide: imports only html-scan.ts — the CLI copies both verbatim into az-vite/, where vite.config.ts runs this as a post transformIndexHtml hook.
 * Tests: packages/target-web/test/head-order.test.ts, scripts/verify-build.mjs
 */

/**
 * The bundler writes a page's entry `<script type="module">` into its head
 * first and the stylesheet `<link>` after it. A module script is deferred,
 * but nothing makes it wait for a stylesheet linked AFTER it: one browser
 * engine runs it as soon as it has loaded, so under load the behaviour
 * runtime attaches to a page whose styles have not applied, and every layout
 * it reads then (a carousel's ends, a block's place in the first viewport)
 * is the unstyled page's. With the stylesheet first, a module script runs
 * only once the stylesheets before it have loaded — the standard order, and
 * no cost to first paint: the stylesheet was render-blocking either way, and
 * the script is still fetched as soon as the head is read.
 *
 * Run after the bundler has written its own tags, so the order it injects is
 * the one corrected. Only the head is reordered, and only stylesheets that
 * follow its first script; each keeps its order among the others, and lands
 * just before that script, after the charset and the page's policy.
 */

import { decodeAttribute, startTags, type StartTag } from './html-scan.ts';

/** HTML's ASCII whitespace, which separates the tokens of `rel`. */
const TOKENS = /[\t\n\f\r ]+/;

/** A `<link>` whose `rel` names a stylesheet (ASCII case-insensitive, HTML §4.6.7). */
function isStylesheet(tag: StartTag): boolean {
  if (tag.name !== 'link') return false;
  const rel = decodeAttribute(tag.attrs.get('rel') ?? '').toLowerCase();
  return rel.split(TOKENS).includes('stylesheet');
}

/** Where the line holding `at` starts, when only spaces and tabs come before it on that line; else `at`. */
function lineStart(html: string, at: number): number {
  let i = at;
  while (i > 0 && (html[i - 1] === ' ' || html[i - 1] === '\t')) i--;
  return i > 0 && html[i - 1] === '\n' ? i - 1 : at;
}

/** `html` with every stylesheet in its head that follows the head's first script moved to just before that script. */
export function stylesFirst(html: string): string {
  const tags = startTags(html);
  const bodyAt = tags.findIndex((t) => t.name === 'body');
  const head = bodyAt < 0 ? tags : tags.slice(0, bodyAt);
  const script = head.find((t) => t.name === 'script');
  if (!script) return html;
  const late = head.filter((t) => t.start > script.start && isStylesheet(t));
  if (late.length === 0) return html;
  // Each link leaves with the line it stood on; where the script has a line
  // of its own, each lands on its own line, indented as the script is.
  const from = lineStart(html, script.start);
  const separator = from < script.start ? html.slice(from, script.start) : '';
  const moved = late.map((t) => html.slice(t.start, t.end) + separator).join('');
  let out = html.slice(0, script.start) + moved;
  let at = script.start;
  for (const t of late) {
    out += html.slice(at, lineStart(html, t.start));
    at = t.end;
  }
  return out + html.slice(at);
}
