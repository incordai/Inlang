/**
 * @az module actions
 * Purpose: the target-agnostic half of buttons: intents from destinations, hierarchies.
 * Spec: docs/buttons-and-sections-spec.md §1 · docs/GRAMMAR.md §4.3
 * Exports: intentOf, INTENTS, defaultHierarchy, isScriptUrl
 * Edit guide: a new URI scheme is an allow-list entry here (unlisted schemes are AZ1404).
 * Tests: packages/core/test/actions.test.ts
 */

/**
 * Actions — buttons-and-sections-spec §1, the target-agnostic half.
 *
 * What an action DOES is read from its destination, never declared (§1.3,
 * GRAMMAR §4.3); how much weight it carries is its hierarchy (§1.2). Both are
 * decided here, once, so the validator and every target agree. How an action
 * looks and which element it becomes is the target's business.
 */

import { HIERARCHIES, type Hierarchy } from './emit-contract.ts';

/** What an action does — buttons §1.2. */
export const INTENTS = ['go', 'call', 'mail', 'download', 'external', 'play', 'show', 'copy'] as const;
export type Intent = (typeof INTENTS)[number];

/** GRAMMAR §4.3: a scheme destination's key decides its intent. */
const SCHEME_INTENT: Readonly<Record<string, Intent>> = {
  tel: 'call', mailto: 'mail', video: 'play', popup: 'play', copy: 'copy', http: 'external', https: 'external',
};

/** The schemes a destination may use — GRAMMAR §4.3, and nothing else. */
export const DESTINATION_SCHEMES: readonly string[] = Object.keys(SCHEME_INTENT);

/**
 * Schemes that run code when followed. A quoted destination carrying one is
 * refused even where the value might be text, because every fill's second
 * argument can become an `href` (AZ1404).
 */
const SCRIPT_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data']);

/**
 * The scheme a browser would read from a URL, lower-cased; null for none.
 * Browsers drop leading C0 controls and spaces and remove every tab and line
 * break before parsing (WHATWG URL), so ` java\tscript:` is `javascript:` —
 * the same normalisation happens here before the scheme is taken.
 */
export function schemeOf(value: string): string | null {
  const cleaned = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  return m ? m[1].toLowerCase() : null;
}

/** Whether a quoted destination would run code if followed. */
export const isScriptUrl = (value: string): boolean => {
  const scheme = schemeOf(value);
  return scheme !== null && SCRIPT_SCHEMES.has(scheme);
};

/** The intent a scheme key maps to; null for a key the grammar does not list. */
function schemeIntent(key: string): Intent | null {
  return Object.hasOwn(SCHEME_INTENT, key) ? SCHEME_INTENT[key] : null;
}

/**
 * The intent of a destination, from its kind alone (GRAMMAR §4.3):
 * a route goes, an anchor shows, a path downloads, a scheme by its key.
 * Null when the argument is not a destination (or its scheme is unknown,
 * which the link stage has already reported, AZ1404).
 */
export function intentOf(arg: { readonly kind: string; readonly value: string } | undefined): Intent | null {
  if (!arg) return null;
  switch (arg.kind) {
    case 'route': return 'go';
    case 'anchor': return 'show';
    case 'path': return 'download';
    // Own keys only: `constructor:x` must not find Object's constructor.
    case 'pair': return schemeIntent(arg.value.slice(0, arg.value.indexOf(':')).toLowerCase());
    default: return null;
  }
}

/** The slot words whose fills are actions. */
export const ACTION_WORDS: ReadonlySet<string> = new Set(['cta', 'alt']);

export const isHierarchy = (value: string | null): value is Hierarchy =>
  value !== null && (HIERARCHIES as readonly string[]).includes(value);

/**
 * Default weight (buttons §1.2, hero §5): the first `cta` of a section is
 * primary, every other action secondary; an author's `as` wins.
 */
export function defaultHierarchy(fill: { readonly word: string; readonly as: string | null }, ctaIndex: number): Hierarchy {
  if (isHierarchy(fill.as)) return fill.as;
  return fill.word === 'cta' && ctaIndex === 0 ? 'primary' : 'secondary';
}
