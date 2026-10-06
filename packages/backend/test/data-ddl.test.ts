/**
 * The lock as SQL (data-ddl.ts) applied by the server (data-migrate.ts), on
 * SQLite: every op kind lands, values never appear in SQL text, destructive
 * steps wait for confirmation, guards stop a change that would break rows,
 * a crashed step resumes, and two instances apply each unit once. The same
 * steps run on PostgreSQL and MySQL in scripts/backend-db.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, plan, replay, type LockFlags, type LockStep, type Manifest } from '../../core/src/index.ts';
import { dataSteps } from '../src/data-ddl.ts';
import { migrate, openSqlite, type Db } from '../src/server/db.ts';
import { AUDIT_STEP, DestructivePending, GuardFailed, migrateData } from '../src/server/data-migrate.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}
const SITE = (data: string) => `az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n${data}page /\n  hero center\n    title "Hi"\n`;

/** Lock steps for a sequence of file revisions, each with its flags. */
function lockOf(revisions: readonly (readonly [string, Partial<LockFlags>?])[]): LockStep[] {
  const steps: LockStep[] = [];
  for (const [data, flags] of revisions) {
    const r = compile(SITE(data), { manifests });
    assert.ok(r.ok, JSON.stringify(r.diagnostics));
    const p = plan(replay(steps), r.spec!.site.data ?? [], { rename: [], drop: [], unique: [], ...flags });
    assert.deepEqual([p.problems, p.flagErrors], [[], []]);
    if (p.ops.length > 0) steps.push({ version: steps.length + 1, ops: p.ops });
  }
  return steps;
}

const FAST = { waitMs: 400, staleMs: 150, heartbeatMs: 30, pollMs: 10 };
async function fresh(path = join(mkdtempSync(join(tmpdir(), 'az-ddl-')), 'db.sqlite')): Promise<Db> {
  const db = await openSqlite(path);
  await migrate(db);
  return db;
}
const columns = async (db: Db, table: string) =>
  (await db.all('SELECT name FROM pragma_table_info(?) ORDER BY cid', [table])).map((r) => r.name);

const V1 = '  data products\n    name text required\n    price money usd\n    status choice draft live\n    sku text\n';

test('determinism: the same lock gives the same SQL, byte for byte', () => {
  const lock = lockOf([[V1]]);
  assert.equal(JSON.stringify(dataSteps(lock)), JSON.stringify(dataSteps(lock)));
});

/** Every unquoted word the DDL may contain: keywords, types, `n` (the guard's count alias). */
const SQL_WORDS = new Set(('CREATE TABLE INDEX UNIQUE ON ALTER ADD COLUMN DROP RENAME TO UPDATE SET WHERE IS NULL NOT '
  + 'PRIMARY KEY CONSTRAINT FOREIGN REFERENCES DELETE CASCADE RESTRICT TEXT INTEGER BIGINT SMALLINT TINYINT VARCHAR CHAR '
  + 'CHECK IN length SELECT COUNT AS FROM GROUP BY HAVING ENGINE InnoDB DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_bin ID n').split(' '));

test('no value is ever SQL text: identifiers quoted, the only literals are the fixed type caps', () => {
  const lock = lockOf([
    [V1],
    [`${V1}    featured flag default on\n    due date\n    link url\n    body longtext\n    contact email unique\n    photo image\n  data reviews\n    product ref products\n`],
  ]);
  const caps = new Set(['200', '10000', '254', '2048', '63', '10', '0', '1', '36', '80']);
  for (const step of dataSteps(lock)) {
    for (const [engine, units] of Object.entries(step.units)) {
      for (const u of units) {
        for (const sql of [u.sql, u.guard?.sql].filter((s): s is string => s !== undefined)) {
          const bare = sql.replace(/"[a-z0-9_]+"|`[a-z0-9_]+`/g, 'ID');
          assert.ok(!/'/.test(bare), `${engine}: no string literal in ${sql}`);
          for (const n of bare.match(/\b\d+\b/g) ?? []) assert.ok(caps.has(n), `${engine}: literal ${n} in ${sql}`);
          for (const w of bare.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) assert.ok(SQL_WORDS.has(w), `${engine}: bare word '${w}' in ${sql}`);
        }
      }
    }
  }
});

test('create, add with a fill, rename, drop: every op lands on SQLite and the data survives', async () => {
  const db = await fresh();
  const steps = dataSteps(lockOf([
    [V1],
    [`${V1}    featured flag\n    note text required default "none"\n`],
    [`${V1.replace('sku text', 'code text')}    featured flag\n    note text required default "none"\n`, { rename: ['products.sku=code'] }],
    [`${V1.replace('    sku text\n', '').replace('data products', 'data items')}    featured flag\n    note text required default "none"\n`, { rename: ['products=items'], drop: ['items.code'] }],
  ]));
  await migrateData(db, steps.slice(0, 1));
  await db.run('INSERT INTO azd_products (id, owner, created, updated, name, price, status, sku) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)', ['r1', 1, 1, 'Chair', 1999, 'draft', 'C-1']);
  assert.deepEqual(await migrateData(db, steps, { confirm: Infinity }), [2, 3, 4]);
  assert.deepEqual(await columns(db, 'azd_items'), ['id', 'owner', 'created', 'updated', 'name', 'price', 'status', 'featured', 'note']);
  assert.deepEqual({ ...(await db.get('SELECT name, featured, note FROM azd_items WHERE id = ?', ['r1'])) }, { name: 'Chair', featured: 0, note: 'none' });
  assert.deepEqual(await migrateData(db, steps, { confirm: Infinity }), [], 'CONTROL: nothing left to apply');
  await db.close();
});

test('an image is three columns — key, width, height — through create, add, rename and drop (data-spec §4.3)', async () => {
  const db = await fresh();
  const steps = dataSteps(lockOf([
    [`${V1}    photo image\n`],
    [`${V1}    photo image\n    back image\n`],
    [`${V1}    picture image\n    back image\n`, { rename: ['products.photo=picture'] }],
    [`${V1}    picture image\n`, { drop: ['products.back'] }],
  ]));
  const base = ['id', 'owner', 'created', 'updated', 'name', 'price', 'status', 'sku'];
  await migrateData(db, steps.slice(0, 1));
  assert.deepEqual(await columns(db, 'azd_products'), [...base, 'photo', 'photo__w', 'photo__h']);
  await db.run('INSERT INTO azd_products (id, owner, created, updated, name, photo, photo__w, photo__h) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)', ['r1', 1, 1, 'Chair', 'k.webp', 640, 480]);
  await migrateData(db, steps.slice(0, 2));
  assert.deepEqual(await columns(db, 'azd_products'), [...base, 'photo', 'photo__w', 'photo__h', 'back', 'back__w', 'back__h']);
  await migrateData(db, steps, { confirm: Infinity });
  assert.deepEqual(await columns(db, 'azd_products'), [...base, 'picture', 'picture__w', 'picture__h']);
  assert.deepEqual({ ...(await db.get('SELECT picture, picture__w, picture__h FROM azd_products WHERE id = ?', ['r1'])) }, { picture: 'k.webp', picture__w: 640, picture__h: 480 });
  // One unit per column on every engine, each with its own probe, so a crash resumes per column.
  const add = steps[1].units;
  for (const d of ['sqlite', 'postgres', 'mysql'] as const) {
    assert.deepEqual(add[d].map((u) => u.probe && 'name' in u.probe ? u.probe.name : null), ['back', 'back__w', 'back__h'], d);
  }
  assert.match(add.postgres[0].sql!, /"back" VARCHAR\(80\)$/);
  await db.close();
});

test('a destructive step waits for --confirm; the safe steps before it apply', async () => {
  const db = await fresh();
  const steps = dataSteps(lockOf([
    [V1],
    [`${V1}    extra text\n`],
    [V1.replace('    sku text\n', ''), { drop: ['products.sku', 'products.extra'] }],
  ]));
  assert.deepEqual(steps.map((s) => s.destructive), [false, false, true]);
  await assert.rejects(migrateData(db, steps), (e: unknown) => e instanceof DestructivePending && /--migrate --confirm 3/.test(e.message));
  assert.ok((await columns(db, 'azd_products')).includes('extra'), 'step 2 applied');
  assert.ok((await columns(db, 'azd_products')).includes('sku'), 'step 3 not applied');
  await assert.rejects(migrateData(db, steps, { confirm: 2 }), DestructivePending);
  assert.deepEqual(await migrateData(db, steps, { confirm: 3 }), [3]);
  assert.ok(!(await columns(db, 'azd_products')).includes('sku'));
  await db.close();
});

test('guards: a removed choice still held, or a new unique with duplicates, stops with a count and releases the claim', async () => {
  const db = await fresh();
  const steps = dataSteps(lockOf([
    [V1],
    [V1.replace('draft live', 'draft published').replace('sku text', 'sku text unique'), { drop: ['products.status.live'], unique: ['products.sku'] }],
  ]));
  await migrateData(db, steps.slice(0, 1));
  const row = (id: string, status: string, sku: string) =>
    db.run('INSERT INTO azd_products (id, owner, created, updated, name, status, sku) VALUES (?, NULL, 1, 1, ?, ?, ?)', [id, 'x', status, sku]);
  await row('a', 'live', 'S');
  await row('b', 'draft', 'S');
  await assert.rejects(migrateData(db, steps, { confirm: 2 }), (e: unknown) => e instanceof GuardFailed && /removed choice \(live\) — 1 row;/.test(e.message) && !/'live'/.test(e.message));
  assert.equal((await db.all('SELECT * FROM az_data_migrations WHERE applied_at IS NULL')).length, 0, 'claim released');
  await db.run("UPDATE azd_products SET status = 'draft' WHERE id = 'a'");
  await assert.rejects(migrateData(db, steps, { confirm: 2 }), (e: unknown) => e instanceof GuardFailed && /more than one row — 1 row/.test(e.message));
  await db.run("UPDATE azd_products SET sku = 'T' WHERE id = 'a'");
  assert.deepEqual(await migrateData(db, steps, { confirm: 2 }), [2]);
  await assert.rejects(row('c', 'draft', 'T'), /UNIQUE/);
  await db.close();
});

test('a crashed instance: its half-done step resumes past the statement that landed', async () => {
  const db = await fresh();
  const [step] = dataSteps(lockOf([[V1]]));
  await db.run('CREATE TABLE IF NOT EXISTS az_data_migrations (version INTEGER NOT NULL, step INTEGER NOT NULL, claimed_at INTEGER NOT NULL, applied_at INTEGER, PRIMARY KEY (version, step))');
  // The crash: unit 1 (CREATE TABLE) ran and was claimed but never recorded.
  await db.run(step.units.sqlite[0].sql!);
  await db.run('INSERT INTO az_data_migrations (version, step, claimed_at, applied_at) VALUES (1, 1, 1000, NULL)');
  assert.deepEqual(await migrateData(db, [step], { now: () => 1000 + FAST.staleMs + 1, timing: FAST }), [1]);
  // Version 0 is the server's own audit table (data-spec §11), applied alongside.
  const recorded = await db.all('SELECT step FROM az_data_migrations WHERE applied_at IS NOT NULL AND version > 0');
  assert.equal(recorded.length, step.units.sqlite.length);
  await db.close();
});

test('two instances starting together apply each unit exactly once', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'az-ddl-')), 'db.sqlite');
  const [a, b] = [await fresh(path), await openSqlite(path)];
  const steps = dataSteps(lockOf([[V1], [`${V1}    extra text\n  data tags\n    label text unique\n`]]));
  const [ra, rb] = await Promise.all([migrateData(a, steps, { timing: FAST }), migrateData(b, steps, { timing: FAST })]);
  assert.ok(ra.length + rb.length >= 2, `a ran ${ra}, b ran ${rb}`);
  const units = steps.reduce((n, s) => n + s.units.sqlite.length, 0);
  assert.equal(Number((await a.get('SELECT COUNT(*) AS n FROM az_data_migrations WHERE applied_at IS NOT NULL AND version > 0'))!.n), units);
  // The audit table's own step is claimed like any other: applied once, not twice.
  assert.equal(Number((await a.get('SELECT COUNT(*) AS n FROM az_data_migrations WHERE applied_at IS NOT NULL AND version = 0'))!.n),
    AUDIT_STEP.units.sqlite.length);
  await a.close();
  await b.close();
});

test('the admin audit table is created on start, as system step 0, before the site\'s steps', async () => {
  const db = await fresh();
  const steps = dataSteps(lockOf([[V1]]));
  assert.deepEqual(await migrateData(db, steps), [1], 'only the site\'s steps are reported');
  assert.deepEqual(await columns(db, 'az_data_audit'), ['id', 'admin', 'tbl', 'row_id', 'action', 'at']);
  assert.deepEqual(await migrateData(db, steps), [], 'CONTROL: a second start applies nothing');
  await db.close();
});

test('a renamed table frees its name: a new table may take it', async () => {
  const db = await fresh();
  const steps = dataSteps(lockOf([
    [V1],
    [V1.replace('data products', 'data items'), { rename: ['products=items'] }],
    [`${V1.replace('data products', 'data items')}  data products\n    title text unique\n`],
  ]));
  assert.deepEqual(await migrateData(db, steps, { confirm: Infinity }), [1, 2, 3]);
  assert.deepEqual(await columns(db, 'azd_products'), ['id', 'owner', 'created', 'updated', 'title']);
  await db.close();
});

test('foreign keys: a ref target in use cannot be deleted; deleting the owner account removes its rows', async () => {
  const db = await fresh();
  const steps = dataSteps(lockOf([[`${V1}  data reviews\n    product ref products\n`]]));
  await migrateData(db, steps);
  await db.run("INSERT INTO az_users (id, email, name, created_at, updated_at) VALUES ('u1', 'a@b.cd', 'A', 1, 1)");
  await db.run("INSERT INTO azd_products (id, owner, created, updated, name) VALUES ('p1', 'u1', 1, 1, 'x')");
  await db.run("INSERT INTO azd_reviews (id, owner, created, updated, product) VALUES ('r1', NULL, 1, 1, 'p1')");
  await assert.rejects(db.run("DELETE FROM azd_products WHERE id = 'p1'"), /FOREIGN KEY/);
  await db.run("DELETE FROM azd_reviews WHERE id = 'r1'");
  await db.run("DELETE FROM az_users WHERE id = 'u1'");
  assert.equal((await db.all('SELECT id FROM azd_products')).length, 0, 'owner cascade');
  await db.close();
});
