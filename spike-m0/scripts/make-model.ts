/**
 * Generate the sample model for the opt-in `.glb` path — ASSUMPTIONS A8.
 *
 * No third-party model files: the mesh is built here in three, exported with
 * three's own GLTFExporter, then Draco-compressed with the reference
 * encoder (draco3dgltf) through glTF Transform's KHR_draco_mesh_compression
 * writer — the author-side pipeline stack-evaluation.md §9 names. None of these
 * tools ship in the site; only the resulting .glb and three's decoder do.
 *
 * What the sample represents: a product hero model at a realistic web budget —
 * a shoe-like assembly (a lathed sole, a smooth upper, laces) with positions,
 * normals and UVs, no textures. Draco compresses geometry only; texture weight
 * is a separate budget (KTX2/WebP) and is NOT measured here.
 *
 * Run:  pnpm model                      → public/models/sample.glb (~200k tris)
 *       pnpm model --sweep              → sizes at 50k…800k triangles (A8 evidence)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'public/models/sample.glb');

/** The shipped sample's budget: mid-range for a web product hero model. */
const SAMPLE_TRIANGLES = 200_000;
const SWEEP = [50_000, 100_000, 200_000, 400_000, 800_000];

/** A8 / hero-spec manifest: "maxBytes": 5242880. */
const BUDGET_BYTES = 5 * 1024 * 1024;

/**
 * GLTFExporter hands its output through FileReader, a browser API Node lacks.
 * It calls exactly readAsArrayBuffer and readAsDataURL and listens on
 * onloadend; this adapter provides those two over Node's own Blob.
 */
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); });
  }
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
    });
  }
}
(globalThis as unknown as { FileReader: typeof NodeFileReader }).FileReader = NodeFileReader;

/** A shoe-like assembly whose triangle count scales with `triangles`. */
function buildProduct(triangles: number): THREE.Mesh {
  // Segment counts scale with sqrt(budget) on both axes of each surface, so
  // triangles scale linearly; the upper carries the curvature and gets the
  // most segments. The printed count is measured, not this target.
  const k = Math.sqrt(triangles / 200_000);
  const upper = new THREE.TorusKnotGeometry(1, 0.42, Math.round(560 * k), Math.round(96 * k), 2, 3);
  upper.scale(1.4, 0.8, 0.9);

  const profile: THREE.Vector2[] = [];
  const steps = Math.max(8, Math.round(48 * k));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    profile.push(new THREE.Vector2(0.2 + Math.sin(t * Math.PI) * 1.9, -1 + t * 0.45));
  }
  const sole = new THREE.LatheGeometry(profile, Math.round(620 * k));
  sole.scale(1.3, 1, 0.6);

  const laces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.6 + i * 0.25, 0.7, -0.4),
      new THREE.Vector3(-0.5 + i * 0.25, 0.95, 0),
      new THREE.Vector3(-0.6 + i * 0.25, 0.7, 0.4),
    ]);
    laces.push(new THREE.TubeGeometry(curve, Math.round(180 * k), 0.035, Math.max(6, Math.round(24 * k)), false));
  }

  // Every part is indexed, which mergeGeometries requires of all or none.
  const merged = mergeGeometries([upper, sole, ...laces], false);
  if (!merged) throw new Error('make-model: geometries could not be merged');
  merged.computeBoundingSphere();
  return new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.55 }));
}

const triangleCount = (m: THREE.Mesh) => {
  const g = m.geometry;
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
};

/** three → glTF binary (uncompressed), exactly as an author's DCC export would be. */
async function exportGlb(mesh: THREE.Mesh): Promise<Uint8Array> {
  const scene = new THREE.Scene();
  scene.add(mesh);
  const out = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Uint8Array(out as ArrayBuffer);
}

/** Uncompressed .glb → Draco-compressed .glb. */
async function draco(glb: Uint8Array): Promise<Uint8Array> {
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    });
  const doc = await io.readBinary(glb);
  doc.createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    // glTF Transform's documented defaults, stated explicitly so the record
    // says what produced the sizes: edgebreaker, 14-bit positions.
    .setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizationBits: { POSITION: 14, NORMAL: 10, TEXCOORD_0: 12 },
    });
  return io.writeBinary(doc);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

if (process.argv.includes('--sweep')) {
  console.log('\nA8 — Draco size by triangle count (geometry only: position, normal, uv)\n');
  console.log('  triangles     raw .glb     draco .glb   ratio   under 5 MB');
  for (const target of SWEEP) {
    const mesh = buildProduct(target);
    const raw = await exportGlb(mesh);
    const packed = await draco(raw);
    console.log(`  ${String(Math.round(triangleCount(mesh))).padStart(9)}   ${mb(raw.byteLength).padStart(10)}   ${mb(packed.byteLength).padStart(10)}   ${(raw.byteLength / packed.byteLength).toFixed(1).padStart(4)}x   ${packed.byteLength < BUDGET_BYTES ? 'yes' : 'NO'}`);
  }
} else {
  const mesh = buildProduct(SAMPLE_TRIANGLES);
  const packed = await draco(await exportGlb(mesh));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, packed);
  console.log(`make-model: ${Math.round(triangleCount(mesh))} triangles → ${OUT} (${mb(packed.byteLength)})`);
}
