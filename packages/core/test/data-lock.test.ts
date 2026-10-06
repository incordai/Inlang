/**
 * The schema lock (data-spec §6.1–§6.2): storage schema, replay, the digest,
 * every change kind classified safe / destructive / refused, renames never
 * guessed, and the build-time check (AZ1701, AZ1706).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../src/index.ts';
import {
  LockError, checkLock, parseLock, plan, replay, serialiseLock, storageOf,
  type LockFlags, type LockStep, type LockTable,
} from '../src/data-lock.ts';
import type { SpecTable } from '../src/data.ts';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}
const HEAD = 'az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n';
const src = (data: string) => `${HEAD}${data}page /\n  hero center\n    title "Shop"\n`;
const tablesOf = (data: string): SpecTable[] => {
  const r = compile(src(data), { manifests });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), [], 'fixture compiles');
  return [...(r.spec?.site.data ?? [])];
};
const NO: LockFlags = { rename: [], drop: [], unique: [] };
const flags = (f: Partial<LockFlags>): LockFlags => ({ ...NO, ...f });

/** The lock a file's tables would get as its first step. */
const lockFor = (data: string): LockStep[] => {
  const p = plan([], tablesOf(data), NO);
  assert.deepEqual(p.problems, []);
  return [{ version: 1, ops: p.ops }];
};

/** Plan from `before` to `after`; when allowed, its ops must land exactly on `after`. */
function step(before: string, after: string, f: LockFlags = NO) {
  const steps = lockFor(before);
  const want = tablesOf(after);
  const p = plan(replay(steps), want, f);
  if (p.problems.length === 0 && p.flagErrors.length === 0) {
    const landed = replay([...steps, { version: 2, ops: p.ops }]);
    const byName = (ts: LockTable[]) => Object.fromEntries(ts.map((t) => [t.name, Object.fromEntries(t.fields.map((x) => [x.name, x]))]));
    assert.deepEqual(byName(landed), byName(storageOf(want)), 'the step lands on the file');
  }
  return p;
}
const codes = (p: { problems: { code: string }[] }) => p.problems.map((x) => x.code);
const kinds = (p: { changes: { kind: string }[] }) => p.changes.map((c) => c.kind);

const BASE = '  data products\n    name text required\n    price money usd\n    status choice draft live\n    allow anyone read\n';

test('the lock holds storage only: rules, private, locked and default are not in it', () => {
  const [t] = storageOf(tablesOf('  data notes\n    body text required private locked default "x"\n    allow anyone read\n'));
  assert.deepEqual(t, { name: 'notes', fields: [{ name: 'body', type: 'text', required: true, unique: false, index: true }] }, 'index: required text is sortable, so indexed');
});

test('every field the API sorts by is indexed, recorded in the lock (review #3, data-spec §4.5)', () => {
  const [t] = storageOf(tablesOf('  data notes\n    title text required\n    n number required\n    note text\n    flagged flag\n    code text required unique\n    allow anyone read\n'));
  assert.deepEqual(t.fields.map((f) => [f.name, f.index]), [['title', true], ['n', true], ['note', false], ['flagged', false], ['code', false]],
    'required sortable fields; not optional ones (never sortable), not a unique one (its own index)');
  // A lock written before this rule plans the index as a safe step.
  const old = [{ version: 1, ops: [{ op: 'createTable' as const, table: 'notes', fields: [{ name: 'title', type: 'text' as const, required: true, unique: false, index: false }] }] }];
  const p = plan(replay(old), tablesOf('  data notes\n    title text required\n    allow anyone read\n'), NO);
  assert.deepEqual([codes(p), kinds(p), p.changes[0].text], [[], ['safe'], 'notes.title gains its index']);
});

test('CONTROL: an unchanged file plans nothing', () => {
  const p = step(BASE, BASE);
  assert.deepEqual([p.ops, p.changes, p.problems, p.flagErrors], [[], [], [], []]);
});

test('CONTROL: changing rules, search, private, locked or a default needs no step', () => {
  const p = step(BASE, '  data products\n    name text required private locked default "n"\n    price money usd\n    status choice draft live default live\n    allow signedin read\n');
  assert.deepEqual(p.ops, []);
});

test('safe: a new table, a new optional field, a new choice value, an index', () => {
  const p = step(BASE, `${BASE.replace('draft live', 'draft live sold').replace('price money usd', 'price money usd index')}    blurb longtext\n  data tags\n    label text\n`);
  assert.deepEqual(codes(p), []);
  assert.ok(kinds(p).every((k) => k === 'safe'), JSON.stringify(p.changes));
  assert.deepEqual(p.ops.map((o) => o.op).sort(), ['addField', 'createTable', 'setField', 'setField']);
});

test('safe: a new required field with a default fills existing rows; a flag fills off', () => {
  const p = step(BASE, `${BASE}    sku text required default "none"\n    featured flag\n`);
  assert.deepEqual(codes(p), []);
  const fills = Object.fromEntries(p.ops.map((o) => [o.op === 'addField' ? o.field.name : '', 'fill' in o ? o.fill : undefined]));
  assert.deepEqual(fills, { sku: 'none', featured: false });
});

test('AZ1705: a new required field with no default', () => {
  assert.deepEqual(codes(step(BASE, `${BASE}    sku text required\n`)), ['AZ1705']);
});

test('AZ1705: an existing field made required with no default; with a default it is safe', () => {
  const after = BASE.replace('price money usd', 'price money usd required');
  assert.deepEqual(codes(step(BASE, after)), ['AZ1705']);
  const ok = step(BASE, BASE.replace('price money usd', 'price money usd required default 0'));
  assert.deepEqual(codes(ok), []);
  assert.deepEqual(ok.ops, [{ op: 'setField', table: 'products', field: { name: 'price', type: 'money', currency: 'usd', required: true, unique: false, index: true }, fill: 0 }]);
});

test('AZ1702: a dropped field needs --drop; with it the drop is destructive', () => {
  const after = BASE.replace('    price money usd\n', '');
  assert.deepEqual(codes(step(BASE, after)), ['AZ1702']);
  const p = step(BASE, after, flags({ drop: ['products.price'] }));
  assert.deepEqual([codes(p), kinds(p), p.ops], [[], ['destructive'], [{ op: 'dropField', table: 'products', field: 'price' }]]);
});

test('AZ1703: a field gone beside a new one of its type is never read as a rename', () => {
  const after = BASE.replace('name text required', 'title text required default "x"');
  assert.deepEqual(codes(step(BASE, after)), ['AZ1703']);
  const p = step(BASE, after, flags({ rename: ['products.name=title'] }));
  assert.deepEqual(codes(p), []);
  assert.deepEqual(p.ops, [{ op: 'renameField', table: 'products', field: 'name', to: 'title' }]);
  assert.deepEqual(kinds(p), ['destructive']);
});

test('tables: a vanished table is AZ1702, beside a new one AZ1703; --rename and --drop record them', () => {
  assert.deepEqual(codes(step(`${BASE}  data tags\n    label text\n`, BASE)), ['AZ1702']);
  const renamed = BASE.replace('data products', 'data items');
  assert.deepEqual(codes(step(BASE, renamed)), ['AZ1703']);
  const p = step(BASE, renamed, flags({ rename: ['products=items'] }));
  assert.deepEqual([codes(p), p.ops], [[], [{ op: 'renameTable', table: 'products', to: 'items' }]]);
  const d = step(`${BASE}  data tags\n    label text\n`, BASE, flags({ drop: ['tags'] }));
  assert.deepEqual([codes(d), d.ops], [[], [{ op: 'dropTable', table: 'tags' }]]);
});

test('a table rename carries the refs that point at it', () => {
  const before = `${BASE}  data reviews\n    product ref products\n`;
  const after = before.replace('data products', 'data items').replace('ref products', 'ref items');
  const p = step(before, after, flags({ rename: ['products=items'] }));
  assert.deepEqual(codes(p), []);
  assert.deepEqual(p.ops.map((o) => o.op), ['renameTable']);
});

test('AZ1704: type, currency and ref changes are refused', () => {
  assert.deepEqual(codes(step(BASE, BASE.replace('name text', 'name longtext'))), ['AZ1704']);
  assert.deepEqual(codes(step(BASE, BASE.replace('money usd', 'money eur'))), ['AZ1704']);
  const two = `${BASE}  data aa\n    x text\n  data bb\n    x text\n  data cc\n    r ref aa\n`;
  assert.deepEqual(codes(step(two, two.replace('r ref aa', 'r ref bb'))), ['AZ1704']);
});

test('a removed choice value needs --drop table.field.value', () => {
  const after = BASE.replace('draft live', 'draft published');
  assert.deepEqual(codes(step(BASE, after)), ['AZ1702']);
  const p = step(BASE, after, flags({ drop: ['products.status.live'] }));
  assert.deepEqual(codes(p), []);
  assert.ok(kinds(p).includes('destructive') && kinds(p).includes('safe'));
});

test('AZ1707: a field becoming unique needs --unique; dropping unique is safe', () => {
  const after = BASE.replace('name text required', 'name text required unique');
  assert.deepEqual(codes(step(BASE, after)), ['AZ1707']);
  const p = step(BASE, after, flags({ unique: ['products.name'] }));
  assert.deepEqual([codes(p), kinds(p)], [[], ['destructive', 'safe']], 'unique, and its sort index becomes the unique one');
  assert.deepEqual(kinds(step(after, BASE)), ['safe', 'safe']);
});

test('a cycle between new tables is created, then closed with an added field', () => {
  const p = step(BASE, `${BASE}  data aa\n    b ref bb\n  data bb\n    a ref aa\n`);
  assert.deepEqual(codes(p), []);
  assert.deepEqual(p.ops.map((o) => `${o.op} ${o.table}`), ['createTable aa', 'createTable bb', 'addField aa']);
});

test('dropping two tables that point at each other replays', () => {
  const before = `${BASE}  data aa\n    b ref bb\n  data bb\n    a ref aa\n`;
  const p = step(before, BASE, flags({ drop: ['aa', 'bb'] }));
  assert.deepEqual(codes(p), []);
});

test('flags that name nothing pending are usage errors', () => {
  const p = step(BASE, BASE, flags({ drop: ['products.nope'], rename: ['bad'], unique: ['products.name'] }));
  assert.equal(p.flagErrors.length, 3);
});

test('serialise → parse round-trips; the digest ignores key order and catches edits', () => {
  const steps = lockFor(BASE);
  const text = serialiseLock(steps, sha);
  assert.deepEqual(parseLock(text, sha).steps, steps);
  assert.equal(serialiseLock(steps, sha), text, 'deterministic');
  const reordered = JSON.parse(text);
  reordered.steps[0].ops[0] = Object.fromEntries(Object.entries(reordered.steps[0].ops[0]).reverse());
  assert.doesNotThrow(() => parseLock(JSON.stringify(reordered), sha));
  const edited = text.replace('"required": true', '"required": false');
  assert.notEqual(edited, text);
  assert.throws(() => parseLock(edited, sha), LockError);
});

test('a damaged lock is refused whatever the damage', () => {
  const good = JSON.parse(serialiseLock(lockFor(BASE), sha));
  // Correctly signed, so only the steps themselves can be at fault.
  const resign = (o: { steps: unknown[] }) => serialiseLock(o.steps as LockStep[], sha);
  const cases: string[] = [
    'not json',
    JSON.stringify({ ...good, format: 2 }),
    JSON.stringify({ ...good, extra: 1 }),
    resign({ steps: [{ version: 2, ops: good.steps[0].ops }] }),
    resign({ steps: [{ version: 1, ops: [{ op: 'explode', table: 'products' }] }] }),
    resign({ steps: [{ version: 1, ops: [{ op: 'dropTable', table: 'products' }] }] }),
    resign({ steps: [{ version: 1, ops: [{ op: 'createTable', table: 'p', fields: [{ name: 'x', type: 'blob', required: false, unique: false, index: false }] }] }] }),
    resign({ steps: [{ version: 1, ops: [{ op: 'createTable', table: 'p', fields: [{ name: 'x', type: 'ref', ref: 'nowhere', required: false, unique: false, index: false }] }] }] }),
  ];
  for (const c of cases) assert.throws(() => parseLock(c, sha), LockError, c.slice(0, 80));
});

const AT = { line: 3, col: 3 };
const NAMES = { source: 'site.az', lock: 'site.data.json' };

test('checkLock: AZ1701 for no lock, for a stale lock, and for a lock with no tables', () => {
  const tables = tablesOf(BASE);
  assert.deepEqual(checkLock(tables, null, NAMES, sha, AT).map((d) => d.code), ['AZ1701']);
  const lock = serialiseLock(lockFor(BASE), sha);
  assert.deepEqual(checkLock(tablesOf(`${BASE}    extra text\n`), lock, NAMES, sha, AT).map((d) => d.code), ['AZ1701']);
  assert.deepEqual(checkLock([], lock, NAMES, sha, AT).map((d) => d.code), ['AZ1701']);
  assert.match(checkLock(tables, null, NAMES, sha, AT)[0].message, /az backend plan site\.az, then az backend schema site\.az/);
});

test('checkLock: AZ1706 for a damaged lock', () => {
  assert.deepEqual(checkLock(tablesOf(BASE), '{"format":1', NAMES, sha, AT).map((d) => d.code), ['AZ1706']);
});

test('CONTROL: checkLock passes a matching lock, field order aside, and a site with neither', () => {
  const lock = serialiseLock(lockFor(BASE), sha);
  assert.deepEqual(checkLock(tablesOf(BASE), lock, NAMES, sha, AT), []);
  const reordered = '  data products\n    status choice draft live\n    price money usd\n    name text required\n';
  assert.deepEqual(checkLock(tablesOf(reordered), lock, NAMES, sha, AT), []);
  assert.deepEqual(checkLock([], null, NAMES, sha, AT), []);
});

test('compile runs the check only when given a lock, at the first data line', () => {
  const s = src(BASE);
  const lock = { text: null, source: 'site.az', name: 'site.data.json', digest: sha };
  const r = compile(s, { manifests, lock });
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.pos.line]), [['AZ1701', 8]]);
  assert.equal(r.ok, false);
  assert.deepEqual(compile(s, { manifests }).diagnostics.filter((d) => d.code.startsWith('AZ17')), [], 'CONTROL: no lock option, no check');
  const noData = compile(src(''), { manifests, lock });
  assert.equal(noData.ok, true, 'CONTROL: a site without data needs no lock');
});
