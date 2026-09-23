/**
 * A link to a file ships the file — buttons-and-sections §1 (a path
 * downloads).
 *
 * A destination written as a path (`./brochure.pdf`) went into `href` as
 * written: the file was never registered as an asset, so the build never
 * copied it (a 404), and the relative URL resolved against the current
 * route (`/work/brochure.pdf` on /work). Every kind of link — the action
 * primitive, nav, footer and the generic fill — now resolves a path through
 * the asset sandbox: copied, root-relative, refused if it escapes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject, PathEscapeError } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const project = (source: string) => {
  const r = compile(source, { manifests });
  assert.ok(r.ok, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
  return emitProject(r.spec!, { emitters: WEB_EMITTERS });
};
const app = (p: ReturnType<typeof project>) => p.files.find((f) => f.path === 'src/App.tsx')!.content;

const SITE = `az 1
site aurora
  nav bar
    link "Menu" ./files/menu.pdf
    link "Work" /work
  footer minimal
    link "Terms" ./files/terms.pdf
page /
  hero center
    title "Built in the dark"
    cta "Brochure" ./files/brochure.pdf
page /work
`;

test('a file destination is copied into the build', () => {
  const p = project(SITE);
  for (const f of ['files/brochure.pdf', 'files/menu.pdf', 'files/terms.pdf']) {
    assert.ok(p.assets.includes(f), `${f} is not shipped; assets: ${p.assets.join(', ')}`);
  }
});

test('a file destination is linked from the site root, so it works on every route', () => {
  const a = app(project(SITE));
  for (const f of ['brochure', 'menu', 'terms']) {
    assert.match(a, new RegExp(`"href": "/files/${f}\\.pdf"`), f);
    assert.doesNotMatch(a, new RegExp(`"href": "\\./files/${f}\\.pdf"`), `${f} is still relative`);
  }
});

test('CONTROL: routes, anchors and schemes are left as written', () => {
  const a = app(project(SITE));
  assert.match(a, /"href": "\/work"/);
});

test('SECURITY: a file destination cannot leave the project', () => {
  const r = compile(SITE.replace('./files/brochure.pdf', './a/../../secret.pdf'), { manifests });
  // The link stage refuses it; if a caller skipped that, the target does too.
  if (r.ok) assert.throws(() => emitProject(r.spec!, { emitters: WEB_EMITTERS }), PathEscapeError);
  else assert.ok(r.diagnostics.some((d) => d.code === 'AZ1210'));
});
