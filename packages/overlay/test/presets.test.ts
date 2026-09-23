/**
 * The presets as style and policy — overlays-spec §2, §3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { POLICY, PRESETS, closeButton, drawer, dropdown, popup, type OverlayTheme } from '../src/index.ts';

const t = resolve(THEMES.midnight, 'dark') as unknown as OverlayTheme;
const styles = { dropdown: dropdown(t), drawer: drawer(t, 'Menu'), popup: popup(t, 'Video') };

test('§2: a dropdown does not trap; drawer and popup trap and lock', () => {
  assert.deepEqual(POLICY.dropdown, { focus: 'return', scroll: 'close', modal: false });
  for (const p of ['drawer', 'popup'] as const) assert.deepEqual(POLICY[p], { focus: 'trap', scroll: 'lock', modal: true });
  assert.deepEqual([...PRESETS], Object.keys(styles), 'every preset has a style');
});

test('modal presets carry the runtime mark and a name; the dropdown does not', () => {
  assert.equal(styles.drawer.attrs['data-az-behaviour'], 'dialog');
  assert.equal(styles.drawer.attrs['aria-label'], 'Menu');
  assert.equal(styles.popup.attrs['data-az-overlay'], 'popup');
  assert.equal(styles.dropdown.attrs['data-az-behaviour'], undefined);
});

test('§3: only transform and opacity animate, and the open state carries the enter', () => {
  for (const [name, s] of Object.entries(styles)) {
    for (const tr of [s.style.transition, s.states.open.transition]) {
      // Split between transitions, not inside a cubic-bezier's arguments.
      for (const part of String(tr).split(/,\s*(?=[a-z-]+ \d)/)) {
        assert.match(part.trim(), /^(opacity|transform) /, `${name}: '${part.trim()}' animates something else`);
      }
    }
    assert.equal(s.states.open.transform, 'none', `${name} ends in place`);
  }
});

test('§3: exit is faster than enter', () => {
  const ms = (tr: unknown) => Number(/ (\d+)ms/.exec(String(tr))?.[1]);
  for (const [name, s] of Object.entries(styles)) {
    assert.ok(ms(s.style.transition) < ms(s.states.open.transition), `${name}: exit must be the quicker`);
  }
});

test('no preset sets display — the closed state belongs to the element', () => {
  for (const [name, s] of Object.entries(styles)) {
    assert.equal(s.style.display, undefined, name);
    assert.equal(s.states.open.display, undefined, name);
  }
});

test('the close control is a 44px named button with a focus ring', () => {
  const c = closeButton(t, 'Close menu');
  assert.equal(c.attrs['aria-label'], 'Close menu');
  assert.equal(c.style.minWidth, `${t.size.tap}px`);
  assert.match(String(c.states.focusVisible.outline), /solid/);
});

test('the runtime touches nothing at import: a server render never reaches window', async () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined', 'CONTROL: no DOM here');
  // A computed URL: the root typecheck has no DOM library, and the runtime is
  // checked by packages/overlay/tsconfig.json, which has.
  const runtime = await import(new URL('../src/runtime/behaviours.ts', import.meta.url).href) as { attach: unknown };
  assert.equal(typeof runtime.attach, 'function');
});

test('the runtime imports only its siblings — it is copied alone into each project', () => {
  const dir = fileURLToPath(new URL('../src/runtime/', import.meta.url));
  for (const f of readdirSync(dir)) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^\.\/[a-z-]+\.ts$/, `${f} imports '${m[1]}'`);
    }
  }
});
