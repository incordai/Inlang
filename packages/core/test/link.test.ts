/**
 * Link stage tests — ARCHITECTURE §3, §4.1.
 * Run: pnpm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lex } from '../src/lex.ts';
import { parse } from '../src/parse.ts';
import { link, type Manifest, type LinkedWord } from '../src/link.ts';
import { compile } from '../src/index.ts';

/** Load the real manifests — the same files the compiler ships. */
const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const name of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${name}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const run = (src: string) => {
  const l = lex(src);
  const p = parse(l.tokens, l.diagnostics);
  const r = link(p.file, manifests);
  return { ...r, diagnostics: [...p.diagnostics, ...r.diagnostics] };
};
const codes = (src: string) => run(src).diagnostics.map((d) => d.code);
const find = (ws: LinkedWord[], word: string): LinkedWord | undefined => {
  for (const w of ws) {
    if (w.word === word) return w;
    const hit = find(w.children, word);
    if (hit) return hit;
  }
  return undefined;
};

test('all 11 manifests load', () => {
  assert.equal(manifests.size, 11, [...manifests.keys()].join(','));
});

test('a variant and modifiers are sorted apart', () => {
  const r = run('az 1\npage /\n  hero split 3d scroll\n    title "Hi"\n');
  const hero = find(r.root, 'hero')!;
  assert.equal(hero.variant, 'split');
  assert.deepEqual(hero.modifiers.sort(), ['3d', 'scroll']);
});

test('AZ1202 — two variants fail loudly, never silently pick', () => {
  // hero-spec §11 is explicit that this must not silently choose one.
  const cs = codes('az 1\npage /\n  hero center split\n    title "Hi"\n');
  assert.ok(cs.includes('AZ1202'), cs.join(','));
});

test('CONTROL: one variant does NOT trigger the two-variant error', () => {
  const cs = codes('az 1\npage /\n  hero center\n    title "Hi"\n');
  assert.ok(!cs.includes('AZ1202'));
});

test('AZ1201 — an unknown word is named, not ignored', () => {
  const cs = codes('az 1\npage /\n  carousel wide\n');
  assert.ok(cs.includes('AZ1201'), cs.join(','));
});

test('AZ1204 — an unknown variant suggests the real ones', () => {
  const r = run('az 1\npage /\n  hero sideways\n    title "Hi"\n');
  const d = r.diagnostics.find((x) => x.code === 'AZ1204');
  assert.ok(d, 'must be reported');
  assert.match(d!.message, /center|split/, 'must suggest actual variants');
});

test('AZ1206 — `requires` from the manifest is enforced', () => {
  // hero.json: requires { scroll: [3d] } — scroll without 3d has nothing to drive.
  const cs = codes('az 1\npage /\n  hero center scroll\n    title "Hi"\n');
  assert.ok(cs.includes('AZ1206'), cs.join(','));
});

test('CONTROL: satisfying the requirement clears it', () => {
  const cs = codes('az 1\npage /\n  hero center 3d scroll\n    title "Hi"\n');
  assert.ok(!cs.includes('AZ1206'), cs.join(','));
});

test('AZ1207 — a required prop is enforced', () => {
  // hero.json: title is required.
  const cs = codes('az 1\npage /\n  hero center\n');
  assert.ok(cs.includes('AZ1207'), cs.join(','));
});

test('AZ1208 — an enum prop must be one of its words', () => {
  // height is an enum of words now, not a number.
  const cs = codes('az 1\npage /\n  hero center\n    title "Hi"\n    height enormous\n');
  assert.ok(cs.includes('AZ1208'), cs.join(','));
});

test('CONTROL: a valid enum word passes', () => {
  const cs = codes('az 1\npage /\n  hero center\n    title "Hi"\n    height peek\n');
  assert.ok(!cs.includes('AZ1208'), cs.join(','));
});

test('props are collected onto the word', () => {
  const r = run('az 1\npage /\n  hero center\n    title "Built in the dark"\n    height tall\n');
  const hero = find(r.root, 'hero')!;
  assert.equal(hero.props.title.value, 'Built in the dark');
  assert.equal(hero.props.height.value, 'tall');
});

test('nav children resolve, and `as` survives linking', () => {
  const r = run('az 1\nsite aurora\n  nav split\n    link "Work" /work\n    group "P" as dropdown\n');
  const group = find(r.root, 'group')!;
  assert.equal(group.as, 'dropdown');
  assert.ok(find(r.root, 'link'), 'link resolves as a nav child');
});

test('structure keywords and their properties resolve', () => {
  const cs = codes('az 1\nsite aurora\n  width wide\n  theme midnight\n    accent violet\n');
  assert.ok(!cs.includes('AZ1201'), 'width/accent must not read as unknown words: ' + cs.join(','));
});

test("the spec's worked example links with no ERRORS", () => {
  const src = readFileSync(new URL('./fixture-site.az', import.meta.url), 'utf8');
  const r = run(src);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(
    errors.map((d) => `${d.code} ${d.pos.line}:${d.pos.col} ${d.message}`),
    [],
  );
});

/* ---------------- diagnostics added while compiling the specs ---------------- */

test('AZ1211 — `recommends` warns, and does NOT block the build', () => {
  // nav-spec §4: "warn when `solid` is used without" an inverse logo. It was
  // expressed as `requires`, which is an ERROR, and rejected the nav spec's
  // own worked example.
  const r = run('az 1\nsite aurora\n  nav split solid\n    logo ./logo.svg\n');
  const d = r.diagnostics.find((x) => x.code === 'AZ1211');
  assert.ok(d, 'the recommendation must be reported: ' + r.diagnostics.map((x) => x.code));
  assert.equal(d!.severity, 'warning', 'advice must not fail the build');
});

test('CONTROL: supplying the recommended value silences it', () => {
  const cs = codes('az 1\nsite aurora\n  nav split solid\n    logo ./logo.svg\n    inverse ./logo-w.svg\n');
  assert.ok(!cs.includes('AZ1211'), cs.join(','));
});

test('AZ1206 — a requirement is satisfied by a SLOT FILL, not only a prop', () => {
  // `footer columns` requires `group`; groups arrive as slot fills. Checking
  // only props told the footer spec's own example to "add: group <value>"
  // while two groups were declared directly beneath.
  const cs = codes('az 1\nsite aurora\n  footer columns\n    group "Shop"\n      link "Shoes" /shoes\n');
  assert.ok(!cs.includes('AZ1206'), 'a declared group must satisfy it: ' + cs.join(','));
});

test('CONTROL: the same requirement still fires when nothing satisfies it', () => {
  const cs = codes('az 1\nsite aurora\n  footer columns\n    link "Privacy" /legal\n');
  assert.ok(cs.includes('AZ1206'), cs.join(','));
});
/**
 * AZ1303 comes from the SPEC stage, which needs the whole file.
 *
 * `run` above stops at link and would never see it, so these two go through
 * the full compile instead.
 */
const wholeFileCodes = (src: string) =>
  compile(src, { manifests }).diagnostics.map((d) => d.code);


test('AZ1303 — a site-scoped prop missing everywhere is reported once', () => {
  const cs = wholeFileCodes('az 1\nsite aurora\n\npage /login\n  auth login\n');
  assert.ok(cs.includes('AZ1303'), cs.join(','));
});

test('CONTROL: declaring it at site level clears AZ1303', () => {
  const cs = wholeFileCodes('az 1\nsite aurora\n  auth\n    adapter session\n\npage /login\n  auth login\n');
  assert.ok(!cs.includes('AZ1303'), cs.join(','));
});

test('AZ1304 — a site-scoped prop declared on a BLOCK is rejected', () => {
  // auth-spec §2: one adapter per site. Without this the rule was prose only,
  // and two pages could name two different auth backends.
  const r = run('az 1\nsite aurora\n\npage /login\n  auth login\n    adapter session\n');
  const d = r.diagnostics.find((x) => x.code === 'AZ1304');
  assert.ok(d, r.diagnostics.map((x) => x.code).join(','));
  assert.match(d!.message, /site aurora|site <name>/, 'must name where it belongs');
});

test('AZ1212 — a manifest naming an unknown value set is reported, not crashed on', () => {
  // `pricing.currency` declares `"values": "iso4217"` — a NAME, not a list.
  // The enum check assumed an array and threw `values.join is not a function`,
  // so one manifest field took the whole compiler down.
  const fake = new Map(manifests);
  fake.set('probe', {
    name: 'probe',
    props: { kind: { type: 'enum', values: 'nosuchset' } },
  } as Manifest);
  const l = lex('az 1\nsite aurora\n  probe\n    kind x\n');
  const p = parse(l.tokens, l.diagnostics);
  const res = link(p.file, fake);
  assert.ok(res.diagnostics.some((d) => d.code === 'AZ1212'),
    res.diagnostics.map((d) => d.code).join(','));
});

test('a named value set validates the real manifest — pricing.currency', () => {
  assert.ok(!codes('az 1\nsite aurora\n\npage /\n  pricing cards\n    title "P"\n    currency usd\n    plan "S"\n      monthly 29\n      cta "Go" /go\n').includes('AZ1208'));
  assert.ok(codes('az 1\nsite aurora\n\npage /\n  pricing cards\n    title "P"\n    currency dollars\n    plan "S"\n      monthly 29\n      cta "Go" /go\n').includes('AZ1208'),
    'a value of the wrong shape must still be caught');
});
