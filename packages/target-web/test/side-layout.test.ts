/**
 * nav-block-spec §10 Q2, resolved: `side` is a PAGE layout — the page's
 * content sits in a column beside the nav column, not below it.
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
  return { app: file('src/App.tsx'), css: file('src/theme.css') };
}

const SIDE = 'az 1\nsite docs\n  nav side\n    link "Guide" /guide\n    link "API" /api\npage /\n  text\n    title "Getting started"\n    body "Install, then build."\npage /guide\npage /api\n';

test('a page with a side nav is laid out as nav column + content column', () => {
  const { app } = files(SIDE);
  assert.match(app, /const SIDE: Record<string, number> = \{/);
  assert.match(app, /"\/": 1/, 'the leading node is the nav');
  assert.match(app, /<Page route=\{page\.route\} layout="side">/);
  assert.match(app, /<div className="az-layout-content">/);
});

test('the grid is the side-nav width beside the content, and stacks below sm', () => {
  const { css } = files(SIDE);
  assert.match(css, /\.az-page\[data-layout="side"\] \{\n  display: grid;\n  grid-template-columns: 256px minmax\(0, 1fr\);/);
  assert.match(css, /@media \(width < 768px\) \{\n  \.az-page\[data-layout="side"\] \{ display: block; \}/);
});

test('CONTROL: a site without a side nav gets neither the layout nor its CSS', () => {
  const { app, css } = files(SIDE.replace('nav side', 'nav bar'));
  assert.doesNotMatch(app, /SIDE|layout="side"|az-layout-content/);
  assert.doesNotMatch(css, /data-layout="side"/);
});

test('a protected side page keeps its nav outside <Protected>, so it shows while checking', () => {
  const src = 'az 1\nsite docs\n  auth\n    adapter session\n    protect /api\n  nav side\n    link "API" /api\npage /login\n  auth login\n    alt "Create an account" /signup\npage /signup\n  auth signup\n    terms /terms\npage /terms\npage /api\n  text\n    title "Reference"\n    body "Every call."\n';
  const { app } = files(src);
  assert.match(app, /const PROTECT: Record<string, number> = \{\n?\s*"\/api": 0/);
  assert.match(app, /"\/api": 1/, 'the nav is the side lead');
});
