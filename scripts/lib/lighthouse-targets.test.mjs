/**
 * `pnpm test:lighthouse --fail-under`: which scores fail the run. The audits
 * themselves need a browser and run in test:lighthouse; what is judged
 * against what is pure, and tested here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { M5_TARGETS, belowTargets, parseFailUnder } from './lighthouse-targets.mjs';

const perfect = { performance: 100, accessibility: 100, 'best-practices': 100, seo: 100 };
/** A result as lighthouse.mjs records it: the median-perf run's scores, and every run's. */
const site = (name, runs, median = runs[Math.floor((runs.length - 1) / 2)]) => ({ name, scores: median, runs });

test('m5 is the M5 targets: perf 85, a11y 100, best practices 100, SEO 95', () => {
  assert.deepEqual(parseFailUnder('m5'), { performance: 85, accessibility: 100, 'best-practices': 100, seo: 95 });
  assert.deepEqual(parseFailUnder('m5'), { ...M5_TARGETS });
});

test('a list names only the categories it enforces, by their short names', () => {
  assert.deepEqual(parseFailUnder('perf=90,seo=100'), { performance: 90, seo: 100 });
  assert.deepEqual(parseFailUnder('a11y=100, bp=0'), { accessibility: 100, 'best-practices': 0 });
});

test('CONTROL: a malformed, unknown, out-of-range or repeated threshold is refused, naming it', () => {
  assert.throws(() => parseFailUnder(''), /'' is neither/);
  assert.throws(() => parseFailUnder('perf'), /'perf' is neither/);
  assert.throws(() => parseFailUnder('perf=8.5'), /'perf=8.5' is neither/);
  assert.throws(() => parseFailUnder('perf=-1'), /'perf=-1' is neither/);
  assert.throws(() => parseFailUnder('speed=90'), /no category 'speed'/);
  assert.throws(() => parseFailUnder('performance=90'), /no category 'performance'/);
  assert.throws(() => parseFailUnder('seo=101'), /seo=101 — a score is 0–100/);
  assert.throws(() => parseFailUnder('seo=95,seo=90'), /seo given twice/);
});

test('every site at or above every target: nothing is below', () => {
  const edge = { performance: 85, accessibility: 100, 'best-practices': 100, seo: 95 };
  assert.deepEqual(belowTargets([site('a', [perfect, perfect, perfect]), site('b', [edge])], M5_TARGETS), []);
});

test('perf is judged on the median run: one slow run on a loaded machine does not fail it', () => {
  const slow = { ...perfect, performance: 40 };
  assert.deepEqual(belowTargets([site('a', [slow, perfect, perfect], perfect)], M5_TARGETS), []);
});

test('CONTROL: a median perf below target fails, naming the site and score', () => {
  const low = { ...perfect, performance: 84 };
  assert.deepEqual(belowTargets([site('a', [low, low, perfect], low)], M5_TARGETS),
    [{ site: 'a', category: 'performance', score: 84, target: 85, run: null }]);
});

test('CONTROL: SEO, a11y and best practices fail on any run below target, not forgiven by the others', () => {
  const seo90 = { ...perfect, seo: 90 };
  const a11y98 = { ...perfect, accessibility: 98 };
  assert.deepEqual(belowTargets([site('nav', [perfect, seo90, a11y98], perfect)], M5_TARGETS), [
    { site: 'nav', category: 'accessibility', score: 98, target: 100, run: 3 },
    { site: 'nav', category: 'seo', score: 90, target: 95, run: 2 },
  ]);
});

test('CONTROL: an unmeasured (n/a) score is below target, not a pass', () => {
  assert.deepEqual(belowTargets([site('a', [{ ...perfect, seo: null }])], { seo: 95 }),
    [{ site: 'a', category: 'seo', score: null, target: 95, run: 1 }]);
});

test('only the named categories are enforced; a site that was not audited is left to the caller', () => {
  const lowPerf = { ...perfect, performance: 10 };
  assert.deepEqual(belowTargets([site('a', [lowPerf])], { seo: 95 }), []);
  assert.deepEqual(belowTargets([{ name: 'broken', error: 'does not build' }], M5_TARGETS), []);
});
