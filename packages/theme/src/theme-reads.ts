/**
 * @az module theme-reads
 * Purpose: a word's declared themeReads must equal the token paths its own source reads.
 * Spec: docs/ARCHITECTURE.md §4.1 · docs/ARCHITECTURE.md §5
 * Exports: themeReadsIn, checkThemeReads, TokenRead
 * Edit guide: reads are found in text, like the theme lint; a new accessor form needs a pattern and a test case.
 * Tests: packages/theme/test/theme-reads.test.ts, packages/cli/test/lint-migrate.test.ts
 */

/**
 * `themeReads` in word.json is what the graph's `themeReads` edge, `az
 * explain` and docs/WORDS.md say a word depends on (ARCHITECTURE §4.1, §5).
 * Written by hand it drifts the moment an emitter changes, so `az lint`
 * holds it to the source: the list must be EXACTLY the token paths the
 * word's own files read through `ctx.theme` — none missing, none extra.
 *
 * What counts as a read, and what does not:
 *   - `ctx.theme.<group>.<key>`, `ctx.theme.<group>['<key>']` and
 *     `ctx.theme.<group>[<number>]`, each also with optional chaining
 *     (`t.gradient?.accent` — a group only some sites have, theme-spec §13),
 *     and the same through a local alias
 *     (`const t = ctx.theme`) or a parameter typed `ThemeLike`.
 *   - `typeSize.<key>` is the token `type.size.<key>`, as theme-spec names it.
 *   - A group read whole or by a computed key (`t.space`, `t.space[n]`)
 *     reads every token in it: `<group>.*`, which then stands for the group.
 *   - `pattern` is the site's pattern as var() references, not a token.
 *   - Tokens a shared helper reads when handed the theme (`framed(t)`,
 *     `glassSurface(t)`) and the buttons `ctx.actions` draws belong to that
 *     helper, not to the word: the list names what this word's code reads.
 *
 * Text-based, like the theme lint (lint.ts): comments are blanked first so a
 * token named in prose is not a read, and line numbers still point home.
 */

import type { LintFinding } from './lint.ts';

/** One token path read by a source file, and where the first read is. */
export interface TokenRead {
  readonly path: string;
  readonly file: string;
  readonly line: number;
  readonly col: number;
}

/** The token groups of `ThemeLike` (core/src/emit-contract.ts); `typeSize` is mapped to `type.size`. */
const GROUPS = ['color', 'size', 'typeSize', 'type', 'radius', 'shadow', 'space', 'motion', 'layer', 'breakpoint', 'gradient'];

const IDENT = '[A-Za-z_$][\\w$]*';

/** Before an element access: optional chaining's `?.` may come first. */
const OPT = '\\s*(?:\\?\\.\\s*)?';

/** Blank comments, keeping every newline and column, so positions survive. */
function blankComments(source: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])(\/\/[^\n]*)/g, (_, lead: string, comment: string) => lead + blank(comment));
}

/** The expressions that hold the theme in this file: `ctx.theme` and its aliases. */
function themeHolders(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*ctx\\.theme\\b(?!\\s*\\.)`, 'g'))) names.add(m[1]);
  for (const m of code.matchAll(new RegExp(`(${IDENT})\\s*\\??\\s*:\\s*(?:Readonly<\\s*)?ThemeLike\\b`, 'g'))) names.add(m[1]);
  return ['ctx\\.theme', ...[...names].map((n) => n.replace(/\$/g, '\\$'))];
}

/** Every token path one source file reads, each with its first position, sorted by path. */
export function themeReadsIn(file: string, source: string): TokenRead[] {
  const code = blankComments(source);
  const access = new RegExp(
    `(?<![\\w$.])(?:${themeHolders(code).join('|')})\\s*\\??\\.\\s*(${GROUPS.join('|')})\\b` +
    `(?:\\s*\\??\\.\\s*(${IDENT})|${OPT}\\[\\s*'([^']+)'\\s*\\]|${OPT}\\[\\s*"([^"]+)"\\s*\\]|${OPT}\\[\\s*(\\d+)\\s*\\])?`,
    'g');
  const first = new Map<string, TokenRead>();
  for (const m of code.matchAll(access)) {
    const group = m[1] === 'typeSize' ? 'type.size' : m[1];
    const key = m[2] ?? m[3] ?? m[4] ?? m[5];
    const path = `${group}.${key ?? '*'}`;
    if (first.has(path)) continue;
    const before = code.slice(0, m.index);
    first.set(path, { path, file, line: before.split('\n').length, col: m.index - before.lastIndexOf('\n') });
  }
  return [...first.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The group a path belongs to: `type.size.sm` → `type.size`, `color.bg` → `color`. */
const groupOf = (path: string): string => (path.startsWith('type.size.') ? 'type.size' : path.split('.')[0]);

/** A whole-group read (`g.*`) stands for every read in its group. */
function normalise(paths: Iterable<string>): Set<string> {
  const all = new Set(paths);
  const whole = new Set([...all].filter((p) => p.endsWith('.*')).map((p) => p.slice(0, -2)));
  return new Set([...all].filter((p) => p.endsWith('.*') || !whole.has(groupOf(p))));
}

/**
 * Compare a word's declared `themeReads` with what its source files read.
 * `manifestFile`/`manifestText` locate an extra entry on its own line;
 * `sources` are the word pack's files as `[displayPath, text]`.
 */
export function checkThemeReads(
  manifestFile: string,
  manifestText: string,
  declared: readonly string[],
  sources: readonly (readonly [string, string])[],
): LintFinding[] {
  const reads = new Map<string, TokenRead>();
  for (const [file, text] of sources) {
    for (const r of themeReadsIn(file, text)) if (!reads.has(r.path)) reads.set(r.path, r);
  }
  const read = normalise(reads.keys());
  // The list is held as written: an entry a wildcard already covers is extra.
  const listed = new Set(declared);
  const findings: LintFinding[] = [];

  for (const path of [...read].sort()) {
    if (listed.has(path)) continue;
    const at = reads.get(path)!;
    findings.push({
      file: at.file, line: at.line, col: at.col, rule: 'theme-reads',
      message: `'${path}' is read here but missing from themeReads in word.json — add it`,
    });
  }
  const lines = manifestText.split(/\r?\n/);
  for (const path of [...listed].sort()) {
    if (read.has(path)) continue;
    const quoted = JSON.stringify(path);
    const i = lines.findIndex((l) => l.includes(quoted));
    findings.push({
      file: manifestFile, line: Math.max(i, 0) + 1, col: i < 0 ? 1 : lines[i].indexOf(quoted) + 1, rule: 'theme-reads',
      message: `'${path}' is in themeReads but the word's source never reads it — remove it`,
    });
  }
  return findings;
}
