/**
 * A site whose only backend feature is a public chat (chat-block-spec
 * §19.15): no `auth`, no `email`, no sign-in pages. Its project has no auth
 * runtime, no AuthRuntime and no session read — yet its chat module, the
 * guard's backend address check (the azbackend adapter's own, copied alone)
 * and every page's connect-src reach the backend exactly as an azbackend
 * site's do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { BACKEND_ENV, BACKEND_URL_FILES, guardTs } from '../src/auth.ts';
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

const PUBLIC = `az 1
site demo
  backend
    database sqlite
    model    default

page /
  chat panel
    allow anyone
page /about
  hero center
    title "About"
`;

const project = (src: string) => {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, r.diagnostics.map((d) => d.message).join('\n'));
  return emitProject(r.spec, { emitters: WEB_EMITTERS });
};

test('the public chat site has a chat and no auth: no auth runtime, AuthRuntime or <Protected>', () => {
  const p = project(PUBLIC);
  assert.equal(p.chat, true);
  assert.equal(p.auth, false);
  assert.equal(p.backendUrlCheck, true);
  assert.equal(p.files.some((f) => f.path.startsWith('src/az-auth/')), false, 'no auth config or react module is generated');
  const app = p.files.find((f) => f.path === 'src/App.tsx')!.content;
  assert.match(app, /<ChatRuntime \/>/);
  assert.doesNotMatch(app, /AuthRuntime|Protected|az-auth/);
});

test('its chat module reads the backend address and no session: nobody is ever signed in', () => {
  const p = project(PUBLIC);
  const chat = p.files.find((f) => f.path === CHAT_FILE)!.content;
  assert.equal(chat, chatTsx('src/az', false, false));
  assert.match(chat, new RegExp(`import\\.meta\\.env\\.${BACKEND_ENV[0]}`));
  assert.doesNotMatch(chat, /adapter|account|onSession|az-auth/);
  // CONTROL: with accounts, the module reads the adapter's session as before.
  assert.match(chatTsx('src/az'), /import \{ adapter \} from "\.\.\/az-auth\/config\.ts";/);
  assert.match(chatTsx('src/az'), /onSession: \(fn\) => adapter\.onChange/);
});

test('the build guard needs the backend address and checks it with the adapter\'s own check, under chat\'s name', () => {
  const p = project(PUBLIC);
  const guard = p.files.find((f) => f.path === 'az-vite/guard.ts')!.content;
  assert.equal(guard, guardTs(BACKEND_ENV, null, true));
  assert.match(guard, new RegExp(`const REQUIRED: readonly string\\[\\] = \\["${BACKEND_ENV[0]}"\\];`));
  assert.match(guard, /import \{ backendUrlProblem \} from "\.\.\/src\/az-auth\/azbackend\.ts";/);
  assert.match(guard, /"chat: the site's backend needs "/);
  assert.match(guard, /"chat: the site's backend — " \+ problem/);
  // Only the three files that check lives in are copied (the CLI copies BACKEND_URL_FILES).
  assert.deepEqual([...BACKEND_URL_FILES].sort(), ['azbackend.ts', 'contract.ts', 'session.ts']);
});

test('every page reaches the backend: its address is in each page\'s connect-src, and in AZ.md\'s public keys', () => {
  const p = project(PUBLIC);
  const build = p.files.find((f) => f.path === 'az-vite/build.mjs')!.content;
  const needs = JSON.parse(/const NEEDS = (\{.*?\});\n/s.exec(build)?.[1] ?? 'null') as Record<string, { connect: string[] }> | null;
  assert.ok(needs, 'the build script carries each page\'s needs');
  for (const [page, n] of Object.entries(needs)) assert.deepEqual(n.connect, [BACKEND_ENV[0]], page);
  const azmd = p.files.find((f) => f.path === 'AZ.md')!.content;
  assert.match(azmd, new RegExp(`\`${BACKEND_ENV[0]}\``));
  assert.match(azmd, /no accounts/);
});

test('CONTROL: a chat on a backend with accounts is unchanged — the adapter\'s session, no separate URL check', () => {
  const p = project(`az 1
site demo
  auth
    adapter azbackend
  backend
    database sqlite
    email    smtp
    model    default

page /
  chat panel
page /login
  auth login
    alt "Back" /
`);
  assert.equal(p.auth, true);
  assert.equal(p.backendUrlCheck, false);
  assert.equal(p.files.find((f) => f.path === CHAT_FILE)!.content, chatTsx('src/az'));
  assert.equal(p.files.find((f) => f.path === 'az-vite/guard.ts')!.content, guardTs(BACKEND_ENV, 'azbackend'));
});
