/**
 * The opt-in model path — a Draco-compressed .glb instead of the procedural
 * strands (scene-spec §11.1: procedural is the default, a model is opt-in).
 *
 * Tests ASSUMPTIONS A8. hero-spec §8 applies as to the procedural scene: the
 * decoder is self-hosted (bundled from three, no CDN), every GPU resource is disposed on unmount,
 * and the poster stands in while loading or on failure (Hero, model-url.tsx).
 * Loaded lazily by Hero, so the default page never downloads these loaders.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { computeFraming } from './framing.ts';
import type { Rung } from './tiers.ts';
import { reportModel } from './model-url.tsx';

/** Max distance of any vertex from the Y axis — what framing sizes against. */
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

function triangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null;
    if (g) n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}

/** Free every geometry, material and texture under `root`. */
function disposeTree(root: THREE.Object3D): void {
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

export default function Model({ url, rung, scroll, subscribers, onVertices, onFail }: {
  url: string;
  rung: Rung;
  scroll: React.RefObject<number>;
  subscribers: Set<(progress: number) => void>;
  onVertices: (n: number) => void;
  onFail: (error: unknown) => void;
}) {
  const invalidate = useThree((st) => st.invalidate);
  const aspect = useThree((st) => st.viewport.aspect);
  const [scene, setScene] = useState<THREE.Group | null>(null);

  // Loaded imperatively, not through a suspending loader: a failed fetch is
  // caught HERE and reported, rather than surfacing as an uncaught page error
  // while the poster stays up. hero-spec §8 dispose(): the decoder's workers
  // are released on unmount, and a model that arrives after unmount is freed
  // at once instead of leaking.
  useEffect(() => {
    let alive = true;
    let loaded: THREE.Group | null = null;
    // DRACO_GLTF_CONFIG is the glTF-only decoder that three references with
    // `new URL(…, import.meta.url)`, so the bundler emits it into this site:
    // self-hosted, same-origin, no CDN (PRD §6.7), and nothing to copy by hand.
    const draco = new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG);
    new GLTFLoader().setDRACOLoader(draco).loadAsync(url).then(
      (gltf) => {
        if (!alive) { disposeTree(gltf.scene); return; }
        loaded = gltf.scene;
        setScene(gltf.scene);
      },
      (error: unknown) => { if (alive) onFail(error); },
    );
    return () => {
      alive = false;
      if (loaded) disposeTree(loaded);
      draco.dispose();
    };
  }, [url, onFail]);

  const radius = useMemo(() => (scene ? radiusXZ(scene) : 0), [scene]);
  const framing = useMemo(() => computeFraming(aspect, radius), [aspect, radius]);

  useEffect(() => {
    if (!scene) return;
    let vertices = 0;
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) vertices += (o as THREE.Mesh).geometry.attributes.position.count;
    });
    onVertices(vertices);
    reportModel({ url, state: 'ready', readyMs: performance.now(), triangles: triangles(scene), error: null });
    invalidate();
  }, [scene, url, onVertices, invalidate]);

  // The same scroll contract as the procedural scene: follow while the rung
  // allows it, hold the pose once it does not.
  const target = useRef(scroll.current ?? 0);
  useEffect(() => {
    if (!rung.scrollLinkedCamera) return;
    const follow = (p: number) => { target.current = p; };
    follow(scroll.current ?? 0);
    subscribers.add(follow);
    return () => { subscribers.delete(follow); };
  }, [rung.scrollLinkedCamera, scroll, subscribers]);

  const group = useRef<THREE.Group>(null);
  const damped = useRef(target.current);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    damped.current += (target.current - damped.current) * (1 - Math.exp(-6 * dt));
    if (group.current) group.current.rotation.y = -0.35 + damped.current * Math.PI * 0.55;
  });

  return (
    <group ref={group} position={framing.position} scale={framing.scale}>
      {scene && <primitive object={scene} />}
    </group>
  );
}

