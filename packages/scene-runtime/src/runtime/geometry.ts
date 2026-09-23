/**
 * @az runtime geometry
 * Purpose: procedural strand geometry — the default scene, seeded and deterministic.
 * Spec: docs/scene-block-spec.md §11 · docs/ASSUMPTIONS.md A8b
 * Exports: buildStrands, disposeStrands, DEFAULT_STRANDS
 * Edit guide: the vertex hash must stay stable across engines (cc723c2a1b107de4 for the default seed).
 * Tests: packages/scene-runtime/test/scene-runtime.test.ts
 */

/**
 * Procedural geometry — the DEFAULT source of a 3D scene.
 *
 * Implements docs/scene-block-spec.md §11.1. The technique (swept spline tubes
 * plus shell layers for volume) is the one catalogued in
 * docs/3d-technique-reference.md §§2–3, reimplemented from the method rather
 * than from anyone's source.
 *
 * Determinism (A8b) is the whole point: every value below derives from the
 * seed, so the same site name yields the same mesh on every engine, forever.
 */

import * as THREE from 'three';
import { rng, valueNoise1D, hashFloats } from './seed.ts';

export interface StrandParams {
  readonly seed: number;
  readonly strands: number;
  readonly pointsPerStrand: number;
  readonly tubularSegments: number;
  readonly radialSegments: number;
  readonly radius: number;
  readonly spread: number;
}

export const DEFAULT_STRANDS: StrandParams = {
  seed: 0,
  strands: 14,
  pointsPerStrand: 8,
  tubularSegments: 48,
  radialSegments: 6,
  radius: 0.045,
  spread: 2.2,
};

/**
 * Build one strand's control points.
 *
 * Deliberately NOT a helix: a regular curve reads as a tech demo. The noise
 * displacement is what makes it read as grown rather than generated.
 */
function strandCurve(p: StrandParams, index: number): THREE.CatmullRomCurve3 {
  const r = rng(p.seed + index * 7919);
  const noise = valueNoise1D(p.seed + index * 104729);
  const pts: THREE.Vector3[] = [];

  // Each strand starts somewhere on a ring and climbs, wandering as it goes.
  const theta0 = r() * Math.PI * 2;
  const climb = 0.55 + r() * 0.9;

  for (let i = 0; i < p.pointsPerStrand; i++) {
    const t = i / (p.pointsPerStrand - 1);
    const theta = theta0 + t * (1.2 + r() * 2.4);
    const radius = p.spread * (0.25 + 0.75 * Math.sin(Math.PI * t)) * (0.6 + noise(t * 3) * 0.8);
    pts.push(
      new THREE.Vector3(
        Math.cos(theta) * radius + (noise(t * 5 + 11) - 0.5) * 0.5,
        -1.2 + t * climb * 2.6,
        Math.sin(theta) * radius + (noise(t * 5 + 23) - 0.5) * 0.5,
      ),
    );
  }
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
}

export interface BuiltGeometry {
  readonly geometries: THREE.TubeGeometry[];
  /** Hash of every vertex position, in order. The A8b determinism token. */
  readonly hash: string;
  readonly vertexCount: number;
  /** Max distance of any vertex from the Y axis — the disc the group sweeps
   *  as it rotates. Framing must size against THIS, not the bounding box. */
  readonly radiusXZ: number;
}

/**
 * Build the strand set. Allocated ONCE — never rebuilt per frame.
 *
 * Rebuilding geometry each frame is the mistake that kills mid-range devices;
 * animation happens in the shader against a uniform instead
 * (3d-technique-reference.md §3).
 */
export function buildStrands(params: Partial<StrandParams> = {}): BuiltGeometry {
  const p = { ...DEFAULT_STRANDS, ...params };
  const geometries: THREE.TubeGeometry[] = [];
  let total = 0;

  for (let i = 0; i < p.strands; i++) {
    const g = new THREE.TubeGeometry(
      strandCurve(p, i),
      p.tubularSegments,
      p.radius * (0.6 + (i % 5) * 0.18),
      p.radialSegments,
      false,
    );
    geometries.push(g);
    total += g.attributes.position.count;
  }

  // Concatenate every position attribute in a fixed order so the hash covers
  // the whole scene, not one strand.
  const all = new Float32Array(total * 3);
  let off = 0;
  for (const g of geometries) {
    const a = g.attributes.position.array as Float32Array;
    all.set(a, off);
    off += a.length;
  }

  let radiusXZ = 0;
  for (let i = 0; i < all.length; i += 3) {
    const r = Math.hypot(all[i], all[i + 2]);
    if (r > radiusXZ) radiusXZ = r;
  }

  return { geometries, hash: hashFloats(all), vertexCount: total, radiusXZ };
}

/** Free every GPU resource. hero-spec §8: without this a route change leaks. */
export function disposeStrands(built: BuiltGeometry): void {
  for (const g of built.geometries) g.dispose();
}
