/**
 * `font` — GRAMMAR font-decl, theme-spec §8.1.
 *
 * The linker treated `font` as a plain site property and returned it with no
 * children, so its role lines never reached the Spec: every site compiled
 * with `fonts: {}` and no role or family was ever checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Manifest } from '../src/index.ts';

const manifests = new Map<string, Manifest>();
const site = (roles: string) => `az 1\nsite aurora\n  font\n${roles}page /\n`;
const codes = (src: string) => compile(src, { manifests }).diagnostics.map((d) => d.code);

test('font roles reach the Spec', () => {
  const r = compile(site('    display serif\n    body    mono\n'), { manifests });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.spec?.site.fonts, { display: 'serif', body: 'mono' });
});

test('CONTROL: a site without font has no font roles', () => {
  const r = compile('az 1\nsite aurora\npage /\n', { manifests });
  assert.deepEqual(r.spec?.site.fonts, {});
});

test('an unknown role is AZ1405, in the GRAMMAR wording', () => {
  const r = compile(site('    heading serif\n'), { manifests });
  const d = r.diagnostics.find((x) => x.code === 'AZ1405');
  assert.ok(d, JSON.stringify(r.diagnostics));
  assert.match(d.message, /'heading' is not a font role — use display, body, mono/);
  assert.deepEqual(r.spec?.site.fonts ?? {}, {});
});

test('an unknown family is AZ1416 and names the choices', () => {
  const r = compile(site('    display comic\n'), { manifests });
  const d = r.diagnostics.find((x) => x.code === 'AZ1416');
  assert.ok(d, JSON.stringify(r.diagnostics));
  assert.match(d.message, /'comic' is not a family — use sans, serif, mono, rounded/);
});

test('a role with no family, and font with no roles, are AZ1205', () => {
  assert.ok(codes(site('    body\n')).includes('AZ1205'));
  assert.ok(codes('az 1\nsite aurora\n  font\npage /\n').includes('AZ1205'));
});

test('a repeated role warns and keeps the first', () => {
  const r = compile(site('    display serif\n    display mono\n'), { manifests });
  assert.ok(r.diagnostics.some((d) => d.code === 'AZ1203' && d.severity === 'warning'));
  assert.deepEqual(r.spec?.site.fonts, { display: 'serif' });
});

test('every family is accepted for every role', () => {
  for (const role of ['display', 'body', 'mono']) {
    for (const family of ['sans', 'serif', 'mono', 'rounded']) {
      assert.deepEqual(codes(site(`    ${role} ${family}\n`)), [], `${role} ${family}`);
    }
  }
});
