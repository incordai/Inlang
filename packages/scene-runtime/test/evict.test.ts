/**
 * scene-spec §7 eviction policy — pure, so a trace tests it without a GPU.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { budgetFrom, SCENE_BUDGET_BYTES, sceneResources, seenAt, toEvict, type Resident } from '../src/runtime/evict.ts';

const MB = 1024 * 1024;
const view = (id: number, over: Partial<Resident> = {}): Resident =>
  ({ id, visible: false, backdrop: false, lastVisible: id, resources: [{ key: `own-${id}`, bytes: 10 * MB }], ...over });

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

test('sceneResources keys every buffer and texture, so two scenes sharing one yield the same keys', () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const texture = new THREE.DataTexture(new Uint8Array(64 * 64 * 4), 64, 64);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const a = new THREE.Scene().add(new THREE.Mesh(geometry, material));
  const b = new THREE.Scene().add(new THREE.Mesh(geometry, material));
  const buffers = Object.values(geometry.attributes).reduce((n, x) => n + x.array.byteLength, 0) + geometry.index!.array.byteLength;
  const tex = Math.round(64 * 64 * 4 * (texture.generateMipmaps ? 4 / 3 : 1));
  const ra = sceneResources(a);
  assert.equal(ra.reduce((n, r) => n + r.bytes, 0), buffers + tex);
  assert.deepEqual(sceneResources(b).map((r) => r.key).sort(), ra.map((r) => r.key).sort(), 'the same uploads, the same keys');
  const c = new THREE.Scene().add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  assert.notDeepEqual(sceneResources(c).map((r) => r.key).sort(), ra.map((r) => r.key).sort(), 'CONTROL: a new geometry is a new key');
});

test('a model shown in two views is one upload: releasing one of them frees nothing', () => {
  const shared = [{ key: 'model', bytes: 30 * MB }];
  const views = [view(0, { resources: shared, lastVisible: 1 }), view(1, { resources: shared, visible: true }),
    view(2, { lastVisible: 2 })];
  // 40MB held (the model once, plus view 2's own 10MB). To fit 30MB, view 2
  // must go; releasing view 0 alone frees nothing while view 1 shows the model.
  assert.deepEqual(toEvict(views, 30 * MB), [2]);
});

test('CONTROL: once no kept view shares the model, releasing its holders frees it', () => {
  const shared = [{ key: 'model', bytes: 30 * MB }];
  const views = [view(0, { resources: shared, lastVisible: 1 }), view(1, { resources: shared, lastVisible: 2 })];
  assert.deepEqual(toEvict(views, 5 * MB), [0, 1]);
});

test('recency is when a view LEFT the warm margin, not when it entered', () => {
  // A: entered at 0, left at 100. B: entered at 50, left at 60.
  let a = seenAt(false, true, -Infinity, 0);
  let b = seenAt(false, true, -Infinity, 50);
  b = seenAt(true, false, b, 60);
  a = seenAt(true, false, a, 100);
  assert.deepEqual([a, b], [100, 60]);
  assert.deepEqual(toEvict([view(0, { lastVisible: a }), view(1, { lastVisible: b })], 10 * MB), [1],
    'the one left longer ago goes first');
  assert.equal(seenAt(false, false, 7, 99), 7, 'CONTROL: no change while it stays away');
});

test('?az-scene-budget takes whole megabytes only', () => {
  assert.equal(budgetFrom('?az-scene-budget=8'), 8 * MB);
  for (const bad of ['?az-scene-budget=-1', '?az-scene-budget=1e9', '?az-scene-budget=x', '']) {
    assert.equal(budgetFrom(bad), SCENE_BUDGET_BYTES, bad);
  }
});
