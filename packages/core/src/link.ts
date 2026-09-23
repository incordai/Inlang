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

import { ACTION_WORDS, defaultHierarchy, intentOf, isHierarchy } from './actions.ts';
import { HIERARCHIES } from './emit-contract.ts';
import type { Diagnostic, Pos } from './lex.ts';
import type { Arg, Statement, AzFile } from './parse.ts';
import { routePath, runBlockChecks, type Check, type CheckChild } from './checks.ts';

export interface PropSpec {
  readonly type: string;
  readonly required?: boolean;
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
  /** `int` props: the smallest value. */
  readonly min?: number;
}

export interface Manifest {
  readonly name: string;
  readonly kind?: string;
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
export const STRUCTURE = new Set(['site', 'theme', 'font', 'page', 'raw', 'slot']);

/**
 * Where `slot <name> <path>` may put a component on EVERY block, beside the
 * slots a word's manifest declares: immediately before or after the block
 * (GRAMMAR §8 writes `slot after ./custom/Ticker.tsx` in a hero). Universal,
 * so no word needs per-slot code to host one.
 */
export const INJECTION_POINTS: readonly string[] = ['before', 'after'];

/** File types an escape-hatch component may be (PRD §6.6). */
export const COMPONENT_EXT: readonly string[] = ['.tsx', '.ts', '.jsx', '.js'];

/** Properties those keywords accept — PRD §6.1a. */
export const STRUCTURE_PROPS: Record<string, ReadonlySet<string>> = {
  site: new Set(['width', 'theme', 'font']),
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
        if (!spec.values.includes(arg.value)) {
          err('AZ1208',
              `${word}: '${arg.value}' is not a ${key} — try: ${spec.values.join(', ')}`,
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

  /** Slot fills above a slot's max or below its min. */
  function checkSlotBounds(
    word: string, m: Manifest | undefined, children: LinkedWord[], pos: Pos,
  ) {
    for (const [slot, def] of Object.entries(m?.slots ?? {})) {
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

  function resolve(s: Statement, parent: Manifest | undefined, parentWord: string | null): LinkedWord | null {
    // A property of the enclosing word.
    if (isProp(s, parent)) {
      return { word: s.word, variant: null, modifiers: [], args: s.args, props: {}, as: s.as,
               children: [], pos: s.pos };
    }

    // A structure keyword's property, e.g. `width` under `site`.
    if (parentWord && STRUCTURE_PROPS[parentWord]?.has(s.word)) {
      return { word: s.word, variant: null, modifiers: [], args: s.args, props: {}, as: s.as,
               children: [], pos: s.pos };
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
            `${s.word}: '${a.value}' is not a variant or modifier — try: ${known.slice(0, 6).join(', ')}`,
            a.pos);
      }
    }

    // ---- children -------------------------------------------------------
    const children: LinkedWord[] = [];
    // A `list` prop keeps every item with its own position, so a bad item is
    // reported where it was written, not at the start of the line.
    const listItems: Record<string, Arg[]> = {};
    for (const c of s.children) {
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

    // ---- slot limits, ARCHITECTURE §4.1 ---------------------------------
    checkSlotBounds(s.word, m, children, s.pos);

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
      const needed = byValue[trigger.value];
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
    // is a dead link the compiler can see, whichever word carries it.
    for (const [key, arg] of Object.entries(props)) {
      if (m?.props?.[key]?.type !== 'route') continue;
      if (routes.has(routePath(arg.value))) continue;
      err('AZ1215',
          `${s.word}: '${arg.value}' is not a page in this site — add it or fix the ${key}`,
          arg.pos);
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
      }, routes, (d) => diagnostics.push(d));
    }

    return { word: s.word, variant, modifiers, args: s.args, props, as: s.as, children, pos: s.pos };
  }

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
