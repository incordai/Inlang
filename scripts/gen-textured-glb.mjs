/**
 * Generates packages/scene-runtime/test/fixture-assets/textured.glb — a cube
 * whose one material samples a texture embedded in the file (glTF 2.0 §5.10:
 * an image in a bufferView). test:3d draws it under the page's shipped
 * Content-Security-Policy (word-quality-gate §2 B): the loader hands an
 * embedded image to the browser as a `blob:` URL, so this is the model that
 * proves which `blob:` sources a model page really needs.
 *
 * Deterministic to the byte, with no library: the PNG's pixels are stored
 * in uncompressed deflate blocks (RFC 1951 §3.2.4), so no compressor's
 * version can change the output. The texture is a checker of a saturated
 * red and white — a colour the cube can only show if the texture was
 * decoded and sampled; its material's own colour is white.
 * packages/scene-runtime/test/textured-fixture.test.ts regenerates and
 * compares, so the committed file never drifts from this generator.
 *
 * Run: node scripts/gen-textured-glb.mjs
 */

import { writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Where the fixture is committed. */
export const TEXTURED_GLB = fileURLToPath(new URL('../packages/scene-runtime/test/fixture-assets/textured.glb', import.meta.url));

/** The texture: SIZE × SIZE pixels, squares of CELL pixels. */
const SIZE = 32;
const CELL = 8;
/** The checker's two colours, RGB. */
export const RED = [220, 24, 24];
const WHITE = [255, 255, 255];

/* ---- PNG (RFC 2083), 8-bit RGB, stored deflate ----------------------------- */

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

function chunk(type, data) {
  const head = Buffer.from(type, 'latin1');
  return Buffer.concat([u32(data.length), head, data, u32(crc32(Buffer.concat([head, data])))]);
}

/** Adler-32 of `data` (RFC 1950 §8). */
function adler32(data) {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream of `data` in stored blocks: the bytes as they are, framed. */
function storedZlib(data) {
  const MAX = 65535;
  const parts = [Buffer.from([0x78, 0x01])];
  for (let at = 0; at < data.length || at === 0; at += MAX) {
    const block = data.subarray(at, at + MAX);
    const last = at + MAX >= data.length ? 1 : 0;
    const head = Buffer.alloc(5);
    head[0] = last;
    head.writeUInt16LE(block.length, 1);
    head.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(head, block);
    if (last) break;
  }
  parts.push(u32(adler32(data)));
  return Buffer.concat(parts);
}

function checkerPng() {
  const rows = Buffer.alloc(SIZE * (1 + SIZE * 3));
  for (let y = 0; y < SIZE; y++) {
    const row = y * (1 + SIZE * 3);
    rows[row] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const colour = (Math.floor(x / CELL) + Math.floor(y / CELL)) % 2 === 0 ? RED : WHITE;
      rows.set(colour, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', storedZlib(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- the cube: 6 faces × 4 corners, each face the whole texture ------------ */

function cube() {
  // Each face: its normal and two axes spanning it, so corners are n ± u ± v.
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach(([n, u, v], f) => {
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...n.map((c, i) => (c + su * u[i] + sv * v[i]) / 2));
      normals.push(...n);
      uvs.push((su + 1) / 2, (1 - sv) / 2);
    }
    const o = f * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

/* ---- GLB (glTF 2.0 §4.4) ----------------------------------------------------- */

const pad4 = (buf, fill) => (buf.length % 4 === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4), fill)]));

/** The fixture's bytes. */
export function texturedGlb() {
  const { positions, normals, uvs, indices } = cube();
  const png = checkerPng();
  const views = [];
  const parts = [];
  let length = 0;
  const view = (bytes, target) => {
    const data = pad4(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    parts.push(data);
    length += data.length;
    return views.length - 1;
  };
  const ARRAY_BUFFER = 34962;
  const ELEMENT_ARRAY_BUFFER = 34963;
  const FLOAT = 5126;
  const UNSIGNED_SHORT = 5123;
  const vPos = view(positions, ARRAY_BUFFER);
  const vNor = view(normals, ARRAY_BUFFER);
  const vUv = view(uvs, ARRAY_BUFFER);
  const vIdx = view(indices, ELEMENT_ARRAY_BUFFER);
  const vPng = view(png);
  const json = {
    asset: { version: '2.0', generator: 'az scripts/gen-textured-glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'textured-cube' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'checker', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: vPng, mimeType: 'image/png' }],
    accessors: [
      { bufferView: vPos, componentType: FLOAT, count: positions.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: vNor, componentType: FLOAT, count: normals.length / 3, type: 'VEC3' },
      { bufferView: vUv, componentType: FLOAT, count: uvs.length / 2, type: 'VEC2' },
      { bufferView: vIdx, componentType: UNSIGNED_SHORT, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: length }],
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = Buffer.concat(parts);
  const head = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  return Buffer.concat([header, head(jsonChunk.length, 0x4e4f534a), jsonChunk, head(binChunk.length, 0x004e4942), binChunk]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bytes = texturedGlb();
  writeFileSync(TEXTURED_GLB, bytes);
  console.log(`wrote ${TEXTURED_GLB} (${bytes.length} bytes)`);
}
