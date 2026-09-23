/**
 * Budget eviction — scene-spec §7.
 *
 * Paused views keep their GPU resources, so scrolling back costs nothing. But
 * a long page of scenes can hold more than a phone can: when live scene
 * memory exceeds the budget, the least-recently-visible PAUSED view is
 * released and shows its poster; an active view is never evicted, nor the
 * backdrop, which is on screen on every frame (§6.4).
 *
 * The policy is pure — views in, ids out — so a trace tests it without a GPU.
 */

import * as THREE from 'three';

/**
 * Live scene memory the page may hold, estimated GPU bytes.
 *
 * gallery-spec §9 measures sixteen 1024² textures at ~85MB of GPU memory
 * and calls it a tab crash on a mid-range phone; 64MB sits below that with
 * room for the page's own compositing. Recorded in scene-spec §7.
 */
export const SCENE_BUDGET_BYTES = 64 * 1024 * 1024;

/** A view as the policy sees it. */
export interface Resident {
  readonly id: number;
  /** Inside the warm margin — being drawn, or about to be. */
  readonly visible: boolean;
  readonly backdrop: boolean;
  /** When it was last visible (page clock); never-seen views count as oldest. */
  readonly lastVisible: number;
  /** Its estimated GPU bytes while resident. */
  readonly bytes: number;
}

/**
 * Which views to release, oldest-seen first, until the total fits.
 * Returns fewer than needed when only active views remain: those stay.
 */
export function toEvict(residents: readonly Resident[], budget: number): number[] {
  let total = residents.reduce((n, r) => n + r.bytes, 0);
  if (total <= budget) return [];
  const paused = residents
    .filter((r) => !r.visible && !r.backdrop)
    .sort((a, b) => a.lastVisible - b.lastVisible || a.id - b.id);
  const out: number[] = [];
  for (const r of paused) {
    if (total <= budget) break;
    out.push(r.id);
    total -= r.bytes;
  }
  return out;
}

/** Texture bytes: RGBA8, plus a third for the mip chain. */
function textureBytes(t: THREE.Texture): number {
  const image = t.image as { width?: number; height?: number } | undefined;
  const w = image?.width ?? 0;
  const h = image?.height ?? 0;
  return Math.round(w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1));
}

/**
 * The GPU bytes a scene graph holds: every geometry's buffers and every
 * material texture, each counted once across all scenes passed the same
 * `seen` set — a model shown in two views is one upload. The scene's
 * environment map is the page's, shared by every view, and is not counted.
 */
export function sceneBytes(root: THREE.Object3D, seen: Set<string>): number {
  let bytes = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    if (!seen.has(g.uuid)) {
      seen.add(g.uuid);
      for (const a of Object.values(g.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength;
      if (g.index) bytes += g.index.array.byteLength;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      for (const value of Object.values(m)) {
        if (value instanceof THREE.Texture && !seen.has(value.uuid)) {
          seen.add(value.uuid);
          bytes += textureBytes(value);
        }
      }
    }
  });
  return bytes;
}

/** `?az-scene-budget=<MB>`: a smaller budget, for tests and diagnosis (whole MB only). */
export function budgetFrom(search: string): number {
  const mb = new URLSearchParams(search).get('az-scene-budget');
  return mb !== null && /^\d{1,4}$/.test(mb) ? Number(mb) * 1024 * 1024 : SCENE_BUDGET_BYTES;
}
