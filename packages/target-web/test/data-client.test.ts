/**
 * src/data/client.ts (data-spec §7): emitted only with tables, only the
 * operations a rule grants, deterministic, type-correct under strict
 * TypeScript, and — run against a recorded fetch — the exact requests the
 * server expects and a result for every answer, never a throw. The real
 * server is reached from a browser in scripts/data-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { dataClient } from '../src/data-client.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
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
const DATA = `  data products
    name text required search
    price money usd required
    status choice draft live default draft
    featured flag
    contact email private
    stock number locked default 0
    allow anyone read
    allow signedin create
    allow owner edit delete
  data class
    label text
    allow anyone create
`;
const specOf = (data: string) => {
  const r = compile(SITE(data), { manifests });
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  return r.spec!;
};

test('emitted only with tables; deterministic', () => {
  const withData = emitProject(specOf(DATA), { emitters: {} }).files.find((f) => f.path === 'src/data/client.ts');
  assert.ok(withData);
  assert.equal(withData.content, dataClient(specOf(DATA).site.data!));
  assert.equal(dataClient(specOf(DATA).site.data!), dataClient(specOf(DATA).site.data!));
  assert.ok(!emitProject(specOf(''), { emitters: {} }).files.some((f) => f.path.startsWith('src/data/')), 'CONTROL: none without tables');
});

test('only granted operations; a table named like a keyword is a key, not a variable', () => {
  const src = dataClient(specOf(DATA).site.data!);
  const products = /products: \{([\s\S]*?)\n {2}\},/.exec(src)![1];
  assert.deepEqual([...products.matchAll(/^ {4}(\w+): \(/gm)].map((m) => m[1]), ['list', 'get', 'create', 'update', 'remove']);
  const klass = /class: \{([\s\S]*?)\n {2}\},/.exec(src)![1];
  assert.deepEqual([...klass.matchAll(/^ {4}(\w+): \(/gm)].map((m) => m[1]), ['create']);
  assert.ok(!/export const class\b/.test(src));
  assert.match(src, /export interface ProductsRowInput \{\n {2}name: string;\n {2}price: number;\n {2}status\?: "draft" \| "live" \| null;/, 'required without a default is required input; the rest optional');
  assert.ok(!/ProductsRowInput \{[^}]*stock/.test(src), 'locked fields are not input');
  assert.match(src, /readonly contact: string \| null;/, 'private reads as nullable');
});

test('a write answers with its row only as the read rules grant it (review #4)', () => {
  const src = dataClient(specOf(`${DATA}  data notes\n    body text\n    allow owner read edit\n    allow signedin create\n  data tips\n    body text\n    allow signedin read\n    allow anyone create\n`).site.data!);
  assert.match(src, /create: \(input: ProductsRowInput\) => call<\{ item: ProductsRow \}>/, 'anyone reads: the row');
  assert.match(src, /create: \(input: ClassRowInput\) => call<\{ item: null \}>/, 'nobody reads: never the row');
  assert.match(src, /create: \(input: NotesRowInput\) => call<\{ item: NotesRow \}>/, 'the creator owns it and owners read');
  assert.match(src, /update: \(id: string, changes: NotesRowPatch\) => toRow<\{ item: NotesRow \}>/);
  assert.match(src, /create: \(input: TipsRowInput\) => call<\{ item: TipsRow \| null \}>/, 'signed out, the creator may not read it');
});

const IMAGES = `  data products
    name text required
    photo image
    proof image private
    badge image locked
    allow anyone read
    allow signedin create
    allow owner edit delete
  data gallery
    cover image
    allow anyone read
    allow signedin create
`;

/** Tables named like the platform's own types, and two that once shared a type name (review #6). */
const CLASHES = ['records', 'promises', 'responses', 'requests', 'errors', 'maps', 'box', 'boxes']
  .map((t) => `  data ${t}\n    label text required\n    allow anyone read\n    allow signedin create\n    allow owner edit delete\n`).join('');

test('the generated client type-checks under strict TypeScript — with and without image fields, and tables named like built-ins', () => {
  for (const data of [DATA, IMAGES, CLASHES]) {
    const dir = mkdtempSync(join(tmpdir(), 'az-client-'));
    writeFileSync(join(dir, 'client.ts'), dataClient(specOf(data).site.data!));
    // A module beside it that uses the client AND the built-ins the tables are named after.
    if (data === CLASHES) {
      writeFileSync(join(dir, 'use.ts'), [
        'import { tables, type RecordsRow, type BoxRow, type BoxesRow } from "./client.ts";',
        'const byId: Record<string, RecordsRow> = {};',
        'const wait: Promise<Response> = fetch("/");',
        'const pair: [BoxRow["label"], BoxesRow["label"]] = ["a", "b"];',
        'export const used = [byId, wait, pair, tables.box.list, tables.boxes.list, new Map<string, Error>()];',
        '',
      ].join('\n'));
    }
    writeFileSync(join(dir, 'env.d.ts'), 'interface ImportMeta { readonly env: Record<string, string | undefined> }\n');
    const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
    // Run from the temporary folder: no project tsconfig.json applies there.
    const r = spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--allowImportingTsExtensions', 'client.ts', 'env.d.ts', ...(data === CLASHES ? ['use.ts'] : [])], { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test('image fields: DataImage | null in rows, never input; upload/clear only where an edit rule opens them, locked ones admin-only', () => {
  const src = dataClient(specOf(IMAGES).site.data!);
  assert.match(src, /readonly photo: DataImage \| null;/);
  assert.ok(!/ProductsRowInput \{[^}]*(photo|proof|badge)/.test(src) && !/ProductsRowPatch \{[^}]*(photo|proof|badge)/.test(src), 'never sent as JSON');
  const products = /products: \{([\s\S]*?)\n {2}\},/.exec(src)![1];
  assert.deepEqual([...products.matchAll(/^ {4}(\w+): \(/gm)].map((m) => m[1]), ['list', 'get', 'create', 'update', 'remove', 'upload', 'clear']);
  assert.match(products, /upload: \(id: string, field: "photo" \| "proof", file: Blob\)/, 'the locked badge is not offered');
  const gallery = /gallery: \{([\s\S]*?)\n {2}\},/.exec(src)![1];
  assert.ok(!/upload|clear/.test(gallery), 'no edit rule, no upload');
  assert.match(src, /^ {2}upload: \(table: TableName, id: string, field: string, file: Blob\)/m, 'admins upload to any image field');
  const plain = dataClient(specOf(DATA).site.data!);
  assert.ok(!/DataImage/.test(plain), 'CONTROL: no image type without image fields');
  const plainProducts = /products: \{([\s\S]*?)\n {2}\},/.exec(plain)![1];
  assert.ok(!/upload|clear/.test(plainProducts), 'CONTROL: no table upload without image fields');
});

test('AZ.md names the image fields and where uploads go; a site without them says nothing of images', () => {
  const md = (data: string) => emitProject(specOf(data), { emitters: {} }).files.find((f) => f.path === 'AZ.md')!.content;
  assert.match(md(IMAGES), /- Images \(`products\.photo`, `products\.proof`, `products\.badge`, `gallery\.cover`; data-spec §8\)/);
  assert.match(md(IMAGES), /`server\/src\/data-images\.ts`/);
  assert.doesNotMatch(md(DATA), /- Images \(/, 'CONTROL');
});

test('upload sends the file\'s raw bytes with the CSRF header; clear is a DELETE', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { tables, calls } = await loadClient(() => Response.json({ item: { id: 'x', photo: null } }), IMAGES);
    const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
    assert.deepEqual(await tables.products.upload(ID, 'photo', file), { ok: true, item: { id: 'x', photo: null } });
    await tables.products.clear(ID, 'proof');
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['PUT', `https://api.studio.test/data/products/${ID}/photo`],
      ['DELETE', `https://api.studio.test/data/products/${ID}/proof`],
    ]);
    assert.equal(calls[0].init.body, file, 'the Blob itself, not JSON');
    assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/octet-stream', 'x-az-request': '1' });
    assert.equal(calls[0].init.credentials, 'include');
    assert.deepEqual(calls[1].init.headers, { 'x-az-request': '1' });
  } finally { globalThis.fetch = realFetch; }
});

test('imageSrcset: each width copy and the image at its width; none for an image without copies', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { mod } = await loadClient(() => Response.json({}), IMAGES);
    const srcset = mod.imageSrcset as (i: unknown) => string | undefined;
    const url = `https://api.studio.test/data/products/${ID}/photo?v=${ID}`;
    assert.equal(srcset({ url, width: 1600, height: 1000, variants: [480, 768, 1200].map((w) => ({ url: `${url}&w=${w}`, width: w })) }),
      `${url}&w=480 480w, ${url}&w=768 768w, ${url}&w=1200 1200w, ${url} 1600w`);
    assert.equal(srcset({ url, width: 1600, height: 1000, variants: [] }), undefined, 'an image stored before copies: its src alone');
    assert.ok(!/imageSrcset/.test(dataClient(specOf(DATA).site.data!)), 'CONTROL: none without image fields');
  } finally { globalThis.fetch = realFetch; }
});

/** The generated module, loaded with its backend address fixed and fetch recorded. */
async function loadClient(respond: (url: string, init: RequestInit) => Promise<Response> | Response, data = DATA) {
  const dir = mkdtempSync(join(tmpdir(), 'az-client-'));
  const src = dataClient(specOf(data).site.data!).replace(/import\.meta\.env\.AZ_PUBLIC_BACKEND_URL/, '"https://api.studio.test"');
  writeFileSync(join(dir, 'client.ts'), src);
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  type Op = (...a: unknown[]) => Promise<Record<string, unknown>>;
  const mod = await import(pathToFileURL(join(dir, 'client.ts')).href) as { tables: Record<string, Record<string, Op>>; admin: Record<string, Op> } & Record<string, unknown>;
  return { tables: mod.tables, admin: mod.admin, calls, mod };
}

/** A row id as the server makes one (randomUUID). */
const ID = '0b6f5c2e-7d4a-4c1b-9e3f-2a8d6c4b1f00';

test('requests: the address, credentials, the CSRF header on writes only, encoded queries and ids', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { tables, calls } = await loadClient(() => Response.json({ items: [], next: null }));
    await tables.products.list({ limit: 5, sort: '-price', featured: true, 'status.in': ['draft', 'live'], 'price.gte': 100, mine: true, q: 'a&b' });
    await tables.products.get(ID);
    await tables.products.create({ name: 'n', price: 1 });
    await tables.products.update(ID, { price: 2 });
    await tables.products.remove(ID);
    assert.equal(calls[0].url, 'https://api.studio.test/data/products?limit=5&sort=-price&featured=on&status.in=draft%2Clive&price.gte=100&mine=1&q=a%26b');
    assert.equal(calls[1].url, `https://api.studio.test/data/products/${ID}`);
    assert.deepEqual(calls.map((c) => c.init.method), ['GET', 'GET', 'POST', 'PATCH', 'DELETE']);
    for (const c of calls) {
      assert.equal(c.init.credentials, 'include');
      const h = c.init.headers as Record<string, string>;
      assert.equal(h['x-az-request'], c.init.method === 'GET' ? undefined : '1', `${c.init.method} CSRF header`);
    }
    assert.equal(calls[2].init.body, '{"name":"n","price":1}');
    assert.equal((calls[2].init.headers as Record<string, string>)['content-type'], 'application/json');
  } finally { globalThis.fetch = realFetch; }
});

test('results: every answer resolves — data, a closed code with its field, or unknown', async () => {
  const realFetch = globalThis.fetch;
  try {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Response.json({ item: { id: 'x' } }, { status: 201 }),
      () => Response.json({ error: 'taken', field: 'sku' }, { status: 409 }),
      () => Response.json({ error: 'something-new' }, { status: 400 }),
      () => new Response('<html>proxy error</html>', { status: 502 }),
      () => { throw new TypeError('network down'); },
      () => new Response(null, { status: 204 }),
    ];
    let i = 0;
    const { tables } = await loadClient(() => answers[i++]());
    assert.deepEqual(await tables.products.create({ name: 'n', price: 1 }), { ok: true, item: { id: 'x' } });
    assert.deepEqual(await tables.products.create({ name: 'n', price: 1 }), { ok: false, code: 'taken', field: 'sku' });
    assert.deepEqual(await tables.products.create({ name: 'n', price: 1 }), { ok: false, code: 'unknown' });
    assert.deepEqual(await tables.products.list(), { ok: false, code: 'unknown' });
    assert.deepEqual(await tables.products.list(), { ok: false, code: 'unknown' });
    assert.deepEqual(await tables.products.remove(ID), { ok: true });
  } finally { globalThis.fetch = realFetch; }
});

test('ids: only a row id the server could have made reaches a URL; `..` and the rest are not_found, with no request', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { tables, admin, calls } = await loadClient(() => Response.json({ item: { id: ID } }), IMAGES);
    const bad = ['..', '.', '', '../products', 'a/b', '%2e%2e', ID.toUpperCase(), `${ID}/..`, ` ${ID}`, `${ID}?x=1`];
    const file = new Blob([new Uint8Array([1])]);
    for (const id of bad) {
      for (const [what, run] of [
        ['get', () => tables.products.get(id)], ['update', () => tables.products.update(id, { price: 2 })],
        ['remove', () => tables.products.remove(id)], ['upload', () => tables.products.upload(id, 'photo', file)],
        ['clear', () => tables.products.clear(id, 'photo')],
        ['admin.get', () => admin.get('products', id)], ['admin.update', () => admin.update('products', id, {})],
        ['admin.remove', () => admin.remove('products', id)], ['admin.clear', () => admin.clear('products', id, 'photo')],
        ['admin.upload', () => admin.upload('products', id, 'photo', file)],
      ] as const) {
        assert.deepEqual(await run(), { ok: false, code: 'not_found' }, `${what}(${JSON.stringify(id)})`);
      }
    }
    // A field or table that is not a name: `clear(id, "..")` would otherwise be the row's DELETE.
    for (const field of ['..', '.', 'a/b', '']) {
      assert.deepEqual(await admin.clear('products', ID, field), { ok: false, code: 'not_found' }, `field ${field}`);
      assert.deepEqual(await admin.upload('products', ID, field, file), { ok: false, code: 'not_found' }, `field ${field}`);
    }
    assert.deepEqual(await admin.get('..', ID), { ok: false, code: 'not_found' }, 'table ..');
    assert.equal(calls.length, 0, 'no refused id ever became a request');
    // CONTROL: a real id goes out, unchanged.
    assert.deepEqual(await admin.get('products', ID), { ok: true, item: { id: ID } });
    assert.deepEqual(await admin.clear('products', ID, 'photo'), { ok: true, item: { id: ID } });
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['GET', `https://api.studio.test/admin/data/products/${ID}`],
      ['DELETE', `https://api.studio.test/admin/data/products/${ID}/photo`],
    ]);
  } finally { globalThis.fetch = realFetch; }
});
