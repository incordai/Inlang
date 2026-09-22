import { buildStrands } from '../src/geometry.ts';
import * as THREE from 'three';
const b = buildStrands({ seed: 0x415a, strands: 16 });
const box = new THREE.Box3();
for (const g of b.geometries) { g.computeBoundingBox(); if (g.boundingBox) box.union(g.boundingBox); }
const size = box.getSize(new THREE.Vector3());
const c = box.getCenter(new THREE.Vector3());
console.log('min   ', box.min.toArray().map(n=>n.toFixed(2)).join(', '));
console.log('max   ', box.max.toArray().map(n=>n.toFixed(2)).join(', '));
console.log('size  ', size.toArray().map(n=>n.toFixed(2)).join(', '));
console.log('center', c.toArray().map(n=>n.toFixed(2)).join(', '));

// The group rotates on Y, so the axis-aligned box UNDERSTATES the footprint.
// What actually matters for framing is the max radius in the XZ plane.
let maxR = 0, minY = Infinity, maxY = -Infinity;
for (const g of b.geometries) {
  const pos = g.attributes.position.array as Float32Array;
  for (let i = 0; i < pos.length; i += 3) {
    const r = Math.hypot(pos[i], pos[i + 2]);
    if (r > maxR) maxR = r;
    if (pos[i + 1] < minY) minY = pos[i + 1];
    if (pos[i + 1] > maxY) maxY = pos[i + 1];
  }
}
console.log('XZ rotation radius', maxR.toFixed(2), '-> swept width', (maxR * 2).toFixed(2));
console.log('Y extent          ', minY.toFixed(2), 'to', maxY.toFixed(2));
