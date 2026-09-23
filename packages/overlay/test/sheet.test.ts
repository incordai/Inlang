/**
 * nav-spec §6's other two mobile menus — `sheet` (overlays-spec §2, §3) and
 * `full` — as presets, policy, the sheet's spring and its drag threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, PRESETS, full, sheet, springEasing } from '../src/index.ts';
import { SHEET_DRAG_MIN, sheetDismissed } from '../src/runtime/logic.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';

const theme = resolve(THEMES.midnight, 'dark') as unknown as Parameters<typeof sheet>[0];

test('sheet and full are modal presets that trap focus and lock the page', () => {
  for (const p of ['sheet', 'full'] as const) {
    assert.ok((PRESETS as readonly string[]).includes(p));
    assert.deepEqual(POLICY[p], { focus: 'trap', scroll: 'lock', modal: true });
  }
});

test('sheet rises from the bottom edge: translateY(100%) → none on a spring', () => {
  const s = sheet(theme, 'Menu');
  assert.equal(s.attrs['data-az-overlay'], 'sheet');
  assert.equal(s.attrs['data-az-behaviour'], 'dialog');
  assert.equal(s.style.insetBlockEnd, 0);
  assert.equal(s.style.transform, 'translateY(100%)');
  assert.equal(s.states.open.transform, 'none');
  assert.match(String(s.states.open.transition), /^transform 280ms linear\(0, /);
});

test('full covers the screen and fades', () => {
  const f = full(theme, 'Menu');
  assert.equal(f.attrs['data-az-overlay'], 'full');
  assert.equal(f.style.inset, 0);
  assert.equal(f.style.opacity, 0);
  assert.equal(f.states.open.opacity, 1);
});

test('theme-spec §9.2: the spring settles within 2% inside the 280ms budget', () => {
  const values = springEasing(300, 30, 1, 280, 56).slice('linear('.length, -1).split(', ').map(Number);
  assert.equal(values[0], 0);
  assert.equal(values.at(-1), 1);
  // ζ ≈ 0.87: its 0.43% overshoot peaks near 363ms, after the budget, so the
  // curve never exceeds 1 here; by 267ms (≈95%) it is within 2% and stays.
  assert.ok(Math.max(...values) <= 1);
  const late = values.slice(Math.floor(values.length * 0.95));
  assert.ok(late.every((v) => Math.abs(1 - v) < 0.02), `late samples ${late}`);
  // The landing on 1 is a sub-1% step, not a visible jump.
  assert.ok(1 - values.at(-2)! < 0.01);
});

test('DETERMINISM: the same spring is the same curve', () => {
  assert.equal(springEasing(300, 30, 1, 280), springEasing(300, 30, 1, 280));
});

test('a drag dismisses past a quarter of the height or 96px, whichever is larger', () => {
  assert.equal(sheetDismissed(SHEET_DRAG_MIN - 1, 200), false);
  assert.equal(sheetDismissed(SHEET_DRAG_MIN, 200), true);
  assert.equal(sheetDismissed(150, 800), false, 'a tall sheet needs 200px');
  assert.equal(sheetDismissed(200, 800), true);
});
