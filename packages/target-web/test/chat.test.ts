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
  assert.match(text, /adapter\.session\(\) !== null/);
  // Nothing but the public backend URL is read from the environment.
  assert.deepEqual([...text.matchAll(/import\.meta\.env\.([A-Z_]+)/g)].map((m) => m[1]), ['AZ_PUBLIC_BACKEND_URL']);
});

test('CONTROL: a site without a chat panel emits exactly what it did before', () => {
  const p = project(SITE('', ''));
  assert.equal(p.chat, false);
  assert.equal(p.files.some((f) => f.path === CHAT_FILE), false);
  assert.doesNotMatch(p.files.find((f) => f.path === 'src/App.tsx')!.content, /Chat/);
});
