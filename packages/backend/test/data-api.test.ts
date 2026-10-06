/**
 * The /data routes over SQLite (data-spec §5, §13, §14): the authorization
 * matrix for every legal rule combination against a reference evaluator
 * written from the spec's table, and each row of the threat table that D1
 * covers — mass assignment, IDOR, the existence oracle, private fields,
 * unbounded queries, filter/sort/search injection, CSRF and CORS per
 * method, body caps, rate limits — each with a control that still works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, SITE, startBackend, type Harness } from './helpers.ts';
import { dataOf } from './data-fixture.ts';
import { isForeignKeyViolation } from '../src/server/data-api.ts';

const GOOD = 'a-long-enough-password';
const MINUTE = 60 * 1000;

async function signUp(h: Harness, name: string) {
  const c = client(h.url);
  const r = await c.post('/auth/sign-up', { name, email: `${name.toLowerCase()}@studio.test`, password: GOOD, passwordConfirm: GOOD });
  assert.equal(r.status, 200);
  const id = ((await r.json()) as { session: { user: { id: string } } }).session.user.id;
  return { c, id };
}

const json = async (r: Response) => (r.status === 204 ? null : r.json()) as Promise<Record<string, unknown>>;

/* ---- the authorization matrix ------------------------------------------ */

type Who = 'anyone' | 'signedin' | 'owner';
interface Rules { read: Who[]; create: Who[]; edit: Who[]; delete: Who[] }

const subsets = <T>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);

/** Every rule set the compiler accepts (data-spec §4.7, AZ1241–AZ1244). */
const LEGAL: Rules[] = subsets<Who>(['anyone', 'signedin', 'owner']).flatMap((read) =>
  subsets<Who>(['anyone', 'signedin']).flatMap((create) =>
    subsets<Who>(['owner']).flatMap((edit) => subsets<Who>(['owner']).map((del) => ({ read, create, edit, delete: del })))))
  .filter((r) => !(r.create.includes('anyone') && [...r.read, ...r.edit, ...r.delete].includes('owner')));

type Actor = 'out' | 'other' | 'owner';
type Route = 'list' | 'get' | 'create' | 'edit' | 'delete';

/**
 * The spec's table, read directly — written apart from the server's code.
 * Returns the status, and for a list whether the owner's row is in it.
 */
function expected(r: Rules, actor: Actor, route: Route): { status: number; sees?: boolean } {
  const signedIn = actor !== 'out';
  if (route === 'list' || route === 'get') {
    if (r.read.length === 0) return { status: 403 };
    if (!r.read.includes('anyone') && !signedIn) return { status: 401 };
    const sees = r.read.includes('anyone') || (r.read.includes('signedin') && signedIn) || (r.read.includes('owner') && actor === 'owner');
    return route === 'list' ? { status: 200, sees } : { status: sees ? 200 : 404 };
  }
  if (route === 'create') {
    if (r.create.length === 0) return { status: 403 };
    if (r.create.includes('anyone')) return { status: 201 };
    return { status: signedIn ? 201 : 401 };
  }
  const rule = route === 'edit' ? r.edit : r.delete;
  if (rule.length === 0) return { status: 403 };
  if (!signedIn) return { status: 401 };
  return { status: actor === 'owner' ? (route === 'edit' ? 200 : 204) : 404 };
}

const allowLines = (r: Rules) => (['anyone', 'signedin', 'owner'] as const)
  .map((who) => [who, (['read', 'create', 'edit', 'delete'] as const).filter((a) => r[a].includes(who))] as const)
  .filter(([, actions]) => actions.length > 0)
  .map(([who, actions]) => `    allow ${who} ${actions.join(' ')}\n`).join('');

test(`the authorization matrix: ${LEGAL.length} rule sets × 3 actors × 5 routes agree with the spec's table`, async () => {
  let cells = 0;
  for (let start = 0; start < LEGAL.length; start += 20) {
    const chunk = LEGAL.slice(start, start + 20);
    const data = chunk.map((r, i) => `  data m${start + i}x\n    title text\n${allowLines(r)}`).join('');
    const h = await startBackend({}, { data: dataOf(data) });
    try {
      const owner = await signUp(h, 'Owner');
      const other = await signUp(h, 'Other');
      const actors: Record<Actor, ReturnType<typeof client>> = { out: client(h.url), other: other.c, owner: owner.c };
      for (const [i, rules] of chunk.entries()) {
        const t = `m${start + i}x`;
        const row = '00000000-0000-4000-8000-00000000000a';
        await h.db.run(`INSERT INTO azd_${t} (id, owner, created, updated, title) VALUES (?, ?, 1, 1, 'kept')`, [row, owner.id]);
        for (const actor of ['out', 'other', 'owner'] as const) {
          const c = actors[actor];
          const responses: Record<Route, Response> = {
            list: await c.get(`/data/${t}`),
            get: await c.get(`/data/${t}/${row}`),
            create: await c.request('POST', `/data/${t}`, { title: 'new' }),
            edit: await c.request('PATCH', `/data/${t}/${row}`, { title: 'edited' }),
            delete: await c.request('DELETE', `/data/${t}/${row}`),
          };
          for (const route of ['list', 'get', 'create', 'edit', 'delete'] as const) {
            const want = expected(rules, actor, route);
            const res = responses[route];
            const where = `${JSON.stringify(rules)} ${actor} ${route}`;
            assert.equal(res.status, want.status, where);
            if (want.sees !== undefined) {
              const items = ((await res.json()) as { items: { id: string }[] }).items;
              assert.equal(items.some((x) => x.id === row), want.sees, `${where}: row visible`);
            } else {
              await res.body?.cancel();
            }
            cells++;
          }
          // The owner's delete (last) removed the row; restore it for the next actor.
          await h.db.run(`INSERT INTO azd_${t} (id, owner, created, updated, title) SELECT ?, ?, 1, 1, 'kept' WHERE NOT EXISTS (SELECT 1 FROM azd_${t} WHERE id = ?)`, [row, owner.id, row]);
        }
        h.clock.now += 11 * MINUTE;   // past every write window
      }
    } finally { await h.close(); }
  }
  assert.equal(cells, LEGAL.length * 15);
});

/* ---- one shop for the threat rows -------------------------------------- */

const SHOP = `  data products
    name     text     required search
    blurb    longtext search
    price    money    usd required
    stock    number   default 0 locked
    status   choice   draft live sold default draft
    sku      text     unique
    contact  email    private
    link     url
    due      date
    featured flag
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
`;

async function shop() {
  const h = await startBackend({}, { data: dataOf(SHOP) });
  const a = await signUp(h, 'Ana');
  const b = await signUp(h, 'Bo');
  const create = async (c: ReturnType<typeof client>, body: Record<string, unknown>) => {
    const r = await c.request('POST', '/data/products', { name: 'Chair', price: 1999, ...body });
    assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
    return ((await r.json()) as { item: Record<string, unknown> }).item;
  };
  return { h, a, b, create };
}

test('CRUD: create applies defaults and hides the owner; read, edit, delete; then it is gone', async () => {
  const { h, a, create } = await shop();
  try {
    const item = await create(a.c, { contact: 'ana@studio.test' });
    assert.deepEqual(Object.keys(item).sort(), ['blurb', 'contact', 'created', 'due', 'featured', 'id', 'link', 'mine', 'name', 'price', 'sku', 'status', 'stock', 'updated'].sort());
    assert.equal(item.mine, true);
    assert.equal(item.stock, 0, 'locked default');
    assert.equal(item.status, 'draft', 'choice default');
    assert.equal(item.featured, false, 'flag default off');
    assert.equal(item.contact, 'ana@studio.test', 'its owner reads a private field');
    assert.ok(!JSON.stringify(item).includes(a.id), 'the owner id never leaves the server');
    const got = await json(await a.c.get(`/data/products/${item.id}`));
    assert.deepEqual(got.item, item);
    h.clock.now += 1000;
    const edited = await json(await a.c.request('PATCH', `/data/products/${item.id}`, { price: 2499, blurb: 'Two\nlines' }));
    assert.equal((edited.item as Record<string, unknown>).price, 2499);
    assert.ok(((edited.item as Record<string, number>).updated) > (item.updated as number));
    assert.equal((await a.c.request('DELETE', `/data/products/${item.id}`)).status, 204);
    assert.equal((await a.c.get(`/data/products/${item.id}`)).status, 404);
  } finally { await h.close(); }
});

test('SECURITY mass assignment: id, owner, created, updated, mine, a locked field or any other key is refused; the row is unchanged', async () => {
  const { h, a, create } = await shop();
  try {
    const item = await create(a.c, {});
    for (const key of ['id', 'owner', 'created', 'updated', 'mine', 'stock', 'password_hash', 'constructor', '__proto__']) {
      const body = `{"name":"x","${key}":"00000000-0000-4000-8000-000000000001"}`;
      const made = await a.c.request('POST', '/data/products', body);
      assert.deepEqual([made.status, await made.json()], [400, { error: 'invalid', field: key }], `create with ${key}`);
      const changed = await a.c.request('PATCH', `/data/products/${item.id}`, body);
      assert.deepEqual([changed.status, await changed.json()], [400, { error: 'invalid', field: key }], `edit with ${key}`);
    }
    assert.deepEqual((await json(await a.c.get(`/data/products/${item.id}`))).item, item);
    assert.equal(((await json(await a.c.get('/data/products'))).items as unknown[]).length, 1, 'nothing was created');
  } finally { await h.close(); }
});

test('SECURITY IDOR + existence oracle: another account editing or deleting a row gets exactly what a missing row gets', async () => {
  const { h, a, b, create } = await shop();
  try {
    const item = await create(a.c, {});
    const missing = '00000000-0000-4000-8000-0000000000ff';
    for (const [method, body] of [['PATCH', { price: 1 }], ['DELETE', undefined]] as const) {
      const foreign = await b.c.request(method, `/data/products/${item.id}`, body);
      const absent = await b.c.request(method, `/data/products/${missing}`, body);
      assert.deepEqual([foreign.status, await foreign.text()], [absent.status, await absent.text()], method);
      assert.equal(foreign.status, 404);
    }
    assert.equal(((await json(await a.c.get(`/data/products/${item.id}`))).item as Record<string, unknown>).price, 1999, 'unchanged');
    assert.equal((await a.c.request('PATCH', `/data/products/${item.id}`, { price: 1 })).status, 200, 'CONTROL: the owner can');
  } finally { await h.close(); }
});

test('SECURITY excessive exposure: a private field is null for everyone but its owner, decided in SQL', async () => {
  const { h, a, b, create } = await shop();
  try {
    await create(a.c, { contact: 'ana@studio.test' });
    for (const c of [b.c, client(h.url)]) {
      const items = (await json(await c.get('/data/products'))).items as Record<string, unknown>[];
      assert.equal(items[0].contact, null);
      assert.equal(items[0].mine, false);
      assert.ok(!JSON.stringify(items).includes('ana@studio.test') && !JSON.stringify(items).includes(a.id));
    }
    assert.equal(((await json(await a.c.get('/data/products'))).items as Record<string, unknown>[])[0].contact, 'ana@studio.test', 'CONTROL: the owner reads it');
  } finally { await h.close(); }
});

test('SECURITY private-field oracle: filtering on a private field is refused, except on your own rows (mine=1)', async () => {
  const { h, a, b, create } = await shop();
  try {
    await create(a.c, { contact: 'ana@studio.test' });
    for (const c of [b.c, client(h.url)]) {
      const r = await c.get('/data/products?contact=ana%40studio.test');
      assert.deepEqual([r.status, await r.json()], [400, { error: 'bad_query', field: 'contact' }]);
    }
    const own = await json(await a.c.get('/data/products?mine=1&contact=ana%40studio.test'));
    assert.equal((own.items as unknown[]).length, 1, 'CONTROL: the owner may, on their own rows');
    assert.equal((await client(h.url).get('/data/products?mine=1')).status, 401, 'mine needs a session');
    assert.equal(((await json(await b.c.get('/data/products?mine=1'))).items as unknown[]).length, 0);
  } finally { await h.close(); }
});

test('SECURITY unbounded queries: limit 1–100 (default 20); keyset pages have no gaps or repeats while rows arrive', async () => {
  const { h, a } = await shop();
  try {
    for (const bad of ['0', '101', '1000000', '-1', '1.5', 'ten', '']) {
      const r = await client(h.url).get(`/data/products?limit=${bad}`);
      assert.deepEqual([r.status, await r.json()], [400, { error: 'bad_query', field: 'limit' }], bad);
    }
    for (let i = 0; i < 45; i++) {
      h.clock.now += 1;
      await h.db.run("INSERT INTO azd_products (id, owner, created, updated, name, price, status, stock) VALUES (?, ?, ?, ?, 'p', ?, 'draft', 0)",
        [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, a.id, h.clock.now, h.clock.now, i]);
    }
    assert.equal(((await json(await client(h.url).get('/data/products'))).items as unknown[]).length, 20, 'default 20');
    const seen: string[] = [];
    let next: string | null = null;
    let page = 0;
    do {
      const r = await json(await client(h.url).get(`/data/products?sort=price&limit=10${next ? `&after=${next}` : ''}`));
      seen.push(...(r.items as { id: string }[]).map((x) => x.id));
      next = r.next as string | null;
      // A row arriving mid-walk sorts before the cursor: it must not shift the pages.
      if (page++ === 1) await h.db.run("INSERT INTO azd_products (id, owner, created, updated, name, price, status, stock) VALUES ('00000000-0000-4000-8000-0000000000aa', NULL, 1, 1, 'early', 0, 'draft', 0)");
    } while (next);
    assert.equal(new Set(seen).size, seen.length, 'no repeats');
    assert.equal(seen.filter((s) => !s.endsWith('aa')).length, 45, 'no gaps');
    for (const bad of ['xyz', Buffer.from('[1]').toString('base64url'), Buffer.from('[1,"not-a-uuid"]').toString('base64url'), 'A'.repeat(700)]) {
      assert.equal((await client(h.url).get(`/data/products?sort=price&after=${bad}`)).status, 400, `cursor ${bad.slice(0, 20)}`);
    }
  } finally { await h.close(); }
});

test('SECURITY filter / sort injection: every unknown or malformed parameter is a 400 naming it — never a 500, never ignored', async () => {
  const { h } = await shop();
  try {
    const cases: [string, string][] = [
      ['password_hash=x', 'password_hash'], ['owner=x', 'owner'], ['id=x', 'id'], ['a.b.c=1', 'a.b.c'], ['price.between=1', 'price.between'],
      ['sort=password_hash', 'sort'], ['sort=owner', 'sort'], ['sort=blurb', 'sort'], ['sort=sku', 'sort'], ['sort=--price', 'sort'],
      ['name=Chair', 'name'], ['name.in=a,b', 'name.in'], ['price=1e3', 'price'], ['price=--1', 'price'], ['price.gte=abc', 'price.gte'],
      ['price=99999999999999999', 'price'], ['featured=true', 'featured'], ['due=2023-02-29', 'due'], ['status=gone', 'status'],
      [`status.in=${Array.from({ length: 21 }, (_, i) => `v${i}`).join(',')}`, 'status.in'], ['price=1&price=2', 'price'],
      ["sku=x'%20OR%201=1--", 'sku'], ['mine=0', 'mine'], ['q=a', 'q'], [`q=${'a'.repeat(101)}`, 'q'],
    ];
    for (const [query, field] of cases) {
      const r = await client(h.url).get(`/data/products?${query}`);
      assert.deepEqual([r.status, await r.json()], [400, { error: 'bad_query', field }], query);
    }
    for (const ok of ['price.gte=100', 'status.in=draft,live', 'featured=on', 'due=2024-02-29', 'sort=-price', 'sort=name', 'q=ch']) {
      assert.equal((await client(h.url).get(`/data/products?${ok}`)).status, 200, `CONTROL ${ok}`);
    }
    assert.equal((await client(h.url).get('/data/products/00000000-0000-4000-8000-000000000001?x=1')).status, 400, 'a get takes no parameters');
  } finally { await h.close(); }
});

test('SECURITY SQL injection: hostile values are stored and matched literally; the tables survive', async () => {
  const { h, a, create } = await shop();
  try {
    const hostile = "x'); DROP TABLE azd_products; --";
    const item = await create(a.c, { name: hostile, sku: "1' OR '1'='1" });
    assert.equal(((await json(await a.c.get(`/data/products/${item.id}`))).item as Record<string, unknown>).name, hostile);
    const found = await json(await client(h.url).get(`/data/products?q=${encodeURIComponent("'); DROP")}`));
    assert.equal((found.items as unknown[]).length, 1);
    assert.ok(await h.db.get("SELECT 1 FROM sqlite_schema WHERE name = 'azd_products'"));
  } finally { await h.close(); }
});

test('SECURITY expensive search: wildcards are literal — % matches only %, _ only _, ! only !', async () => {
  const { h, a, create } = await shop();
  try {
    for (const name of ['100% wool', 'half_price', 'wow!', 'plain', 'ÄBC']) await create(a.c, { name });
    const hits = async (term: string) => ((await json(await client(h.url).get(`/data/products?q=${encodeURIComponent(term)}`))).items as { name: string }[]).map((x) => x.name).sort();
    assert.deepEqual(await hits('0%'), ['100% wool']);
    assert.deepEqual(await hits('%%'), []);
    assert.deepEqual(await hits('f_'), ['half_price']);
    assert.deepEqual(await hits('w!'), ['wow!']);
    assert.deepEqual(await hits('PLAIN'), ['plain'], 'case-insensitive for ASCII');
    // SQLite's LOWER folds ASCII only (verified, data-spec §5.1): ä does not find Ä here.
    assert.deepEqual(await hits('äbc'), []);
    assert.deepEqual(await hits('ÄBC'), ['ÄBC']);
  } finally { await h.close(); }
});

test('SECURITY CSRF and CORS: every non-GET needs the header and an allowed origin; preflight names the data methods', async () => {
  const { h, a, create } = await shop();
  try {
    const item = await create(a.c, {});
    for (const [method, path, body] of [['POST', '/data/products', { name: 'x', price: 1 }], ['PATCH', `/data/products/${item.id}`, { price: 5 }], ['DELETE', `/data/products/${item.id}`, undefined]] as const) {
      const noHeader = await a.c.request(method, path, body, { 'x-az-request': '0' });
      assert.deepEqual([noHeader.status, await noHeader.json()], [403, { error: 'unknown' }], `${method} without the header`);
      const foreign = await client(h.url, 'https://evil.example').request(method, path, body, { cookie: [...a.c.jar].map(([k, v]) => `${k}=${v}`).join('; ') });
      assert.equal(foreign.status, 403, `${method} from another origin`);
      assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    }
    assert.equal(((await json(await a.c.get(`/data/products/${item.id}`))).item as Record<string, unknown>).price, 1999, 'unchanged');
    const pre = await fetch(`${h.url}/data/products`, { method: 'OPTIONS', headers: { origin: SITE } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, PUT, DELETE');
    assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
    assert.equal((await client(h.url).get('/data/products')).status, 200, 'CONTROL: a GET needs no header');
    const auth = await fetch(`${h.url}/auth/session`, { method: 'OPTIONS', headers: { origin: SITE } });
    assert.equal(auth.headers.get('access-control-allow-methods'), 'GET, POST', 'CONTROL: auth keeps its methods');
  } finally { await h.close(); }
});

test('SECURITY oversized bodies: past 64 KB is 413; a full 10,000-character longtext (40 KB) fits', async () => {
  const { h, a } = await shop();
  try {
    const big = await a.c.request('POST', '/data/products', `{"name":"x","price":1,"blurb":"${'a'.repeat(64 * 1024)}"}`);
    assert.deepEqual([big.status, await big.json()], [413, { error: 'too_large' }]);
    const full = await a.c.request('POST', '/data/products', { name: 'x', price: 1, blurb: '😀'.repeat(10_000) });
    assert.equal(full.status, 201, 'CONTROL: over the 16 KB auth cap, under the data cap');
    const over = await a.c.request('POST', '/data/products', { name: 'x', price: 1, blurb: 'a'.repeat(10_001) });
    assert.deepEqual([over.status, await over.json()], [400, { error: 'too_long', field: 'blurb' }]);
    const notJson = await a.c.request('POST', '/data/products', 'name=x', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.deepEqual([notJson.status, await notJson.json()], [400, { error: 'invalid' }]);
  } finally { await h.close(); }
});

test('SECURITY spam: an anyone-create table takes 10 rows per address per hour, then 429', async () => {
  const { h } = await shop();
  try {
    const stranger = client(h.url);
    for (let i = 0; i < 10; i++) assert.equal((await stranger.request('POST', '/data/waitlist', { email: `p${i}@studio.test` })).status, 201);
    const r = await stranger.request('POST', '/data/waitlist', { email: 'p10@studio.test' });
    assert.deepEqual([r.status, await r.json()], [429, { error: 'rate_limited' }]);
    h.clock.now += 61 * MINUTE;
    assert.equal((await stranger.request('POST', '/data/waitlist', { email: 'p11@studio.test' })).status, 201, 'CONTROL: the window passes');
    assert.equal((await stranger.get('/data/waitlist')).status, 403, 'nobody reads a table with no read rule');
  } finally { await h.close(); }
});

test('writes per address: 60 per 10 minutes, then 429', async () => {
  const { h, a } = await shop();
  try {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await a.c.request('POST', '/data/products', { name: `n${i}`, price: 1 })).status;
    assert.equal(last, 429);
  } finally { await h.close(); }
});

test('values: each type\'s limits, boundaries and refusals', async () => {
  const { h, a } = await shop();
  try {
    const post = async (body: Record<string, unknown>) => {
      h.clock.now += 11 * MINUTE;
      const r = await a.c.request('POST', '/data/products', { name: 'x', price: 1, ...body });
      return [r.status, r.status === 201 ? 'ok' : await r.json()];
    };
    const bad = (field: string, error = 'invalid') => [400, { error, field }];
    assert.deepEqual(await post({ name: 'a'.repeat(200) }), [201, 'ok']);
    assert.deepEqual(await post({ name: '😀'.repeat(200) }), [201, 'ok'], 'characters, not UTF-16 units');
    assert.deepEqual(await post({ name: 'a'.repeat(201) }), bad('name', 'too_long'));
    assert.deepEqual(await post({ name: 'two\nlines' }), bad('name'));
    assert.deepEqual(await post({ name: '   ' }), bad('name', 'required'));
    assert.deepEqual(await post({ name: 5 }), bad('name'));
    assert.deepEqual(await post({ price: -1 }), bad('price'));
    assert.deepEqual(await post({ price: 2 ** 53 }), bad('price'));
    assert.deepEqual(await post({ price: 1.5 }), bad('price'));
    assert.deepEqual(await post({ price: '1' }), bad('price'));
    assert.deepEqual(await post({ featured: 'yes' }), bad('featured'));
    assert.deepEqual(await post({ due: '2023-02-29' }), bad('due'));
    assert.deepEqual(await post({ due: '2024-02-29' }), [201, 'ok']);
    assert.deepEqual(await post({ contact: 'x<victim@corp.example>' }), bad('contact'));
    assert.deepEqual(await post({ link: 'javascript:alert(1)' }), bad('link'));
    assert.deepEqual(await post({ link: 'https://user:pw@studio.test/' }), bad('link'));
    assert.deepEqual(await post({ link: 'https://studio.test/a?b=c' }), [201, 'ok']);
    assert.deepEqual(await post({ status: 'gone' }), bad('status'));
    assert.deepEqual(await post({ name: undefined, price: undefined }), bad('name', 'required'));
  } finally { await h.close(); }
});

test('unique and foreign keys: 409 taken names the field; a ref must exist; a referenced row is in_use', async () => {
  const { h, a, b, create } = await shop();
  try {
    const first = await create(a.c, { sku: 'S-1' });
    const dup = await a.c.request('POST', '/data/products', { name: 'y', price: 1, sku: 'S-1' });
    assert.deepEqual([dup.status, await dup.json()], [409, { error: 'taken', field: 'sku' }]);
    assert.equal((await a.c.request('POST', '/data/products', { name: 'y', price: 1, sku: 's-1' })).status, 201, 'binary comparison: case differs');
    const orphan = await b.c.request('POST', '/data/reviews', { product: '00000000-0000-4000-8000-0000000000ff', stars: 5 });
    assert.deepEqual([orphan.status, await orphan.json()], [400, { error: 'invalid', field: 'product' }]);
    assert.equal((await b.c.request('POST', '/data/reviews', { product: first.id, stars: 5 })).status, 201);
    const del = await a.c.request('DELETE', `/data/products/${first.id}`);
    assert.deepEqual([del.status, await del.json()], [409, { error: 'in_use' }]);
  } finally { await h.close(); }
});

test('required cannot be cleared; null clears an optional field', async () => {
  const { h, a, create } = await shop();
  try {
    const item = await create(a.c, { blurb: 'x' });
    const cleared = await a.c.request('PATCH', `/data/products/${item.id}`, { name: null });
    assert.deepEqual([cleared.status, await cleared.json()], [400, { error: 'required', field: 'name' }]);
    const ok = await json(await a.c.request('PATCH', `/data/products/${item.id}`, { blurb: null }));
    assert.equal((ok.item as Record<string, unknown>).blurb, null);
  } finally { await h.close(); }
});

test('routes: an unknown table, a malformed id, PUT and nested paths are 404', async () => {
  const { h, a } = await shop();
  try {
    for (const [method, path] of [['GET', '/data/nope'], ['GET', '/data/products/1'], ['GET', '/data'], ['PUT', '/data/products/00000000-0000-4000-8000-000000000001'], ['GET', '/data/products/00000000-0000-4000-8000-000000000001/x'], ['POST', '/data/products/00000000-0000-4000-8000-000000000001']] as const) {
      const r = await a.c.request(method, path);
      assert.deepEqual([r.status, await r.json()], [404, { error: 'not_found' }], `${method} ${path}`);
    }
  } finally { await h.close(); }
});

test('foreign-key refusals are recognised on every engine, ON DELETE RESTRICT included', () => {
  assert.ok(isForeignKeyViolation({ code: '23001' }), 'PostgreSQL restrict_violation — what RESTRICT raises (found on 18.6)');
  assert.ok(isForeignKeyViolation({ code: '23503' }), 'PostgreSQL foreign_key_violation');
  assert.ok(isForeignKeyViolation({ errno: 1451 }) && isForeignKeyViolation({ errno: 1452 }), 'MySQL');
  assert.ok(isForeignKeyViolation({ errcode: 787 }) && isForeignKeyViolation({ message: 'FOREIGN KEY constraint failed' }), 'SQLite');
  assert.ok(!isForeignKeyViolation({ code: '23505' }) && !isForeignKeyViolation(new Error('x')), 'CONTROL: a unique violation is not one');
});

test('CONTROL: a backend without data answers /data exactly as before (404 unknown)', async () => {
  const h = await startBackend();
  try {
    const r = await client(h.url).get('/data/products');
    assert.deepEqual([r.status, await r.json()], [404, { error: 'unknown' }]);
  } finally { await h.close(); }
});
