/**
 * scene-spec §7 eviction policy — pure, so a trace tests it without a GPU.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { budgetFrom, SCENE_BUDGET_BYTES, sceneBytes, toEvict, type Resident } from '../src/runtime/evict.ts';

const MB = 1024 * 1024;
const view = (id: number, over: Partial<Resident> = {}): Resident =>
  ({ id, visible: false, backdrop: false, lastVisible: id, bytes: 10 * MB, ...over });

test('under budget, nothing is released', () => {
  assert.deepEqual(toEvict([view(0), view(1)], 64 * MB), []);
});

test('over budget, the least-recently-visible paused views go first, until it fits', () => {
  const views = [view(0, { lastVisible: 300 }), view(1, { lastVisible: 100 }), view(2, { lastVisible: 200 }),
    view(3, { visible: true, lastVisible: 400 })];
  assert.deepEqual(toEvict(views, 20 * MB), [1, 2], 'oldest first, stopping once 20MB fits');
});

test('an active view is never evicted, even when that leaves the page over budget', () => {
  const views = [view(0, { visible: true }), view(1, { visible: true }), view(2)];
  assert.deepEqual(toEvict(views, 5 * MB), [2]);
});

test('the backdrop is never evicted — it is on screen on every frame (§6.4)', () => {
  assert.deepEqual(toEvict([view(0, { backdrop: true, lastVisible: -Infinity }), view(1)], 5 * MB), [1]);
});

test('CONTROL: a view never seen counts as the oldest', () => {
  assert.deepEqual(toEvict([view(0, { lastVisible: 50 }), view(1, { lastVisible: -Infinity })], 10 * MB), [1]);
});

test('sceneBytes counts a buffer or texture once, however many scenes share it', () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const texture = new THREE.DataTexture(new Uint8Array(64 * 64 * 4), 64, 64);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const a = new THREE.Scene().add(new THREE.Mesh(geometry, material));
  const b = new THREE.Scene().add(new THREE.Mesh(geometry, material));
  const buffers = Object.values(geometry.attributes).reduce((n, x) => n + x.array.byteLength, 0) + geometry.index!.array.byteLength;
  const tex = 64 * 64 * 4;
  const seen = new Set<string>();
  const first = sceneBytes(a, seen);
  assert.equal(first, buffers + Math.round(tex * (texture.generateMipmaps ? 4 / 3 : 1)));
  assert.equal(sceneBytes(b, seen), 0, 'the shared geometry and texture are already counted');
  assert.equal(sceneBytes(b, new Set()), first, 'CONTROL: a fresh count sees them again');
});

test('?az-scene-budget takes whole megabytes only', () => {
  assert.equal(budgetFrom('?az-scene-budget=8'), 8 * MB);
  for (const bad of ['?az-scene-budget=-1', '?az-scene-budget=1e9', '?az-scene-budget=x', '']) {
    assert.equal(budgetFrom(bad), SCENE_BUDGET_BYTES, bad);
  }
});
