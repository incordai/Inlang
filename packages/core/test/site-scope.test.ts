/**
 * Site-scoped props reach every instance of their word — auth-spec §2.
 *
 * `adapter` is declared once, on the site-level `auth`, and is refused at
 * page level (AZ1304). The site-level `auth` is not an inherited block, so
 * before this the Spec dropped it and a page's `auth login` never learned its
 * adapter — the form fell back to `custom` on every page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, formatDiagnostics, type Manifest, type Spec } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const site = (adapter: string) =>
  `az 1\nsite aurora\n  auth\n    adapter ${adapter}\npage /\npage /login\n  auth login\n`;

function loginAuth(src: string) {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const spec = r.spec as Spec;
  const page = spec.pages.find((p) => p.route === '/login');
  const auth = page?.blocks.find((b) => b.word === 'auth');
  assert.ok(auth, 'CONTROL: the login page has its auth block');
  return auth;
}

test('a page-level auth carries the adapter declared at site level', () => {
  assert.equal(loginAuth(site('azbackend')).props.adapter, 'azbackend');
});

test('CONTROL: the value follows the site declaration, not a constant', () => {
  assert.equal(loginAuth(site('hosted')).props.adapter, 'hosted');
});

test('the page keeps its own props alongside the inherited one', () => {
  const auth = loginAuth(site('session'));
  assert.equal(auth.variant, 'login');
  assert.equal(auth.props.methods, 'password', 'manifest defaults still apply');
});

test('CONTROL: a word with no site-scoped props gains nothing', () => {
  const r = compile('az 1\nsite aurora\n  auth\n    adapter session\npage /\n  hero center\n    title "x"\n',
    { manifests });
  assert.ok(r.spec);
  const hero = r.spec.pages[0].blocks.find((b) => b.word === 'hero');
  assert.ok(hero && !('adapter' in hero.props));
});
