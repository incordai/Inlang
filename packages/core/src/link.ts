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

import type { Diagnostic, Pos } from './lex.ts';
import type { Arg, Statement, AzFile } from './parse.ts';

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
  readonly slots?: Record<string, unknown>;
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

const isProp = (s: Statement, m: Manifest | undefined) =>
  m?.props ? Object.prototype.hasOwnProperty.call(m.props, s.word) : false;

export function link(file: AzFile, manifests: Map<string, Manifest>): LinkResult {
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, pos: Pos) =>
    diagnostics.push({ code, message, pos, severity: 'error' });
  const warn = (code: string, message: string, pos: Pos) =>
    diagnostics.push({ code, message, pos, severity: 'warning' });

  /**
   * Resolve one statement.
   *
   * `parent` is the manifest of the enclosing word, so a statement can be
   * recognised as that word's PROPERTY rather than as an unknown word — the
   * same token shape means different things by position (GRAMMAR §3.1).
   */
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
    for (const c of s.children) {
      // A child that names a prop of THIS word carries its value.
      if (m?.props && Object.prototype.hasOwnProperty.call(m.props, c.word)) {
        if (c.args.length > 0) props[c.word] = c.args[0];
        else {
          err('AZ1205', `${s.word}: '${c.word}' has no value — write: ${c.word} <value>`, c.pos);
        }
        continue;
      }
      const linked = resolve(c, m, s.word);
      if (linked) children.push(linked);
    }

    // ---- slot limits, ARCHITECTURE §4.1 ---------------------------------
    for (const [slot, spec] of Object.entries(m?.slots ?? {})) {
      const max = (spec as { max?: number }).max;
      if (typeof max !== 'number') continue;
      const used = children.filter((c) => c.word === slot).length;
      if (used > max) {
        err('AZ1209',
            `${s.word}: ${used} ${slot}s, maximum is ${max} — remove ${used - max}`,
            s.pos);
      }
    }

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

    // ---- path sandboxing, VERIFICATION §5 --------------------------------
    //
    // A core invariant, not a target concern: `model ../../../etc/passwd` must
    // not resolve, and enforcing it HERE means every target inherits it rather
    // than each one remembering. Pure string logic, because core cannot import
    // node:path (ARCHITECTURE §1a).
    for (const [key, arg] of Object.entries(props)) {
      if (m?.props?.[key]?.type !== 'path') continue;
      const cleaned = arg.value.replace(/\\/g, '/');
      if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith('/')) {
        err('AZ1210',
            `${s.word}: '${arg.value}' is an absolute path — assets must live inside the project`,
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
            `${s.word}: '${arg.value}' points outside the project — assets must live inside it`,
            arg.pos);
      }
    }

    // ---- enum values must be known words ---------------------------------
    for (const [key, arg] of Object.entries(props)) {
      const spec = m?.props?.[key];
      if (spec?.type !== 'enum' || !spec.values) continue;

      if (Array.isArray(spec.values)) {
        if (!spec.values.includes(arg.value)) {
          err('AZ1208',
              `${s.word}: '${arg.value}' is not a ${key} — try: ${spec.values.join(', ')}`,
              arg.pos);
        }
        continue;
      }

      const set = NAMED_VALUE_SETS[spec.values];
      if (!set) {
        // The manifest names a set the compiler does not know. That is a bug
        // in the manifest, and it is reported as one instead of crashing.
        err('AZ1212',
            `${s.word}: ${key} names an unknown value set '${spec.values}' — `
            + `known sets: ${Object.keys(NAMED_VALUE_SETS).join(', ')}`,
            arg.pos);
        continue;
      }
      if (!set.test(arg.value)) {
        err('AZ1208', `${s.word}: '${arg.value}' is not a ${key} — expected ${set.describe}`,
            arg.pos);
      }
    }

    return { word: s.word, variant, modifiers, args: s.args, props, as: s.as, children, pos: s.pos };
  }

  const root: LinkedWord[] = [];
  for (const s of file.body) {
    const linked = resolve(s, undefined, null);
    if (linked) root.push(linked);
  }
  return { root, diagnostics };
}
