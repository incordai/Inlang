/**
 * The prose subset (overlay chat-markdown.ts, chat-block-spec §21.1.2): every
 * form it reads, every form it must leave as the text it is — HTML, links,
 * images, entities, unclosed and crossed delimiters — and a cost linear in
 * what it reads. The tree it makes is the only thing the page draws prose
 * from, so "literal" here means: a text leaf holding exactly those characters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proseBlocks, proseInlines, spokenText, type ProseBlock, type ProseInline } from '../src/chat-markdown.ts';

const text = (s: string): ProseInline => ({ t: 'text', s });
const p = (...c: ProseInline[]): ProseBlock => ({ t: 'p', c });

/** Every leaf's text, in order: what a visitor reads, the marks the subset took away excluded. */
const leaves = (nodes: readonly ProseInline[]): string => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.s : leaves(n.c))).join('');
/** Whether a tree holds anything but text leaves. */
const formatted = (nodes: readonly ProseInline[]): boolean => nodes.some((n) => n.t !== 'text');

test('inline forms: strong, em, code, escapes', () => {
  assert.deepEqual(proseInlines('a **b** c'), [text('a '), { t: 'strong', c: [text('b')] }, text(' c')]);
  assert.deepEqual(proseInlines('a __b__ c'), [text('a '), { t: 'strong', c: [text('b')] }, text(' c')]);
  assert.deepEqual(proseInlines('a *b* c'), [text('a '), { t: 'em', c: [text('b')] }, text(' c')]);
  assert.deepEqual(proseInlines('a _b_ c'), [text('a '), { t: 'em', c: [text('b')] }, text(' c')]);
  assert.deepEqual(proseInlines('run `npm i` now'), [text('run '), { t: 'code', s: 'npm i' }, text(' now')]);
  // A code span's content is never read further, and one padding space each side goes.
  assert.deepEqual(proseInlines('`` a `*b*` c ``'), [{ t: 'code', s: 'a `*b*` c' }]);
  assert.deepEqual(proseInlines('\\*not em\\* and \\`not code\\` and \\\\'), [text('*not em* and `not code` and \\')]);
  // Two levels nest; strong in em and em in strong.
  assert.deepEqual(proseInlines('**a *b* c**'), [{ t: 'strong', c: [text('a '), { t: 'em', c: [text('b')] }, text(' c')] }]);
  assert.deepEqual(proseInlines('*a **b** c*'), [{ t: 'em', c: [text('a '), { t: 'strong', c: [text('b')] }, text(' c')] }]);
});

test('emphasis by the flanking rule: snake_case and spaced stars stay text; a third level is text', () => {
  for (const s of ['snake_case_name', 'a * b * c', '** not strong **', 'x_y_', '_ spaced _', '***three***', '****']) {
    assert.equal(formatted(proseInlines(s)), false, s);
    assert.equal(leaves(proseInlines(s)), s, s);
  }
  assert.deepEqual(proseInlines('2*3*4'), [text('2'), { t: 'em', c: [text('3')] }, text('4')]);
  // A third opener is text: the depth stops at two.
  const deep = proseInlines('**a *b __c__ d* e**');
  assert.equal(leaves(deep), 'a b __c__ d e');
  assert.equal(JSON.stringify(deep).includes('"strong","c":[{"t":"text","s":"c"}'), false);
});

test('unmatched, crossed and unclosed delimiters are the text they are', () => {
  for (const s of ['**open', 'close**', '`unclosed', '``a`', '*', '**', '`', '\\']) {
    const nodes = proseInlines(s);
    assert.equal(leaves(nodes), s.replace('\\\\', '\\'), s);
  }
  // Crossed: a closer matches only the innermost opener — the outer one stays text, nothing is dropped.
  assert.deepEqual(proseInlines('*a **b* c**'), [text('*a '), { t: 'strong', c: [text('b* c')] }]);
});

test('every hostile form stays literal text — no tree node but text, the characters exactly as written', () => {
  const hostile = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(2)>', '<a href="javascript:alert(3)">x</a>',
    '![x](https://evil.example/pixel.png?q=secret)', '[click](https://evil.example/)', '<https://evil.example/>',
    'https://evil.example/raw', 'javascript:alert(4)', '&lt;b&gt;bold&lt;/b&gt; &#106;avascript:', '<!-- comment -->',
    '<style>body{display:none}</style>', '[ref]: https://evil.example/', '<div style="position:fixed">x</div>',
  ];
  for (const s of hostile) {
    const blocks = proseBlocks(s);
    assert.deepEqual(blocks, [p(text(s))], s);
  }
  // Inside formatting too: the leaves are the text, never a link or an element.
  const inStrong = proseInlines('**<img src=x onerror=alert(1)>** `<script>`');
  assert.deepEqual(inStrong, [{ t: 'strong', c: [text('<img src=x onerror=alert(1)>')] }, text(' '), { t: 'code', s: '<script>' }]);
  // Block forms outside the subset are paragraphs of their own text.
  for (const s of ['# Heading', '> quote', '| a | b |', '---', '    indented code', '1) not a list', '-not a list']) {
    assert.deepEqual(proseBlocks(s), [p(text(s))], s);
  }
});

test('blocks: paragraphs at blank lines, lists, code blocks with a language', () => {
  assert.deepEqual(proseBlocks('One\ntwo\n\n  \nThree'), [p(text('One\ntwo')), p(text('Three'))]);
  assert.deepEqual(proseBlocks('- a\n* **b**\n  - c'), [{ t: 'ul', items: [[text('a')], [{ t: 'strong', c: [text('b')] }], [text('c')]] }]);
  assert.deepEqual(proseBlocks('3. three\n4. four'), [{ t: 'ol', start: 3, items: [[text('three')], [text('four')]] }]);
  // A list of the other kind starts a new list; a plain line ends one.
  assert.deepEqual(proseBlocks('- a\n1. b\nafter'), [{ t: 'ul', items: [[text('a')]] }, { t: 'ol', start: 1, items: [[text('b')]] }, p(text('after'))]);
  assert.deepEqual(proseBlocks('Try:\n```js\nconst a = "<b>";\n\n**x**\n```\nDone.'), [
    p(text('Try:')), { t: 'code', lang: 'js', s: 'const a = "<b>";\n\n**x**', open: false }, p(text('Done.')),
  ]);
  // No language, a language that is not one word, an unclosed block (still streaming), a closing fence with spaces.
  assert.deepEqual(proseBlocks('```\nx\n```  '), [{ t: 'code', lang: null, s: 'x', open: false }]);
  assert.deepEqual(proseBlocks('```js onload=alert(1)\nx'), [{ t: 'code', lang: null, s: 'x', open: true }]);
  // A line naming a language inside a block does not close it; an indented fence opens none.
  assert.deepEqual(proseBlocks('```\n```js\n```'), [{ t: 'code', lang: null, s: '```js', open: false }]);
  assert.deepEqual(proseBlocks(' ```\nx'), [p(text(' ```\nx'))]);
});

test('plain prose gives exactly the paragraphs C1 drew (paragraphsOf), so no answer changes shape', () => {
  const paragraphsOf = (t: string) => t.split(/\n{2,}/).map((x) => x.replace(/^\n+|\n+$/g, '')).filter((x) => x !== '');
  for (const s of ['A plain answer. Ask me anything else.', 'Planted. Second sentence.\n\nA new paragraph.', '\n\nlead\n\n\n\ntrail\n\n', 'line one\nline two']) {
    assert.deepEqual(proseBlocks(s), paragraphsOf(s).map((x) => p(text(x))), s);
  }
});

test('the status region hears the words without their marks', () => {
  assert.equal(spokenText('**Team** fits *five*.\n\n- `a`\n- b\n\n```\ncode\n```'), 'Team fits five. a b A code block.');
});

test('linear: 20 000 characters of every delimiter parse within a fixed bound', () => {
  const unit = (s: string) => {
    const t0 = process.hrtime.bigint();
    proseBlocks(s);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const N = 20_000;
  for (const piece of ['*', '_a', '`', '``x', '**a ', '\\*', '- ', '```\n', '*a _b ', '1. x\n']) {
    const s = piece.repeat(Math.ceil(N / piece.length)).slice(0, N);
    const ms = unit(s);
    // Quadratic over 20 000 would be hundreds of millions of steps; linear is a few milliseconds.
    assert.ok(ms < 250, `${JSON.stringify(piece)}: ${ms.toFixed(1)} ms`);
    assert.ok(proseBlocks(s).length > 0, JSON.stringify(piece));
  }
});
