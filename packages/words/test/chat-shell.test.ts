/**
 * chat-block-spec §5.4, §7, §9: the chat word ships a shell the page runtime
 * runs — the greeting as text, a hidden form with a visible label, hidden
 * templates for both kinds of message, the follow-up controls as real
 * buttons, a polite status region, and its config — and nothing that runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFor, compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import { WEB_EMITTERS } from '../registry.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const w of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}
const T = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;

/** The chat block of a small site, emitted; `lines` go under `chat panel`. */
function chat(lines: string[] = [], { login = true } = {}): EmittedNode {
  const src = ['az 1', 'site aurora', '  auth', '    adapter azbackend', '  backend', '    database sqlite', '    email smtp',
    '    model default', 'page /pricing', '  chat panel', ...lines.map((l) => `    ${l}`),
    ...(login ? ['page /login', '  auth login', '    alt "Back" /pricing'] : []), ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b) => b.word === 'chat')!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

const walk = (n: EmittedNode | string): EmittedNode[] => (typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)]);
const texts = (n: EmittedNode | string): string[] => (typeof n === 'string' ? [n] : (n.children ?? []).flatMap(texts));
const marked = (root: EmittedNode, attr: string) => walk(root).filter((n) => n.attrs?.[attr] !== undefined);
const one = (root: EmittedNode, attr: string) => {
  const found = marked(root, attr);
  assert.equal(found.length, 1, `exactly one [${attr}]`);
  return found[0];
};

test('the config names the page, who may ask, the limit and the sign-in page — and nothing else', () => {
  const root = chat(['limit 12']);
  assert.deepEqual(JSON.parse(root.attrs!['data-az-chat']), { page: '/pricing', allow: 'signedin', limit: 12, signin: '/login' });
  assert.equal(root.attrs!['data-az-chat-state'], 'idle');
  const open = chat(['allow anyone']);
  assert.deepEqual(JSON.parse(open.attrs!['data-az-chat']), { page: '/pricing', allow: 'anyone', limit: 20, signin: null });
});

test('the greeting ships as the first message, as text; without one the transcript is empty', () => {
  const root = chat(['greeting "Hi! <b>Ask</b> me."']);
  const transcript = one(root, 'data-az-chat-transcript');
  assert.equal(transcript.tag, 'ol');
  assert.equal(transcript.attrs?.['aria-live'], undefined, '§9: the transcript is not a live region');
  assert.deepEqual(texts(transcript), ['Hi! <b>Ask</b> me.'], 'a string node: the target escapes it');
  assert.deepEqual(one(chat(), 'data-az-chat-transcript').children, []);
});

test('the form ships hidden, with a visible label tied to its textarea, and Send/Stop as real buttons', () => {
  const root = chat();
  const form = one(root, 'data-az-chat-form');
  assert.equal(form.tag, 'form');
  assert.equal(form.attrs?.hidden, 'hidden', 'with JavaScript off the form could not send, so it is not shown');
  const label = walk(form).find((n) => n.tag === 'label')!;
  const input = one(root, 'data-az-chat-input');
  assert.equal(input.tag, 'textarea');
  assert.equal(label.attrs?.for, input.attrs?.id);
  assert.deepEqual(texts(label), ['Your question']);
  assert.equal(input.attrs?.maxlength, '1000');
  assert.equal(one(root, 'data-az-chat-send').attrs?.type, 'submit');
  const stop = one(root, 'data-az-chat-stop');
  assert.deepEqual([stop.tag, stop.attrs?.type, stop.attrs?.hidden], ['button', 'button', 'hidden']);
});

test('both message templates ship hidden, each one paragraph of nothing', () => {
  const templates = one(chat(), 'data-az-chat-templates');
  assert.equal(templates.attrs?.hidden, 'hidden');
  const items = (templates.children ?? []) as EmittedNode[];
  assert.deepEqual(items.map((i) => i.attrs?.class), ['az-chat-message az-chat-message--visitor', 'az-chat-message az-chat-message--site']);
  for (const i of items) assert.deepEqual(texts(i), []);
  // §9: visitor messages on surface-alt, answers on surface — theme tokens only.
  assert.deepEqual(items.map((i) => i.style?.background), [T.color['surface-alt'], T.color.surface]);
});

test('suggested questions are buttons that never submit; none are emitted without any', () => {
  const root = chat(['ask "Which plan fits five?"', 'ask "Can I cancel?"']);
  const asks = one(root, 'data-az-chat-asks');
  assert.equal(asks.attrs?.hidden, 'hidden');
  const buttons = marked(root, 'data-az-chat-ask');
  assert.deepEqual(buttons.map((b) => [b.tag, b.attrs?.type, texts(b).join('')]),
    [['button', 'button', 'Which plan fits five?'], ['button', 'button', 'Can I cancel?']]);
  assert.equal(marked(chat(), 'data-az-chat-asks').length, 0);
});

test('Sign in to ask links to the sign-in page only when signed-in visitors alone may ask and a page signs them in', () => {
  const signin = marked(chat(), 'data-az-chat-signin');
  assert.equal(signin.length, 1);
  assert.equal(signin[0].attrs?.href, '/login');
  assert.equal(signin[0].attrs?.hidden, 'hidden');
  assert.equal(marked(chat(['allow anyone']), 'data-az-chat-signin').length, 0);
  assert.equal(marked(chat([], { login: false }), 'data-az-chat-signin').length, 0);
});

test('one polite status region, visually hidden; a noscript line; errors in color.danger', () => {
  const root = chat();
  const status = one(root, 'data-az-chat-status');
  assert.equal(status.attrs?.role, 'status');
  assert.equal(status.style?.position, 'absolute');
  assert.equal(one(root, 'data-az-chat-error').style?.color, T.color.danger);
  const noscript = walk(root).filter((n) => n.tag === 'noscript');
  assert.equal(noscript.length, 1);
  assert.deepEqual(texts(noscript[0]), ['Turn on JavaScript to ask a question.']);
});

test('CONTROL: nothing in the shell runs — no inline handler, no script, no style attribute, no image', () => {
  const nodes = walk(chat(['greeting "Hello"', 'ask "Why?"']));
  assert.ok(nodes.length > 20, 'CONTROL: the walk sees the shell');
  for (const n of nodes) {
    assert.ok(!['script', 'img', 'iframe', 'object', 'embed'].includes(n.tag), n.tag);
    for (const a of Object.keys(n.attrs ?? {})) assert.ok(!/^on/i.test(a) && a !== 'style', `${n.tag} ${a}`);
  }
});
