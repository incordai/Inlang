/**
 * The `from` runtime's decisions (data-spec §10.3, §13), pure, so tested
 * without a browser. The DOM wiring they drive is checked in three browsers
 * by scripts/data-e2e.mjs (`pnpm test:data`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeValue, emptyWithout, markerProp, paragraphs, parseRowsConfig, problemCopy, rowImage, rowSrcset, rowText, safeUrl,
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

test('an empty URL value drops the attribute — it never resolves to the page itself', () => {
  const base = 'https://site.test/board';
  for (const empty of ['', ' ', '\t\n']) assert.equal(safeUrl(empty, base), null, JSON.stringify(empty));
  const valueOf = (p: string) => ({ blank: '   ', ok: 'a.webp' } as Record<string, string>)[p] ?? null;
  // A row without the value: no src, no href — not the page, not the template's remainder.
  assert.equal(attributeValue('src', MARK('missing'), valueOf, base), null);
  assert.equal(attributeValue('href', MARK('missing'), valueOf, base), null);
  assert.equal(attributeValue('src', MARK('blank'), valueOf, base), null);
  assert.equal(attributeValue('href', `/notes/${MARK('missing')}`, valueOf, base), null, 'a partial URL is no URL');
  assert.equal(attributeValue('src', `/media/${MARK('ok')}`, valueOf, base), 'https://site.test/media/a.webp', 'CONTROL: every marker filled');
  assert.equal(attributeValue('alt', MARK('missing'), valueOf, base), '', 'CONTROL: a text attribute may be empty');
});

test('an image without its source is dropped whole; other elements only lose the attribute', () => {
  assert.equal(emptyWithout('IMG', 'src'), true);
  assert.equal(emptyWithout('img', 'SRC'), true);
  assert.equal(emptyWithout('A', 'href'), false, 'CONTROL: a link keeps its text');
  assert.equal(emptyWithout('IMG', 'alt'), false, 'CONTROL: only the source empties an image');
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

test('an image field fills by its URL and size; anything else a server should never send is no image', () => {
  const url = 'https://api.shop.test/data/notes/x/photo?v=1';
  assert.deepEqual(rowImage({ photo: { url, width: 640, height: 480 } }, 'photo'), { url, width: 640, height: 480, variants: [] }, 'a server from before copies sends none');
  assert.deepEqual(rowImage({ photo: { url, width: -1, height: 1.5 } }, 'photo'), { url, width: 0, height: 0, variants: [] }, 'a bad size is no size');
  for (const v of [null, 'https://x.test/a.webp', { url: '' }, { url: 5 }, [url], undefined]) {
    assert.equal(rowImage({ photo: v }, 'photo'), null, JSON.stringify(v));
  }
  assert.equal(rowImage({}, 'photo'), null);
  assert.equal(rowText({ photo: { url, width: 1, height: 1 } }, 'photo'), null, 'CONTROL: an image is never text');
  // The URL still passes the src rule: a javascript: URL from a server is dropped.
  assert.equal(attributeValue('src', MARK('src'), () => rowImage({ p: { url: 'javascript:alert(1)', width: 1, height: 1 } }, 'p')!.url, 'https://shop.test/'), null);
});

test('a row image\'s srcset: its copies then itself, each a safe URL at its width — or none at all', () => {
  const url = 'https://api.shop.test/data/notes/x/photo?v=1';
  const variants = [480, 768, 1200].map((width) => ({ url: `${url}&w=${width}`, width }));
  const image = rowImage({ photo: { url, width: 1600, height: 1000, variants } }, 'photo')!;
  assert.deepEqual(image.variants, variants);
  assert.equal(rowSrcset(image, 'https://shop.test/'), `${url}&w=480 480w, ${url}&w=768 768w, ${url}&w=1200 1200w, ${url} 1600w`);
  // An image stored before copies: no srcset, its src alone (the CONTROL the browser suite also covers).
  assert.equal(rowSrcset(rowImage({ photo: { url, width: 1600, height: 1000, variants: [] } }, 'photo')!, 'https://shop.test/'), null);
  assert.equal(rowSrcset(rowImage({ photo: { url, width: 1600, height: 1000 } }, 'photo')!, 'https://shop.test/'), null);
  // A set the server did not send whole is no set: one bad copy drops it all.
  const bad = (vs: unknown[], width = 1600) => rowSrcset(rowImage({ photo: { url, width, height: 1000, variants: vs } }, 'photo')!, 'https://shop.test/');
  assert.equal(bad([{ url: 'javascript:alert(1)', width: 480 }]), null, 'a script URL');
  assert.equal(bad([{ url: `${url}&w=768`, width: 768 }, { url: `${url}&w=480`, width: 480 }]), null, 'out of order');
  assert.equal(bad([{ url: `${url}&w=1200`, width: 1200 }], 1000), null, 'wider than the image: never an upscale');
  assert.equal(bad(variants, 0), null, 'an image of unknown width');
  assert.equal(rowSrcset({ url: 'javascript:x', width: 1600, height: 1000, variants }, 'https://shop.test/'), null, 'the image itself unsafe');
  // Copies that are not a URL and a width are not copies.
  assert.deepEqual(rowImage({ photo: { url, width: 1600, height: 1000, variants: [{ url: 5, width: 480 }, { url, width: -1 }, 'x', null] } }, 'photo')!.variants, []);
  assert.equal(attributeValue('srcset', MARK('src'), () => url, 'https://shop.test/'), null, 'CONTROL: a template marker never fills srcset');
});
