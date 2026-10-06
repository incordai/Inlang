/**
 * Data tables for tests, made the way a build makes them: the `.az` file
 * compiled, its first lock step planned, the step turned into SQL units.
 * Test-only.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, plan, type Manifest, type SpecTable } from '../../core/src/index.ts';
import { dataSteps } from '../src/data-ddl.ts';
import type { DataStep } from '../src/server/data-migrate.ts';
import { loadTables, type Table } from '../src/server/data-values.ts';

const wordsDir = new URL('../../words/', import.meta.url);
export const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

export const dataSite = (data: string) =>
  `az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n${data}page /\n  hero center\n    title "Hi"\n`;

/** `data …` lines → the runtime tables and the steps that create them. */
export function dataOf(data: string): { tables: Table[]; steps: DataStep[] } {
  const r = compile(dataSite(data), { manifests });
  if (!r.ok || !r.spec?.site.data) throw new Error(`fixture does not compile: ${JSON.stringify(r.diagnostics)}`);
  const spec: readonly SpecTable[] = r.spec.site.data;
  const p = plan([], spec, { rename: [], drop: [], unique: [] });
  // Through JSON and loadTables, exactly as the server reads data.json.
  return { tables: loadTables(JSON.parse(JSON.stringify({ tables: spec }))), steps: dataSteps([{ version: 1, ops: p.ops }]) };
}
