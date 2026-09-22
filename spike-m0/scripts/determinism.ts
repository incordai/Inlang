/**
 * A8b probe: is the seeded generator reproducible?
 *
 * ROADMAP.md M0 exit criterion — "identical vertex-buffer hash across two
 * builds, two runs and two browser engines". This script covers the RUNS axis
 * headlessly and is the control for the other two: if the hash is unstable
 * within one process, nothing downstream is worth measuring.
 *
 * Run: pnpm test:determinism
 */

import { buildStrands, disposeStrands } from '../src/geometry.ts';
import { seedFrom, rng } from '../src/seed.ts';
import { fitsInFrame, computeFraming } from '../src/framing.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log('\nA8b — seeded generator reproducibility\n');

/* 1. The PRNG itself. If this drifts, everything above it drifts. */
const a = Array.from({ length: 5 }, rng(12345));
const b = Array.from({ length: 5 }, rng(12345));
check('same seed → same PRNG stream', JSON.stringify(a) === JSON.stringify(b));
const c = Array.from({ length: 5 }, rng(12346));
check('different seed → different stream', JSON.stringify(a) !== JSON.stringify(c));

/* 2. String seeding must be stable and must actually discriminate. */
check('seedFrom stable', seedFrom('aurora') === seedFrom('aurora'));
check('seedFrom discriminates', seedFrom('aurora') !== seedFrom('aurors'));

/* 3. The real assertion: identical geometry across repeated builds. */
const runs = Array.from({ length: 3 }, () => buildStrands({ seed: 0x415a }));
const hashes = runs.map((r) => r.hash);
check('3 builds → identical vertex hash', new Set(hashes).size === 1, hashes[0]);
check('vertex count stable', new Set(runs.map((r) => r.vertexCount)).size === 1,
      `${runs[0].vertexCount} vertices`);

/* 4. CONTROL — the test must be able to FAIL. A hash that never changes
      would pass clause 3 even if the generator ignored its seed entirely. */
const other = buildStrands({ seed: 0x415b });
check('CONTROL: a different seed changes the hash', other.hash !== hashes[0],
      `${hashes[0]} vs ${other.hash}`);

/* 5. Parameters must affect output, or "deterministic" is just "constant". */
const denser = buildStrands({ seed: 0x415a, strands: 9 });
check('CONTROL: fewer strands changes the hash', denser.hash !== hashes[0]);

runs.forEach(disposeStrands);
disposeStrands(other);
disposeStrands(denser);

/* 6. FRAMING — the bug two screenshots caught and zero assertions did.
      The group rotates on Y, so the footprint is the swept disc, not the
      bounding box. Sizing against the box cropped the object at the frame
      edge. This asserts the real radius fits at the widest aspect we ship. */
{
  const built = buildStrands({ seed: 0x415a, strands: 16 });
  let maxR = 0;
  for (const g of built.geometries) {
    const pos = g.attributes.position.array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      const r = Math.hypot(pos[i], pos[i + 2]);
      if (r > maxR) maxR = r;
    }
  }
  // Every aspect we could plausibly be viewed at, including portrait phone.
  for (const aspect of [21 / 9, 16 / 9, 16 / 10, 4 / 3, 1.0, 390 / 844]) {
    const fr = computeFraming(aspect, maxR);
    const f = fitsInFrame(maxR, aspect, { position: fr.position, scale: fr.scale });
    check(`object stays in frame at aspect ${aspect.toFixed(2)}`, f.fits,
          `scale=${fr.scale.toFixed(2)}${fr.clamped ? ' (clamped)' : ''}, right=${f.right.toFixed(2)} vs halfW=${f.halfW.toFixed(2)}`);
  }

  /* CONTROL: a scale that genuinely overflows must be reported as not fitting,
     or the check above is inert. */
  const bad = fitsInFrame(maxR, 16 / 9, { position: [1.43, -0.24, -0.17], scale: 1.6 });
  check('CONTROL: an oversized scale is reported as NOT fitting', !bad.fits,
        `right=${bad.right.toFixed(2)} vs halfW=${bad.halfW.toFixed(2)}`);
  disposeStrands(built);
}

/* 7. RESTACK — hero-spec §10 and §8 together. On narrow viewports the object
      must move BELOW the copy, not sit behind it. Centring it vertically put
      the vines straight through the paragraph on a phone; a screenshot caught
      that, nothing else did. */
{
  const built = buildStrands({ seed: 0x415a, strands: 16 });
  const phone = computeFraming(390 / 844, built.radiusXZ);
  const desktop = computeFraming(1440 / 900, built.radiusXZ);

  check('narrow viewport restacks (object pushed below the copy)',
        phone.restacked && phone.position[1] < -0.5,
        `phone y=${phone.position[1].toFixed(2)}, restacked=${phone.restacked}`);
  check('narrow viewport centres the object horizontally',
        Math.abs(phone.position[0]) < 0.01, `x=${phone.position[0].toFixed(2)}`);
  check('CONTROL: wide viewport does NOT restack, keeps the object beside text',
        !desktop.restacked && desktop.position[0] > 1.0,
        `desktop x=${desktop.position[0].toFixed(2)}, y=${desktop.position[1].toFixed(2)}`);
  disposeStrands(built);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
