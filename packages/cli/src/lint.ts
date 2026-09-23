/**
 * @az module lint-cli
 * Purpose: az lint: the theme lint over every word pack (a folder with word.json).
 * Spec: docs/PRD.md §7.3
 * Exports: lintWords, LintReport
 * Edit guide: a word pack is exactly what the manifest loader loads.
 * Tests: packages/cli/test/lint-migrate.test.ts
 */

/**
 * `az lint` — theme-token enforcement over word packs (PRD §7.3, A7).
 *
 * A word pack is a directory holding a `word.json` — the same rule the
 * compiler's manifest loader uses (CONVENTIONS §3: a word IS its manifest),
 * so what lint checks is exactly what the compiler would load. Every source
 * file inside it is linted; nothing is exempt by comment or heuristic
 * (theme-spec §4: the exemption is by path, and word packs have none).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { lintSource, type LintFinding } from '../../theme/src/lint.ts';

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

  const findings = packs.flatMap((pack) => sourcesIn(pack).flatMap((file) =>
    lintSource(displayPath(file), readFileSync(file, 'utf8'))));
  return { words: packs.map((p) => relative(wordsDir, p) || '.'), findings };
}
