/**
 * The maps' tile route (chat-block-spec §21.4.3, Q19e): a tile archive read
 * by HTTP Range — one range, 206 with its Content-Range, 416 for any range it
 * cannot or will not serve — strong ETags, the preconditions a tile reader
 * sends, the glyph and sprite paths under the operator's folders only, and
 * the CORS edge: an allowed origin, `range` and `if-match` allowed, `etag`
 * and `content-range` exposed. And the start-up check of what .env names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTiles, openTiles, parseRange, readArchiveHeader, TilesProblem } from '../src/server/chat-tiles.ts';
import type { MapConfig } from '../src/server/env.ts';
import { SITE, startBackend } from './helpers.ts';

/** A 127-byte PMTiles v3 header with these zooms, then `body` bytes of data. */
function archive(minZoom: number, maxZoom: number, body = 300): Buffer {
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1');
  header.writeUInt8(3, 7);
  header.writeUInt8(minZoom, 100);
  header.writeUInt8(maxZoom, 101);
  header.writeInt32LE(-1_800_000_000, 102);
  header.writeInt32LE(-850_000_000, 106);
  header.writeInt32LE(1_800_000_000, 110);
  header.writeInt32LE(850_000_000, 114);
  return Buffer.concat([header, Buffer.from(Array.from({ length: body }, (_, i) => i % 251))]);
}

/** A folder of map files as an operator lays them out, and its MapConfig. */
function files(): { dir: string; map: MapConfig; world: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'az-tiles-'));
  const world = archive(0, 6);
  writeFileSync(join(dir, 'world.pmtiles'), world);
  writeFileSync(join(dir, 'region.pmtiles'), archive(0, 14, 40));
  mkdirSync(join(dir, 'glyphs', 'Noto Sans Regular'), { recursive: true });
  writeFileSync(join(dir, 'glyphs', 'Noto Sans Regular', '0-255.pbf'), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, 'glyphs', 'Noto Sans Regular', '256-511.pbf'), Buffer.from([4, 5]));
  mkdirSync(join(dir, 'sprites'));
  writeFileSync(join(dir, 'sprites', 'light.json'), '{}\n');
  writeFileSync(join(dir, 'sprites', 'light@2x.png'), Buffer.from([0x89, 0x50]));
  writeFileSync(join(dir, 'secret.txt'), 'not a map file');
  return {
    dir, world,
    map: {
      world: join(dir, 'world.pmtiles'), region: join(dir, 'region.pmtiles'), glyphs: join(dir, 'glyphs'), sprites: join(dir, 'sprites'),
      attribution: 'Map data: the operator’s',
    },
  };
}

test('parseRange: one byte range, a suffix, an open end; a last byte past the end is the end', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-15', 100), { start: 0, end: 15 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 }, 'a suffix past the size is the whole file');
  assert.deepEqual(parseRange('bytes=0-16383', 100), { start: 0, end: 99 }, 'the tile reader asks for 16 KB of a smaller file');
});

test('parseRange: a first byte past the end, a reversed range, more than one, another unit or nothing is unsatisfiable', () => {
  for (const h of ['bytes=100-', 'bytes=100-200', 'bytes=20-10', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-0', 'bytes=-', 'bytes=abc', 'bytes= 0-1', 'bytes=0x10-20', '']) {
    assert.equal(parseRange(h, 100), 'unsatisfiable', h);
  }
  assert.equal(parseRange('bytes=-1', 0), 'unsatisfiable', 'an empty file has no byte to give');
});

test('readArchiveHeader: a PMTiles v3 header, or why not', () => {
  assert.deepEqual(readArchiveHeader(archive(2, 9).subarray(0, 127)), { minZoom: 2, maxZoom: 9, bounds: [-180, -85, 180, 85] });
  assert.equal(readArchiveHeader(Buffer.alloc(40)), 'is shorter than a tile archive header');
  assert.equal(readArchiveHeader(Buffer.alloc(127)), 'is not a PMTiles archive');
  const v2 = archive(0, 6);
  v2.writeUInt8(2, 7);
  assert.equal(readArchiveHeader(v2), 'is not a version 3 PMTiles archive');
  assert.equal(readArchiveHeader(archive(9, 2)), 'has zoom levels out of order');
});

test('openTiles: each file .env names is opened at start-up — a missing or foreign one refused by its key, never its path', async () => {
  const f = files();
  try {
    const opened = await openTiles(f.map);
    assert.deepEqual(Object.keys(opened.archives).sort(), ['region', 'world']);
    assert.equal(opened.archives.region?.header.maxZoom, 14);
    const refused = async (map: MapConfig, message: RegExp) => {
      await assert.rejects(openTiles(map), (e: unknown) => e instanceof TilesProblem && message.test(e.message) && !e.message.includes(f.dir));
    };
    await refused({ ...f.map, world: join(f.dir, 'nope.pmtiles') }, /^AZ_MAP_WORLD is not a file this server can read$/);
    await refused({ ...f.map, region: join(f.dir, 'secret.txt') }, /^AZ_MAP_REGION is shorter than a tile archive header$/);
    await refused({ ...f.map, glyphs: join(f.dir, 'secret.txt') }, /^AZ_MAP_GLYPHS is not a folder this server can read$/);
    await refused({ ...f.map, sprites: join(f.dir, 'missing') }, /^AZ_MAP_SPRITES is not a folder this server can read$/);
    // CONTROL: no archive at all is no problem — maps show their lists.
    assert.deepEqual(Object.keys((await openTiles({ ...f.map, world: null, region: null })).archives), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

/** A server with the tile route behind the real app edge (app.ts), on SITE's allow-list. */
async function served() {
  const f = files();
  const b = await startBackend({}, { tiles: createTiles(await openTiles(f.map)) });
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    fetch(`${b.url}/tiles/${path}`, { method, headers: { origin: SITE, ...headers } });
  return { ...f, b, get, close: async () => { await b.close(); rmSync(f.dir, { recursive: true, force: true }); } };
}

test('Range: 206 with the bytes asked and their Content-Range; the whole file is 200; HEAD has the headers and no body', async () => {
  const s = await served();
  try {
    const part = await s.get('world.pmtiles', { range: 'bytes=0-15' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-15/${s.world.length}`);
    assert.equal(part.headers.get('content-length'), '16');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), s.world.subarray(0, 16));
    const big = await s.get('world.pmtiles', { range: 'bytes=0-16383' });
    assert.equal(big.status, 206, 'a range past the end of a small file is the file, still partial');
    assert.equal(big.headers.get('content-range'), `bytes 0-${s.world.length - 1}/${s.world.length}`);
    assert.equal((await big.arrayBuffer()).byteLength, s.world.length);
    const tail = await s.get('world.pmtiles', { range: 'bytes=-10' });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), s.world.subarray(s.world.length - 10));
    const whole = await s.get('world.pmtiles');
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), s.world);
    const head = await s.get('world.pmtiles', { range: 'bytes=0-15' }, 'HEAD');
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '16');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally {
    await s.close();
  }
});

test('Range: what cannot be served is 416 with the size alone — past the end, reversed, several ranges, another unit, malformed', async () => {
  const s = await served();
  try {
    for (const range of [`bytes=${s.world.length}-`, 'bytes=20-10', 'bytes=0-1,4-5', 'items=0-1', 'bytes=abc']) {
      const r = await s.get('world.pmtiles', { range });
      assert.equal(r.status, 416, range);
      assert.equal(r.headers.get('content-range'), `bytes */${s.world.length}`, range);
      assert.equal((await r.arrayBuffer()).byteLength, 0, range);
    }
  } finally {
    await s.close();
  }
});

test('validators: a strong ETag and Last-Modified, cached a day; If-Match of another version is 412, If-None-Match of this one 304; a replaced file is a new ETag', async () => {
  const s = await served();
  try {
    const first = await s.get('world.pmtiles', { range: 'bytes=0-15' });
    const etag = first.headers.get('etag') ?? '';
    assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/, 'strong: a reader compares it byte for byte');
    assert.ok(first.headers.get('last-modified'));
    assert.equal(first.headers.get('cache-control'), 'public, max-age=86400');
    await first.arrayBuffer();
    assert.equal((await s.get('world.pmtiles', { range: 'bytes=0-15', 'if-match': etag })).status, 206);
    const stale = await s.get('world.pmtiles', { range: 'bytes=0-15', 'if-match': '"0-0"' });
    assert.equal(stale.status, 412);
    const same = await s.get('world.pmtiles', { 'if-none-match': etag });
    assert.equal(same.status, 304);
    assert.equal(same.headers.get('etag'), etag);
    // The operator replaces the archive: its version is read again, so a reader holding the old one is told.
    writeFileSync(join(s.dir, 'world.pmtiles'), archive(0, 6, 500));
    utimesSync(join(s.dir, 'world.pmtiles'), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const after = await s.get('world.pmtiles', { range: 'bytes=0-15', 'if-match': etag });
    assert.equal(after.status, 412);
    assert.notEqual(after.headers.get('etag'), etag);
  } finally {
    await s.close();
  }
});

test('CORS: an allowed origin only; the preflight allows range and if-match, every answer exposes etag and content-range; no credentials', async () => {
  const s = await served();
  try {
    const pre = await fetch(`${s.b.url}/tiles/world.pmtiles`, {
      method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'GET', 'access-control-request-headers': 'range,if-match' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
    assert.equal(pre.headers.get('access-control-allow-headers'), 'range, if-match');
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, HEAD');
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    const r = await s.get('world.pmtiles', { range: 'bytes=0-3' });
    assert.equal(r.headers.get('access-control-expose-headers'), 'etag, content-range');
    assert.equal(r.headers.get('vary'), 'Origin');
    await r.arrayBuffer();
    const other = await fetch(`${s.b.url}/tiles/world.pmtiles`, { headers: { origin: 'https://elsewhere.example', range: 'bytes=0-3' } });
    assert.equal(other.status, 403, 'another site cannot read the operator\'s tiles through a visitor');
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${s.b.url}/tiles/world.pmtiles`)).status, 403, 'no origin, no tiles');
    assert.equal((await fetch(`${s.b.url}/tiles/world.pmtiles`, { method: 'POST', headers: { origin: SITE } })).status, 405);
  } finally {
    await s.close();
  }
});

test('map.json: the archives by name and depth, whether glyphs and sprites are served, the attribution — never a path; not cached', async () => {
  const s = await served();
  try {
    const r = await s.get('map.json');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), {
      archives: [{ name: 'world', minzoom: 0, maxzoom: 6 }, { name: 'region', minzoom: 0, maxzoom: 14 }],
      glyphs: true, sprites: true, attribution: 'Map data: the operator’s',
    });
    assert.ok(!text.includes(s.dir), 'no path of the server\'s');
  } finally {
    await s.close();
  }
});

test('glyphs and sprites: the first font of a stack the folder has; only their own shapes — a path out of the folder is 404', async () => {
  const s = await served();
  try {
    const stack = await s.get(`glyphs/${encodeURIComponent('Open Sans Regular,Noto Sans Regular')}/0-255.pbf`);
    assert.equal(stack.status, 200);
    assert.equal(stack.headers.get('content-type'), 'application/x-protobuf');
    assert.deepEqual(Buffer.from(await stack.arrayBuffer()), Buffer.from([1, 2, 3]));
    assert.equal((await s.get('glyphs/Noto%20Sans%20Regular/256-511.pbf')).status, 200);
    const json = await s.get('sprites/light.json');
    assert.equal(json.headers.get('content-type'), 'application/json');
    assert.equal(await json.text(), '{}\n');
    const png = await s.get('sprites/light@2x.png');
    assert.equal(png.headers.get('content-type'), 'image/png');
    await png.arrayBuffer();
    for (const path of [
      'glyphs/Noto%20Sans%20Regular/1-256.pbf', 'glyphs/Noto%20Sans%20Regular/0-254.pbf', 'glyphs/..%2F..%2Fsecret.txt/0-255.pbf',
      'glyphs/Noto%20Sans%20Regular/..%2F..%2Fsecret.txt', 'glyphs/%2E%2E/0-255.pbf', 'sprites/../secret.txt', 'sprites/%2E%2E%2Fsecret.json',
      'sprites/Light.json', 'sprites/light.svg', 'secret.txt', 'world.pmtiles/x', 'other.pmtiles', 'glyphs/Missing%20Font/0-255.pbf',
    ]) {
      const r = await s.get(path);
      assert.equal(r.status, 404, path);
      assert.ok(!(await r.text()).includes('not a map file'), path);
    }
  } finally {
    await s.close();
  }
});

test('CONTROL: a server whose chat shows no maps has no tile route at all', async () => {
  const b = await startBackend();
  try {
    assert.equal((await fetch(`${b.url}/tiles/map.json`, { headers: { origin: SITE } })).status, 404);
  } finally {
    await b.close();
  }
});
