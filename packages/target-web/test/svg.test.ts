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
  // A local paint server stays referenced; its stops take currentColor below,
  // so an opacity gradient keeps its shape in the theme colour.
  assert.equal(paths[0].attrs?.fill, 'url(#g)', 'a local gradient paint stays a reference');
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

/* ---- paint: a single-colour icon, and the parts that are never painted ---- */

const byId = (n: EmittedNode, id: string) => walk(n).find((x) => x.attrs?.id?.endsWith(id));

test('a mask keeps its authored paints — they are luminance, never shown', () => {
  // The exporter's usual cut-out: white keeps, black removes.
  const svg = sanitizeSvg(`<svg viewBox="0 0 24 24"><defs><mask id="m"><rect id="keep" width="24" height="24" fill="white"/><circle id="cut" cx="12" cy="12" r="4" fill="black"/></mask></defs><path id="shape" d="M0 0h24v24H0z" fill="#111" mask="url(#m)"/></svg>`, './i.svg');
  assert.equal(byId(svg, 'keep')?.attrs?.fill, 'white');
  assert.equal(byId(svg, 'cut')?.attrs?.fill, 'black');
  assert.equal(byId(svg, 'shape')?.attrs?.fill, 'currentColor', 'CONTROL: the painted shape still takes the theme colour');
});

test('transparent and white paints become none; they are background, not ink', () => {
  // A design tool's artboard background, and a transparent hit area.
  const svg = sanitizeSvg('<svg viewBox="0 0 24 24"><rect id="bg" width="24" height="24" fill="#FFFFFF"/><rect id="hit" width="24" height="24" fill="transparent"/><path id="ink" d="M4 12h16" stroke="#0a0a0a"/><circle id="w" r="2" fill="white" stroke="rgb(255, 255, 255)"/></svg>', './i.svg');
  assert.equal(byId(svg, 'bg')?.attrs?.fill, 'none');
  assert.equal(byId(svg, 'hit')?.attrs?.fill, 'none');
  assert.equal(byId(svg, 'w')?.attrs?.fill, 'none');
  assert.equal(byId(svg, 'w')?.attrs?.stroke, 'none');
  assert.equal(byId(svg, 'ink')?.attrs?.stroke, 'currentColor');
});

/* ---- ids: every inlined copy has its own ---------------------------------- */

const GRAD = '<svg viewBox="0 0 24 24"><defs><clipPath id="a"><rect width="12" height="24"/></clipPath><linearGradient id="g"><stop offset="0"/></linearGradient></defs><path d="M0 0" clip-path="url(#a)" fill="url(#g)"/><use href="#a"/></svg>';

test('ids are prefixed per inlined instance, and every reference follows', () => {
  const one = sanitizeSvg(GRAD, './i.svg', 'az-i0-');
  const two = sanitizeSvg(GRAD, './i.svg', 'az-i1-');
  const ids = (n: EmittedNode) => walk(n).map((x) => x.attrs?.id).filter(Boolean);
  assert.deepEqual(ids(one), ['az-i0-a', 'az-i0-g']);
  assert.deepEqual(ids(two), ['az-i1-a', 'az-i1-g']);
  const path = walk(two).find((x) => x.tag === 'path')!;
  assert.equal(path.attrs?.['clip-path'], 'url(#az-i1-a)');
  assert.equal(path.attrs?.fill, 'url(#az-i1-g)', 'a gradient reference is not recoloured');
  assert.equal(walk(two).find((x) => x.tag === 'use')?.attrs?.href, '#az-i1-a');
});

test('two icons on one page never share an id', () => {
  const nodes = [sanitizeSvg(GRAD, './a.svg', 'az-i0-'), sanitizeSvg(GRAD, './b.svg', 'az-i1-')];
  const all = nodes.flatMap(walk).map((x) => x.attrs?.id).filter(Boolean);
  assert.equal(new Set(all).size, all.length);
});

/** XML 1.0's Char production (§2.2) leaves these out: each range, by its first and last code point. */
const NOT_XML_CHARS: Readonly<Record<string, readonly [number, number]>> = {
  'NUL and the C0 controls before tab': [0x0, 0x8],
  'the C0 controls between line feed and carriage return': [0xb, 0xc],
  'the C0 controls after carriage return': [0xe, 0x1f],
  'the surrogates': [0xd800, 0xdfff],
  'U+FFFE and U+FFFF': [0xfffe, 0xffff],
};

for (const [range, [first, last]] of Object.entries(NOT_XML_CHARS)) {
  test(`a character reference to ${range} (U+${first.toString(16).toUpperCase()}–U+${last.toString(16).toUpperCase()}) is an SvgError naming the file and the reference`, () => {
    for (const n of new Set([first, first + 1, (first + last) >> 1, last])) {
      if (n > last) continue;
      for (const ref of [`&#x${n.toString(16)};`, `&#${n};`]) {
        assert.throws(() => sanitizeSvg(`<svg viewBox="0 0 1 1"><g id="a${ref}"/></svg>`, './i.svg'),
          (e: unknown) => e instanceof SvgError && e.message.includes("'./i.svg'") && e.message.includes(ref)
            && e.message.includes('XML does not allow'), ref);
      }
    }
  });
}

test('CONTROL: a character reference at each edge of XML\'s characters is decoded', () => {
  for (const n of [0x9, 0xa, 0xd, 0x20, 0xd7ff, 0xe000, 0xfffd, 0x10000, 0x10ffff]) {
    const svg = sanitizeSvg(`<svg viewBox="0 0 1 1"><g id="a&#x${n.toString(16)};"/></svg>`, './i.svg');
    assert.equal(walk(svg).find((x) => x.tag === 'g')?.attrs?.id, `a${String.fromCodePoint(n)}`, n.toString(16));
  }
});

test('a character reference beyond Unicode is an SvgError, not a crash', () => {
  for (const ref of ['&#x110000;', '&#1114112;', '&#x99999999999;']) {
    assert.throws(() => sanitizeSvg(`<svg viewBox="0 0 1 1"><g id="a${ref}"/></svg>`, './i.svg'),
      (e: unknown) => e instanceof SvgError && e.message.includes("'./i.svg'"), ref);
  }
});
