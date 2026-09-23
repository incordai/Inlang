/**
 * @az module checks
 * Purpose: runs each word's validation table (word.json `checks`) at block, page and site level.
 * Spec: each docs/*-block-spec.md validation table
 * Exports: runBlockChecks, runPageChecks, runSiteChecks, Check
 * Edit guide: a new rule kind is added here once, then used as data by any word; codes are per word AZ2xxx.
 * Tests: packages/core/test/checks.test.ts
 */

/**
 * Per-word validations, declared in `word.json` and run here.
 *
 * Every block spec ends in a validation table (hero-spec §11, gallery-spec §11,
 * …). Writing those rows into link.ts as `if (word === 'gallery')` would break
 * the rule that core knows nothing about any specific word — a word is a
 * folder, and its manifest is the only place it is described. So a manifest
 * lists its rows as data, in a small closed vocabulary of `kind`s, and this
 * module evaluates them. The codes live in the manifest too: GRAMMAR §7
 * reserves AZ2000+ for per-word validations, and an ID is permanent once
 * shipped, so it belongs to the row, not to the order rows happen to run in.
 *
 * Two stages see different things, so the kinds split by stage:
 *   - BLOCK kinds run at link, on one block and its slot fills, with only the
 *     values the author wrote (a default is not a choice to warn about).
 *   - PAGE kinds run once the Spec exists, over the blocks a page renders —
 *     inherited ones included, defaults applied — because "one per page"
 *     cannot be judged from one block.
 */

import type { Diagnostic, Pos } from './lex.ts';

export type BlockCheckKind =
  | 'count'             // slot fills of `slots`, fires when atLeast <= n <= atMost
  | 'when'              // fires whenever `when` holds
  | 'childMissing'      // a fill of `slot` lacks `prop`
  | 'childEqual'        // a fill of `slot` has props[0] === props[1], both non-empty
  | 'childAllOrNone'    // some, but not all, fills of `slot` have `prop`
  | 'childAtMostOne'    // more than one fill of `slot` has `prop`
  | 'childUnique'       // two fills of `slot` share a label
  | 'childLabelWords'   // a fill of `slots` has a label longer than `atMost` words
  | 'childLabelPattern' // a fill of `slot` has a label not matching `pattern`
  | 'childRoute'        // a fill of `slots` links to a route that is not a page
  | 'propWords'         // written string `prop` has atLeast..atMost words
  | 'valuePattern';     // `prop` (on the block, or on each fill of `slot`) matches `pattern`

export type PageCheckKind =
  | 'perPage'           // more than `atMost` of this word (matching `when`) on one page
  | 'notFirst'          // this word (matching `when`) opens the page's content
  | 'pageWhen'          // `when` holds on a block a page renders, site-scoped props resolved
  | 'pageLacks';        // `when` holds, and no block the page renders is `needsWord` matching `needs`

/**
 * SITE kinds run once per file, on the site-level declaration of a word,
 * with every page in view — "a protected route has nowhere to send
 * signed-out users" (auth-spec §11) is about the whole site.
 */
export type SiteCheckKind =
  | 'siteNeeds';        // the site-level block holds `when`, and no page renders one matching `needs`

/** A gate. Every field given must hold; an empty gate always holds. */
export interface CheckWhen {
  /** The effective variant — the default when none was written — is one of these. */
  readonly variant?: string[];
  readonly notVariant?: string[];
  /** No variant was written at all. */
  readonly noVariant?: boolean;
  readonly modifier?: string;
  readonly notModifier?: string;
  /** The prop is set (written, or resolved at page stage). */
  readonly prop?: string;
  /** …and equals this value. */
  readonly value?: string;
  /** …and, as a `list` prop, includes this item. */
  readonly includes?: string;
  /** …and is none of these (an unset prop is none of them). */
  readonly notIn?: string[];
  /** A second gate that must hold as well — two props in one rule. */
  readonly also?: CheckWhen;
  /** The block is declared under a page, not at site level. */
  readonly inPage?: boolean;
}

export interface Check {
  /** Permanent diagnostic ID, AZ2000 or above (GRAMMAR §7). */
  readonly code: string;
  readonly kind: BlockCheckKind | PageCheckKind | SiteCheckKind;
  readonly severity: 'error' | 'warning';
  /**
   * The message after `<word>: `. Placeholders: {n} a count, {k} how many
   * have the prop, {label} a fill's label (file name for a path), {value} a
   * route, {first}/{second} two fills' labels, {with}/{without} a fill that
   * has the prop and one that does not.
   */
  readonly message: string;
  readonly when?: CheckWhen;
  readonly slots?: string[];
  readonly slot?: string;
  /** For `count`, counts only fills carrying this prop; for child kinds, the prop. */
  readonly prop?: string;
  /** With `prop`: the prop must have this value to count as carried (`highlight on`). */
  readonly value?: string;
  readonly props?: [string, string];
  readonly atLeast?: number;
  readonly atMost?: number;
  readonly pattern?: string;
  /** For `siteNeeds` / `pageLacks`: what a block must match to satisfy it. */
  readonly needs?: CheckWhen;
  /** For `pageLacks`: the word that must be on the page (defaults to this word). */
  readonly needsWord?: string;
}

export const BLOCK_KINDS: ReadonlySet<string> = new Set<BlockCheckKind>([
  'count', 'when', 'childMissing', 'childEqual', 'childAllOrNone', 'childAtMostOne',
  'childUnique', 'childLabelWords', 'childLabelPattern', 'childRoute', 'propWords', 'valuePattern',
]);
export const PAGE_KINDS: ReadonlySet<string> = new Set<PageCheckKind>(['perPage', 'notFirst', 'pageWhen', 'pageLacks']);
export const SITE_KINDS: ReadonlySet<string> = new Set<SiteCheckKind>(['siteNeeds']);

/** One argument of a fill, as either stage holds it. */
export interface CheckArg {
  readonly kind: string;
  readonly value: string;
}

/** A slot fill, as a check sees it. */
export interface CheckChild {
  readonly word: string;
  readonly args: readonly CheckArg[];
  readonly props: Readonly<Record<string, string>>;
  readonly pos: Pos;
}

/** One block, as a check sees it — the same shape at link and page stage. */
export interface CheckSubject {
  readonly word: string;
  /** The effective variant: the written one, else the manifest's first. */
  readonly variant: string | null;
  readonly variantWritten: boolean;
  readonly modifiers: readonly string[];
  readonly props: Readonly<Record<string, string>>;
  /** How each prop was written (`string`, `path`, …); link stage only. */
  readonly propKinds?: Readonly<Record<string, string>>;
  readonly children: readonly CheckChild[];
  readonly inPage: boolean;
  readonly pos: Pos;
}

export function holds(when: CheckWhen | undefined, s: CheckSubject): boolean {
  if (!when) return true;
  if (when.variant && !(s.variant !== null && when.variant.includes(s.variant))) return false;
  if (when.notVariant && s.variant !== null && when.notVariant.includes(s.variant)) return false;
  if (when.noVariant && s.variantWritten) return false;
  if (when.modifier && !s.modifiers.includes(when.modifier)) return false;
  if (when.notModifier && s.modifiers.includes(when.notModifier)) return false;
  if (when.prop !== undefined) {
    const v = s.props[when.prop];
    if (when.notIn !== undefined) {
      if (v !== undefined && when.notIn.includes(v)) return false;
    } else if (!(when.prop in s.props)) return false;
    if (when.value !== undefined && v !== when.value) return false;
    // A list prop is stored comma-joined (link.ts LIST_SEPARATOR).
    if (when.includes !== undefined && !(v ?? '').split(',').includes(when.includes)) return false;
  }
  if (when.inPage && !s.inPage) return false;
  if (when.also && !holds(when.also, s)) return false;
  return true;
}

/**
 * Does a fill carry `prop`? Either as a value line (`alt "…"`) or, for a
 * flag, as a bare word on the fill itself — feature-spec writes
 * `item "Sewn, not glued" lead`.
 */
export function carries(c: CheckChild, prop: string, value?: string): boolean {
  if (value !== undefined) return c.props[prop] === value;
  return prop in c.props || c.args.some((a) => a.kind === 'word' && a.value === prop);
}

/** A fill's name in a message: its first argument, a path shortened to its file. */
export function labelOf(c: CheckChild): string {
  const first = c.args[0];
  if (!first) return c.word;
  return first.kind === 'path' ? first.value.split('/').pop() ?? first.value : first.value;
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole);
}

/** The path part of a route, without a query or fragment. */
export const routePath = (value: string) => value.replace(/[?#].*$/, '') || '/';

type Report = (d: Diagnostic) => void;

/** Run one block's BLOCK-kind checks. `routes` are the pages the file declares. */
export function runBlockChecks(
  checks: readonly Check[], s: CheckSubject, routes: ReadonlySet<string>, report: Report,
): void {
  const say = (c: Check, pos: Pos, vars: Record<string, string | number> = {}) =>
    report({ code: c.code, severity: c.severity, pos, message: `${s.word}: ${fill(c.message, vars)}` });

  for (const c of checks) {
    if (!BLOCK_KINDS.has(c.kind) || !holds(c.when, s)) continue;
    const fills = (names: readonly string[] | undefined) =>
      s.children.filter((k) => names?.includes(k.word));
    const inSlot = fills(c.slot ? [c.slot] : c.slots);

    switch (c.kind as BlockCheckKind) {
      case 'count': {
        const n = c.prop ? inSlot.filter((k) => carries(k, c.prop!, c.value)).length : inSlot.length;
        if (n >= (c.atLeast ?? 0) && n <= (c.atMost ?? Infinity)) say(c, s.pos, { n });
        break;
      }
      case 'when':
        say(c, s.pos);
        break;
      case 'childMissing':
        for (const k of inSlot) if (!carries(k, c.prop!, c.value)) say(c, k.pos, { label: labelOf(k) });
        break;
      case 'childEqual': {
        const [a, b] = c.props!;
        for (const k of inSlot) {
          if (k.props[a] && k.props[a] === k.props[b]) say(c, k.pos, { label: labelOf(k) });
        }
        break;
      }
      case 'childAllOrNone': {
        const withIt = inSlot.filter((k) => carries(k, c.prop!, c.value));
        const without = inSlot.filter((k) => !carries(k, c.prop!, c.value));
        if (withIt.length > 0 && without.length > 0) {
          say(c, without[0].pos, {
            k: withIt.length, n: inSlot.length,
            with: labelOf(withIt[0]), without: labelOf(without[0]),
          });
        }
        break;
      }
      case 'childAtMostOne': {
        const marked = inSlot.filter((k) => carries(k, c.prop!, c.value));
        if (marked.length > 1) {
          say(c, marked[1].pos, { n: marked.length, first: labelOf(marked[0]), second: labelOf(marked[1]) });
        }
        break;
      }
      case 'childUnique': {
        const seen = new Set<string>();
        for (const k of inSlot) {
          const label = labelOf(k);
          if (seen.has(label)) say(c, k.pos, { label });
          seen.add(label);
        }
        break;
      }
      case 'childLabelWords':
        for (const k of inSlot) {
          if (k.args[0]?.kind === 'string' && words(k.args[0].value) > (c.atMost ?? Infinity)) {
            say(c, k.pos, { label: labelOf(k) });
          }
        }
        break;
      case 'childLabelPattern': {
        const re = new RegExp(c.pattern!);
        for (const k of inSlot) {
          if (k.args[0]?.kind === 'string' && !re.test(k.args[0].value)) say(c, k.pos, { label: labelOf(k) });
        }
        break;
      }
      case 'propWords': {
        const v = s.props[c.prop!];
        if (v === undefined || s.propKinds?.[c.prop!] !== 'string') break;
        const n = words(v);
        if (n >= (c.atLeast ?? 0) && n <= (c.atMost ?? Infinity)) say(c, s.pos, { n });
        break;
      }
      case 'valuePattern': {
        const re = new RegExp(c.pattern!);
        const targets = c.slot ? inSlot.map((k) => ({ v: k.props[c.prop!], pos: k.pos })) : [{ v: s.props[c.prop!], pos: s.pos }];
        for (const t of targets) {
          if (t.v !== undefined && re.test(t.v)) say(c, t.pos, { prop: c.prop!, value: t.v });
        }
        break;
      }
      case 'childRoute':
        for (const k of inSlot) {
          for (const a of k.args) {
            if (a.kind === 'route' && !routes.has(routePath(a.value))) say(c, k.pos, { value: a.value });
          }
        }
        break;
    }
  }
}

/** One block a page renders, with its word's checks and where it was written. */
export interface PageEntry {
  readonly subject: CheckSubject;
  readonly checks: readonly Check[];
  /** The page's opening content block — not nav, footer or a backdrop layer. */
  readonly opensContent: boolean;
}

/** Run the PAGE-kind checks over the blocks one page renders, in order. */
export function runPageChecks(entries: readonly PageEntry[], report: Report): void {
  const seen = new Set<string>();
  for (const e of entries) {
    for (const c of e.checks) {
      if (!PAGE_KINDS.has(c.kind)) continue;
      const say = (pos: Pos, vars: Record<string, string | number> = {}) =>
        report({ code: c.code, severity: c.severity, pos,
                 message: `${e.subject.word}: ${fill(c.message, vars)}` });

      if (c.kind === 'notFirst') {
        if (e.opensContent && holds(c.when, e.subject)) say(e.subject.pos);
        continue;
      }
      if (c.kind === 'pageWhen') {
        if (holds(c.when, e.subject)) say(e.subject.pos);
        continue;
      }
      if (c.kind === 'pageLacks') {
        const word = c.needsWord ?? e.subject.word;
        const met = entries.some((x) => x.subject.word === word && holds(c.needs, x.subject));
        if (holds(c.when, e.subject) && !met) say(e.subject.pos);
        continue;
      }
      // perPage: judged once per check per page, over every matching block.
      const id = `${e.subject.word}\u0000${c.code}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const matching = entries.filter((x) => x.subject.word === e.subject.word && holds(c.when, x.subject));
      const max = c.atMost ?? Infinity;
      if (matching.length > max) say(matching[max].subject.pos, { n: matching.length });
    }
  }
}

/** A site-level declaration of a word, with its word's checks. */
export interface SiteEntry {
  readonly subject: CheckSubject;
  readonly checks: readonly Check[];
}

/**
 * Run the SITE-kind checks: each site-level declaration against the blocks
 * every page renders (`pages`, one list of subjects per page).
 */
export function runSiteChecks(
  sites: readonly SiteEntry[], pages: readonly (readonly CheckSubject[])[], report: Report,
): void {
  for (const e of sites) {
    for (const c of e.checks) {
      if (!SITE_KINDS.has(c.kind) || !holds(c.when, e.subject)) continue;
      const met = pages.some((blocks) =>
        blocks.some((b) => b.word === e.subject.word && holds(c.needs, b)));
      if (!met) {
        report({ code: c.code, severity: c.severity, pos: e.subject.pos,
                 message: `${e.subject.word}: ${fill(c.message, {})}` });
      }
    }
  }
}
