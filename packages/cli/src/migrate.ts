/**
 * @az module migrate
 * Purpose: az migrate: upgrade a .az file step by step to this grammar version.
 * Spec: docs/PRD.md §5
 * Exports: migrate, MIGRATIONS, GRAMMAR_VERSION
 * Edit guide: a grammar change after the freeze ships as a MigrationStep here.
 * Tests: packages/cli/test/lint-migrate.test.ts
 */

/**
 * `az migrate` — upgrade a .az file across grammar versions (PRD §5).
 *
 * Grammar 1 is the only version, so there are no steps yet and every current
 * file is a no-op. The path exists now so the first grammar change after the
 * M5 freeze ships as a step here instead of a breaking release (ROADMAP M3).
 */

import { lex, parse } from '../../core/src/index.ts';

/** The grammar this compiler reads; the parser rejects any other (AZ1021). */
export const GRAMMAR_VERSION = 1;

/** One upgrade: source written for `from` becomes source for `from + 1`. */
export interface MigrationStep {
  readonly from: number;
  readonly migrate: (source: string) => string;
}

/** Ordered upgrade steps. Empty until a grammar version after 1 exists. */
export const MIGRATIONS: readonly MigrationStep[] = [];

export type MigrateResult =
  | { readonly ok: true; readonly from: number; readonly source: string; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

/** Read the file's `az N` marker; null when there is none or it is not a whole number. */
function versionOf(source: string): number | null {
  const { tokens, diagnostics } = lex(source);
  const marker = parse(tokens, diagnostics).file.version;
  // Canonical integers only: the compiler compares the marker's text, so
  // `az 01` is not version 1 there, and must not be one here either.
  return marker !== null && /^(0|[1-9]\d*)$/.test(marker) ? Number(marker) : null;
}

export function migrate(
  source: string,
  steps: readonly MigrationStep[] = MIGRATIONS,
  target: number = GRAMMAR_VERSION,
): MigrateResult {
  const from = versionOf(source);
  if (from === null) {
    return { ok: false, message: `no version marker — the first line must be: az ${target}` };
  }
  if (from > target) {
    return { ok: false, message: `written for az ${from}, newer than this compiler (reads az ${target}) — upgrade az` };
  }
  let current = source;
  for (let v = from; v < target; v++) {
    const step = steps.find((s) => s.from === v);
    if (!step) return { ok: false, message: `no migration from az ${v} to az ${v + 1}` };
    current = step.migrate(current);
  }
  return { ok: true, from, source: current, changed: current !== source };
}
