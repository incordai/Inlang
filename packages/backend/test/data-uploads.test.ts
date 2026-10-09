/**
 * The image routes over SQLite (data-spec §5, §8, §13): upload, serve,
 * replace, clear and delete with no file left behind; the serving headers;
 * the read rule and `private` on an image read; owner-only uploads, CSRF,
 * the body cap enforced while streaming, refused types and bombs, the upload
 * limit, admin uploads with the audit, no path traversal, the orphan sweep;
 * width copies served under `w` with the same headers, every delete path and
 * the claim removing all of them, and the backfill of images stored before them.
 * Each refusal has a CONTROL that the same route works for the right caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { client, SITE, startBackend, type Harness } from './helpers.ts';
import { dataOf } from './data-fixture.ts';
import { createImages } from '../src/server/data-images.ts';
import { createData } from '../src/server/data-api.ts';
import { HEIC, metadataFindings, phoneJpeg, plainJpeg, pngClaiming, SVG, TEXT } from './image-fixtures.ts';

const GOOD = 'a-long-enough-password';
const SHOP = `  data products
    name     text     required
    photo    image
    proof    image    private
    badge    image    locked
    allow anyone read
    allow signedin create
    allow owner edit delete
  data drafts
    title    text
    cover    image
    allow owner read
    allow signedin create
    allow owner edit delete
  data frozen
    title    text
    cover    image
    allow anyone read
    allow signedin create
`;

type Client = ReturnType<typeof client>;
const body = async (r: Response) => (r.status === 204 ? null : r.json()) as Promise<Record<string, unknown>>;
type Img = { url: string; width: number; height: number } | null;

async function signUp(h: Harness, name: string, verified = false): Promise<{ c: Client; id: string }> {
  const c = client(h.url);
  const r = await c.post('/auth/sign-up', { name, email: `${name.toLowerCase()}@studio.test`, password: GOOD, passwordConfirm: GOOD });
  assert.equal(r.status, 200);
  const id = ((await r.json()) as { session: { user: { id: string } } }).session.user.id;
  if (verified) await h.db.run('UPDATE az_users SET email_verified = 1 WHERE id = ?', [id]);
  return { c, id };
}

/** The files directory's stored images and leftover temporaries. */
const files = (dir: string) => ({
  stored: readdirSync(dir).filter((n) => n.endsWith('.webp')).sort(),
  temp: readdirSync(join(dir, '.tmp')),
});

async function shop(over: { uploadLimit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-uploads-'));
  const images = await createImages({ dir });
  const h = await startBackend({}, { data: dataOf(SHOP), admins: ['boss@studio.test'], images, ...over });
  const ana = await signUp(h, 'Ana');
  const bob = await signUp(h, 'Bob');
  const boss = await signUp(h, 'Boss', true);
  const create = async (c: Client, table: string, fields: Record<string, unknown>) => {
    const r = await c.request('POST', `/data/${table}`, fields);
    assert.equal(r.status, 201);
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const chair = await create(ana.c, 'products', { name: 'Chair' });
  return { h, dir, images, ana, bob, boss, chair, create };
}

const put = (c: Client, path: string, bytes: Uint8Array) => c.upload('PUT', path, bytes);

test('upload → item with { url, width, height }; the url serves a clean WebP with the §8 headers, without an Origin', async () => {
  const { h, dir, ana, chair } = await shop();
  try {
    const r = await put(ana.c, `/data/products/${chair}/photo`, await phoneJpeg(640, 320, 6));
    assert.equal(r.status, 200);
    const photo = (await body(r) as { item: { photo: Img } }).item.photo!;
    assert.deepEqual([photo.width, photo.height], [320, 640], 'orientation applied');
    assert.match(photo.url, new RegExp(`^${h.url}/data/products/${chair}/photo\\?v=[0-9a-f-]{36}$`));
    assert.deepEqual(files(dir).stored.length, 1);

    // An <img> sends no Origin: the read rule alone answers.
    const img = await client(h.url).navigate(photo.url);
    assert.equal(img.status, 200);
    const bytes = Buffer.from(await img.arrayBuffer());
    assert.deepEqual(metadataFindings(bytes), []);
    assert.deepEqual(Object.fromEntries(['content-type', 'x-content-type-options', 'content-disposition', 'content-security-policy', 'cache-control', 'cross-origin-resource-policy']
      .map((k) => [k, img.headers.get(k)])), {
      'content-type': 'image/webp',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
      'cross-origin-resource-policy': 'cross-origin',
    });
    assert.equal(img.headers.get('content-length'), String(bytes.length));
    // Cached publicly, so it varies by Origin: an <img> load without one must
    // never be served to a later fetch() that needs the CORS headers (review #6).
    assert.equal(img.headers.get('vary'), 'Origin');
    const fetched = await ana.c.get(photo.url.slice(h.url.length));
    assert.deepEqual([fetched.status, fetched.headers.get('vary'), fetched.headers.get('access-control-allow-origin')], [200, 'Origin', SITE]);
    await fetched.body?.cancel();

    // The same row read and listed carries the same image.
    const one = await body(await ana.c.get(`/data/products/${chair}`)) as { item: { photo: Img; proof: Img } };
    assert.deepEqual([one.item.photo, one.item.proof], [photo, null]);
    const list = await body(await client(h.url).get('/data/products')) as { items: { photo: Img }[] };
    assert.deepEqual(list.items[0].photo, photo);

    // Without `v` (not the URL the API hands out), never cached as immutable.
    const bare = await client(h.url).navigate(`${h.url}/data/products/${chair}/photo`);
    assert.deepEqual([bare.status, bare.headers.get('cache-control'), bare.headers.get('cross-origin-resource-policy')], [200, 'private, no-store', 'same-site']);
    assert.equal(bare.headers.get('vary'), 'Origin', 'every image answer varies by Origin');
  } finally {
    await h.close();
  }
});

test('replace and clear: the old file is removed after the row moves on; a stale url is 404; no orphan', async () => {
  const { h, dir, ana, chair } = await shop();
  try {
    const first = (await body(await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(40, 30))) as { item: { photo: Img } }).item.photo!;
    const second = (await body(await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(50, 30))) as { item: { photo: Img } }).item.photo!;
    assert.notEqual(first.url, second.url);
    assert.equal(files(dir).stored.length, 1, 'the replaced file is gone');
    assert.equal((await client(h.url).navigate(first.url)).status, 404, 'a stale version is not the new image');
    assert.equal((await client(h.url).navigate(second.url)).status, 200);

    const cleared = await ana.c.request('DELETE', `/data/products/${chair}/photo`);
    assert.equal(cleared.status, 200);
    assert.equal((await body(cleared) as { item: { photo: Img } }).item.photo, null);
    assert.deepEqual(files(dir), { stored: [], temp: [] });
    assert.equal((await client(h.url).navigate(second.url)).status, 404);
    assert.equal((await ana.c.request('DELETE', `/data/products/${chair}/photo`)).status, 200, 'clearing an empty image is fine');
  } finally {
    await h.close();
  }
});

test('deleting a row removes its images — the owner\'s delete and an admin\'s', async () => {
  const { h, dir, ana, boss, chair, create } = await shop();
  try {
    await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(20, 20));
    await put(ana.c, `/data/products/${chair}/proof`, await plainJpeg(20, 20));
    assert.equal(files(dir).stored.length, 2);
    assert.equal((await ana.c.request('DELETE', `/data/products/${chair}`)).status, 204);
    assert.equal(files(dir).stored.length, 0);

    const stool = await create(ana.c, 'products', { name: 'Stool' });
    await put(ana.c, `/data/products/${stool}/photo`, await plainJpeg(20, 20));
    assert.equal((await boss.c.request('DELETE', `/admin/data/products/${stool}`)).status, 204);
    assert.deepEqual(files(dir), { stored: [], temp: [] });
  } finally {
    await h.close();
  }
});

test('SECURITY owner-only: another account\'s upload is 404 and writes nothing; signed out 401; no edit rule 403', async () => {
  const { h, dir, ana, bob, chair, create } = await shop();
  try {
    const jpeg = await plainJpeg(20, 20);
    assert.deepEqual([(await put(bob.c, `/data/products/${chair}/photo`, jpeg)).status, files(dir)], [404, { stored: [], temp: [] }]);
    assert.equal((await bob.c.request('DELETE', `/data/products/${chair}/photo`)).status, 404);
    assert.equal((await put(client(h.url), `/data/products/${chair}/photo`, jpeg)).status, 401);
    const ice = await create(ana.c, 'frozen', { title: 'Ice' });
    assert.deepEqual([(await put(ana.c, `/data/frozen/${ice}/cover`, jpeg)).status, files(dir).stored], [403, []]);
    assert.equal((await put(ana.c, `/data/products/${chair}/photo`, jpeg)).status, 200, 'CONTROL: the owner uploads');
    // Bob's clear of Ana's image did nothing.
    assert.equal((await bob.c.request('DELETE', `/data/products/${chair}/photo`)).status, 404);
    assert.equal(files(dir).stored.length, 1);
  } finally {
    await h.close();
  }
});

test('SECURITY image reads follow the read rule and `private`: same answer as an absent row', async () => {
  const { h, ana, bob, chair, create } = await shop();
  try {
    const proof = (await body(await put(ana.c, `/data/products/${chair}/proof`, await plainJpeg(20, 20))) as { item: { proof: Img } }).item.proof!;
    const own = await ana.c.navigate(proof.url);
    assert.deepEqual([own.status, own.headers.get('cache-control'), own.headers.get('cross-origin-resource-policy')], [200, 'private, no-store', 'same-site'],
      'the owner reads a private image, never cached for others');
    assert.equal((await bob.c.navigate(proof.url)).status, 404);
    assert.equal((await client(h.url).navigate(proof.url)).status, 404);
    assert.equal((await body(await bob.c.get(`/data/products/${chair}`)) as { item: { proof: Img } }).item.proof, null);

    const draft = await create(ana.c, 'drafts', { title: 'Plan' });
    const cover = (await body(await put(ana.c, `/data/drafts/${draft}/cover`, await plainJpeg(20, 20))) as { item: { cover: Img } }).item.cover!;
    assert.equal((await ana.c.navigate(cover.url)).headers.get('cache-control'), 'private, no-store', 'an owner-read table is never public');
    assert.equal((await bob.c.navigate(cover.url)).status, 404);
    assert.equal((await client(h.url).navigate(cover.url)).status, 401);
  } finally {
    await h.close();
  }
});

test('SECURITY CSRF: an upload needs the allowed Origin and x-az-request; a read of an image needs neither', async () => {
  const { h, dir, ana, chair } = await shop();
  try {
    const jpeg = await plainJpeg(20, 20);
    assert.equal((await ana.c.upload('PUT', `/data/products/${chair}/photo`, jpeg, { 'x-az-request': '' })).status, 403);
    assert.equal((await ana.c.upload('PUT', `/data/products/${chair}/photo`, jpeg, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await ana.c.request('DELETE', `/data/products/${chair}/photo`, undefined, { origin: 'https://evil.test' })).status, 403);
    assert.deepEqual(files(dir), { stored: [], temp: [] });
    // Only the image read is exempt: a row read from another origin is still refused.
    assert.equal((await ana.c.get(`/data/products/${chair}`, { origin: 'https://evil.test' })).status, 403);
    const evil = await ana.c.get(`/data/products/${chair}/photo`, { origin: 'https://evil.test' });
    assert.equal(evil.headers.get('access-control-allow-origin'), null, 'no CORS grant for a foreign origin');
    assert.equal((await put(ana.c, `/data/products/${chair}/photo`, jpeg)).status, 200, 'CONTROL');
  } finally {
    await h.close();
  }
});

test('SECURITY the body cap: declared or streamed past it is 413 and nothing stays on disk', async () => {
  const { h, dir, ana, chair } = await shop({ uploadLimit: 64 * 1024 });
  try {
    const big = Buffer.concat([await plainJpeg(20, 20), Buffer.alloc(70 * 1024, 1)]);
    const declared = await put(ana.c, `/data/products/${chair}/photo`, big);
    assert.deepEqual([declared.status, await body(declared)], [413, { error: 'too_large', field: 'photo' }]);
    // No Content-Length: the cap is enforced while reading the stream.
    const streamed = await fetch(`${h.url}/data/products/${chair}/photo`, {
      method: 'PUT', duplex: 'half',
      headers: { origin: 'http://127.0.0.1:5173', 'x-az-request': '1', cookie: [...ana.c.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(8 * 1024)); c.close(); } }),
    } as RequestInit);
    assert.equal(streamed.status, 413);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(files(dir), { stored: [], temp: [] });
    assert.equal((await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(20, 20))).status, 200, 'CONTROL: under the cap');
  } finally {
    await h.close();
  }
});

test('SECURITY refused content: SVG, text and HEIC are 415; a pixel bomb is 413; nothing is stored', async () => {
  const { h, dir, ana, chair } = await shop();
  try {
    for (const b of [SVG, TEXT, HEIC]) {
      const r = await put(ana.c, `/data/products/${chair}/photo`, b);
      assert.deepEqual([r.status, await body(r)], [415, { error: 'unsupported_type', field: 'photo' }]);
    }
    const bomb = await put(ana.c, `/data/products/${chair}/photo`, await pngClaiming(100_000, 100_000));
    assert.deepEqual([bomb.status, await body(bomb)], [413, { error: 'too_large', field: 'photo' }]);
    assert.deepEqual(files(dir), { stored: [], temp: [] });
    assert.equal((await body(await ana.c.get(`/data/products/${chair}`)) as { item: { photo: Img } }).item.photo, null);
  } finally {
    await h.close();
  }
});

test('SECURITY an image is never set through JSON; a locked image only by an admin (audited)', async () => {
  const { h, ana, boss, chair } = await shop();
  try {
    for (const v of ['x.webp', null, { url: 'https://evil.test/a.png', width: 1, height: 1 }]) {
      assert.deepEqual(await body(await ana.c.request('PATCH', `/data/products/${chair}`, { photo: v })), { error: 'invalid', field: 'photo' });
      assert.deepEqual(await body(await ana.c.request('POST', '/data/products', { name: 'X', photo: v })), { error: 'invalid', field: 'photo' });
    }
    assert.deepEqual(await body(await boss.c.request('PATCH', `/admin/data/products/${chair}`, { photo: null })), { error: 'invalid', field: 'photo' }, 'not even an admin');
    const jpeg = await plainJpeg(20, 20);
    assert.deepEqual(await body(await put(ana.c, `/data/products/${chair}/badge`, jpeg)), { error: 'invalid', field: 'badge' });
    const r = await put(boss.c, `/admin/data/products/${chair}/badge`, jpeg);
    assert.equal(r.status, 200, 'CONTROL: an admin sets a locked image');
    const badge = (await body(r) as { item: { badge: Img } }).item.badge!;
    assert.match(badge.url, /\/admin\/data\/products\/.+\/badge\?v=/);
    const audit = await body(await boss.c.get('/admin/audit')) as { items: { action: string; row: string }[] };
    assert.deepEqual(audit.items.map((a) => [a.action, a.row]), [['edit', chair]]);
    // An admin reads a private image of any row; the public route stays the owner's.
    const proof = (await body(await put(ana.c, `/data/products/${chair}/proof`, jpeg)) as { item: { proof: Img } }).item.proof!;
    assert.equal((await boss.c.navigate(proof.url)).status, 404, 'the public route: not the owner');
    const adminView = (await body(await boss.c.get(`/admin/data/products/${chair}`)) as { item: { proof: Img } }).item.proof!;
    const seen = await boss.c.navigate(adminView.url);
    assert.deepEqual([seen.status, seen.headers.get('cache-control')], [200, 'private, no-store']);
    assert.equal((await ana.c.navigate(adminView.url)).status, 403, 'the admin route: admins only');
    assert.equal((await boss.c.request('DELETE', `/admin/data/products/${chair}/badge`)).status, 200);
  } finally {
    await h.close();
  }
});

test('SECURITY no traversal or stray routes: only declared image fields, uuid ids, `v` the only parameter', async () => {
  const { h, ana, chair } = await shop();
  try {
    await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(20, 20));
    const anon = client(h.url);
    for (const path of [
      `/data/products/${chair}/name`, `/data/products/${chair}/nosuch`, `/data/products/${chair}/..%2F..%2Fetc%2Fpasswd`,
      `/data/products/${chair}/%2e%2e`, `/data/products/not-a-uuid/photo`, `/data/products/${chair}/photo/x`, `/data/nosuch/${chair}/photo`,
    ]) {
      assert.equal((await anon.get(path)).status, 404, path);
      // Without an Origin, a path that is not an image read (`%2e%2e` is resolved by the URL parser) is refused at the edge.
      assert.equal((await anon.navigate(`${h.url}${path}`)).status, /\/x$|%2e%2e$/.test(path) ? 403 : 404, `${path} without Origin`);
    }
    assert.deepEqual(await body(await anon.navigate(`${h.url}/data/products/${chair}/photo?x=1`)), { error: 'bad_query', field: 'x' });
    assert.deepEqual(await body(await anon.navigate(`${h.url}/data/products/${chair}/photo?v=a&v=b`)), { error: 'bad_query', field: 'v' });
    assert.deepEqual(await body(await anon.get('/data/products?photo=x')), { error: 'bad_query', field: 'photo' }, 'an image is not a filter');
    assert.equal((await ana.c.request('PATCH', `/data/products/${chair}/photo`)).status, 404, 'only GET, PUT, DELETE');
  } finally {
    await h.close();
  }
});

test('the upload limit: 30 an hour per account (data-spec §5.5)', async () => {
  const { h, ana, chair } = await shop();
  try {
    const jpeg = await plainJpeg(8, 8);
    for (let i = 0; i < 30; i++) assert.equal((await put(ana.c, `/data/products/${chair}/photo`, jpeg)).status, 200, `upload ${i + 1}`);
    assert.deepEqual(await body(await put(ana.c, `/data/products/${chair}/photo`, jpeg)), { error: 'rate_limited' });
    h.clock.now += 60 * 60 * 1000 + 1;
    assert.equal((await put(ana.c, `/data/products/${chair}/photo`, jpeg)).status, 200, 'CONTROL: the next hour');
  } finally {
    await h.close();
  }
});

test('the orphan sweep: a file no row names (a crash between file and row) is removed; files in use are kept', async () => {
  const { h, dir, images, ana, chair } = await shop();
  try {
    const photo = (await body(await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(20, 20))) as { item: { photo: Img } }).item.photo!;
    // A file stored whose row was never written: what a crash between the two leaves.
    const temp = images.tempPath();
    writeFileSync(temp, await plainJpeg(20, 20));
    const crashed = await images.store(temp);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const n of files(dir).stored) utimesSync(join(dir, n), old, old);
    const api = createData({ db: h.db, tables: dataOf(SHOP).tables, images });
    assert.equal(await api.sweepImages(), 1);
    assert.deepEqual(files(dir).stored.includes(crashed.key), false);
    assert.equal((await client(h.url).navigate(photo.url)).status, 200, 'CONTROL: the image in use is served');
  } finally {
    await h.close();
  }
});

/* ---- width copies (data-spec §8) --------------------------------------- */

type Sized = { url: string; width: number; height: number; variants: { url: string; width: number }[] };
const HEADERS = ['content-type', 'x-content-type-options', 'content-disposition', 'content-security-policy', 'cache-control',
  'cross-origin-resource-policy', 'vary', 'x-frame-options', 'referrer-policy', 'strict-transport-security'];
const headersOf = (r: Response) => Object.fromEntries(HEADERS.map((k) => [k, r.headers.get(k)]));
/** The stored files of one key's UUID. */
const setOf = (dir: string, key: string) => readdirSync(dir).filter((n) => n.startsWith(key.slice(0, 36))).sort();
/** The key a row's image field holds now. */
const keyOf = async (h: Harness, table: string, field: string, id: string) =>
  String((await h.db.get(`SELECT "${field}" AS k FROM "azd_${table}" WHERE id = ?`, [id]))?.k);

test('width copies over HTTP: the item lists them, each serves its width with the original\'s headers; any other width is 404', async () => {
  const { h, ana, chair } = await shop();
  try {
    const r = await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(1600, 1000));
    const photo = (await body(r) as { item: { photo: Sized } }).item.photo;
    assert.deepEqual(photo.variants, [480, 768, 1200].map((w) => ({ url: `${photo.url}&w=${w}`, width: w })));
    const original = await client(h.url).navigate(photo.url);
    await original.body?.cancel();
    for (const v of photo.variants) {
      const img = await client(h.url).navigate(v.url);
      assert.equal(img.status, 200, v.url);
      assert.deepEqual(headersOf(img), headersOf(original), `${v.width}: the same §8 and security headers`);
      assert.equal(headersOf(img)['cache-control'], 'public, max-age=31536000, immutable');
      const bytes = Buffer.from(await img.arrayBuffer());
      assert.equal(img.headers.get('content-length'), String(bytes.length));
      assert.equal((await sharp(bytes).metadata()).width, v.width);
      // A fetch() from the site gets its CORS grant, as for the original.
      const fetched = await ana.c.get(v.url.slice(h.url.length));
      assert.deepEqual([fetched.status, fetched.headers.get('access-control-allow-origin'), fetched.headers.get('vary')], [200, SITE, 'Origin']);
      await fetched.body?.cancel();
    }
    const base = photo.url;
    for (const w of ['500', '2048', '1600', '0480', '480.0', '480%20', '%20480', '+480', '4.8e2', '', 'x', '-480', '480%00']) {
      const bad = await client(h.url).navigate(`${base}&w=${w}`);
      assert.equal(bad.status, 404, `w=${w}`);
      assert.equal(bad.headers.get('cache-control'), 'no-store', `w=${w}: a 404 is never cached`);
    }
    assert.deepEqual(await body(await client(h.url).navigate(`${base}&w=480&w=768`)), { error: 'bad_query', field: 'w' });
    assert.equal((await client(h.url).navigate(`${base.replace(/v=[^&]+/, `v=${'0'.repeat(36)}`)}&w=480`)).status, 404, 'a stale v with a width is 404');
    // Without v, a copy is private like the bare original.
    const bare = await client(h.url).navigate(`${h.url}/data/products/${chair}/photo?w=480`);
    assert.deepEqual([bare.status, bare.headers.get('cache-control'), bare.headers.get('cross-origin-resource-policy')], [200, 'private, no-store', 'same-site']);
    await bare.body?.cancel();
    // A 1000 px image has no 1200 copy: never upscaled, so that width is 404.
    const narrow = (await body(await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(1000, 600))) as { item: { photo: Sized } }).item.photo;
    assert.deepEqual(narrow.variants.map((v) => v.width), [480, 768]);
    assert.equal((await client(h.url).navigate(`${narrow.url}&w=1200`)).status, 404);
    assert.equal((await client(h.url).navigate(`${narrow.url}&w=768`)).status, 200, 'CONTROL: a width it has');
  } finally {
    await h.close();
  }
});

test('SECURITY a private image\'s copies follow its rule: the owner reads them uncached, others get 404', async () => {
  const { h, ana, bob, chair } = await shop();
  try {
    const proof = (await body(await put(ana.c, `/data/products/${chair}/proof`, await plainJpeg(1600, 1000))) as { item: { proof: Sized } }).item.proof;
    assert.equal(proof.variants.length, 3);
    for (const v of proof.variants) {
      const own = await ana.c.navigate(v.url);
      assert.deepEqual([own.status, own.headers.get('cache-control'), own.headers.get('cross-origin-resource-policy')], [200, 'private, no-store', 'same-site']);
      await own.body?.cancel();
      assert.equal((await bob.c.navigate(v.url)).status, 404);
      assert.equal((await client(h.url).navigate(v.url)).status, 404);
    }
  } finally {
    await h.close();
  }
});

test('every delete path removes every copy: replace, clear, the row\'s delete, an admin\'s delete and an admin\'s clear', async () => {
  const { h, dir, ana, boss, chair, create } = await shop();
  try {
    const big = await plainJpeg(1600, 1000);
    await put(ana.c, `/data/products/${chair}/photo`, big);
    const first = await keyOf(h, 'products', 'photo', chair);
    assert.equal(setOf(dir, first).length, 4, 'CONTROL: four files');
    await put(ana.c, `/data/products/${chair}/photo`, big);
    const second = await keyOf(h, 'products', 'photo', chair);
    assert.deepEqual([setOf(dir, first), setOf(dir, second).length], [[], 4], 'replace: the old key\'s four files are gone');
    await ana.c.request('DELETE', `/data/products/${chair}/photo`);
    assert.deepEqual(files(dir), { stored: [], temp: [] }, 'clear');

    await put(ana.c, `/data/products/${chair}/photo`, big);
    await put(ana.c, `/data/products/${chair}/proof`, big);
    assert.equal(files(dir).stored.length, 8);
    assert.equal((await ana.c.request('DELETE', `/data/products/${chair}`)).status, 204);
    assert.deepEqual(files(dir), { stored: [], temp: [] }, 'the owner\'s row delete');

    const stool = await create(ana.c, 'products', { name: 'Stool' });
    await put(ana.c, `/data/products/${stool}/photo`, big);
    assert.equal((await boss.c.request('DELETE', `/admin/data/products/${stool}`)).status, 204);
    assert.deepEqual(files(dir), { stored: [], temp: [] }, 'an admin\'s row delete');

    const lamp = await create(ana.c, 'products', { name: 'Lamp' });
    assert.equal((await put(boss.c, `/admin/data/products/${lamp}/badge`, big)).status, 200);
    assert.equal(files(dir).stored.length, 4);
    assert.equal((await boss.c.request('DELETE', `/admin/data/products/${lamp}/badge`)).status, 200);
    assert.deepEqual(files(dir), { stored: [], temp: [] }, 'an admin\'s clear');
  } finally {
    await h.close();
  }
});

test('the claim cleanup: a planted account\'s rows go with the claim, and the sweep takes every copy of their images', async () => {
  const { h, dir, images, create } = await shop();
  try {
    const planter = await signUp(h, 'Victim');
    const row = await create(planter.c, 'products', { name: 'Planted' });
    assert.equal((await put(planter.c, `/data/products/${row}/photo`, await plainJpeg(1600, 1000))).status, 200);
    const key = await keyOf(h, 'products', 'photo', row);
    assert.equal(setOf(dir, key).length, 4);
    const owner = client(h.url);
    await owner.post('/auth/link', { email: 'victim@studio.test' });
    await new Promise((r) => setTimeout(r, 20));
    const link = /https?:\/\/\S+/.exec(h.mail.at(-1)!.text)![0];
    assert.equal((await owner.navigate(link)).status, 302);
    assert.equal(await h.db.get('SELECT id FROM "azd_products" WHERE id = ?', [row]), undefined, 'CONTROL: the claim deleted the planted row');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const n of setOf(dir, key)) utimesSync(join(dir, n), old, old);
    const api = createData({ db: h.db, tables: dataOf(SHOP).tables, images });
    assert.equal(await api.sweepImages(), 4);
    assert.deepEqual(setOf(dir, key), []);
  } finally {
    await h.close();
  }
});

/** An image stored the way uploads were before width copies: `<uuid>.webp`, named by its row. */
async function legacyImage(h: Harness, dir: string, id: string, w: number, ht: number): Promise<string> {
  const key = `${randomUUID()}.webp`;
  writeFileSync(join(dir, key), await sharp(await plainJpeg(w, ht)).webp({ quality: 80 }).toBuffer());
  await h.db.run('UPDATE "azd_products" SET photo = ?, photo__w = ?, photo__h = ? WHERE id = ?', [key, w, ht, id]);
  return key;
}

test('an image stored before width copies keeps working: no variants, its url serves, every width is 404', async () => {
  const { h, dir, chair } = await shop();
  try {
    const key = await legacyImage(h, dir, chair, 1600, 1000);
    const photo = (await body(await client(h.url).get(`/data/products/${chair}`)) as { item: { photo: Sized } }).item.photo;
    assert.deepEqual([photo.width, photo.variants], [1600, []]);
    assert.equal(photo.url, `${h.url}/data/products/${chair}/photo?v=${key.slice(0, 36)}`);
    const img = await client(h.url).navigate(photo.url);
    assert.deepEqual([img.status, img.headers.get('cache-control')], [200, 'public, max-age=31536000, immutable']);
    await img.body?.cancel();
    for (const w of [480, 768, 1200]) assert.equal((await client(h.url).navigate(`${photo.url}&w=${w}`)).status, 404, `w=${w}`);
  } finally {
    await h.close();
  }
});

test('the backfill: counts without confirm; with it, gives old images copies under the same url, and removes the old file', async () => {
  const { h, dir, images, ana, chair, create } = await shop();
  try {
    const key = await legacyImage(h, dir, chair, 1600, 1000);
    const small = await create(ana.c, 'products', { name: 'Small' });
    await legacyImage(h, dir, small, 300, 200);
    const fresh = await create(ana.c, 'products', { name: 'Fresh' });
    await put(ana.c, `/data/products/${fresh}/photo`, await plainJpeg(1600, 1000));
    const api = createData({ db: h.db, tables: dataOf(SHOP).tables, images, publicUrl: h.url });
    const before = readdirSync(dir).sort();
    assert.deepEqual(await api.backfillImages({ confirm: false, deadline: Infinity }), { widened: 0, left: 2, skipped: 0 });
    assert.deepEqual(readdirSync(dir).sort(), before, 'without confirm nothing changes');
    assert.deepEqual(await api.backfillImages({ confirm: true, deadline: 0 }), { widened: 0, left: 2, skipped: 0 }, 'past its deadline it starts nothing');
    assert.deepEqual(readdirSync(dir).sort(), before);

    assert.deepEqual(await api.backfillImages({ confirm: true, deadline: Infinity, settleMs: 0 }), { widened: 2, left: 0, skipped: 0 });
    const now = await keyOf(h, 'products', 'photo', chair);
    assert.equal(now, `${key.slice(0, 36)}.full.webp`);
    assert.deepEqual(setOf(dir, key), [`${key.slice(0, 36)}.1200.webp`, `${key.slice(0, 36)}.480.webp`, `${key.slice(0, 36)}.768.webp`, now].sort(), 'the old file is gone');
    const photo = (await body(await client(h.url).get(`/data/products/${chair}`)) as { item: { photo: Sized } }).item.photo;
    assert.equal(photo.url, `${h.url}/data/products/${chair}/photo?v=${key.slice(0, 36)}`, 'the same url: cached copies stay right');
    assert.deepEqual(photo.variants.map((v) => v.width), [480, 768, 1200]);
    for (const v of [photo, ...photo.variants]) assert.equal((await client(h.url).navigate(v.url)).status, 200, v.url);
    const tiny = (await body(await client(h.url).get(`/data/products/${small}`)) as { item: { photo: Sized } }).item.photo;
    assert.deepEqual(tiny.variants, [], 'a 300 px image is moved but has no narrower copy');
    assert.deepEqual(await api.backfillImages({ confirm: false, deadline: Infinity }), { widened: 0, left: 0, skipped: 0 }, 'a second run finds nothing');
  } finally {
    await h.close();
  }
});

test('the backfill never overwrites a newer image: a replace while it works wins, and its own new files go', async () => {
  const { h, dir, images, ana, chair } = await shop();
  try {
    const key = await legacyImage(h, dir, chair, 1600, 1000);
    let replaced = '';
    // The owner replaces the image while the backfill is making its copies.
    const racing: typeof images = {
      ...images,
      async addWidths(k) {
        const made = await images.addWidths(k);
        assert.equal((await put(ana.c, `/data/products/${chair}/photo`, await plainJpeg(900, 600))).status, 200);
        replaced = await keyOf(h, 'products', 'photo', chair);
        return made;
      },
    };
    const api = createData({ db: h.db, tables: dataOf(SHOP).tables, images: racing });
    assert.deepEqual(await api.backfillImages({ confirm: true, deadline: Infinity, settleMs: 0 }), { widened: 0, left: 0, skipped: 0 });
    assert.equal(await keyOf(h, 'products', 'photo', chair), replaced, 'the replacement stays');
    assert.deepEqual(setOf(dir, key), [], 'neither the old file (the replace removed it) nor the backfill\'s copies remain');
    assert.equal(setOf(dir, replaced).length, 3, 'CONTROL: the replacement\'s own files (900 px: 480 and 768)');
    // A row whose file went missing is skipped, named by count only.
    const lines: string[] = [];
    const lost = `${randomUUID()}.webp`;
    await h.db.run('UPDATE "azd_products" SET photo = ? WHERE id = ?', [lost, chair]);
    const logged = createData({ db: h.db, tables: dataOf(SHOP).tables, images, log: (l) => lines.push(l) });
    assert.deepEqual(await logged.backfillImages({ confirm: true, deadline: Infinity, settleMs: 0 }), { widened: 0, left: 0, skipped: 1 });
    assert.equal(await keyOf(h, 'products', 'photo', chair), lost, 'left as it was');
    assert.ok(lines.length === 1 && !lines[0].includes(lost.slice(0, 36)), lines.join('\n'));
  } finally {
    await h.close();
  }
});
