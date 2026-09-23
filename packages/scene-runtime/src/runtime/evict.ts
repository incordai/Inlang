/**
 * @az runtime evict
 * Purpose: budget eviction: least-recently-visible paused views go back to their poster.
 * Spec: docs/scene-block-spec.md §7
 * Exports: toEvict, sceneResources, SCENE_BUDGET_BYTES, budgetFrom
 * Edit guide: never evict a visible view or the backdrop; count a shared resource once.
 * Tests: packages/scene-runtime/test/evict.test.ts
 */

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

/** One GPU resource a view holds: an upload, keyed so a shared one counts once. */
export interface Resource {
  readonly key: string;
  readonly bytes: number;
}

/** A view as the policy sees it. */
export interface Resident {
  readonly id: number;
  /** Inside the warm margin — being drawn, or about to be. */
  readonly visible: boolean;
  readonly backdrop: boolean;
  /** When it was last visible (page clock); never-seen views count as oldest. */
  readonly lastVisible: number;
  /**
   * What it holds on the GPU. A model shown in two views is ONE upload:
   * releasing one of them frees nothing while the other still holds it.
   */
  readonly resources: readonly Resource[];
}

/** Bytes of the distinct resources the given views hold together. */
function heldBytes(residents: readonly Resident[]): number {
  const held = new Map<string, number>();
  for (const r of residents) for (const res of r.resources) held.set(res.key, res.bytes);
  let total = 0;
  for (const b of held.values()) total += b;
  return total;
}

/**
 * Which views to release, oldest-seen first, until what REMAINS fits.
 * Returns fewer than needed when only active views remain: those stay.
 * Accounting is by resource, so a view whose model another view also shows
 * is released only when that frees enough on its own or with others.
 */
export function toEvict(residents: readonly Resident[], budget: number): number[] {
  if (heldBytes(residents) <= budget) return [];
  const paused = residents
    .filter((r) => !r.visible && !r.backdrop)
    .sort((a, b) => a.lastVisible - b.lastVisible || a.id - b.id);
  const out = new Set<number>();
  for (const r of paused) {
    out.add(r.id);
    if (heldBytes(residents.filter((x) => !out.has(x.id))) <= budget) break;
  }
  // Nothing freed is nothing gained: a release that frees no bytes (its
  // resources shared with a kept view) is not made.
  const kept = residents.filter((x) => !out.has(x.id));
  return [...out].filter((id) => {
    const r = residents.find((x) => x.id === id)!;
    const others = new Set(kept.flatMap((x) => x.resources.map((res) => res.key)));
    return r.resources.some((res) => !others.has(res.key)) || r.resources.length === 0;
  });
}

/**
 * When a view was last visible, after an intersection change: the moment it
 * LEFT the warm margin counts, not the moment it entered — a view on screen
 * from 0 to 100 is more recent than one seen from 50 to 60.
 */
export function seenAt(wasVisible: boolean, isVisible: boolean, last: number, now: number): number {
  return wasVisible || isVisible ? now : last;
}

/** Texture bytes: RGBA8, plus a third for the mip chain. */
function textureBytes(t: THREE.Texture): number {
  const image = t.image as { width?: number; height?: number } | undefined;
  const w = image?.width ?? 0;
  const h = image?.height ?? 0;
  return Math.round(w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1));
}

/**
 * The GPU resources a scene graph holds: every geometry's buffers and every
 * material texture, keyed by uuid — a model shown in two views yields the
 * same keys from both. The scene's environment map is the page's, shared by
 * every view, and is not counted.
 */
export function sceneResources(root: THREE.Object3D): Resource[] {
  const out = new Map<string, number>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    if (!out.has(g.uuid)) {
      let bytes = 0;
      for (const a of Object.values(g.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength;
      if (g.index) bytes += g.index.array.byteLength;
      out.set(g.uuid, bytes);
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      for (const value of Object.values(m)) {
        if (value instanceof THREE.Texture && !out.has(value.uuid)) out.set(value.uuid, textureBytes(value));
      }
    }
  });
  return [...out].map(([key, bytes]) => ({ key, bytes }));
}

/** `?az-scene-budget=<MB>`: a smaller budget, for tests and diagnosis (whole MB only). */
export function budgetFrom(search: string): number {
  const mb = new URLSearchParams(search).get('az-scene-budget');
  return mb !== null && /^\d{1,4}$/.test(mb) ? Number(mb) * 1024 * 1024 : SCENE_BUDGET_BYTES;
}
