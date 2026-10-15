/**
 * `site width` — PRD §6.1a: the frame every section aligns to. The value is
 * one of five named choices (default `default`), each a theme token, and
 * every section's inset reads it; no section states a width of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, explain, DESCRIPTION_MAX, type Manifest } from '../../core/src/index.ts';
import { SITE_WIDTHS } from '../../core/src/link.ts';
import { emit } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const site = (width: string | null, theme = 'midnight') =>
  `az 1\nsite bench\n${width === null ? '' : `  width ${width}\n`}  theme ${theme}\n\npage /\n  hero center\n    title "Built slowly"\n  text prose\n    body "Oak."\n  cta card\n    title "Reserve"\n    cta "Reserve a pair" /reserve\n\npage /reserve\n`;

function build(src: string) {
  const r = compile(src, { manifests });
  return { r, files: r.spec ? emit(r.spec, { emitters: WEB_EMITTERS }) : [] };
}
const file = (files: { path: string; content: string }[], path: string) => files.find((f) => f.path === path)!.content;
const codes = (src: string) => compile(src, { manifests }).diagnostics.map((d) => d.code);
type Sized = { size: Record<string, number>; breakpoint: Record<string, number> };

test('PRD §6.1a: the five frames compile; the default is `default`', () => {
  assert.deepEqual(Object.keys(SITE_WIDTHS), ['full', 'wide', 'default', 'narrow', 'reading']);
  for (const w of Object.keys(SITE_WIDTHS)) {
    const { r } = build(site(w));
    assert.ok(r.ok, `${w}: ${r.diagnostics.map((d) => d.message).join('\n')}`);
    assert.equal(r.spec!.site.width, w);
  }
  assert.equal(build(site(null)).r.spec!.site.width, 'default');
});

test('an unknown frame is refused, naming the choices (AZ1414); a bare `width` has no value', () => {
  assert.ok(codes(site('center')).includes('AZ1414'), 'the old default is not a frame');
  const d = compile(site('huge'), { manifests }).diagnostics.find((x) => x.code === 'AZ1414')!;
  assert.equal(d.message, "site: width 'huge' is not one of: full, wide, default, narrow, reading");
  assert.ok(codes(site('')).includes('AZ1205'));
});

test('every frame is explained in the description limit', () => {
  for (const [w, text] of Object.entries(SITE_WIDTHS)) {
    assert.ok(text.length > 0 && text.length <= DESCRIPTION_MAX, `${w}: ${text.length}`);
    const line = explain(['site', 'width', w], manifests).lines.at(-1);
    assert.equal(line?.text, text, `az explain site width ${w}`);
  }
});

test('the site sets --az-frame from theme tokens, per frame', () => {
  for (const name of ['midnight', 'paper', 'signal'] as const) {
    const t = resolve(THEMES[name], 'dark') as unknown as Sized;
    const css = file(build(site('default', name)).files, 'src/theme.css');
    assert.ok(css.includes(`.az-site { --az-frame: ${t.size.container}px; }`), name);
    assert.ok(css.includes('.az-site[data-width="full"] { --az-frame: 100%; }'), name);
    assert.ok(css.includes(`.az-site[data-width="wide"] { --az-frame: ${t.size.container + 2 * t.size['gutter-lg']}px; }`), name);
    assert.ok(css.includes(`.az-site[data-width="narrow"] { --az-frame: ${t.breakpoint.md}px; }`), name);
    assert.ok(css.includes(`.az-site[data-width="reading"] { --az-frame: ${t.size['measure-body']}ch; }`), name);
  }
  assert.match(file(build(site('narrow')).files, 'src/App.tsx'), /width=\{"narrow"\}/);
});

test('sections inset to the frame at desktop; the inset card sits in it', () => {
  const t = resolve(THEMES.midnight, 'dark') as unknown as Sized;
  const frame = `max(${t.size['gutter-lg']}px, calc((100% - var(--az-frame, 100%)) / 2))`;
  const sheet = file(build(site('default')).files, 'src/az.css');
  assert.ok(sheet.split(`padding-inline: ${frame}`).length - 1 >= 2, 'hero and text read the frame');
  assert.ok(sheet.includes(`margin-inline: ${frame}`), 'the cta card sits in the frame');
  // Every block word frames its root through the one helper.
  for (const w of ['cta', 'feature', 'faq', 'auth', 'hero', 'footer', 'nav', 'gallery', 'pricing', 'scene', 'text']) {
    assert.match(readFileSync(new URL(`${w}/emit.web.ts`, wordsDir), 'utf8'), /framed\(t\)/, `${w} does not read the frame`);
  }
});
