/**
 * @az module palette-page
 * Purpose: `az palette`'s gallery — one static page showing every colour choice, light and dark side by side, with its .az lines.
 * Spec: docs/theme-spec.md §14 · docs/word-quality-gate.md §2 B (the page policy)
 * Exports: palettePage, PALETTE_DIR, PALETTE_FILE, PALETTE_POLICY_NEEDS
 * Edit guide: every colour is a token from the theme package's own CSS generators (scopedSchemeCss, gradientCss,
 *   patternCss) — never a literal here; layout CSS reads tokens only. The page carries the build's policy (csp.ts):
 *   no style attributes, and its one script and one stylesheet are allowed by hash. The choices themselves come
 *   from core's colour.ts, the one list; this file only paints them.
 * Tests: packages/cli/test/palette.test.ts, packages/cli/test/palette-cli.test.ts, scripts/palette.mjs
 */

/**
 * The colour step comes first (PRD §6.1a), and colour is judged by eye. The
 * page shows, per theme, each choice as a card: the `.az` lines that make it,
 * a copy button, and the choice painted in the light and the dark scheme
 * side by side — the theme's swatches; every hue as a primary button and a
 * link; every allowed pair as a gradient button over its two-hue glow; every
 * pattern shape.
 *
 * Several themes on one page: each panel declares its theme and scheme on
 * its own class (scopedSchemeCss), and an accent or a pair only the tokens
 * it changes. A gradient or a pattern is declared on the element that paints
 * it, so its `var()`s resolve to that panel's hues, not the page's.
 */

import {
  ACCENT_NAMES, BREAKPOINT, DEFAULT_THEME, FONT_STACKS, PATTERN_ORIGINS, SPACE, TYPE_SIZE, PATTERN_SHAPES, THEMES, gradientCss, patternCss, patternLayers, schemeCss,
  schemeReferences, scopedSchemeCss, withAccentPair,
  type AccentName, type ColorTokens, type PatternOrigin, type PatternShape, type Scheme, type Theme,
} from '../../theme/src/index.ts';
import { pagePolicy, withPolicy, type PageNeeds } from '../../target-web/src/csp.ts';
import { colourLinesAz, patternWords, type ColourChoices } from '../../core/src/colour.ts';

/** Where `az palette` writes by default: a hidden folder in the build's, so no page route can collide with it. */
export const PALETTE_DIR = '.az-build/.palette';
export const PALETTE_FILE = 'index.html';

/** What the page loads beyond itself: only its `data:` icon. */
export const PALETTE_POLICY_NEEDS: PageNeeds = { dataIcon: true, connect: [], images: [], decoder: false, map: false };

const SCHEMES: readonly Scheme[] = ['light', 'dark'];
/** The tokens a hue decides (accent.ts) and the ones a pair adds (gradient.ts PAIR_TOKENS). */
const HUE_KEYS: readonly (keyof ColorTokens)[] = ['accent', 'accent-hover', 'accent-contrast'];
const PAIR_KEYS: readonly (keyof ColorTokens)[] = [...HUE_KEYS, 'accent2', 'accent2-hover', 'on-gradient'];
/** The swatches each scheme shows, by token, with the name a reader knows them by. */
const SWATCHES: readonly (readonly [keyof ColorTokens, string])[] = [
  ['bg', 'ground (bg)'], ['surface', 'surface'], ['surface-alt', 'surface-alt'],
  ['text', 'text'], ['muted', 'muted'], ['accent', 'accent'],
];

/** One theme as the page paints it: core's choice, with the theme package's tokens. */
interface PaletteTheme {
  readonly name: string;
  readonly description: string;
  readonly theme: Theme;
  readonly defaultScheme: Scheme;
  readonly hues: readonly AccentName[];
  readonly pairs: readonly (readonly [AccentName, AccentName])[];
}

/** A hue name from core's closed set as the theme package's type; the two sets are held equal by test. */
function hueOf(name: string): AccentName {
  const hue = ACCENT_NAMES.find((h) => h === name);
  if (hue === undefined) throw new Error(`palette: hue '${name}' has no ramp in the theme package`);
  return hue;
}

function painted(c: ColourChoices): PaletteTheme[] {
  return c.themes.map((t) => {
    const theme = (THEMES as Readonly<Record<string, Theme>>)[t.name];
    if (theme === undefined) throw new Error(`palette: theme '${t.name}' has no tokens in the theme package`);
    return {
      name: t.name,
      description: t.description,
      theme,
      defaultScheme: theme.defaultScheme ?? 'light',
      hues: t.hues.map(hueOf),
      pairs: t.pairs.map(([a, b]) => [hueOf(a), hueOf(b)] as const),
    };
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A class name for a theme, scheme and hues. */
const cls = (...parts: string[]) => parts.join('-');

/** What the page's CSS must declare, collected while the markup is written. */
interface Sheet {
  readonly blocks: Map<string, string>;
  /** Each theme with a hue or pair applied, once for both schemes: a pair's proof is the slow part. */
  readonly accented: Map<string, Theme>;
}

function declare(sheet: Sheet, selector: string, css: () => string): void {
  if (!sheet.blocks.has(selector)) sheet.blocks.set(selector, css());
}

/** The selector for one theme and scheme, declaring its tokens on first use. */
function schemeClass(sheet: Sheet, t: PaletteTheme, scheme: Scheme): string {
  const name = cls('s', t.name, scheme);
  declare(sheet, `.${name}`, () => scopedSchemeCss(t.theme, scheme, `.${name}`)
    + `.${name} { color-scheme: ${scheme}; font-family: ${t.theme.type.body}; }\n`
    + `.${name} .disp { font-family: ${t.theme.type.display}; font-weight: ${t.theme.type['weight-display']}; }\n`
    + `.${name} .btn { border-radius: ${px(t.theme.radius.md)}; }\n`);
  return name;
}

/** The selector for one hue or pair on a theme and scheme: only the tokens it changes. */
function hueClass(sheet: Sheet, t: PaletteTheme, scheme: Scheme, hues: readonly AccentName[]): string {
  const name = cls('x', t.name, scheme, ...hues);
  const [first, second] = hues;
  const key = cls(t.name, ...hues);
  const theme = sheet.accented.get(key) ?? withAccentPair(t.theme, first, second ?? null);
  sheet.accented.set(key, theme);
  declare(sheet, `.${name}`, () => scopedSchemeCss(theme, scheme, `.${name}`, second ? PAIR_KEYS : HUE_KEYS));
  return name;
}

/** The selector that paints `shape` from the panel's own accent (and its second hue, for a pair). */
function patternClass(sheet: Sheet, shape: PatternShape, origin: PatternOrigin, paired: boolean): string {
  const name = cls('p', shape, origin, ...(paired ? ['pair'] : []));
  // The inks are token references (the same for every theme), as the target passes them.
  const refs = schemeReferences(THEMES[DEFAULT_THEME] as Theme).color;
  declare(sheet, `.${name}`, () => patternCss(
    patternLayers(shape, origin, refs.accent, paired ? refs.accent2 ?? null : null), `.${name}`));
  return name;
}

/** One card: its `.az` lines, a copy button (shown by the script), and a light and a dark panel. */
function card(id: string, lines: readonly string[], panel: (scheme: Scheme) => { classes: string[]; body: string }): string {
  const text = lines.join('\n');
  const panels = SCHEMES.map((scheme) => {
    const p = panel(scheme);
    return `<div class="${['panel', ...p.classes].join(' ')}"><span class="scheme">${scheme}</span>${p.body}</div>`;
  }).join('');
  return `<li class="card" id="${esc(id)}"><div class="card-head"><pre><code>${esc(text)}</code></pre>`
    + `<button type="button" class="copy" data-copy="${esc(text).replace(/\n/g, '&#10;')}" `
    + `aria-label="${esc(`Copy ${lines.map((l) => l.trim()).join(', ')}`)}" hidden>Copy</button></div>`
    + `<div class="duo">${panels}</div></li>`;
}

function swatchCard(sheet: Sheet, t: PaletteTheme): string {
  return card(`${t.name}-colours`, colourLinesAz(t.name), (scheme) => ({
    classes: [schemeClass(sheet, t, scheme)],
    body: `<p class="disp">${esc(t.name)}</p><ul class="sw">${SWATCHES.map(([token, label]) =>
      `<li><span class="chip chip-${token}"></span><span>${esc(label)}</span></li>`).join('')}</ul>`,
  }));
}

function hueCard(sheet: Sheet, t: PaletteTheme, hue: AccentName): string {
  return card(`${t.name}-accent-${hue}`, colourLinesAz(t.name, [hue]), (scheme) => ({
    classes: [schemeClass(sheet, t, scheme), hueClass(sheet, t, scheme, [hue])],
    body: `<span class="btn">Get started</span><span class="lnk">Read the story</span>`,
  }));
}

function pairCard(sheet: Sheet, t: PaletteTheme, pair: readonly [AccentName, AccentName], origin: PatternOrigin): string {
  return card(`${t.name}-pair-${pair.join('-')}`, colourLinesAz(t.name, pair, patternWords('glow', origin)), (scheme) => ({
    classes: [schemeClass(sheet, t, scheme), hueClass(sheet, t, scheme, pair), 'grad', 'pat', patternClass(sheet, 'glow', origin, true)],
    body: `<span class="btn btn-grad">Get started</span><span class="muted">Glow from ${esc(origin)}</span>`,
  }));
}

function patternCard(sheet: Sheet, t: PaletteTheme, shape: PatternShape, origin: PatternOrigin, hue: AccentName | null): string {
  const words = patternWords(shape, origin);
  return card(`${t.name}-pattern-${shape}`, colourLinesAz(t.name, hue ? [hue] : [], words), (scheme) => ({
    classes: [schemeClass(sheet, t, scheme), ...(hue ? [hueClass(sheet, t, scheme, [hue])] : []),
      ...(shape === 'none' ? [] : ['pat', patternClass(sheet, shape, origin, false)])],
    body: `<p class="disp">${esc(shape)}</p><span class="muted">pattern ${esc(words.join(' '))}</span>`,
  }));
}

/** The page's own theme: the default one, light or dark as the browser prefers. */
const CHROME = THEMES[DEFAULT_THEME] as Theme;
const px = (n: number) => `${n}px`;
const S = (step: keyof typeof SPACE) => px(SPACE[step]);

/** The chrome's layout: every size, face and colour is a token. */
const LAYOUT = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: ${FONT_STACKS.sans}; font-size: ${TYPE_SIZE.base}; line-height: 1.5; }
.wrap { max-width: ${px(CHROME.size.container)}; margin: 0 auto; padding: ${S(24)} ${S(16)} ${S(64)}; }
h1 { margin: 0 0 ${S(8)}; font-size: ${TYPE_SIZE['2xl']}; line-height: 1.2; }
h2 { margin: ${S(48)} 0 ${S(4)}; font-size: ${TYPE_SIZE.xl}; }
h3 { margin: ${S(32)} 0 ${S(12)}; font-size: ${TYPE_SIZE.lg}; }
p { margin: 0 0 ${S(8)}; }
.lead, .note { color: var(--az-color-muted); max-width: 70ch; }
a { color: var(--az-color-accent); }
:focus-visible { outline: ${px(CHROME.size.ring)} solid var(--az-color-focus); outline-offset: ${px(CHROME.size['ring-offset'])}; }
.toc ul { display: flex; flex-wrap: wrap; gap: ${S(8)} ${S(16)}; list-style: none; margin: ${S(12)} 0 0; padding: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap: ${S(16)}; list-style: none; margin: 0; padding: 0; }
.card { border: 1px solid var(--az-color-border); border-radius: ${px(CHROME.radius.md)}; background: var(--az-color-surface); overflow: hidden; }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: ${S(8)}; padding: ${S(8)} ${S(12)}; }
.card-head pre { margin: 0; font-family: ${FONT_STACKS.mono}; font-size: ${TYPE_SIZE.sm}; line-height: 1.45; white-space: pre-wrap; }
.copy { font: inherit; font-size: ${TYPE_SIZE.sm}; padding: ${S(4)} ${S(12)}; border-radius: ${px(CHROME.radius.sm)}; border: 1px solid var(--az-color-border-strong); background: var(--az-color-surface-alt); color: var(--az-color-text); cursor: pointer; }
.copy[hidden] { display: none; }
.duo { display: grid; grid-template-columns: 1fr 1fr; }
.panel { display: flex; flex-direction: column; align-items: flex-start; gap: ${S(8)}; min-height: ${S(128)}; padding: ${S(16)}; background-color: var(--az-color-bg); color: var(--az-color-text); }
.scheme { font-size: ${TYPE_SIZE.xs}; letter-spacing: 0.08em; text-transform: uppercase; color: var(--az-color-muted); }
.disp { margin: 0; font-size: ${TYPE_SIZE.lg}; line-height: 1.2; }
.muted { color: var(--az-color-muted); font-size: ${TYPE_SIZE.sm}; }
.btn { display: inline-block; padding: ${S(8)} ${S(16)}; font-weight: 600; background: var(--az-color-accent); color: var(--az-color-accent-contrast); }
.btn-grad { background: var(--az-gradient-accent); color: var(--az-color-on-gradient); }
.lnk { color: var(--az-color-accent); text-decoration: underline; }
.pat { background-image: var(--az-pattern-image); background-size: var(--az-pattern-size); background-position: var(--az-pattern-position); }
.sw { display: grid; gap: ${S(4)}; list-style: none; margin: 0; padding: 0; font-size: ${TYPE_SIZE.sm}; }
.sw li { display: flex; align-items: center; gap: ${S(8)}; }
.chip { flex: none; width: ${S(24)}; height: ${S(24)}; border-radius: ${px(CHROME.radius.sm)}; border: 1px solid var(--az-color-border-strong); }
${SWATCHES.map(([token]) => `.chip-${token} { background: var(--az-color-${token}); }`).join('\n')}
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: ${px(BREAKPOINT.xs)}) { .duo { grid-template-columns: 1fr; } }
`;

/**
 * Shows each copy button where the clipboard can be written, and says what
 * was copied. Without it (or where the clipboard is refused) the lines stay
 * on the page to select by hand.
 */
const SCRIPT = `const status = document.getElementById('copy-status');
if (navigator.clipboard) {
  for (const b of document.querySelectorAll('button[data-copy]')) {
    b.hidden = false;
    b.addEventListener('click', () => {
      const text = b.dataset.copy;
      navigator.clipboard.writeText(text).then(
        () => { status.textContent = 'Copied: ' + text.split('\\n').map((l) => l.trim()).join(', '); },
        () => { status.textContent = 'The clipboard is blocked here: select the lines and copy them.'; });
    });
  }
}
`;

/**
 * The gallery for `p` (already filtered), as one HTML file with its policy.
 * With `hue` (the --accent filter) the patterns are drawn in it; without,
 * in each theme's own accent. Deterministic: the same input, the same bytes.
 */
export function palettePage(p: ColourChoices, accent: string | null = null): string {
  const hue = ACCENT_NAMES.find((h) => h === accent) ?? null;
  const sheet: Sheet = { blocks: new Map(), accented: new Map() };
  const shapes = PATTERN_SHAPES.filter((s) => p.patterns.some((n) => n.name === s));
  // Each pattern card is drawn from the default origin (a pattern line without one gets it).
  const origin = PATTERN_ORIGINS.find((o) => o === p.defaultOrigin) ?? PATTERN_ORIGINS[0];
  const themes = painted(p);

  const sections = themes.map((t) => {
    const list = (items: string[]) => `<ul class="cards">${items.join('')}</ul>`;
    return `<section id="theme-${esc(t.name)}" aria-labelledby="h-${esc(t.name)}">`
      + `<h2 id="h-${esc(t.name)}">${esc(t.name)}</h2><p class="lead">${esc(t.description)}; ${t.defaultScheme} by default</p>`
      + `<h3>Colours</h3>${list([swatchCard(sheet, t)])}`
      + `<h3>Accents</h3><p class="note">One hue: the primary button and links.</p>${list(t.hues.map((h) => hueCard(sheet, t, h)))}`
      + `<h3>Gradient pairs</h3><p class="note">Two hues: a gradient button and a two-hue glow. Either order holds.</p>`
      + (t.pairs.length ? list(t.pairs.map((pair) => pairCard(sheet, t, pair, origin))) : '<p class="note">No pair.</p>')
      + `<h3>Patterns</h3><p class="note">Drawn in the accent, from ${esc(origin)}; origins: ${esc(p.origins.map((o) => o.name).join(', '))}.</p>`
      + list(shapes.map((s) => patternCard(sheet, t, s, origin, hue)))
      + '</section>';
  }).join('\n');

  const css = [
    '/* az palette — every colour from the theme package\'s generators */',
    schemeCss(CHROME),
    LAYOUT,
    gradientCss(true, '.grad'),
    ...sheet.blocks.values(),
  ].join('\n');

  const toc = themes.map((t) => `<li><a href="#theme-${esc(t.name)}">${esc(t.name)}</a></li>`).join('');
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>az palette</title>
    <link rel="icon" href="data:," />
    <style>${css}</style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>Palette</h1>
        <p class="lead">Colour comes first. Pick a theme, an accent or a gradient pair, and a pattern by eye, then paste the lines under <code>site</code> in your .az file. Every choice here holds its contrast floors in light and dark.</p>
        <nav class="toc" aria-label="Themes"><ul>${toc}</ul></nav>
      </header>
      <main>
        <p id="copy-status" class="sr" role="status"></p>
${sections}
      </main>
      <footer><p class="note">Written by az palette from the theme tables. In a terminal: az palette --list.</p></footer>
    </div>
    <script>${SCRIPT}</script>
  </body>
</html>
`;
  return withPolicy(html, pagePolicy(PALETTE_POLICY_NEEDS, html, {}));
}
