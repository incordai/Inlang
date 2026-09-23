/**
 * The nav sits before <main> and the footer after it, whatever their form —
 * nav-spec §7 (the skip link targets <main> and must skip the nav) and the
 * footer's contentinfo landmark, which exists only outside <main>.
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

function home(nav: string) {
  const src = `az 1\nsite aurora\n  nav ${nav}\n    link "Work" /work\n  footer minimal\n    link "Terms" /terms\npage /\n  hero center\n    title "x"\npage /work\npage /terms\n`;
  const r = compile(src, { manifests });
  assert.ok(r.spec, JSON.stringify(r.diagnostics));
  const app = emit(r.spec, { emitters: WEB_EMITTERS }).find((f) => f.path === 'src/App.tsx')!.content;
  const start = app.indexOf('= [', app.indexOf('const PAGES')) + 2;
  const pages = JSON.parse(app.slice(start, app.indexOf('\n];', start) + 2)) as { route: string; lead: number; tail: number }[];
  return { app, page: pages.find((p) => p.route === '/')! };
}

for (const nav of ['bar', 'bar sticky', 'bar hide', 'bar shrink', 'bar solid', 'side', 'split sticky solid']) {
  test(`nav ${nav}: the nav leads, before <main>; the footer trails, after it`, () => {
    const { page } = home(nav);
    assert.equal(page.lead, 1, 'the nav is the one node before <main>');
    assert.equal(page.tail, 1, 'the footer is the one node after </main>');
  });
}

test('Page renders lead, then <main id="az-content">, then tail', () => {
  const runtime = readFileSync(new URL('../src/emit.ts', import.meta.url), 'utf8');
  assert.match(runtime, /\{lead\}\s*<main id="az-content" tabIndex=\{-1\} className="az-main">\{children\}<\/main>\s*\{tail\}/);
});
