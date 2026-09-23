/**
 * Author text reaches HTML and JSX with the escaping of the place it lands.
 *
 * `escapeText` is a JS-string escape. Used in HTML (<title>) or in a JSX
 * attribute string it showed its escape codes as text: `Maria's` became
 * `Maria's` in the tab title and in the site's data attributes.
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
const files = (name: string) =>
  emit(compile(`az 1\nsite ${JSON.stringify(name)}\npage /\n`, { manifests }).spec!, { emitters: WEB_EMITTERS });
const file = (name: string, path: string) => files(name).find((f) => f.path === path)!.content;

test('the page title is HTML-escaped, not JS-escaped', () => {
  const html = file("Maria's & Co", 'index.html');
  assert.match(html, /<title>Maria&#39;s &amp; Co<\/title>/);
  assert.doesNotMatch(html, /\\u00/, 'no JS escape codes may reach HTML');
});

test('SECURITY: markup in the site name stays text in the title', () => {
  const html = file('</title><script>alert(1)</script>', 'index.html');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;/);
});

test('JSX attributes carry the name as a JS expression, so escapes are decoded', () => {
  const app = file("Maria's & Co", 'src/App.tsx');
  // A JSX attribute STRING does not process \u escapes; an expression does.
  assert.doesNotMatch(app, /name="[^"]*\\u00/);
  assert.match(app, /name=\{"Maria's \\u0026 Co"\}/);
});

test('CONTROL: a plain name is unchanged in both places', () => {
  assert.match(file('aurora', 'index.html'), /<title>aurora<\/title>/);
  assert.match(file('aurora', 'src/App.tsx'), /name=\{"aurora"\}/);
});

test('package.json carries a valid package name derived from the site name', () => {
  const pkg = JSON.parse(file("Maria's & Co", 'package.json')) as { name: string };
  // npm: lowercase, URL-safe, no spaces or quotes.
  assert.match(pkg.name, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(pkg.name, 'maria-s-co');
});
