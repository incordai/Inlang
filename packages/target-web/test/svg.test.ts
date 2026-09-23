/**
 * Inline SVG sanitising — feature-block-spec §7. Hostile files first: the
 * sanitiser's job is to make an author's icon safe to put in the page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmittedNode } from '../../core/src/emit-contract.ts';
import { renderNode } from '../src/render.ts';
import { MAX_SVG_BYTES, SvgError, sanitizeSvg } from '../src/svg.ts';

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const tags = (n: EmittedNode) => walk(n).map((x) => x.tag);
const html = (source: string) => renderNode(sanitizeSvg(source, './icon.svg'));

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" stroke-width="2"><path d="M4 12h16"/><circle cx="12" cy="12" r="3" fill="#ff0000"/></svg>';

test('a plain icon keeps its shapes, loses its size, is decorative, and takes currentColor', () => {
  const svg = sanitizeSvg(ICON, './icon.svg');
  assert.deepEqual(tags(svg), ['svg', 'path', 'circle']);
  assert.equal(svg.attrs?.viewBox, '0 0 24 24');
  assert.equal(svg.attrs?.width, undefined, '§7: width/height come off');
  assert.equal(svg.attrs?.height, undefined);
  assert.equal(svg.attrs?.['aria-hidden'], 'true');
  assert.equal(svg.attrs?.focusable, 'false');
  assert.equal(svg.attrs?.fill, 'none', '`none` is kept — it is not a colour');
  assert.equal(svg.attrs?.stroke, 'currentColor', 'a hard-coded stroke becomes the theme colour');
  assert.equal(walk(svg)[2].attrs?.fill, 'currentColor');
  assert.equal(walk(svg)[1].attrs?.d, 'M4 12h16');
});

test('SECURITY: script, style, foreignObject, links and text elements go with their content', () => {
  const out = html(`<svg viewBox="0 0 1 1">
    <script>alert(1)</script>
    <style>path { fill: url(https://tracker.example/x) }</style>
    <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject>
    <a href="javascript:alert(1)"><path d="M0 0"/></a>
    <title>Icon</title><text>Hello</text>
    <image href="https://tracker.example/pixel.png"/>
    <animate attributeName="href" to="javascript:alert(1)"/>
    <path d="M1 1"/>
  </svg>`);
  for (const bad of ['script', 'alert', 'style', 'foreignObject', 'onerror', '<a', 'javascript', 'tracker', 'Hello', 'Icon', 'animate', '<image']) {
    assert.ok(!out.includes(bad), `"${bad}" survived: ${out}`);
  }
  assert.ok(out.includes('d="M1 1"'), 'CONTROL: the real shape is kept');
});

test('SECURITY: every event handler and style attribute is removed', () => {
  const svg = sanitizeSvg('<svg viewBox="0 0 1 1" onload="alert(1)" style="background:url(x)"><path d="M0 0" onclick="alert(2)" ONMOUSEOVER="alert(3)" style="fill:red"/></svg>', './i.svg');
  for (const n of walk(svg)) {
    for (const k of Object.keys(n.attrs ?? {})) {
      assert.ok(!/^on/i.test(k) && k !== 'style', `${n.tag} kept ${k}`);
    }
  }
});

test('SECURITY: references may point only inside the file', () => {
  const svg = sanitizeSvg(`<svg viewBox="0 0 1 1">
    <defs><path id="a" d="M0 0"/><linearGradient id="g"><stop offset="0" stop-color="#123456"/></linearGradient></defs>
    <use href="#a"/>
    <use href="https://evil.example/sprite.svg#a"/>
    <use xlink:href="data:image/svg+xml,&lt;svg onload='alert(1)'/&gt;"/>
    <path d="M0 0" fill="url(#g)"/>
    <path d="M0 0" fill="url(https://evil.example/x)"/>
    <path d="M0 0" clip-path="url(#a)" mask="url(javascript:alert(1))"/>
  </svg>`, './i.svg');
  const uses = walk(svg).filter((n) => n.tag === 'use');
  assert.equal(uses.length, 1, 'only the local <use> survives (§7)');
  assert.equal(uses[0].attrs?.href, '#a');
  const paths = walk(svg).filter((n) => n.tag === 'path' && n.attrs?.id !== 'a');
  assert.equal(paths[0].attrs?.fill, 'currentColor', 'a local gradient paint becomes currentColor');
  assert.equal(paths[1].attrs?.fill, undefined, 'an outside url() is dropped');
  assert.equal(paths[2].attrs?.['clip-path'], 'url(#a)', 'CONTROL: a local reference is kept');
  assert.equal(paths[2].attrs?.mask, undefined);
  assert.equal(walk(svg).find((n) => n.tag === 'stop')?.attrs?.['stop-color'], 'currentColor');
});

test('SECURITY: DOCTYPE, entities, CDATA and processing instructions are refused, not guessed at', () => {
  const refused = [
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    '<svg viewBox="0 0 1 1"><![CDATA[<script>alert(1)</script>]]></svg>',
    '<?xml-stylesheet href="https://evil.example/x.css"?><svg viewBox="0 0 1 1"/>',
    '<svg viewBox="0 0 1 1"><path d="&unknown;"/></svg>',
  ];
  for (const source of refused) assert.throws(() => sanitizeSvg(source, './i.svg'), SvgError, source);
});

test('malformed or non-icon files are refused with a message naming the file', () => {
  for (const source of [
    '<svg viewBox="0 0 1 1"><path d="M0 0"></svg>',            // unclosed
    '<svg viewBox="0 0 1 1"><g></path></g></svg>',             // mismatched close
    '<div><svg/></div>',                                       // not an svg root
    '<svg/><svg/>',                                            // two roots
    '<svg viewBox="0 0 1 1">loose text</svg>',                 // text outside an element
    '<svg viewBox="0 0 1 1"><path d=M0/></svg>',               // unquoted attribute
  ]) {
    assert.throws(() => sanitizeSvg(source, './bad.svg'), (e: unknown) => e instanceof SvgError && e.message.includes("'./bad.svg'"), source);
  }
  assert.throws(() => sanitizeSvg(`<svg>${' '.repeat(MAX_SVG_BYTES)}</svg>`, './big.svg'), SvgError);
});

test('CONTROL: an XML declaration, comments and the XML entities are fine', () => {
  const svg = sanitizeSvg('<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by hand --><svg viewBox="0 0 1 1"><g id="a&amp;b"><path d="M0 0"/></g></svg>', './i.svg');
  assert.equal(walk(svg).find((n) => n.tag === 'g')?.attrs?.id, 'a&b');
});

test('every kept element and attribute is on the allowlist', () => {
  const svg = sanitizeSvg(ICON.replace('<path', '<g transform="scale(2)" data-x="1" xml:space="preserve"><path').replace('/><circle', '/></g><circle'), './i.svg');
  const allowedTags = new Set(['svg', 'g', 'path', 'circle']);
  for (const n of walk(svg)) {
    assert.ok(allowedTags.has(n.tag), n.tag);
    assert.ok(!('data-x' in (n.attrs ?? {})) && !('xml:space' in (n.attrs ?? {})), `${n.tag} kept an unknown attribute`);
  }
});
