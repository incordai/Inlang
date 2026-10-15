/**
 * Secret detection — auth-block-spec §4, §11. Test values are built at
 * runtime from obviously fake parts; none is a real key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../src/index.ts';
import { isSecretLiteral, redact, scanEnv, scanText } from '../src/secrets.ts';
import { legacyScanText } from './legacy-secrets.ts';

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

test('EQUIVALENCE: every finding exactly the old scan\'s — real tokens, near-misses, and 2 000 generated texts', () => {
  const service = jwt('service_role');
  const anon = jwt('anon');
  const fixed = [
    `t="${service}"`, `a ${anon} b ${service}.x`, `x${service}`, `eyJ${service}`, `${service}.${anon}`,
    `eyJabcdefgh.abcdefgh.abcdefg`, `eyJabcdefg.abcdefgh.abcdefgh`, `eyJabcdefgh.abcdefgh.abcdefgh`, `eyJeyJabcdefgh.abcdefgh.abcdefgh`,
    `abcdeyJ12345678.12345678.12345678.12345678`, `eyJ1234567eyJ12345678.12345678.12345678`, `${RANDOMISH} ${anon} ${RANDOMISH}`,
  ];
  for (const text of fixed) assert.deepEqual(scanText(text), legacyScanText(text), text);
  // Seeded, so a failure reproduces: texts made of the pieces the rule reads.
  let seed = 7;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
  const pieces = ['eyJ', 'eyJh', 'abcdefgh', 'Q9', '.', '.', '-', '_', ' ', '"', 'x', RANDOMISH, service, anon, '12345678'];
  let found = 0;
  for (let i = 0; i < 2_000; i++) {
    const text = Array.from({ length: 4 + Math.floor(next() * 24) }, () => pieces[Math.floor(next() * pieces.length)]).join('');
    const want = legacyScanText(text);
    assert.deepEqual(scanText(text), want, text);
    found += want.length;
  }
  assert.ok(found > 500, `CONTROL: the generated texts hold findings (${found})`);
});
