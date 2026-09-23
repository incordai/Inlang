/**
 * A studio environment from emissive planes, prefiltered for image-based
 * lighting — 3d-technique-reference §1: the physical material reads as a
 * product render only when it has an environment to reflect.
 *
 * Built from geometry owned here, not an .hdr file: an HDRI download would put
 * a third-party request into every generated site (PRD principle 1). The
 * planes are the spike's key / rim / fill / bounce arrangement. Lights are
 * neutral — only their strength differs — so the one colour in the scene is
 * the theme's, carried by the material.
 */

import * as THREE from 'three';

interface Light {
  readonly intensity: number;
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number];
}

const LIGHTS: readonly Light[] = [
  { intensity: 4.2, position: [-3.5, 4.5, 5], size: [9, 9] },    // key: large, soft, high front-left
  { intensity: 6.0, position: [5, 1.5, -4], size: [5, 5] },      // rim: tight, behind right — draws the edge
  { intensity: 1.4, position: [2, -3.5, 3], size: [8, 5] },      // fill: broad and low
  { intensity: 0.9, position: [0, -5, 0], size: [12, 12] },      // ground bounce
];

/** Sigma of the prefilter blur, in radians — soft reflections, not mirror. */
const BLUR_SIGMA = 0.04;

/** The prefiltered environment. The caller disposes the target (and so its texture). */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();
  const plane = new THREE.PlaneGeometry(1, 1);
  const materials: THREE.MeshBasicMaterial[] = [];
  for (const light of LIGHTS) {
    // HDR white: a basic material's colour above 1 is how an emitter is
    // brighter than the surface it lights (the prefilter target is half-float).
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    material.color.setScalar(light.intensity);
    materials.push(material);
    const mesh = new THREE.Mesh(plane, material);
    mesh.position.set(...light.position);
    mesh.scale.set(light.size[0], light.size[1], 1);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, BLUR_SIGMA);
  pmrem.dispose();
  plane.dispose();
  for (const m of materials) m.dispose();
  return target;
}
