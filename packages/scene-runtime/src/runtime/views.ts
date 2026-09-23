/**
 * @az runtime views
 * Purpose: what a view draws: procedural strands, a loaded model, or the image ring.
 * Spec: docs/scene-block-spec.md §11
 * Exports: strands, model, ring, ModelCache, disposeTree
 * Edit guide: models are ref-counted in ModelCache; failed images keep the ring from going ready.
 * Tests: scripts/test-3d.mjs
 */

/**
 * What a view draws: the procedural strands (the default), a loaded model,
 * or gallery `orbit`'s ring of images. Each is a scene plus a camera; the
 * shared renderer (stage.ts) decides when and where each one is drawn.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { buildStrands, disposeStrands, type BuiltGeometry } from './geometry.ts';
import { createStrandMaterial, type GrowthUniforms } from './material.ts';
import { CAMERA, computeCentredFraming, computeFraming } from './framing.ts';
import type { Rung } from './tiers.ts';

/** Where the scroll or orbit input has put the object, damped by the stage. */
export interface Pose {
  /** 0 → 1 through the view's scroll range (page range for a backdrop). */
  readonly progress: number;
  /** Extra rotation from keyboard or drag, radians (`camera orbit`). */
  readonly yaw: number;
}

export interface Content {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Something is there to draw. Until then the poster stays up — hero-spec §8:
   * the poster is the loading state as well as the static one.
   */
  readonly ready: boolean;
  /** Size the camera and framing for the view's current aspect ratio. */
  setAspect(aspect: number): void;
  /** Apply a rung's level of detail (§5 rung 5). */
  setRung(rung: Rung): void;
  /** The theme accent changed with the scheme. */
  recolour(hex: string): void;
  update(pose: Pose): void;
  dispose(): void;
}

/** `hero` and `scene` frame the object in a box of their own; a hero behind its text keeps it beside the copy. */
export type Framing = 'centred' | 'beside-text';

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 100);
  c.position.set(...CAMERA.position);
  return c;
}

/** Free every geometry, material and texture under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      for (const value of Object.values(m)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      m.dispose();
    }
  });
}

/** Max distance of any vertex from the Y axis — the disc the object sweeps. */
function radiusXZ(root: THREE.Object3D): number {
  let r = 0;
  const v = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const pos = mesh.isMesh ? mesh.geometry.attributes.position : undefined;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      r = Math.max(r, Math.hypot(v.x, v.z));
    }
  });
  return r;
}

/** The pose that opens the scene before any scroll: already formed (spike Hero §8). */
const REST_GROWTH = 0.62;
const GROWTH_RANGE = 0.48;
const REST_YAW = -0.35;
const YAW_RANGE = Math.PI * 0.55;
/** Strand counts per level of detail — the spike's measured values. */
const STRANDS = { high: 16, low: 10 } as const;

function place(group: THREE.Group, aspect: number, radius: number, framing: Framing): void {
  const f = framing === 'centred' ? computeCentredFraming(aspect, radius) : computeFraming(aspect, radius);
  group.position.set(...f.position);
  group.scale.setScalar(f.scale);
}

/** The procedural strands, seeded — scene-spec §11.1, the default geometry. */
export function strands(seed: number, colour: string, env: THREE.Texture, framing: Framing): Content {
  const scene = new THREE.Scene();
  scene.environment = env;
  const cam = camera();
  const group = new THREE.Group();
  scene.add(group);

  let lod: 'high' | 'low' = 'high';
  let hex = colour;
  let built: BuiltGeometry | null = null;
  let material: THREE.MeshPhysicalMaterial | null = null;
  let uniforms: GrowthUniforms | null = null;
  let aspect = 1;

  const build = () => {
    if (built) disposeStrands(built);
    material?.dispose();
    group.clear();
    built = buildStrands({ seed, strands: STRANDS[lod] });
    ({ material, uniforms } = createStrandMaterial(lod === 'high' ? 'full' : 'lite', hex));
    for (const g of built.geometries) group.add(new THREE.Mesh(g, material));
    place(group, aspect, built.radiusXZ, framing);
  };
  build();

  return {
    scene,
    camera: cam,
    ready: true,
    setAspect(a) {
      aspect = a;
      cam.aspect = a;
      cam.updateProjectionMatrix();
      if (built) place(group, a, built.radiusXZ, framing);
    },
    setRung(rung) {
      if (rung.lod === lod) return;
      lod = rung.lod;
      build();
    },
    recolour(next) {
      hex = next;
      material?.color.setStyle(next, THREE.SRGBColorSpace);
    },
    update(pose) {
      if (uniforms) uniforms.uGrowth.value = REST_GROWTH + pose.progress * GROWTH_RANGE;
      group.rotation.y = REST_YAW + pose.progress * YAW_RANGE + pose.yaw;
    },
    dispose() {
      if (built) disposeStrands(built);
      material?.dispose();
      group.clear();
    },
  };
}

/**
 * Loaded models, one fetch and one decode per URL however many views show
 * it (scene-spec §5: shared caches keyed by asset path).
 */
export class ModelCache {
  private readonly draco = new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG);
  private readonly loader = new GLTFLoader().setDRACOLoader(this.draco);
  private readonly pending = new Map<string, Promise<THREE.Group>>();
  /** Live views holding each URL: §7 releases the entries none still references. */
  private readonly refs = new Map<string, number>();

  /** Take a reference; the first loads and decodes. Pair with release(). */
  acquire(url: string): Promise<THREE.Group> {
    this.refs.set(url, (this.refs.get(url) ?? 0) + 1);
    let p = this.pending.get(url);
    if (!p) {
      // DRACO_GLTF_CONFIG is the glTF decoder three references with
      // `new URL(…, import.meta.url)`, so the bundler ships it inside this
      // site: same-origin, no CDN (PRD §6.7).
      p = this.loader.loadAsync(url).then((gltf) => gltf.scene);
      this.pending.set(url, p);
    }
    return p;
  }

  /** Drop a reference; the last one frees the decoded model's GPU resources. */
  release(url: string): void {
    const n = (this.refs.get(url) ?? 0) - 1;
    if (n > 0) { this.refs.set(url, n); return; }
    this.refs.delete(url);
    this.pending.get(url)?.then(disposeTree, () => undefined);
    this.pending.delete(url);
  }

  dispose(): void {
    for (const p of this.pending.values()) {
      p.then(disposeTree, () => undefined);
    }
    this.pending.clear();
    this.refs.clear();
    this.draco.dispose();
  }
}

/**
 * A model from the site's own assets. The stage validated the URL; a failed
 * load leaves the view's poster up and is reported, never thrown at the page.
 */
export function model(url: string, cache: ModelCache, env: THREE.Texture, framing: Framing,
  onFail: (error: unknown) => void): Content {
  const scene = new THREE.Scene();
  scene.environment = env;
  const cam = camera();
  const group = new THREE.Group();
  scene.add(group);
  let aspect = 1;
  let radius = 0;
  let alive = true;
  let loaded = false;

  cache.acquire(url).then(
    (source) => {
      if (!alive) return;
      // A clone shares geometry and materials with the cached original.
      const instance = source.clone(true);
      radius = radiusXZ(instance) || 1;
      group.add(instance);
      place(group, aspect, radius, framing);
      loaded = true;
    },
    (error: unknown) => { if (alive) onFail(error); },
  );

  return {
    scene,
    camera: cam,
    get ready() { return loaded; },
    setAspect(a) {
      aspect = a;
      cam.aspect = a;
      cam.updateProjectionMatrix();
      if (radius) place(group, a, radius, framing);
    },
    setRung() { /* a model's LOD is the author's asset; the rung caps DPR and motion */ },
    recolour() { /* a model carries its own materials */ },
    update(pose) {
      group.rotation.y = REST_YAW + pose.progress * YAW_RANGE + pose.yaw;
    },
    dispose() {
      alive = false;
      // Shared resources belong to the cache, which frees them when the last
      // view holding this model lets go.
      group.clear();
      cache.release(url);
    },
  };
}

/** gallery-spec §9: planes around a circle, facing out. */
const RING = { radius: 2.6, planeWidth: 1.4, turnsPerScroll: 0.5 } as const;

/**
 * gallery `orbit`: a ring of the section's own images, rotated by scroll or
 * drag. A ring with a missing image is not the ring: one failed image fails
 * the view, which keeps its poster and its list (the images stay content).
 */
export function ring(sources: readonly string[], aspectRatio: number, env: THREE.Texture,
  onFail: (error: unknown) => void): Content {
  const scene = new THREE.Scene();
  scene.environment = env;
  const cam = camera();
  const group = new THREE.Group();
  scene.add(group);
  const loader = new THREE.TextureLoader();
  const plane = new THREE.PlaneGeometry(RING.planeWidth, RING.planeWidth / aspectRatio);
  const materials: THREE.MeshBasicMaterial[] = [];
  const textures: THREE.Texture[] = [];
  let alive = true;
  let loaded = 0;
  let failed = false;
  const fail = (error: unknown) => {
    if (!alive || failed) return;
    failed = true;
    onFail(error);
  };

  sources.forEach((src, i) => {
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0 });
    materials.push(material);
    const mesh = new THREE.Mesh(plane, material);
    const angle = (i / sources.length) * Math.PI * 2;
    mesh.position.set(Math.sin(angle) * RING.radius, 0, Math.cos(angle) * RING.radius);
    mesh.rotation.y = angle;
    group.add(mesh);
    loader.load(src, (texture) => {
      if (!alive) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      material.map = texture;
      material.opacity = 1;
      material.needsUpdate = true;
      loaded++;
    }, undefined, fail);
  });

  return {
    scene,
    camera: cam,
    // The ring replaces the poster only once every image has arrived.
    get ready() { return !failed && loaded === sources.length; },
    setAspect(a) {
      cam.aspect = a;
      cam.updateProjectionMatrix();
    },
    setRung() { /* the ring has one level of detail; the rung caps DPR and motion */ },
    recolour() { /* the images are the content; nothing to tint */ },
    update(pose) {
      group.rotation.y = pose.progress * Math.PI * 2 * RING.turnsPerScroll + pose.yaw;
    },
    dispose() {
      alive = false;
      for (const t of textures) t.dispose();
      for (const m of materials) m.dispose();
      plane.dispose();
      group.clear();
    },
  };
}
