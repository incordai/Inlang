/**
 * @az runtime seed
 * Purpose: deterministic randomness: string seeds, PRNG, noise, vertex hashing.
 * Spec: docs/ASSUMPTIONS.md A8b
 * Exports: seedFrom, rng, valueNoise1D, hashFloats
 * Edit guide: no Math.random or ambient input — determinism depends on it.
 * Tests: packages/scene-runtime/test/scene-runtime.test.ts
 */

/**
 * Deterministic pseudo-randomness for procedural geometry.
 *
 * Tests ASSUMPTIONS.md A8b: a seeded generator must be reproducible across
 * builds, runs and engines. That rules out `Math.random()` (unseedable), any
 * ambient input (time, iteration order), and any platform noise implementation
 * whose output may change between browser versions.
 *
 * Everything here is integer-and-float arithmetic defined by this file, so the
 * only cross-engine risk left is IEEE-754 rounding, which is specified.
 */

/** Seed a 32-bit state from a string, so a site name maps to a stable scene. */
export function seedFrom(text: string): number {
  // FNV-1a, 32-bit. Chosen because it is short, well-defined and has no
  // dependency on host hashing (which is not stable across engines).
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 — a small, fast, fully specified PRNG.
 * Returns a function producing floats in [0, 1).
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep-interpolated value noise in 1D. Deterministic by construction. */
export function valueNoise1D(seed: number) {
  const grad = new Float64Array(256);
  const r = rng(seed);
  for (let i = 0; i < 256; i++) grad[i] = r();
  return (x: number): number => {
    const i = Math.floor(x);
    const f = x - i;
    const a = grad[((i % 256) + 256) % 256];
    const b = grad[(((i + 1) % 256) + 256) % 256];
    const t = f * f * (3 - 2 * f); // smoothstep
    return a + (b - a) * t;
  };
}

/**
 * Hash a Float32Array to a hex string.
 *
 * This is the A8b determinism probe: the same `.az` input must yield the same
 * vertex buffer on every engine. Comparing buffers directly is what the test
 * asserts; this collapses one to a comparable token.
 */
export function hashFloats(buf: Float32Array): string {
  // Hash the raw bytes, not the numbers — this catches a differing bit pattern
  // that would print identically at any reasonable decimal precision.
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') +
          (h2 >>> 0).toString(16).padStart(8, '0'));
}
