/**
 * The surface. This is where "expensive" actually comes from.
 *
 * Built to the recipe measured in docs/3d-technique-reference.md §1: a physical
 * material with a clearcoat over a low roughness, lit by an environment. The
 * earlier spike used a flat Lambert ShaderMaterial with no environment at all,
 * which is why it read as noise rather than as a product render.
 *
 * The growth reveal is injected into the STOCK material via onBeforeCompile
 * rather than replacing it — §3's technique. Writing our own ShaderMaterial
 * would mean reimplementing clearcoat, IBL and tone mapping by hand, which is
 * exactly the trade that made the first attempt look cheap.
 */

import * as THREE from 'three';
import type { Tier } from './tiers.ts';

export interface GrowthUniforms {
  uGrowth: { value: number };
  uSpread: { value: number };
  uTipMix: { value: number };
}

/** Per-tier surface settings. Roughness contrast is what reads as material
 *  variety — not colour (3d-technique-reference §1). */
const SURFACE: Record<Tier, {
  roughness: number; clearcoat: number; clearcoatRoughness: number; envMapIntensity: number;
}> = {
  full:   { roughness: 0.18, clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.4 },
  // `lite` drops the clearcoat pass, the single most expensive term here.
  lite:   { roughness: 0.42, clearcoat: 0.0, clearcoatRoughness: 0.0,  envMapIntensity: 1.0 },
  static: { roughness: 0.9,  clearcoat: 0.0, clearcoatRoughness: 0.0,  envMapIntensity: 0.0 },
};

export function createStrandMaterial(tier: Tier): {
  material: THREE.MeshPhysicalMaterial;
  uniforms: GrowthUniforms;
} {
  const s = SURFACE[tier];
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#6f8f3a').convertSRGBToLinear(),
    roughness: s.roughness,
    metalness: 0,
    clearcoat: s.clearcoat,
    clearcoatRoughness: s.clearcoatRoughness,
    envMapIntensity: s.envMapIntensity,
    side: THREE.DoubleSide,
  });

  const uniforms: GrowthUniforms = {
    uGrowth: { value: 0.15 },
    uSpread: { value: 0.55 },
    uTipMix: { value: 1.0 },
  };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrowth = uniforms.uGrowth;
    shader.uniforms.uSpread = uniforms.uSpread;
    shader.uniforms.uTipMix = uniforms.uTipMix;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying float vT;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vT = uv.x;`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uGrowth;
         uniform float uSpread;
         uniform float uTipMix;
         varying float vT;
         // Deterministic hash noise, defined here rather than taken from the
         // platform so it cannot change between browser versions (A8b).
         float az_hash11(float p) {
           p = fract(p * 0.1031);
           p *= p + 33.33;
           p *= p + p;
           return fract(p);
         }
         // SMOOTH value noise. A raw hash sampled per fragment makes adjacent
         // fragments alternate discard/keep, which stipples the surface instead
         // of producing a growth front. Interpolating between lattice points at
         // LOW frequency is what makes the edge read as organic.
         float az_vnoise(float x) {
           float i = floor(x);
           float f = fract(x);
           f = f * f * (3.0 - 2.0 * f);
           return mix(az_hash11(i), az_hash11(i + 1.0), f);
         }`,
      )
      // clipping_planes_fragment is the first thing in main(), so the discard
      // happens before any lighting work is done for a fragment we throw away.
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         float az_n = az_vnoise(vT * 3.5) * 0.68 + az_vnoise(vT * 8.0) * 0.32;
         float az_cov = uGrowth * (1.0 + uSpread) - az_n * uSpread - vT;
         if (az_cov <= 0.02) discard;`,
      )
      // Tip lightening: the growing end catches more light, which is what makes
      // it read as growth rather than as a wipe.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.9 + 0.06,
                                smoothstep(0.30, 1.0, vT) * uTipMix);`,
      );
  };

  // Stable cache key so three does not recompile the program per material
  // instance — 3d-technique-reference §6 lists this among the guards that are
  // invisible until absent.
  material.customProgramCacheKey = () => `az-strand-${tier}`;

  return { material, uniforms };
}
