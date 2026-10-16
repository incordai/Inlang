/**
 * The vector-tile and archive writer behind the default world basemap
 * (vector-tiles.mjs, scripts/gen-basemap.mjs): clipping, winding,
 * simplification, the tile ids, and an archive the tile-archive reader reads
 * back — equal tiles stored once — and the committed basemap itself: a
 * PMTiles v3 archive of the world to zoom 6, about a megabyte, credited in
 * its own metadata, with land where land is and nothing where the ocean is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PMTiles, zxyToTileId } from 'pmtiles';
import { EXTENT, clipLine, clipRing, layer, pmtiles, project, ringArea, rounded, simplify, tileId } from './vector-tiles.mjs';
import { readArchiveAttribution, readArchiveHeader } from '../../packages/backend/src/server/chat-tiles.ts';

const BASEMAP = fileURLToPath(new URL('../../packages/backend/assets/basemap/world.pmtiles', import.meta.url));
const SOURCES = JSON.parse(readFileSync(new URL('../basemap/sources.json', import.meta.url), 'utf8'));

const sourceOf = (bytes) => ({
  getKey: () => 'archive',
  getBytes: async (offset, length) => ({ data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length) }),
});

/** The layer names of an MVT tile (field 3, each a message whose field 1 is its name). */
function layerNames(tile) {
  const bytes = new Uint8Array(tile);
  const names = [];
  let i = 0;
  const varint = () => { let v = 0; let s = 1; for (;;) { const b = bytes[i++]; v += (b & 0x7f) * s; if (b < 0x80) return v; s *= 128; } };
  while (i < bytes.length) {
    const key = varint();
    const len = varint();
    if (key === (3 << 3 | 2)) {
      const end = i + len;
      let j = i;
      const inner = () => { let v = 0; let s = 1; for (;;) { const b = bytes[j++]; v += (b & 0x7f) * s; if (b < 0x80) return v; s *= 128; } };
      while (j < end) {
        const k = inner();
        if (k === (1 << 3 | 2)) { const n = inner(); names.push(Buffer.from(bytes.slice(j, j + n)).toString('utf8')); break; }
        if ((k & 7) === 0) inner(); else { const n = inner(); j += n; }
      }
      i = end;
    } else i += len;
  }
  return names;
}

test('a ring clipped to a box keeps what is inside; a line clipped to it is the pieces inside', () => {
  const square = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  assert.equal(ringArea(rounded(clipRing(square, 0, 0, 20, 20), true)), 100);
  assert.deepEqual(clipRing(square, 20, 20, 30, 30), []);
  assert.deepEqual(clipLine([[-5, 5], [5, 5], [5, 15], [5, 25]], 0, 0, 10, 10), [[[0, 5], [5, 5], [5, 10]]]);
  assert.deepEqual(clipLine([[-5, 5], [15, 5]], 0, 0, 10, 10), [[[0, 5], [10, 5]]]);
  assert.deepEqual(clipLine([[20, 20], [30, 30]], 0, 0, 10, 10), []);
});

test('winding: the surveyor\'s formula is positive for a clockwise ring on screen (MVT exterior)', () => {
  assert.ok(ringArea([[0, 0], [10, 0], [10, 10], [0, 10]]) > 0);
  assert.ok(ringArea([[0, 0], [0, 10], [10, 10], [10, 0]]) < 0);
});

test('simplification keeps both ends and every point farther than the tolerance; rounding drops repeats', () => {
  const line = [[0, 0], [1, 0.1], [2, 0], [3, 5], [4, 0]];
  assert.deepEqual(simplify(line, 0.5), [[0, 0], [2, 0], [3, 5], [4, 0]]);
  assert.deepEqual(rounded([[0.2, 0.2], [0.4, 0.1], [5, 5], [0.1, 0.4]], true), [[0, 0], [5, 5]]);
});

test('projection: the world is 2^z tiles of EXTENT units, y down', () => {
  assert.deepEqual(project(-180, 85.0511287798066, 0).map((v) => Math.round(v) + 0), [0, 0]);
  assert.deepEqual(project(0, 0, 1).map(Math.round), [EXTENT, EXTENT]);
});

test('tile ids are the format\'s own', () => {
  for (const [z, x, y] of [[0, 0, 0], [1, 1, 0], [3, 5, 2], [6, 63, 17]]) assert.equal(tileId(z, x, y), zxyToTileId(z, x, y));
});

test('an archive the reader reads back: tiles by id, equal tiles stored once, metadata as written', async () => {
  const land = Buffer.from(layer('earth', [{ kind: 'polygon', props: { kind: 'earth' }, parts: [[[0, 0], [EXTENT, 0], [EXTENT, EXTENT], [0, EXTENT]]] }]));
  const edge = Buffer.from(layer('boundaries', [{ kind: 'line', props: { kind: 'country', kind_detail: 2 }, parts: [[[0, 0], [EXTENT, EXTENT]]] }]));
  const tiles = [{ z: 1, x: 0, y: 0, data: land }, { z: 1, x: 0, y: 1, data: land }, { z: 1, x: 1, y: 1, data: land }, { z: 1, x: 1, y: 0, data: edge }];
  const bytes = pmtiles(tiles, { minZoom: 1, maxZoom: 1, metadata: { attribution: 'Test credit' } });
  assert.equal(bytes.length < 127 + 200 + land.length * 2 + edge.length, true, 'the land tile is stored once');
  const reader = new PMTiles(sourceOf(bytes));
  const header = await reader.getHeader();
  assert.deepEqual([header.minZoom, header.maxZoom, header.numAddressedTiles, header.numTileContents], [1, 1, 4, 2]);
  for (const t of tiles) assert.deepEqual(Buffer.from((await reader.getZxy(t.z, t.x, t.y)).data), t.data);
  assert.deepEqual(await reader.getMetadata(), { attribution: 'Test credit' });
  assert.deepEqual(layerNames(land), ['earth']);
});

test('the committed basemap: PMTiles v3, the world to zoom 6, about a megabyte, credited in its own metadata', async () => {
  const bytes = readFileSync(BASEMAP);
  assert.ok(statSync(BASEMAP).size < 2 * 1024 * 1024, `${statSync(BASEMAP).size} bytes — a few MB at most`);
  const header = readArchiveHeader(bytes.subarray(0, 127));
  assert.ok(typeof header !== 'string', String(header));
  assert.deepEqual([header.minZoom, header.maxZoom], [0, 6]);
  assert.deepEqual(header.bounds.map(Math.round), [-180, -85, 180, 85]);
  assert.equal(await readArchiveAttribution(BASEMAP), SOURCES.attribution);
  const reader = new PMTiles(sourceOf(bytes));
  const meta = await reader.getMetadata();
  assert.deepEqual(meta.vector_layers.map((l) => l.id), ['earth', 'water', 'boundaries']);
});

test('the committed basemap holds land where land is, lakes and borders, and no tile over open ocean', async () => {
  const reader = new PMTiles(sourceOf(readFileSync(BASEMAP)));
  const at = (z, lon, lat) => {
    const n = 2 ** z;
    const r = (lat * Math.PI) / 180;
    return [z, Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
  };
  const names = async (z, lon, lat) => {
    const t = await reader.getZxy(...at(z, lon, lat));
    return t ? layerNames(t.data) : null;
  };
  assert.deepEqual(await names(0, 0, 0), ['earth', 'water', 'boundaries'], 'the whole world at zoom 0');
  assert.equal((await names(6, 13.4, 52.5))?.[0], 'earth', 'Berlin is land');
  assert.ok((await names(5, 33, -1))?.includes('water'), 'Lake Victoria is a lake');
  assert.ok((await names(6, 7.6, 47.6))?.includes('boundaries'), 'the borders meet near Basel');
  assert.equal(await names(6, -150, 0), null, 'the mid-Pacific is open water: no tile');
});
