/**
 * The renderer's theme modules and template rules (chat-block-spec §22.3):
 * one module per theme, each naming itself and holding the chat word's
 * shell; the template builder refuses an event handler or a style whatever
 * a template says. The DOM they build is driven in three browsers by
 * scripts/chat-lib-e2e.mjs; the committed modules are held to the generator
 * by scripts/lib/chat-themes.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { THEMES } from '../../theme/src/index.ts';
import { TEMPLATE_ATTRIBUTE_REFUSED, type ChatTheme, type TemplateNode } from '../src/chat-templates.ts';

const DIR = new URL('../themes/', import.meta.url);

test('one module and one stylesheet per theme, each module naming its theme and holding a chat shell', async () => {
  const files = readdirSync(DIR).sort();
  const names = Object.keys(THEMES).sort();
  assert.deepEqual(files, names.flatMap((n) => [`${n}.css`, `${n}.ts`]));
  for (const name of names) {
    const mod = await import(new URL(`${name}.ts`, DIR).href) as ChatTheme;
    assert.equal(mod.THEME, name);
    const shell = mod.SHELL as Exclude<TemplateNode, string>;
    assert.equal(shell.t, 'section');
    assert.ok(shell.a?.['data-az-chat'] !== undefined, `${name}: the chat block's shell`);
  }
});

test('the builder refuses every event handler and the style attribute, and only those', () => {
  for (const k of ['onclick', 'onerror', 'ONLOAD', 'onazwhatever', 'style', 'Style']) assert.ok(TEMPLATE_ATTRIBUTE_REFUSED.test(k), k);
  // CONTROL: the attributes templates do carry are kept.
  for (const k of ['class', 'data-az-chat-slot', 'aria-label', 'role', 'type', 'hidden', 'tabindex', 'viewBox', 'd', 'stroke-width', 'data-state', 'styles-of']) {
    assert.ok(!TEMPLATE_ATTRIBUTE_REFUSED.test(k), k);
  }
});

test('the renderer runs in a browser and an app webview: no Node-only global or module in its sources', () => {
  const src = new URL('../src/', import.meta.url);
  const files = readdirSync(src).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  assert.ok(files.length >= 18, 'CONTROL: the sources are found');
  for (const f of files) {
    const code = readFileSync(new URL(f, src), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const banned of [/\bBuffer\b/, /\bprocess\./, /\brequire\(/, /['"]node:/, /\b__dirname\b/]) assert.doesNotMatch(code, banned, `${f} uses ${banned}`);
  }
});
