/**
 * The chat renderer's committed themes (packages/chat-render/themes/,
 * chat-block-spec §22.3) are what the chat word and the stylesheet compiler
 * make now — a change to either that is not regenerated fails here — and
 * every shell holds each template an answer is drawn from, and nothing a
 * template may never carry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatThemeFiles, staleThemeFiles } from './chat-themes.mjs';

const FILES = chatThemeFiles();
const shells = FILES.filter((f) => f.path.endsWith('.ts')).map((f) => ({ path: f.path, shell: JSON.parse(f.content.slice(f.content.indexOf('export const SHELL: TemplateNode = ') + 'export const SHELL: TemplateNode = '.length).trimEnd().replace(/;$/, '')) }));

const walk = (n) => (typeof n === 'string' ? [] : [n, ...(n.c ?? []).flatMap(walk)]);

test('six themes, a module and a stylesheet each, all as committed', () => {
  assert.equal(FILES.length, 12);
  assert.deepEqual(staleThemeFiles(FILES), [], 'run node scripts/gen-chat-themes.mjs');
});

test('CONTROL: a committed file that differs is found', () => {
  assert.deepEqual(staleThemeFiles([{ ...FILES[0], content: `${FILES[0].content}/* edited */\n` }]), [FILES[0].path]);
});

test('every shell holds every template an answer is drawn from', () => {
  const parts = ['faq', 'feature', 'cta-route', 'cta-https', 'cta-mailto', 'cta-tel', 'paint', 'figure', 'table', 'stats', 'cards', 'dashboard',
    'explore', 'map', 'map-popup', 'unavailable', 'share', 'row-image'];
  for (const { path, shell } of shells) {
    const nodes = walk(shell);
    for (const box of ['data-az-chat-templates', 'data-az-chat-parts', 'data-az-chat-prose', 'data-az-chat-extras', 'data-az-chat-transcript', 'data-az-chat-form']) {
      assert.ok(nodes.some((n) => n.a?.[box] !== undefined), `${path}: ${box}`);
    }
    const have = nodes.map((n) => n.a?.['data-az-chat-part']).filter(Boolean);
    for (const p of parts) assert.ok(have.includes(p), `${path}: the ${p} part`);
  }
});

test('no template carries a script, a frame, an event handler, a style or a script URL', () => {
  for (const { path, shell } of shells) {
    for (const n of walk(shell)) {
      assert.ok(!['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base'].includes(n.t), `${path}: <${n.t}>`);
      for (const [k, v] of Object.entries(n.a ?? {})) {
        assert.doesNotMatch(k, /^on|^style$/i, `${path}: ${k}`);
        assert.doesNotMatch(v, /javascript:/i, `${path}: ${k}`);
      }
    }
  }
});
