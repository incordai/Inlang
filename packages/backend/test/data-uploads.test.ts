/**
 * The image routes over SQLite (data-spec §5, §8, §13): upload, serve,
 * replace, clear and delete with no file left behind; the serving headers;
 * the read rule and `private` on an image read; owner-only uploads, CSRF,
 * the body cap enforced while streaming, refused types and bombs, the upload
 * limit, admin uploads with the audit, no path traversal, the orphan sweep.
 * Each refusal has a CONTROL that the same route works for the right caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, startBackend, type Harness } from './helpers.ts';
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

    // The same row read and listed carries the same image.
    const one = await body(await ana.c.get(`/data/products/${chair}`)) as { item: { photo: Img; proof: Img } };
    assert.deepEqual([one.item.photo, one.item.proof], [photo, null]);
    const list = await body(await client(h.url).get('/data/products')) as { items: { photo: Img }[] };
    assert.deepEqual(list.items[0].photo, photo);

    // Without `v` (not the URL the API hands out), never cached as immutable.
    const bare = await client(h.url).navigate(`${h.url}/data/products/${chair}/photo`);
    assert.deepEqual([bare.status, bare.headers.get('cache-control'), bare.headers.get('cross-origin-resource-policy')], [200, 'private, no-store', 'same-site']);
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
