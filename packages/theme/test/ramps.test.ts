/**
 * The accent ramps are GENERATED data — PRD §6.1a, theme-spec §4.
 *
 * ramps.ts may hold raw colours only because it is the generator's output
 * (scope.test exempts it as theme data). This test is what makes that safe:
 * the committed file must equal a fresh run, byte for byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HUES, STEPS, rampsSource } from '../../../scripts/gen-ramps.mjs';
import { ACCENT_RAMPS, RAMP_STEPS } from '../src/ramps.ts';
import { luminance, rgbOf } from '../src/color.ts';

const FILE = fileURLToPath(new URL('../src/ramps.ts', import.meta.url));

test('ramps.ts is exactly the generator output — no hand edits', () => {
  assert.equal(readFileSync(FILE, 'utf8'), rampsSource(),
    'regenerate with: node scripts/gen-ramps.mjs');
});

test('every hue has every step, in the generator order', () => {
  assert.deepEqual(Object.keys(ACCENT_RAMPS), Object.keys(HUES));
  assert.deepEqual([...RAMP_STEPS], [...STEPS]);
});

test('each ramp darkens monotonically, so a step means one lightness for every hue', () => {
  for (const [name, steps] of Object.entries(ACCENT_RAMPS)) {
    const l = RAMP_STEPS.map((s) => luminance(rgbOf((steps as Record<number, string>)[s])));
    for (let i = 1; i < l.length; i++) {
      assert.ok(l[i] < l[i - 1], `${name} ${RAMP_STEPS[i]} is not darker than ${RAMP_STEPS[i - 1]}`);
    }
  }
});

test('CONTROL: a changed hue makes the comparison fail', () => {
  const tampered = rampsSource().replace(/hsl\(([\d.]+) /, (_m, h) => `hsl(${Number(h) + 1} `);
  assert.notEqual(tampered, readFileSync(FILE, 'utf8'));
});
