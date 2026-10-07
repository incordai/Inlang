/**
 * @az module describe
 * Purpose: one-line (≤60 char) meaning of every .az term; explain() resolves terms in context.
 * Spec: docs/GRAMMAR.md §2–§5 · each word.json
 * Exports: explain, formatExplained, STRUCTURE_DESCRIPTIONS, DESCRIPTION_MAX
 * Edit guide: a new structure keyword or setting needs a row here; block terms live in word.json.
 * Tests: packages/core/test/describe.test.ts, packages/words/test/descriptions.test.ts
 */

import {
  ACCENT_HUES, FONT_FAMILIES, PATTERN_ORIGIN_NAMES, PATTERN_SHAPE_NAMES, SITE_WIDTHS, THEME_NAMES,
  type Manifest, type PropSpec,
} from './link.ts';
import { BACKEND_SETTINGS } from './backend.ts';
import {
  ACTION_DESCRIPTIONS, MODIFIER_DESCRIPTIONS, TYPE_DESCRIPTIONS, WHO_DESCRIPTIONS,
} from './data.ts';
import { FROM_SETTINGS } from './from.ts';
import { closest } from './suggest.ts';

/** The owner's limit: short enough for an AI to read every one cheaply. */
export const DESCRIPTION_MAX = 60;

interface TermInfo {
  readonly description: string;
  /** Settings the keyword takes, and what each is. */
  readonly settings?: Readonly<Record<string, string>>;
  /** Closed choices per setting, where the compiler knows them. */
  readonly values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Structure keywords — no manifest, so their meanings live here. Values are
 * listed only where the compiler holds a closed set (backend choices).
 */
export const STRUCTURE_DESCRIPTIONS: Readonly<Record<string, TermInfo>> = {
  az: { description: 'Grammar version marker; the first line, e.g. az 1' },
  site: {
    description: 'The site: name, frame, theme; shared nav/footer',
    settings: {
      width: 'Width of the frame every section aligns to',
      theme: 'Theme name, e.g. midnight, paper or signal',
      font: 'Font roles for display, body and mono text',
      description: 'Search-result text for every page; quoted, ≤160 chars',
      icon: 'Site icon, .svg or .png; square PNG ≥180×180 adds touch icon',
    },
    values: { width: SITE_WIDTHS, theme: THEME_NAMES },
  },
  theme: {
    description: 'Theme choice and its tuning (under site)',
    settings: {
      accent: 'Hue ramp the theme draws its accent from',
      pattern: 'Background pattern and its origin',
    },
    // A pattern line is `pattern <shape> [origin]`: both are its values.
    values: { accent: ACCENT_HUES, pattern: { ...PATTERN_SHAPE_NAMES, ...PATTERN_ORIGIN_NAMES } },
  },
  font: {
    description: 'Font role assignments (under site)',
    settings: {
      display: 'Family style for headings',
      body: 'Family style for running text',
      mono: 'Family style for code and figures',
    },
    values: { display: FONT_FAMILIES, body: FONT_FAMILIES, mono: FONT_FAMILIES },
  },
  page: {
    description: 'One page of the site; its value is the route',
    settings: { description: "This page's search-result text; overrides site's" },
  },
  raw: { description: 'Mount your own component file in page or block' },
  slot: { description: 'Put your component in a block slot or before/after' },
  data: {
    description: 'A database table and its API: data products',
    // A data line is `<field> <type> <modifiers…>` or `allow <who> <action…>`:
    // the types, modifiers and `allow` are what can follow.
    settings: {
      ...TYPE_DESCRIPTIONS,
      ...MODIFIER_DESCRIPTIONS,
      allow: 'Who may do what: allow anyone read',
    },
    values: { allow: { ...WHO_DESCRIPTIONS, ...ACTION_DESCRIPTIONS } },
  },
  allow: {
    description: 'A data rule: allow <who> <action…>; none = admins',
    settings: { ...WHO_DESCRIPTIONS, ...ACTION_DESCRIPTIONS },
  },
  backend: {
    description: 'Built-in server: database and email choices',
    settings: {
      database: 'Database engine the server uses',
      email: 'How the server sends email',
    },
    values: {
      database: {
        sqlite: 'SQLite file on the server',
        postgres: 'PostgreSQL via AZ_DATABASE_URL',
        mysql: 'MySQL via AZ_DATABASE_URL',
      },
      email: {
        smtp: 'Send through an SMTP server',
        api: 'Send through an HTTPS email API',
      },
    },
  },
};

// Every backend setting the compiler accepts must be described above.
for (const key of Object.keys(BACKEND_SETTINGS)) {
  if (!STRUCTURE_DESCRIPTIONS.backend.settings?.[key]) {
    throw new Error(`describe: backend setting '${key}' has no description`);
  }
}

export interface ExplainedLine {
  /** The term as asked, e.g. `center`. */
  readonly term: string;
  /** What it is: word, variant, modifier, prop, value, slot, child, keyword, setting. */
  readonly kind: string;
  /** Where it belongs, e.g. `hero` or `hero.height`. */
  readonly of: string;
  readonly text: string;
}

export interface Explained {
  readonly lines: ExplainedLine[];
  readonly unknown: { readonly term: string; readonly suggestion: string | null }[];
}

const own = <T>(o: Readonly<Record<string, T>> | undefined, k: string): T | undefined =>
  o && Object.hasOwn(o, k) ? o[k] : undefined;

/** A scope terms resolve in: a word, a slot of a word, or a structure keyword. */
interface Scope {
  readonly name: string;
  readonly manifest?: Manifest;
  readonly slotDef?: { props?: Record<string, PropSpec>; slots?: Record<string, unknown> };
  readonly keyword?: TermInfo;
  /** The last prop or setting named, whose values the next term may be. */
  readonly lastProp?: { readonly path: string; readonly spec?: PropSpec; readonly values?: Readonly<Record<string, string>> };
}

type SlotDef = { description?: string; props?: Record<string, PropSpec>; slots?: Record<string, unknown> };

/**
 * Explain terms in context, the way an author writes them: `hero center`,
 * `hero height peek`, `pricing plan monthly`, `backend database postgres`.
 * A term that names another word or keyword starts a new context, so one call
 * can cover `hero center nav sticky`.
 */
export function explain(terms: readonly string[], manifests: ReadonlyMap<string, Manifest>): Explained {
  const lines: ExplainedLine[] = [];
  const unknown: { term: string; suggestion: string | null }[] = [];
  let scope: Scope | null = null;

  const startScope = (term: string): boolean => {
    const m = manifests.get(term);
    if (m) {
      scope = { name: term, manifest: m };
      lines.push({ term, kind: 'word', of: '', text: m.description ?? '' });
      return true;
    }
    const k = own(STRUCTURE_DESCRIPTIONS, term);
    if (k) {
      scope = { name: term, keyword: k };
      lines.push({ term, kind: 'keyword', of: '', text: k.description });
      return true;
    }
    return false;
  };

  for (const term of terms) {
    const s = scope as Scope | null;
    if (s) {
      const found = resolve(s, term);
      if (found) {
        lines.push(found.line);
        if (found.next) scope = found.next;
        continue;
      }
    }
    if (startScope(term)) continue;
    const candidates = new Set<string>([...manifests.keys(), ...Object.keys(STRUCTURE_DESCRIPTIONS)]);
    if (s) for (const c of membersOf(s)) candidates.add(c);
    unknown.push({ term, suggestion: closest(term, candidates) });
  }
  return { lines, unknown };
}

/** Every term that could follow in this scope. */
function membersOf(s: Scope): string[] {
  const m = s.manifest;
  const d = s.slotDef ?? (m ? { props: m.props, slots: m.slots as Record<string, unknown> | undefined } : undefined);
  return [
    ...(m && !s.slotDef ? [...(m.variants ?? []), ...(m.modifiers ?? []), ...(m.children ?? [])] : []),
    ...(m?.from && !s.slotDef ? ['from'] : []),
    ...Object.keys(d?.props ?? {}),
    ...Object.keys(d?.slots ?? {}),
    ...Object.keys(s.keyword?.settings ?? {}),
    ...Object.keys(s.lastProp?.values ?? {}),
  ];
}

function resolve(s: Scope, term: string): { line: ExplainedLine; next?: Scope } | null {
  // A value of the prop or setting just named: `height peek`.
  const value = own(s.lastProp?.values, term);
  if (value !== undefined) {
    return { line: { term, kind: 'value', of: s.lastProp!.path, text: value } };
  }
  const keep = { ...s, lastProp: undefined };

  if (s.keyword) {
    const setting = own(s.keyword.settings, term);
    if (setting === undefined) return null;
    return {
      line: { term, kind: 'setting', of: s.name, text: setting },
      next: { ...keep, lastProp: { path: `${s.name}.${term}`, values: own(s.keyword.values, term) } },
    };
  }

  const m = s.manifest;
  if (m && !s.slotDef) {
    const variant = own(m.descriptions?.variants, term);
    if (variant !== undefined) return { line: { term, kind: 'variant', of: s.name, text: variant }, next: keep };
    const modifier = own(m.descriptions?.modifiers, term);
    if (modifier !== undefined) return { line: { term, kind: 'modifier', of: s.name, text: modifier }, next: keep };
    const child = own(m.descriptions?.children, term);
    if (child !== undefined) return { line: { term, kind: 'child', of: s.name, text: child }, next: keep };
    // `feature from` (data-spec §10): its lines are the mappings the word
    // declares and the shared settings, explained like a keyword's.
    if (term === 'from' && m.from) {
      const settings: Record<string, string> = { ...FROM_SETTINGS };
      for (const [key, f] of Object.entries(m.from.map)) settings[key] = f.description;
      return {
        line: { term, kind: 'child', of: s.name, text: m.from.description },
        next: { name: `${s.name}.from`, keyword: { description: m.from.description, settings } },
      };
    }
  }

  const props = s.slotDef ? s.slotDef.props : m?.props;
  const prop = own(props, term);
  if (prop) {
    return {
      line: { term, kind: 'prop', of: s.name, text: prop.description ?? '' },
      next: { ...keep, lastProp: { path: `${s.name}.${term}`, spec: prop, values: prop.valueDescriptions } },
    };
  }

  const slots = (s.slotDef ? s.slotDef.slots : m?.slots) as Record<string, unknown> | undefined;
  const slot = own(slots, term) as SlotDef | undefined;
  if (slot) {
    return {
      line: { term, kind: 'slot', of: s.name, text: slot.description ?? '' },
      next: { name: `${s.name}.${term}`, manifest: m, slotDef: slot },
    };
  }
  return null;
}

/** `hero: …` lines, one per explained term — the CLI's and MCP's text form. */
export function formatExplained(e: Explained): string {
  const out = e.lines.map((l) => `${l.of ? `${l.of} ` : ''}${l.term} (${l.kind}): ${l.text}`);
  for (const u of e.unknown) {
    out.push(`${u.term}: unknown${u.suggestion ? ` — did you mean '${u.suggestion}'?` : ''}`);
  }
  return out.join('\n');
}
