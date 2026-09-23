/**
 * auth — `methods`, `redirect`, `impl` (auth-block-spec §5, §11, §12.3).
 *
 * Compiled through the real manifest, then emitted, so each test covers the
 * rule the spec states AND the markup it produces. The adapter itself is M4;
 * what is checked here is what the compiler can promise without one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../core/src/index.ts';
import type { Manifest } from '../../core/src/link.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { emit as emitAuth } from '../auth/emit.web.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const d of readdirSync(WORDS)) {
  const f = join(WORDS, d, 'word.json');
  if (!existsSync(f)) continue;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

function context(): EmitContext {
  const t = resolve(THEMES.midnight, 'dark');
  return {
    theme: {
      color: t.color as unknown as Record<string, string>,
      size: t.size as unknown as Record<string, number>,
      type: t.type as unknown as Record<string, string | number>,
      radius: t.radius as unknown as Record<string, number>,
      shadow: t.shadow as unknown as Record<string, string>,
      space: t.space as unknown as Record<string, number>,
      motion: t.motion as unknown as Record<string, string | number>,
      layer: t.layer as unknown as Record<string, number>,
      breakpoint: t.breakpoint,
      typeSize: t.typeSize as unknown as Record<string, string>,
    },
    target: 'web',
    site: { name: 'aurora' },
    slot: () => [],
    asset: (p) => p,
    ...actionsFor(t as unknown as EmitContext['theme']),
  };
}

/** A whole file: one site adapter, a login page with `lines`, and an account page. */
function file(lines: string, adapter = '    adapter session\n', variant = 'login') {
  return `az 1\nsite aurora\n  auth\n${adapter}\npage /login\n  auth ${variant}\n${lines}\npage /account\n`;
}
const compileFile = (src: string) => compile(src, { manifests });
const codes = (src: string) => compileFile(src).diagnostics.map((d) => d.code);

/** The emitted form of the page's auth block. */
function form(lines: string, variant = 'login'): EmittedNode {
  const r = compileFile(file(lines, undefined, variant));
  assert.ok(r.ok, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  const block = r.spec!.pages[0].blocks.find((b) => b.word === 'auth')!;
  const section = emitAuth(block, context());
  const f = (section.children ?? []).find(
    (c): c is EmittedNode => typeof c !== 'string' && c.tag === 'form');
  assert.ok(f, 'the auth block emits a form');
  return f;
}
const kids = (n: EmittedNode) =>
  (n.children ?? []).filter((c): c is EmittedNode => typeof c !== 'string');
const inputs = (f: EmittedNode) =>
  kids(f).flatMap(kids).filter((n) => n.tag === 'input').map((n) => n.attrs?.type);
const buttons = (f: EmittedNode) => kids(f).filter((n) => n.tag === 'button');

/* ---- impl: required by `adapter custom` -------------------------------- */

test('§11: adapter custom without impl is an error', () => {
  const cs = codes(file('', '    adapter custom\n'));
  assert.ok(cs.includes('AZ1206'), cs.join(','));
});

test('CONTROL: adapter custom WITH impl at site level compiles', () => {
  const r = compileFile(file('', '    adapter custom\n    impl ./auth/adapter.ts\n'));
  assert.ok(r.ok, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
});

test('CONTROL: another adapter needs no impl', () => {
  assert.ok(!codes(file('')).includes('AZ1206'));
});

test('impl belongs with the adapter — one per site, so a page-level impl is AZ1304', () => {
  assert.ok(codes(file('    impl ./auth/adapter.ts\n', '    adapter custom\n')).includes('AZ1304'));
});

test('impl is sandboxed like every path prop', () => {
  const cs = codes(file('', '    adapter custom\n    impl ../../outside.ts\n'));
  assert.ok(cs.includes('AZ1210'), cs.join(','));
});

/* ---- redirect ---------------------------------------------------------- */

test('§11: a redirect to an undeclared page is an error', () => {
  const r = compileFile(file('    redirect /dashboard\n'));
  const d = r.diagnostics.find((x) => x.code === 'AZ1215');
  assert.ok(d, r.diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /auth: '\/dashboard' is not a page in this site — add it or fix the redirect/);
});

test('the redirect reaches the form for the M4 runtime', () => {
  assert.equal(form('    redirect /account\n').attrs?.['data-redirect'], '/account');
});

test('CONTROL: no redirect, no data-redirect', () => {
  assert.equal(form('').attrs?.['data-redirect'], undefined);
});

/* ---- methods ----------------------------------------------------------- */

test('CONTROL: the default is password — email, password, one "Sign in"', () => {
  const f = form('');
  assert.deepEqual(inputs(f), ['email', 'password']);
  assert.deepEqual(buttons(f).map((b) => b.children), [['Sign in']]);
  assert.equal(f.attrs?.['data-methods'], 'password');
});

test('methods link — a passwordless form asks for no password', () => {
  const f = form('    methods link\n');
  assert.deepEqual(inputs(f), ['email']);
  assert.deepEqual(buttons(f).map((b) => b.children), [['Email me a link']]);
  assert.equal(f.attrs?.['data-methods'], 'link');
});

test('methods password link — one form, the link offered as the alternative', () => {
  const f = form('    methods password link\n');
  assert.deepEqual(inputs(f), ['email', 'password']);
  const [primary, alt] = buttons(f);
  assert.equal(primary.children?.[0], 'Sign in', 'Enter submits the password sign-in');
  assert.equal(primary.attrs?.value, 'password');
  assert.equal(primary.attrs?.formnovalidate, undefined);
  assert.equal(alt.children?.[0], 'Email me a link instead');
  assert.equal(alt.attrs?.value, 'link');
  assert.equal(alt.attrs?.type, 'submit');
  assert.equal(alt.attrs?.formnovalidate, 'formnovalidate',
    'the link button must not demand the password it replaces');
  assert.equal(f.attrs?.['data-methods'], 'password link');
});

/** The whole emitted section of the page's auth block. */
function section(lines: string, adapter = '    adapter session\n', variant = 'login'): EmittedNode {
  const r = compileFile(file(lines, adapter, variant));
  assert.ok(r.ok, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  return emitAuth(r.spec!.pages[0].blocks.find((b) => b.word === 'auth')!, context());
}
const all = (n: EmittedNode): EmittedNode[] => [n, ...kids(n).flatMap(all)];

test('§12.3 overridden by the owner: methods oauth compiles on a cookie adapter', () => {
  for (const adapter of ['    adapter session\n', '    adapter azbackend\n']) {
    const codes = compileFile(file('    methods password oauth\n', adapter)).diagnostics.map((d) => d.code);
    assert.ok(!codes.includes('AZ1214') && !codes.includes('AZ2005'), codes.join(','));
  }
});

test('AZ2005: methods oauth on an adapter with no server to run the round-trip is an error', () => {
  const r = compileFile(file('    methods oauth\n', '    adapter custom\n    impl ./adapter.ts\n'));
  const d = r.diagnostics.find((x) => x.code === 'AZ2005');
  assert.ok(d && d.severity === 'error', r.diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /needs adapter azbackend, session or hosted/);
});

test('AZ2006: methods oauth on the STANDARD hosted protocol is an error — it has no provider sign-in', () => {
  const r = compileFile(file('    methods oauth\n', '    adapter hosted\n'));
  const d = r.diagnostics.find((x) => x.code === 'AZ2006');
  assert.ok(d && d.severity === 'error', r.diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /needs profile token-endpoint/);
});

test('§3.5 CONTROL: methods oauth compiles on hosted with the token-endpoint profile', () => {
  const codes = compileFile(file('    methods password oauth\n', '    adapter hosted\n    profile token-endpoint\n'))
    .diagnostics.map((d) => d.code);
  assert.ok(!codes.includes('AZ2005') && !codes.includes('AZ2006'), codes.join(','));
});

test('§3.4 oauth: a hidden provider container with ONE secondary template action, beside the form', () => {
  const out = section('    methods password oauth\n');
  const box = all(out).find((n) => n.attrs?.['data-az-oauth'] === 'providers');
  assert.ok(box, 'the provider container is emitted');
  assert.equal(box.attrs?.hidden, 'hidden', 'hidden until the backend lists a provider');
  assert.equal(box.style?.display, undefined, 'no display of its own, or it would beat `hidden`');
  const templates = all(box).filter((n) => n.attrs?.['data-az-oauth-template']);
  assert.equal(templates.length, 1);
  const link = all(templates[0]).find((n) => n.tag === 'a');
  assert.match(String(link?.attrs?.class), /az-action--secondary/, 'the form submit stays the one primary');
  assert.ok(!all(out).some((n) => n.tag === 'form' && all(n).includes(box)), 'provider links are not inside the form');
  assert.match(String(all(out).find((n) => n.tag === 'form')?.attrs?.['data-methods']), /\boauth\b/);
});

test('CONTROL: without oauth there is no provider container', () => {
  assert.ok(!all(section('    methods password\n')).some((n) => n.attrs?.['data-az-oauth']));
});

test('§3.4 signup: name, email, password, retype and an optional location — in that order', () => {
  const f = form('    terms /account\n', 'signup');
  const named = kids(f).flatMap(kids).filter((n) => n.tag === 'input');
  assert.deepEqual(named.map((n) => n.attrs?.name), ['name', 'email', 'password', 'passwordConfirm', 'location', 'terms']);
  const by = (name: string) => named.find((n) => n.attrs?.name === name)!;
  assert.equal(by('passwordConfirm').attrs?.autocomplete, 'new-password', 'a manager fills both from one entry');
  assert.equal(by('passwordConfirm').attrs?.required, 'required');
  assert.equal(by('location').attrs?.required, undefined, 'location is optional');
  const labels = all(f).filter((n) => n.tag === 'label').map((n) => String(n.children?.[0]));
  assert.ok(labels.includes('Retype password') && labels.includes('Location (optional)'), labels.join(' | '));
});

test('§3.4 reset: the set-new-password form asks for the new password twice', () => {
  const out = section('    alt "Back" /account\n', undefined, 'reset');
  const set = all(out).find((n) => n.tag === 'form' && n.attrs?.['data-flow'] === 'reset-set')!;
  assert.deepEqual(all(set).filter((n) => n.tag === 'input').map((n) => n.attrs?.name), ['email', 'password', 'passwordConfirm']);
});

test('CONTROL: reset always requests a link, whatever the methods', () => {
  const f = form('    methods password\n', 'reset');
  assert.deepEqual(inputs(f), ['email']);
  assert.deepEqual(buttons(f).map((b) => b.children), [['Email me a link']]);
});

/* ---- §11: the form title is the page's <h1> ------------------------------ */

/** The auth section's heading, whatever the variant. */
function heading(lines: string, variant = 'login') {
  const r = compileFile(file(lines, undefined, variant));
  assert.ok(r.ok, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  const block = r.spec!.pages[0].blocks.find((b) => b.word === 'auth')!;
  const h = kids(emitAuth(block, context())).filter((n) => /^h[1-6]$/.test(n.tag));
  assert.equal(h.length, 1, 'exactly one heading');
  return { tag: h[0].tag, text: String(h[0].children?.[0] ?? '') };
}

test('§11: the written title is the page <h1>', () => {
  assert.deepEqual(heading('    title "Welcome back"\n'), { tag: 'h1', text: 'Welcome back' });
});

test('§11: an untitled form still gives its page an <h1>, named for the flow', () => {
  assert.deepEqual(heading(''), { tag: 'h1', text: 'Sign in' });
  assert.deepEqual(heading('', 'reset'), { tag: 'h1', text: 'Reset password' });
});
