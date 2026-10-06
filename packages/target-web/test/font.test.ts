/**
 * `font` in the web target — theme-spec §8.1.
 *
 * A role overrides the theme's type token, so every block that reads
 * `type.display` / `type.body` / `type.mono` follows it; theme.css sets the
 * body family on the page so unstyled text follows it too (it used to fall
 * back to the browser's default face).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../src/emit.ts';
import { FONT_STACKS, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const PAGE = 'page /\n  hero center\n    title "Built in the dark"\n    sub "Handmade."\n';
const site = (theme: string, font = '') => `az 1\nsite aurora\n  theme ${theme}\n${font}${PAGE}`;
const files = (src: string) => {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, JSON.stringify(r.diagnostics));
  return emit(r.spec, { emitters: WEB_EMITTERS });
};
const read = (fs: { path: string; content: string }[], p: string) => fs.find((f) => f.path === p)?.content ?? '';

for (const theme of Object.keys(THEMES)) {
  test(`${theme}: display serif puts the serif stack on the h1's rule`, () => {
    const css = read(files(site(theme, '  font\n    display serif\n')), 'src/az.css');
    assert.ok(css.includes(`font-family: ${FONT_STACKS.serif}`), 'the serif stack is in az.css');
    const plain = read(files(site(theme)), 'src/az.css');
    assert.ok(!plain.includes(FONT_STACKS.serif), 'CONTROL: without font the serif stack is absent');
  });

  test(`${theme}: theme.css gives the page the body family, and font body overrides it`, () => {
    const own = THEMES[theme as keyof typeof THEMES].type.body;
    assert.ok(read(files(site(theme)), 'src/theme.css').includes(`body { font-family: ${own}; }`));
    assert.ok(read(files(site(theme, '  font\n    body mono\n')), 'src/theme.css')
      .includes(`body { font-family: ${FONT_STACKS.mono}; }`));
  });

  test(`${theme}: naming the theme's own families changes no byte (CONTROL)`, () => {
    // Every theme's stacks are the system ones today, so sans/sans/mono IS
    // the theme: an override that equals the token must not alter output.
    const t = THEMES[theme as keyof typeof THEMES].type;
    const same = Object.entries(FONT_STACKS).filter(([, v]) => v === t.display).map(([k]) => k)[0];
    if (!same) return;
    // AZ.md names the roles the author wrote, so only it may differ.
    const drop = (fs: { path: string; content: string }[]) => fs.filter((f) => f.path !== 'AZ.md');
    assert.deepEqual(drop(files(site(theme, `  font\n    display ${same}\n`))), drop(files(site(theme))));
  });
}

test('AZ.md tells an AI which fonts the site uses and where to change them', () => {
  assert.match(read(files(site('paper', '  font\n    display serif\n')), 'AZ.md'),
    /Fonts: display serif; any role not set keeps the theme's family \(change with `font`/);
  assert.match(read(files(site('paper')), 'AZ.md'), /Fonts: the theme's own families/);
});
