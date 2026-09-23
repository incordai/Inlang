/**
 * Author components in the web target — PRD §6.6, ROADMAP M3.
 *
 * The target turns `raw` / `slot` into component nodes, records each module
 * for the CLI to copy, and imports it in the generated App under an
 * identifier derived from position — never from the author's path, which
 * reaches the source only as a JSON string (CONVENTIONS §6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest, type Spec } from '../../core/src/index.ts';
import { COMPONENT_TAG, type EmittedNode } from '../../core/src/emit-contract.ts';
import { emitProject, PathEscapeError } from '../src/emit.ts';
import { emitBlock } from '../src/tree.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

function spec(body: string): Spec {
  const r = compile(`az 1\nsite aurora\npage /\n${body}`, { manifests });
  assert.ok(r.ok && r.spec, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  return r.spec;
}
const project = (s: Spec) => emitProject(s, { emitters: WEB_EMITTERS });
const app = (s: Spec) => project(s).files.find((f) => f.path === 'src/App.tsx')!.content;

/** The page's nodes as the generated App carries them. */
function pageNodes(s: Spec): EmittedNode[] {
  const json = /const PAGES[^=]*= (\[[\s\S]*?\n\]);/.exec(app(s));
  assert.ok(json, 'App carries its pages as JSON');
  return (JSON.parse(json[1]) as { nodes: EmittedNode[] }[])[0].nodes;
}
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const components = (n: EmittedNode) => walk(n).filter((x) => x.tag === COMPONENT_TAG).map((x) => x.attrs?.src);

const HERO = '  hero center\n    title "x"\n';

test('each module is recorded once, sorted, and imported under a positional name', () => {
  const s = spec(`${HERO}    slot after ./custom/Ticker.tsx\n  raw ./custom/Badge.tsx\n  raw ./custom/Badge.tsx\n`);
  const p = project(s);
  assert.deepEqual(p.modules, ['custom/Badge.tsx', 'custom/Ticker.tsx']);
  const source = app(s);
  assert.match(source, /^import U0 from "\.\/user\/custom\/Badge\.tsx";$/m);
  assert.match(source, /^import U1 from "\.\/user\/custom\/Ticker\.tsx";$/m);
  assert.match(source, /"custom\/Badge\.tsx": U0,/);
  assert.match(source, /theme: \{/, 'the components receive the theme');
  assert.match(source, /"accent": "var\(--az-color-accent\)"/, 'colours as references, theme-spec §3.3');
});

test('CONTROL: a site with no custom code imports nothing and records no module', () => {
  const s = spec(HERO);
  assert.deepEqual(project(s).modules, []);
  assert.doesNotMatch(app(s), /^import U\d/m);
});

test('placement: before/after beside the block, a named slot among its fills, raw inside it', () => {
  const nodes = pageNodes(spec(
    `${HERO}    cta "Go" /\n    slot before ./b.tsx\n    slot after ./a.tsx\n    slot cta ./c.tsx\n    raw ./in.tsx\n  raw ./page.tsx\n`));
  const [before, hero, after, page] = nodes;
  assert.deepEqual([before.tag, before.attrs?.src], [COMPONENT_TAG, 'b.tsx']);
  assert.equal(hero.attrs?.class?.split(' ')[0], 'az-hero');
  assert.deepEqual([after.tag, after.attrs?.src], [COMPONENT_TAG, 'a.tsx']);
  assert.deepEqual([page.tag, page.attrs?.src], [COMPONENT_TAG, 'page.tsx']);
  // Inside the hero: the cta slot's component as a list item, and raw last.
  const actions = walk(hero).find((x) => x.attrs?.class?.split(' ').includes('az-hero-actions'))!;
  assert.deepEqual(actions.children?.map((c) => (typeof c === 'string' ? c : c.tag)), ['li', 'li']);
  assert.deepEqual(components(actions), ['c.tsx']);
  const last = hero.children?.[hero.children.length - 1];
  assert.ok(last && typeof last !== 'string' && last.attrs?.src === 'in.tsx', 'raw renders after the word’s own content');
});

test('DETERMINISM: the same source emits the same App', () => {
  const src = `${HERO}    slot after ./custom/Ticker.tsx\n  raw ./custom/Badge.tsx\n`;
  assert.equal(app(spec(src)), app(spec(src)));
});

test('SECURITY: a hostile path reaches the App only as a JSON string', () => {
  const s = spec(`${HERO}  raw ./ok.tsx\n`);
  const hostile = './x");globalThis.pwned=1;//.tsx';
  const evil: Spec = { ...s, pages: [{ route: '/', blocks: [{ ...s.pages[0].blocks[1], args: [{ kind: 'path', value: hostile }] }] }] };
  const source = app(evil);
  const line = source.split('\n').find((l) => l.startsWith('import U0 from '))!;
  const literal = line.slice('import U0 from '.length, -1);
  // The sandbox normalises `//` to `/`; everything else survives, inside the string.
  assert.equal(JSON.parse(literal), './user/x");globalThis.pwned=1;/.tsx', 'one string, whole path inside it');
  assert.doesNotMatch(source, /^[^"]*globalThis\.pwned/m, 'never as code');
});

test('SECURITY: the target refuses a non-component module even if the linker is bypassed', () => {
  const s = spec(`${HERO}  raw ./ok.tsx\n`);
  const css: Spec = { ...s, pages: [{ route: '/', blocks: [{ ...s.pages[0].blocks[1], args: [{ kind: 'path', value: './site.css' }] }] }] };
  assert.throws(() => project(css), PathEscapeError);
  const out: Spec = { ...s, pages: [{ route: '/', blocks: [{ ...s.pages[0].blocks[1], args: [{ kind: 'path', value: '../../x.tsx' }] }] }] };
  assert.throws(() => project(out), PathEscapeError);
});

test('a caller with no component resolver fails loudly on raw, never drops it', () => {
  const s = spec(`${HERO}  raw ./ok.tsx\n`);
  const theme = resolve(THEMES.midnight, 'dark') as unknown as Parameters<typeof emitBlock>[1];
  assert.throws(() => emitBlock(s.pages[0].blocks[1], theme, WEB_EMITTERS, (p) => p, { name: 'aurora' }),
    /cannot place custom components/);
});
