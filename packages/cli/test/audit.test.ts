/**
 * `az audit` — word-quality-gate §5: every check against a planted build or
 * a faked machine, the advisory query offline and timed out, the real
 * binary end to end, and no secret value ever reaching the output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AUDIT_CHECKS, audit, backendHeaderProblems, cspProblems, readAdvisory, type AuditOptions } from '../src/audit.ts';
import { formatReport, runChecks, systemProbe, type Check, type Probe, type RunOptions, type RunResult } from '../src/doctor.ts';
import { findNpmCli } from '../src/serve.ts';
import { pagePolicy, sha256Source, withPolicy, type PageNeeds } from '../../target-web/src/csp.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const NO_NETWORK = join(ROOT, 'packages/cli/test/no-network.mjs');

/** Shaped like a service key the guard refuses (core secrets.ts) — planted, never real. */
const PLANTED = `sk_live_${'Z9q'.repeat(12)}`;
/** A high-entropy public value, shipped on purpose. */
const PUBLIC = 'Pk7vR2mQ9xL4tW8nB3cY6hJ1sD5fG0aZeUoIpKjHgFdSa';

const SITE = 'az 1\nsite aurora\npage /\n  hero center\n    title "Hi"\n';
const BACKEND = 'az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\npage /\n  hero center\n    title "Hi"\n';

const PAGE = (head = '', body = '<div id="root"><p>hi</p></div>') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8" />${head}<title>t</title><script type="module" src="./assets/index.js"></script></head><body>${body}</body></html>`;
const STRICT = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; object-src 'none'; base-uri 'self'" />`;

/** A real az build of `source`, with `dist` files planted where the project's own build would write them. */
function built(
  source: string, dist: Record<string, string> | null = { 'index.html': PAGE(), 'assets/index.js': 'console.log("hi");\n' },
  files: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'az-audit-'));
  writeFileSync(join(dir, 'site.az'), source);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  const r = spawnSync(process.execPath, [BIN, 'build', 'site.az'], { cwd: dir, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = join(dir, '.az-build');
  for (const [path, content] of Object.entries(dist ?? {})) {
    mkdirSync(join(out, 'dist', path, '..'), { recursive: true });
    writeFileSync(join(out, 'dist', path), content);
  }
  return { dir, out };
}

/** This machine, with its children and environment chosen per test. */
function fakeProbe(over: Partial<Probe> = {}): Probe {
  return { ...systemProbe(findNpmCli), env: {}, ...over };
}

const options = (b: { dir: string; out: string }, over: Partial<AuditOptions> = {}): AuditOptions =>
  ({ outDir: b.out, cwd: b.dir, probe: fakeProbe(), online: false, ...over });

async function check(id: string, b: { dir: string; out: string }, over: Partial<AuditOptions> = {}) {
  const c = AUDIT_CHECKS.find((x) => x.id === id);
  assert.ok(c, `no check ${id}`);
  const r = await audit({ ...options(b, over), checks: [c] });
  return r.checks[0];
}

/* ---- the output folder ---------------------------------------------------- */

test('output: a folder az did not build fails alone, with the build command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-audit-'));
  const r = await audit({ outDir: join(dir, '.az-build'), cwd: dir, probe: fakeProbe(), online: false });
  assert.deepEqual(r.checks.map((c) => [c.id, c.status, c.line]), [['output', 'fail', 'output: .az-build is not an az build — there is nothing to audit']]);
  assert.equal(r.exit, 1);
});

/* ---- bundle secrets -------------------------------------------------------- */

test('bundle secrets: a key planted in a shipped file fails by file:offset and shape', async () => {
  const js = `console.log("hi");const k="${PLANTED}";`;
  const b = built(SITE, { 'index.html': PAGE(), 'assets/index.js': js, 'assets/k.pem.txt': '-----BEGIN PRIVATE KEY-----\n' });
  const c = await check('bundle-secrets', b);
  assert.equal(c.status, 'fail');
  assert.equal(c.line, 'bundle secrets: 2 key-shaped strings in the built site — anyone who loads it can read them');
  assert.deepEqual(c.fix?.slice(0, 2), [`dist/assets/index.js:${js.indexOf(PLANTED)} (secret-prefix)`, 'dist/assets/k.pem.txt:0 (pem)']);
});

test('bundle secrets: a key in a pre-rendered page is found — after the guard has run', async () => {
  const b = built(SITE, { 'index.html': PAGE('', `<div id="root"><p data-k="${PLANTED}">hi</p></div>`) });
  const c = await check('bundle-secrets', b);
  assert.equal(c.status, 'fail');
  assert.match(c.fix?.[0] ?? '', /^dist\/index\.html:\d+ \(secret-prefix\)$/);
});

test('bundle secrets: a public value set as AZ_PUBLIC_ is allowed, as by the guard; unset, it fails', async () => {
  const b = built(SITE, { 'index.html': PAGE(), 'assets/index.js': `const url="${PUBLIC}";` });
  const unset = await check('bundle-secrets', b);
  assert.equal(unset.status, 'fail');
  assert.equal(unset.fix?.[0], 'dist/assets/index.js:11 (entropy)');
  writeFileSync(join(b.out, '.env'), `AZ_PUBLIC_AUTH_KEY=${PUBLIC}\n`);
  assert.equal((await check('bundle-secrets', b)).status, 'pass', 'from the output folder\'s .env');
  writeFileSync(join(b.out, '.env'), '');
  assert.equal((await check('bundle-secrets', b, { probe: fakeProbe({ env: { AZ_PUBLIC_AUTH_KEY: PUBLIC } }) })).status, 'pass', 'from the environment');
  assert.equal((await check('bundle-secrets', b, { probe: fakeProbe({ env: { OTHER_KEY: PUBLIC } }) })).status, 'fail', 'only the public prefix is allowed');
});

test('bundle secrets: a package\'s published file, shipped byte-for-byte, is judged by key shape only', async () => {
  const dense = `const table="${PUBLIC}";`;
  const b = built(SITE, { 'index.html': PAGE(), 'assets/decoder-AbC_12-z.js': dense, 'assets/other-XyZ_98-q.js': dense });
  mkdirSync(join(b.out, 'node_modules/pkg/libs'), { recursive: true });
  writeFileSync(join(b.out, 'node_modules/pkg/libs/decoder.js'), dense);
  // The same name with other bytes is not the published file.
  writeFileSync(join(b.out, 'node_modules/pkg/libs/other.js'), `${dense}\n`);
  const c = await check('bundle-secrets', b);
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.fix?.slice(0, 1), ['dist/assets/other-XyZ_98-q.js:13 (entropy)']);
  writeFileSync(join(b.out, 'node_modules/pkg/libs/other.js'), dense);
  const both = await check('bundle-secrets', b);
  assert.deepEqual([both.status, both.line], ['pass', 'bundle secrets: none in 3 shipped text files — the build guard\'s patterns, after pre-render; 2 files a package published judged by key shape only']);
  // A key's shape is still found in a published copy.
  const keyed = `${dense}const k="${PLANTED}";`;
  writeFileSync(join(b.out, 'dist/assets/decoder-AbC_12-z.js'), keyed);
  writeFileSync(join(b.out, 'node_modules/pkg/libs/decoder.js'), keyed);
  const shape = await check('bundle-secrets', b);
  assert.equal(shape.status, 'fail');
  assert.deepEqual(shape.fix?.slice(0, 1), [`dist/assets/decoder-AbC_12-z.js:${keyed.indexOf(PLANTED)} (secret-prefix)`]);
});

test('bundle secrets: an unbuilt site fails with the install-and-build command; images are not read', async () => {
  const none = await check('bundle-secrets', built(SITE, null));
  assert.equal(none.status, 'fail');
  assert.equal(none.line, 'bundle secrets: .az-build/dist is not a folder the build wrote — the site is not built, so nothing it ships can be checked');
  assert.deepEqual(none.fix, ['run: cd .az-build && npm install && npm run build']);
  const b = built(SITE, { 'index.html': PAGE(), 'assets/a.webp': PLANTED });
  const c = await check('bundle-secrets', b);
  assert.equal(c.status, 'pass');
  assert.equal(c.line, 'bundle secrets: none in 1 shipped text file — the build guard\'s patterns, after pre-render');
});

test('bundle secrets: a page\'s policy may pin digests of what it carries inline; any other digest is judged', async () => {
  const style = 'color:var(--az-color-accent)';
  const own = sha256Source(style);
  const pinned = (digest: string) => PAGE(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-hashes' ${digest}; object-src 'none'; base-uri 'self'" />`,
    `<div id="root"><p style="${style}">hi</p></div>`);
  const ok = await check('bundle-secrets', built(SITE, { 'index.html': pinned(own), 'assets/index.js': 'console.log("hi");\n' }));
  assert.equal(ok.status, 'pass', ok.line);
  // CONTROL: the same shape, but the digest of nothing on the page — a value someone put there.
  const planted = sha256Source('color:red');
  const bad = await check('bundle-secrets', built(SITE, { 'index.html': pinned(planted), 'assets/index.js': 'console.log("hi");\n' }));
  assert.equal(bad.status, 'fail', bad.line);
  assert.ok((bad.fix ?? []).some((f) => /^dist\/index\.html:\d+ \(entropy\)$/.test(f)), (bad.fix ?? []).join(' | '));
});

test('a page whose attributes hold any numeric reference is read as the browser reads it — never a RangeError', async () => {
  // Past U+10FFFF, a surrogate, zero and a C1 remap in a style attribute; the
  // policy itself written with references the old decoding left as text.
  const style = "font-family:'&#x110000;&#xD800;&#0;&#x80;'";
  const own = sha256Source("font-family:'\uFFFD\uFFFD\uFFFD\u20AC'");
  const content = `default-src &#X27;self&#X27;; style-src &#39;self&#39; &#x27;unsafe-hashes&#x27; ${own}; object-src &#39;none&#39;; base-uri &#39;self&#39;`;
  const b = built(SITE, { 'index.html': PAGE(`<meta http-equiv="Content-Security-Policy" content="${content}" />`, `<div id="root"><p style="${style}">hi</p></div>`) });
  const secrets = await check('bundle-secrets', b);
  assert.equal(secrets.status, 'pass', secrets.line);
  const csp = await check('page-csp', b);
  assert.deepEqual([csp.status, csp.line], ['pass', 'page CSP: 1 page, each with a strict policy']);
});

/* ---- Content-Security-Policy ---------------------------------------------- */

test('cspProblems: a strict policy has none; each weakness is named', () => {
  assert.deepEqual(cspProblems("default-src 'self'; object-src 'none'; base-uri 'self'"), []);
  assert.deepEqual(cspProblems("script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; base-uri 'none'"), [
    "'unsafe-eval' in script-src — strings run as code",
    "'unsafe-inline' in script-src — an injected script runs",
    'script-src allows https: — scripts from anywhere',
    "object-src is not 'none' — plugin content may load",
  ]);
  assert.deepEqual(cspProblems("img-src *"), [
    'no script-src or default-src — any script may load',
    "object-src is not 'none' — plugin content may load",
    'no base-uri — an injected <base> moves every relative script',
    'img-src allows * — images from anywhere, and the page can send what it reads in their URLs',
  ]);
  // A hash pins the inline scripts: 'unsafe-inline' is then ignored by the browser.
  assert.deepEqual(cspProblems("default-src 'none'; script-src 'self' 'unsafe-inline' 'sha256-abc='; base-uri 'none'"), []);
  // The first directive of a name wins.
  assert.deepEqual(cspProblems("default-src 'self'; object-src 'none'; object-src *; base-uri 'self'"), []);
  // The weaker tier: any inline style, scripts still pinned — named for what it is.
  assert.deepEqual(cspProblems("default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"), [
    "'unsafe-inline' in style-src — injected markup can restyle the page",
  ]);
  // Hashed style attributes ('unsafe-hashes') are pinned, not open.
  assert.deepEqual(cspProblems("default-src 'self'; style-src 'self' 'unsafe-hashes' 'sha256-abc='; object-src 'none'; base-uri 'self'"), []);
});

/** A strict policy with one fetch directive set to `sources` — what that directive alone leaves open. */
const only = (directive: string, sources: string) =>
  cspProblems(`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; ${directive} ${sources}`);

test('cspProblems: every fetch directive is graded — a wildcard and an http:/https: scheme source weaken it', () => {
  const what: Record<string, string> = {
    'connect-src': 'the page can send what it reads anywhere',
    'img-src': 'images from anywhere, and the page can send what it reads in their URLs',
    'worker-src': 'workers from anywhere',
    'style-src': 'stylesheets from anywhere',
    'font-src': 'fonts from anywhere',
    'frame-src': 'frames from anywhere',
  };
  for (const [directive, consequence] of Object.entries(what)) {
    assert.deepEqual(only(directive, "'self' *"), [`${directive} allows * — ${consequence}`], directive);
    assert.deepEqual(only(directive, "'self' https:"), [`${directive} allows https: — ${consequence}`], directive);
    assert.deepEqual(only(directive, "'self' http:"), [`${directive} allows http: — ${consequence}`], directive);
    assert.deepEqual(only(directive, "'self' https://*.cdn.test"), [`${directive} allows https://*.cdn.test — ${consequence}`], directive);
    // CONTROL: one named origin is not "anywhere".
    assert.deepEqual(only(directive, "'self' https://api.example.org"), [], `${directive} with one origin`);
  }
  // default-src is graded in its own right: everything it covers falls back to it.
  assert.deepEqual(cspProblems("default-src 'self' https:; script-src 'self'; object-src 'none'; base-uri 'self'"), [
    'default-src allows https: — whatever no other directive names loads from anywhere',
  ]);
  assert.deepEqual(cspProblems("default-src *; script-src 'self'; object-src 'none'; base-uri 'self'"), [
    'default-src allows * — whatever no other directive names loads from anywhere',
  ]);
});

test('cspProblems: blob: and data: pass only where az\'s own policy uses them, for its reason', () => {
  // Where the generated policy uses them: the data: icon, a model's blob: textures (fetched) and its decoder worker.
  assert.deepEqual(only('img-src', "'self' data:"), []);
  // Textures are decoded with createImageBitmap, never an <img>: img-src carries no blob:.
  assert.deepEqual(only('img-src', "'self' blob:"), ['img-src allows blob: — images from anywhere, and the page can send what it reads in their URLs']);
  assert.deepEqual(only('connect-src', "'self' blob:"), []);
  assert.deepEqual(only('worker-src', "'self' blob:"), []);
  // Everywhere else they are a source any page can name.
  assert.deepEqual(only('connect-src', "'self' data:"), ['connect-src allows data: — the page can send what it reads anywhere']);
  assert.deepEqual(only('worker-src', "'self' data:"), ['worker-src allows data: — workers from anywhere']);
  assert.deepEqual(only('style-src', "'self' data:"), ['style-src allows data: — stylesheets from anywhere']);
  assert.deepEqual(only('style-src', "'self' blob:"), ['style-src allows blob: — stylesheets from anywhere']);
  assert.deepEqual(only('font-src', "'self' blob:"), ['font-src allows blob: — fonts from anywhere']);
  assert.deepEqual(only('frame-src', "'self' data:"), ['frame-src allows data: — frames from anywhere']);
  assert.deepEqual(cspProblems("default-src 'self' blob:; script-src 'self'; object-src 'none'; base-uri 'self'"), [
    'default-src allows blob: — whatever no other directive names loads from anywhere',
  ]);
});

test('cspProblems: az\'s page policy with every need at once still grades strict', () => {
  const need: PageNeeds = { dataIcon: true, decoder: true, connect: ['AZ_PUBLIC_AUTH_URL'], images: ['AZ_PUBLIC_BACKEND_URL'] };
  const html = '<meta charset="utf-8" /><div id="root"><p style="color:red">hi</p></div><script>1</script><style>p{}</style>';
  const policy = pagePolicy(need, html, { AZ_PUBLIC_AUTH_URL: 'https://auth.example.org', AZ_PUBLIC_BACKEND_URL: 'http://127.0.0.1:8787' });
  assert.match(policy, /img-src 'self' data: http:\/\/127\.0\.0\.1:8787; connect-src 'self' blob: https:\/\/auth\.example\.org; worker-src 'self' blob:/);
  assert.deepEqual(cspProblems(policy), []);
});

test('page CSP: the policy az\'s build gives each page grades strict — a plain page, a 3D model page, an auth page', async () => {
  const source = 'az 1\nsite aurora\n  auth\n    adapter hosted\npage /\n  hero split 3d\n    title "Hi"\n    describe "A shoe"\n    model ./shoe.glb\n' +
    'page /plain\n  hero center\n    title "Plain"\npage /login\n  auth login\n';
  const b = built(source, {}, { 'shoe.glb': '' });
  // What the generated build.mjs does after the pre-render: each page's template, filled, given its policy.
  const build = readFileSync(join(b.out, 'az-vite/build.mjs'), 'utf8');
  const needs = JSON.parse(/\nconst NEEDS = ([\s\S]*?\n});\n/.exec(build)?.[1] ?? '{}') as Record<string, PageNeeds>;
  assert.deepEqual(Object.keys(needs).sort(), ['index.html', 'login/index.html', 'plain/index.html']);
  const env = { AZ_PUBLIC_AUTH_URL: 'https://auth.example.org' };
  const policies: string[] = [];
  for (const [file, need] of Object.entries(needs)) {
    const filled = readFileSync(join(b.out, file), 'utf8').replace('<div id="root"></div>', '<div id="root"><p style="color:red">hi</p></div>');
    const policy = pagePolicy(need, filled, env);
    policies.push(policy);
    mkdirSync(join(b.out, 'dist', file, '..'), { recursive: true });
    writeFileSync(join(b.out, 'dist', file), withPolicy(filled, policy));
  }
  assert.ok(policies.every((p) => cspProblems(p).length === 0), policies.join('\n'));
  const [model, login, plain] = policies;
  assert.match(model, /script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-hashes' 'sha256-[^']+'; .*worker-src 'self' blob:/);
  assert.match(login, /connect-src 'self' https:\/\/auth\.example\.org; /);
  assert.doesNotMatch(plain, /wasm|worker-src/, 'CONTROL: the decoder only where the model is');
  const r = await check('page-csp', b);
  assert.deepEqual([r.status, r.line], ['pass', 'page CSP: 3 pages, each with a strict policy']);
});

test('page CSP: no policy warns as a finding; a weak one is named per page; a strict one passes', async () => {
  const bare = await check('page-csp', built(SITE));
  assert.equal(bare.status, 'warn');
  assert.equal(bare.line, 'page CSP: none of 1 page sets a Content-Security-Policy — an injected script would run');
  assert.match(bare.fix?.[0] ?? '', /^az build gives every page one/, 'the fix says how to get az\'s policy');

  const weak = `<meta http-equiv="content-security-policy" content="default-src 'self' 'unsafe-inline'; base-uri 'self'" />`;
  const mixed = await check('page-csp', built(SITE, { 'index.html': PAGE(STRICT), 'work/index.html': PAGE(weak), 'legal/index.html': PAGE() }));
  assert.equal(mixed.status, 'warn');
  assert.equal(mixed.line, 'page CSP: 1 page without a policy, 1 page with a weak one');
  assert.deepEqual(mixed.fix?.slice(0, 2), ['/legal: no policy',
    "/work: 'unsafe-inline' in script-src — an injected script runs; object-src is not 'none' — plugin content may load; 'unsafe-inline' in style-src — injected markup can restyle the page"]);

  const inlineStyle = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'" />`;
  const styled = await check('page-csp', built(SITE, { 'index.html': PAGE(STRICT), 'work/index.html': PAGE(inlineStyle) }));
  assert.deepEqual([styled.status, styled.line], ['warn', 'page CSP: 1 page allowing any inline style (scripts pinned)']);

  const strict = await check('page-csp', built(SITE, { 'index.html': PAGE(STRICT), 'work/index.html': PAGE(STRICT) }));
  assert.deepEqual([strict.status, strict.line], ['pass', 'page CSP: 2 pages, each with a strict policy']);
  // A policy inside a comment is not a policy.
  assert.equal((await check('page-csp', built(SITE, { 'index.html': PAGE(`<!-- ${STRICT} -->`) }))).status, 'warn');
});

test('backendHeaderProblems: az\'s own headers have none; each gap is named', () => {
  assert.deepEqual(backendHeaderProblems({
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  }), []);
  assert.deepEqual(backendHeaderProblems({ 'Content-Security-Policy': "default-src 'self'" }), [
    "CSP default-src is not 'none'", 'CSP has no frame-ancestors — a response may be framed', 'no X-Content-Type-Options: nosniff', 'no Referrer-Policy',
  ]);
  assert.deepEqual(backendHeaderProblems({}), ['no Content-Security-Policy', 'no X-Content-Type-Options: nosniff', 'no Referrer-Policy']);
});

test('backend CSP: a built server passes on az\'s headers; an edited copy is not vouched for; no server skips', async () => {
  assert.equal((await check('backend-csp', built(SITE))).status, 'skip');
  const b = built(BACKEND);
  const ok = await check('backend-csp', b);
  assert.deepEqual([ok.status, ok.line], ['pass', "backend CSP: every API response sends default-src 'none'; frame-ancestors 'none', nosniff, a referrer policy"]);
  const http = join(b.out, 'server/src/http.ts');
  writeFileSync(http, readFileSync(http, 'utf8').replace("default-src 'none'; frame-ancestors 'none'", "default-src *"));
  const edited = await check('backend-csp', b);
  assert.equal(edited.status, 'warn');
  assert.equal(edited.line, 'backend CSP: .az-build/server/src/http.ts is not what this az writes — its response headers can\'t be vouched for');
});

/* ---- new-tab links -------------------------------------------------------- */

test('new-tab links: target=_blank without noopener warns; with it passes; none skips', async () => {
  const open = '<a href="https://example.org" target="_blank">x</a><a href="/a" target="_blank" rel="noreferrer">y</a>';
  const c = await check('new-tab-links', built(SITE, { 'index.html': PAGE('', open) }));
  assert.equal(c.status, 'warn');
  assert.equal(c.line, 'new-tab links: 1 link with target="_blank" and no rel="noopener" — the opened page can redirect this one');
  assert.equal(c.fix?.[0], '/: https://example.org');
  const safe = await check('new-tab-links', built(SITE, { 'index.html': PAGE('', '<a target=_blank rel="noopener noreferrer" href="/x">x</a>') }));
  assert.deepEqual([safe.status, safe.line], ['pass', 'new-tab links: 1 link, each with rel="noopener"']);
  assert.equal((await check('new-tab-links', built(SITE))).status, 'skip');
});

/* ---- dependency advisories ------------------------------------------------- */

const LOCK = '{"name":"aurora","lockfileVersion":3,"packages":{}}';

/** A probe whose advisory child answers `result`; records every child it was asked to start. */
function advisoryProbe(result: RunResult) {
  const calls: { args: readonly string[]; options: RunOptions }[] = [];
  const probe = fakeProbe({
    npmCli: () => '/fake/npm-cli.js',
    run: async (_file: string, args: readonly string[], o: RunOptions) => {
      calls.push({ args, options: o });
      return result;
    },
  });
  return { probe, calls };
}

const report = (v: object, vulnerabilities: object = {}) =>
  JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...v } } });
const exit = (code: number, stdout: string, stderr = ''): RunResult => ({ kind: 'exit', code, stdout, stderr });

test('dependencies: without --online nothing is asked — no child, no network', async () => {
  const b = built(SITE);
  writeFileSync(join(b.out, 'package-lock.json'), LOCK);
  const { probe, calls } = advisoryProbe(exit(0, report({})));
  const c = await check('dependencies', b, { probe });
  assert.deepEqual([c.status, c.line], ['skip', 'dependencies: not checked — the advisory service is a network call; run: az audit --online']);
  assert.equal(calls.length, 0);
});

test('dependencies: a high advisory fails with the package named; moderate warns; none passes', async () => {
  const b = built(SITE);
  writeFileSync(join(b.out, 'package-lock.json'), LOCK);
  const high = advisoryProbe(exit(1, report({ high: 1, moderate: 2 }, { 'left-pad': { severity: 'high' }, other: { severity: 'moderate' } })));
  const c = await check('dependencies', b, { probe: high.probe, online: true });
  assert.equal(c.status, 'fail');
  assert.equal(c.line, 'dependencies: 1 package with a high or critical advisory');
  assert.deepEqual(c.fix?.slice(0, 2), ['.az-build: left-pad (high)', '.az-build: 0 critical, 1 high, 2 moderate, 0 low, 0 info']);
  assert.deepEqual(high.calls.map((x) => [x.args.slice(1), x.options.cwd, x.options.timeoutMs]), [[['audit', '--json'], b.out, 15_000]]);
  assert.equal((await check('dependencies', b, { probe: advisoryProbe(exit(1, report({ moderate: 1 }))).probe, online: true })).status, 'warn');
  const clean = await check('dependencies', b, { probe: advisoryProbe(exit(0, report({}))).probe, online: true });
  assert.deepEqual([clean.status, clean.line], ['pass', 'dependencies: no known advisory (.az-build: 0 critical, 0 high, 0 moderate, 0 low, 0 info)']);
});

test('OFFLINE: an unreachable advisory service warns "could not reach", never fails', async () => {
  const b = built(SITE);
  writeFileSync(join(b.out, 'package-lock.json'), LOCK);
  const refused = exit(1, JSON.stringify({ message: 'request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9', error: { summary: '', detail: '' } }),
    'npm error audit endpoint returned an error\n');
  const c = await check('dependencies', b, { probe: advisoryProbe(refused).probe, online: true });
  assert.equal(c.status, 'warn');
  assert.equal(c.line, 'dependencies: could not reach the advisory service — not checked (.az-build: could not reach the advisory service)');
});

test('TIMEOUT: an advisory query that does not answer warns with the time, and the run goes on', async () => {
  const b = built(SITE);
  writeFileSync(join(b.out, 'package-lock.json'), LOCK);
  const c = await check('dependencies', b, { probe: advisoryProbe({ kind: 'timeout', ms: 15_000 }).probe, online: true });
  assert.deepEqual([c.status, c.line], ['warn', 'dependencies: could not reach the advisory service — not checked (.az-build: no answer after 15s)']);
});

test('dependencies: no lockfile warns with the install step and asks nothing; a failing query fails with its words', async () => {
  const b = built(SITE);
  const none = advisoryProbe(exit(0, report({})));
  const c = await check('dependencies', b, { probe: none.probe, online: true });
  assert.equal(c.status, 'warn');
  assert.deepEqual(c.fix, ['.az-build: no lockfile — run: cd .az-build && npm install, then az audit --online']);
  assert.equal(none.calls.length, 0);
  writeFileSync(join(b.out, 'package-lock.json'), LOCK);
  const broken = await check('dependencies', b, { probe: advisoryProbe(exit(1, '', 'npm error code EJSONPARSE\n')).probe, online: true });
  assert.deepEqual([broken.status, broken.line], ['fail', 'dependencies: the advisory query failed — .az-build: exit 1: npm error code EJSONPARSE']);
  assert.equal(readAdvisory(exit(1, JSON.stringify({ error: { code: 'ENOLOCK', summary: 'x' } }))).kind, 'no-lock');
});

test('dependencies: the built server is asked too, at once', async () => {
  const b = built(BACKEND);
  writeFileSync(join(b.out, 'package-lock.json'), LOCK);
  writeFileSync(join(b.out, 'server/package-lock.json'), LOCK);
  const { probe, calls } = advisoryProbe(exit(0, report({})));
  const c = await check('dependencies', b, { probe, online: true });
  assert.equal(c.status, 'pass');
  assert.deepEqual(calls.map((x) => x.options.cwd).sort(), [b.out, join(b.out, 'server')]);
});

/* ---- deadlines, and secrets in the output --------------------------------- */

test('DEADLINE: a hung audit check reports no answer and says to run az audit again', async () => {
  const hung: Check<null> = { id: 'hung', title: 'hung step', run: () => new Promise(() => {}) };
  const started = Date.now();
  const [r] = await runChecks([hung], null, 150, 'az audit');
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual([r.status, r.line], ['fail', 'hung step: no answer after 0.2s']);
  assert.match(r.fix?.[0] ?? '', /run az audit again/);
});

/** A site reader that never answers: a synchronous loop, which no timer on its own thread could end. */
function stuckReader(): URL {
  const file = join(mkdtempSync(join(tmpdir(), 'az-audit-reader-')), 'stuck.mjs');
  writeFileSync(file, 'for (;;) { /* never yields */ }\n');
  return pathToFileURL(file);
}

test('a page of 300 000 unclosed tags is read, not timed out — the page scans are one linear pass (html-scan.ts)', async () => {
  // The regular-expression scans this replaced were quadratic on it: minutes of synchronous work for one 900KB file.
  const b = built(SITE, { 'index.html': PAGE(STRICT, '<a '.repeat(300_000)) });
  const r = await audit(options(b, { checks: AUDIT_CHECKS.filter((c) => c.id === 'page-csp' || c.id === 'new-tab-links') }));
  assert.deepEqual(r.checks.map((c) => [c.id, c.status]), [['page-csp', 'pass'], ['new-tab-links', 'skip']],
    r.checks.map((c) => c.line).join(' | '));
});

test('DEADLINE: a read of the built site that never answers is ended at its timeout — the line says so, every other check finishes', async () => {
  const b = built(BACKEND);
  const started = Date.now();
  const r = await audit(options(b, { siteReader: stuckReader(), siteMs: 1_000, deadlineMs: 10_000 }));
  const took = Date.now() - started;
  assert.ok(took < 8_000, `ended at the read's timeout, not the scan's end (${took}ms)`);
  assert.deepEqual(r.checks.map((c) => [c.id, c.status, c.line]), [
    ['bundle-secrets', 'fail', 'bundle secrets: no answer after 1s reading .az-build/dist — nothing it ships was checked'],
    ['server-keys', 'skip', 'server keys: the built site was not read — see the bundle secrets line'],
    ['dependencies', 'skip', 'dependencies: not checked — the advisory service is a network call; run: az audit --online'],
    ['page-csp', 'skip', 'page CSP: the built site was not read — see the bundle secrets line'],
    ['backend-csp', 'pass', r.checks[4].line],
    ['new-tab-links', 'skip', 'new-tab links: the built site was not read — see the bundle secrets line'],
    ['chat-shared-page', 'skip', 'chat shared page: the built site was not read — see the bundle secrets line'],
    ['chat-context', 'skip', 'chat context: the build has no chat server'],
    ['chat-runtime', 'skip', 'chat runtime: the site has no chat'],
  ]);
  assert.match(r.checks[4].line, /^backend CSP: every API response sends /);
  assert.equal(r.exit, 1);
});

test('DEADLINE: a check deadline shorter than the read\'s ends the run, and the read with it', async () => {
  const b = built(SITE);
  const started = Date.now();
  const r = await audit(options(b, { checks: AUDIT_CHECKS.filter((c) => c.id === 'bundle-secrets'), siteReader: stuckReader(), siteMs: 600_000, deadlineMs: 500 }));
  assert.ok(Date.now() - started < 3_000);
  assert.equal(r.checks[0].line, 'bundle secrets: no answer after 0.5s');
  // The worker is terminated once the report is in: if it were not, this test file would not exit for minutes.
});

test('SECURITY: a planted secret\'s value never reaches the report, text or JSON', async () => {
  const b = built(BACKEND, {
    'index.html': PAGE('', `<a target="_blank" href="/x?k=${PLANTED}">x</a>`),
    'assets/index.js': `const k="${PLANTED}";`,
    // A file named like the key: its name is a value too.
    [`assets/${PLANTED}.js`]: `const k="${PLANTED}";`,
  });
  writeFileSync(join(b.out, '.env.local'), `AZ_PUBLIC_SERVICE_KEY=${PLANTED}\n`);
  const r = await audit(options(b, { probe: fakeProbe({ env: { AZ_PUBLIC_OTHER: 'x' } }) }));
  assert.equal(r.checks.find((c) => c.id === 'bundle-secrets')?.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'new-tab-links')?.status, 'warn');
  for (const text of [formatReport(r, 'az audit'), JSON.stringify(r)]) {
    assert.ok(!text.includes(PLANTED), 'the planted key must not appear');
    assert.ok(!text.includes('Z9qZ9q'), 'no part of it either');
  }
});

/* ---- the binary, end to end ------------------------------------------------ */

/** Every file under a folder with its size and modification time. */
const snapshot = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).sort()
  .map((f) => { const s = statSync(join(dir, f)); return `${f} ${s.size} ${s.mtimeMs}`; });

const az = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', NO_NETWORK, BIN, 'audit', ...args], { cwd, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, timeout: 60_000 });

test('E2E: az audit on a built fixture with a planted key exits 1, never prints it, and --json says the same', () => {
  const b = built(BACKEND, { 'index.html': PAGE(), 'assets/index.js': `console.log(1);const k="${PLANTED}";` });
  const text = az(b.dir);
  assert.equal(text.status, 1, text.stderr);
  assert.ok(!text.stderr.includes('NETWORK ATTEMPT'), text.stderr);
  const lines = text.stdout.split('\n');
  assert.equal(lines[0], 'az audit');
  assert.ok(lines.includes('  ✗ bundle secrets: 1 key-shaped string in the built site — anyone who loads it can read it'), text.stdout);
  assert.ok(lines.includes(`      dist/assets/index.js:${'console.log(1);const k="'.length} (secret-prefix)`), text.stdout);
  assert.ok(lines.includes('  - dependencies: not checked — the advisory service is a network call; run: az audit --online'), text.stdout);
  assert.ok(lines.includes('  ! page CSP: none of 1 page sets a Content-Security-Policy — an injected script would run'), text.stdout);
  assert.ok(lines.some((l) => l.startsWith('  ✓ backend CSP: every API response sends')), text.stdout);
  assert.equal(lines.at(-2), 'az audit: 1 failure, 1 warning, 1 passed, 6 skipped');
  assert.ok(!text.stdout.includes(PLANTED));

  const json = az(b.dir, '--json', '--out', '.az-build');
  assert.equal(json.status, 1, json.stderr);
  const r = JSON.parse(json.stdout) as { ok: boolean; exit: number; checks: { id: string }[] };
  assert.deepEqual([r.ok, r.exit], [false, 1]);
  assert.deepEqual(r.checks.map((c) => c.id), AUDIT_CHECKS.map((c) => c.id));
  assert.ok(!json.stdout.includes(PLANTED));
});

test('E2E: a clean build exits 0 and reads only; a usage error exits 2', () => {
  const b = built(SITE);
  const before = snapshot(b.dir);
  const r = az(b.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ bundle secrets: none in 2 shipped text files/);
  assert.deepEqual(snapshot(b.dir), before, 'nothing written, changed or removed');
  assert.equal(az(b.dir, '--bogus').status, 2);
  const file = az(b.dir, 'site.az');
  assert.equal(file.status, 2);
  assert.match(file.stderr, /audit reads a build, not the \.az file/);
});
