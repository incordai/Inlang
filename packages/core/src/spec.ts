/**
 * Spec — the contract boundary.
 *
 * ARCHITECTURE.md §3: "`Spec` is the contract boundary. It must be
 * JSON-serialisable and contain no target-specific fields."
 *
 * Everything upstream (lex, parse, link) is about understanding the file.
 * Everything downstream (emit) is about one target. This type is the seam, and
 * it is the reason a second target is possible later: nothing here knows what
 * React, CSS or a canvas is.
 *
 * DETERMINISM (CONVENTIONS §6): no timestamps, no random ids, stable key
 * order. `az build` twice must produce byte-identical output, and that claim
 * begins here — if the Spec is unstable, nothing downstream can be stable.
 */

import type { Diagnostic, Pos } from './lex.ts';
import type { SpecBlock } from './spec-block.ts';
import type { LinkedWord } from './link.ts';
import type { Manifest } from './link.ts';
import { runPageChecks, runSiteChecks, type CheckSubject, type PageEntry } from './checks.ts';

/**
 * Where each block was written. A SpecBlock carries no position — it is the
 * target-facing shape — but a page-level check must point at a line.
 */
const written = new WeakMap<SpecBlock, Pos>();

// SpecBlock lives in its own dependency-free module so the emit contract,
// and a word ejected with it (`az eject`), can import it without this file.
export type { SpecBlock } from './spec-block.ts';

export interface SpecPage {
  readonly route: string;
  readonly blocks: SpecBlock[];
}

export interface SpecSite {
  readonly name: string;
  /** Frame — PRD §6.1a. Resolved to a word, never a pixel value. */
  readonly width: string;
  readonly theme: string;
  readonly accent: string;
  readonly pattern: string;
  readonly fonts: Record<string, string>;
  /** Blocks declared at site level and inherited by every page. */
  readonly inherited: SpecBlock[];
  /**
   * Site-scoped prop values by word — `{ auth: { adapter: "hosted" } }`.
   * A site-level `auth` renders nothing, so it is not an inherited block,
   * but the target still needs its settings to wire the site (M4).
   */
  readonly scoped: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface Spec {
  readonly version: string;
  readonly site: SpecSite;
  readonly pages: SpecPage[];
}

export interface SpecResult {
  readonly spec: Spec;
  readonly diagnostics: Diagnostic[];
}

/** Defaults for the frame and theme, so a Spec is always complete. */
const SITE_DEFAULTS = {
  width: 'center',
  theme: 'midnight',
  accent: 'violet',
  pattern: 'glow',
} as const;

/** Blocks that may be declared at site level and inherited — nav-spec §8. */
const INHERITABLE = new Set(['nav', 'footer', 'scene']);

/**
 * Recursively build a block, applying manifest defaults.
 *
 * Defaults are applied HERE rather than in a target, so every target sees the
 * same complete value and two targets cannot disagree about what `height`
 * means when the author omitted it.
 */
/**
 * Site-scoped prop values, by word: `auth` -> { adapter: "azbackend" }.
 *
 * A `scope: "site"` prop is declared once, on the site-level instance of its
 * word, and belongs to every instance on every page (auth-spec §2: one
 * adapter per site). The link stage refuses it at page level (AZ1304), so
 * without carrying it down a page's `auth login` never learned its adapter.
 */
type SiteScoped = ReadonlyMap<string, Readonly<Record<string, string>>>;

function siteScopedProps(kids: LinkedWord[], manifests: Map<string, Manifest>): SiteScoped {
  const out = new Map<string, Record<string, string>>();
  for (const w of kids) {
    const m = manifests.get(w.word);
    for (const [key, spec] of Object.entries(m?.props ?? {})) {
      if (spec.scope !== 'site' || !(key in w.props)) continue;
      const values = out.get(w.word) ?? {};
      values[key] ??= w.props[key].value;
      out.set(w.word, values);
    }
  }
  return out;
}

function toBlock(w: LinkedWord, manifests: Map<string, Manifest>, site: SiteScoped = new Map()): SpecBlock {
  const block = buildBlock(w, manifests, site);
  written.set(block, w.pos);
  return block;
}

function buildBlock(w: LinkedWord, manifests: Map<string, Manifest>, site: SiteScoped): SpecBlock {
  const m = manifests.get(w.word);
  const props: Record<string, string> = {};

  for (const [key, arg] of Object.entries(w.props)) props[key] = arg.value;

  for (const [key, value] of Object.entries(site.get(w.word) ?? {})) {
    if (!(key in props)) props[key] = value;
  }

  for (const [key, spec] of Object.entries(m?.props ?? {})) {
    if (key in props) continue;
    if (spec.default !== undefined) props[key] = String(spec.default);
  }

  // Stable key order — CONVENTIONS §6. Object insertion order is what
  // JSON.stringify emits, so sorting here is what makes the bytes stable.
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(props).sort()) ordered[key] = props[key];

  return {
    word: w.word,
    variant: w.variant ?? m?.variants?.[0] ?? null,
    modifiers: [...w.modifiers].sort(),
    // Source order is meaningful here — label then destination — so these are
    // NOT sorted the way props are.
    args: w.args
      .filter((a) => a.value !== w.variant && !w.modifiers.includes(a.value))
      .map((a) => ({ kind: a.kind, value: a.value })),
    props: ordered,
    as: w.as,
    children: w.children.map((c) => toBlock(c, manifests, site)),
  };
}

export function buildSpec(
  version: string | null,
  root: LinkedWord[],
  manifests: Map<string, Manifest>,
): SpecResult {
  const diagnostics: Diagnostic[] = [];

  const siteWord = root.find((w) => w.word === 'site');
  const pageWords = root.filter((w) => w.word === 'page');

  if (!siteWord) {
    diagnostics.push({
      code: 'AZ1301',
      message: 'site: no site declared — every file needs: site <name>',
      pos: { line: 1, col: 1 },
      severity: 'error',
    });
  }
  if (pageWords.length === 0) {
    diagnostics.push({
      code: 'AZ1302',
      message: 'page: no pages declared — add: page /',
      pos: siteWord?.pos ?? { line: 1, col: 1 },
      severity: 'error',
    });
  }

  // ---- site-scoped props, checked file-wide (AZ1303) --------------------
  //
  // A prop marked `scope: "site"` is declared ONCE and shared — auth's
  // `adapter` is the case ("one adapter per site", auth-spec §2). The link
  // stage cannot check it, because it sees one block at a time and a page's
  // `auth login` is legitimately silent about the adapter. Checking it here,
  // where the whole file is in view, is what makes dropping it from the
  // per-block check safe rather than a hole.
  {
    const siteKids = siteWord?.children ?? [];
    const seen = new Set<string>();
    const walk = (w: LinkedWord) => {
      const m = manifests.get(w.word);
      for (const [key, ps] of Object.entries(m?.props ?? {})) {
        if (ps.scope !== 'site' || !ps.required) continue;
        const id = `${w.word}.${key}`;
        if (seen.has(id)) continue;
        // Is it declared on a SITE-level instance of the same word?
        const declared = siteKids.some((k) => k.word === w.word && key in k.props);
        if (declared) { seen.add(id); continue; }
        seen.add(id);
        diagnostics.push({
          code: 'AZ1303',
          message: `${w.word}: no ${key} declared — add it once at site level: `
                 + `site <name> / ${w.word} / ${key} <value>`,
          pos: w.pos,
          severity: 'error',
        });
      }
      w.children.forEach(walk);
    };
    for (const p of pageWords) p.children.forEach(walk);
  }

  // ---- the frame and theme, resolved once (PRD principle 3) -------------
  const kids = siteWord?.children ?? [];
  const themeWord = kids.find((w) => w.word === 'theme');
  const fontWord = kids.find((w) => w.word === 'font');

  const fonts: Record<string, string> = {};
  for (const role of (fontWord?.children ?? [])) {
    // `font` holds `display serif` style roles; the value rides on the child.
    fonts[role.word] = role.args[0]?.value ?? '';
  }

  const inherited = kids
    .filter((w) => INHERITABLE.has(w.word))
    .map((w) => toBlock(w, manifests));

  const site = siteScopedProps(kids, manifests);
  const pages: SpecPage[] = pageWords.map((p) => ({
    route: p.args[0]?.value ?? '/',
    blocks: p.children.map((c) => toBlock(c, manifests, site)),
  }));

  // A word's own first argument is its value: `width wide` -> "wide".
  // Read from `args`, because a structure keyword has no manifest and so no
  // variant or modifier for its value to have been sorted into.
  const valueOf = (w: LinkedWord | undefined, fallback: string) =>
    w?.args[0]?.value ?? w?.variant ?? fallback;
  const widthWord = kids.find((w) => w.word === 'width');
  const accentWord = themeWord?.children.find((w) => w.word === 'accent');
  const patternWord = themeWord?.children.find((w) => w.word === 'pattern');

  const spec: Spec = {
    version: version ?? '1',
    site: {
      name: siteWord?.args[0]?.value ?? 'site',
      width: valueOf(widthWord, SITE_DEFAULTS.width),
      theme: valueOf(themeWord, SITE_DEFAULTS.theme),
      accent: valueOf(accentWord, SITE_DEFAULTS.accent),
      pattern: valueOf(patternWord, SITE_DEFAULTS.pattern),
      fonts,
      inherited,
      scoped: Object.fromEntries([...site.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    },
    pages,
  };

  // ---- one site, one value for a site-scoped prop ------------------------
  //
  // auth-spec §11: "'hosted' and 'session' are both adapters — one site, one
  // adapter". Two site-level declarations used to resolve silently to the
  // first.
  {
    const firstSeen = new Map<string, { value: string; word: string; key: string }>();
    for (const w of kids) {
      for (const [key, ps] of Object.entries(manifests.get(w.word)?.props ?? {})) {
        if (ps.scope !== 'site' || !(key in w.props)) continue;
        const id = `${w.word}.${key}`;
        const value = w.props[key].value;
        const before = firstSeen.get(id);
        if (!before) { firstSeen.set(id, { value, word: w.word, key }); continue; }
        if (before.value === value) continue;
        diagnostics.push({
          code: 'AZ1505',
          message: `${w.word}: '${before.value}' and '${value}' are both ${key}s — one site, one ${key}`,
          pos: w.props[key].pos,
          severity: 'error',
        });
      }
    }
  }

  // ---- page-level rows of each word's validation table (checks.ts) -----
  const rendered: CheckSubject[][] = [];
  for (const page of pages) {
    const entries = pageEntries(spec, page, manifests);
    runPageChecks(entries, (d) => diagnostics.push(d));
    rendered.push(entries.map((e) => e.subject));
  }

  // ---- site-level rows: one declaration, every page in view ------------
  runSiteChecks(
    kids.filter((w) => manifests.get(w.word)?.checks?.length).map((w) => ({
      subject: {
        word: w.word,
        variant: w.variant,
        variantWritten: w.variant !== null,
        modifiers: w.modifiers,
        props: Object.fromEntries(Object.entries(w.props).map(([k, a]) => [k, a.value])),
        children: [],
        inPage: false,
        pos: w.pos,
      },
      checks: manifests.get(w.word)?.checks ?? [],
    })),
    rendered,
    (d) => diagnostics.push(d),
  );

  return { spec, diagnostics };
}

/**
 * The blocks one page renders, for page-level checks.
 *
 * Inherited blocks the page does not override or suppress, then the page's
 * own — including a SECOND declaration of the same word, which blocksFor
 * collapses (it can render only one) and which is exactly what "only one per
 * page" must see.
 */
function pageEntries(spec: Spec, page: SpecPage, manifests: Map<string, Manifest>): PageEntry[] {
  const own = page.blocks.filter((b) => b.variant !== 'none');
  const overridden = new Set(page.blocks.map((b) => b.word));
  const inherited = spec.site.inherited.filter((b) => !overridden.has(b.word) && b.variant !== 'none');

  // Content opens with the first own block that is not page chrome: nav and
  // footer frame a page, and a backdrop scene is a layer behind it.
  const chrome = (b: SpecBlock) =>
    b.word === 'nav' || b.word === 'footer' || (b.word === 'scene' && b.variant === 'backdrop');
  const opener = own.find((b) => !chrome(b));

  const entry = (b: SpecBlock, inPage: boolean): PageEntry => ({
    subject: subjectOf(b, inPage),
    checks: manifests.get(b.word)?.checks ?? [],
    opensContent: b === opener,
  });
  return [...inherited.map((b) => entry(b, false)), ...own.map((b) => entry(b, true))];
}

function subjectOf(b: SpecBlock, inPage: boolean): CheckSubject {
  const at = written.get(b) ?? { line: 1, col: 1 };
  return {
    word: b.word,
    variant: b.variant,
    variantWritten: true,
    modifiers: b.modifiers,
    props: b.props,
    children: b.children.map((c) => ({
      word: c.word, args: c.args, props: c.props, pos: written.get(c) ?? at,
    })),
    inPage,
    pos: at,
  };
}

/**
 * Serialise a Spec deterministically.
 *
 * Sorted keys at every level. This is the function `test:determinism` compares,
 * and the product's headline claim rests on it returning identical bytes for
 * identical input, forever.
 */
export function serialiseSpec(spec: Spec): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortValue((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortValue(spec), null, 2) + '\n';
}

/**
 * Where an inherited block sits relative to a page's own content.
 *
 * `nav` opens the page and `footer` closes it; a site-level `scene` is a
 * backdrop, so it goes first and sits behind (scene-spec §4). Without this,
 * every target concatenated `[...inherited, ...page.blocks]` and rendered the
 * FOOTER ABOVE THE PAGE CONTENT — the markup was valid and the page was wrong.
 */
const PLACEMENT: Record<string, 'start' | 'end'> = {
  nav: 'start', scene: 'start', footer: 'end',
};

/**
 * Where a block sits if it is an inherited one, else undefined.
 *
 * Only `scene backdrop` is inherited like nav (scene-spec §6); `scene inline`
 * and `scene full` are ordinary page content. Treating every scene as
 * inheritable hoisted a page's inline scene to the top, and let it replace
 * the site's backdrop. `none` stays placed, because it is how a page opts
 * out of the inherited backdrop.
 */
function placementOf(b: SpecBlock): 'start' | 'end' | undefined {
  if (b.word === 'scene' && b.variant !== 'backdrop' && b.variant !== 'none') return undefined;
  return PLACEMENT[b.word];
}

/**
 * The blocks a page actually renders, inheritance resolved.
 *
 * This is a CORE function, not a target's job. Two targets doing this
 * independently is two chances to disagree about what a page contains, and
 * the rules are language rules rather than markup rules:
 *
 *   - a page-level declaration OVERRIDES the inherited one of the same word
 *     (footer-spec §1: `page /checkout` / `footer minimal`)
 *   - the reserved variant `none` suppresses it entirely, inherited included
 *     (GRAMMAR §5.2 — it exists so a login page can have no nav)
 *   - `nav` opens the page, `footer` closes it
 *
 * Before this existed, `page /login` with `nav none` rendered TWO navs: the
 * inherited one plus the suppression itself.
 */
export function blocksFor(spec: Spec, page: SpecPage): SpecBlock[] {
  const start: SpecBlock[] = [];
  const end: SpecBlock[] = [];
  const body: SpecBlock[] = [];

  // What the page says about each inheritable word, if anything.
  const overrides = new Map<string, SpecBlock>();
  for (const b of page.blocks) {
    if (placementOf(b) !== undefined) overrides.set(b.word, b);
  }

  for (const inheritedBlock of spec.site.inherited) {
    const chosen = overrides.get(inheritedBlock.word) ?? inheritedBlock;
    if (chosen.variant === 'none') continue;
    (placementOf(chosen) === 'end' ? end : start).push(chosen);
  }

  for (const b of page.blocks) {
    const placement = placementOf(b);
    if (placement === undefined) { body.push(b); continue; }
    // Already handled above as an override of an inherited block.
    if (spec.site.inherited.some((i) => i.word === b.word)) continue;
    if (b.variant === 'none') continue;   // nothing to suppress, but not shown
    (placement === 'end' ? end : start).push(b);
  }

  return [...start, ...body, ...end];
}
