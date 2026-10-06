/**
 * The data tables against REAL PostgreSQL and MySQL (data-spec §14): every
 * migration kind up from empty, guards, a crashed step resumed, two
 * migrators at once, the rules and values through the data routes, the
 * admin routes and their audit (§11), image fields (§8: three columns
 * through every migration kind, upload, replace under a race, clear, delete
 * and the orphan sweep), a
 * unique race, foreign keys, keyset order, search case per engine — and
 * the spec's three INFERENCES settled on the engines themselves (CHECK on
 * MySQL, LOWER outside ASCII, a driver's `LIMIT ?`). Run by backend-db.mjs
 * inside its containers.
 */

import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWithin } from './lib/bounded.mjs';
import { createImages } from '../packages/backend/src/server/data-images.ts';
import { plainJpeg } from '../packages/backend/test/image-fixtures.ts';
import { compile, plan, replay } from '../packages/core/src/index.ts';
import { dataSteps } from '../packages/backend/src/data-ddl.ts';
import { DestructivePending, GuardFailed, migrateData } from '../packages/backend/src/server/data-migrate.ts';
import { createData } from '../packages/backend/src/server/data-api.ts';
import { loadTables } from '../packages/backend/src/server/data-values.ts';
import { isUniqueViolation } from '../packages/backend/src/server/db.ts';
import { selectList, parseQuery } from '../packages/backend/src/server/data-query.ts';

/** A database connection that will not close is abandoned after this (rule 13: bound every wait). */
const DB_CLOSE_MS = 15_000;

const wordsDir = new URL('../packages/words/', import.meta.url);
const manifests = new Map();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8'));
    manifests.set(m.name, m);
  }
}
const SITE = (data) => `az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n${data}page /\n  hero center\n    title "Hi"\n`;

/**
 * Lock steps for a sequence of revisions; the last revision's tables. A site
 * has one lock per database; these checks put several in one, so each after
 * the first starts at `from`, which also keeps their constraint names apart.
 */
function lockOf(revisions, from = 0) {
  const steps = [];
  let tables = [];
  for (const [data, flags = {}] of revisions) {
    const r = compile(SITE(data), { manifests });
    if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.diagnostics)}`);
    const p = plan(replay(steps), r.spec.site.data, { rename: [], drop: [], unique: [], ...flags });
    if (p.problems.length || p.flagErrors.length) throw new Error(`plan: ${JSON.stringify([p.problems, p.flagErrors])}`);
    if (p.ops.length) steps.push({ version: from + steps.length + 1, ops: p.ops });
    tables = r.spec.site.data;
  }
  return { steps: dataSteps(steps), tables: loadTables(JSON.parse(JSON.stringify({ tables }))) };
}

const columns = async (db, table) => (await db.all(
  `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ${db.dialect === 'postgres' ? 'current_schema()' : 'DATABASE()'} AND table_name = ? ORDER BY ordinal_position`, [table],
)).map((r) => r.c ?? r.C ?? r.COLUMN_NAME);

const FAST = { waitMs: 3_000, staleMs: 1_000, heartbeatMs: 200, pollMs: 25 };

const P1 = '  data products\n    name text required\n    price money usd required\n    status choice draft live\n    sku text\n'
  + '  data tags\n    label text unique\n    color choice red blue\n';
const P2 = `${P1}    shade text\n`.replace('    sku text\n', '    sku text\n    featured flag\n    note text required default "none"\n');
const REVISIONS = [
  [P1],
  [P2],
  [P2.replace('sku text', 'code text'), { rename: ['products.sku=code'] }],
  [P2.replace('    sku text\n', '').replace('data tags', 'data labels').replace('red blue', 'red green'),
    { rename: ['tags=labels'], drop: ['products.code', 'labels.color.blue'] }],
  [P2.replace('    sku text\n', '').replace('data tags', 'data labels').replace('red blue', 'red green').replace('name text required', 'name text required unique'),
    { unique: ['products.name'] }],
  [`${P2.replace('    sku text\n', '').replace('data tags', 'data labels').replace('red blue', 'red green').replace('name text required', 'name text required unique')}  data tags\n    title text unique\n`],
];

export async function dataSuite(engine, db, openAgain, check, info) {
  // ---- the spec's inferences, on the engine itself ----------------------
  await db.run('CREATE TABLE azt_check (v INTEGER, CHECK (v > 0))');
  let checked = false;
  try { await db.run('INSERT INTO azt_check (v) VALUES (?)', [-1]); } catch { checked = true; }
  await db.run('DROP TABLE azt_check');
  check(`${engine} INFERENCE: a CHECK constraint is enforced`, checked);
  try {
    const rows = await db.all('SELECT 1 AS x LIMIT ?', [5]);
    info(`${engine} INFERENCE: LIMIT as a bound parameter works (${rows.length} row)`);
  } catch (e) {
    info(`${engine} INFERENCE: LIMIT as a bound parameter is refused: ${e.code ?? e.name}`);
  }

  // ---- every migration kind, from empty ---------------------------------
  const { steps } = lockOf(REVISIONS);
  check(`${engine}: steps 3-5 are destructive`, steps.map((s) => s.destructive).join() === 'false,false,true,true,true,false');
  // A row from before step 2, which adds a required field with a default.
  await migrateData(db, steps.slice(0, 1));
  await db.run("INSERT INTO azd_products (id, owner, created, updated, name, price, status) VALUES ('p0', NULL, 1, 1, 'Lamp', 3, 'draft')");
  let refused = null;
  try { await migrateData(db, steps); } catch (e) { refused = e; }
  check(`${engine}: an unconfirmed destructive step stops the start, naming --confirm`, refused instanceof DestructivePending && /--migrate --confirm 5/.test(refused.message));
  check(`${engine}: the safe steps before it applied`, (await columns(db, 'azd_products')).includes('note'));
  await db.run("INSERT INTO azd_tags (id, owner, created, updated, label, color) VALUES ('t1', NULL, 1, 1, 'Hot', 'blue')");
  await db.run("INSERT INTO azd_products (id, owner, created, updated, name, price, status, note, featured) VALUES ('p1', NULL, 1, 1, 'Chair', 5, 'live', 'n', 0)");
  await db.run("INSERT INTO azd_products (id, owner, created, updated, name, price, status, note, featured) VALUES ('p2', NULL, 1, 1, 'Chair', 7, 'live', 'n', 0)");
  let guard = null;
  try { await migrateData(db, steps, { confirm: 5 }); } catch (e) { guard = e; }
  check(`${engine}: a removed choice still held is refused with a count`, guard instanceof GuardFailed && /removed choice \(blue\) — 1 row;/.test(guard.message), guard?.message);
  await db.run("UPDATE azd_labels SET color = 'red' WHERE id = 't1'");
  guard = null;
  try { await migrateData(db, steps, { confirm: 5 }); } catch (e) { guard = e; }
  check(`${engine}: a new unique over duplicates is refused with a count`, guard instanceof GuardFailed && /more than one row — 1 row/.test(guard.message), guard?.message);
  await db.run("UPDATE azd_products SET name = 'Stool' WHERE id = 'p2'");
  const applied = await migrateData(db, steps, { confirm: 5 });
  check(`${engine}: renames, drops, a unique, a reused table name all land`, applied.join() === '5,6', applied.join());
  check(`${engine}: the columns are the file's`, (await columns(db, 'azd_products')).join() === 'id,owner,created,updated,name,price,status,featured,note');
  check(`${engine}: the renamed table kept its rows`, (await db.get("SELECT label FROM azd_labels WHERE id = 't1'"))?.label === 'Hot');
  const p0 = await db.get("SELECT note, featured FROM azd_products WHERE id = 'p0'");
  check(`${engine}: a new field's fill reached the rows already there`, p0?.note === 'none' && Number(p0?.featured) === 0, JSON.stringify(p0));
  check(`${engine}: a new table took the renamed table's old name`, (await columns(db, 'azd_tags')).join() === 'id,owner,created,updated,title');
  let dup = false;
  try { await db.run("INSERT INTO azd_products (id, owner, created, updated, name, price, note) VALUES ('p3', NULL, 1, 1, 'Chair', 1, 'n')"); } catch (e) { dup = isUniqueViolation(e); }
  check(`${engine}: the new unique holds`, dup);
  check(`${engine}: applying again is a no-op`, (await migrateData(db, steps, { confirm: 5 })).length === 0);

  // ---- a crashed step resumes; two migrators at once --------------------
  // Versions offset so these locks never meet the main lock's history rows.
  const resume = lockOf([['  data crashed\n    title text\n    n number index\n']], 300).steps;
  await db.run(resume[0].units[engine][0].sql);
  await db.run('INSERT INTO az_data_migrations (version, step, claimed_at, applied_at) VALUES (?, ?, ?, NULL)', [301, 1, 1000]);
  const resumed = await migrateData(db, resume, { now: () => 1000 + FAST.staleMs + 1, timing: FAST });
  check(`${engine}: a crashed step (its CREATE landed, unrecorded) resumes past it`, (await columns(db, 'azd_crashed')).includes('n'), `applied ${resumed}`);

  const other = await openAgain();
  try {
    const conc = lockOf([['  data racea\n    title text unique\n  data raceb\n    a ref racea\n']], 100).steps;
    const results = await Promise.allSettled([migrateData(db, conc, { timing: FAST }), migrateData(other, conc, { timing: FAST })]);
    const units = conc.reduce((n, s) => n + s.units[engine].length, 0);
    const recorded = Number((await db.get('SELECT COUNT(*) AS n FROM az_data_migrations WHERE version BETWEEN 101 AND 199 AND applied_at IS NOT NULL')).n);
    check(`${engine}: two migrators at once — both finish, each unit recorded once`, results.every((r) => r.status === 'fulfilled') && recorded === units,
      `${results.map((r) => r.status)} ${recorded}/${units}`);
  } finally { await closeWithin(other, DB_CLOSE_MS, `${engine} second connection close`); }

  // ---- the routes, on this engine ---------------------------------------
  const shop = lockOf([[`  data items
    name text required search
    price money usd required
    sku text unique
    contact email private
    allow anyone read
    allow signedin create
    allow owner edit delete
  data notes
    item ref items required
    allow anyone read
    allow signedin create
`]], 200);
  await migrateData(db, shop.steps);
  const users = [randomUUID(), randomUUID()];
  for (const [i, id] of users.entries()) {
    await db.run('INSERT INTO az_users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)', [id, `u${i}@data.test`, `U${i}`]);
  }
  const api = createData({ db, tables: shop.tables });
  const call = (method, path, user, body) => api.handle({
    method, url: new URL(path, 'http://x'), ip: `10.0.0.${Math.floor(Math.random() * 250)}`,
    user: async () => user, body: async () => body,
  });
  const made = await call('POST', '/data/items', users[0], { name: "x'); DROP TABLE azd_items; --", price: 10, contact: 'a@data.test' });
  check(`${engine} API: create`, made.status === 201, JSON.stringify(made.body));
  const id = made.body.item.id;
  const asOther = await call('GET', `/data/items/${id}`, users[1]);
  check(`${engine} API: a private field is null for another account, the hostile name literal`,
    asOther.body.item.contact === null && asOther.body.item.name === "x'); DROP TABLE azd_items; --");
  check(`${engine} API: its owner reads it`, (await call('GET', `/data/items/${id}`, users[0])).body.item.contact === 'a@data.test');
  const foreign = await call('PATCH', `/data/items/${id}`, users[1], { price: 1 });
  const absent = await call('PATCH', `/data/items/${randomUUID()}`, users[1], { price: 1 });
  check(`${engine} API: another account's edit is answered like a missing row`, foreign.status === 404 && JSON.stringify(foreign) === JSON.stringify(absent));
  const race = await Promise.all([1, 2].map(() => call('POST', '/data/items', users[0], { name: 'r', price: 1, sku: 'SAME' })));
  check(`${engine} API: two creates with one unique value — one 201, one 409 taken`,
    race.map((r) => r.status).sort().join() === '201,409' && race.some((r) => r.body?.error === 'taken' && r.body?.field === 'sku'), race.map((r) => r.status).join());
  check(`${engine} API: a ref must exist`, (await call('POST', '/data/notes', users[1], { item: randomUUID() })).body?.field === 'item');
  check(`${engine} API: a note on the item`, (await call('POST', '/data/notes', users[1], { item: id })).status === 201);
  const inUse = await call('DELETE', `/data/items/${id}`, users[0]);
  check(`${engine} API: a referenced row is in_use`, inUse.status === 409 && inUse.body.error === 'in_use');
  for (let i = 0; i < 30; i++) await call('POST', '/data/items', users[0], { name: `k${i}`, price: i % 4 });
  const expected = (await db.all(`SELECT id, price FROM ${engine === 'mysql' ? '`azd_items`' : '"azd_items"'}`))
    .map((r) => ({ id: r.id, price: Number(r.price) }))
    .sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : 1)).map((r) => r.id);
  const walked = [];
  let next = null;
  do {
    const page = await call('GET', `/data/items?sort=price&limit=7${next ? `&after=${next}` : ''}`, null);
    walked.push(...page.body.items.map((x) => x.id));
    next = page.body.next;
  } while (next);
  check(`${engine} API: keyset pages walk every row once, in (price, id) order`, walked.join() === expected.join(), `${walked.length}/${expected.length}`);
  await call('POST', '/data/items', users[0], { name: 'ÄBC wool', price: 1 });
  await call('POST', '/data/items', users[0], { name: '100% wool', price: 1 });
  const hits = async (q) => (await call('GET', `/data/items?q=${encodeURIComponent(q)}`, null)).body.items.map((x) => x.name);
  check(`${engine} API: a literal % matches only %`, (await hits('0%')).join() === '100% wool');
  info(`${engine} INFERENCE: search 'äbc' finds 'ÄBC wool': ${(await hits('äbc')).length === 1 ? 'yes — LOWER folds beyond ASCII here' : 'no — LOWER is ASCII-only here'}`);
  check(`${engine} API: an unknown parameter is a 400 naming it`, (await call('GET', '/data/items?owner=x', null)).body.field === 'owner');

  // ---- the admin routes (data-spec §11), on this engine -----------------
  const boss = randomUUID();
  const unverified = randomUUID();
  await db.run('INSERT INTO az_users (id, email, name, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)', [boss, 'boss@data.test', 'Boss']);
  await db.run('INSERT INTO az_users (id, email, name, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)', [unverified, 'fake@data.test', 'Fake']);
  const accounts = new Map([[boss, { id: boss, email: 'boss@data.test', verified: true }], [unverified, { id: unverified, email: 'fake@data.test', verified: false }]]);
  let tick = Date.now();
  // A clock that moves per call, so the audit's newest-first order is decided by time, not by tie-break.
  const admin = createData({ db, tables: shop.tables, admins: ['boss@data.test', 'fake@data.test'], now: () => ++tick });
  const asAdmin = (method, path, who, body) => admin.handle({
    method, url: new URL(path, 'http://x'), ip: '10.0.1.1',
    user: async () => who, account: async () => accounts.get(who) ?? null, body: async () => body,
  });
  check(`${engine} ADMIN: a listed but unverified account is refused`, (await asAdmin('GET', '/admin/data', unverified)).status === 403);
  const tableList = await asAdmin('GET', '/admin/data', boss);
  const itemCount = Number((await db.get(`SELECT COUNT(*) AS n FROM ${engine === 'mysql' ? '`azd_items`' : '"azd_items"'}`)).n);
  check(`${engine} ADMIN: the table list counts every row`, tableList.status === 200 && tableList.body.tables.find((t) => t.name === 'items')?.count === itemCount, JSON.stringify(tableList.body));
  const adminWalk = [];
  let adminNext = null;
  const counts = new Set();
  do {
    const page = await asAdmin('GET', `/admin/data/items?sort=price&limit=7${adminNext ? `&after=${adminNext}` : ''}`, boss);
    adminWalk.push(...page.body.items.map((x) => x.id));
    counts.add(page.body.count);
    adminNext = page.body.next;
  } while (adminNext);
  const allIds = (await db.all(`SELECT id, price FROM ${engine === 'mysql' ? '`azd_items`' : '"azd_items"'}`))
    .map((r) => ({ id: r.id, price: Number(r.price) })).sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : 1)).map((r) => r.id);
  check(`${engine} ADMIN: keyset pages walk every row once (owner join included), count constant`, adminWalk.join() === allIds.join() && counts.size === 1 && [...counts][0] === allIds.length,
    `${adminWalk.length}/${allIds.length} counts ${[...counts]}`);
  const seen = await asAdmin('GET', `/admin/data/items/${id}`, boss);
  check(`${engine} ADMIN: a row shows its private field and its owner's address`, seen.body.item.contact === 'a@data.test' && seen.body.item.ownerEmail === 'u0@data.test', JSON.stringify(seen.body));
  const searched = await asAdmin('GET', `/admin/data/items?q=${encodeURIComponent('0%')}&contact=a@data.test`, boss);
  check(`${engine} ADMIN: search and a private filter, count following them`, searched.status === 200 && searched.body.count === 0, JSON.stringify(searched.body));
  const SECRET = 'audit-must-not-hold-this';
  const edited = await asAdmin('PATCH', `/admin/data/items/${id}`, boss, { name: SECRET, contact: 'b@data.test' });
  check(`${engine} ADMIN: edits another account's row; the owner stays`, edited.status === 200 && edited.body.item.ownerEmail === 'u0@data.test', JSON.stringify(edited.body));
  const badEdit = await asAdmin('PATCH', `/admin/data/items/${id}`, boss, { price: -5 });
  check(`${engine} ADMIN: validation still holds`, badEdit.status === 400 && badEdit.body.field === 'price');
  const created = await asAdmin('POST', '/admin/data/items', boss, { name: 'by admin', price: 2, sku: 'SAME' });
  check(`${engine} ADMIN: a unique still holds for an admin`, created.status === 409 && created.body.error === 'taken');
  const made2 = await asAdmin('POST', '/admin/data/items', boss, { name: 'by admin', price: 2 });
  check(`${engine} ADMIN: create is owned by the admin`, made2.status === 201 && made2.body.item.ownerEmail === 'boss@data.test');
  check(`${engine} ADMIN: delete`, (await asAdmin('DELETE', `/admin/data/items/${made2.body.item.id}`, boss)).status === 204);
  const auditRows = await db.all('SELECT * FROM az_data_audit');
  check(`${engine} ADMIN: three audit rows, no value in any`, auditRows.length === 3 && !JSON.stringify(auditRows).includes(SECRET) && !JSON.stringify(auditRows).includes('b@data.test'), JSON.stringify(auditRows.map((r) => r.action)));
  const audit1 = await asAdmin('GET', '/admin/audit?limit=2', boss);
  const audit2 = await asAdmin('GET', `/admin/audit?limit=2&after=${audit1.body.next}`, boss);
  check(`${engine} ADMIN: the audit pages newest first, naming the admin`,
    [...audit1.body.items, ...audit2.body.items].map((x) => x.action).join() === 'delete,create,edit' && audit2.body.next === null && audit1.body.items[0].admin === 'boss@data.test',
    JSON.stringify([audit1.body, audit2.body]));

  // ---- image fields (data-spec §4.3, §8), on this engine -----------------
  const pics = lockOf([
    ['  data pics\n    title text\n    photo image\n    allow anyone read\n    allow signedin create\n    allow owner edit delete\n'],
    ['  data pics\n    title text\n    photo image\n    proof image private\n    allow anyone read\n    allow signedin create\n    allow owner edit delete\n'],
    ['  data pics\n    title text\n    picture image\n    proof image private\n    allow anyone read\n    allow signedin create\n    allow owner edit delete\n', { rename: ['pics.photo=picture'] }],
    ['  data pics\n    title text\n    picture image\n    gone image\n    proof image private\n    allow anyone read\n    allow signedin create\n    allow owner edit delete\n'],
    ['  data pics\n    title text\n    picture image\n    proof image private\n    allow anyone read\n    allow signedin create\n    allow owner edit delete\n', { drop: ['pics.gone'] }],
  ], 400);
  await migrateData(db, pics.steps, { confirm: Infinity });
  check(`${engine} IMAGES: three columns per image through create, add, rename and drop`,
    (await columns(db, 'azd_pics')).join() === 'id,owner,created,updated,title,picture,picture__w,picture__h,proof,proof__w,proof__h', (await columns(db, 'azd_pics')).join());
  const dir = mkdtempSync(join(tmpdir(), `az-db-images-${engine}-`));
  const images = await createImages({ dir });
  const gallery = createData({ db, tables: pics.tables, images, publicUrl: 'https://api.data.test' });
  const stored = () => readdirSync(dir).filter((n) => n.endsWith('.webp'));
  const send = (method, path, user, bytes) => gallery.handle({
    method, url: new URL(path, 'http://x'), ip: '10.0.2.1', user: async () => user, body: async () => ({}),
    upload: async (_limit, to) => { writeFileSync(to, bytes); },
  });
  const pic = await send('POST', '/data/pics', users[0]);
  const pid = pic.body?.item?.id;
  check(`${engine} IMAGES: a row is created without its image`, pic.status === 201 && pic.body.item.picture === null, JSON.stringify(pic.body));
  const up = await send('PUT', `/data/pics/${pid}/picture`, users[0], await plainJpeg(300, 200));
  const row = await db.get(`SELECT ${['picture', 'picture__w', 'picture__h'].map((c) => (engine === 'mysql' ? `\`${c}\`` : `"${c}"`)).join(', ')} FROM ${engine === 'mysql' ? '`azd_pics`' : '"azd_pics"'} WHERE id = ?`, [pid]);
  check(`${engine} IMAGES: upload stores the key and size; the API answers { url, width, height }`,
    up.status === 200 && up.body.item.picture.width === 300 && Number(row.picture__w) === 300 && Number(row.picture__h) === 200
      && /^[0-9a-f-]{36}\.webp$/.test(row.picture) && up.body.item.picture.url === `https://api.data.test/data/pics/${pid}/picture?v=${row.picture.slice(0, 36)}`,
    JSON.stringify([up.status, row]));
  const both = await Promise.all([300, 400].map(async (w) => send('PUT', `/data/pics/${pid}/picture`, users[0], await plainJpeg(w, 100))));
  const after = await db.get(`SELECT ${engine === 'mysql' ? '`picture`' : '"picture"'} AS k FROM ${engine === 'mysql' ? '`azd_pics`' : '"azd_pics"'} WHERE id = ?`, [pid]);
  check(`${engine} IMAGES: two replacements at once — both answered, one file left, the one the row names`,
    both.every((r) => r.status === 200) && stored().length === 1 && stored()[0] === after.k, `${both.map((r) => r.status)} ${stored()} ${after.k}`);
  const theirs = await send('PUT', `/data/pics/${pid}/picture`, users[1], await plainJpeg(10, 10));
  check(`${engine} IMAGES: another account's upload is 404 and stores nothing`, theirs.status === 404 && stored().length === 1);
  await send('PUT', `/data/pics/${pid}/proof`, users[0], await plainJpeg(10, 10));
  const read = (user, field, v) => gallery.handle({ method: 'GET', url: new URL(`/data/pics/${pid}/${field}${v ? `?v=${v}` : ''}`, 'http://x'), ip: '10.0.2.2', user: async () => user });
  const proofKey = (await db.get(`SELECT ${engine === 'mysql' ? '`proof`' : '"proof"'} AS k FROM ${engine === 'mysql' ? '`azd_pics`' : '"azd_pics"'} WHERE id = ?`, [pid])).k;
  const own = await read(users[0], 'proof', proofKey.slice(0, 36));
  check(`${engine} IMAGES: a private image — its owner reads it (never shared), others get 404`,
    own.status === 200 && own.file?.shared === false && (await read(users[1], 'proof')).status === 404 && (await read(null, 'proof')).status === 404);
  const pub = await read(null, 'picture', after.k.slice(0, 36));
  check(`${engine} IMAGES: a public image under its current version is shared (immutable)`, pub.status === 200 && pub.file?.shared === true);
  const cleared = await send('DELETE', `/data/pics/${pid}/picture`, users[0]);
  check(`${engine} IMAGES: clear nulls the three columns and removes the file`, cleared.status === 200 && cleared.body.item.picture === null && stored().length === 1);
  const removed = await send('DELETE', `/data/pics/${pid}`, users[0]);
  check(`${engine} IMAGES: deleting the row removes its remaining image`, removed.status === 204 && stored().length === 0, `${removed.status} ${stored()}`);
  const temp = images.tempPath();
  writeFileSync(temp, await plainJpeg(10, 10));
  await images.store(temp);
  check(`${engine} IMAGES: the sweep keeps a young orphan (its row may be on the way)`, (await gallery.sweepImages()) === 0 && stored().length === 1);

  if (engine === 'postgres') {
    await db.run(`INSERT INTO azd_items (id, owner, created, updated, name, price)
      SELECT md5(g::text)::uuid::text, NULL, g, g, 'bulk', g % 50 FROM generate_series(1, 5000) AS g`);
    await db.run('ANALYZE azd_items');
    const table = shop.tables.find((t) => t.name === 'items');
    const lq = parseQuery(table, new URLSearchParams(''), false);
    const s = selectList('postgres', table, lq, null, false);
    const planText = (await db.all(`EXPLAIN ${s.sql}`, s.params)).map((r) => r['QUERY PLAN']).join('\n');
    check('postgres: the default page reads the created index under a LIMIT, not the table', /Limit/.test(planText) && /Index Scan Backward using/.test(planText) && !/Seq Scan/.test(planText), planText.split('\n')[1]?.trim());
  }
}
