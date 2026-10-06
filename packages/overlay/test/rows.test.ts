/**
 * The `from` runtime's decisions (data-spec §10.3, §13), pure, so tested
 * without a browser. The DOM wiring they drive is checked in three browsers
 * by scripts/data-e2e.mjs (`pnpm test:data`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeValue, markerProp, paragraphs, parseRowsConfig, problemCopy, rowText, safeUrl,
} from '../src/runtime/rows-logic.ts';

const MARK = (prop: string) => `\u{E000}${prop}\u{E000}`;
const CONFIG = {
  table: 'notes', label: 'title', query: { limit: 6, sort: '-created', mine: true, status: 'live' },
  map: { text: 'body', title: 'title' }, types: { text: 'longtext', title: 'text' }, empty: 'No notes yet',
};

test('the config the emitter writes parses; anything else is refused, not guessed at', () => {
  assert.deepEqual(parseRowsConfig(JSON.stringify(CONFIG)), CONFIG);
  assert.deepEqual(parseRowsConfig(JSON.stringify({ ...CONFIG, label: null })), { ...CONFIG, label: null });
  for (const bad of [
    null, '', '{', '[]', JSON.stringify({ ...CONFIG, table: 'Notes; drop' }),
    JSON.stringify({ ...CONFIG, map: { title: '../x' } }),
    JSON.stringify({ ...CONFIG, map: [] }),
    JSON.stringify({ ...CONFIG, query: { limit: { $gt: 1 } } }),
    JSON.stringify({ ...CONFIG, query: { 'a.b': 1 } }),
    JSON.stringify({ ...CONFIG, label: 'nope' }),
    JSON.stringify({ ...CONFIG, empty: 3 }),
  ]) {
    assert.equal(parseRowsConfig(bad), null, String(bad));
  }
});

test('a row value is text only when it is a plain value', () => {
  const row = { title: 'Hello', n: 3, yes: true, empty: '', none: null, obj: { a: 1 }, list: ['a'] };
  assert.equal(rowText(row, 'title'), 'Hello');
  assert.equal(rowText(row, 'n'), '3');
  assert.equal(rowText(row, 'yes'), 'Yes');
  for (const k of ['empty', 'none', 'obj', 'list', 'missing']) assert.equal(rowText(row, k), null, k);
  assert.equal(rowText(null, 'title'), null);
  assert.equal(rowText(Object.create({ title: 'inherited' }), 'title'), null, 'own fields only');
  assert.equal(rowText({ title: '<b>x</b>' }, 'title'), '<b>x</b>', 'markup is returned as the text it is');
});

test('a URL from a row is http(s) or nothing — after the browser\'s own normalisation', () => {
  const base = 'https://site.test/board';
  assert.equal(safeUrl('https://cdn.test/a.webp', base), 'https://cdn.test/a.webp');
  assert.equal(safeUrl('/uploads/a.webp', base), 'https://site.test/uploads/a.webp');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)',
    'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://site.test/x']) {
    assert.equal(safeUrl(bad, base), null, bad);
  }
});

test('a template attribute takes a row value as text; URL attributes only a safe URL; handlers never', () => {
  const valueOf = (p: string) => ({ alt: 'A "quoted" <alt>', src: 'javascript:alert(1)', ok: '/a.webp' } as Record<string, string>)[p] ?? null;
  const base = 'https://site.test/';
  assert.equal(attributeValue('alt', MARK('alt'), valueOf, base), 'A "quoted" <alt>');
  assert.equal(attributeValue('src', MARK('src'), valueOf, base), null);
  assert.equal(attributeValue('SRC', MARK('ok'), valueOf, base), 'https://site.test/a.webp');
  assert.equal(attributeValue('href', MARK('src'), valueOf, base), null);
  assert.equal(attributeValue('onclick', MARK('alt'), valueOf, base), null);
  assert.equal(attributeValue('style', MARK('alt'), valueOf, base), null);
  assert.equal(attributeValue('srcset', MARK('ok'), valueOf, base), null);
  assert.equal(attributeValue('aria-label', `See ${MARK('missing')}`, valueOf, base), 'See ');
});

test('a longtext is paragraphs of lines; blank lines split, single newlines break', () => {
  assert.deepEqual(paragraphs('One.\n\nTwo,\nthree.'), [['One.'], ['Two,', 'three.']]);
  assert.deepEqual(paragraphs('a\r\n\r\n\r\nb'), [['a'], ['b']]);
  assert.deepEqual(paragraphs('\n\n  \n'), []);
  assert.deepEqual(paragraphs('<p>x</p>'), [['<p>x</p>']], 'never parsed');
});

test('the error copy: its own line for rate limits and the network, one line for the rest', () => {
  assert.match(problemCopy('rate_limited'), /^Too many requests/);
  assert.match(problemCopy('unknown'), /connection/);
  assert.equal(problemCopy('forbidden'), problemCopy('bad_query'), 'the reason stays in the server\'s logs');
  assert.notEqual(problemCopy('forbidden'), problemCopy('unknown'));
});

test('a marker is exactly one prop between the private-use marks', () => {
  assert.equal(markerProp(MARK('title')), 'title');
  assert.equal(markerProp(` ${MARK('title')}`), null);
  assert.equal(markerProp(`${MARK('title')}${MARK('text')}`), null);
  assert.equal(markerProp('title'), null);
  assert.equal(markerProp(MARK('Title')), null);
});
