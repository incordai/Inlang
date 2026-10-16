/**
 * Vector tiles and their archive, written the same way on every run — for
 * the default world basemap (scripts/gen-basemap.mjs, chat-block-spec
 * §19.15): Web Mercator projection, simplification, clipping a polygon or a
 * line to a tile, the MVT v2.1 encoding, and a PMTiles v3 archive.
 *
 * Every step is plain arithmetic in a fixed order — no randomness, no
 * clock, no locale — and nothing is compressed (no compression library's
 * version can change the bytes); `node scripts/gen-basemap.mjs --check`
 * regenerates the archive and compares it byte for byte.
 *
 * References: the vector tile specification (MVT) 2.1 (§4.3 geometry, §4.3.4.4
 * winding), the PMTiles v3 specification (§3 header, §4 directories, Hilbert
 * tile ids), and the style specification's Web Mercator (EPSG:3857).
 */

/** Tile coordinates run 0…EXTENT; a tile's own pixels are 0…4095. */
export const EXTENT = 4096;
/** Web Mercator's latitude limit: the square world. */
export const MAX_LAT = 85.0511287798066;

/* ---- protobuf writing (only what MVT and the PMTiles directory use) ---- */

export function varint(n) {
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

/* ---- projection ---- */

/** A longitude and latitude as world coordinates at zoom `z`: 0…2^z·EXTENT across, y down. */
export function project(lon, lat, z) {
  const scale = 2 ** z * EXTENT;
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const r = (clamped * Math.PI) / 180;
  return [((lon + 180) / 360) * scale, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale];
}

/* ---- simplification (Douglas–Peucker, iterative so a long ring cannot overflow the stack) ---- */

/** Points kept of `pts` within `tolerance` of the line it simplifies to; the first and last always. */
export function simplify(pts, tolerance) {
  if (pts.length <= 2 || tolerance <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let far = 0;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d2;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > far) { far = d2; worst = i; }
    }
    if (worst >= 0 && far > t2) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/* ---- clipping to a box ---- */

/** A closed ring (first point not repeated) clipped to the box [x0, x1] × [y0, y1] (Sutherland–Hodgman). */
export function clipRing(ring, x0, y0, x1, y1) {
  let pts = ring;
  const edges = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cross] of edges) {
    if (pts.length === 0) break;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cross(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(cross(prev, cur));
      }
    }
    pts = out;
  }
  return pts;
}

/** A line clipped to the box: the pieces of it inside, each two points or more (Liang–Barsky per segment). */
export function clipLine(line, x0, y0, x1, y1) {
  const pieces = [];
  let cur = null;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) {
        if (q < 0) { visible = false; break; }
      } else {
        const r = q / p;
        if (p < 0) { if (r > t1) { visible = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { visible = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!visible) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const start = [ax + t0 * dx, ay + t0 * dy];
    const end = [ax + t1 * dx, ay + t1 * dy];
    if (!cur) cur = [start];
    cur.push(end);
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/* ---- integer tile geometry ---- */

/** Points rounded to whole tile units, consecutive repeats dropped (and, for a ring, a last point equal to the first). */
export function rounded(pts, ring) {
  const out = [];
  for (const [x, y] of pts) {
    const p = [Math.round(x), Math.round(y)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (ring && out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
  return out;
}

/** The surveyor's formula in tile coordinates: positive for MVT's exterior winding (clockwise, y down). */
export function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

/* ---- MVT encoding ---- */

/** MVT geometry commands (§4.3) for rings (a polygon's, exterior first) or lines. */
function commands(kind, parts) {
  const out = [];
  let cx = 0;
  let cy = 0;
  const move = (px, py) => {
    out.push(zigzag(px - cx), zigzag(py - cy));
    cx = px;
    cy = py;
  };
  for (const pts of parts) {
    out.push(1 + 8 * 1);
    move(pts[0][0], pts[0][1]);
    out.push(2 + 8 * (pts.length - 1));
    for (const p of pts.slice(1)) move(p[0], p[1]);
    if (kind === 'polygon') out.push(7 + 8 * 1);
  }
  return out;
}

const GEOM = { line: 2, polygon: 3 };

/** A property value as MVT §4.1 writes it: a string, or an unsigned whole number. */
const valueOf = (v) => (typeof v === 'number' ? [...key(5, 0), ...varint(v)] : stringField(1, v));

/** One MVT layer of features `{ kind: 'polygon'|'line', props, parts }`, ids from 1 in order. */
export function layer(name, features) {
  const keys = [];
  const values = [];
  const index = (list, v) => {
    const at = list.indexOf(v);
    if (at >= 0) return at;
    list.push(v);
    return list.length - 1;
  };
  const feats = features.map((f, i) => {
    const tags = Object.entries(f.props).flatMap(([k, v]) => [index(keys, k), index(values, v)]);
    return bytesField(2, [...uintField(1, i + 1), ...packed(2, tags), ...uintField(3, GEOM[f.kind]), ...packed(4, commands(f.kind, f.parts))]);
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

/* ---- the PMTiles v3 archive ---- */

/** The Hilbert tile id of z/x/y (PMTiles: zoom levels in order, each along a Hilbert curve). */
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

/** A directory (PMTiles §4): count, id deltas, run lengths, lengths, offsets (+1, or 0 for "right after the previous"). */
function directory(entries) {
  const out = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) {
    out.push(...varint(e.id - last));
    last = e.id;
  }
  for (const e of entries) out.push(...varint(e.run));
  for (const e of entries) out.push(...varint(e.length));
  for (const e of entries) out.push(...varint(e.offset + 1));
  return Buffer.from(out);
}

const u64 = (buf, at, n) => buf.writeBigUInt64LE(BigInt(n), at);
const e7 = (buf, at, deg) => buf.writeInt32LE(Math.round(deg * 1e7), at);
/** The root directory must fit, with the header, in the first 16 KiB a reader fetches. */
const ROOT_MAX = 16384 - 127;

/**
 * The archive's bytes for tiles `{ z, x, y, data }`: tiles with equal bytes
 * are stored once (their entries share an offset; a run of consecutive ids
 * is one entry), uncompressed, in tile id order of first appearance.
 */
export function pmtiles(tiles, { minZoom, maxZoom, metadata, bounds = [-180, -MAX_LAT, 180, MAX_LAT], center = [0, 0, 0] }) {
  const byId = [...tiles].map((t) => ({ id: tileId(t.z, t.x, t.y), data: t.data })).sort((a, b) => a.id - b.id);
  const stored = new Map();
  const chunks = [];
  let offset = 0;
  const entries = [];
  for (const t of byId) {
    const hex = t.data.toString('base64');
    let at = stored.get(hex);
    if (at === undefined) {
      at = offset;
      stored.set(hex, at);
      chunks.push(t.data);
      offset += t.data.length;
    }
    const prev = entries.at(-1);
    if (prev && prev.offset === at && prev.id + prev.run === t.id) prev.run++;
    else entries.push({ id: t.id, run: 1, offset: at, length: t.data.length });
  }
  const root = directory(entries);
  if (root.length > ROOT_MAX) throw new Error(`the root directory is ${root.length} bytes, past the ${ROOT_MAX} a reader's first fetch holds`);
  const meta = Buffer.from(JSON.stringify(metadata), 'utf8');
  const data = Buffer.concat(chunks);
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1');
  header.writeUInt8(3, 7);
  const rootAt = 127;
  const metaAt = rootAt + root.length;
  const dataAt = metaAt + meta.length;
  u64(header, 8, rootAt);
  u64(header, 16, root.length);
  u64(header, 24, metaAt);
  u64(header, 32, meta.length);
  u64(header, 40, dataAt + data.length);   // no leaf directories
  u64(header, 48, 0);
  u64(header, 56, dataAt);
  u64(header, 64, data.length);
  u64(header, 72, byId.length);            // addressed tiles
  u64(header, 80, entries.length);         // tile entries
  u64(header, 88, chunks.length);          // tile contents
  header.writeUInt8(0, 96);                // not clustered: equal tiles share bytes
  header.writeUInt8(1, 97);                // internal compression: none
  header.writeUInt8(1, 98);                // tile compression: none
  header.writeUInt8(1, 99);                // tile type: MVT
  header.writeUInt8(minZoom, 100);
  header.writeUInt8(maxZoom, 101);
  e7(header, 102, bounds[0]);
  e7(header, 106, bounds[1]);
  e7(header, 110, bounds[2]);
  e7(header, 114, bounds[3]);
  header.writeUInt8(center[2], 118);
  e7(header, 119, center[0]);
  e7(header, 123, center[1]);
  return Buffer.concat([header, root, meta, data]);
}
