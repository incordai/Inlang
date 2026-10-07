/**
 * `description` (site and page) and `icon` (site) — GRAMMAR §4.4.
 *
 * Found by `pnpm test:lighthouse` (ASSUMPTIONS A6, pre-M5): a page with no
 * lead copy had no meta description and nothing the author could write to
 * give it one, and no site could name its icon. Both lines were unknown
 * words (AZ1201) before this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, serialiseSpec, type Manifest } from '../src/index.ts';
import { iconFormat } from '../src/icon.ts';

const manifests = new Map<string, Manifest>();
const ascii = (s: string) => new TextEncoder().encode(s);

/** A PNG's signature and IHDR chunk header — what the sniff reads. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 180, 0, 0, 0, 180]);
const SVG = ascii('<?xml version="1.0"?>\n<!-- mark -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>');
const GIF = ascii('GIF89a\x01\x00\x01\x00');

const site = (settings: string, pages = 'page /\n') => `az 1\nsite aurora\n${settings}${pages}`;
const run = (src: string, readBytes?: (p: string) => Uint8Array | null) => compile(src, { manifests, readBytes });
const codes = (src: string, readBytes?: (p: string) => Uint8Array | null) => run(src, readBytes).diagnostics.map((d) => d.code);
const only = (src: string, code: string, readBytes?: (p: string) => Uint8Array | null) => {
  const r = run(src, readBytes);
  const d = r.diagnostics.find((x) => x.code === code);
  assert.ok(d, `${code} expected: ${JSON.stringify(r.diagnostics)}`);
  return d;
};

/* ---- description --------------------------------------------------------- */

test('a site description and a page description reach the Spec; neither is an unknown word', () => {
  const r = run(site('  description "Handmade shoes, forty pairs a month."\n',
    'page /\npage /work\n  description "Every pair we made this year."\n'));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.spec?.site.description, 'Handmade shoes, forty pairs a month.');
  assert.equal(r.spec?.pages[0].description, undefined);
  assert.equal(r.spec?.pages[1].description, 'Every pair we made this year.');
});

test("a page's description is a setting, not a block it renders", () => {
  const r = run(site('', 'page /\n  description "Only words."\n'));
  assert.deepEqual(r.spec?.pages[0].blocks, []);
});

test('the description is copy as written, its whitespace collapsed to one line', () => {
  const r = run(site('  description "  Two\\nlines,   one   sentence.  "\n'));
  assert.equal(r.spec?.site.description, 'Two lines, one sentence.');
});

test('CONTROL: without description or icon the Spec serialises exactly as before — no new keys', () => {
  const json = serialiseSpec(run(site('')).spec!);
  assert.doesNotMatch(json, /"description"|"icon"/);
});

test('an empty description is AZ1420 — whitespace only is empty too', () => {
  for (const text of ['', '   ']) {
    const d = only(site(`  description "${text}"\n`), 'AZ1420');
    assert.equal(d.severity, 'error');
    assert.match(d.message, /^site: description is empty/);
  }
  assert.match(only(site('', 'page /\n  description ""\n'), 'AZ1420').message, /^page: /);
});

test('an unquoted description is AZ1205 and says to quote it; a missing one is AZ1205', () => {
  assert.match(only(site('  description shoes\n'), 'AZ1205').message, /write it in quotes: description "shoes"/);
  assert.match(only(site('  description\n'), 'AZ1205').message, /has no value/);
});

test('a second value is AZ1406; an indented body is AZ1219', () => {
  assert.ok(codes(site('  description "One." "Two."\n')).includes('AZ1406'));
  assert.ok(codes(site('  description "One."\n    more "x"\n')).includes('AZ1219'));
});

test('over 160 characters is a warning (AZ1409), not an error — the build still stands', () => {
  const long = 'a'.repeat(161);
  const r = run(site(`  description "${long}"\n`));
  const d = r.diagnostics.find((x) => x.code === 'AZ1409');
  assert.equal(d?.severity, 'warning', JSON.stringify(r.diagnostics));
  assert.match(d!.message, /161 characters, 160 is the limit/);
  assert.equal(r.ok, true);
  assert.equal(r.spec?.site.description, long, 'an explicit description is not cut');
});

test('CONTROL: exactly 160 characters, counted as characters not bytes, is silent', () => {
  assert.deepEqual(codes(site(`  description "${'é'.repeat(160)}"\n`)), []);
});

test('a description set twice is AZ1504, at site and at page level', () => {
  assert.ok(codes(site('  description "One."\n  description "Two."\n')).includes('AZ1504'));
  assert.ok(codes(site('', 'page /\n  description "One."\n  description "Two."\n')).includes('AZ1504'));
});

/* ---- icon ---------------------------------------------------------------- */

test('a site icon reaches the Spec as written, and is read through the caller\'s reader', () => {
  const asked: string[] = [];
  const r = run(site('  icon ./brand/icon.svg\n'), (p) => { asked.push(p); return SVG; });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.spec?.site.icon, './brand/icon.svg');
  assert.deepEqual(asked, ['./brand/icon.svg']);
});

test('a PNG icon passes; the content decides, the name must agree', () => {
  assert.deepEqual(codes(site('  icon ./icon.png\n'), () => PNG), []);
});

test('AZ1421: a file that is neither PNG nor SVG, whatever it is named', () => {
  const d = only(site('  icon ./icon.png\n'), 'AZ1421', () => GIF);
  assert.match(d.message, /is not a PNG or an SVG file/);
  assert.equal(d.pos.line, 3, 'reported at the icon line');
});

test('AZ1421: an SVG named .png (or a PNG named .svg) — a host would serve it as the wrong type', () => {
  assert.match(only(site('  icon ./icon.png\n'), 'AZ1421', () => SVG).message, /is an SVG file — name it \.svg/);
  assert.match(only(site('  icon ./icon.svg\n'), 'AZ1421', () => PNG).message, /is a PNG file — name it \.png/);
});

test('AZ1421: a file the reader cannot read (missing, outside the project) is a compile error', () => {
  assert.match(only(site('  icon ./icon.svg\n'), 'AZ1421', () => null).message, /can't be read/);
});

test('CONTROL: without a reader (the Playground) the content is not checked', () => {
  assert.deepEqual(codes(site('  icon ./icon.svg\n')), []);
});

test('SECURITY: a path out of the project is refused at link stage and never read', () => {
  for (const path of ['../../etc/icon.png', './a/../../icon.png']) {
    let read = false;
    const r = run(site(`  icon ${path}\n`), () => { read = true; return PNG; });
    assert.ok(r.diagnostics.some((d) => d.code === 'AZ1210'), `${path}: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(read, false, `${path} must not reach the reader`);
  }
});

test('SECURITY: a URL or an absolute path is not a project file (AZ1402) — the icon ships with the site', () => {
  for (const value of ['https://cdn.example/icon.png', '/etc/icon.png', '"./icon.png"', 'icon.png']) {
    assert.ok(codes(site(`  icon ${value}\n`)).includes('AZ1402'), value);
  }
});

test('an icon that is not .svg or .png by name is AZ1410', () => {
  assert.ok(codes(site('  icon ./icon.ico\n')).includes('AZ1410'));
});

test('an icon under a page is AZ1503 — one icon per site', () => {
  assert.match(only(site('', 'page /\n  icon ./icon.svg\n'), 'AZ1503').message, /move it to site level/);
});

test('icon twice is AZ1504; no value is AZ1205', () => {
  assert.ok(codes(site('  icon ./a.svg\n  icon ./b.svg\n')).includes('AZ1504'));
  assert.ok(codes(site('  icon\n')).includes('AZ1205'));
});

/* ---- the sniff on its own --------------------------------------------- */

test('iconFormat: PNG by signature and IHDR; SVG by its root element past BOM, prolog, comments, doctype', () => {
  assert.equal(iconFormat(PNG), 'png');
  assert.equal(iconFormat(SVG), 'svg');
  assert.equal(iconFormat(ascii('﻿<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg/>')), 'svg');
  assert.equal(iconFormat(ascii('<svg>')), 'svg');
});

test('CONTROL: iconFormat refuses what is only near the shape', () => {
  assert.equal(iconFormat(PNG.subarray(0, 12)), null, 'a truncated PNG');
  assert.equal(iconFormat(Uint8Array.from([...PNG.subarray(0, 12), 0x49, 0x44, 0x41, 0x54])), null, 'no IHDR first');
  assert.equal(iconFormat(ascii('<html><svg></svg></html>')), null, 'an HTML page holding an svg');
  assert.equal(iconFormat(ascii('<svgfoo/>')), null, 'another element');
  assert.equal(iconFormat(ascii('svg')), null);
  assert.equal(iconFormat(GIF), null);
  assert.equal(iconFormat(new Uint8Array()), null);
});
