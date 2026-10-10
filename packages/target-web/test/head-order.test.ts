/**
 * Head order (head-order.ts): a built page links its stylesheets before any
 * script, so a module script never runs against the unstyled page.
 * scripts/verify-build.mjs checks the same order on every page a real build ships.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stylesFirst } from '../src/head-order.ts';

/** The head the bundler writes: its entry script, a preload, then the stylesheet. */
const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
    <title>Site</title>
    <script type="module" crossorigin src="./assets/main.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/chunk.js">
    <link rel="stylesheet" crossorigin href="./assets/main.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

test('a stylesheet after the entry script moves to just before it, on its own line, after the policy', () => {
  assert.equal(stylesFirst(BUILT), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
    <title>Site</title>
    <link rel="stylesheet" crossorigin href="./assets/main.css">
    <script type="module" crossorigin src="./assets/main.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/chunk.js">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`);
});

test('several stylesheets keep their order; a rel token list and any case count', () => {
  const html = '<head><script src="a.js"></script><link rel="stylesheet" href="1.css"><link REL="Alternate StyleSheet" href="2.css"></head>';
  assert.equal(stylesFirst(html),
    '<head><link rel="stylesheet" href="1.css"><link REL="Alternate StyleSheet" href="2.css"><script src="a.js"></script></head>');
});

test('a page already in order, or with no script, is returned as it is', () => {
  const ordered = stylesFirst(BUILT);
  assert.equal(stylesFirst(ordered), ordered);
  const none = '<head><link rel="stylesheet" href="a.css"></head><body><p>x</p></body>';
  assert.equal(stylesFirst(none), none);
});

test('only the head is reordered: a stylesheet in the body stays where it is', () => {
  const html = '<head><script src="a.js"></script></head><body><link rel="stylesheet" href="late.css"></body>';
  assert.equal(stylesFirst(html), html);
});

test('a `<link` inside a script\'s text is not a stylesheet', () => {
  const html = '<head><script>const t = \'<link rel="stylesheet" href="x.css">\';</script></head>';
  assert.equal(stylesFirst(html), html);
});

test('ordering is idempotent and loses no markup', () => {
  const once = stylesFirst(BUILT);
  const sorted = (s: string) => [...s.replace(/\s/g, '')].sort().join('');
  assert.equal(sorted(once), sorted(BUILT));
  assert.equal(stylesFirst(once), once);
});
