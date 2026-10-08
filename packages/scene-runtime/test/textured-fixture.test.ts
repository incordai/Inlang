/**
 * The textured model test:3d draws under the page's policy
 * (word-quality-gate §2 B) is GENERATED: the committed file must equal a
 * fresh run of scripts/gen-textured-glb.mjs, byte for byte, and must really
 * carry an embedded texture — or the browser check proves nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { RED, TEXTURED_GLB, texturedGlb } from '../../../scripts/gen-textured-glb.mjs';

/** Kept small: a fixture in the repository, not an asset. */
const MAX_BYTES = 50 * 1024;

interface Gltf {
  images: { bufferView?: number; uri?: string; mimeType?: string }[];
  textures: { source: number }[];
  materials: { pbrMetallicRoughness?: { baseColorTexture?: { index: number }; baseColorFactor?: number[] } }[];
  meshes: { primitives: { attributes: Record<string, number>; material: number }[] }[];
  bufferViews: { byteOffset?: number; byteLength: number }[];
}

/** The JSON and BIN chunks of a GLB (glTF 2.0 §4.4). */
function chunks(glb: Buffer): { json: Gltf; bin: Buffer } {
  assert.equal(glb.readUInt32LE(0), 0x46546c67, 'magic glTF');
  assert.equal(glb.readUInt32LE(4), 2, 'container version 2');
  assert.equal(glb.readUInt32LE(8), glb.length, 'declared length is the file length');
  const jsonLength = glb.readUInt32LE(12);
  assert.equal(glb.readUInt32LE(16), 0x4e4f534a, 'first chunk is JSON');
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf;
  const at = 20 + jsonLength;
  assert.equal(glb.readUInt32LE(at + 4), 0x004e4942, 'second chunk is BIN');
  return { json, bin: glb.subarray(at + 8, at + 8 + glb.readUInt32LE(at)) };
}

test('textured.glb is exactly the generator output — no hand edits', () => {
  assert.ok(readFileSync(TEXTURED_GLB).equals(texturedGlb()), 'regenerate with: node scripts/gen-textured-glb.mjs');
});

test('the generator is deterministic: two runs, the same bytes', () => {
  assert.ok(texturedGlb().equals(texturedGlb()));
});

test(`it stays under ${MAX_BYTES / 1024}KB`, () => {
  assert.ok(texturedGlb().length < MAX_BYTES, `${texturedGlb().length} bytes`);
});

test('its one material samples an image embedded in the file, not one fetched by URI', async () => {
  const { json, bin } = chunks(texturedGlb());
  const primitive = json.meshes[0].primitives[0];
  assert.ok('TEXCOORD_0' in primitive.attributes, 'the cube has texture coordinates');
  const pbr = json.materials[primitive.material].pbrMetallicRoughness;
  assert.equal(pbr?.baseColorFactor, undefined, 'the material\'s own colour is white: only the texture can be red');
  const image = json.images[json.textures[pbr?.baseColorTexture?.index ?? -1].source];
  assert.equal(image.uri, undefined, 'no URI: the loader makes a blob: URL from the bytes');
  assert.equal(image.mimeType, 'image/png');
  const view = json.bufferViews[image.bufferView ?? -1];
  const png = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [32, 32, 3]);
  assert.deepEqual([...data.subarray(0, 3)], [...RED], 'the texture decodes, its first square red');
});
