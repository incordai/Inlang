/**
 * The map tests' tile data (map-fixture.mjs): the same bytes on every run, a
 * few kilobytes, a real PMTiles v3 archive — its tile ids the format's own
 * (checked against the tile-archive reader's zxyToTileId), and every tile it
 * holds read back through that reader — the world at zoom 0–2 and the small
 * area to zoom 6, nothing outside it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { PMTiles, zxyToTileId } from 'pmtiles';
import { FIXTURE_AREA, FIXTURE_FONTS, FIXTURE_MAX_ZOOM, mapFixture, SPRITE_ICONS, tileId } from './map-fixture.mjs';
import { readArchiveHeader } from '../../packages/backend/src/server/chat-tiles.ts';

/** The archive as the reader's source: bytes by range, as HTTP Range would give them. */
const sourceOf = (bytes) => ({
  getKey: () => 'fixture',
  getBytes: async (offset, length) => ({ data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length) }),
});

test('the same bytes on every run, and a few kilobytes', () => {
  const a = mapFixture();
  const b = mapFixture();
  assert.equal(Buffer.compare(a.archive, b.archive), 0);
  assert.ok(a.archive.length < 8 * 1024, `${a.archive.length} bytes`);
  assert.deepEqual(a.glyphs.map((g) => g.bytes.toString('hex')), b.glyphs.map((g) => g.bytes.toString('hex')));
});

test('tile ids are the format\'s own: every z/x/y to zoom 6 as the reader numbers it', () => {
  for (let z = 0; z <= FIXTURE_MAX_ZOOM; z++) {
    const n = 2 ** z;
    for (let x = 0; x < n; x += Math.max(1, n >> 3)) for (let y = 0; y < n; y += Math.max(1, n >> 3)) assert.equal(tileId(z, x, y), zxyToTileId(z, x, y), `${z}/${x}/${y}`);
  }
});

test('the reader opens it: its header, the world at low zoom, the area to zoom 6, nothing outside', async () => {
  const { archive } = mapFixture();
  const p = new PMTiles(sourceOf(archive));
  const h = await p.getHeader();
  assert.equal(h.specVersion, 3);
  assert.equal(h.minZoom, 0);
  assert.equal(h.maxZoom, FIXTURE_MAX_ZOOM);
  assert.equal(h.tileType, 1, 'vector tiles');
  assert.deepEqual(readArchiveHeader(archive.subarray(0, 127)), { minZoom: 0, maxZoom: 6, bounds: [-180, -85, 180, 85] }, 'the server reads the same header');
  for (const [z, x, y] of [[0, 0, 0], [1, 1, 0], [2, 3, 3]]) assert.ok(await p.getZxy(z, x, y), `world tile ${z}/${x}/${y}`);
  // The area's tile at zoom 6, and one far from it.
  const n = 2 ** 6;
  const ax = Math.floor(((FIXTURE_AREA.west + FIXTURE_AREA.east) / 2 + 180) / 360 * n);
  const lat = ((FIXTURE_AREA.south + FIXTURE_AREA.north) / 2) * Math.PI / 180;
  const ay = Math.floor((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n);
  const inside = await p.getZxy(6, ax, ay);
  assert.ok(inside && inside.data.byteLength > 0, 'the area at zoom 6');
  assert.equal(await p.getZxy(6, 0, 0), undefined, 'nothing outside the area past zoom 2');
  assert.equal(await p.getZxy(7, ax * 2, ay * 2), undefined, 'nothing past zoom 6');
  const meta = await p.getMetadata();
  assert.deepEqual(meta.vector_layers.map((l) => l.id), ['earth', 'water', 'roads', 'places']);
});

test('a glyph range per font a basemap names, and a one-pixel sprite whose index names each place icon', () => {
  const { glyphs, sprite } = mapFixture();
  assert.deepEqual(glyphs.map((g) => g.font), FIXTURE_FONTS);
  for (const g of glyphs) {
    // A glyphs message: field 1 (stacks) holding field 1 (name) and field 2 (range).
    assert.equal(g.bytes[0], 0x0a);
    assert.ok(g.bytes.includes(Buffer.from(g.font)) && g.bytes.includes(Buffer.from('0-255')));
  }
  assert.deepEqual(Object.keys(JSON.parse(sprite.json.toString('utf8'))), SPRITE_ICONS);
  assert.equal(JSON.parse(sprite.json2x.toString('utf8')).townspot.pixelRatio, 2);
  assert.equal(sprite.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  // Each chunk's CRC-32 is its type and data's (PNG §5.3).
  let at = 8;
  while (at < sprite.png.length) {
    const len = sprite.png.readUInt32BE(at);
    const typed = sprite.png.subarray(at + 4, at + 8 + len);
    assert.equal(sprite.png.readUInt32BE(at + 8 + len), crc32(typed), typed.subarray(0, 4).toString('latin1'));
    at += 12 + len;
  }
});
