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
import { CHAT_FILE, chatTsx } from '../src/chat.ts';
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
  assert.doesNotMatch(file(project(SITE('    model default\n', '  chat panel\n    show faq\n')), 'src/theme.css'), /series-/);
  assert.doesNotMatch(file(project(SITE('', '')), 'src/theme.css'), /series-/);
});
