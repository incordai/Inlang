/**
 * Secret detection — auth-block-spec §4, §11. Test values are built at
 * runtime from obviously fake parts; none is a real key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../src/index.ts';
import { entropy, isSecretLiteral, ownNames, redact, scanEnv, scanText, siteScanner } from '../src/secrets.ts';
import { legacyScanText } from './legacy-secrets.ts';
import { referenceScanText } from './reference-secrets.ts';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role: string) => `${b64url({ alg: 'HS256' })}.${b64url({ role, iss: 'probe' })}.c2lnbmF0dXJlLXByb2Jl`;
/** 40 characters of letters and digits with high entropy — a key's shape. */
const RANDOMISH = 'Zq8Lm2Xv7Rt4Wp9Kd3Hs6Nb1Gc5Fy0JaQe8UoTi';

const rules = (text: string, allow?: Set<string>) => scanText(text, allow).map((f) => f.rule).sort();

test('the shape rules: private key block, secret prefix, service_role, privileged token', () => {
  assert.deepEqual(rules('x -----BEGIN RSA PRIVATE KEY----- y'), ['pem']);
  assert.deepEqual(rules(`k="sk_live_${'A1b2C3d4'.repeat(3)}"`), ['secret-prefix']);
  assert.deepEqual(rules('{"role":"service_role"}'), ['service-role']);
  assert.deepEqual(rules(`t="${jwt('service_role')}"`), ['jwt-privileged']);
});

test('CONTROL: a public (anon) token and ordinary code pass', () => {
  assert.deepEqual(rules(`t="${jwt('anon')}"`), []);
  assert.deepEqual(rules('function a(b){return b.map((c)=>c*2)}const x="Handmade. Forty pairs."'), []);
});

test('entropy: a long random string fails, unless it is the site\'s public value or inlined data', () => {
  assert.deepEqual(rules(`const k="${RANDOMISH}"`), ['entropy']);
  assert.deepEqual(rules(`const k="${RANDOMISH}"`, new Set([RANDOMISH])), [], 'the public key is allowed');
  assert.deepEqual(rules(`url(data:image/webp;base64,${RANDOMISH})`), [], 'an inlined asset is not a key');
  assert.deepEqual(rules('const hash="abcdefabcdefabcdefabcdefabcdefabcdef"'), [], 'low entropy is not a key');
});

test('SECURITY: a finding never repeats the secret it found', () => {
  for (const f of scanText(`k="${RANDOMISH}" ${jwt('service_role')}`)) {
    assert.ok(!f.excerpt.includes(RANDOMISH) && !f.excerpt.includes(jwt('service_role')), f.excerpt);
  }
  assert.equal(redact('a-secret-value'), '[redacted, 14 chars]');
});

test('env: only the public prefix is judged — by name, then by value', () => {
  const found = scanEnv({
    AZ_PUBLIC_SERVICE_KEY: 'anything',
    AZ_PUBLIC_DB_KEY: jwt('service_role'),
    AZ_PUBLIC_AUTH_KEY: jwt('anon'),
    AZ_PUBLIC_AUTH_URL: 'https://auth.invalid',
    DATABASE_SERVICE_KEY: jwt('service_role'),
  });
  assert.deepEqual(found.map((f) => `${f.where}:${f.rule}`), ['AZ_PUBLIC_DB_KEY:jwt-privileged', 'AZ_PUBLIC_SERVICE_KEY:private-name']);
});

test('CONTROL: a public key alone passes the env rule, high entropy and all', () => {
  assert.deepEqual(scanEnv({ AZ_PUBLIC_AUTH_KEY: RANDOMISH, AZ_PUBLIC_AUTH_URL: 'https://auth.invalid' }), []);
});

test('isSecretLiteral: any token is a literal key in source; prose is not', () => {
  assert.ok(isSecretLiteral(jwt('anon')));
  assert.ok(isSecretLiteral(RANDOMISH));
  assert.ok(!isSecretLiteral('Built in the dark'));
  assert.ok(!isSecretLiteral('/account'));
});

/* ---- AZ1411 through the compiler --------------------------------------- */

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}
const codes = (src: string) => compile(src, { manifests }).diagnostics.map((d) => d.code);

test('AZ1411: a key written into the .az file is an error, wherever it is', () => {
  assert.ok(codes(`az 1\nsite a\npage /\n  hero center\n    title "${jwt('anon')}"\n`).includes('AZ1411'));
  assert.ok(codes(`az 1\nsite a\npage /\n  hero center\n    title "x"\n    cta "${RANDOMISH}" /\n`).includes('AZ1411'));
});

test('CONTROL: an ordinary site has no AZ1411', () => {
  const src = readFileSync(new URL('./fixture-site.az', import.meta.url), 'utf8');
  assert.ok(!codes(src).includes('AZ1411'));
});

/* ---- graphics code is not a leak -------------------------------------------- */

test('WebGL names in a 3D bundle are not secrets: property accesses and extension names', () => {
  const graphics = [
    'ext.framebufferTexture2DMultisampleEXT(gl.FRAMEBUFFER)',
    'return e.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR',
    "extensions.get('WEBGL_compressed_texture_s3tc_srgb')",
    'const name = "KHR_materials_emissive_strength"',
  ].join(';\n');
  assert.deepEqual(scanText(graphics), []);
});

test('SECURITY: the exemptions do not open a hole for real keys', () => {
  const key = 'Xk9vQ2mZr7Lp4sBw8TnC3yHd6JfA1gKe';
  // As a value: a string literal, an assignment, a URL path (a webhook token).
  for (const text of [
    `const k = "${key}"`,
    `token=${key}`,
    `fetch("https://hooks.example.com/${key}")`,
    `fetch("https://hooks.example.com/services/T00/${key}")`,
    // A registry-looking prefix does not launder a mixed-case random tail.
    `const k = "WEBGL_${key}"`,
  ]) {
    assert.equal(scanText(text).length, 1, text);
  }
});

/* ---- a map library's bundle is not a leak (chat-block-spec §21.4, stack-evaluation §19) ---- */

test('code and links in a bundled map library are not keys: NAME=value runs, a path of words, the build\'s own file names', () => {
  // As measured in the map library's minified bundle: an assignment in a shader, a property set, a constant, a link in a message.
  const library = [
    'const float ATMOSPHERE_HEIGHT_TO_GLOBE_RADIUS=100000.0/6371000.0;',
    'this._globeViewProjMatrixF64Inverted=ot(),this._globeProjMatrixInverted=ot()',
    'static{this.MAX_TEXTURE_POOL_SIZE_PER_BUCKET=50}',
    'warnOnce(`See https://github.com/org/project-gl-js/issues/2907`)',
  ].join(';\n');
  assert.deepEqual(scanText(library), []);
  // The worker file's own hashed name, as a chunk names it, is allowed — exactly that name, no other.
  const chunk = 'var e=`/assets/maplibre-gl-worker-VaXr2Fck.mjs`;export{e as default};';
  const names = ownNames(['assets/maplibre-gl-worker-VaXr2Fck.mjs', 'assets/main-B6rAErZn.js', 'index.html']);
  assert.deepEqual(scanText(chunk, new Set(names)), []);
  assert.equal(scanText(chunk).length, 1, 'CONTROL: without the build\'s names the hashed path reads as a key');
  assert.equal(scanText('var e=`/assets/maplibre-gl-worker-WbYs3Gdl.mjs`;', new Set(names)).length, 1, 'another hash is not the build\'s file');
  // As the map site's chunk names it today — relative to itself — the name is under the rule's floor, allowed or not.
  assert.deepEqual(scanText('var DI=``+new URL(`maplibre-gl-worker-VaXr2Fck.mjs`,import.meta.url).href'), []);
});

/** The map library's published files, as the map site's bundle carries them (a root devDependency, pinned). */
const MAP_LIBRARY = new URL('../../../node_modules/maplibre-gl/dist/', import.meta.url);
const MAP_FILES = ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

test('the map library\'s own files hold no key: the runs that once read as keys pass, each by the rule meant for it', () => {
  let once = 0;
  for (const name of MAP_FILES) {
    const text = readFileSync(new URL(name, MAP_LIBRARY), 'utf8');
    once += legacyScanText(text).length;
    assert.deepEqual(scanText(text), [], name);
  }
  // CONTROL: the rules as they were before NAME=value was two runs and a path of words passed found these.
  assert.ok(once >= 6, `the library's files hold the shapes that once read as keys (${once})`);
  // The link in its message, as the file writes it: a path of lowercase words and an issue number.
  const text = readFileSync(new URL(MAP_FILES[0], MAP_LIBRARY), 'utf8');
  const links = [...text.matchAll(/[a-z]+\/[a-z-]+\/[a-z-]+\/issues\/[0-9]+/g)].map((m) => m[0]);
  assert.ok(links.length > 0 && links.every((l) => l.length >= 32 && entropy(l) >= 4), 'CONTROL: the link is long and dense enough to be judged');
  for (const l of links) assert.deepEqual(scanText(`warnOnce(\`See https://host.${l}\`)`), [], l);
});

/* ---- findings of the review of the loosened rule: each a real-looking key that shipped ---- */

/** Obviously fake keys of letters and digits, built for the length each case needs. */
const K30 = 'Qx7Lm2Vb9Rt4Wp8Kd3Hs6Nz1Gc5FyA';
const K31 = `${K30}j`;
const K24 = 'Ab3dE5gH7jK9mN1pQ3sT5vW7';

test('padding: base64 of 22 or 23 bytes — 30 characters and ==, 31 and = — is a key at the rule\'s floor', () => {
  assert.equal(K30.length, 30);
  for (const text of [`k="${K30}=="`, `k="${K31}="`, `fetch("/x?t=${K30}==&a=1")`]) {
    const found = scanText(text);
    assert.deepEqual(found.map((f) => f.rule), ['entropy'], text);
  }
  assert.equal(scanText(`k="${K30}=="`)[0].excerpt, redact(`${K30}==`), 'the pad counts toward the length');
  // CONTROL: the same characters without a pad are under the floor; a name of 31 characters set to a value is not padded.
  assert.deepEqual(scanText(`k="${K31}"`), []);
  assert.deepEqual(scanText('this._globeViewProjMatrixF64Inverted=ot()'), []);
  assert.deepEqual(scanText(`k="${K30}===x"`), [], 'three = are not a pad');
});

test('a short key a credential\'s name is set to: a query string, a config line, a cookie', () => {
  for (const text of [
    `fetch("https://tiles.example.com/v1/{z}/{x}/{y}.pbf?api_key=${K24}&lang=en")`,
    `API_KEY=${K24}\n`,
    `document.cookie="session_token=${K24}; path=/; secure"`,
    `location.hash="#access_token=${K24}"`,
    `x?sig=${K24}`,
  ]) {
    assert.deepEqual(scanText(text).map((f) => f.rule), ['entropy'], text);
    assert.ok(isSecretLiteral(text), text);
  }
  // A long one is reported once, by the run rule.
  assert.equal(scanText(`?token=${K30}==`).length, 1);
});

test('CONTROL: a name that is not a credential\'s, an empty value, a short or repeated one, code that sets a name', () => {
  for (const text of [
    '?page=2', '?sort=name', '?token=&page=2', '?api_key=demo', '?token=abc123abc123abc123',
    '?auth=redirect', 'a.key=createTokenizer16Bit', '?api_key=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '?redirect_token=/account/settings/2024',
  ]) {
    assert.deepEqual(scanText(text), [], text);
  }
});

test('a path segment of random letters is judged — only all digits or lowercase words are plain', () => {
  for (const text of [
    'fetch("https://hooks.example.com/services/12345/AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf")',
    'fetch("https://example.com/org/12345/project/ZyXwVuTsRqPoNmLkJiHgFeDcBa")',
  ]) {
    assert.deepEqual(scanText(text).map((f) => f.rule), ['entropy'], text);
  }
  // CONTROL: lowercase words with hyphens and an issue number stay a path of words.
  assert.deepEqual(scanText('See https://code.example.com/org/project-gl-js/issues/2907'), []);
});

test('ownNames: only the run a file the bundler emitted starts with — never a run inside another name', () => {
  const key = 'Zq8Lm2Xv7Rt4Wp9Kd3Hs6Nb1Gc5Fy0JaQe';
  // A file copied from public/ is not passed (it is not in the bundle), and even passed its inner run is not a name.
  const names = new Set(ownNames([`public/logo.${key}.svg`, `assets/logo.${key}.svg`]));
  assert.equal(scanText(`var k="${key}"`, names).length, 1, 'a key inside a shipped file\'s name is still a key elsewhere');
  assert.deepEqual(ownNames([`public/logo.${key}.svg`]), []);
  // The build's own worker file: its path and its path after / (its name alone is under the rule's floor).
  assert.deepEqual(ownNames(['assets/maplibre-gl-worker-VaXr2Fck.mjs']).sort(), ['/assets/maplibre-gl-worker-VaXr2Fck', 'assets/maplibre-gl-worker-VaXr2Fck']);
  // A long file name is a name by itself too, as a chunk beside it names it.
  assert.deepEqual(ownNames(['assets/chat-map-gl-runtime-module-B6rAErZn.js']).sort(),
    ['/assets/chat-map-gl-runtime-module-B6rAErZn', '/chat-map-gl-runtime-module-B6rAErZn', 'assets/chat-map-gl-runtime-module-B6rAErZn', 'chat-map-gl-runtime-module-B6rAErZn']);
});

test('siteScanner: the one scan of a built site — public values, the emitted files\' names, a text\'s own digests', () => {
  const PUBLIC = 'Pk7vR2mQ9xL4tW8nB3cY6hJ1sD5fG0aZeUoIpKjHgFdSa';
  const digest = 'Dg4hT7kL2pQ9wX3zV6bN1mC8rF5jS0aYeUiOpKlHgTr=';
  // As csp.ts ownDigests gives them: the source expression without its quotes.
  const scan = siteScanner([PUBLIC], ['assets/map-library-worker-VaXr2Fck.mjs'], (text) => (text.includes('<style>') ? [`sha256-${digest}`] : []));
  assert.deepEqual(scan(`k="${PUBLIC}";u="/assets/map-library-worker-VaXr2Fck.mjs"`), []);
  assert.deepEqual(scan(`<style>a{}</style><meta content="'sha256-${digest}'">`), []);
  // CONTROL: a digest the text does not pin, another hash of the worker, a key — each judged.
  assert.equal(scan(`<p>'sha256-${digest}'</p>`).length, 1);
  assert.equal(scan('u="/assets/map-library-worker-WbYs3Gdl.mjs"').length, 1);
  assert.equal(scan(`?api_key=${K24}`).length, 1);
  // A public URL carrying its own public key ships as it is: allowed whole and by the parts the scan reads alone.
  const tiles = `https://tiles.example.com/{z}/{x}/{y}.pbf?key=${K24}&v=${RANDOMISH}`;
  const withTiles = siteScanner([tiles], [], () => []);
  assert.deepEqual(withTiles(`const u=${JSON.stringify(tiles)};`), []);
  assert.equal(withTiles(`?key=${K24.split('').reverse().join('')}`).length, 1, 'CONTROL: another key in the same place is judged');
});

test('the secret prefix: inside a longer name, after _, and as short as real keys of it are', () => {
  for (const text of [
    `k="xsk_live_${K24.slice(0, 16)}"`,
    `const api_sk_live_${K24.slice(0, 12)} = 1`,
    `k="api_sk_live_${K24.slice(0, 16)}"`,
    'k="sk_live_Ab3dE5gH7j"',
    'k="rk_test_Ab3dE5gH7j"',
    `k="api_sk_${K24}"`,
  ]) {
    assert.ok(scanText(text).some((f) => f.rule === 'secret-prefix'), text);
  }
  // CONTROL: words that hold the letters, a mode with too few characters, a bare prefix inside a word.
  for (const text of ['task_list', 'task_listOfThingsToDo123', 'disk_test_results', 'k="sk_live_Ab3dE5gH7"', `mask_${K24}`, 'risk_live_feed']) {
    assert.ok(!scanText(text).some((f) => f.rule === 'secret-prefix'), text);
  }
});

test('SECURITY: a key is still found inside each of those shapes — after =, with padding, in a path segment', () => {
  const key = 'Xk9vQ2mZr7Lp4sBw8TnC3yHd6JfA1gKe';
  for (const text of [
    `const API_TOKEN_FOR_THE_SERVICE_ACCOUNT=${key}`,
    `k="${key}=="`,
    `fetch("https://hooks.example.com/services/T00/${key}")`,
    `fetch("https://example.com/org/project/issues/${key}")`,
    `a=b=c=${key}`,
  ]) {
    assert.equal(scanText(text).length, 1, text);
  }
  // Base64 padding stays part of the key it ends.
  assert.equal(scanText(`k="${key}=="`)[0].excerpt, redact(`${key}==`));
});

test('env: a backend server setting given a public name fails the site build (backend-spec §4)', () => {
  const found = scanEnv({
    AZ_PUBLIC_SMTP_PASSWORD: 'hunter2hunter2',
    AZ_PUBLIC_DATABASE_URL: 'postgres://u:p@db.internal/app',
    AZ_PUBLIC_EMAIL_API_KEY: 'k-123',
    AZ_PUBLIC_SESSION_SECRET: 'x'.repeat(43),
    AZ_PUBLIC_BACKEND_URL: 'https://api.example.org',
  });
  assert.deepEqual(found.map((f) => f.where), [
    'AZ_PUBLIC_DATABASE_URL', 'AZ_PUBLIC_EMAIL_API_KEY', 'AZ_PUBLIC_SESSION_SECRET', 'AZ_PUBLIC_SMTP_PASSWORD',
  ]);
  assert.ok(found.every((f) => f.rule === 'private-name'));
  // The server's own names carry no public prefix and are never judged, never inlined.
  assert.deepEqual(scanEnv({ AZ_SMTP_PASSWORD: 'hunter2hunter2', AZ_DATABASE_URL: 'postgres://u:p@h/db' }), []);
});

test('env: nothing about chat is public — AZ_PUBLIC_CHAT_* fails the site build (chat-block-spec §6.4)', () => {
  // The page reaches chat through AZ_PUBLIC_BACKEND_URL; a key, URL or model
  // id with a public name would ship the operator's model access to every visitor.
  const found = scanEnv({
    AZ_PUBLIC_CHAT_KEY: 'k-123',
    AZ_PUBLIC_CHAT_URL: 'https://models.example.org/v1',
    AZ_PUBLIC_CHAT_MODEL: 'some-model',
    AZ_PUBLIC_BACKEND_URL: 'https://api.example.org',
    // Public by design (auth-block-spec §3.1): a generic KEY rule would refuse it.
    AZ_PUBLIC_AUTH_KEY: 'pk-123',
  });
  assert.deepEqual(found.map((f) => f.where), ['AZ_PUBLIC_CHAT_KEY', 'AZ_PUBLIC_CHAT_MODEL', 'AZ_PUBLIC_CHAT_URL']);
  assert.ok(found.every((f) => f.rule === 'private-name'));
  // The server's own chat names carry no public prefix and are never judged.
  assert.deepEqual(scanEnv({ AZ_CHAT_KEY: 'k-123', AZ_CHAT_URL: 'https://models.example.org/v1' }), []);
});

/* ---- a hex key a credential's name is set to: hex's own measure, never a bare hex run ---- */

/** A seeded source of fake values, so every case and failure reproduces. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
}
const HEX = '0123456789abcdef';
/** `count` fake hex values of `length`, drawn from `digits` (all sixteen by default). */
function fakeHex(seed: number, count: number, length: number, digits = HEX): string[] {
  const next = seeded(seed);
  return Array.from({ length: count }, () => Array.from({ length }, () => digits[Math.floor(next() * digits.length)]).join(''));
}
/** The floor a named value had before hex was judged by its own measure — what each case below fell under. */
const OLD_NAMED_BITS = 3.0;

test('SECURITY: a random hex key of 16 to 64 characters set to a credential\'s name is found', () => {
  // 16, 20 and 24 characters: random draws that measure under the old 3.0-bit floor (14%, 3% and 0.5% of them do).
  // 32, 40 and 64: random hex over seven of its digits — every such draw is under the old floor.
  const keys = [
    ...[16, 20, 24].map((n) => fakeHex(16 + n, 2_000, n).find((k) => entropy(k) < OLD_NAMED_BITS && /[a-f]/.test(k) && /[0-9]/.test(k))),
    ...[32, 40, 64].map((n) => fakeHex(n, 1, n, '03579bd')[0]),
  ];
  for (const key of keys) {
    assert.ok(key !== undefined && entropy(key) < OLD_NAMED_BITS, `CONTROL: ${key?.length}-character key is under the old floor`);
    for (const text of [`fetch("/v1/tiles?api_key=${key}&lang=en")`, `AUTH_TOKEN=${key.toUpperCase()}\n`, `document.cookie="session_secret=${key}; path=/"`, `x?sig=${key}`]) {
      assert.deepEqual(scanText(text).map((f) => f.rule), ['entropy'], `${key.length}: ${text}`);
      assert.equal(scanText(text)[0].excerpt, redact(key), 'the finding names the length only');
    }
  }
});

test('the hex threshold, as measured: 99% or more of 10 000 random hex keys a length are found by name', () => {
  for (const n of [16, 17, 18, 19, 20, 21, 22, 23, 24, 32, 40, 64]) {
    const keys = fakeHex(1_000 + n, 10_000, n);
    const found = keys.filter((k) => scanText(`?token=${k}`).length === 1).length;
    assert.ok(found >= 9_900, `${n} characters: ${found} of 10 000 found`);
    if (n >= 24) assert.equal(found, keys.filter((k) => /[a-f]/.test(k) && /[0-9]/.test(k)).length, `${n}: from 24 every key mixing letters and digits`);
  }
});

test('CONTROL: an id, zeros, a version, a unit repeated or counted, and a bare hex hash are not keys', () => {
  for (const text of [
    '?id=deadbeefdeadbeef', 'token=0000000000000000', '?version=1a2b3c', '?token=deadbeefdeadbeef', '?token=00000000deadbeef',
    '?token=0123456789abcdef', '?key=fedcba9876543210', '?key=0123456789abcdef0123456789', `?token=${'a1b2c3d4'.repeat(4)}`, `?sig=${'cafe1234'.repeat(8)}`,
  ]) {
    assert.deepEqual(scanText(text), [], text);
  }
  // A content hash, an asset's hash and a commit id are hex in every bundle: with no credential's name before them, never judged as one.
  for (const n of [32, 40, 64]) {
    for (const h of fakeHex(2_000 + n, 200, n)) {
      for (const text of [`const h="${h}"`, `{"hash":"${h}","size":12}`, `u="/assets/chunk.${h}.js"`, `commit ${h}\n`, `?v=${h}`]) {
        assert.deepEqual(scanText(text), [], text);
      }
    }
  }
});

/* ---- the JWT rule: one pass, exactly the old regular expression's finds ---- */

/** CPU milliseconds `f` takes: the least of `runs` (process.cpuUsage, so a loaded machine cannot fail it). */
function cpuMs(f: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = process.cpuUsage();
    f();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}
/** The bound: CPU time per input character. Measured ~10ns here; 1µs leaves room for a slow machine. */
const NS_PER_CHAR = 1_000;
/** Eight times the input may cost at most this many times more — linear is ~8, quadratic ~64. */
const GROWTH_8X = 24;

test('LINEAR: a 5MB run of `eyJ` — no token, under the bound, and eight times the input about eight times the cost', () => {
  const big = 'eyJ'.repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const small = big.slice(0, big.length / 8);
  const tBig = cpuMs(() => scanText(big), 1);
  const tSmall = cpuMs(() => scanText(small));
  assert.ok(tBig <= (big.length * NS_PER_CHAR) / 1e6, `${tBig.toFixed(1)}ms CPU for ${big.length} characters`);
  assert.ok(tBig <= GROWTH_8X * Math.max(tSmall, 1), `8× the input took ${(tBig / tSmall).toFixed(1)}× (${tSmall.toFixed(1)} → ${tBig.toFixed(1)}ms)`);
});

test('LINEAR: a 5MB text of short tokens — the JWT spans are walked once, not searched for every run', () => {
  const token = jwt('anon');
  const big = `${token} `.repeat(Math.ceil((5 * 1024 * 1024) / (token.length + 1)));
  const tBig = cpuMs(() => scanText(big), 1);
  assert.ok(tBig <= (big.length * NS_PER_CHAR) / 1e6, `${tBig.toFixed(1)}ms CPU for ${big.length} characters`);
});

test('QUADRATIC (old code): a run of `eyJ` — eight times the input costs far more than eight times as much, past the bound', () => {
  const small = 'eyJ'.repeat(2_000);
  const big = 'eyJ'.repeat(16_000);
  const tSmall = cpuMs(() => legacyScanText(small));
  const tBig = cpuMs(() => legacyScanText(big), 1);
  assert.ok(tBig > GROWTH_8X * Math.max(tSmall, 1), `8× the input took ${(tBig / tSmall).toFixed(1)}× (${tSmall.toFixed(1)} → ${tBig.toFixed(1)}ms)`);
  assert.ok(tBig > (big.length * NS_PER_CHAR) / 1e6, `CONTROL: ${tBig.toFixed(1)}ms CPU for ${big.length} characters is past the bound`);
});

test('LINEAR: 5MB of names never set, one 5MB run with a pad that is not one, 5MB named hex values — under the bound', () => {
  const MB5 = 5 * 1024 * 1024;
  for (const big of [
    ' apiKeyName'.repeat(Math.ceil(MB5 / 11)), `?token=${'A1'.repeat(MB5 / 2)}==x`,
    // Hex values its period and its count are read from: a random one, one a near repeat, and many short ones.
    `?api_key=${fakeHex(5, 1, MB5)[0]}`, `?api_key=${'a1'.repeat(MB5 / 2)}b`, `&token=${fakeHex(6, 1, 20)[0]}`.repeat(MB5 / 27),
  ]) {
    const t = cpuMs(() => scanText(big), 1);
    assert.ok(t <= (big.length * NS_PER_CHAR) / 1e6, `${t.toFixed(1)}ms CPU for ${big.length} characters`);
  }
});

test('EQUIVALENCE: every finding exactly the plain rules\' — real tokens, near-misses, and 8 000 generated texts', () => {
  const service = jwt('service_role');
  const anon = jwt('anon');
  const fixed = [
    `t="${service}"`, `a ${anon} b ${service}.x`, `x${service}`, `eyJ${service}`, `${service}.${anon}`,
    `eyJabcdefgh.abcdefgh.abcdefg`, `eyJabcdefg.abcdefgh.abcdefgh`, `eyJabcdefgh.abcdefgh.abcdefgh`, `eyJeyJabcdefgh.abcdefgh.abcdefgh`,
    `abcdeyJ12345678.12345678.12345678.12345678`, `eyJ1234567eyJ12345678.12345678.12345678`, `${RANDOMISH} ${anon} ${RANDOMISH}`,
    // Named hex at and around each edge: 15, 16, 23 and 24 characters, a repeat with a partial copy, a count that wraps, two cases.
    ...[15, 16, 23, 24].flatMap((n) => fakeHex(30 + n, 3, n).map((h) => `?key=${h}&token=${h.toUpperCase()}`)),
    '?key=deadbeefdeadbeefdead', '?key=deadbeefdeadbeefdeadb', '?sig=cdef0123456789abcdef01', '?sig=cdef0123456789abcdef01x', '?key=9F3Ac07E5b1D42e8aB6c',
  ];
  for (const text of fixed) assert.deepEqual(scanText(text), referenceScanText(text), text);
  // Seeded, so a failure reproduces: texts made of the pieces the rule reads.
  let seed = 7;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
  const pieces = [
    'eyJ', 'eyJh', 'abcdefgh', 'Q9', '.', '.', '-', '_', ' ', '"', 'x', RANDOMISH, service, anon, '12345678',
    // Pads, paths and query strings: what the run's pad, the path rule and a credential's named value read.
    '=', '==', '/', '/', 'issues', '2907', 'AbCdEfGh', '?', '&', ';', '#', '\n', 'api_key=', 'token=', 'page=', 'sk_live_', 'Xk9vQ2mZr7Lp4sBw',
  ];
  // Named hex: random, repeated, counted and over few digits — what a named hex value's measure reads.
  const hexPieces = [
    '?', '&', ' ', 'x', '=', 'key=', 'token=', 'sig=', 'id=', '9f3a', 'c07e5b1d', '0123', '4567', '89ab', 'cdef', 'deadbeef', 'D41A', '0000',
    ...fakeHex(8, 6, 12), ...fakeHex(9, 3, 8, '0359bd'), ...fakeHex(10, 3, 6).map((h) => h.toUpperCase()),
  ];
  let found = 0;
  const hexNamed = { found: 0, passed: 0 };
  const rulesSeen = new Set<string>();
  for (let i = 0; i < 8_000; i++) {
    const from = i < 4_000 ? pieces : hexPieces;
    const text = Array.from({ length: 4 + Math.floor(next() * 24) }, () => from[Math.floor(next() * from.length)]).join('');
    const want = referenceScanText(text);
    assert.deepEqual(scanText(text), want, text);
    found += want.length;
    for (const f of want) rulesSeen.add(f.rule);
    for (const m of text.matchAll(/(?:^|[?&#;\s"'`])\w*(?:key|token|sig)=([0-9a-f]{16,}|[0-9A-F]{16,})(?![A-Za-z0-9+/_=-])/g)) {
      const at = (m.index ?? 0) + m[0].length - m[1].length;
      if (want.some((f) => f.where === `@${at}`)) hexNamed.found++;
      else hexNamed.passed++;
    }
  }
  assert.ok(found > 1_000, `CONTROL: the generated texts hold findings (${found})`);
  assert.ok(hexNamed.found > 100 && hexNamed.passed > 5, `CONTROL: named hex values both found and passed (${JSON.stringify(hexNamed)})`);
  assert.deepEqual([...rulesSeen].sort(), ['entropy', 'jwt-privileged', 'secret-prefix'], 'CONTROL: the texts exercise every rule their pieces can make');
});
