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
    case 'pair': return SCHEME_INTENT[arg.value.slice(0, arg.value.indexOf(':')).toLowerCase()] ?? null;
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
