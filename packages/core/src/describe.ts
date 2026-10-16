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
import { partnersOf } from './colour.ts';
import { CHAT_WORD, SHOW_GROUPS } from './chat.ts';
import { closest } from './suggest.ts';

/** The owner's limit: short enough for an AI to read every one cheaply. */
export const DESCRIPTION_MAX = 60;

interface TermInfo {
  readonly description: string;
  /** Settings the keyword takes, and what each is. */
  readonly settings?: Readonly<Record<string, string>>;
  /** Closed choices per setting, where the compiler knows them. */
  readonly values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Lines explaining a setting also prints, one per entry: `theme accent` lists its pairs. */
  readonly lists?: Readonly<Record<string, { readonly kind: string; readonly lines: Readonly<Record<string, string>> }>>;
  /**
   * Lines the keyword prints when it is the last term asked about, one per
   * entry; each entry is also a term after it. `theme` lists the themes.
   */
  readonly entries?: { readonly kind: string; readonly lines: Readonly<Record<string, string>> };
}

/**
 * One line per hue naming the hues it pairs with (theme-spec §13). The table
 * is per theme: a partner every theme allows is named plainly, one only some
 * allow is named with the themes that refuse it.
 */
function pairLines(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const hue of Object.keys(ACCENT_HUES)) {
    const parts = partnersOf(hue);
    out[hue] = parts.length ? `Pairs with ${parts.join(', ')}` : 'Pairs with no hue';
  }
  return out;
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
      theme: 'Theme name, e.g. midnight, paper, clay or volt',
      font: 'Font roles for display, body and mono text',
      description: 'Search-result text for every page; quoted, ≤160 chars',
      icon: 'Site icon, .svg or .png; square PNG ≥180×180 adds touch icon',
    },
    values: { width: SITE_WIDTHS, theme: THEME_NAMES },
  },
  theme: {
    description: 'Theme choice and its tuning (under site)',
    settings: {
      accent: 'Hue ramp for the accent; a second hue makes a gradient',
      pattern: 'Background pattern and its origin',
    },
    // A pattern line is `pattern <shape> [origin]`: both are its values.
    values: { accent: ACCENT_HUES, pattern: { ...PATTERN_SHAPE_NAMES, ...PATTERN_ORIGIN_NAMES } },
    lists: { accent: { kind: 'pairs', lines: pairLines() } },
    entries: { kind: 'theme', lines: THEME_NAMES },
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
    description: 'Built-in server: database, email and model choices',
    settings: {
      database: 'Database engine the server uses',
      email: 'How the server sends email; only a site with accounts',
      model: 'The server talks to a model for chat (optional)',
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
      model: {
        default: 'The operator picks it in the server .env',
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

  const startScope = (term: string, last: boolean): boolean => {
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
      const entries = last ? k.entries : undefined;
      if (entries) {
        for (const [entry, text] of Object.entries(entries.lines)) lines.push({ term: entry, kind: entries.kind, of: term, text });
      }
      return true;
    }
    return false;
  };

  for (const [i, term] of terms.entries()) {
    const s = scope as Scope | null;
    if (s) {
      const found = resolve(s, term);
      if (found) {
        lines.push(found.line);
        // A `show` group (chat-block-spec §19.15) lists what it expands to, one component a line.
        const group = found.line.kind === 'value' && s.lastProp?.path === SHOW_PATH ? own(SHOW_GROUPS, term) : undefined;
        for (const member of group ?? []) {
          lines.push({ term: member, kind: 'component', of: `${SHOW_PATH}.${term}`, text: own(s.lastProp?.values, member) ?? '' });
        }
        const list = s.keyword && found.line.kind === 'setting' ? own(s.keyword.lists, term) : undefined;
        if (list) {
          for (const [entry, text] of Object.entries(list.lines)) {
            lines.push({ term: entry, kind: list.kind, of: `${s.name}.${term}`, text });
          }
        }
        if (found.next) scope = found.next;
        continue;
      }
    }
    if (startScope(term, i === terms.length - 1)) continue;
    // A prop only one word has may be named alone: `az explain show all` is the chat's `show`.
    const owner = !s ? soleOwner(term, manifests) : null;
    if (owner) {
      const found = resolve({ name: owner.name, manifest: owner.manifest }, term);
      if (found) {
        lines.push(found.line);
        if (found.next) scope = found.next;
        continue;
      }
    }
    const candidates = new Set<string>([...manifests.keys(), ...Object.keys(STRUCTURE_DESCRIPTIONS)]);
    if (s) for (const c of membersOf(s)) candidates.add(c);
    unknown.push({ term, suggestion: closest(term, candidates) });
  }
  return { lines, unknown };
}

/** The chat's `show`, whose groups explain() expands. */
const SHOW_PATH = `${CHAT_WORD}.show`;

/** The one word that declares prop `term`, or null when none or several do. */
function soleOwner(term: string, manifests: ReadonlyMap<string, Manifest>): { name: string; manifest: Manifest } | null {
  const owners = [...manifests].filter(([, m]) => Object.hasOwn(m.props ?? {}, term));
  return owners.length === 1 ? { name: owners[0][0], manifest: owners[0][1] } : null;
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
    ...Object.keys(s.keyword?.entries?.lines ?? {}),
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
    const entries = s.keyword.entries;
    const entry = own(entries?.lines, term);
    if (entries && entry !== undefined) return { line: { term, kind: entries.kind, of: s.name, text: entry }, next: keep };
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
