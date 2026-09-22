/**
 * The compiler API — one entry point, callable from Node and the browser.
 * Run: pnpm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, serialiseSpec, formatDiagnostics, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}
const src = readFileSync(new URL('./fixture-site.az', import.meta.url), 'utf8');

test("the spec's worked example compiles ok", () => {
  const r = compile(src, { manifests });
  assert.equal(r.ok, true, formatDiagnostics(r.diagnostics));
  assert.ok(r.spec);
});

test('the Spec is JSON-serialisable — ARCHITECTURE §3', () => {
  const r = compile(src, { manifests });
  const json = serialiseSpec(r.spec!);
  const back = JSON.parse(json);
  assert.deepEqual(back, JSON.parse(JSON.stringify(r.spec)));
});

test('the Spec contains no target-specific fields', () => {
  // ARCHITECTURE §2: core must have zero knowledge of React, Vite, three.js
  // or CSS. What must be target-free is the Spec's STRUCTURE — its keys and
  // its own vocabulary. An author's path may legitimately end in `.tsx`,
  // because `raw`/`slot` point at their component (PRD §6.6); scanning raw
  // text flagged that as a leak, which measured the wrong thing.
  const spec = compile(src, { manifests }).spec!;
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        keys.add(k.toLowerCase());
        walk(val);
      }
    }
  };
  walk(spec);
  for (const leak of ['react', 'vite', 'three', 'jsx', 'tsx', 'css', 'canvas', 'webgl', 'html']) {
    assert.ok(!keys.has(leak), `Spec has a target-specific KEY: ${leak}`);
    for (const k of keys) {
      assert.ok(!k.includes(leak), `Spec key '${k}' names a target detail`);
    }
  }
});

test('CONTROL: the key scan would CATCH a target-specific key', () => {
  // Without this the test above passes because it inspects nothing.
  const keys = new Set(['word', 'variant', 'jsxfactory']);
  let caught = false;
  for (const k of keys) if (k.includes('jsx')) caught = true;
  assert.ok(caught, 'the scan must be able to fail');
});

test('DETERMINISM: the same source yields byte-identical Specs', () => {
  const a = serialiseSpec(compile(src, { manifests }).spec!);
  const b = serialiseSpec(compile(src, { manifests }).spec!);
  assert.equal(a, b);
});

test('CONTROL: a changed source yields a DIFFERENT Spec', () => {
  // Without this, "identical" might mean the serialiser ignores its input.
  const a = serialiseSpec(compile(src, { manifests }).spec!);
  const b = serialiseSpec(compile(src.replace('site aurora', 'site borealis'), { manifests }).spec!);
  assert.notEqual(a, b);
});

test('key order is stable regardless of declaration order', () => {
  const one = 'az 1\nsite a\n  width wide\n  theme midnight\npage /\n  hero center\n    title "Hi"\n    height tall\n';
  const two = 'az 1\nsite a\n  theme midnight\n  width wide\npage /\n  hero center\n    height tall\n    title "Hi"\n';
  assert.equal(
    serialiseSpec(compile(one, { manifests }).spec!),
    serialiseSpec(compile(two, { manifests }).spec!),
  );
});

test('manifest defaults are resolved into the Spec', () => {
  const r = compile('az 1\nsite a\npage /\n  hero center\n    title "Hi"\n', { manifests });
  const hero = r.spec!.pages[0].blocks.find((b) => b.word === 'hero')!;
  assert.equal(hero.props.height, 'peek', 'the manifest default must be applied');
});

test('errors are collected across stages, not thrown at the first', () => {
  const r = compile('az 1\nsite a\npage /\n  hero center split\n  carousel wide\n', { manifests });
  const codes = r.diagnostics.map((d) => d.code);
  assert.ok(codes.includes('AZ1202'), 'link error');
  assert.ok(codes.includes('AZ1201'), 'a LATER error is still reported');
  assert.equal(r.ok, false);
});

test('ok is false on error and true on a clean file', () => {
  assert.equal(compile('az 1\nsite a\npage /\n  hero center\n    title "Hi"\n', { manifests }).ok, true);
  assert.equal(compile('az 1\nsite a\npage /\n  nonsense\n', { manifests }).ok, false);
});

test('warnings alone do NOT block — CONVENTIONS §5', () => {
  const r = compile('az 1\nsite a\npage /\n  hero center 3d 3d\n    title "Hi"\n    model ./a.glb\n', { manifests });
  const warns = r.diagnostics.filter((d) => d.severity === 'warning');
  assert.ok(warns.length > 0, 'the repeated modifier must warn');
  assert.equal(r.ok, true, 'a warning must not block the build');
});

test('core does not import anything network-capable — ARCHITECTURE §2', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    for (const banned of ['node:http', 'node:https', 'undici', 'node:fs', 'node:net']) {
      assert.ok(!text.includes(`from '${banned}'`), `${f} imports ${banned}`);
    }
  }
});
