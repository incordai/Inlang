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

/** The App's PAGES entry for one route: its layout and where <main> starts. */
function entry(app: string, route: string): { layout?: string; lead: number; tail: number } {
  const start = app.indexOf('= [', app.indexOf('const PAGES')) + 2;
  const pages = JSON.parse(app.slice(start, app.indexOf('\n];', start) + 2)) as
    { route: string; layout?: string; lead: number; tail: number }[];
  return pages.find((p) => p.route === route)!;
}

test('a page with a side nav is laid out as nav column + content column', () => {
  const { app } = files(SIDE);
  assert.equal(entry(app, '/').layout, 'side');
  assert.equal(entry(app, '/').lead, 1, 'the leading node is the nav, before <main>');
  assert.match(app, /<Page route=\{page\.route\} layout=\{page\.layout\}/);
});

test('the grid is the side-nav width beside the content, and stacks below sm', () => {
  const { css } = files(SIDE);
  assert.match(css, /\.az-page\[data-layout="side"\] \{\n  display: grid;\n  grid-template-columns: 256px minmax\(0, 1fr\);/);
  assert.match(css, /@media \(width < 768px\) \{\n  \.az-page\[data-layout="side"\] \{ display: block; \}/);
});

test('CONTROL: a site without a side nav gets neither the layout nor its CSS', () => {
  const { app, css } = files(SIDE.replace('nav side', 'nav bar'));
  assert.equal(entry(app, '/').layout, undefined);
  assert.equal(entry(app, '/').lead, 1, 'the bar nav still leads, before <main>');
  assert.doesNotMatch(css, /data-layout="side"/);
});

test('a protected side page keeps its nav outside <Protected>, so it shows while checking', () => {
  const src = 'az 1\nsite docs\n  auth\n    adapter session\n    protect /api\n  nav side\n    link "API" /api\npage /login\n  auth login\n    alt "Create an account" /signup\npage /signup\n  auth signup\n    terms /terms\npage /terms\npage /api\n  text\n    title "Reference"\n    body "Every call."\n';
  const { app } = files(src);
  assert.match(app, /const PROTECT = new Set<string>\(\[\n  "\/api"\n\]\);/);
  // The nav leads the page, before <main>; <Protected> wraps only <main>'s content.
  assert.equal(entry(app, '/api').lead, 1);
  assert.equal(entry(app, '/api').layout, 'side');
});
