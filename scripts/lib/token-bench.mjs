/**
 * The token benchmark's working parts (docs/token-benchmark.md): the corpus,
 * the representations of one site, and the counting. `scripts/token-benchmark.mjs`
 * runs them over the whole corpus; `token-bench.test.mjs` runs them on two sites.
 *
 * Every representation of a site comes from ONE compile of its source:
 *
 *   az          the .az source, full-line `#` comments left out
 *   specMin     the Spec as `az spec` prints it, minified
 *   specPretty  the Spec exactly as `az spec` prints it
 *   tree        the Spec as a `{type, props, children}` component tree (componentTree)
 *   html        the pre-rendered body markup of every page (htmlBody)
 *   htmlShared  the same, with the nav and footer written once for the site
 *   appTsx      the generated src/App.tsx
 *
 * The compile is the real one: `specOf` and `build` from the CLI, with the
 * bundled words, into a temporary directory. Nothing here changes what they produce.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, specOf, wordsFor } from '../../packages/cli/src/az.ts';
import { SITE_DEFAULTS } from '../../packages/core/src/spec.ts';
import { COMPONENT_TAG } from '../../packages/core/src/emit-contract.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WORDS = join(ROOT, 'packages/words');
const CLI = join(ROOT, 'packages/cli/bin/az.js');

/** `az backend schema` writes one small lock file; past this it is killed. */
const SCHEMA_MS = 60_000;

/** The representations, in table order. */
export const REPRESENTATIONS = ['az', 'specMin', 'specPretty', 'tree', 'html', 'htmlShared', 'appTsx'];

/** The representations that carry an inlined file's content themselves (inlinedFiles). */
const INLINES = new Set(['html', 'htmlShared', 'appTsx']);

/** The rule-of-thumb ratio the approximation uses (docs/token-benchmark.md §4.4). */
export const CHARS_PER_TOKEN = 4;

/**
 * The tokenizers, by the encoding name each one implements. The package that
 * provides them is mapped in package.json `imports` (`#tokenizer/*`), so the
 * choice lives in one place and can be swapped there.
 */
export const ENCODINGS = ['o200k_base', 'cl100k_base'];

/** The encoding the headline figures use. */
export const PRIMARY_ENCODING = ENCODINGS[0];

/** Each encoding's `countTokens`, and the package name and version that provided it. */
export async function loadCounters() {
  const counters = {};
  let provider = null;
  for (const name of ENCODINGS) {
    const specifier = `#tokenizer/${name}`;
    const mod = await import(specifier);
    if (typeof mod.countTokens !== 'function') throw new Error(`${specifier} has no countTokens`);
    counters[name] = mod.countTokens;
    provider ??= packageOf(fileURLToPath(import.meta.resolve(specifier)));
  }
  return { counters, provider };
}

/** The nearest package.json above `file`: its name and version. */
function packageOf(file) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const p = join(dir, 'package.json');
    if (!existsSync(p)) continue;
    const { name, version } = JSON.parse(readFileSync(p, 'utf8'));
    if (name && version) return `${name}@${version}`;
  }
  throw new Error(`no package.json with a name and version above ${file}`);
}

/**
 * A `const NAME = \`…\`;` template literal from a script, as text. The data
 * e2e site and the combined site live in their scripts; reading them from
 * there keeps the benchmark on the exact sources those checks build. A
 * literal with a substitution or an escape is refused, since its text would
 * then not be its value.
 */
export function literal(file, name) {
  const text = readFileSync(file, 'utf8');
  const open = `\nconst ${name} = \``;
  const start = text.indexOf(open);
  if (start < 0) throw new Error(`${file}: no \`const ${name} = \\\`\``);
  const from = start + open.length;
  const end = text.indexOf('\n`;', from);
  if (end < 0) throw new Error(`${file}: ${name} is not closed by a line \`;`);
  const value = text.slice(from, end + 1);
  if (value.includes('${') || value.includes('\\')) throw new Error(`${file}: ${name} has a substitution or an escape`);
  return value;
}

const preview = (word) => ({ from: join(WORDS, word, 'preview-assets'), to: 'preview-assets' });

/**
 * Every site in the corpus: `{ name, group, source, assets: [{from, to}], files: {path: text}, schema? }`.
 * `assets` are copied beside the source; `files` are written there (the
 * data site's own component, which no representation counts); `schema`
 * records the data lock first with the real `az backend schema`, as
 * scripts/data-e2e.mjs does. The lock is derived from the source, so no
 * representation counts it either.
 */
export function corpus() {
  const sites = [];
  sites.push({ name: 'minimal', group: 'fixture', source: readFileSync(join(ROOT, 'fixtures/minimal.az'), 'utf8'), assets: [], files: {} });
  const fixture = join(ROOT, 'packages/core/test');
  sites.push({
    name: 'grammar-fixture', group: 'fixture',
    source: readFileSync(join(fixture, 'fixture-site.az'), 'utf8'),
    assets: [{ from: join(fixture, 'fixture-assets'), to: '.' }], files: {},
  });
  for (const word of readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'preview.az'))).sort()) {
    for (const f of readdirSync(join(WORDS, word)).filter((f) => /^preview(\.[a-z0-9-]+)?\.az$/.test(f)).sort()) {
      const variant = f.slice('preview.'.length, -'.az'.length);
      sites.push({
        name: variant ? `${word}.${variant}` : word, group: 'preview',
        source: readFileSync(join(WORDS, word, f), 'utf8'), assets: [preview(word)], files: {},
      });
    }
  }
  sites.push({
    name: 'combined', group: 'site',
    source: literal(join(ROOT, 'scripts/lighthouse.mjs'), 'COMBINED'),
    assets: ['hero', 'nav', 'feature', 'gallery'].map(preview), files: {},
  });
  const dataE2e = join(ROOT, 'scripts/data-e2e.mjs');
  sites.push({
    name: 'data-e2e', group: 'site', source: literal(dataE2e, 'SITE'), assets: [],
    files: { 'custom/Notes.tsx': literal(dataE2e, 'NOTES_COMPONENT') }, schema: true,
  });
  for (const name of ['ledger', 'harbour']) {
    sites.push({ name, group: 'site', source: readFileSync(join(ROOT, `scripts/token-benchmark/${name}.az`), 'utf8'), assets: [], files: {} });
  }
  return sites;
}

/** The source without its full-line comments: what an author must write. */
export function azText(source) {
  return source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

/** A value with every null, empty string, empty array and empty object left out. */
function pruned(value) {
  if (Array.isArray(value)) return value.map(pruned);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const p = pruned(v);
    if (p === null || p === undefined || p === '') continue;
    if (Array.isArray(p) && p.length === 0) continue;
    if (typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0) continue;
    out[k] = p;
  }
  return out;
}

/**
 * The Spec as a component tree: the `{type, props, children}` shape a "UI as
 * JSON" format uses. The mapping (docs/token-benchmark.md §2.4):
 *
 *   - the site is `{type: "Site"}`; its inherited blocks, then its pages, are its children;
 *   - a page is `{type: "Page", props: {route, description?}}`; its blocks are its children;
 *   - a block is `{type: <word>}`, with `variant`, each modifier as `<name>: true`,
 *     its positional values as `args` (values only), `as`, and its props;
 *   - a value the source did not need to write is left out, as a component
 *     library applies its own defaults: a prop equal to its word's declared
 *     default, a variant that is the word's first, a site setting equal to
 *     the Spec's site default, a site-scoped value repeated on a page block;
 *   - every null, empty string, empty list and empty object is left out.
 *
 * Nothing is renamed or abbreviated; keys are the Spec's own.
 */
export function componentTree(spec, manifests) {
  const scoped = spec.site.scoped ?? {};
  const block = (b) => {
    const m = manifests.get(b.word);
    const props = {};
    if (b.variant !== null && b.variant !== (m?.variants?.[0] ?? null)) props.variant = b.variant;
    for (const mod of b.modifiers) props[mod] = true;
    if (b.args.length > 0) props.args = b.args.map((a) => a.value);
    if (b.as !== null) props.as = b.as;
    for (const [k, v] of Object.entries(b.props)) {
      const declared = m?.props?.[k]?.default;
      if (declared !== undefined && String(declared) === v) continue;
      if (scoped[b.word]?.[k] === v) continue;
      props[k] = v;
    }
    if (b.from) props.from = b.from;
    return pruned({ type: b.word, props, children: b.children.map(block) });
  };
  const { inherited, ...site } = spec.site;
  const siteProps = {};
  for (const [k, v] of Object.entries(site)) {
    if (k in SITE_DEFAULTS && SITE_DEFAULTS[k] === v) continue;
    siteProps[k] = v;
  }
  return pruned({
    type: 'Site',
    props: siteProps,
    children: [
      ...inherited.map(block),
      ...spec.pages.map((p) => pruned({ type: 'Page', props: { route: p.route, description: p.description }, children: p.blocks.map(block) })),
    ],
  });
}

/**
 * The PAGES table of a generated App.tsx, parsed. It is the emitter's own
 * sorted JSON (target-web emit.ts `stableJson`, two-space indent), so the
 * array closes on the first `]` at the start of a line.
 */
export function pagesOf(appTsx) {
  const open = appTsx.indexOf('\nconst PAGES: ');
  const assign = open < 0 ? -1 : appTsx.indexOf('[] = [', open);
  if (assign < 0) throw new Error('App.tsx: no PAGES table');
  const from = assign + '[] = '.length;
  const end = appTsx.indexOf('\n]', from);
  if (end < 0) throw new Error('App.tsx: PAGES is not closed');
  return JSON.parse(appTsx.slice(from, end + 2));
}

/** A node tree without the author's own components (raw / slot), whose markup is their code, not the site's. */
function withoutComponents(node) {
  if (typeof node === 'string') return node;
  return { ...node, children: (node.children ?? []).filter((c) => typeof c === 'string' || c.tag !== COMPONENT_TAG).map(withoutComponents) };
}

/** Elements without a closing tag; the runtime's own list (target-web emit.ts runtimeTsx VOID). */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Elements whose text is written as is, not escaped (HTML raw text elements). */
const RAW_TEXT = new Set(['script', 'style']);

/** Attributes the server renderer writes as present-or-absent (`name=""`), by their HTML names. */
const BOOLEAN = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled',
  'formnovalidate', 'hidden', 'inert', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate',
  'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected',
]);

/** Attributes the server renderer writes in their React spelling, on the elements it renders specially. */
const REACT_SPELLING = { input: { autocomplete: 'autoComplete' }, img: { srcset: 'srcSet' } };

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/**
 * An emitted node as the pre-render writes it (the runtime's Node, rendered
 * to a string): attributes in the node's order, a boolean attribute as
 * `name=""` or left out, a void element closed with `/>`, raw text elements
 * unescaped, `<!-- -->` between two adjacent text children, and an
 * attribute in REACT_SPELLING written that way. Checked
 * against real pre-rendered pages in docs/token-benchmark.md §2.5.
 */
export function prerendered(node) {
  if (typeof node === 'string') return escapeText(node);
  if (node.style && Object.keys(node.style).length > 0) throw new Error(`<${node.tag}> carries an inline style; the emitter moves styles to classes`);
  const attrs = [];
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    if (BOOLEAN.has(k)) {
      if (v !== '') attrs.push(`${k}=""`);
      continue;
    }
    attrs.push(`${REACT_SPELLING[node.tag]?.[k] ?? k}="${escapeText(String(v))}"`);
  }
  const open = `<${node.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
  if (VOID.has(node.tag)) return `${open}/>`;
  const raw = RAW_TEXT.has(node.tag);
  let inner = '';
  let lastText = false;
  for (const c of node.children ?? []) {
    const text = typeof c === 'string';
    if (text && lastText) inner += '<!-- -->';
    inner += text ? (raw ? c : escapeText(c)) : prerendered(c);
    lastText = text;
  }
  return `${open}>${inner}</${node.tag}>`;
}

/**
 * Every page's body markup, as the pre-render writes it into the page: the
 * runtime's site, page and <main> wrappers (target-web emit.ts runtimeTsx)
 * around the page's emitted nodes, serialised by `prerendered`.
 *
 * With `shared`, each distinct run of chrome (the nav before <main>, the
 * footer after it) is written once for the whole site instead of once per
 * page: markup with an include for what pages repeat.
 */
export function htmlBody(appTsx, spec, { shared = false } = {}) {
  const site = (children) => ({
    tag: 'div',
    attrs: { class: 'az-site', 'data-site': spec.site.name, 'data-width': spec.site.width, 'data-theme': spec.site.theme },
    children,
  });
  const chrome = new Set();
  const pages = pagesOf(appTsx).map((page) => {
    const nodes = page.nodes.filter((n) => typeof n === 'string' || n.tag !== COMPONENT_TAG).map(withoutComponents);
    const lead = nodes.slice(0, page.lead);
    const tail = nodes.slice(nodes.length - page.tail);
    const main = { tag: 'main', attrs: { id: 'az-content', tabindex: '-1', class: 'az-main' }, children: nodes.slice(page.lead, nodes.length - page.tail) };
    if (shared) for (const n of [...lead, ...tail]) chrome.add(prerendered(n));
    const wrapper = {
      tag: 'div',
      attrs: { class: 'az-page', 'data-route': page.route, ...(page.layout ? { 'data-layout': page.layout } : {}) },
      children: shared ? [main] : [...lead, main, ...tail],
    };
    return prerendered(site([wrapper]));
  });
  return [...chrome, ...pages].join('\n');
}

/**
 * The text files the emitter writes INTO the markup: a feature item's `icon`
 * (inlined SVG, words/feature/emit.web.ts) and a `text` body that is a file
 * (markdown, target-web emit.ts). The html and appTsx carry their content;
 * every other representation only names them, so their text is counted once
 * on top of those (docs/token-benchmark.md §2.8).
 */
export function inlinedFiles(spec) {
  const paths = new Set();
  const walk = (b) => {
    if (b.word === 'item' && /\.svg$/i.test(b.props.icon ?? '')) paths.add(b.props.icon);
    if (b.word === 'text' && /^\.\.?\/.*\.md$/i.test(b.props.body ?? '')) paths.add(b.props.body);
    b.children.forEach(walk);
  };
  spec.site.inherited.forEach(walk);
  for (const p of spec.pages) p.blocks.forEach(walk);
  return [...paths].sort();
}

/**
 * Lay a site out in a fresh directory, compile and build it there (with its
 * responsive images, as `az build` writes them) and return every
 * representation as text, with the Spec they came from. `imageCache` is
 * where resized images are kept (one for a whole run spares re-encoding);
 * by default one inside the directory. The directory is
 * removed before this returns.
 */
export function representations(site, { imageCache } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-token-bench-'));
  try {
    for (const { from, to } of site.assets) if (existsSync(from)) cpSync(from, join(dir, to), { recursive: true });
    for (const [path, text] of Object.entries(site.files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const file = join(dir, 'site.az');
    writeFileSync(file, site.source);
    if (site.schema) {
      execFileSync(process.execPath, [CLI, 'backend', 'schema', file], {
        env: { ...process.env, AZ_WORDS: WORDS }, encoding: 'utf8', timeout: SCHEMA_MS, killSignal: 'SIGKILL', stdio: 'pipe',
      });
    }
    const options = { source: file, wordsDir: WORDS, projectWordsDir: null };
    const { json, report } = specOf(options);
    if (!json) throw new Error(`${site.name}: does not compile\n${report}`);
    const outcome = build({ ...options, outDir: join(dir, 'out'), imageCache: imageCache ?? join(dir, 'image-cache') });
    if (!outcome.ok) throw new Error(`${site.name}: does not build\n${outcome.report}`);
    const app = outcome.files.find((f) => f.path === 'src/App.tsx');
    if (!app) throw new Error(`${site.name}: the build has no src/App.tsx`);
    const spec = JSON.parse(json);
    const manifests = wordsFor(options, false).manifests;
    const inlined = inlinedFiles(spec).map((p) => readFileSync(resolve(dir, p), 'utf8'));
    return {
      spec,
      inlined,
      text: {
        az: azText(site.source),
        specMin: JSON.stringify(spec),
        specPretty: json,
        tree: JSON.stringify(componentTree(spec, manifests)),
        html: htmlBody(app.content, spec),
        htmlShared: htmlBody(app.content, spec, { shared: true }),
        appTsx: app.content,
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Characters and tokens (per encoding) of one text. */
function count(text, counters) {
  const tokens = {};
  for (const [name, fn] of Object.entries(counters)) tokens[name] = fn(text);
  return { chars: text.length, tokens };
}

/** One site's measurement: per representation, chars, tokens and the approximation. */
export function measure(site, counters, options = {}) {
  const r = representations(site, options);
  const extra = r.inlined.join('\n');
  const result = { name: site.name, group: site.group, pages: r.spec.pages.length, inlinedFiles: r.inlined.length, reps: {} };
  for (const rep of REPRESENTATIONS) {
    // The markup already holds the inlined files' content; the rest only name them.
    const text = INLINES.has(rep) || extra === '' ? r.text[rep] : `${r.text[rep]}\n${extra}`;
    const c = count(text, counters);
    result.reps[rep] = { ...c, approxTokens: Math.round(c.chars / CHARS_PER_TOKEN) };
  }
  return result;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (x, places = 2) => Math.round(x * 10 ** places) / 10 ** places;

/**
 * Per representation, the ratio of its tokens to the .az source's, over every
 * site: the median, the worst case (the smallest ratio: where .az saves
 * least) and the best, plus corpus totals. Also every site where a
 * representation is NOT larger than the .az source.
 */
export function summarise(results, encoding = PRIMARY_ENCODING) {
  const out = { encoding, sites: results.length, ratios: {}, totals: {}, azNotSmallest: [] };
  for (const rep of REPRESENTATIONS) {
    const tokens = results.reduce((n, r) => n + r.reps[rep].tokens[encoding], 0);
    const chars = results.reduce((n, r) => n + r.reps[rep].chars, 0);
    out.totals[rep] = { tokens, chars, charsPerToken: round(chars / tokens) };
    if (rep === 'az') continue;
    const ratios = results.map((r) => ({ name: r.name, ratio: r.reps[rep].tokens[encoding] / r.reps.az.tokens[encoding] }));
    const sorted = [...ratios].sort((a, b) => a.ratio - b.ratio || a.name.localeCompare(b.name));
    out.ratios[rep] = {
      median: round(median(ratios.map((x) => x.ratio))),
      worst: { site: sorted[0].name, ratio: round(sorted[0].ratio) },
      best: { site: sorted.at(-1).name, ratio: round(sorted.at(-1).ratio) },
    };
    for (const r of results) {
      if (r.reps[rep].tokens[encoding] <= r.reps.az.tokens[encoding]) out.azNotSmallest.push({ site: r.name, representation: rep });
    }
  }
  return out;
}
