/**
 * feature-spec §7 through the real build: an icon is read from the project
 * through the asset sandbox, sanitised, and inlined — never copied, never
 * trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/az.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

const SITE = (icon: string) => `az 1
site aurora
page /
  hero center
    title "Built in the dark"
  feature grid
    title "Made properly"
    item "Hand-cut leather"
      icon ${icon}
      text "Cut by hand."
    item "Sewn, not glued"
      text "A stitched welt."
`;

function project(iconSource: string | null, iconPath = 'icons/knife.svg') {
  const dir = mkdtempSync(join(tmpdir(), 'az-icon-'));
  writeFileSync(join(dir, 'site.az'), SITE(`./${iconPath}`), 'utf8');
  if (iconSource !== null) {
    mkdirSync(join(dir, 'icons'), { recursive: true });
    writeFileSync(join(dir, iconPath), iconSource, 'utf8');
  }
  return { dir, file: join(dir, 'site.az'), out: join(dir, 'out') };
}
const run = (p: { file: string; out: string }) => build({ source: p.file, outDir: p.out, wordsDir: WORDS });
const app = (p: { out: string }) => readFileSync(join(p.out, 'src/App.tsx'), 'utf8');

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" stroke="#1d1d1f"><path d="M4 20L20 4"/></svg>';

test('an icon is inlined, sanitised, in the theme colour, and not copied as a file', () => {
  const p = project(ICON);
  const r = run(p);
  assert.equal(r.ok, true, r.report);
  const out = app(p);
  assert.match(out, /"tag": "svg"/);
  assert.match(out, /"d": "M4 20L20 4"/);
  assert.match(out, /"stroke": "currentColor"/);
  assert.doesNotMatch(out, /#1d1d1f/, 'the hard-coded colour does not ship');
  assert.ok(!existsSync(join(p.out, 'public/icons/knife.svg')), 'inlined, so not copied');
});

test('SECURITY: a hostile icon ships none of its payload', () => {
  const p = project('<svg viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><foreignObject><iframe src="https://evil.example"/></foreignObject><path d="M0 0" onclick="alert(3)"/></svg>');
  const r = run(p);
  assert.equal(r.ok, true, r.report);
  assert.doesNotMatch(app(p), /alert|onload|onclick|script|iframe|evil\.example|foreignObject/i);
});

test('SECURITY: an icon symlinked outside the project is refused and nothing is written', (t) => {
  const p = project(null);
  const outside = mkdtempSync(join(tmpdir(), 'az-outside-'));
  writeFileSync(join(outside, 'secret.svg'), ICON, 'utf8');
  mkdirSync(join(p.dir, 'icons'));
  try {
    symlinkSync(join(outside, 'secret.svg'), join(p.dir, 'icons/knife.svg'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks not permitted here'); return; }
    throw e;
  }
  const r = run(p);
  assert.equal(r.ok, false);
  assert.match(r.report, /resolves outside the project/);
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')));
});

test('a missing icon fails the build with its path', () => {
  const r = run(project(null));
  assert.equal(r.ok, false);
  assert.match(r.report, /icon: '\.\/icons\/knife\.svg' does not exist/);
});

test('an icon with a character reference XML does not allow (&#xD800;, &#0;) fails the build with its path — no crash, nothing written', () => {
  for (const ref of ['&#xD800;', '&#0;']) {
    const p = project(`<svg viewBox="0 0 1 1"><path d="M0 0" id="a${ref}"/></svg>`);
    const r = run(p);
    assert.equal(r.ok, false, ref);
    assert.equal(r.exit, 1, ref);
    assert.ok(r.report.includes(`icon: './icons/knife.svg' has a character reference to a character XML does not allow (${ref})`), r.report);
    assert.ok(!existsSync(join(p.out, 'src/App.tsx')), 'a failed build writes nothing');
  }
});

test('SECURITY: an icon with a DOCTYPE (entity tricks) fails the build, it is not guessed at', () => {
  const p = project('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"><path d="&x;"/></svg>');
  const r = run(p);
  assert.equal(r.ok, false);
  assert.match(r.report, /icon: '\.\/icons\/knife\.svg' has a DOCTYPE/);
  assert.ok(!existsSync(join(p.out, 'src/App.tsx')), 'a failed build writes nothing');
});
