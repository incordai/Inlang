/**
 * The probe hears about a hidden tab from `visibilitychange` itself — a
 * hidden tab gets no frames, so waiting for the next one would never see it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TierProbe } from '../src/runtime/tiers.ts';

const probe = () => new TierProbe({ rung: 0, ceilingRung: 0, promotable: false });

test('hide() re-takes the drift baseline and drops the interval across the hidden time', () => {
  const p = probe();
  let t = 0;
  for (let i = 0; i < 200; i++) p.sample((t += 16.7), true);
  const before = p.engine.snapshot.outliers;
  p.hide();
  // The first frame after returning comes minutes later: not a frame gap.
  p.sample((t += 120_000), true);
  p.sample((t += 16.7), true);
  assert.equal(p.engine.snapshot.outliers, before, 'the hidden time was never measured as an interval');
});

test('CONTROL: without hide(), the hidden time lands in the probe as one huge interval', () => {
  const p = probe();
  let t = 0;
  for (let i = 0; i < 200; i++) p.sample((t += 16.7), true);
  const before = p.engine.snapshot.outliers;
  p.sample((t += 120_000), true);
  assert.equal(p.engine.snapshot.outliers, before + 1);
});
