/**
 * Rendering — the one place user content is escaped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNode, escapeHtml, styleString } from '../src/render.ts';

test('SECURITY: a script tag in content cannot break out', () => {
  const html = renderNode({ tag: 'h1', children: ['</script><script>alert(1)</script>'] });
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;'), 'angle brackets must be entity-encoded');
});

test('SECURITY: a quote in an attribute cannot terminate it', () => {
  const html = renderNode({ tag: 'div', attrs: { title: 'he said "hi" onload=x' } });
  assert.ok(!/title="[^"]*"[^>]*onload=/.test(html), `attribute broke out: ${html}`);
  assert.ok(html.includes('&quot;'));
});

test('CONTROL: ordinary text is left readable', () => {
  // Escaping everything into entities would pass the tests above and make the
  // output unreadable.
  assert.equal(escapeHtml('Built in the dark'), 'Built in the dark');
  assert.equal(renderNode({ tag: 'p', children: ['Handmade.'] }), '<p>Handmade.</p>');
});

test('style keys are sorted — determinism, CONVENTIONS §6', () => {
  const a = styleString({ zIndex: 1, color: 'red', margin: 0 });
  const b = styleString({ margin: 0, zIndex: 1, color: 'red' });
  assert.equal(a, b, 'declaration order must not change the bytes');
});

test('camelCase style keys become CSS properties', () => {
  assert.equal(styleString({ marginTop: '4px' }), 'margin-top:4px');
  assert.equal(styleString({ paddingInline: '8px' }), 'padding-inline:8px');
});

test('empty style values are dropped, not emitted as empty rules', () => {
  assert.equal(styleString({ color: 'red', margin: '' }), 'color:red');
});

test('void elements take no closing tag', () => {
  assert.equal(renderNode({ tag: 'br' }), '<br>');
  assert.equal(renderNode({ tag: 'img', attrs: { src: 'a.png' } }), '<img src="a.png">');
});

test('CONTROL: a non-void element DOES get a closing tag', () => {
  assert.equal(renderNode({ tag: 'div' }), '<div></div>');
});

test('children render recursively', () => {
  const html = renderNode({
    tag: 'section',
    children: [{ tag: 'h2', children: ['Title'] }, { tag: 'p', children: ['Body'] }],
  });
  assert.equal(html, '<section><h2>Title</h2><p>Body</p></section>');
});

test('the hero emitter renders to safe markup end to end', async () => {
  const { emit } = await import('../../words/hero/emit.web.ts');
  const { resolve, THEMES } = await import('../../theme/src/index.ts');
  const t = resolve(THEMES.midnight, 'dark');
  const node = emit(
    { word: 'hero', variant: 'center', modifiers: [], args: [], as: null, children: [],
      props: { title: '</script>evil', height: 'peek' } },
    { theme: t as never, target: 'web', site: { name: 'aurora' }, slot: () => [], asset: (p) => p },
  );
  const html = renderNode(node);
  assert.ok(!html.includes('<script'), 'content escaped through the whole path');
  assert.ok(html.includes('min-height:85svh'), 'the height word reached the markup');
});
