/**
 * scene-spec §6.5 — a block with no surface of its own resolves one over a
 * page's backdrop: the veil, `color.veil`, under the `overBackdrop` state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

function files(src: string) {
  const r = compile(src, { manifests });
  assert.ok(r.spec, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  const out = emit(r.spec, { emitters: WEB_EMITTERS });
  const file = (p: string) => out.find((f) => f.path === p)!.content;
  return { az: file('src/az.css'), theme: file('src/theme.css'), app: file('src/App.tsx') };
}

const PAGE = (hero: string) => `az 1\nsite aurora\n  scene backdrop 3d\n    poster ./fog.webp\n    alt "Slow fog"\npage /\n  hero ${hero}\n    title "Built in the dark"\n  text\n    title "The studio"\n    body "Two people, one room."\n`;

/** The class of the first element carrying `cls`, from the emitted page data. */
function generatedClass(app: string, cls: string): string {
  const m = new RegExp(`"class": "(?:[^"]* )?${cls}(?: [^"]*)? (az-s-[a-z0-9]+)"|"class": "(az-s-[a-z0-9]+) (?:[^"]* )?${cls}(?: [^"]*)?"`).exec(app)
    ?? new RegExp(`"class": "[^"]*\\b${cls}\\b[^"]*"`).exec(app);
  assert.ok(m, `no element with ${cls}`);
  const found = /az-s-[a-z0-9]+/.exec(m[0]);
  assert.ok(found, `${cls} has no generated class`);
  return found[0];
}

const VEIL_RULE = (cls: string) =>
  new RegExp(`\\.az-page:has\\(\\[data-az-3d\\]\\[data-az-variant="backdrop"\\]\\) \\.${cls} \\{[^}]*background: var\\(--az-color-veil\\)`);

test('the theme defines the veil once, on the page background, at the tested percent', () => {
  const { theme } = files(PAGE('center'));
  assert.match(theme, /--az-color-veil: color-mix\(in srgb, var\(--az-color-bg\) 92%, transparent\)/);
  assert.equal((theme.match(/--az-color-veil:/g) ?? []).length, 1);
});

test('over a backdrop, the hero and the text block take the veil', () => {
  const { az, app } = files(PAGE('center'));
  assert.match(az, VEIL_RULE(generatedClass(app, 'az-hero')));
  assert.match(az, VEIL_RULE(generatedClass(app, 'az-text')));
});

test('CONTROL: a `full` hero is already on its scrim and takes no veil', () => {
  const { az, app } = files(PAGE('full'));
  assert.doesNotMatch(az, VEIL_RULE(generatedClass(app, 'az-hero')));
});
