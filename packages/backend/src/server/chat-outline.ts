/**
 * @az server chat-outline
 * Purpose: the site content as the model reads it: an outline of context.json's public pages, each page as a summary and in full.
 * Spec: docs/chat-block-spec.md §8.3, §19.17
 * Exports: siteOutline, outlineString, SiteOutline, OutlinePage
 * Edit guide: every value the author wrote is a quoted string with <, > and & escaped, so no text can start a line or close the section; total over any JSON (an unknown shape adds nothing, never throws); deterministic.
 * Tests: packages/backend/test/chat-outline.test.ts
 */

/**
 * The site content was sent as `JSON.stringify` of context.json's pages:
 * every block repeated its keys (`"block"`, `"label"`, `"to"`, `"question"`)
 * on every item. The outline says the same in fewer tokens (chat-block-spec
 * §19.17): one line per block, page or item, the structure in bare words the
 * build chose and every value the author wrote as a JSON string —
 *
 *     page /help "Help and shipping"
 *       faq "Questions"
 *         1 "Do you ship abroad?" "Yes, to most countries."
 *       cta "Still stuck?"; button "Contact us" /contact
 *
 * A string is JSON-quoted with `<`, `>` and `&` escaped as \u003c, \u003e
 * and \u0026 (chat-knows.ts escapes rows the same way), so a value can
 * neither break its line nor close the `<site-content>` section it is in.
 * Items are numbered from 1, the number a quote of one item names
 * (`show faq /help #2`).
 *
 * Each page has two forms: its summary — its route, description and each
 * block's word, title and size — and its full content. A chat sends every
 * page in full, or, on a large site, every summary and only the pages a
 * question needs in full (chat.ts systemText, §19.17). The words of each
 * page are kept for that choice (chat-match.ts).
 *
 * Copied into a generated server with chat; imports chat-match.ts.
 */

import { MATCH_LIMITS, terms } from './chat-match.ts';

/** One page of the outline: its route, its summary and full lines, and its words for choosing it. */
export interface OutlinePage {
  readonly route: string;
  /** The page's line and one line per block: what every question is sent on a large site. */
  readonly summary: string;
  /** The page in full: its line, every block and every item. */
  readonly full: string;
  /** The terms of every string the page holds, for scoring it against a question (chat-match.ts). */
  readonly terms: readonly string[];
  /** …and of its route and its blocks' titles, which count twice. */
  readonly title: readonly string[];
}

export interface SiteOutline {
  /** The site's own line, `site "Bench" "Its description"` — empty without a description: the prompt names the site already. */
  readonly site: string;
  readonly pages: readonly OutlinePage[];
}

/** A value the author wrote, as one inert JSON string: nothing in it can end its line or the section. */
export const outlineString = (s: string): string =>
  JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/** A destination, a price or a code that needs no quotes: nothing in it a line or the section could end at. */
const PLAIN = /^[A-Za-z0-9/#][A-Za-z0-9/#._~:-]*$/;
/** A destination, price or code as written when it is plain, else quoted. */
const term = (s: string): string => (PLAIN.test(s) ? s : outlineString(s));

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** The quoted values that are strings, joined by spaces; absent ones add nothing. */
const quoted = (...vs: unknown[]): string => vs.map(str).filter((s): s is string => s !== null).map(outlineString).join(' ');

/** A block's buttons, after its other parts: `; button "Label" /to`. */
function buttons(actions: unknown): string {
  return list(actions).filter(isObj).filter((a) => str(a.label) !== null && str(a.to) !== null)
    .map((a) => `; button ${outlineString(a.label as string)} ${term(a.to as string)}`).join('');
}

/** A head line: its word and the values that are there, separated by one space. */
const head = (indent: string, word: string, rest: string): string => `${indent}${word}${rest === '' ? '' : ` ${rest}`}`;

/** One block as its summary line and its full lines, or null for a shape the build never writes. */
function blockLines(b: Obj): { summary: string; full: string[] } | null {
  const word = str(b.block);
  if (word === null || !/^[a-z]+$/.test(word)) return null;
  const at = '  ';
  const inner = '    ';
  switch (word) {
    case 'faq':
    case 'feature': {
      const raw = list(word === 'faq' ? b.questions : b.items).filter(isObj);
      const items = raw.map((i, n) => head(inner, String(n + 1), word === 'faq' ? quoted(i.question, i.answer) : quoted(i.title, i.text)));
      const size = items.length === 0 ? '' : ` (${items.length} ${items.length === 1 ? 'item' : 'items'})`;
      const top = head(at, word, quoted(b.title, b.sub));
      return { summary: `${head(at, word, quoted(b.title))}${size}`, full: [`${top}${buttons(b.actions)}`, ...items] };
    }
    case 'pricing': {
      const plans = list(b.plans).filter(isObj).map((p) => {
        const price = [['monthly', p.monthly], ['annual', p.annual]].filter(([, v]) => str(v) !== null).map(([k, v]) => `${k} ${term(v as string)}`);
        const features = list(p.features).map(str).filter((s): s is string => s !== null).map(outlineString);
        const parts = [quoted(p.name), ...price, ...(str(p.badge) ? [`badge ${outlineString(p.badge as string)}`] : []), ...(p.highlighted === true ? ['highlighted'] : [])];
        return `${head(inner, 'plan', parts.filter(Boolean).join(' '))}${features.length > 0 ? `; features ${features.join(' ')}` : ''}${buttons(p.actions)}`;
      });
      const terms = [quoted(b.title, b.sub), ...(str(b.currency) ? [`currency ${term(b.currency as string)}`] : []), ...(str(b.period) ? [`period ${term(b.period as string)}`] : [])];
      const size = plans.length === 0 ? '' : ` (${plans.length} ${plans.length === 1 ? 'plan' : 'plans'})`;
      return { summary: `${head(at, word, quoted(b.title))}${size}`, full: [head(at, word, terms.filter(Boolean).join(' ')), ...plans] };
    }
    case 'text': {
      const body = str(b.body);
      return { summary: head(at, word, quoted(b.title)), full: [`${head(at, word, quoted(b.title))}${buttons(b.actions)}`, ...(body ? [`${inner}${outlineString(body)}`] : [])] };
    }
    default:
      // hero, cta and any other block the build writes: its eyebrow, title and line, and its buttons.
      return { summary: head(at, word, quoted(b.title)), full: [`${head(at, word, quoted(b.eyebrow, b.title, b.sub))}${buttons(b.actions)}`] };
  }
}

/** Every string a value holds, depth first — the page's words for choosing it. */
function strings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isObj(v)) for (const k of Object.keys(v)) if (k !== 'block' && k !== 'to' && k !== 'route') strings(v[k], out);
  return out;
}

/**
 * context.json's `{ site, pages }` as the outline: the site's line and each
 * page with a route, in the file's order. Anything not of the build's shape
 * is left out.
 */
export function siteOutline(content: unknown): SiteOutline {
  const c = isObj(content) ? content : {};
  const site = isObj(c.site) ? c.site : {};
  const pages: OutlinePage[] = [];
  for (const p of list(c.pages)) {
    if (!isObj(p)) continue;
    const route = str(p.route);
    if (route === null || !route.startsWith('/')) continue;
    const line = head('', 'page', [outlineString(route).slice(1, -1), quoted(p.description)].filter(Boolean).join(' '));
    const blocks = list(p.blocks).filter(isObj).map(blockLines).filter((b): b is { summary: string; full: string[] } => b !== null);
    pages.push({
      route,
      summary: [line, ...blocks.map((b) => b.summary)].join('\n'),
      full: [line, ...blocks.flatMap((b) => b.full)].join('\n'),
      terms: terms(strings(p, []).join('\n'), MATCH_LIMITS.pageChars, MATCH_LIMITS.pageTerms),
      title: terms([route, ...list(p.blocks).filter(isObj).map((b) => str(b.title) ?? '')].join('\n'), MATCH_LIMITS.pageChars, MATCH_LIMITS.pageTerms),
    });
  }
  return { site: str(site.description) === null ? '' : head('', 'site', quoted(site.name, site.description)), pages };
}
