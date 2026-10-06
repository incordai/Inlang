/**
 * The /admin routes over SQLite (data-spec §11, §13, §14): who is an admin
 * (verified AND listed, decided before any table is looked up), rules
 * bypassed but validation never, the audit table holding no values, CSRF and
 * CORS on admin writes, no table enumeration, the admin limits — each with a
 * control showing the same request works for the right caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, startBackend, type Harness } from './helpers.ts';
import { dataOf } from './data-fixture.ts';
import { parseAdminEmails } from '../src/server/data-api.ts';

const GOOD = 'a-long-enough-password';
const MINUTE = 60 * 1000;

const SHOP = `  data products
    name     text     required search
    price    money    usd required
    stock    number   default 0 locked
    status   choice   draft live sold default draft
    contact  email    private
    allow anyone read
    allow signedin create
    allow owner edit delete
  data reviews
    product  ref      products required
    stars    number   required
    allow anyone read
    allow signedin create
    allow owner edit delete
  data waitlist
    email    email    required private
    allow anyone create
  data notes
    body     text     required
`;

type Client = ReturnType<typeof client>;

async function signUp(h: Harness, name: string, verified: boolean): Promise<{ c: Client; id: string; email: string }> {
  const c = client(h.url);
  const email = `${name.toLowerCase()}@studio.test`;
  const r = await c.post('/auth/sign-up', { name, email, password: GOOD, passwordConfirm: GOOD });
  assert.equal(r.status, 200);
  const id = ((await r.json()) as { session: { user: { id: string } } }).session.user.id;
  // The verification link itself is covered by backend.test.ts; here only its outcome matters.
  if (verified) await h.db.run('UPDATE az_users SET email_verified = 1 WHERE id = ?', [id]);
  return { c, id, email };
}

/** A shop whose admin list holds `boss` (verified) and `fake` (never verified). */
async function shop(admins: readonly string[] = ['boss@studio.test', 'fake@studio.test']) {
  const h = await startBackend({}, { data: dataOf(SHOP), admins });
  const boss = await signUp(h, 'Boss', true);
  const fake = await signUp(h, 'Fake', false);
  const ana = await signUp(h, 'Ana', true);
  const r = await ana.c.request('POST', '/data/products', { name: 'Chair', price: 1999, contact: 'ana@studio.test' });
  assert.equal(r.status, 201);
  const chair = ((await r.json()) as { item: { id: string } }).item.id;
  return { h, boss, fake, ana, chair };
}

const body = async (r: Response) => (r.status === 204 ? null : r.json()) as Promise<Record<string, unknown>>;

test('AZ_ADMIN_EMAILS: lower-cased, deduplicated, empty allowed; a malformed entry is named', () => {
  assert.deepEqual(parseAdminEmails(' Boss@Studio.test , boss@studio.test,b@x.test '), { ok: true, emails: ['b@x.test', 'boss@studio.test'] });
  assert.deepEqual(parseAdminEmails(undefined), { ok: true, emails: [] });
  assert.deepEqual(parseAdminEmails(''), { ok: true, emails: [] });
  const bad = parseAdminEmails('boss@studio.test,not-an-address');
  assert.equal(bad.ok, false);
  assert.match((bad as { problem: string }).problem, /'not-an-address' is not an email address/);
});

test('SECURITY admin takeover: only a verified, listed account is an admin; the check is on the server', async () => {
  const { h, boss, fake, ana } = await shop();
  try {
    const out = client(h.url);
    assert.deepEqual([(await out.get('/admin/data')).status, await body(await out.get('/admin/data'))], [401, { error: 'signin_required' }]);
    assert.deepEqual(await body(await fake.c.get('/admin/data')), { error: 'forbidden' }, 'listed but unverified is not an admin');
    assert.equal((await fake.c.get('/admin/data')).status, 403);
    assert.equal((await ana.c.get('/admin/data')).status, 403, 'verified but unlisted is not an admin');
    for (const c of [fake.c, ana.c]) {
      assert.equal((await c.request('POST', '/admin/data/products', { name: 'x', price: 1 })).status, 403);
      assert.equal((await c.get('/admin/audit')).status, 403);
    }
    const ok = await boss.c.get('/admin/data');
    assert.equal(ok.status, 200, 'CONTROL: the verified, listed account is an admin');
    assert.deepEqual(await ok.json(), { tables: [{ name: 'products', count: 1 }, { name: 'reviews', count: 0 }, { name: 'waitlist', count: 0 }, { name: 'notes', count: 0 }] });
    // Verifying the listed address later makes it an admin — the list is read per request.
    await h.db.run('UPDATE az_users SET email_verified = 1 WHERE id = ?', [fake.id]);
    assert.equal((await fake.c.get('/admin/data')).status, 200, 'CONTROL: verified now');
  } finally { await h.close(); }
});

test('SECURITY an empty AZ_ADMIN_EMAILS: the admin routes answer 403 to everyone', async () => {
  const { h, boss } = await shop([]);
  try {
    assert.deepEqual([(await boss.c.get('/admin/data')).status, await body(await boss.c.get('/admin/data'))], [403, { error: 'forbidden' }]);
    assert.equal((await client(h.url).get('/admin/data/products')).status, 403, 'not even a sign-in prompt');
    assert.equal((await boss.c.get('/data/products')).status, 200, 'CONTROL: the public routes still serve');
  } finally { await h.close(); }
});

test('SECURITY enumeration: a non-admin gets one answer whether or not a table exists', async () => {
  const { h, boss, ana } = await shop();
  try {
    const paths = ['/admin/data/products', '/admin/data/nosuch', '/admin/data/notes/00000000-0000-4000-8000-000000000001', '/admin/data/x/y/z/w', '/admin/audit'];
    for (const p of paths) {
      const r = await ana.c.get(p);
      assert.deepEqual([r.status, await r.json()], [403, { error: 'forbidden' }], p);
    }
    assert.equal((await boss.c.get('/admin/data/nosuch')).status, 404, 'CONTROL: an admin learns a table is absent');
    assert.equal((await boss.c.get('/admin/data/products')).status, 200);
  } finally { await h.close(); }
});

test('admin list: every row, private fields, the owner\'s address, a total count across pages', async () => {
  const { h, boss, ana, chair } = await shop();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await ana.c.request('POST', '/data/products', { name: `Stool ${i}`, price: 500 + i })).status, 201);
    const pub = (await body(await client(h.url).get('/data/products'))) as { items: Record<string, unknown>[] };
    assert.equal(pub.items.find((x) => x.id === chair)!.contact, null, 'CONTROL: the public list hides a private field');

    const first = await body(await boss.c.get('/admin/data/products?limit=2&sort=name'));
    assert.equal(first.count, 5);
    const items = first.items as Record<string, unknown>[];
    assert.deepEqual(items.map((x) => x.name), ['Chair', 'Stool 0']);
    assert.deepEqual([items[0].contact, items[0].ownerEmail, items[0].mine], ['ana@studio.test', 'ana@studio.test', false]);
    const second = await body(await boss.c.get(`/admin/data/products?limit=2&sort=name&after=${first.next as string}`));
    assert.deepEqual([(second.items as Record<string, unknown>[]).map((x) => x.name), second.count], [['Stool 1', 'Stool 2'], 5]);

    const filtered = await body(await boss.c.get('/admin/data/products?q=stool&contact=ana@studio.test'));
    assert.deepEqual([filtered.count, filtered.items], [0, []], 'filters on a private field, and count follows the filters');
    assert.equal((await body(await boss.c.get('/admin/data/products?contact=ana@studio.test'))).count, 1);
    assert.equal((await ana.c.get('/data/products?contact=ana@studio.test')).status, 400, 'CONTROL: the public list refuses a private filter');

    const one = await body(await boss.c.get(`/admin/data/products/${chair}`));
    assert.deepEqual([(one.item as Record<string, unknown>).name, (one.item as Record<string, unknown>).ownerEmail], ['Chair', 'ana@studio.test']);
    // Allow-listed parameters, as on the public routes.
    for (const q of ['?evil=1', '?sort=contact', '?sort=name;drop', '?limit=101', '?after=x', '?q=a', '?limit=2&limit=3']) {
      const r = await boss.c.get(`/admin/data/products${q}`);
      assert.equal(r.status, 400, q);
      assert.equal((await body(r)).error, 'bad_query');
    }
    assert.deepEqual(await body(await boss.c.get(`/admin/data/products/${chair}?x=1`)), { error: 'bad_query', field: 'x' });
    assert.deepEqual(await body(await boss.c.get('/admin/data?x=1')), { error: 'bad_query', field: 'x' });
  } finally { await h.close(); }
});

test('admin writes: rules bypassed — locked fields, others\' rows, tables with no allow lines', async () => {
  const { h, boss, ana, chair } = await shop();
  try {
    const created = await boss.c.request('POST', '/admin/data/products', { name: 'Desk', price: 9900, stock: 3 });
    assert.equal(created.status, 201);
    const desk = ((await created.json()) as { item: Record<string, unknown> }).item;
    assert.deepEqual([desk.stock, desk.mine, desk.ownerEmail], [3, true, 'boss@studio.test'], 'a locked field, owned by the admin');
    assert.equal((await ana.c.request('POST', '/data/products', { name: 'Desk', price: 1, stock: 3 })).status, 400, 'CONTROL: the public route refuses a locked field');

    const edited = await boss.c.request('PATCH', `/admin/data/products/${chair}`, { status: 'live', stock: 7 });
    assert.equal(edited.status, 200);
    assert.equal(((await edited.json()) as { item: Record<string, unknown> }).item.status, 'live');
    const after = (await body(await boss.c.get(`/admin/data/products/${chair}`))).item as Record<string, unknown>;
    assert.deepEqual([after.status, after.stock, after.ownerEmail], ['live', 7, 'ana@studio.test'], 'the owner is unchanged');
    assert.equal((await boss.c.request('PATCH', `/data/products/${chair}`, { status: 'sold' })).status, 404, 'CONTROL: the public route keeps the owner rule for the admin too');

    assert.equal((await ana.c.request('POST', '/data/notes', { body: 'hi' })).status, 403, 'a table with no allow lines is closed to the public');
    assert.equal((await ana.c.get('/data/notes')).status, 403);
    const note = await boss.c.request('POST', '/admin/data/notes', { body: 'kept for staff' });
    assert.equal(note.status, 201, 'CONTROL: and reachable to an admin');
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    assert.equal((await boss.c.request('DELETE', `/admin/data/notes/${noteId}`)).status, 204);
    assert.equal((await boss.c.request('DELETE', `/admin/data/notes/${noteId}`)).status, 404, 'gone');

    // A ref holds the row: refused with a code, nothing removed.
    const rev = await ana.c.request('POST', '/data/reviews', { product: chair, stars: 5 });
    assert.equal(rev.status, 201);
    assert.deepEqual([(await boss.c.request('DELETE', `/admin/data/products/${chair}`).then(async (r) => [r.status, await r.json()]))], [[409, { error: 'in_use' }]]);
    const revId = ((await rev.json()) as { item: { id: string } }).item.id;
    assert.equal((await boss.c.request('DELETE', `/admin/data/reviews/${revId}`)).status, 204, 'another account\'s row');
    assert.equal((await boss.c.request('DELETE', `/admin/data/products/${chair}`)).status, 204);
    assert.equal((await ana.c.get(`/data/products/${chair}`)).status, 404);
  } finally { await h.close(); }
});

test('SECURITY validation and mass assignment: an admin is held to every value check', async () => {
  const { h, boss, chair } = await shop();
  try {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ name: 'x', price: 1, owner: 'someone' }, { error: 'invalid', field: 'owner' }],
      [{ name: 'x', price: 1, id: '00000000-0000-4000-8000-000000000001' }, { error: 'invalid', field: 'id' }],
      [{ name: 'x', price: 1, created: 1 }, { error: 'invalid', field: 'created' }],
      [{ name: 'x', price: 1, ownerEmail: 'a@b.test' }, { error: 'invalid', field: 'ownerEmail' }],
      [{ name: 'x', price: -1 }, { error: 'invalid', field: 'price' }],
      [{ name: 'x', price: 1, status: 'gone' }, { error: 'invalid', field: 'status' }],
      [{ name: 'a'.repeat(201), price: 1 }, { error: 'too_long', field: 'name' }],
      [{ price: 1 }, { error: 'required', field: 'name' }],
      [{ name: 'x', price: 1, contact: 'not-mail' }, { error: 'invalid', field: 'contact' }],
    ];
    for (const [sent, want] of cases) {
      const r = await boss.c.request('POST', '/admin/data/products', sent);
      assert.deepEqual([r.status, await r.json()], [400, want], JSON.stringify(sent));
    }
    const edit = await boss.c.request('PATCH', `/admin/data/products/${chair}`, { name: null });
    assert.deepEqual([edit.status, await edit.json()], [400, { error: 'required', field: 'name' }]);
    const big = await boss.c.request('POST', '/admin/data/products', { name: 'x', price: 1, pad: 'a'.repeat(70 * 1024) });
    assert.equal(big.status, 413);
    assert.equal((await boss.c.request('POST', '/admin/data/products', '{not json')).status, 400);
    assert.equal((await boss.c.request('POST', '/admin/data/reviews', { product: '00000000-0000-4000-8000-000000000009', stars: 1 })).status, 400, 'a ref to nothing');
    assert.equal((await body(await boss.c.get('/admin/data'))).tables instanceof Array, true);
    assert.equal(((await body(await boss.c.get('/admin/data/products'))).count), 1, 'none of the refused writes landed');
    assert.equal((await h.db.all('SELECT * FROM az_data_audit')).length, 0, 'and none was audited');
  } finally { await h.close(); }
});

test('SECURITY audit: every admin write is a row — who, table, row, action, time — and never a value', async () => {
  const { h, boss, ana, chair } = await shop();
  try {
    const SECRET_VALUE = 'Secret-Value-7d1f';
    const SECRET_MAIL = 'private-7d1f@studio.test';
    h.clock.now += 1;
    const c = await boss.c.request('POST', '/admin/data/products', { name: SECRET_VALUE, price: 4242, contact: SECRET_MAIL });
    const id = ((await c.json()) as { item: { id: string } }).item.id;
    h.clock.now += 1;
    assert.equal((await boss.c.request('PATCH', `/admin/data/products/${chair}`, { name: `${SECRET_VALUE}-2`, contact: SECRET_MAIL })).status, 200);
    h.clock.now += 1;
    assert.equal((await boss.c.request('DELETE', `/admin/data/products/${id}`)).status, 204);
    assert.equal((await ana.c.request('PATCH', `/data/products/${chair}`, { name: 'Owner edit' })).status, 200);

    const rows = await h.db.all('SELECT * FROM az_data_audit ORDER BY at');
    assert.deepEqual(rows.map((r) => [r.admin, r.tbl, r.row_id, r.action]), [
      [boss.id, 'products', id, 'create'], [boss.id, 'products', chair, 'edit'], [boss.id, 'products', id, 'delete'],
    ], 'admin writes only — an owner\'s own edit is not audited');
    const text = JSON.stringify(rows);
    for (const v of [SECRET_VALUE, SECRET_MAIL, '4242', 'ana@studio.test']) assert.ok(!text.includes(v), `no value in the audit: ${v}`);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['action', 'admin', 'at', 'id', 'row_id', 'tbl']);

    const page1 = await body(await boss.c.get('/admin/audit?limit=2'));
    assert.deepEqual((page1.items as Record<string, unknown>[]).map((x) => [x.action, x.admin, x.table]),
      [['delete', 'boss@studio.test', 'products'], ['edit', 'boss@studio.test', 'products']]);
    const page2 = await body(await boss.c.get(`/admin/audit?limit=2&after=${page1.next as string}`));
    assert.deepEqual([(page2.items as Record<string, unknown>[]).map((x) => x.action), page2.next], [['create'], null]);
    assert.ok(!JSON.stringify([page1, page2]).includes(SECRET_VALUE));
    for (const q of ['?limit=0', '?after=zzz', '?table=products', '?limit=2&limit=3']) assert.equal((await boss.c.get(`/admin/audit${q}`)).status, 400, q);
    assert.equal((await boss.c.request('POST', '/admin/audit', {})).status, 404, 'the audit is read-only');
  } finally { await h.close(); }
});

test('SECURITY CSRF and CORS on admin writes: the header and an allowed origin, every method', async () => {
  const { h, boss, chair } = await shop();
  try {
    const writes: [string, string, unknown][] = [
      ['POST', '/admin/data/products', { name: 'x', price: 1 }],
      ['PATCH', `/admin/data/products/${chair}`, { name: 'y' }],
      ['DELETE', `/admin/data/products/${chair}`, undefined],
    ];
    const cookie = [...boss.c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    for (const [method, path, sent] of writes) {
      assert.equal((await boss.c.request(method, path, sent, { 'x-az-request': '0' })).status, 403, `${method} without the header`);
      const foreign = await client(h.url, 'https://evil.example').request(method, path, sent, { cookie });
      assert.equal(foreign.status, 403, `${method} from another origin`);
      assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await h.db.all('SELECT * FROM az_data_audit')).length, 0, 'nothing written');
    assert.equal((await boss.c.request('PATCH', `/admin/data/products/${chair}`, { name: 'y' })).status, 200, 'CONTROL: the site\'s own request');
    const pre = await fetch(`${h.url}/admin/data/products`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5173' } });
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /PATCH/);
  } finally { await h.close(); }
});

test('SECURITY IDOR across tables: a row id from one table is absent from another', async () => {
  const { h, boss, chair } = await shop();
  try {
    assert.equal((await boss.c.get(`/admin/data/reviews/${chair}`)).status, 404);
    assert.equal((await boss.c.request('PATCH', `/admin/data/reviews/${chair}`, { stars: 1 })).status, 404);
    assert.equal((await boss.c.request('DELETE', `/admin/data/notes/${chair}`)).status, 404);
    assert.equal((await boss.c.get('/admin/data/products/not-a-uuid')).status, 404);
    assert.equal((await boss.c.get(`/admin/data/products/${chair}`)).status, 200, 'CONTROL: in its own table');
    assert.equal((await h.db.all('SELECT * FROM az_data_audit')).length, 0, 'a miss is not audited');
  } finally { await h.close(); }
});

test('moderation: an anyone-create table\'s rows are listed, private fields included, and removable by an admin', async () => {
  const { h, boss } = await shop();
  try {
    const stranger = client(h.url);
    for (const e of ['real@studio.test', 'spam1@junk.test', 'spam2@junk.test']) assert.equal((await stranger.request('POST', '/data/waitlist', { email: e })).status, 201);
    assert.equal((await stranger.get('/data/waitlist')).status, 403, 'nobody reads it publicly');
    assert.equal((await boss.c.get('/admin/data/waitlist?q=junk')).status, 400, 'search covers only fields declared search');
    const all = (await body(await boss.c.get('/admin/data/waitlist?sort=created'))).items as { id: string; email: string; ownerEmail: null }[];
    assert.deepEqual(all.map((x) => [x.email, x.ownerEmail]).sort(), [['real@studio.test', null], ['spam1@junk.test', null], ['spam2@junk.test', null]]);
    for (const x of all.filter((r) => r.email.endsWith('@junk.test'))) assert.equal((await boss.c.request('DELETE', `/admin/data/waitlist/${x.id}`)).status, 204);
    assert.equal((await body(await boss.c.get('/admin/data/waitlist'))).count, 1);
  } finally { await h.close(); }
});

test('limits: admin writes 300 per 10 minutes per account; refused admin writes count per address', async () => {
  const { h, boss, ana } = await shop();
  try {
    let last = 0;
    for (let i = 0; i < 300; i++) {
      last = (await boss.c.request('POST', '/admin/data/notes', { body: `n${i}` })).status;
      assert.equal(last, 201, `write ${i} — past the public 60 per address`);
    }
    const over = await boss.c.request('POST', '/admin/data/notes', { body: 'one more' });
    assert.deepEqual([over.status, await over.json()], [429, { error: 'rate_limited' }]);
    assert.equal((await boss.c.get('/admin/data/notes')).status, 200, 'reads are a separate budget');
    h.clock.now += 11 * MINUTE;
    assert.equal((await boss.c.request('POST', '/admin/data/notes', { body: 'later' })).status, 201, 'CONTROL: the window passes');

    // A non-admin probing the write routes is bounded by the public per-address limit.
    h.clock.now += 11 * MINUTE;
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await ana.c.request('POST', '/admin/data/notes', { body: 'x' })).status);
    assert.deepEqual([statuses[0], statuses[59], statuses[60]], [403, 403, 429]);
  } finally { await h.close(); }
});
