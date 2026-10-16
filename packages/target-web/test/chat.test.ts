/**
 * src/chat/runtime.tsx (chat-block-spec §7): generated only for a site with a
 * chat panel, it hands the overlay runtime's chat.ts the backend's address
 * and the auth adapter's session, and App renders it only then. A site
 * without chat emits exactly what it did before. The runtime in real
 * browsers is scripts/chat-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { CHAT_FILE, CHAT_RUNTIME_FILES, MAP_RUNTIME_FILES, MAP_TILES_ENV, chatTsx, mapCss } from '../src/chat.ts';
import { PINS } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const SITE = (model: string, page: string) => `az 1
site shop
  auth
    adapter azbackend
  backend
    database sqlite
    email smtp
${model}page /
  hero center
    title "Hi"
${page}page /login
  auth login
    alt "Back" /
`;

const project = (src: string) => {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, r.diagnostics.map((d) => d.message).join('\n'));
  return emitProject(r.spec, { emitters: WEB_EMITTERS });
};

test('a site with a chat panel gets the chat module, and App renders it', () => {
  const p = project(SITE('    model default\n', '  chat panel\n'));
  assert.equal(p.chat, true);
  const chat = p.files.find((f) => f.path === CHAT_FILE);
  assert.equal(chat?.content, chatTsx('src/az'));
  const app = p.files.find((f) => f.path === 'src/App.tsx')!.content;
  assert.match(app, /import \{ ChatRuntime \} from "\.\/chat\/runtime\.tsx";/);
  assert.match(app, /<ChatRuntime \/>/);
});

test('the module reads the backend address as the auth adapter does, and the session from the adapter', () => {
  const text = chatTsx('src/az');
  assert.match(text, /import \{ attachChat \} from "\.\.\/az\/chat\.ts";/);
  assert.match(text, /import \{ adapter \} from "\.\.\/az-auth\/config\.ts";/);
  assert.match(text, /const BASE: string = import\.meta\.env\.AZ_PUBLIC_BACKEND_URL \?\? "";/);
  // The account's id (or null) — who may ask, and whom the kept chat is bound to (chat-block-spec §19.11).
  assert.match(text, /return adapter\.session\(\)\?\.user\.id \?\? null;/);
  assert.match(text, /onSession: \(fn\) => adapter\.onChange\(\(session\) => fn\(session\?\.user\.id \?\? null\)\)/);
  // Nothing but the public backend URL is read from the environment.
  assert.deepEqual([...text.matchAll(/import\.meta\.env\.([A-Z_]+)/g)].map((m) => m[1]), ['AZ_PUBLIC_BACKEND_URL']);
});

test('CONTROL: a site without a chat panel emits exactly what it did before', () => {
  const p = project(SITE('', ''));
  assert.equal(p.chat, false);
  assert.equal(p.files.some((f) => f.path === CHAT_FILE), false);
  assert.doesNotMatch(p.files.find((f) => f.path === 'src/App.tsx')!.content, /Chat/);
});

/* ---- C2b (chat-block-spec §20.4, §20.6, §20.7) ---------------------------- */

const file = (p: ReturnType<typeof project>, path: string) => p.files.find((f) => f.path === path)?.content ?? '';

/* ---- C3 (chat-block-spec §3.1): a float under site, on every page --------- */

const FLOATING = `az 1
site shop
  auth
    adapter azbackend
  backend
    database sqlite
    email smtp
    model default
  chat float
    title "Ask Shop"
    allow anyone
    show cta
page /
  hero center
    title "Hi"
page /about
  hero center
    title "About"
page /quiet
  chat none
page /help
  chat panel
    allow anyone
page /login
  auth login
    alt "Back" /
`;

test('a site whose only chat is the site\'s float gets the chat module; the launcher is on every page but the one that says none and the one with its own panel', () => {
  const p = project(FLOATING);
  assert.equal(p.chat, true, 'the float counts as a chat');
  assert.ok(p.files.some((f) => f.path === CHAT_FILE));
  const app = file(p, 'src/App.tsx');
  // /, /about and /login show the float; /quiet says none; /help has its panel; the shared page its read-only shell.
  assert.equal((app.match(/data-az-chat-launcher/g) ?? []).length, 3);
  assert.equal((app.match(/az-chat--panel/g) ?? []).length, 2, '/help and the shared page');
  for (const route of ['/', '/about', '/login']) assert.ok(app.includes(`\\"page\\":\\"${route}\\"`), `${route} asks from ${route}`);
  assert.ok(!app.includes('\\"page\\":\\"/quiet\\"'));
  // The shared page's shell is a panel whatever chat it was made from (a float has nothing to open there).
  assert.match(app, /\\"shared\\":true/);
});

test('a chat that shows components gets the shared-answer page: read-only, noindex, its parts every chat\'s', () => {
  const p = project(SITE('    model default\n', '  chat panel\n    show chart cta\n    allow anyone\n'));
  const html = file(p, 'chat/shared/index.html');
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.doesNotMatch(file(p, 'index.html'), /noindex/, 'CONTROL: the chat page itself is indexed as before');
  const app = file(p, 'src/App.tsx');
  assert.match(app, /"\/chat\/shared"/);
  assert.match(app, /\\"shared\\":true/, 'the shell says it is the shared page');
  assert.match(app, /A shared answer/);
});

test('CONTROL: a prose-only chat gets no shared page; a site without chat neither', () => {
  assert.equal(file(project(SITE('    model default\n', '  chat panel\n')), 'chat/shared/index.html'), '');
  assert.equal(file(project(SITE('', '')), 'chat/shared/index.html'), '');
});

test('a chat that draws charts gets the theme\'s six series colours, in both schemes; every other site does not', () => {
  const charts = file(project(SITE('    model default\n', '  chat panel\n    show chart\n')), 'src/theme.css');
  for (let n = 1; n <= 6; n++) assert.match(charts, new RegExp(`--az-color-series-${n}: `));
  assert.ok((charts.match(/--az-color-series-1: /g) ?? []).length >= 2, 'light and dark');
  // An explore draws charts too (§21.3.4).
  assert.match(file(project(SITE('    model default\n', '  chat panel\n    show explore\n')), 'src/theme.css'), /--az-color-series-6: /);
  assert.doesNotMatch(file(project(SITE('    model default\n', '  chat panel\n    show faq\n')), 'src/theme.css'), /series-/);
  assert.doesNotMatch(file(project(SITE('', '')), 'src/theme.css'), /series-/);
});

/* ---- C8 (chat-block-spec §21.4): maps, on a map site only ---------------- */

test('a chat that shows maps: the module hands the panel the map drawer and the build\'s third-party archive, if set; App unchanged', () => {
  const p = project(SITE('    model default\n', '  chat panel\n    show map\n    allow anyone\n'));
  assert.equal(p.map, true);
  const chat = file(p, CHAT_FILE);
  assert.equal(chat, chatTsx('src/az', true));
  assert.match(chat, /import \{ drawMap \} from "\.\.\/az\/chat-map-draw\.ts";/);
  assert.match(chat, new RegExp(`const TILES: string \\| null = import\\.meta\\.env\\.${MAP_TILES_ENV} \\|\\| null;`));
  assert.match(chat, /drawMap: \(d, data\) => drawMap\(\{ \.\.\.d, tiles: TILES \}, data\),/);
  // The library is never imported by the module itself: the drawer imports it when the first map arrives.
  assert.doesNotMatch(chat, /maplibre|pmtiles|chat-map-gl/);
  assert.equal(MAP_TILES_ENV, 'AZ_PUBLIC_MAP_TILES_URL');
});

test('a map site depends on the three pinned map packages and gives the library\'s popup the theme; no other site does', () => {
  const pkg = (src: string) => JSON.parse(file(project(src), 'package.json')) as { dependencies: Record<string, string> };
  const map = pkg(SITE('    model default\n', '  chat panel\n    show map\n'));
  assert.deepEqual(
    { maplibre: map.dependencies['maplibre-gl'], pmtiles: map.dependencies.pmtiles, basemaps: map.dependencies['@protomaps/basemaps'] },
    { maplibre: PINS.maplibre, pmtiles: PINS.pmtiles, basemaps: PINS.basemaps },
  );
  for (const src of [SITE('    model default\n', '  chat panel\n    show chart explore\n'), SITE('', '')]) {
    const deps = pkg(src).dependencies;
    assert.equal(deps['maplibre-gl'] ?? deps.pmtiles ?? deps['@protomaps/basemaps'], undefined, 'CONTROL: no map, no map packages');
  }
  const css = file(project(SITE('    model default\n', '  chat panel\n    show map\n')), 'src/az.css');
  const theme = file(project(SITE('    model default\n', '  chat panel\n    show map\n')), 'src/theme.css');
  assert.ok(css.includes('.az-chat-map-stage .maplibregl-popup-content') || theme.includes('.az-chat-map-stage .maplibregl-popup-content'), 'the popup rules ship');
  assert.doesNotMatch(file(project(SITE('    model default\n', '  chat panel\n    show chart\n')), 'src/theme.css'), /maplibregl/);
  // Its pins are a series token, so a map site has them.
  assert.match(theme, /--az-color-series-1: /);
});

test('mapCss: the popup\'s box and tip from the theme\'s tokens — two classes deep, never a literal colour', () => {
  const t = { color: { bg: 'var(--az-color-bg)', text: 'var(--az-color-text)', 'border-strong': 'var(--az-color-border-strong)' }, radius: { sm: 4 }, space: { 8: 8, 12: 12 } };
  const css = mapCss(t as unknown as Parameters<typeof mapCss>[0]);
  assert.match(css, /^\.az-chat-map-stage \.maplibregl-popup-content \{ background: var\(--az-color-bg\); color: var\(--az-color-text\);/m);
  assert.equal((css.match(/maplibregl-popup-tip \{ border-(?:top|bottom|left|right)-color: var\(--az-color-border-strong\); \}/g) ?? []).length, 8, 'every anchor\'s tip');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
});

test('the map runtime files are their own list: never among the chat\'s, copied only to a map site (cli az.ts)', () => {
  assert.deepEqual([...MAP_RUNTIME_FILES], ['chat-map.ts', 'chat-map-draw.ts', 'chat-map-gl.ts']);
  assert.ok(MAP_RUNTIME_FILES.every((f) => !CHAT_RUNTIME_FILES.includes(f)));
  assert.equal(project(SITE('    model default\n', '  chat panel\n    show chart\n')).map, false);
  assert.equal(project(SITE('', '')).map, false);
});
