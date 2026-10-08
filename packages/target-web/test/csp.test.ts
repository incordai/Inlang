/**
 * Each built page's Content-Security-Policy — word-quality-gate §2 B.
 *
 * csp.ts makes the policy from what a page needs (the emitter's
 * PageNeeds, written into build.mjs) and its final markup (hashes); these
 * pin both halves. scripts/verify-build.mjs checks the pages a real build
 * ships, and the browser gate (`csp`) loads every page in three engines and
 * fails on any violation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import {
  PolicyError, inlineScripts, inlineStyles, originOf, pagePolicy, sha256Source, styleAttributes, withPolicy, type PageNeeds,
} from '../src/csp.ts';
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

/** The NEEDS a site's build.mjs carries, by HTML file. */
function needsOf(src: string): Record<string, PageNeeds> {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const build = emitProject(r.spec, { emitters: WEB_EMITTERS }).files.find((f) => f.path === 'az-vite/build.mjs')?.content ?? '';
  const m = /\nconst NEEDS = ([\s\S]*?\n});\n/.exec(build);
  assert.ok(m, 'build.mjs carries NEEDS');
  return JSON.parse(m[1]) as Record<string, PageNeeds>;
}

const PLAIN: PageNeeds = { dataIcon: true, connect: [], images: [], decoder: false };
const page = (body: string) => `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>t</title>\n` +
  `    <script type="module" crossorigin src="./assets/main.js"></script>\n  </head>\n  <body>\n    <div id="root">${body}</div>\n  </body>\n</html>\n`;
/** The base64 SHA-256 of exactly these characters, computed here independently of csp.ts. */
const digest = (text: string) => `'sha256-${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('base64')}'`;

test('a plain page: same-origin everything, its data: icon, no plugin, no moved base', () => {
  assert.equal(pagePolicy(PLAIN, page('<main><h1>Hi</h1></main>'), {}),
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
  assert.doesNotMatch(pagePolicy(PLAIN, page(''), {}), /unsafe-inline|unsafe-eval|frame-ancestors/,
    'never unsafe-inline or unsafe-eval; frame-ancestors is ignored in a meta, so it is never written');
  assert.match(pagePolicy({ ...PLAIN, dataIcon: false }, page(''), {}), /img-src 'self'; /, 'a site icon file: no data: at all');
});

test('inline scripts: each executed one by the hash of its exact text; data blocks and src scripts are not scripts to allow', () => {
  const run = 'window.__a = "café — </p>";\n';
  const other = ' document.documentElement.dataset.x = "1" ';
  const html = page(`<main><script>${run}</script><script type="module">${other}</script>` +
    '<script type="application/ld+json">{"@type":"FAQPage"}</script></main>');
  assert.deepEqual(inlineScripts(html), [run, other], 'byte for byte, whitespace kept');
  const policy = pagePolicy(PLAIN, html, {});
  const script = /script-src ([^;]*)/.exec(policy)?.[1].split(' ') ?? [];
  assert.deepEqual(script, ["'self'", ...[digest(run), digest(other)].sort()], 'the hashes match the page\'s own bytes');
  assert.equal(sha256Source(run), digest(run));
  // A browser hashes the text after its parser turned CR LF into LF.
  assert.deepEqual(inlineScripts(page('<script>a();\r\nb();</script>')), ['a();\nb();']);
});

test('style attributes: allowed by hash only, with unsafe-hashes — decoded as the browser reads them', () => {
  const html = page('<p class="x" style="color:var(--az-color-accent)">a</p><span style="content:&quot;&amp;&quot;">b</span>' +
    '<script>const s = \'<i style="color:red">\';</script><!-- <b style="color:blue"> -->');
  assert.deepEqual(styleAttributes(html), ['color:var(--az-color-accent)', 'content:"&"'],
    'a style= inside a script or a comment is not an attribute');
  const style = /style-src ([^;]*)/.exec(pagePolicy(PLAIN, html, {}))?.[1].split(' ') ?? [];
  assert.deepEqual(style, ["'self'", "'unsafe-hashes'", ...[digest('color:var(--az-color-accent)'), digest('content:"&"')].sort()]);
  assert.match(pagePolicy(PLAIN, page('<p>no styles</p>'), {}), /style-src 'self'; /, 'CONTROL: no attribute, no unsafe-hashes');
  const sheet = page('<style>.a{color:red}</style>');
  assert.deepEqual(inlineStyles(sheet), ['.a{color:red}']);
  assert.match(pagePolicy(PLAIN, sheet, {}), new RegExp(`style-src 'self' ${digest('.a{color:red}').replace(/[+/]/g, '\\$&')}; `),
    'an inline sheet needs its hash, not unsafe-hashes');
});

test('a page with a 3D model: wasm-unsafe-eval and a blob: worker for the decoder — never unsafe-eval', () => {
  const policy = pagePolicy({ ...PLAIN, decoder: true }, page(''), {});
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'; /);
  assert.match(policy, /worker-src 'self' blob:; /);
  assert.match(policy, /img-src 'self' data:; connect-src 'self' blob:; /,
    'a model\'s embedded textures are fetched from blob: URLs and decoded as bitmaps: connect-src, not img-src');
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  assert.doesNotMatch(pagePolicy(PLAIN, page(''), {}), /wasm|worker-src|blob:/, 'CONTROL: none of it without a model');
});

test('origins come from the public variables a page names, and nothing else', () => {
  const env = { AZ_PUBLIC_AUTH_URL: 'https://auth.example.org/v1/', AZ_PUBLIC_BACKEND_URL: 'https://api.example.org', AZ_PUBLIC_OTHER_URL: 'https://other.example.org' };
  const policy = pagePolicy({ ...PLAIN, connect: ['AZ_PUBLIC_AUTH_URL'], images: ['AZ_PUBLIC_BACKEND_URL'] }, page(''), env);
  assert.match(policy, /img-src 'self' data: https:\/\/api\.example\.org; connect-src 'self' https:\/\/auth\.example\.org; /, 'the origin, never the path');
  assert.doesNotMatch(policy, /other\.example/);
  assert.match(pagePolicy({ ...PLAIN, connect: ['AZ_PUBLIC_AUTH_URL'] }, page(''), {}), /connect-src 'self'; /, 'unset: nothing added');
  assert.throws(() => originOf('AZ_PUBLIC_AUTH_URL', 'not a url'), PolicyError);
  assert.throws(() => originOf('AZ_PUBLIC_AUTH_URL', 'javascript:alert(1)'), PolicyError);
});

test('withPolicy: the meta is the first thing after the charset, before any script or stylesheet', () => {
  const out = withPolicy(page(''), "default-src 'self'");
  const meta = out.indexOf('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'" />');
  assert.ok(meta > out.indexOf('<meta charset="utf-8" />') && meta < out.indexOf('<script'), out.slice(0, 300));
  assert.throws(() => withPolicy('<html><head></head></html>', 'x'), PolicyError);
});

test('the emitter\'s needs: per page, only what that page does', () => {
  const plain = needsOf('az 1\nsite aurora\npage /\n  hero center\n    title "x"\npage /work\n');
  assert.deepEqual(plain, { 'index.html': PLAIN, 'work/index.html': PLAIN });

  // A model on / only: the decoder there, and nowhere else.
  const three = needsOf('az 1\nsite aurora\npage /\n  hero split 3d\n    title "x"\n    describe "A shoe"\n    model ./shoe.glb\n' +
    'page /plain\n  hero center\n    title "y"\npage /proc\n  hero split 3d\n    title "z"\n    describe "Strands"\n');
  assert.equal(three['index.html'].decoder, true);
  assert.equal(three['plain/index.html'].decoder, false);
  assert.equal(three['proc/index.html'].decoder, false, 'a procedural scene decodes nothing');

  // Auth: every page calls the adapter's origin — the session check runs on each.
  const hosted = needsOf('az 1\nsite aurora\n  auth\n    adapter hosted\npage /\n  hero center\n    title "x"\npage /login\n  auth login\n');
  assert.deepEqual(Object.values(hosted).map((n) => n.connect), [['AZ_PUBLIC_AUTH_URL'], ['AZ_PUBLIC_AUTH_URL']]);
  const session = needsOf('az 1\nsite aurora\n  auth\n    adapter session\npage /\n  hero center\n    title "x"\npage /login\n  auth login\n');
  assert.deepEqual(Object.values(session).map((n) => n.connect), [[], []], 'session is same-origin');

  // Uploaded images: from the backend, on the page whose block reads rows and on the admin pages.
  const data = needsOf(`az 1
site shop
  auth
    adapter azbackend
  backend
    database sqlite
    email smtp
  data notes
    title text required
    photo image
    allow anyone read
page /
  hero center
    title "Hi"
page /list
  feature grid
    from notes
      title title
page /mine
  raw ./custom/Notes.tsx
page /login
  auth login
`);
  assert.deepEqual(data['index.html'], { dataIcon: true, connect: ['AZ_PUBLIC_BACKEND_URL'], images: [], decoder: false });
  assert.deepEqual(data['list/index.html'].images, ['AZ_PUBLIC_BACKEND_URL']);
  assert.deepEqual(data['mine/index.html'].images, ['AZ_PUBLIC_BACKEND_URL'], 'an author component may show rows through the client');
  assert.deepEqual(data['login/index.html'].images, [], 'CONTROL: a page that cannot show rows');
  const admin = Object.keys(data).filter((f) => f.startsWith('admin'));
  assert.ok(admin.length > 0 && admin.every((f) => data[f].images[0] === 'AZ_PUBLIC_BACKEND_URL'), admin.join(' '));
});

test('build.mjs gives every page its policy after the pre-render, from csp.ts beside it', () => {
  const r = compile('az 1\nsite aurora\npage /\n  hero center\n    title "x"\n', { manifests });
  assert.ok(r.ok && r.spec);
  const build = emitProject(r.spec, { emitters: WEB_EMITTERS }).files.find((f) => f.path === 'az-vite/build.mjs')?.content ?? '';
  assert.match(build, /import \{ ownDigests, pagePolicy, withPolicy \} from "\.\/csp\.ts";/);
  assert.match(build, /const env = loadEnv\("production", root, "AZ_PUBLIC_"\);/, 'origins from the public env only');
  const render = build.indexOf('render(route)');
  assert.ok(render > 0 && build.indexOf('withPolicy(filled, pagePolicy(page, filled, env))') > render, 'the policy is made from the filled page');
  // word-quality-gate §5.5: every page as written goes through the guard's scan; a hit removes dist/.
  const wrote = build.indexOf('writeFileSync(file, text)');
  const scanned = build.indexOf('await shippedSecrets(written, join(root, "node_modules"), scan)');
  assert.ok(wrote > render && scanned > wrote, 'the pages are scanned once they are written');
  assert.ok(build.indexOf('bundleMessage(h.path, h.finding, "page")') > scanned && build.indexOf('await removeOutput(root, dist)') > scanned);
  const html = emitProject(r.spec, { emitters: WEB_EMITTERS }).files.find((f) => f.path === 'index.html')?.content ?? '';
  assert.doesNotMatch(html, /Content-Security-Policy/, 'the template the dev server serves carries none');
});
