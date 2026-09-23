/**
 * The web target's auth wiring (M4) — auth-block-spec §3–§5.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';
import { MIN_PASSWORD as EMITTED_MIN } from '../../words/auth/emit.web.ts';
import { MIN_PASSWORD as RUNTIME_MIN } from '../../auth-runtime/src/runtime/contract.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const site = (adapter: string, extra = '') => `az 1
site studio
  auth
    adapter ${adapter}
    protect /account /login
${extra}page /
  hero center
    title "x"
page /login
  auth login
    alt "Create an account" /signup
page /signup
  auth signup
    terms /terms
page /terms
page /account
  nav bar
    link "Home" /
  hero center
    title "Orders"
`;

function project(src: string) {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  return emitProject(r.spec, { emitters: WEB_EMITTERS });
}
const file = (p: ReturnType<typeof project>, path: string) => p.files.find((f) => f.path === path)?.content ?? '';

test('a hosted site: config reads the PUBLIC env, the guard requires it, App guards /account', () => {
  const p = project(site('hosted'));
  assert.equal(p.auth, true);
  const config = file(p, 'src/az-auth/config.ts');
  assert.match(config, /createHostedAdapter\(\{\n  url: import\.meta\.env\.AZ_PUBLIC_AUTH_URL/);
  assert.match(config, /publicKey: import\.meta\.env\.AZ_PUBLIC_AUTH_KEY/);
  assert.match(config, /export const LOGIN: string \| null = "\/login";/);
  assert.match(config, /§4\.1 — what actually protects the data/, 'the generated file carries §4.1');
  assert.match(file(p, 'az-vite/guard.ts'), /const REQUIRED: readonly string\[\] = \["AZ_PUBLIC_AUTH_URL","AZ_PUBLIC_AUTH_KEY"\]/);
  const app = file(p, 'src/App.tsx');
  assert.match(app, /import \{ AuthRuntime, Protected \} from "\.\/az-auth\/react\.tsx";/);
  // The login page is never protected (a loop). The nav leads the page,
  // before <main>, so it stays outside <Protected> and shows while checking.
  assert.match(app, /const PROTECT = new Set<string>\(\[\n  "\/account"\n\]\);/);
  assert.match(app, /<Protected lead=\{null\}>\{nodes\(page, page\.lead, /);
  assert.match(file(p, 'src/theme.css'), /\.az-session \{/);
});

test('§3.5: the token-endpoint profile imports its own module and lands resets on the reset page', () => {
  const p = project(site('hosted', '    profile token-endpoint\npage /reset\n  auth reset\n'));
  const config = file(p, 'src/az-auth/config.ts');
  assert.match(config, /import \{ createTokenEndpointAdapter \} from "\.\/hosted-token\.ts"/);
  assert.match(config, /resetPath: "\/reset"/);
  assert.match(config, /import\.meta\.env\.AZ_PUBLIC_AUTH_URL/);
  assert.doesNotMatch(config, /createHostedAdapter/, 'only the chosen protocol ships');
  assert.match(file(p, 'az-vite/guard.ts'), /"AZ_PUBLIC_AUTH_URL","AZ_PUBLIC_AUTH_KEY"/, 'same public variables as standard');
});

test('CONTROL: the standard profile is the default and imports the standard module only', () => {
  const config = file(project(site('hosted')), 'src/az-auth/config.ts');
  assert.match(config, /createHostedAdapter/);
  assert.doesNotMatch(config, /hosted-token/);
});

test('a session site uses same-origin routes and needs no env', () => {
  const p = project(site('session'));
  assert.match(file(p, 'src/az-auth/config.ts'), /createSessionAdapter\(\{ base: "\/api\/auth" \}\)/);
  assert.match(file(p, 'az-vite/guard.ts'), /const REQUIRED: readonly string\[\] = \[\]/);
});

test('a custom site imports the author\'s impl through the sandboxed module path', () => {
  const p = project(site('custom', '    impl ./auth/adapter.ts\n'));
  assert.deepEqual(p.modules, ['auth/adapter.ts']);
  assert.match(file(p, 'src/az-auth/config.ts'), /import impl from "\.\.\/user\/auth\/adapter\.ts";/);
  assert.doesNotMatch(file(p, 'src/App.tsx'), /auth\/adapter/, 'the adapter is not rendered as a component');
});

test('CONTROL: a site without auth carries no auth wiring — but still the guard', () => {
  const p = project('az 1\nsite plain\npage /\n  hero center\n    title "x"\n');
  assert.equal(p.auth, false);
  assert.ok(!p.files.some((f) => f.path.startsWith('src/az-auth/')));
  assert.doesNotMatch(file(p, 'src/App.tsx'), /az-auth/);
  assert.doesNotMatch(file(p, 'src/theme.css'), /az-session/);
  const vite = file(p, 'vite.config.ts');
  assert.match(vite, /envPrefix: "AZ_PUBLIC_"/);
  assert.match(vite, /plugins: \[secretGuard\(\)\]/);
});

test('§3.4: azbackend compiles and wires the backend adapter from its one PUBLIC URL', () => {
  const r = compile(site('azbackend'), { manifests });
  assert.ok(!r.diagnostics.some((d) => d.code === 'AZ1214'), 'azbackend is available now (PRD §11 Q2 decided)');
  const p = project(site('azbackend'));
  const config = file(p, 'src/az-auth/config.ts');
  assert.match(config, /createBackendAdapter\(\{ url: import\.meta\.env\.AZ_PUBLIC_BACKEND_URL \?\? "" \}\)/);
  assert.doesNotMatch(config, /AZ_PUBLIC_AUTH_KEY|publicKey/, 'the backend takes no key');
  const guard = file(p, 'az-vite/guard.ts');
  assert.match(guard, /const REQUIRED: readonly string\[\] = \["AZ_PUBLIC_BACKEND_URL"\]/);
  assert.match(guard, /import \{ backendUrlProblem \} from "\.\.\/src\/az-auth\/azbackend\.ts";/);
  assert.match(guard, /adapter azbackend needs /);
});

test('CONTROL: the hosted guard does not import the backend check', () => {
  const guard = file(project(site('hosted')), 'az-vite/guard.ts');
  assert.doesNotMatch(guard, /backendUrlProblem|AZ_PUBLIC_BACKEND_URL/);
});

test('the emitted hint and the runtime enforce the same password minimum', () => {
  assert.equal(EMITTED_MIN, RUNTIME_MIN);
});
