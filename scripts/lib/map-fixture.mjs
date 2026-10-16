/**
 * A tiny map data set for the tests (chat-block-spec §21.4.6), made the same
 * way on every run: a tile archive of a few kilobytes, a glyph range per font
 * and a one-pixel sprite — never a download.
 *
 *     import { mapFixture } from './lib/map-fixture.mjs';
 *     const { archive, glyphs, sprite } = mapFixture();
 *
 * The archive is a PMTiles v3 file (the format's specification, section 3:
 * a 127-byte header, a root directory, JSON metadata, the tiles) holding
 * vector tiles (the MVT format, v2.1) — the world at zoom 0–2 and the tiles over a small
 * area (around 52.5° N, 13.4° E) at zoom 3–6. Each tile has the layers a
 * basemap style reads: `earth` (the whole tile), `water` (a lake inside the
 * area and an ocean in the west), `roads` (one major road) and `places` (one
 * locality with the numbers a basemap style ranks a label by, so the style
 * asks for a glyph range). Nothing is compressed, so the bytes are the same
 * on every machine.
 *
 * A glyph range is a protobuf of one font stack and no glyphs (a label draws
 * nothing, but its request is real), one for each font a basemap style
 * names; the sprite is a 1×1 transparent PNG and an index naming it for each
 * icon a basemap's place labels use (SPRITE_ICONS), at 1× and at 2×.
 */

import { crc32, deflateSync } from 'node:zlib';

/** The area the higher zooms cover, and the fixture's largest zoom. */
export const FIXTURE_AREA = { west: 13.0, south: 52.3, east: 13.8, north: 52.7 };
export const FIXTURE_MAX_ZOOM = 6;
/** The fonts a basemap's labels name; each one's 0–255 range is a file served. */
export const FIXTURE_FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const WORLD_ZOOM = 2;
const EXTENT = 4096;

/* ---- protobuf writing (only what these two formats use) ---- */

/** Bytes of an unsigned varint. */
function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}
const zigzag = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const key = (field, wire) => varint(field * 8 + wire);
const bytesField = (field, bytes) => [...key(field, 2), ...varint(bytes.length), ...bytes];
const stringField = (field, s) => bytesField(field, [...Buffer.from(s, 'utf8')]);
const uintField = (field, n) => [...key(field, 0), ...varint(n)];
const packed = (field, values) => bytesField(field, values.flatMap(varint));

/* ---- tile geometry ---- */

/** Web Mercator: a longitude and latitude as the tile's pixel at zoom `z` (x, y from the tile's top left). */
function pixel(lon, lat, z, x, y) {
  const n = 2 ** z;
  const wx = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const wy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [Math.round((wx - x) * EXTENT), Math.round((wy - y) * EXTENT)];
}

/** The tile x/y range at zoom `z` that a box covers. */
function tilesOver(box, z) {
  const n = 2 ** z;
  const tx = (lon) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const ty = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  return { x0: tx(box.west), x1: tx(box.east), y0: ty(box.north), y1: ty(box.south) };
}

/** A box as one closed ring in tile pixels, clipped to the tile plus a small buffer; null when it misses the tile. */
function boxRing(box, z, x, y) {
  const lo = -64;
  const hi = EXTENT + 64;
  const [ax, ay] = pixel(box.west, box.north, z, x, y);
  const [bx, by] = pixel(box.east, box.south, z, x, y);
  const left = Math.max(lo, ax);
  const top = Math.max(lo, ay);
  const right = Math.min(hi, bx);
  const bottom = Math.min(hi, by);
  if (left >= right || top >= bottom) return null;
  // Clockwise on screen (y down): the exterior ring's area is positive, as MVT §4.3.4.4 requires.
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

/** MVT geometry commands for one ring, one line or one point (MVT §4.3). */
function commands(kind, points) {
  const out = [];
  let cx = 0;
  let cy = 0;
  const move = (px, py) => {
    out.push(zigzag(px - cx), zigzag(py - cy));
    cx = px;
    cy = py;
  };
  out.push(1 + 8 * 1);
  move(points[0][0], points[0][1]);
  if (kind === 'point') return out;
  out.push(2 + 8 * (points.length - 1));
  for (const p of points.slice(1)) move(p[0], p[1]);
  if (kind === 'polygon') out.push(7 + 8 * 1);
  return out;
}

const GEOM = { point: 1, line: 2, polygon: 3 };

/** A property value as MVT §4.1 writes it: a string, or an unsigned whole number. */
const valueOf = (v) => (typeof v === 'number' ? [...key(5, 0), ...varint(v)] : stringField(1, v));

/** One MVT layer: its features, each with string or whole-number properties. */
function layer(name, features) {
  const keys = [];
  const values = [];
  const index = (list, v) => {
    const at = list.findIndex((x) => x === v);
    if (at >= 0) return at;
    list.push(v);
    return list.length - 1;
  };
  const feats = features.map((f, i) => {
    const tags = Object.entries(f.props).flatMap(([k, v]) => [index(keys, k), index(values, v)]);
    return bytesField(2, [...uintField(1, i + 1), ...packed(2, tags), ...uintField(3, GEOM[f.kind]), ...packed(4, commands(f.kind, f.points))]);
  });
  return bytesField(3, [
    ...uintField(15, 2),
    ...stringField(1, name),
    ...feats.flat(),
    ...keys.flatMap((k) => stringField(3, k)),
    ...values.flatMap((v) => bytesField(4, valueOf(v))),
    ...uintField(5, EXTENT),
  ]);
}

const LAKE = { west: 13.42, south: 52.42, east: 13.6, north: 52.5 };
const OCEAN = { west: -180, south: -85, east: -10, north: 85 };
const ROAD = [[13.3, 52.5], [13.5, 52.53]];
const TOWN = [13.4, 52.52];

/** The vector tile z/x/y. */
function tile(z, x, y) {
  const whole = [[0, 0], [EXTENT, 0], [EXTENT, EXTENT], [0, EXTENT]];
  const water = [LAKE, OCEAN].map((b) => boxRing(b, z, x, y)).filter((r) => r !== null)
    .map((points) => ({ kind: 'polygon', props: { kind: 'water' }, points }));
  const road = ROAD.map(([lon, lat]) => pixel(lon, lat, z, x, y));
  const town = pixel(TOWN[0], TOWN[1], z, x, y);
  const inside = (p) => p[0] >= 0 && p[0] < EXTENT && p[1] >= 0 && p[1] < EXTENT;
  const out = [
    layer('earth', [{ kind: 'polygon', props: { kind: 'earth' }, points: whole }]),
    ...(water.length > 0 ? [layer('water', water)] : []),
    ...(road.some(inside) ? [layer('roads', [{ kind: 'line', props: { kind: 'major_road' }, points: road }])] : []),
    ...(inside(town) ? [layer('places', [{ kind: 'point', props: { kind: 'locality', name: 'Fixture', min_zoom: 4, population_rank: 10 }, points: [town] }])] : []),
  ];
  return Buffer.from(out.flat());
}

/* ---- the archive ---- */

/** The Hilbert tile id of z/x/y (PMTiles §3: zoom levels in order, each along a Hilbert curve). */
export function tileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  const n = 2 ** z;
  let d = 0;
  let tx = x;
  let ty = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      [tx, ty] = [ty, tx];
    }
  }
  return acc + d;
}

/** A directory's entries as PMTiles §4 writes them: count, id deltas, run lengths, lengths, offsets (+1). */
function directory(entries) {
  const out = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) {
    out.push(...varint(e.id - last));
    last = e.id;
  }
  for (const e of entries) out.push(...varint(1));
  for (const e of entries) out.push(...varint(e.length));
  for (const e of entries) out.push(...varint(e.offset + 1));
  return Buffer.from(out);
}

const u64 = (buf, at, n) => buf.writeBigUInt64LE(BigInt(n), at);
const e7 = (buf, at, deg) => buf.writeInt32LE(Math.round(deg * 1e7), at);

/** The archive's bytes. */
function archive() {
  const tiles = [];
  for (let z = 0; z <= FIXTURE_MAX_ZOOM; z++) {
    const box = z <= WORLD_ZOOM ? { x0: 0, x1: 2 ** z - 1, y0: 0, y1: 2 ** z - 1 } : tilesOver(FIXTURE_AREA, z);
    for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) tiles.push({ id: tileId(z, x, y), data: tile(z, x, y) });
  }
  tiles.sort((a, b) => a.id - b.id);
  let offset = 0;
  const entries = tiles.map((t) => {
    const e = { id: t.id, offset, length: t.data.length };
    offset += t.data.length;
    return e;
  });
  const root = directory(entries);
  const metadata = Buffer.from(JSON.stringify({
    name: 'az test fixture',
    vector_layers: ['earth', 'water', 'roads', 'places'].map((id) => ({
      id, fields: { kind: 'String', ...(id === 'places' ? { name: 'String', min_zoom: 'Number', population_rank: 'Number' } : {}) },
    })),
  }), 'utf8');
  const data = Buffer.concat(tiles.map((t) => t.data));
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1');
  header.writeUInt8(3, 7);
  const rootAt = 127;
  const metaAt = rootAt + root.length;
  const dataAt = metaAt + metadata.length;
  u64(header, 8, rootAt);
  u64(header, 16, root.length);
  u64(header, 24, metaAt);
  u64(header, 32, metadata.length);
  u64(header, 40, dataAt + data.length);
  u64(header, 48, 0);
  u64(header, 56, dataAt);
  u64(header, 64, data.length);
  u64(header, 72, tiles.length);
  u64(header, 80, tiles.length);
  u64(header, 88, tiles.length);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(1, 97); // internal compression: none
  header.writeUInt8(1, 98); // tile compression: none
  header.writeUInt8(1, 99); // tile type: MVT
  header.writeUInt8(0, 100);
  header.writeUInt8(FIXTURE_MAX_ZOOM, 101);
  e7(header, 102, -180);
  e7(header, 106, -85);
  e7(header, 110, 180);
  e7(header, 114, 85);
  header.writeUInt8(FIXTURE_MAX_ZOOM, 118);
  e7(header, 119, (FIXTURE_AREA.west + FIXTURE_AREA.east) / 2);
  e7(header, 123, (FIXTURE_AREA.south + FIXTURE_AREA.north) / 2);
  return Buffer.concat([header, root, metadata, data]);
}

/** A glyph range (the style specification's glyph protobuf): one font stack, no glyphs. */
function glyphRange(font, range) {
  return Buffer.from(bytesField(1, [...stringField(1, font), ...stringField(2, range)]));
}

/** A 1×1 transparent PNG (RGBA), its chunks checked by CRC-32 as PNG §5.3 requires. */
function emptyPng() {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The icons a basemap style's place labels name at the fixture's zooms. */
export const SPRITE_ICONS = ['townspot', 'capital'];

/** A sprite index (the style specification's sprite JSON): every icon the one pixel of the image, at `ratio`. */
const spriteIndex = (ratio) => Buffer.from(`${JSON.stringify(Object.fromEntries(SPRITE_ICONS.map((n) => [n, { x: 0, y: 0, width: 1, height: 1, pixelRatio: ratio }])))}\n`, 'utf8');

/** The whole fixture: the archive's bytes, each font's one glyph range, the sprite's index (1× and 2×) and image. */
export function mapFixture() {
  return {
    archive: archive(),
    glyphs: FIXTURE_FONTS.map((font) => ({ font, range: '0-255', bytes: glyphRange(font, '0-255') })),
    sprite: { json: spriteIndex(1), json2x: spriteIndex(2), png: emptyPng() },
  };
}
