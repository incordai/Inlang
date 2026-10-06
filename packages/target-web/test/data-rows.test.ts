/**
 * src/data/rows.tsx (data-spec §10.3): generated only for a site with a
 * `from` block, it hands the behaviour runtime's rows.ts each table's typed
 * `list` — only the tables some block reads — and App renders it only then.
 * A site without `from` emits exactly what it did before; AZ.md maps every
 * `from` block. The runtime in real browsers is scripts/data-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { ROWS_FILE, rowsTsx } from '../src/data-rows.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const SITE = (page: string) => `az 1
site shop
  auth
    adapter azbackend
  backend
    database sqlite
    email smtp
  data notes
    title text required
    allow anyone read
  data class
    name text required
    allow anyone read
  data unused
    name text required
    allow anyone read
page /
  hero center
    title "Hi"
${page}page /login
  auth login
`;

const files = (page: string) => {
  const r = compile(SITE(page), { manifests });
  assert.ok(r.ok && r.spec, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
  return new Map(emitProject(r.spec, { emitters: WEB_EMITTERS }).files.map((f) => [f.path, f.content]));
};

const FROM = '  feature grid\n    from notes\n      title title\n  feature rows\n    from class\n      title name\n';

test('rows.tsx: only the tables a block reads, each through its typed list', () => {
  const out = files(FROM);
  const rows = out.get(ROWS_FILE);
  assert.ok(rows, 'generated with a from block');
  assert.match(rows, /import \{ attachRows, type RowSource \} from "\.\.\/az\/rows\.ts";/);
  assert.match(rows, /"notes": \(query\) => tables\["notes"\]\.list\(query as NotesRowQuery\),/);
  // A table named like a keyword is reached as a string key, never an identifier.
  assert.match(rows, /"class": \(query\) => tables\["class"\]\.list\(query as ClassRowQuery\),/);
  assert.equal(rows.includes('unused'), false, 'a table no block reads is not wired');
  const app = out.get('src/App.tsx')!;
  assert.match(app, /import \{ RowsRuntime \} from "\.\/data\/rows\.tsx";/);
  assert.match(app, /<RowsRuntime \/>/);
});

test('without a from block: no rows.tsx, App imports and renders no rows runtime', () => {
  const out = files('  feature grid\n    item "One"\n    item "Two"\n');
  assert.equal(out.has(ROWS_FILE), false);
  const app = out.get('src/App.tsx')!;
  assert.equal(app.includes('RowsRuntime'), false);
  assert.equal(app.includes('data-az-from'), false);
});

test('a from site emits byte-identical files twice (determinism)', () => {
  const a = files(FROM);
  const b = files(FROM);
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [path, content] of a) assert.equal(b.get(path), content, path);
  assert.ok(a.get('src/App.tsx')!.includes('data-az-from'), 'CONTROL: the shell is in the page data');
});

test('AZ.md maps each from block: page, word, table, mapping, query', () => {
  const md = files(FROM).get('AZ.md')!;
  assert.match(md, /## Data in blocks/);
  assert.ok(md.includes('| `/` | feature | `notes` | title ← title | limit 6 |'), md.slice(md.indexOf('## Data in blocks')));
  assert.ok(md.includes('| `/` | feature | `class` | title ← name | limit 6 |'));
  assert.ok(md.includes('`src/az/rows.ts`'));
  assert.equal(files('  feature grid\n    item "One"\n    item "Two"\n').get('AZ.md')!.includes('Data in blocks'), false);
});

test('rowsTsx reads the runtime from wherever it is copied', () => {
  assert.match(rowsTsx(['notes'], 'src/runtime'), /from "\.\.\/runtime\/rows\.ts";/);
});
