/**
 * @az module link
 * Purpose: statements → resolved words against manifests: props, slots, requires, values, routes.
 * Spec: docs/GRAMMAR.md §4–§5 · docs/ARCHITECTURE.md §4.1
 * Exports: link, Manifest, PropSpec, STRUCTURE, STRUCTURE_PROPS
 * Edit guide: never name a specific word here — per-word rules are manifest data (checks.ts); lookups use Object.hasOwn.
 * Tests: packages/core/test/link.test.ts, packages/core/test/prop-rules.test.ts, packages/core/test/head-settings.test.ts
 */

/**
 * Link stage — statements become resolved words.
 *
 * Implements ARCHITECTURE.md §3 (pipeline) and §4.1 (word manifest).
 *
 * The parser deliberately knows nothing about `hero`. THIS is where a word
 * gains meaning, and it does so ONLY from `word.json` — the manifest is the
 * single source of truth, and validation, autocomplete, lint and the graph are
 * all derived from it. Nothing about any specific word is written here, which
 * is what keeps `core` ignorant enough for a word to be a folder.
 */

import {
  ACTION_WORDS, DESTINATION_SCHEMES, defaultHierarchy, intentOf, isHierarchy, isScriptUrl, schemeOf,
} from './actions.ts';
import { quotable as shown } from './secrets.ts';
import { BACKEND_SETTINGS } from './backend.ts';
import { HIERARCHIES } from './emit-contract.ts';
import type { Diagnostic, Pos } from './lex.ts';
import type { Arg, Statement, AzFile } from './parse.ts';
import { routePath, runBlockChecks, type Check, type CheckChild } from './checks.ts';
import { fromWords, type FromManifest } from './from.ts';
import { ICON_FORMATS } from './icon.ts';
import { ACCENT_PAIRS } from './accent-pairs.ts';

export interface PropSpec {
  readonly type: string;
  readonly required?: boolean;
  /** ≤60 characters: what this prop does, for `az explain` and AI tools. */
  readonly description?: string;
  /** ≤60 characters per enum/list value: what choosing it does. */
  readonly valueDescriptions?: Readonly<Record<string, string>>;
  /**
   * The allowed values: either the list itself, or the NAME of a value set
   * too large to write out (pricing declares `"values": "iso4217"`).
   *
   * This was typed `string[]` while a manifest already used the string form,
   * so the enum check called `.join` on a string and the compiler CRASHED —
   * a malformed manifest must produce a diagnostic, never a stack trace.
   */
  readonly values?: string[] | string;
  readonly ext?: string[];
  readonly maxBytes?: number;
  readonly maxWords?: number;
  readonly default?: unknown;
  /**
   * Where the value is declared.
   *
   * `site` means declared ONCE for the whole file and shared — auth's
   * `adapter` is the case the manifests already described this way
   * ("one adapter per site", auth-spec §2). The field was declared and never
   * read, so every page-level `auth login` was told its adapter was missing.
   * The file-wide check lives in spec.ts (AZ1303), which has the whole file.
   */
  readonly scope?: 'site' | 'block';
  /**
   * Values of the vocabulary that are declared but not available yet.
   *
   * auth-spec §12.3 defers `methods oauth` past the first release. Dropping it
   * from `values` would make `oauth` read as a typo ("not a methods — try: …");
   * keeping it in `values` unrefused would compile a form that silently has
   * no provider buttons. Listing it here names it and refuses it (AZ1214).
   */
  readonly deferred?: string[];
  /** `list` props: the most items the list may hold. `int`: the largest value. */
  readonly max?: number;
  /** `list` props: the type of each item — `enum` (checked against `values`) or `route`. */
  readonly of?: 'enum' | 'route';
  /** `int` props: the smallest value. */
  readonly min?: number;
}

export interface Manifest {
  readonly name: string;
  readonly kind?: string;
  /**
   * ≤60 characters: what the word is. With `descriptions` and each prop's and
   * slot's `description`, this is the whole of `az explain` — the cheapest way
   * for an AI to learn what `hero center` means without reading a spec.
   */
  readonly description?: string;
  readonly descriptions?: {
    readonly variants?: Readonly<Record<string, string>>;
    readonly modifiers?: Readonly<Record<string, string>>;
    readonly children?: Readonly<Record<string, string>>;
  };
  readonly variants?: string[];
  readonly modifiers?: string[];
  readonly props?: Record<string, PropSpec>;
  readonly children?: string[];
  readonly requires?: Record<string, string[]>;
  /**
   * Like `requires`, but a WARNING.
   *
   * nav-spec §4 asks the compiler to "warn when `solid` is used without" an
   * inverse logo — advice, not a hard error. Expressed as `requires` it
   * rejected the spec's own example. Two mechanisms because the specs
   * genuinely mean two different strengths.
   */
  readonly recommends?: Record<string, string[]>;
  /**
   * Requirements triggered by a PROP VALUE: `{ prop: { value: [needs] } }`.
   *
   * `requires` keys on variants and modifiers, and a word's behaviour can also
   * turn on the value of an enum prop — auth's `adapter custom` needs an
   * `impl` file (auth-spec §11). Written into `requires` as `"custom"` it was
   * never active, because `custom` is neither a variant nor a modifier, so
   * the error the spec promises was never raised. Nested rather than a
   * `"adapter=custom"` key, so a manifest never carries syntax inside a
   * string and the prop name is checked like any other key.
   */
  readonly requiresWhen?: Record<string, Record<string, string[]>>;
  readonly slots?: Record<string, unknown>;
  /**
   * The rows of the word's spec validation table, as data (checks.ts).
   * A `count` check with no `when` on exactly one slot takes over that slot's
   * bounds: its message is the spec's, so the generic min/max stays silent.
   */
  readonly checks?: Check[];
  /**
   * `from <table>` (data-spec §10): the slot rows fill and what each slot
   * prop may be mapped from. Only a word with this entry takes `from`.
   */
  readonly from?: FromManifest;
}

/**
 * Value sets named rather than listed.
 *
 * LIMITATION, stated rather than hidden: `iso4217` checks the SHAPE of a
 * currency word (three lowercase letters), not membership of the real ISO 4217
 * table. `zzz` passes today. Writing 180 codes from memory would risk inventing
 * one, which is worse than a documented partial check — the table needs a real
 * data source before this becomes a membership test.
 */
const NAMED_VALUE_SETS: Record<string, { test: (v: string) => boolean; describe: string }> = {
  iso4217: {
    test: (v) => /^[a-z]{3}$/.test(v),
    describe: 'a three-letter currency word, e.g. usd, eur, gbp',
  },
};

/** Structure keywords live in core, not in `words/` — PRD §6.2. */
export const STRUCTURE = new Set(['site', 'theme', 'font', 'page', 'raw', 'slot', 'backend', 'data']);

/**
 * Where `slot <name> <path>` may put a component on EVERY block, beside the
 * slots a word's manifest declares: immediately before or after the block
 * (GRAMMAR §8 writes `slot after ./custom/Ticker.tsx` in a hero). Universal,
 * so no word needs per-slot code to host one.
 */
export const INJECTION_POINTS: readonly string[] = ['before', 'after'];

/** File types an escape-hatch component may be (PRD §6.6). */
export const COMPONENT_EXT: readonly string[] = ['.tsx', '.ts', '.jsx', '.js'];

/**
 * PRD §6.1a: `site width` — the frame every section aligns to. The value
 * names a choice, never a number; the target maps each to a theme token.
 */
export const SITE_WIDTHS: Readonly<Record<string, string>> = {
  full: 'Edge to edge; only the gutters inset the content',
  wide: 'Theme container plus both gutters; wider than default',
  default: 'The theme container, the usual frame (default)',
  narrow: 'Tablet-wide frame (breakpoint md) for a quiet page',
  reading: 'One text column at the body measure',
};

/**
 * The families a `font` role may name — theme-spec §8.1. Generic CSS
 * families only, so no face is downloaded and the build stays offline; the
 * theme package maps each to its stack (FONT_STACKS). Closed: an unknown
 * family would otherwise compile and silently keep the theme's face.
 */
export const FONT_FAMILIES: Readonly<Record<string, string>> = {
  sans: 'Sans-serif system face',
  serif: 'Serif system face',
  mono: 'Monospaced system face',
  rounded: 'Rounded system face; plain sans where unavailable',
};

/**
 * The themes a site may name — theme-spec §5. Core cannot import the theme
 * package (ARCHITECTURE §2), so the names live here and
 * theme/test/accent.test.ts keeps them equal to THEMES.
 */
export const THEME_NAMES: Readonly<Record<string, string>> = {
  midnight: 'Dark-native, near-black ground, one electric accent',
  paper: 'Light editorial: warm paper, ink type, oxblood accent',
  signal: 'High-contrast industrial: square edges, orange accent',
  clay: 'Warm and crafted: cream ground, serif type, terracotta',
  petal: 'Soft and friendly: lavender ground, rounded type, violet',
  volt: 'Loud and graphic: black on white, heavy type, hot magenta',
};

/** `theme accent` hues — PRD §6.1a; equal to the theme package's ACCENT_RAMPS. */
export const ACCENT_HUES: Readonly<Record<string, string>> = {
  violet: 'Violet accent ramp, contrast-checked in both schemes',
  indigo: 'Indigo accent ramp, contrast-checked in both schemes',
  blue: 'Blue accent ramp, contrast-checked in both schemes',
  teal: 'Teal accent ramp, contrast-checked in both schemes',
  green: 'Green accent ramp, contrast-checked in both schemes',
  lime: 'Lime accent ramp, contrast-checked in both schemes',
  amber: 'Amber accent ramp, contrast-checked in both schemes',
  orange: 'Orange accent ramp, contrast-checked in both schemes',
  rose: 'Rose accent ramp, contrast-checked in both schemes',
};

/** `theme pattern` shapes — PRD §6.1a; equal to the theme package's PATTERN_SHAPES. */
export const PATTERN_SHAPE_NAMES: Readonly<Record<string, string>> = {
  none: 'No background pattern',
  glow: 'Accent light blooming from one edge',
  spotlight: 'A soft circle of accent light at the origin',
  ramp: 'Directional accent fade away from the origin',
  grid: 'Perpendicular accent hairlines',
  hatch: 'Diagonal accent hairlines',
  dots: 'Accent dot lattice',
};

/** Where a pattern's light sits; equal to the theme package's PATTERN_ORIGINS. */
export const PATTERN_ORIGIN_NAMES: Readonly<Record<string, string>> = {
  top: 'Light from the top edge (the default)',
  bottom: 'Light from the bottom edge',
  left: 'Light from the left edge',
  right: 'Light from the right edge',
  center: 'Light from the centre',
};

/**
 * `description` — the meta description a search result shows under the
 * page's title, written by the author at site level (every page's default)
 * or per page. Results cut longer copy, so past this length it is advice
 * (AZ1409), like every text limit, never a block (CONVENTIONS §5).
 */
export const META_DESCRIPTION_MAX = 160;

/** Properties those keywords accept — PRD §6.1a. */
export const STRUCTURE_PROPS: Record<string, ReadonlySet<string>> = {
  site: new Set(['width', 'theme', 'font', 'description', 'icon']),
  page: new Set(['description']),
  theme: new Set(['accent', 'pattern']),
  font: new Set(['display', 'body', 'mono']),
};

export interface LinkedWord {
  readonly word: string;
  readonly variant: string | null;
  readonly modifiers: string[];
  /**
   * The raw arguments, kept verbatim.
   *
   * Structure keywords (`site aurora`, `theme midnight`, `page /`) have no
   * manifest, so nothing matches their arguments against variants or
   * modifiers — without this they were silently DROPPED and every site
   * compiled to the same nameless Spec.
   */
  readonly args: Arg[];
  readonly props: Record<string, Arg>;
  readonly as: string | null;
  readonly children: LinkedWord[];
  readonly pos: Pos;
}

export interface LinkResult {
  readonly root: LinkedWord[];
  readonly diagnostics: Diagnostic[];
}

/**
 * A slot definition, viewed as the manifest its children resolve against.
 *
 * `slots` is typed `Record<string, unknown>` because a slot def carries
 * `min`/`max` alongside the same `props`/`slots` a word has. This narrows it
 * in ONE place so the cast is not repeated at every use site.
 */
function slotManifest(name: string, def: unknown): Manifest {
  const d = (def ?? {}) as { props?: Record<string, PropSpec>; slots?: Record<string, unknown> };
  return { name, props: d.props, slots: d.slots };
}

/** A slot's declared bounds. */
function slotBounds(def: unknown): { min?: number; max?: number } {
  const d = (def ?? {}) as { min?: unknown; max?: unknown };
  return {
    min: typeof d.min === 'number' ? d.min : undefined,
    max: typeof d.max === 'number' ? d.max : undefined,
  };
}

/**
 * Is one of this slot's bounds owned by the word's own checks?
 *
 * An unconditional `count` on exactly this slot that fires from zero upward
 * owns the minimum; one open-ended above owns the maximum. Its message is the
 * spec's, and its severity may be the spec's warning where the manifest's
 * bound would have been an error — faq-spec §9 warns at 13 questions.
 */
const countOwned = (m: Manifest | undefined, slot: string, bound: 'min' | 'max') =>
  (m?.checks ?? []).some((c) =>
    c.kind === 'count' && !c.when && !c.prop && c.slots?.length === 1 && c.slots[0] === slot &&
    (bound === 'min' ? (c.atLeast ?? 0) === 0 : c.atMost === undefined));

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

const isProp = (s: Statement, m: Manifest | undefined) =>
  m?.props ? Object.prototype.hasOwnProperty.call(m.props, s.word) : false;

/**
 * A `list` prop's items, in the Spec's serialisation.
 *
 * Comma-joined because that is what a manifest default already becomes when
 * spec.ts writes `String(["password", "link"])` — one format whether the
 * author wrote the list or the manifest supplied it.
 */
export const LIST_SEPARATOR = ',';

/**
 * AZ1404 — GRAMMAR §4.3: a destination uses a route, an anchor, a path or one
 * of the listed schemes, nothing else. Every `scheme:` token in the file is
 * checked, wherever it sits; so is a quoted value in a destination position
 * (any argument after a fill's label), which becomes an `href` — there a
 * scheme that runs code is refused whatever the word. A link that runs script
 * or opens an unlisted protocol is never compiled.
 */
function destinations(body: Statement[], err: (code: string, message: string, pos: Pos) => void): void {
  const refuse = (word: string, scheme: string, pos: Pos) => err('AZ1404',
    `${word}: '${scheme}:' is not a supported destination — use a route, an anchor, or `
    + `${DESTINATION_SCHEMES.filter((k) => !k.startsWith('http')).join('/')}`, pos);
  const walk = (s: Statement) => {
    s.args.forEach((a, index) => {
      if (a.kind === 'pair') {
        const scheme = a.value.slice(0, a.value.indexOf(':')).toLowerCase();
        if (!DESTINATION_SCHEMES.includes(scheme)) refuse(s.word, scheme, a.pos);
      } else if (a.kind === 'string' && index >= 1 && isScriptUrl(a.value)) {
        refuse(s.word, schemeOf(a.value) ?? '', a.pos);
      }
    });
    s.children.forEach(walk);
  };
  body.forEach(walk);
}

export function link(file: AzFile, manifests: Map<string, Manifest>): LinkResult {
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, pos: Pos) =>
    diagnostics.push({ code, message, pos, severity: 'error' });
  const warn = (code: string, message: string, pos: Pos) =>
    diagnostics.push({ code, message, pos, severity: 'warning' });

  // Every page the file declares, so a `route` prop can be checked against
  // the site rather than only its shape. Top-level only: GRAMMAR §5 puts
  // `page` at file level and nowhere else.
  const routes = new Set(
    file.body.filter((s) => s.word === 'page').map((s) => routePath(s.args[0]?.value ?? '/')));

  /**
   * The checks that depend only on a prop's own value and its declaration.
   *
   * One function for a block's props and a slot fill's: a slot fill's props
   * were never checked at all, so `item … media ../../x` and `focus sideways`
   * passed the link stage that a block's would not.
   */
  function checkValues(word: string, props: Record<string, Arg>, specs: Record<string, PropSpec> | undefined) {
    // ---- path sandboxing, VERIFICATION §5 --------------------------------
    //
    // A core invariant, not a target concern: `model ../../../etc/passwd` must
    // not resolve, and enforcing it HERE means every target inherits it rather
    // than each one remembering. Pure string logic, because core cannot import
    // node:path (ARCHITECTURE §1a).
    // Any value WRITTEN as a path is sandboxed, not only `path`-typed props:
    // text's `body` is `markdown` and takes a file (text-spec §11).
    for (const [key, arg] of Object.entries(props)) {
      if (specs?.[key]?.type !== 'path' && arg.kind !== 'path') continue;
      const cleaned = arg.value.replace(/\\/g, '/');
      if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith('/')) {
        err('AZ1210',
            `${word}: '${arg.value}' is an absolute path — assets must live inside the project`,
            arg.pos);
        continue;
      }
      let depth = 0;
      let escapes = false;
      for (const seg of cleaned.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { if (depth === 0) { escapes = true; break; } depth--; }
        else depth++;
      }
      if (escapes) {
        err('AZ1210',
            `${word}: '${arg.value}' points outside the project — assets must live inside it`,
            arg.pos);
      }
    }

    // ---- enum values must be known words ---------------------------------
    for (const [key, arg] of Object.entries(props)) {
      const spec = specs?.[key];
      if (spec?.type !== 'enum' || !spec.values) continue;

      if (Array.isArray(spec.values)) {
        const available = spec.values.filter((v) => !spec.deferred?.includes(v));
        if (spec.deferred?.includes(arg.value)) {
          // Declared vocabulary that is not built yet: named and refused, not
          // compiled into something that silently does nothing (AZ1214).
          err('AZ1214',
              `${word}: ${key} '${arg.value}' is not available yet — use: ${available.join(', ')}`,
              arg.pos);
        } else if (!spec.values.includes(arg.value)) {
          err('AZ1208',
              `${word}: '${shown(arg.value)}' is not a ${key} — try: ${available.join(', ')}`,
              arg.pos);
        }
        continue;
      }

      const set = NAMED_VALUE_SETS[spec.values];
      if (!set) {
        // The manifest names a set the compiler does not know. That is a bug
        // in the manifest, and it is reported as one instead of crashing.
        err('AZ1212',
            `${word}: ${key} names an unknown value set '${spec.values}' — `
            + `known sets: ${Object.keys(NAMED_VALUE_SETS).join(', ')}`,
            arg.pos);
        continue;
      }
      if (!set.test(arg.value)) {
        err('AZ1208', `${word}: '${arg.value}' is not a ${key} — expected ${set.describe}`,
            arg.pos);
      }
    }

    // ---- int ranges: `columns 5` where 2–4 is declared ------------------
    for (const [key, arg] of Object.entries(props)) {
      const spec = specs?.[key];
      if (spec?.type !== 'int') continue;
      if (!/^-?\d+$/.test(arg.value)) {
        err('AZ1407', `${word}: '${arg.value}' is not a whole number — ${key} takes one`, arg.pos);
        continue;
      }
      const n = Number(arg.value);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        err('AZ1408',
            `${word}: '${key} ${arg.value}' is out of range — use ${spec.min ?? '…'} to ${spec.max ?? '…'}`,
            arg.pos);
      }
    }

    // ---- file types: `ext` is declared for path props ---------------------
    // Checked on anything written as a path, so a `markdown` prop given a
    // file (`body ./about.txt`) is typed like a `path` prop.
    for (const [key, arg] of Object.entries(props)) {
      const ext = specs?.[key]?.ext;
      if (!ext || arg.kind !== 'path') continue;
      const lower = arg.value.toLowerCase();
      if (ext.some((e) => lower.endsWith(e))) continue;
      const file = arg.value.split('/').pop() ?? arg.value;
      err('AZ1410', `${word}: '${file}' is not a ${key} file — use ${ext.join(', ')}`, arg.pos);
    }

    // ---- word limits: advice, never a block (CONVENTIONS §5) --------------
    for (const [key, arg] of Object.entries(props)) {
      const max = specs?.[key]?.maxWords;
      if (max === undefined || arg.kind !== 'string') continue;
      const n = wordCount(arg.value);
      if (n > max) {
        warn('AZ1409', `${word}: ${key} is ${n} words, ${max} is the limit — shorten it`, arg.pos);
      }
    }
  }

  /**
   * Slot fills above a slot's max or below its min. `filled` is a slot whose
   * fills come from `from` at runtime: how many there will be is not known
   * here (data-spec §10.2), so its bounds are not checked.
   */
  function checkSlotBounds(
    word: string, m: Manifest | undefined, children: LinkedWord[], pos: Pos, filled: string | null = null,
  ) {
    for (const [slot, def] of Object.entries(m?.slots ?? {})) {
      if (slot === filled) continue;
      const { min, max } = slotBounds(def);
      const used = children.filter((c) => c.word === slot).length;
      if (max !== undefined && used > max && !countOwned(m, slot, 'max')) {
        err('AZ1209', `${word}: ${used} ${slot}s, maximum is ${max} — remove ${used - max}`, pos);
      }
      if (min !== undefined && used < min && !countOwned(m, slot, 'min')) {
        err('AZ1216', `${word}: ${used} ${slot}s, minimum is ${min} — add ${min - used}`, pos);
      }
    }
  }

  /**
   * Resolve one statement.
   *
   * `parent` is the manifest of the enclosing word, so a statement can be
   * recognised as that word's PROPERTY rather than as an unknown word — the
   * same token shape means different things by position (GRAMMAR §3.1).
   */
  /**
   * The escape hatch — `raw <path>` and `slot <name> <path>` (PRD §6.6).
   *
   * GRAMMAR §3.3: `raw` is legal in a page body and inside a block; `slot`
   * inside a block, naming one of that block's slots or an injection point.
   * The path is sandboxed and typed like any path value, so user code is
   * named only from inside the project and only as a component module.
   */
  function escapeHatch(s: Statement, parent: Manifest | undefined, parentWord: string | null): LinkedWord | null {
    // Directly inside a block word — not a slot fill, whose manifest is
    // synthesised from its parent's `slots` entry.
    const inBlock = parentWord !== null && parent !== undefined && manifests.get(parentWord) === parent;
    if (s.word === 'raw' ? !(inBlock || parentWord === 'page') : !inBlock) {
      err('AZ1217', s.word === 'raw'
        ? `raw: only inside a page or a block — move it under the page it belongs to`
        : `slot: only directly inside a block — put it under the block it fills`, s.pos);
      return null;
    }
    const arity = s.word === 'raw' ? 1 : 2;
    const path = s.args[arity - 1];
    if (s.args.length !== arity || path.kind !== 'path' || s.children.length > 0) {
      err('AZ1219', s.word === 'raw'
        ? 'raw: write it as raw ./custom/Component.tsx'
        : 'slot: write it as slot <name> ./custom/Component.tsx', s.pos);
      return null;
    }
    if (s.word === 'slot') {
      const name = s.args[0];
      const names = [...INJECTION_POINTS, ...Object.keys(parent?.slots ?? {})];
      if (name.kind !== 'word' || !names.includes(name.value)) {
        err('AZ1218', `slot: '${name.value}' is not a slot of ${parentWord} — try: ${names.join(', ')}`, name.pos);
        return null;
      }
    }
    checkValues(s.word, { component: path }, { component: { type: 'path', ext: [...COMPONENT_EXT] } });
    return { word: s.word, variant: null, modifiers: [], args: s.args, props: {}, as: s.as,
             children: [], pos: s.pos };
  }

  /**
   * `backend` (backend-spec §2): site-level, and only closed choices. A value
   * outside them is refused rather than carried — and one that looks like a
   * connection string is told where such a thing belongs, because the
   * mistake it prevents is a password committed in a `.az` file.
   */
  function backendDecl(s: Statement, parentWord: string | null): LinkedWord | null {
    if (parentWord !== 'site') {
      err('AZ1223', 'backend: declared outside site — it is site-level, one per site', s.pos);
      return null;
    }
    if (s.args.length > 0) {
      err('AZ1219', 'backend: takes no value — write its settings beneath it', s.args[0].pos);
    }
    const props: Record<string, Arg> = {};
    for (const c of s.children) {
      // Own keys only: `constructor sqlite` must not find Object's constructor.
      const choices = Object.hasOwn(BACKEND_SETTINGS, c.word) ? BACKEND_SETTINGS[c.word] : undefined;
      if (!choices) {
        err('AZ1224', `backend: '${c.word}' is not a backend setting — use: ${Object.keys(BACKEND_SETTINGS).join(', ')}`, c.pos);
        continue;
      }
      const value = c.args[0];
      if (!value || c.args.length !== 1 || c.children.length > 0) {
        err('AZ1205', `backend: '${c.word}' has no value — write: ${c.word} ${choices.join('|')}`, c.pos);
        continue;
      }
      if (value.kind !== 'word' || !choices.includes(value.value)) {
        const secretLike = /[:/@]/.test(value.value);
        err('AZ1412', secretLike
          ? `backend: ${c.word} is a choice, not an address — write ${c.word} ${choices.join('|')}; `
            + 'connection strings and keys go in the backend\'s .env (az backend init)'
          : `backend: ${c.word} '${shown(value.value)}' is not one of: ${choices.join(', ')}`, value.pos);
        continue;
      }
      if (c.word in props) {
        err('AZ1504', `backend: '${c.word}' set twice — keep one`, c.pos);
        continue;
      }
      props[c.word] = value;
    }
    for (const key of Object.keys(BACKEND_SETTINGS)) {
      if (!(key in props) && s.children.every((c) => c.word !== key)) {
        err('AZ1225', `backend: no ${key} — add: ${key} ${BACKEND_SETTINGS[key].join('|')}`, s.pos);
      }
    }
    return { word: 'backend', variant: null, modifiers: [], args: [], props, as: s.as, children: [], pos: s.pos };
  }

  /**
   * `data <table>` (data-spec §4.1): site-level. Its lines are fields and
   * rules, not words — they are kept as written and checked as a whole by
   * the spec stage (data.ts), which sees every table at once (refs, names).
   */
  function dataDecl(s: Statement, parentWord: string | null): LinkedWord | null {
    if (parentWord !== 'site') {
      err('AZ1226', 'data: declared outside site — tables are site-level', s.pos);
      return null;
    }
    const raw = (st: Statement): LinkedWord => ({
      word: st.word, variant: null, modifiers: [], args: st.args, props: {}, as: st.as,
      children: st.children.map(raw), pos: st.pos,
    });
    return raw(s);
  }

  /**
   * `font`'s role lines (GRAMMAR font-decl): each a known role naming a
   * known family, once. Bad lines are reported and dropped; good ones become
   * the children spec.ts reads into `site.fonts`.
   */
  function fontRoles(s: Statement): LinkedWord[] {
    const roles = [...STRUCTURE_PROPS.font];
    const families = Object.keys(FONT_FAMILIES);
    if (s.children.length === 0) {
      err('AZ1205', `font: no roles — write, indented: display ${families.join('|')}`, s.pos);
    }
    const seen = new Set<string>();
    const out: LinkedWord[] = [];
    for (const c of s.children) {
      if (!roles.includes(c.word)) {
        err('AZ1405', `font: '${shown(c.word)}' is not a font role — use ${roles.join(', ')}`, c.pos);
        continue;
      }
      const value = c.args[0];
      if (!value) {
        err('AZ1205', `font: '${c.word}' has no value — write: ${c.word} ${families.join('|')}`, c.pos);
        continue;
      }
      if (!Object.hasOwn(FONT_FAMILIES, value.value)) {
        err('AZ1416', `font: '${shown(value.value)}' is not a family — use ${families.join(', ')}`, value.pos);
        continue;
      }
      if (seen.has(c.word)) {
        warn('AZ1203', `font: '${c.word}' repeated — once is enough`, c.pos);
        continue;
      }
      seen.add(c.word);
      out.push({ word: c.word, variant: null, modifiers: [], args: [value], props: {}, as: null,
                 children: [], pos: c.pos });
    }
    return out;
  }

  /**
   * `theme <name>` and its settings (PRD §6.1a): the name is one of the
   * themes, `accent` a hue, `pattern` a shape with an optional origin. Bad
   * lines are reported and dropped; good ones become the children spec.ts
   * reads. Returning none here once dropped every setting, so `accent` and
   * `pattern` always compiled to the defaults and a typo passed silently.
   */
  function themeSettings(s: Statement): LinkedWord[] {
    const name = s.args[0];
    const themes = Object.keys(THEME_NAMES);
    if (name && !Object.hasOwn(THEME_NAMES, name.value)) {
      err('AZ1417', `theme: '${shown(name.value)}' is not a theme — use ${themes.join(', ')}`, name.pos);
    }
    const settings = [...STRUCTURE_PROPS.theme];
    const seen = new Set<string>();
    const out: LinkedWord[] = [];
    for (const c of s.children) {
      if (!settings.includes(c.word)) {
        err('AZ1405', `theme: '${shown(c.word)}' is not a theme setting — use ${settings.join(', ')}`, c.pos);
        continue;
      }
      const choices = c.word === 'accent' ? ACCENT_HUES : PATTERN_SHAPE_NAMES;
      const value = c.args[0];
      if (!value) {
        err('AZ1205', `theme: '${c.word}' has no value — write: ${c.word} ${Object.keys(choices).join('|')}`, c.pos);
        continue;
      }
      if (c.word === 'accent') {
        const bad = c.args.slice(0, 2).find((a) => !Object.hasOwn(ACCENT_HUES, a.value));
        if (bad) {
          err('AZ1418', `theme: accent '${shown(bad.value)}' is not a hue — use ${Object.keys(ACCENT_HUES).join(', ')}`, bad.pos);
          continue;
        }
        if (c.args.length > 2) {
          err('AZ1406', `theme: 'accent' takes a hue and an optional second hue — remove '${shown(c.args[2].value)}'`, c.args[2].pos);
          continue;
        }
        // theme-spec §13: a pair is offered only where the theme's proof
        // holds along the whole gradient, so the allowed set is per theme.
        // An unknown theme is already AZ1417; its pairs cannot be judged.
        const second = c.args[1];
        const theme = name && Object.hasOwn(ACCENT_PAIRS, name.value) ? name.value : null;
        const partners = theme === null ? null : ACCENT_PAIRS[theme][value.value];
        if (second && partners && !partners.includes(second.value)) {
          err('AZ1423', `theme: accent '${value.value} ${second.value}' is not a pair on ${theme} — `
            + `${value.value} pairs with ${partners.length ? partners.join(', ') : 'no hue'}`, second.pos);
          continue;
        }
      }
      if (c.word === 'pattern') {
        if (!Object.hasOwn(PATTERN_SHAPE_NAMES, value.value)) {
          err('AZ1419', `theme: pattern '${shown(value.value)}' is not a shape — use ${Object.keys(PATTERN_SHAPE_NAMES).join(', ')}`, value.pos);
          continue;
        }
        const origin = c.args[1];
        if (origin && !Object.hasOwn(PATTERN_ORIGIN_NAMES, origin.value)) {
          err('AZ1419', `theme: pattern origin '${shown(origin.value)}' is not one of: ${Object.keys(PATTERN_ORIGIN_NAMES).join(', ')}`, origin.pos);
          continue;
        }
        if (c.args.length > 2) {
          err('AZ1406', `theme: 'pattern' takes a shape and an origin — remove '${shown(c.args[2].value)}'`, c.args[2].pos);
          continue;
        }
      }
      if (seen.has(c.word)) {
        warn('AZ1203', `theme: '${c.word}' repeated — once is enough`, c.pos);
        continue;
      }
      seen.add(c.word);
      out.push({ word: c.word, variant: null, modifiers: [], args: c.args, props: {}, as: null,
                 children: [], pos: c.pos });
    }
    return out;
  }

  /**
   * `description "<text>"` (site or page) and `icon ./<file>` (site): one
   * value on one line. A description is copy, so it is quoted and not empty;
   * an icon is a project file, sandboxed and typed like any path — its
   * content is checked by compile(), which is given the project's reader
   * (AZ1421). Reported problems leave the line out of the Spec.
   */
  function headSetting(s: Statement, parentWord: string): boolean {
    const value = s.args[0];
    const example = s.word === 'icon' ? 'icon ./icon.svg' : 'description "What this page is about"';
    if (!value) {
      err('AZ1205', `${parentWord}: '${s.word}' has no value — write: ${example}`, s.pos);
      return false;
    }
    if (s.args.length > 1) {
      err('AZ1406', `${parentWord}: '${s.word}' takes one value — remove '${shown(s.args[1].value)}'`, s.args[1].pos);
      return false;
    }
    if (s.children.length > 0) {
      err('AZ1219', `${parentWord}: '${s.word}' takes no indented lines — write it on one line: ${example}`, s.children[0].pos);
      return false;
    }
    if (s.word === 'description') {
      if (value.kind !== 'string') {
        err('AZ1205', `${parentWord}: 'description' is a sentence — write it in quotes: description "${shown(value.value)}"`, value.pos);
        return false;
      }
      const text = value.value.replace(/\s+/g, ' ').trim();
      if (text === '') {
        err('AZ1420', `${parentWord}: description is empty — write what the ${parentWord} is about, or remove the line`, value.pos);
        return false;
      }
      const n = [...text].length;
      if (n > META_DESCRIPTION_MAX) {
        warn('AZ1409', `${parentWord}: description is ${n} characters, ${META_DESCRIPTION_MAX} is the limit — search results cut the rest; shorten it`, value.pos);
      }
      return true;
    }
    // `icon`: a file shipped with the site — never a URL, never outside the project.
    if (value.kind !== 'path') {
      err('AZ1402', `${parentWord}: icon '${shown(value.value)}' is not a project file — write: icon ./icon.svg`, value.pos);
      return false;
    }
    const before = diagnostics.length;
    checkValues(parentWord, { icon: value }, {
      icon: { type: 'path', ext: Object.values(ICON_FORMATS).map((f) => f.ext) },
    });
    return diagnostics.length === before;
  }

  function resolve(s: Statement, parent: Manifest | undefined, parentWord: string | null): LinkedWord | null {
    if (s.word === 'backend') return backendDecl(s, parentWord);
    if (s.word === 'data') return dataDecl(s, parentWord);

    // A property of the enclosing word.
    if (isProp(s, parent)) {
      return { word: s.word, variant: null, modifiers: [], args: s.args, props: {}, as: s.as,
               children: [], pos: s.pos };
    }

    // A structure keyword's property, e.g. `width` under `site`.
    if (parentWord && STRUCTURE_PROPS[parentWord]?.has(s.word)) {
      if ((parentWord === 'site' || parentWord === 'page') && (s.word === 'description' || s.word === 'icon')) {
        return headSetting(s, parentWord)
          ? { word: s.word, variant: null, modifiers: [], args: s.args, props: {}, as: s.as, children: [], pos: s.pos }
          : null;
      }
      // `site width` is a closed choice (PRD §6.1a); an unknown frame would
      // otherwise compile and silently render as the default.
      if (parentWord === 'site' && s.word === 'width') {
        const value = s.args[0];
        const choices = Object.keys(SITE_WIDTHS);
        if (!value) err('AZ1205', `site: 'width' has no value — write: width ${choices.join('|')}`, s.pos);
        else if (!Object.hasOwn(SITE_WIDTHS, value.value)) {
          err('AZ1414', `site: width '${shown(value.value)}' is not one of: ${choices.join(', ')}`, value.pos);
        }
      }
      // `font` carries its roles as children (GRAMMAR font-decl); returning
      // none here dropped every role, so `font` never reached the Spec.
      // `theme` carries its settings the same way (PRD §6.1a).
      const children = parentWord !== 'site' ? []
        : s.word === 'font' ? fontRoles(s)
        : s.word === 'theme' ? themeSettings(s)
        : [];
      return { word: s.word, variant: null, modifiers: [], args: s.args, props: {}, as: s.as,
               children, pos: s.pos };
    }

    // A SLOT fill. `hero` declares slots { cta: max 2 }, `footer` declares
    // { link: max 24, ... } — so a `cta` inside a hero is a slot fill, not the
    // cta BLOCK. Slots are the mechanism the specs actually use; `children` is
    // only for nav's nested `group`.
    if (parent?.slots && Object.prototype.hasOwnProperty.call(parent.slots, s.word)) {
      // The slot's OWN definition governs its children, not the enclosing
      // word's. Passing `parent` down here meant `feature.item`'s declared
      // props[title, text, icon, ...] were never consulted, so a `text` under
      // an `item` fell through to the `text` BLOCK and demanded that block's
      // required `body`. The faq spec's own worked example failed to compile
      // on exactly that path (AZ1207 on a line the spec presents as valid).
      const def = slotManifest(s.word, parent.slots[s.word]);
      const props: Record<string, Arg> = {};
      const children: LinkedWord[] = [];
      for (const c of s.children) {
        if (def.props && Object.prototype.hasOwnProperty.call(def.props, c.word)) {
          if (c.args.length > 0) props[c.word] = c.args[0];
          else err('AZ1205', `${s.word}: '${c.word}' has no value — write: ${c.word} <value>`, c.pos);
          continue;
        }
        const linked = resolve(c, def, s.word);
        if (linked) children.push(linked);
      }
      // A fill is checked like a block: pricing's `plan` must have exactly
      // one `cta` (pricing-spec §11), and nothing enforced it.
      checkValues(s.word, props, def.props);
      checkSlotBounds(s.word, def, children, s.pos);
      return { word: s.word, variant: null, modifiers: [], args: s.args, props, as: s.as,
               children, pos: s.pos };
    }

    // POSITION DECIDES, before the manifest map is consulted.
    //
    // `cta` is both a block word AND a child of `nav`. Looking it up in the
    // manifest map first resolved nav's button as the cta BLOCK and demanded
    // the block's required `title`. GRAMMAR §3.3: the same token shape means
    // different things by position, and the enclosing word's `children` list
    // is that position.
    if (parent?.children?.includes(s.word)) {
      return { word: s.word, variant: null, modifiers: [], args: s.args, props: {}, as: s.as,
               children: s.children.map((c) => resolve(c, parent, s.word)).filter(Boolean) as LinkedWord[],
               pos: s.pos };
    }

    if (s.word === 'raw' || s.word === 'slot') return escapeHatch(s, parent, parentWord);

    // GRAMMAR §5.4: the icon is the site's, one per site — not a page's word.
    if (s.word === 'icon' && parentWord === 'page') {
      err('AZ1503', 'icon: declared under a page — move it to site level, one icon per site', s.pos);
      return null;
    }

    // `from` reached here: the enclosing word's manifest takes none (a word
    // that does keeps it in the block's own child loop below).
    if (s.word === 'from' && !manifests.has('from')) {
      err('AZ1201', `${parentWord ?? 'from'}: takes no 'from' — rows load into ${fromWords(manifests).join(', ')}`, s.pos);
      return null;
    }

    const m = manifests.get(s.word);
    const structural = STRUCTURE.has(s.word);

    if (!m && !structural) {
      err('AZ1201', `${s.word}: unknown word — see the word list`, s.pos);
      return null;
    }

    // ---- sort bare arguments into variant / modifiers -------------------
    let variant: string | null = null;
    const modifiers: string[] = [];
    const props: Record<string, Arg> = {};

    for (const a of s.args) {
      if (a.kind !== 'word') continue;
      if (m?.variants?.includes(a.value)) {
        if (variant !== null) {
          // hero-spec §11: two variants must fail loudly, never silently pick.
          err('AZ1202',
              `${s.word}: '${variant}' and '${a.value}' are both layouts — pick one`,
              a.pos);
          continue;
        }
        variant = a.value;
      } else if (m?.modifiers?.includes(a.value)) {
        if (modifiers.includes(a.value)) {
          warn('AZ1203', `${s.word}: '${a.value}' repeated — once is enough`, a.pos);
          continue;
        }
        modifiers.push(a.value);
      } else if (m) {
        const known = [...(m.variants ?? []), ...(m.modifiers ?? [])];
        err('AZ1204',
            `${s.word}: '${shown(a.value)}' is not a variant or modifier — try: ${known.slice(0, 6).join(', ')}`,
            a.pos);
      }
    }

    // ---- children -------------------------------------------------------
    const children: LinkedWord[] = [];
    // A `list` prop keeps every item with its own position, so a bad item is
    // reported where it was written, not at the start of the line.
    const listItems: Record<string, Arg[]> = {};
    // `from <table>` (data-spec §10), kept as written like `data`: the spec
    // stage checks it against the tables, which it alone sees.
    let from: LinkedWord | null = null;
    for (const c of s.children) {
      if (c.word === 'from' && m?.from) {
        if (from) err('AZ1504', `${s.word}: 'from' set twice — keep one`, c.pos);
        else {
          const raw = (st: Statement): LinkedWord => ({
            word: st.word, variant: null, modifiers: [], args: st.args, props: {}, as: st.as,
            children: st.children.map(raw), pos: st.pos,
          });
          from = raw(c);
          children.push(from);
        }
        continue;
      }
      // A child that names a prop of THIS word carries its value.
      if (m?.props && Object.prototype.hasOwnProperty.call(m.props, c.word)) {
        if (c.args.length > 0 && m.props[c.word].type === 'list') {
          // `methods password link` is ONE prop with two items. Taking only
          // the first argument, as a scalar prop does, silently dropped `link`.
          listItems[c.word] = c.args;
          props[c.word] = {
            ...c.args[0],
            value: c.args.map((a) => a.value).join(LIST_SEPARATOR),
          };
        } else if (c.args.length > 0) props[c.word] = c.args[0];
        else {
          err('AZ1205', `${s.word}: '${c.word}' has no value — write: ${c.word} <value>`, c.pos);
        }
        continue;
      }
      const linked = resolve(c, m, s.word);
      if (linked) children.push(linked);
    }

    // ---- data in the block: rows replace the slot's fills (data-spec §10.2)
    const filled = from && m?.from ? m.from.slot : null;
    if (filled && children.some((c) => c.word === filled)) {
      err('AZ1263', `${s.word}: has ${filled}s and 'from' — use one`, from!.pos);
    }

    // ---- slot limits, ARCHITECTURE §4.1 ---------------------------------
    checkSlotBounds(s.word, m, children, s.pos, filled);

    // ---- requires, ARCHITECTURE §4.1 ------------------------------------
    for (const [trigger, needed] of Object.entries(m?.requires ?? {})) {
      const active = variant === trigger || modifiers.includes(trigger);
      if (!active) continue;
      for (const need of needed) {
        // A requirement may name a PROP (`3d` needs `model`), another
        // MODIFIER/VARIANT (`scroll` needs `3d`), or a SLOT FILL (`columns`
        // needs `group`). Checking only props reported `hero center 3d scroll`
        // as missing `3d` while `3d` was right there; adding the slot case
        // fixed the footer spec's own example, which declares two groups and
        // was still told to "add: group <value>".
        const satisfied =
          need in props || modifiers.includes(need) || variant === need ||
          children.some((c) => c.word === need);
        if (satisfied) continue;
        const isWordish = m?.modifiers?.includes(need) || m?.variants?.includes(need);
        err('AZ1206',
            isWordish
              ? `${s.word}: '${trigger}' needs '${need}' — add it: ${s.word} ${need} ${trigger}`
              : `${s.word}: '${trigger}' needs ${need} — add: ${need} <value>`,
            s.pos);
      }
    }

    for (const [trigger, wanted] of Object.entries(m?.recommends ?? {})) {
      if (!(variant === trigger || modifiers.includes(trigger))) continue;
      for (const need of wanted) {
        const satisfied =
          need in props || modifiers.includes(need) || variant === need ||
          children.some((c) => c.word === need);
        if (satisfied) continue;
        warn('AZ1211',
             `${s.word}: '${trigger}' works better with ${need} — add: ${need} <value>`,
             s.pos);
      }
    }

    // ---- requirements keyed on a prop's value ----------------------------
    //
    // The same unmet-requirement error as `requires` (AZ1206), because to the
    // author it is the same thing: this choice needs that. It is reported at
    // the value that triggered it, which is the line the author must look at.
    for (const [prop, byValue] of Object.entries(m?.requiresWhen ?? {})) {
      const trigger = props[prop];
      if (!trigger) continue;
      const needed = Object.hasOwn(byValue, trigger.value) ? byValue[trigger.value] : undefined;
      if (!needed) continue;
      for (const need of needed) {
        if (need in props) continue;
        err('AZ1206',
            `${s.word}: ${prop} '${trigger.value}' needs ${need} — add: ${need} <value>`,
            trigger.pos);
      }
    }

    // ---- site-scoped props belong at site level --------------------------
    //
    // Without this, "one adapter per site" (auth-spec §2) was documentation
    // only: nothing stopped two pages declaring two different auth backends.
    // GRAMMAR §8's example was doing exactly that, block-level, and disagreed
    // with auth's own spec until both were made to say the same thing.
    for (const [key, arg] of Object.entries(props)) {
      if (m?.props?.[key]?.scope !== 'site') continue;
      if (parentWord === 'site') continue;
      err('AZ1304',
          `${s.word}: '${key}' is declared once for the whole site — `
          + `move it to: site <name> / ${s.word} / ${key} ${arg.value}`,
          arg.pos);
    }

    // ---- required props --------------------------------------------------
    for (const [key, spec] of Object.entries(m?.props ?? {})) {
      // A site-scoped prop is declared once for the file, so its absence HERE
      // is not an error — spec.ts checks the file as a whole.
      if (spec.scope === 'site') continue;
      if (spec.required && !(key in props)) {
        err('AZ1207', `${s.word}: '${key}' is required — add: ${key} <value>`, s.pos);
      }
    }

    checkValues(s.word, props, m?.props);

    // ---- list items must be known, available, unique and few enough -----
    for (const [key, items] of Object.entries(listItems)) {
      const spec = m?.props?.[key];
      if (!spec) continue;
      const allowed = Array.isArray(spec.values) ? spec.values : null;
      const available = allowed?.filter((v) => !spec.deferred?.includes(v)) ?? [];
      const seen = new Set<string>();
      for (const item of items) {
        if (seen.has(item.value)) {
          warn('AZ1203', `${s.word}: '${item.value}' repeated — once is enough`, item.pos);
          continue;
        }
        seen.add(item.value);
        if (spec.deferred?.includes(item.value)) {
          err('AZ1214',
              `${s.word}: ${key} '${item.value}' is not available yet — use: ${available.join(', ')}`,
              item.pos);
        } else if (allowed && !allowed.includes(item.value)) {
          err('AZ1208',
              `${s.word}: '${item.value}' is not a ${key} — try: ${available.join(', ')}`,
              item.pos);
        }
      }
      if (typeof spec.max === 'number' && seen.size > spec.max) {
        err('AZ1213',
            `${s.word}: ${seen.size} ${key}, maximum is ${spec.max} — remove ${seen.size - spec.max}`,
            items[0].pos);
      }
    }

    // ---- a route must be a page of this site ----------------------------
    //
    // auth-spec §11: a redirect to an undeclared page is an error. It holds
    // for every `route` prop, not only auth's: a route the site does not have
    // is a dead link the compiler can see, whichever word carries it. A list
    // of routes (auth's `protect`) is checked item by item.
    const routeArgs = (key: string): Arg[] => {
      const spec = m?.props?.[key];
      if (spec?.type === 'route') return props[key] ? [props[key]] : [];
      if (spec?.type === 'list' && spec.of === 'route') return listItems[key] ?? [];
      return [];
    };
    for (const key of Object.keys(props)) {
      for (const arg of routeArgs(key)) {
        if (arg.kind === 'route' && routes.has(routePath(arg.value))) continue;
        err('AZ1215',
            `${s.word}: '${arg.value}' is not a page in this site — add it or fix the ${key}`,
            arg.pos);
      }
    }

    // ---- the word's own validation table (checks.ts) --------------------
    if (m?.checks?.length) {
      const values = (p: Record<string, Arg>) =>
        Object.fromEntries(Object.entries(p).map(([k, a]) => [k, a.value]));
      const fills: CheckChild[] = children.map((c) => ({
        word: c.word, args: c.args, props: values(c.props), pos: c.pos,
      }));
      runBlockChecks(m.checks, {
        word: s.word,
        variant: variant ?? m.variants?.[0] ?? null,
        variantWritten: variant !== null,
        modifiers,
        props: values(props),
        propKinds: Object.fromEntries(Object.entries(props).map(([k, a]) => [k, a.kind])),
        children: fills,
        inPage: parentWord === 'page',
        pos: s.pos,
        filled,
      }, routes, (d) => diagnostics.push(d));
    }

    return { word: s.word, variant, modifiers, args: s.args, props, as: s.as, children, pos: s.pos };
  }

  destinations(file.body, err);

  const root: LinkedWord[] = [];
  for (const s of file.body) {
    const linked = resolve(s, undefined, null);
    if (linked) root.push(linked);
  }
  checkActions(root, err, warn);
  return { root, diagnostics };
}

/**
 * Actions — buttons-and-sections-spec §1. A block's `cta`/`alt` fills are
 * its actions; a page's `cta` is a BLOCK, not an action, so structure words
 * are never treated as sections here.
 */
function checkActions(
  words: readonly LinkedWord[],
  err: (code: string, message: string, pos: Pos) => void,
  warn: (code: string, message: string, pos: Pos) => void,
): void {
  for (const w of words) {
    const fills = STRUCTURE.has(w.word) ? [] : w.children.filter((c) => ACTION_WORDS.has(c.word));
    let ctaIndex = 0;
    const primaries: LinkedWord[] = [];
    for (const f of fills) {
      if (f.as !== null && !isHierarchy(f.as)) {
        err('AZ1220', `${f.word}: 'as ${f.as}' is not a button weight — use: ${HIERARCHIES.join(', ')}`, f.pos);
      }
      if (defaultHierarchy(f, f.word === 'cta' ? ctaIndex++ : -1) === 'primary') primaries.push(f);
      // `video:` and `copy:` have their behaviour. `popup:#id` names declared
      // overlay content, which is Phase 1.5 grammar (GRAMMAR §5), so that
      // button still has nothing to open.
      if (intentOf(f.args[1]) === 'play' && f.args[1].value.toLowerCase().startsWith('popup:')) {
        warn('AZ1222', `${f.word}: '${f.args[1].value}' opens declared popup content, which is not built yet — `
          + "it renders as a button that does nothing; use 'video:' for a film", f.args[1].pos);
      }
    }
    if (primaries.length > 1) {
      warn('AZ1221', `${w.word}: ${primaries.length} primary buttons in one section — buttons §1.2 allows one; `
        + "make the rest 'as secondary'", primaries[1].pos);
    }
    checkActions(w.children, err, warn);
  }
}
