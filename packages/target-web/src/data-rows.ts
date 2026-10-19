/**
 * @az module data-rows
 * Purpose: src/data/rows.tsx — connects every `from` block to the typed client, after the page renders.
 * Spec: docs/data-spec.md §10.3
 * Exports: ROWS_FILE, ROWS_RUNTIME_FILES, fromTables, rowsTsx
 * Edit guide: only the tables some block reads; the DOM work is the behaviour runtime's rows.ts, not this file.
 * Tests: packages/target-web/test/data-rows.test.ts
 */

/**
 * A `from` block ships as a pre-rendered shell (core emit-contract
 * fromShell); the runtime that fills it (overlay runtime rows.ts) is copied
 * into every site, and this generated module hands it each table's typed
 * `list`. Generated only for a site with a `from` block, and App renders it
 * only then, so a site without one ships none of it.
 */

import { generated } from './generated.ts';
import { DATA_DIR, stringLiteral as str } from './data-client.ts';
import { typeName } from '../../core/src/data.ts';
import type { Spec } from '../../core/src/spec.ts';

export const ROWS_FILE = `${DATA_DIR}/rows.tsx`;

/** The behaviour runtime's files that only a site with a `from` block ships. */
export const ROWS_RUNTIME_FILES: readonly string[] = ['rows.ts', 'rows-logic.ts', 'cover-sizes.ts'];

/** The tables `from` blocks read, sorted and once each. */
export function fromTables(spec: Spec): string[] {
  const names = new Set<string>();
  for (const page of spec.pages) for (const b of page.blocks) if (b.from) names.add(b.from.table);
  return [...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

/** The module's text for these tables; `runtimeDir` is where the behaviour runtime is copied (src/az). */
export function rowsTsx(tables: readonly string[], runtimeDir: string): string {
  // Both directories sit under src/, so the runtime is one level up from here.
  const runtime = `../${runtimeDir.replace(/^src\//, '')}/rows.ts`;
  const queries = tables.map((t) => `${typeName(t)}Query`);
  return `${generated('connects every from block to the typed client after the page renders (data-spec §10.3)')}import { useLayoutEffect } from "react";
import { attachRows, type RowSource } from ${str(runtime)};
import { tables, type ${queries.join(', type ')} } from "./client.ts";

/**
 * The list of each table a \`from\` block reads. The query each block sends is
 * the one the compiler checked against the table and the server's
 * allow-list (data-spec §10); it travels in the block's markup, so it is
 * typed here as the table's query.
 */
const SOURCES: Readonly<Record<string, RowSource>> = {
${tables.map((t, i) => `  ${str(t)}: (query) => tables[${str(t)}].list(query as ${queries[i]}),`).join('\n')}
};

/** Fills the page's \`from\` blocks; renders nothing. A layout effect, so it never runs in a server render. */
export function RowsRuntime(): null {
  useLayoutEffect(() => attachRows(document, SOURCES), []);
  return null;
}
`;
}
