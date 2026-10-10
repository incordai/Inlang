/**
 * @az module lint-cli
 * Purpose: az lint: the theme lint over every word pack (a folder with word.json), and its themeReads list.
 * Spec: docs/PRD.md §7.3 · docs/ARCHITECTURE.md §4.1
 * Exports: lintWords, LintReport
 * Edit guide: a word pack is exactly what the manifest loader loads.
 * Tests: packages/cli/test/lint-migrate.test.ts, packages/theme/test/theme-reads.test.ts
 */

/**
 * `az lint` — theme-token enforcement over word packs (PRD §7.3, A7).
 *
 * A word pack is a directory holding a `word.json` — the same rule the
 * compiler's manifest loader uses (CONVENTIONS §3: a word IS its manifest),
 * so what lint checks is exactly what the compiler would load. Every source
 * file inside it is linted; nothing is exempt by comment or heuristic
 * (theme-spec §4: the exemption is by path, and word packs have none).
 *
 * The manifest's `themeReads` is held to the same sources: it must list
 * exactly the token paths the pack's files read (theme/src/theme-reads.ts),
 * because the graph and docs/WORDS.md report it as what the word depends on.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { lintSource, type LintFinding } from '../../theme/src/lint.ts';
import { checkThemeReads } from '../../theme/src/theme-reads.ts';

/** File types a word's markup, styles or logic can live in. */
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/;

export interface LintReport {
  readonly words: string[];
  readonly findings: LintFinding[];
}

function sourcesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesIn(path));
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/** Relative to the working directory when inside it, so paths are clickable; absolute otherwise. */
function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return (rel.startsWith('..') || isAbsolute(rel) ? file : rel).replace(/\\/g, '/');
}

/** Lint every word pack under `wordsDir`, or `wordsDir` itself if it is one. */
export function lintWords(wordsDir: string): LintReport {
  const packs = existsSync(join(wordsDir, 'word.json'))
    ? [wordsDir]
    : readdirSync(wordsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(wordsDir, e.name, 'word.json')))
        .map((e) => join(wordsDir, e.name))
        .sort();

  const findings = packs.flatMap((pack) => {
    const sources = sourcesIn(pack).map((file) => [displayPath(file), readFileSync(file, 'utf8')] as const);
    const manifestFile = join(pack, 'word.json');
    const manifestText = readFileSync(manifestFile, 'utf8');
    const theme = sources.flatMap(([file, text]) => lintSource(file, text));
    let declared: readonly string[];
    try {
      declared = (JSON.parse(manifestText) as { themeReads?: readonly string[] }).themeReads ?? [];
    } catch (e) {
      return [...theme, {
        file: displayPath(manifestFile), line: 1, col: 1, rule: 'theme-reads',
        message: `word.json is not valid JSON (${(e as Error).message}) — fix it, then themeReads can be checked`,
      }];
    }
    return [...theme, ...checkThemeReads(displayPath(manifestFile), manifestText, declared, sources)];
  });
  return { words: packs.map((p) => relative(wordsDir, p) || '.'), findings };
}
