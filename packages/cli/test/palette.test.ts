/**
 * The colour choices (core's colour.ts, theme-spec §14) are DERIVED: these
 * tests hold them equal to the tables the compiler and the theme proof use, show that a new theme or a
 * new pair appears without touching the palette, check that every `.az`
 * line it offers compiles clean, and check the gallery page's policy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCENT_NAMES, PATTERN_ORIGINS, PATTERN_SHAPES, THEMES, pairTable, type Theme,
} from '../../theme/src/index.ts';
import { ACCENT_PAIRS } from '../../core/src/accent-pairs.ts';
import { THEME_NAMES } from '../../core/src/link.ts';
import { compile, formatDiagnostics } from '../../core/src/index.ts';
import { ownDigests, inlineScripts, inlineStyles, styleAttributes } from '../../target-web/src/csp.ts';
import {
  COLOUR_TABLES, colourChoices, colourChoicesFrom, colourChoicesJson, colourLinesAz, filterColourChoices, formatColourChoices,
} from '../../core/src/colour.ts';
import { palettePage } from '../src/palette-page.ts';
import { BUNDLED_WORDS, loadWords } from '../src/words.ts';

const p = colourChoices();
const unordered = (table: Readonly<Record<string, readonly string[]>>) =>
  ACCENT_NAMES.flatMap((a, i) => ACCENT_NAMES.slice(i + 1).filter((b) => table[a]?.includes(b)).map((b) => `${a} ${b}`));

test('the themes are THEMES, in order, each with its az explain line', () => {
  assert.deepEqual(p.themes.map((t) => t.name), Object.keys(THEMES));
  for (const t of p.themes) assert.equal(t.description, THEME_NAMES[t.name]);
});

test('hues, shapes and origins are the theme package\'s closed sets', () => {
  assert.deepEqual(p.hues.map((h) => h.name), [...ACCENT_NAMES]);
  assert.deepEqual(p.patterns.map((s) => s.name), [...PATTERN_SHAPES]);
  assert.deepEqual(p.origins.map((o) => o.name), [...PATTERN_ORIGINS]);
  for (const t of p.themes) assert.deepEqual([...t.hues], [...ACCENT_NAMES], `${t.name}: every hue`);
});

test('each theme\'s pairs are exactly the generator\'s proof (pairTable) and core\'s table', () => {
  for (const t of p.themes) {
    const listed = t.pairs.map(([a, b]) => `${a} ${b}`);
    assert.deepEqual(listed, unordered(pairTable((THEMES as Record<string, Theme>)[t.name])), `${t.name}: the proof`);
    assert.deepEqual(listed, unordered(ACCENT_PAIRS[t.name]), `${t.name}: core's table`);
  }
});

test('a new theme and a new pair show up without touching the palette', () => {
  const pairs = { ...ACCENT_PAIRS, probe: { ...ACCENT_PAIRS.clay, violet: ['indigo'], indigo: ['violet'] } };
  const grown = colourChoicesFrom({ ...COLOUR_TABLES, themes: { ...THEME_NAMES, probe: 'A theme added later' }, pairs });
  const probe = grown.themes.find((t) => t.name === 'probe');
  assert.ok(probe, 'the new theme is listed');
  assert.ok(probe.pairs.some(([a, b]) => a === 'violet' && b === 'indigo'), 'the new pair is listed');
  assert.ok(!probe.pairs.some(([a, b]) => a === 'violet' && b === 'blue'), 'a pair the table drops is gone');
  assert.match(formatColourChoices(grown), /theme probe/);
});

test('CONTROL: a theme the pair generator has not seen is refused, not shown without pairs', () => {
  assert.throws(() => colourChoicesFrom({ ...COLOUR_TABLES, themes: { ...THEME_NAMES, unseen: 'Not generated' } }), /gen-pairs/);
});

test('every .az line the palette offers compiles with no diagnostic', () => {
  const manifests = loadWords(BUNDLED_WORDS, null, { code: false }).manifests;
  const json = colourChoicesJson(p);
  const blocks: string[][] = [];
  for (const t of json.themes) {
    blocks.push([t.az], t.example as string[]);
    for (const a of t.accents) blocks.push([t.az, `  ${a.az}`]);
    for (const pair of t.pairs) {
      const [a, b] = pair.hues;
      blocks.push([t.az, `  ${pair.az}`], [t.az, `  accent ${b} ${a}`]);
    }
    for (const s of json.patterns) for (const line of s.az) blocks.push([t.az, `  ${line}`]);
  }
  for (const lines of blocks) {
    const src = `az 1\nsite probe\n${lines.map((l) => `  ${l}`).join('\n')}\npage /\n  hero center\n    title "Probe"\n`;
    const r = compile(src, { manifests });
    assert.equal(r.diagnostics.length, 0, `${lines.join(' / ')}\n${formatDiagnostics(r.diagnostics, 'probe.az')}`);
  }
  // CONTROL: every theme's every choice was compiled — none skipped by the loops above.
  const patternLines = json.patterns.reduce((n, s) => n + s.az.length, 0);
  assert.equal(blocks.length, json.themes.reduce((n, t) => n + 2 + t.accents.length + 2 * t.pairs.length + patternLines, 0));
  assert.ok(blocks.length >= Object.keys(THEMES).length * (2 + ACCENT_NAMES.length + PATTERN_SHAPES.length));
});

test('CONTROL: the same check fails a pair the theme refuses', () => {
  const manifests = loadWords(BUNDLED_WORDS, null, { code: false }).manifests;
  const r = compile('az 1\nsite probe\n  theme signal\n    accent green amber\npage /\n  hero center\n    title "Probe"\n', { manifests });
  assert.ok(r.diagnostics.some((d) => d.code === 'AZ1423'));
});

test('filters: one theme; one hue with its pairs written hue first; an unknown name suggests', () => {
  const clay = filterColourChoices(p, { theme: 'clay', accent: 'rose' });
  assert.ok(clay.ok);
  assert.deepEqual(clay.choices.themes.map((t) => t.name), ['clay']);
  assert.deepEqual(clay.choices.themes[0].hues, ['rose']);
  assert.deepEqual(clay.choices.themes[0].pairs.map((x) => x.join(' ')), ACCENT_PAIRS.clay.rose.map((h) => `rose ${h}`));
  const typo = filterColourChoices(p, { accent: 'violett' });
  assert.ok(!typo.ok && /did you mean 'violet'/.test(typo.message));
  assert.ok(!filterColourChoices(p, { theme: 'nope' }).ok);
});

test('colourLinesAz writes settings indented under theme', () => {
  assert.deepEqual(colourLinesAz('clay', ['violet', 'rose'], ['glow', 'top']), ['theme clay', '  accent violet rose', '  pattern glow top']);
});

const one = filterColourChoices(p, { theme: 'volt' });
assert.ok(one.ok);
const page = palettePage(one.choices);

test('the page is deterministic', () => {
  assert.equal(palettePage(one.choices), page);
});

test('the page shows every choice of its theme as a card with its .az lines', () => {
  const volt = one.choices.themes[0];
  assert.match(page, /id="volt-colours"/);
  for (const h of volt.hues) assert.match(page, new RegExp(`id="volt-accent-${h}"`));
  for (const [a, b] of volt.pairs) assert.ok(page.includes(`id="volt-pair-${a}-${b}"`) && page.includes(`accent ${a} ${b}`), `${a} ${b}`);
  for (const s of PATTERN_SHAPES) assert.match(page, new RegExp(`id="volt-pattern-${s}"`));
  for (const label of ['ground (bg)', 'surface', 'text', 'muted', 'accent']) assert.ok(page.includes(`<span>${label}</span>`), label);
  assert.equal((page.match(/class="panel /g) ?? []).length, 2 * (1 + volt.hues.length + volt.pairs.length + PATTERN_SHAPES.length));
});

test('the page carries the build\'s policy: its one script and stylesheet by hash, no style attribute, nothing unsafe', () => {
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page)?.[1] ?? '';
  assert.match(policy, /^default-src 'self'; script-src 'self' 'sha256-/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|unsafe-hashes/);
  assert.equal(inlineScripts(page).length, 1);
  assert.equal(inlineStyles(page).length, 1);
  assert.deepEqual(styleAttributes(page), []);
  for (const digest of ownDigests(page)) assert.ok(policy.includes(`'${digest}'`), digest);
});

test('the page holds no colour literal of its own: every colour is a theme declaration', () => {
  const css = inlineStyles(page)[0];
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  // Every hsl() is a custom-property declaration the theme generators wrote.
  for (const line of css.split('\n').filter((l) => /hsl\(/.test(l))) assert.match(line, /^\s*--az-color-[a-z0-9-]+: hsl\(/, line);
});
