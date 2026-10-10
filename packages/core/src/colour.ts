/**
 * @az module colour
 * Purpose: the colour step (theme, accent, pattern) — the legal values as data, text and JSON, and the .az lines, from the closed tables.
 * Spec: docs/PRD.md §6.1a · docs/theme-spec.md §5, §13, §14
 * Exports: DEFAULT_THEME_NAME, partnersOf, colourChoicesMd, themeLinesAz, ThemeLines, colourLinesAz, patternWords,
 *   ColourTables, COLOUR_TABLES, ColourChoices, ColourTheme, Named, colourChoicesFrom, colourChoices, ColourFilter,
 *   filterColourChoices, formatColourChoices, colourChoicesJson, ColourChoicesJson
 * Edit guide: every value comes from link.ts, accent-pairs.ts or spec.ts — never list a theme, hue, pair or shape here.
 *   The one source of colour choices for AZ.md, docs/WORDS.md, `az explain`, `az palette` and the MCP tool az_palette.
 * Tests: packages/core/test/colour.test.ts, packages/target-web/test/azmd.test.ts, packages/words/test/words-index.test.ts,
 *   packages/cli/test/palette.test.ts, packages/cli/test/palette-cli.test.ts, packages/mcp/test/palette.test.ts
 */

/**
 * Colour is the first step of every site (PRD §6.1a): theme, accent (one hue
 * or an allowed pair) and pattern are chosen before any section is written.
 * The places an AI starts from — the generated AZ.md, docs/WORDS.md,
 * `az palette` and the MCP tool az_palette — lead with that step, and all
 * read the legal values from here, so the lists are the compiler's own
 * tables and cannot drift from them.
 */

import { ACCENT_HUES, PATTERN_ORIGIN_NAMES, PATTERN_SHAPE_NAMES, THEME_NAMES } from './link.ts';
import { ACCENT_PAIRS } from './accent-pairs.ts';
import { SITE_DEFAULTS } from './spec.ts';
import { closest } from './suggest.ts';

/** The theme a site without a `theme` line gets. */
export const DEFAULT_THEME_NAME: string = SITE_DEFAULTS.theme;

const code = (s: string): string => `\`${s}\``;

/**
 * The hues `hue` pairs with across `themes`, in ramp order: a partner every
 * one of them allows is named plainly, one only some allow is named with the
 * themes that refuse it — `teal, amber (not signal/volt)`. Empty when none.
 */
export function partnersOf(hue: string, themes: readonly string[] = Object.keys(ACCENT_PAIRS)): string[] {
  const allows = (t: string, h: string): boolean => ACCENT_PAIRS[t]?.[hue]?.includes(h) ?? false;
  return Object.keys(ACCENT_HUES)
    .filter((h) => themes.some((t) => allows(t, h)))
    .map((h) => {
      const refusing = themes.filter((t) => !allows(t, h));
      return refusing.length ? `${h} (not ${refusing.join('/')})` : h;
    });
}

/**
 * The legal colour values as markdown list lines. With a theme, the pairs
 * are that theme's; with null, every theme's, refusals named.
 */
export function colourChoicesMd(theme: string | null): string[] {
  const themes = theme !== null && Object.hasOwn(ACCENT_PAIRS, theme) ? [theme] : Object.keys(ACCENT_PAIRS);
  const where = themes.length === 1 ? ` on ${code(themes[0])}` : '';
  const origins = Object.keys(PATTERN_ORIGIN_NAMES);
  return [
    `- ${code('theme <name>')}, under ${code('site')}; without it the site gets ${code(DEFAULT_THEME_NAME)}:`,
    ...Object.entries(THEME_NAMES).map(([name, text]) => `  - ${code(name)} — ${text}`),
    `- ${code('accent <hue> [<hue2>]')}, under ${code('theme')}; without it the theme keeps its own accent.`
      + ` Hues: ${Object.keys(ACCENT_HUES).map(code).join(' ')}. A second hue makes a gradient,`
      + ` allowed only with these partners${where}:`,
    ...Object.keys(ACCENT_HUES).map((hue) => {
      const partners = partnersOf(hue, themes);
      return `  - ${code(hue)} with ${partners.length ? partners.join(', ') : 'no hue'}`;
    }),
    `- ${code('pattern <shape> [<origin>]')}, under ${code('theme')}; without it there is none.`
      + ` Origins: ${origins.map(code).join(' ')} (default ${code(SITE_DEFAULTS.patternOrigin)}). Shapes:`,
    ...Object.entries(PATTERN_SHAPE_NAMES).map(([name, text]) => `  - ${code(name)} — ${text}`),
  ];
}

/** What a site's colour lines say now. */
export interface ThemeLines {
  readonly site: string;
  readonly theme: string;
  /** null when the theme keeps its own accent. */
  readonly accent: string | null;
  readonly accent2?: string;
  /** "shape origin", or null when the site has no pattern. */
  readonly pattern: string | null;
}

/**
 * The colour lines as they sit under `site`: the theme line first, its
 * settings indented once more — what a choice is pasted as. GRAMMAR §4.4.
 */
export function colourLinesAz(theme: string, accent: readonly string[] = [], pattern: readonly string[] = []): string[] {
  return [
    `theme ${theme}`,
    ...(accent.length > 0 ? [`  accent ${accent.join(' ')}`] : []),
    ...(pattern.length > 0 ? [`  pattern ${pattern.join(' ')}`] : []),
  ];
}

/** The site's colour lines exactly as the .az file writes them, `site` first. */
export function themeLinesAz(t: ThemeLines): string[] {
  const accent = t.accent ? [t.accent, ...(t.accent2 ? [t.accent2] : [])] : [];
  return [`site ${t.site}`, ...colourLinesAz(t.theme, accent, t.pattern ? [t.pattern] : []).map((l) => `  ${l}`)];
}

/* ---------------- the choices as data: az palette and az_palette ---------------- */

/** The closed tables the choices are read from — the compiler's own in COLOUR_TABLES; a test passes others. */
export interface ColourTables {
  /** Theme → its one-line character (what `az explain theme` prints). */
  readonly themes: Readonly<Record<string, string>>;
  readonly hues: Readonly<Record<string, string>>;
  /** Theme → hue → the hues it pairs with (the generated table, theme-spec §13). */
  readonly pairs: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly shapes: Readonly<Record<string, string>>;
  readonly origins: Readonly<Record<string, string>>;
  readonly defaultOrigin: string;
}

export const COLOUR_TABLES: ColourTables = {
  themes: THEME_NAMES,
  hues: ACCENT_HUES,
  pairs: ACCENT_PAIRS,
  shapes: PATTERN_SHAPE_NAMES,
  origins: PATTERN_ORIGIN_NAMES,
  defaultOrigin: SITE_DEFAULTS.patternOrigin,
};

export interface Named { readonly name: string; readonly description: string }

export interface ColourTheme extends Named {
  /** The hues `accent` takes on this theme. */
  readonly hues: readonly string[];
  /**
   * Allowed pairs, each once: [first, second], first before second in ramp
   * order — or, filtered by a hue, that hue first. Either order holds.
   */
  readonly pairs: readonly (readonly [string, string])[];
}

export interface ColourChoices {
  readonly themes: readonly ColourTheme[];
  readonly hues: readonly Named[];
  readonly patterns: readonly Named[];
  readonly origins: readonly Named[];
  /** The origin a `pattern` line without one gets. */
  readonly defaultOrigin: string;
}

const namedOf = (table: Readonly<Record<string, string>>): Named[] =>
  Object.entries(table).map(([name, description]) => ({ name, description }));

/** Every choice `tables` allow. A theme the pair generator has not seen is refused, not shown without pairs. */
export function colourChoicesFrom(tables: ColourTables): ColourChoices {
  const hues = Object.keys(tables.hues);
  const themes = Object.entries(tables.themes).map(([name, description]): ColourTheme => {
    const table = tables.pairs[name];
    if (!table) throw new Error(`colour: theme '${name}' has no pairs table — run node scripts/gen-pairs.mjs`);
    const pairs = hues.flatMap((first, i) => hues.slice(i + 1)
      .filter((second) => table[first]?.includes(second))
      .map((second) => [first, second] as const));
    return { name, description, hues, pairs };
  });
  return {
    themes,
    hues: namedOf(tables.hues),
    patterns: namedOf(tables.shapes),
    origins: namedOf(tables.origins),
    defaultOrigin: tables.defaultOrigin,
  };
}

/** Every colour choice the compiler accepts. */
export const colourChoices = (): ColourChoices => colourChoicesFrom(COLOUR_TABLES);

export interface ColourFilter {
  readonly theme?: string;
  readonly accent?: string;
}

const notOneOf = (what: string, value: string, choices: readonly string[]): string => {
  const near = closest(value, choices);
  return `${what} '${value}' is not one of ${choices.join(', ')}${near ? ` — did you mean '${near}'?` : ''}`;
};

/**
 * One theme, one hue, or both: the theme named, and with a hue only that
 * hue and the pairs it is in, written with the hue first.
 */
export function filterColourChoices(c: ColourChoices, filter: ColourFilter):
  { readonly ok: true; readonly choices: ColourChoices } | { readonly ok: false; readonly message: string } {
  let themes = c.themes;
  if (filter.theme !== undefined) {
    themes = themes.filter((t) => t.name === filter.theme);
    if (themes.length === 0) return { ok: false, message: notOneOf('theme', filter.theme, c.themes.map((t) => t.name)) };
  }
  const hue = filter.accent;
  if (hue !== undefined) {
    if (!c.hues.some((h) => h.name === hue)) return { ok: false, message: notOneOf('accent', hue, c.hues.map((h) => h.name)) };
    themes = themes.map((t) => ({
      ...t,
      hues: t.hues.filter((h) => h === hue),
      pairs: t.pairs.filter((pair) => pair.includes(hue)).map(([a, b]) => (a === hue ? [a, b] as const : [b, a] as const)),
    }));
  }
  return { ok: true, choices: { ...c, themes } };
}

/** A pattern's words: `none` takes no origin; any other shape is written with one. */
export const patternWords = (shape: string, origin: string): string[] => (shape === 'none' ? [shape] : [shape, origin]);

/** One theme's example: its first pair (else hue) and the first shape that draws, from the default origin. */
function example(c: ColourChoices, t: ColourTheme): string[] {
  const shape = c.patterns.find((s) => s.name !== 'none')?.name;
  return colourLinesAz(t.name, t.pairs[0] ?? t.hues.slice(0, 1), shape ? patternWords(shape, c.defaultOrigin) : []);
}

/** The widest a text line may run before its list wraps, and where a row's values start. */
const LIST_WIDTH = 78;
const LIST_LABEL = 18;

/** `label  item item …` (with `mark` ',': `item, item, …`), wrapped under the value column. */
function row(label: string, items: readonly string[], mark = ''): string[] {
  if (items.length === 0) return [`${label.padEnd(LIST_LABEL)}(none)`];
  const out: string[] = [];
  let line = label.padEnd(LIST_LABEL) + items[0];
  for (const item of items.slice(1)) {
    line += mark;
    if (line.length + 1 + item.length > LIST_WIDTH) {
      out.push(line);
      line = ' '.repeat(LIST_LABEL) + item;
    } else {
      line += ` ${item}`;
    }
  }
  return [...out, line];
}

/** `az palette --list`: every choice, one theme per block, for a terminal. */
export function formatColourChoices(c: ColourChoices): string {
  const out: string[] = ['az palette — colour comes first; paste the lines under site', ''];
  for (const t of c.themes) {
    out.push(`theme ${t.name}`.padEnd(LIST_LABEL) + t.description);
    out.push(...row('  accent', t.hues));
    out.push(...row('  accent pair', t.pairs.map(([a, b]) => `${a} ${b}`), ','));
    out.push('');
  }
  out.push(...row('pattern', c.patterns.map((s) => s.name)));
  out.push(...row('pattern origin', c.origins.map((o) => o.name)));
  if (c.themes[0]) out.push('', 'for example:', ...example(c, c.themes[0]).map((l) => `  ${l}`));
  out.push('', 'A pair holds in either order. To pick by eye, az palette writes a gallery page.');
  return out.join('\n') + '\n';
}

/** One choice and the `.az` line that makes it. */
interface Choice { readonly name: string; readonly az: string }

export interface ColourChoicesJson {
  readonly howTo: string;
  readonly themes: readonly {
    readonly name: string;
    readonly description: string;
    readonly az: string;
    readonly accents: readonly Choice[];
    readonly pairs: readonly { readonly hues: readonly [string, string]; readonly az: string }[];
    readonly example: readonly string[];
  }[];
  readonly hues: readonly Named[];
  readonly patterns: readonly (Named & { readonly az: readonly string[] })[];
  readonly origins: readonly Named[];
  readonly defaultOrigin: string;
}

/** `az palette --json` and az_palette: the choices, each with the `.az` line that makes it. */
export function colourChoicesJson(c: ColourChoices): ColourChoicesJson {
  return {
    howTo: 'Pick a theme, then an accent (one hue, or a pair for a gradient), then a pattern; '
      + 'paste the lines under site, settings indented under theme. A pair holds in either order.',
    themes: c.themes.map((t) => ({
      name: t.name,
      description: t.description,
      az: `theme ${t.name}`,
      accents: t.hues.map((h) => ({ name: h, az: `accent ${h}` })),
      pairs: t.pairs.map(([a, b]) => ({ hues: [a, b] as const, az: `accent ${a} ${b}` })),
      example: example(c, t),
    })),
    hues: c.hues,
    patterns: c.patterns.map((s) => ({
      ...s,
      az: s.name === 'none' ? ['pattern none'] : c.origins.map((o) => `pattern ${s.name} ${o.name}`),
    })),
    origins: c.origins,
    defaultOrigin: c.defaultOrigin,
  };
}
