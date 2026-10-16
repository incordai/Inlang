/**
 * @az module prompt
 * Purpose: `az prompt` — the instructions any AI model needs to write .az, as one Markdown block, from the compiler's own tables.
 * Spec: docs/GRAMMAR.md §1–§5 · docs/PRD.md §6.1a · each word.json
 * Exports: buildPrompt, promptJson, promptOptionsFrom, approxTokens, TOKEN_RULE, TRIM_ORDER, Trim, PromptInput,
 *   PromptOptions, Prompt, PromptBuilt, PromptJson, ERROR_CASES, ErrorCase, caseCode, minimalExample, dataExample
 * Edit guide: never list a word's variants or keys, or a theme, hue or value set, here — read them from the manifests and
 *   the tables. Every example and every error case is compiled when the prompt is built; an example that is not clean,
 *   or a case whose first diagnostic is not its stated code, is left out (prompt.test.ts fails when one is).
 * Tests: packages/core/test/prompt.test.ts, packages/cli/test/prompt-cli.test.ts, packages/mcp/test/prompt.test.ts
 */

/**
 * "Your components define the model's instructions": the words' manifests,
 * the colour tables and the structure keywords already hold everything an
 * author may write, so the system prompt an AI needs is generated from them
 * rather than written beside them. A model with no tool connection gets the
 * same vocabulary `az explain`, `az palette` and the MCP catalogue serve.
 *
 * The prose here is only the grammar's shape (GRAMMAR §1–§5), which no table
 * holds. Every example is compiled here before it is shown, and every common
 * error is the compiler's own message for a broken line, so neither can
 * drift from the compiler.
 */

import { compile, blocksFor, type Manifest, type PropSpec } from './index.ts';
import {
  COLOUR_TABLES, DEFAULT_THEME_NAME, colourChoices, colourChoicesMd, colourLinesAz, partnersOf, patternWords,
} from './colour.ts';
import { STRUCTURE_DESCRIPTIONS } from './describe.ts';
import {
  ACTIONS, ACTION_DESCRIPTIONS, DATA_MODIFIERS, DATA_TYPES, MODIFIER_DESCRIPTIONS, TYPE_DESCRIPTIONS, WHO,
  WHO_DESCRIPTIONS,
} from './data.ts';
import { FROM_SETTINGS } from './from.ts';
import { COMPONENT_EXT, FONT_FAMILIES, INJECTION_POINTS, META_DESCRIPTION_MAX, SITE_WIDTHS } from './link.ts';
import { DESTINATION_SCHEMES } from './actions.ts';
import { HIERARCHIES } from './emit-contract.ts';
import { SITE_DEFAULTS } from './spec.ts';
import { closest } from './suggest.ts';

/**
 * The size measure: one token is taken as four characters, rounded up. It is
 * an approximation — a model's tokenizer counts differently, and Markdown
 * punctuation usually costs more — stated wherever a size is reported.
 */
export const TOKEN_RULE = 'approximate tokens = characters / 4, rounded up';
export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * What `--budget` drops, first to last, until the prompt fits. `--compact`
 * drops all of them: the order of work, the syntax rules with the minimal
 * example, the colour choices and every word's variants and keys remain.
 */
export const TRIM_ORDER = ['examples', 'rules', 'info', 'data', 'errors'] as const;
export type Trim = (typeof TRIM_ORDER)[number];

const TRIM_TEXT: Readonly<Record<Trim, string>> = {
  examples: "each word's example file",
  rules: "each word's validation rules",
  info: 'the info line of every word, variant, key and value',
  data: 'the backend and data section',
  errors: 'the common errors and their fixes',
};

export interface PromptInput {
  /** Every word the file may use, by name — the same map `compile` takes. */
  readonly manifests: ReadonlyMap<string, Manifest>;
  /** Word name → its example `.az` file (the word's preview.az); shown only when it compiles clean. */
  readonly examples: ReadonlyMap<string, string>;
}

export interface PromptOptions {
  /** Only these words in the words section; every other section stays. */
  readonly words?: readonly string[];
  /** The smallest prompt: everything in TRIM_ORDER dropped. */
  readonly compact?: boolean;
  /** Approximate tokens (TOKEN_RULE) the prompt must fit in; parts drop in TRIM_ORDER. */
  readonly budget?: number;
}

export interface Prompt {
  readonly markdown: string;
  readonly chars: number;
  readonly tokens: number;
  /** The words described, sorted. */
  readonly words: readonly string[];
  /** The parts left out, in TRIM_ORDER. */
  readonly dropped: readonly Trim[];
}

export type PromptBuilt = { readonly ok: true; readonly prompt: Prompt } | { readonly ok: false; readonly message: string };

const code = (s: string): string => `\`${s}\``;
const fence = (lines: readonly string[]): string[] => ['```az', ...lines, '```'];
const own = <T>(o: Readonly<Record<string, T>> | undefined, k: string): T | undefined =>
  (o && Object.hasOwn(o, k) ? o[k] : undefined);

/** True when `source` compiles with no diagnostic at all — errors and warnings both. */
function clean(source: string, manifests: ReadonlyMap<string, Manifest>): boolean {
  return compile(source, { manifests: new Map(manifests) }).diagnostics.length === 0;
}

/* ---------------- examples, built from the tables ---------------- */

const first = <T>(xs: readonly T[] | undefined): T | undefined => xs?.[0];

/**
 * The smallest whole site: the colour step (the default theme, its first
 * allowed pair, the first shape that paints), the frame, a shared nav and two
 * pages. Null when the word set lacks a word it uses.
 */
export function minimalExample(manifests: ReadonlyMap<string, Manifest>): string[] | null {
  const hero = manifests.get('hero');
  const nav = manifests.get('nav');
  const text = manifests.get('text');
  if (!hero || !nav || !text) return null;
  const theme = colourChoices().themes.find((t) => t.name === DEFAULT_THEME_NAME);
  const shape = Object.keys(COLOUR_TABLES.shapes).find((s) => s !== 'none');
  const families = Object.keys(FONT_FAMILIES);
  const display = families.find((f) => f === 'serif') ?? families[0];
  const body = families.find((f) => f !== display) ?? display;
  const variant = (m: Manifest) => (first(m.variants) ? ` ${first(m.variants)}` : '');
  return [
    'az 1',
    '',
    'site studio',
    `  width ${SITE_DEFAULTS.width}`,
    ...colourLinesAz(theme?.name ?? DEFAULT_THEME_NAME, theme?.pairs[0] ?? [],
      shape ? patternWords(shape, COLOUR_TABLES.defaultOrigin) : []).map((l) => `  ${l}`),
    '  font',
    `    display ${display}`,
    `    body    ${body}`,
    `  nav${variant(nav)}`,
    '    link "Work" /work',
    '',
    'page /',
    `  hero${variant(hero)}`,
    '    title "Made by hand"',
    '    sub   "Two people, one workshop."',
    '    cta   "See the work" /work',
    '',
    'page /work',
    '  text',
    '    title "Work"',
    '    body  "Every pair we made this year."',
  ];
}

/** A site with a backend and one table, read by a block through `from`. Null when a word it uses is missing. */
export function dataExample(manifests: ReadonlyMap<string, Manifest>): string[] | null {
  const fromWord = [...manifests.values()].find((m) => m.from && m.name === 'feature');
  if (!fromWord?.from || !manifests.get('auth') || !manifests.get('hero')) return null;
  const db = Object.keys(STRUCTURE_DESCRIPTIONS.backend.values?.database ?? {})[0];
  const email = Object.keys(STRUCTURE_DESCRIPTIONS.backend.values?.email ?? {})[0];
  return [
    'az 1',
    '',
    'site shop',
    '  auth',
    '    adapter azbackend',
    '  backend',
    `    database ${db}`,
    `    email    ${email}`,
    '  data products',
    '    name   text     required search',
    '    blurb  longtext',
    '    price  money    usd required',
    '    allow anyone   read',
    '    allow signedin create',
    '    allow owner    edit delete',
    '',
    'page /',
    '  hero',
    '    title "The shop"',
    `  ${fromWord.name}`,
    '    title "In the shop"',
    '    from products',
    '      title name',
    '      text  blurb',
    '',
    'page /login',
    '  auth login',
    '    alt "Forgot your password" /reset',
    '',
    'page /reset',
    '  auth reset',
  ];
}

/**
 * Which `allow <who> <action>` cells the compiler accepts, asked of the
 * compiler itself: each cell is the one rule of a table added to the data
 * example, and is allowed when the file still has no error. Empty when the
 * example cannot be built.
 */
function allowMatrix(manifests: ReadonlyMap<string, Manifest>): Record<string, string[]> {
  const base = dataExample(manifests);
  if (!base || !clean(base.join('\n'), manifests)) return {};
  const after = base.reduce((last, l, i) => (l.trimStart().startsWith('allow ') ? i + 1 : last), 0);
  const out: Record<string, string[]> = {};
  for (const who of WHO) {
    out[who] = ACTIONS.filter((action) => {
      const probe = ['  data notes', '    body text', `    allow ${who} ${action}`];
      const lines = [...base.slice(0, after), ...probe, ...base.slice(after)];
      return !compile(lines.join('\n'), { manifests: new Map(manifests) }).diagnostics.some((d) => d.severity === 'error');
    });
  }
  return out;
}

/* ---------------- common errors: the compiler's own messages ---------------- */

export interface ErrorCase {
  /**
   * The diagnostic the broken file must raise first; a case that raises
   * another is not shown. A compiler class ID (below AZ2000) is named; a
   * word's own row is found in its manifest's `checks` by kind, because a
   * per-word ID lives only in word.json (GRAMMAR §7.4).
   */
  readonly code: string | { readonly word: string; readonly check: string };
  /** The broken file, as a change to the minimal example: [line to find, line to put instead]. */
  readonly change: readonly [string, string];
}

/** The ID a case expects, or null when its word or check is not in the set. */
export function caseCode(c: ErrorCase, manifests: ReadonlyMap<string, Manifest>): string | null {
  if (typeof c.code === 'string') return c.code;
  const { word, check } = c.code;
  return manifests.get(word)?.checks?.find((row) => row.kind === check)?.code ?? null;
}

/**
 * The mistakes authors (and models) make most, each as one changed line of
 * the minimal example. What is printed is the line and the compiler's
 * message for it — the message names the fix.
 */
export const ERROR_CASES: readonly ErrorCase[] = [
  { code: 'AZ1020', change: ['az 1', ''] },
  { code: 'AZ1001', change: ['  width default', '\twidth default'] },
  { code: 'AZ1002', change: ['  width default', '   width default'] },
  { code: 'AZ1003', change: ['    title "Made by hand"', '      title "Made by hand"'] },
  { code: 'AZ1201', change: ['  text', '  section'] },
  { code: 'AZ1202', change: ['  hero center', '  hero center split'] },
  { code: 'AZ1202', change: ['    link "Work" /work', '    group "More"\n      mobile drawer\n      link "Work" /work'] },
  { code: 'AZ1202', change: ['    link "Work" /work', '    link "Work" /work\n  hero\n    title "On every page"'] },
  { code: 'AZ1204', change: ['  hero center', '  hero centre'] },
  { code: 'AZ1207', change: ['    title "Made by hand"', ''] },
  { code: 'AZ1208', change: ['    link "Work" /work', '    link "Work" /work\n    mobile true'] },
  { code: 'AZ1215', change: ['    cta   "See the work" /work', '    cta   "See the work" /wrok'] },
  { code: 'AZ1402', change: ['    sub   "Two people, one workshop."', '    poster images/hero.webp'] },
  { code: 'AZ1406', change: ['    title "Made by hand"', '    title made by hand'] },
  { code: 'AZ1406', change: ['    title "Made by hand"', '    title made'] },
  { code: 'AZ1406', change: ['    link "Work" /work', '    link "Work" /work now'] },
  { code: 'AZ1406', change: ['    link "Work" /work', '    link work /work'] },
  { code: 'AZ1413', change: ['page /', 'page /home/'] },
  { code: 'AZ1414', change: ['  width default', '  width 1200'] },
  { code: 'AZ1416', change: ['    display serif', '    display georgia'] },
  { code: 'AZ1417', change: ['  theme midnight', '  theme dark'] },
  { code: 'AZ1418', change: ['    accent violet blue', '    accent purple'] },
  { code: 'AZ1423', change: ['    accent violet blue', '    accent violet indigo'] },
  { code: 'AZ1503', change: ['  hero center', '  theme paper\n  hero center'] },
  { code: 'AZ1504', change: ['    sub   "Two people, one workshop."', '    sub   "Two people, one workshop."\n    sub   "Forty pairs a month."'] },
  {
    code: { word: 'hero', check: 'perPage' },
    change: ['    cta   "See the work" /work', '    cta   "See the work" /work\n  hero\n    title "Again"'],
  },
];

interface ShownError { readonly code: string; readonly line: string; readonly message: string }

/** Each case compiled; only those whose first diagnostic is the stated code. */
function shownErrors(manifests: ReadonlyMap<string, Manifest>): ShownError[] {
  const base = minimalExample(manifests);
  if (!base) return [];
  const source = base.join('\n');
  const out: ShownError[] = [];
  for (const c of ERROR_CASES) {
    const [find, put] = c.change;
    const at = base.indexOf(find);
    if (at < 0) continue;
    const broken = [...base.slice(0, at), put, ...base.slice(at + 1)].join('\n');
    if (broken === source) continue;
    const d = compile(broken, { manifests: new Map(manifests) }).diagnostics[0];
    if (!d || d.code !== caseCode(c, manifests)) continue;
    const line = broken.split('\n')[d.pos.line - 1] ?? '';
    out.push({ code: d.code, line: line.replace(/\t/g, '<tab>').replace(/^( +)/, (s) => '·'.repeat(s.length)), message: d.message });
  }
  return out;
}

/* ---------------- words ---------------- */

const placeholder = (s: string): string => s.replace(/\{([a-z]+)\}/g, '<$1>');

/** A key's value as an author writes it, compactly: `"text" ≤12 words`, `a|b|c`, `./file .glb`. */
function valueShape(p: PropSpec): string {
  // A list checked by a file-wide rule (chat's `show`) names its words in valueDescriptions, not values.
  const values = Array.isArray(p.values) ? p.values.join('|') : p.values ? `<${p.values} code>`
    : p.valueDescriptions ? Object.keys(p.valueDescriptions).join('|') : '';
  switch (p.type) {
    case 'string': return `"text"${p.maxWords !== undefined ? ` ≤${p.maxWords} words` : ''}`;
    case 'markdown': return `"text" or ./file${(p.ext ?? []).join('|')}`;
    case 'path': return `./file${p.ext ? ` (${p.ext.join(' ')})` : ''}`;
    case 'enum': return values;
    case 'int': return `<number${p.min !== undefined && p.max !== undefined ? ` ${p.min}–${p.max}` : ''}>`;
    case 'list': return `${p.of === 'route' ? '/route' : values} …(space-separated${p.max !== undefined ? `, max ${p.max}` : ''})`;
    case 'flag': return '(the key alone, no value)';
    case 'route': return '/route';
    default: return `<${p.type}>`;
  }
}

function keyLine(name: string, p: PropSpec, info: boolean, indent: string): string[] {
  const bits = [valueShape(p)];
  if (p.required) bits.push('required');
  if (p.scope === 'site') bits.push('site level');
  if (p.default !== undefined) bits.push(`default ${Array.isArray(p.default) ? p.default.join(' ') : String(p.default)}`);
  if (p.deferred?.length) bits.push(`not yet: ${p.deferred.join(' ')}`);
  const out = [`${indent}- ${code(name)} ${bits.join(', ')}${info && p.description ? ` — ${p.description}` : ''}`];
  if (info && p.valueDescriptions) {
    for (const [v, text] of Object.entries(p.valueDescriptions)) out.push(`${indent}  - ${code(v)} ${text}`);
  }
  return out;
}

interface SlotDef {
  readonly description?: string;
  readonly min?: number;
  readonly max?: number;
  readonly props?: Record<string, PropSpec>;
  readonly slots?: Record<string, SlotDef>;
}

function slotLines(name: string, s: SlotDef, info: boolean, indent: string): string[] {
  const bounds = [s.min !== undefined ? `min ${s.min}` : '', s.max !== undefined ? `max ${s.max}` : ''].filter(Boolean).join(', ');
  const out = [`${indent}- ${code(name)} fill${bounds ? ` (${bounds})` : ''}${info && s.description ? ` — ${s.description}` : ''}`];
  for (const [k, p] of Object.entries(s.props ?? {})) out.push(...keyLine(k, p, info, `${indent}  `));
  for (const [k, c] of Object.entries(s.slots ?? {})) out.push(...slotLines(k, c, info, `${indent}  `));
  return out;
}

function needsLines(m: Manifest): string[] {
  const out: string[] = [];
  for (const [k, needs] of Object.entries(m.requires ?? {})) out.push(`${code(k)} needs ${needs.map(code).join(', ')}`);
  for (const [prop, byValue] of Object.entries(m.requiresWhen ?? {})) {
    for (const [v, needs] of Object.entries(byValue)) out.push(`${code(`${prop} ${v}`)} needs ${needs.map(code).join(', ')}`);
  }
  for (const [k, wants] of Object.entries(m.recommends ?? {})) out.push(`${code(k)} wants ${wants.map(code).join(', ')} (a warning)`);
  return out;
}

interface WordParts { readonly info: boolean; readonly rules: boolean; readonly example: string | null }

function wordSection(m: Manifest, parts: WordParts): string[] {
  const { info } = parts;
  const variants = m.variants ?? [];
  const modifiers = m.modifiers ?? [];
  const out = [`### ${code(m.name)}${info && m.description ? ` — ${m.description}` : ''}`, ''];
  if (info) {
    if (variants.length) {
      out.push('Variants, one per block (the first is the default):');
      for (const v of variants) out.push(`- ${code(v)} ${own(m.descriptions?.variants, v) ?? ''}`.trimEnd());
    }
    if (modifiers.length) {
      out.push('Modifiers, any number:');
      for (const v of modifiers) out.push(`- ${code(v)} ${own(m.descriptions?.modifiers, v) ?? ''}`.trimEnd());
    }
  } else {
    if (variants.length) out.push(`Variants: ${variants.join(' ')} (first is default)`);
    if (modifiers.length) out.push(`Modifiers: ${modifiers.join(' ')}`);
  }
  const keys = Object.entries(m.props ?? {});
  const slots = Object.entries((m.slots ?? {}) as Record<string, SlotDef>);
  const children = m.children ?? [];
  if (keys.length || slots.length || children.length || m.from) {
    out.push('Keys:');
    for (const [k, p] of keys) out.push(...keyLine(k, p, info, ''));
    for (const [k, s] of slots) out.push(...slotLines(k, s, info, ''));
    const limits = (m as { limits?: Record<string, { max?: number }> }).limits;
    for (const c of children) {
      const max = limits?.[c]?.max;
      const text = own(m.descriptions?.children, c);
      out.push(`- ${code(c)} child${max !== undefined ? ` (max ${max})` : ''}${info && text ? ` — ${text}` : ''}`);
    }
    if (m.from) {
      out.push(`- ${code('from <table>')} rows fill ${code(m.from.slot)} (limit ${m.from.limit.default}, max ${m.from.limit.max})${info ? ` — ${m.from.description}` : ''}`);
      for (const [k, f] of Object.entries(m.from.map)) {
        out.push(`  - ${code(`${k} <field>`)} ${f.types.join('|')}${f.required ? ', required' : ''}${info ? ` — ${f.description}` : ''}`);
      }
    }
  }
  const needs = needsLines(m);
  if (needs.length) out.push(`Needs: ${needs.join('; ')}`);
  if (parts.rules && m.checks?.length) {
    out.push('Rules:');
    for (const c of m.checks) out.push(`- ${code(c.code)} ${c.severity}: ${placeholder(c.message)}`);
  }
  if (parts.example) out.push('Example:', ...fence(parts.example.trimEnd().split('\n')));
  out.push('');
  return out;
}

/* ---------------- the sections ---------------- */

function orderSection(): string[] {
  return [
    '## Order of work',
    '',
    '1. **Colour first.** Choose `theme`, `accent` (one hue, or an allowed pair for a gradient) and `pattern`',
    "   from the user's brand or mood; show 2-3 options as their exact `.az` lines and confirm one.",
    '   Colours come only from the theme: there is no hex value, rgb or colour name anywhere.',
    '2. **Then the frame:** `width` and `font` under `site`.',
    '3. **Then the sections:** one `page <route>` per page, its blocks in render order, from the words below.',
    '4. **Always run `az check <file>.az`** after every edit and fix every diagnostic until it prints',
    '   `az: no problems found`. Each message ends with its fix.',
    '',
  ];
}

function syntaxSection(manifests: ReadonlyMap<string, Manifest>): string[] {
  const example = minimalExample(manifests);
  const schemes = DESTINATION_SCHEMES.map((s) => code(`${s}:`)).join(' ');
  return [
    '## Syntax',
    '',
    '- The first line is `az 1`. One statement per line; nothing else is a separator.',
    '- Indent exactly 2 spaces per level, never tabs, one level deeper at a time, at most 4 levels.',
    '- A statement is `<word> [variant] [modifier ...]`; the lines indented under it are its keys, each',
    '  `<key> <value>`. Spaces between tokens are free, so values may be aligned.',
    '- Copy is a double-quoted string on one line; the only escapes are `\\"`, `\\\\` and `\\n`.',
    '  Everything else is bare: names, numbers, `on`/`off`.',
    '- Lowercase ASCII names only (letters and digits); non-ASCII text only inside quotes.',
    `- Destinations: ${code('/route')} (must be a declared page), ${code('#anchor')}, ${code('./file')} (a download),`,
    `  or a scheme: ${schemes}. A colon appears only in these schemes.`,
    '- Paths begin `./` and stay inside the project; `..` is refused.',
    '- Routes are `/` or `/`-separated segments of letters, digits and `- . _ ~`, no trailing `/`.',
    '- `#` followed by a space, or first on a line, starts a comment; `#name` is an anchor.',
    '- `site <name>` comes once. Under it: the colour, the frame, `description`, `icon`, `backend`, `data`,',
    '  and `nav`, `footer` or `scene backdrop` blocks shared by every page.',
    '- `page <route>` holds the blocks of one page in render order, and its own `description`.',
    "  A page's `nav` or `footer` replaces the site's whole; `nav none` or `footer none` removes it on that page",
    '  (only when the site declares one: with nothing to leave out it is a warning).',
    '- A fill is written `<slot> "<label>" [<destination>]` with its own keys indented under it,',
    `  e.g. ${code('cta "Book a call" /contact')}. ${code('as <look>')} at the end of a button line picks its look:`,
    `  ${HIERARCHIES.map(code).join(' ')}.`,
    '- Every key is set once per block; a word or key that is not listed below is an error.',
    '- There are no variables, conditionals, loops, includes, expressions, inline styles or HTML.',
    `  Custom markup is a component file: ${code('raw ./x.tsx')} in a page or block, or`,
    `  ${code('slot <name> ./x.tsx')} into a block's slot (${INJECTION_POINTS.map(code).join(' and ')} fit any block);`,
    `  extensions ${COMPONENT_EXT.join(' ')}.`,
    '',
    ...(example ? ['A whole site that compiles with no diagnostics:', '', ...fence(example), ''] : []),
  ];
}

function colourSection(info: boolean): string[] {
  const c = colourChoices();
  const head = ['## Colour (choose first)', '', 'All three go under `site`, the settings indented under `theme`:', ''];
  if (info) return [...head, ...colourChoicesMd(null), ''];
  const origins = c.origins.map((o) => o.name);
  return [
    ...head,
    `- ${code('theme <name>')}: ${c.themes.map((t) => t.name).join(' ')} (default ${DEFAULT_THEME_NAME})`,
    `- ${code('accent <hue> [<hue2>]')}: ${c.hues.map((h) => h.name).join(' ')}; a second hue makes a gradient,`
      + ' allowed only with these partners (either order):',
    ...c.hues.map((h) => {
      const partners = partnersOf(h.name);
      return `  - ${h.name}: ${partners.length ? partners.join(', ') : 'none'}`;
    }),
    `- ${code('pattern <shape> [<origin>]')}: ${c.patterns.map((p) => p.name).join(' ')}; origin ${origins.join(' ')}`
      + ` (default ${c.defaultOrigin})`,
    '',
  ];
}

function settingsSection(info: boolean): string[] {
  const site = STRUCTURE_DESCRIPTIONS.site;
  const font = STRUCTURE_DESCRIPTIONS.font;
  const say = (text: string | undefined) => (info && text ? ` — ${text}` : '');
  const values = (table: Readonly<Record<string, string>>) => (info
    ? Object.entries(table).map(([k, text]) => `  - ${code(k)} ${text}`)
    : []);
  return [
    '## Frame and page settings',
    '',
    `- ${code('width <preset>')} under site: ${Object.keys(SITE_WIDTHS).join(' ')} (default ${SITE_DEFAULTS.width})${say(site.settings?.width)}`,
    ...values(SITE_WIDTHS),
    `- ${code('font')} under site, then one role per indented line: ${Object.keys(font.settings ?? {}).map((r) => code(`${r} <family>`)).join(', ')};`
      + ` families ${Object.keys(FONT_FAMILIES).join(' ')}${say(font.description)}`,
    ...values(FONT_FAMILIES),
    `- ${code('description "<text>"')} under site or page, at most ${META_DESCRIPTION_MAX} characters${say(site.settings?.description)}`,
    `- ${code('icon ./icon.svg')} under site only, .svg or .png${say(site.settings?.icon)}`,
    '',
  ];
}

function dataSection(manifests: ReadonlyMap<string, Manifest>, info: boolean): string[] {
  const backend = STRUCTURE_DESCRIPTIONS.backend;
  const matrix = allowMatrix(manifests);
  const example = dataExample(manifests);
  const list = (table: Readonly<Record<string, string>>, keys: readonly string[]) => (info
    ? keys.map((k) => `  - ${code(k)} ${table[k]}`)
    : []);
  const settings = Object.entries(backend.values ?? {}).map(([k, v]) => `${code(`${k} ${Object.keys(v).join('|')}`)}`);
  return [
    '## Backend and data (only when the site stores data)',
    '',
    `- ${code('backend')} under site, with ${settings.join(' and ')} indented under it. Addresses and keys live in`,
    "  the server's `.env`, never in the file. The site's `auth` uses `adapter azbackend`.",
    `- ${code('data <table>')} under site: one field per line, ${code('<field> <type> [type-arg ...] [modifier ...]')}.`,
    `  Types: ${DATA_TYPES.join(' ')}.`,
    ...list(TYPE_DESCRIPTIONS, DATA_TYPES),
    `  Modifiers: ${DATA_MODIFIERS.join(' ')}.`,
    ...list(MODIFIER_DESCRIPTIONS, DATA_MODIFIERS),
    `- ${code('allow <who> <action ...>')} in a table; without one only admins may act. Allowed:`
      + ` ${Object.entries(matrix).map(([who, acts]) => `${who} ${acts.join('|')}`).join('; ')}.`,
    ...(info ? [...WHO.map((w) => `  - ${code(w)} ${WHO_DESCRIPTIONS[w]}`), ...ACTIONS.map((a) => `  - ${code(a)} ${ACTION_DESCRIPTIONS[a]}`)] : []),
    `- ${code('from <table>')} in a block that takes it fills a slot from rows; under it map each key to a field,`
      + ` and optionally ${Object.keys(FROM_SETTINGS).map(code).join(' ')}.`,
    ...list(FROM_SETTINGS, Object.keys(FROM_SETTINGS)),
    '',
    ...(example && clean(example.join('\n'), manifests) ? ['', ...fence(example), ''] : []),
  ];
}

function errorsSection(manifests: ReadonlyMap<string, Manifest>): string[] {
  const shown = shownErrors(manifests);
  if (shown.length === 0) return [];
  return [
    '## Common errors and their fixes',
    '',
    'The line as written (`·` is a space), then what `az check` says:',
    '',
    ...shown.map((e) => `- ${code(e.line || '(line 1 empty)')} → ${code(e.code)} ${e.message}`),
    '',
  ];
}

function closingSection(): string[] {
  return [
    '## Before you answer',
    '',
    'Run `az check <file>.az` and fix every error and warning; `az explain <term ...>` says what any',
    'term means in one line. Never invent a word, key or value that is not listed here.',
    '',
  ];
}

/* ---------------- the prompt ---------------- */

function render(input: PromptInput, words: readonly Manifest[], drop: ReadonlySet<Trim>): string {
  const info = !drop.has('info');
  const example = (m: Manifest): string | null => {
    if (drop.has('examples')) return null;
    const src = input.examples.get(m.name);
    if (src === undefined || !clean(src, input.manifests)) return null;
    const r = compile(src, { manifests: new Map(input.manifests) });
    const spec = r.spec;
    return spec && spec.pages.some((p) => blocksFor(spec, p).some((b) => b.word === m.name)) ? src : null;
  };
  const lines = [
    '# Writing .az files',
    '',
    'A `.az` file describes a whole website in words; the Incord Intelligent Language (inlang) compiler, run as `az`, builds it. This is the complete',
    "vocabulary, generated from the compiler's own tables: write only what is listed here.",
    '',
    ...orderSection(),
    ...syntaxSection(input.manifests),
    ...colourSection(info),
    ...settingsSection(info),
    '## Words (blocks)',
    '',
    ...words.flatMap((m) => wordSection(m, { info, rules: !drop.has('rules'), example: example(m) })),
    ...(drop.has('data') ? [] : dataSection(input.manifests, info)),
    ...(drop.has('errors') ? [] : errorsSection(input.manifests)),
    ...closingSection(),
  ];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

const blockWords = (manifests: ReadonlyMap<string, Manifest>): Manifest[] => [...manifests.values()]
  .filter((m) => m.kind === undefined || m.kind === 'block')
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * The prompt for these words. With a budget, parts drop in TRIM_ORDER until
 * it fits; `compact` starts with all of them dropped. Refused: a word that
 * is not one, or a budget below the smallest prompt.
 */
export function buildPrompt(input: PromptInput, options: PromptOptions = {}): PromptBuilt {
  const all = blockWords(input.manifests);
  let words = all;
  if (options.words !== undefined) {
    const names = all.map((m) => m.name);
    if (options.words.length === 0) return { ok: false, message: `--words needs at least one of ${names.join(', ')}` };
    for (const w of options.words) {
      if (!names.includes(w)) {
        const near = closest(w, names);
        return { ok: false, message: `'${w}' is not a word — use ${names.join(', ')}${near ? ` (did you mean '${near}'?)` : ''}` };
      }
    }
    words = all.filter((m) => options.words!.includes(m.name));
  }
  const budget = options.budget;
  if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0)) {
    return { ok: false, message: `budget must be a whole number of tokens above 0, not '${budget}'` };
  }
  const levels = options.compact ? [TRIM_ORDER.length] : TRIM_ORDER.map((_, i) => i).concat(TRIM_ORDER.length);
  let markdown = '';
  let dropped: Trim[] = [];
  for (const n of levels) {
    dropped = TRIM_ORDER.slice(0, n);
    markdown = render(input, words, new Set(dropped));
    if (budget === undefined || approxTokens(markdown) <= budget) {
      return { ok: true, prompt: { markdown, chars: markdown.length, tokens: approxTokens(markdown), words: words.map((m) => m.name), dropped } };
    }
  }
  return {
    ok: false,
    message: `the smallest prompt is ${approxTokens(markdown)} tokens (${markdown.length} characters; ${TOKEN_RULE}), over the budget of ${budget}`
      + ' — raise --budget or name fewer --words',
  };
}

/**
 * The options as a command line or a tool call writes them: `words` a
 * comma-separated list, `budget` a whole number of tokens. The checks
 * buildPrompt makes (known words, a budget it can meet) stay there.
 */
export function promptOptionsFrom(raw: { readonly words?: string; readonly compact?: boolean; readonly budget?: string }):
  { readonly ok: true; readonly options: PromptOptions } | { readonly ok: false; readonly message: string } {
  const options: { words?: string[]; compact?: boolean; budget?: number } = {};
  if (raw.words !== undefined) {
    options.words = raw.words.split(',').map((w) => w.trim()).filter(Boolean);
    if (options.words.length === 0) return { ok: false, message: 'words needs one or more word names, e.g. hero,cta' };
  }
  if (raw.compact) options.compact = true;
  if (raw.budget !== undefined) {
    if (!/^[1-9][0-9]{0,8}$/.test(raw.budget)) {
      return { ok: false, message: `budget '${raw.budget}' is not a whole number of tokens above 0 (${TOKEN_RULE})` };
    }
    options.budget = Number(raw.budget);
  }
  return { ok: true, options };
}

export interface PromptJson {
  readonly prompt: string;
  readonly chars: number;
  readonly tokens: number;
  readonly tokenRule: string;
  readonly words: readonly string[];
  readonly dropped: readonly { readonly part: Trim; readonly what: string }[];
  readonly trimOrder: readonly Trim[];
}

/** `az prompt --json` and the MCP tool az_prompt. */
export function promptJson(p: Prompt): PromptJson {
  return {
    prompt: p.markdown,
    chars: p.chars,
    tokens: p.tokens,
    tokenRule: TOKEN_RULE,
    words: p.words,
    dropped: p.dropped.map((part) => ({ part, what: TRIM_TEXT[part] })),
    trimOrder: TRIM_ORDER,
  };
}
