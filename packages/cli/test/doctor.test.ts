/**
 * `az doctor` — word-quality-gate §5: every check against a faked machine or
 * a planted project, the deadlines, the real binary end to end, and no
 * secret value ever reaching the output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserPlatform, CHECKS, doctor, glbGeometry, type DoctorOptions } from '../src/doctor-checks.ts';
import { DISK_WARN_BYTES } from '../src/doctor-system.ts';
import { formatReport, runChecks, shellQuote, systemProbe, type Check, type DoctorContext, type Probe, type RunResult } from '../src/doctor.ts';
import { findNpmCli } from '../src/serve.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');

const HERO = 'page /\n  hero center\n    title "Hi"\n';
const GOOD = `az 1\nsite aurora\n${HERO}`;
const BACKEND = (data = '') => `az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n${data}${HERO}`;
const RULED = '  data notes\n    title text required\n    allow anyone read\n';
const BARE = '  data notes\n    title text required\n';

/** A machine that answers like this one, with the Node version, npm and children chosen per test. */
function fakeProbe(over: Partial<Probe> = {}): Probe {
  const real = systemProbe(findNpmCli);
  return { ...real, env: {}, ...over };
}

function project(source: string, files: Record<string, string | Buffer> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-doctor-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, source, 'utf8');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return { dir, file, out: join(dir, '.az-build') };
}

const options = (p: { dir: string; file: string | null; out: string }, probe: Probe = fakeProbe()): DoctorOptions =>
  ({ source: p.file, outDir: p.out, cwd: p.dir, wordsDir: WORDS, probe, projectModules: true });

/** One check's finding for this project and machine. */
async function check(id: string, p: { dir: string; file: string | null; out: string }, probe?: Probe) {
  const c = CHECKS.find((x) => x.id === id);
  assert.ok(c, `no check ${id}`);
  const r = await doctor({ ...options(p, probe), checks: [c] });
  return r.checks[0];
}

/** A glTF 2.0 binary: the JSON chunk, then `bin` bytes of buffer. */
function glb(json: object, bin = 0): Buffer {
  const text = Buffer.from(JSON.stringify(json));
  const j = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const b = Buffer.alloc(bin + ((4 - (bin % 4)) % 4));
  const chunk = (type: number, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  const body = Buffer.concat([chunk(0x4e4f534a, j), ...(bin ? [chunk(0x004e4942, b)] : [])]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}
const RAW_MODEL = { asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
const DRACO_MODEL = { ...RAW_MODEL, extensionsUsed: ['KHR_draco_mesh_compression'] };
const MODEL_SITE = (path: string) => `az 1\nsite s\npage /\n  hero center 3d\n    title "x"\n    model ${path}\n    poster ./assets/p.webp\n    describe "a shoe"\n`;

/* ---- the machine -------------------------------------------------------- */

test('node: an old Node fails with the install line and never an install', async () => {
  const p = { dir: tmpdir(), file: null, out: join(tmpdir(), 'none') };
  const old = await check('node', p, fakeProbe({ node: '18.12.0' }));
  assert.equal(old.status, 'fail');
  assert.equal(old.line, "Node 18.12.0 — az needs 22.18+ (the generated server's engines say >=22.18)");
  assert.match(old.fix![0], /^install Node 22\.18 or later: https:\/\/nodejs\.org\/en\/download$/);
  // CONTROL: the boundary passes.
  assert.equal((await check('node', p, fakeProbe({ node: '22.18.0' }))).status, 'pass');
  assert.equal((await check('node', p, fakeProbe({ node: '22.17.9' }))).status, 'fail');
});

test('npm: a missing binary fails with the fix; a child that hangs reports no answer', async () => {
  const p = { dir: tmpdir(), file: null, out: join(tmpdir(), 'none') };
  const gone = await check('npm', p, fakeProbe({ npmCli: () => null }));
  assert.equal(gone.status, 'fail');
  assert.match(gone.line, /^npm: not found beside Node/);
  assert.match(gone.fix![0], /npm ships with Node/);
  const hung = await check('npm', p, fakeProbe({ run: async (): Promise<RunResult> => ({ kind: 'timeout', ms: 15_000 }) }));
  assert.equal(hung.status, 'fail');
  assert.equal(hung.line, 'npm: no answer after 15s');
  // CONTROL: this machine's npm answers.
  assert.equal((await check('npm', p)).status, 'pass');
});

test('platform: an x64 Node translated on an arm64 machine fails; AZ_WORDS at nothing fails', async () => {
  const p = { dir: tmpdir(), file: null, out: join(tmpdir(), 'none') };
  const translated = fakeProbe({
    platform: 'darwin', arch: 'x64',
    run: async (file): Promise<RunResult> => (file === 'sysctl' ? { kind: 'exit', code: 0, stdout: '1\n', stderr: '' } : { kind: 'missing' }),
  });
  const r = await check('platform', p, translated);
  assert.equal(r.status, 'fail');
  assert.match(r.line, /x64 build, running translated/);
  const words = await check('platform', p, fakeProbe({ env: { AZ_WORDS: join(tmpdir(), 'no-such-words-folder') } }));
  assert.equal(words.status, 'fail');
  assert.equal(words.line, 'platform: AZ_WORDS is set, but not to a folder — every build fails');
  assert.ok(!JSON.stringify(words).includes('no-such-words-folder'), 'the variable\'s value is never printed');
  assert.equal((await check('platform', p)).status, 'pass');
});

test('image library: loads through the resizer\'s child; a child that cannot load it is a warning with the reinstall', async () => {
  const p = { dir: tmpdir(), file: null, out: join(tmpdir(), 'none') };
  const ok = await check('image-library', p);
  assert.equal(ok.status, 'pass', ok.line);
  assert.match(ok.line, /^image library 0\.35\.5 loads on /);
  const broken = await check('image-library', p, fakeProbe({
    run: async (): Promise<RunResult> => ({ kind: 'exit', code: 2, stdout: '', stderr: 'az-image: the image library is not installed for this platform (x)\n' }),
  }));
  assert.equal(broken.status, 'warn');
  assert.match(broken.line, /^image library: the image library is not installed for this platform \(x\) — builds ship images unresized$/);
  assert.match(broken.fix![0], /pnpm install --frozen-lockfile --ignore-scripts$/);
});

test('backend image library: a server with image fields and no node_modules warns; agent calls never load it', async () => {
  const p = project(GOOD, { '.az-build/server/az.config.json': JSON.stringify({ siteName: 's', database: 'sqlite', email: 'smtp', images: true }) });
  const r = await check('backend-image-library', p);
  assert.equal(r.status, 'warn');
  assert.match(r.fix![0], /npm install$/);
  const agent = await doctor({ ...options(p), projectModules: false, checks: CHECKS.filter((c) => c.id === 'backend-image-library') });
  assert.equal(agent.checks[0].status, 'skip');
  // node_modules without the library: the real child, pointed at the server, can't load it.
  mkdirSync(join(p.out, 'server/node_modules'));
  const broken = await check('backend-image-library', p);
  assert.equal(broken.status, 'fail', broken.line);
  assert.match(broken.line, /^backend image library: the image library is not installed for this platform \(Cannot find module 'sharp'/);
});

test('test browsers: skipped unless the project uses the browser-test package; missing browser is a warning with the command', async () => {
  assert.equal((await check('browsers', project(GOOD))).status, 'skip');
  const p = project(GOOD, {
    'package.json': JSON.stringify({ devDependencies: { playwright: '1.0.0' } }),
    'node_modules/playwright-core/browsers.json': JSON.stringify({ browsers: [{ name: 'chromium', revision: '999999' }] }),
  });
  const cache = mkdtempSync(join(tmpdir(), 'az-browsers-'));
  const r = await check('browsers', p, fakeProbe({ env: { PLAYWRIGHT_BROWSERS_PATH: cache } }));
  assert.equal(r.status, 'warn');
  assert.match(r.fix![0], /npx playwright install chromium$/);
  mkdirSync(join(cache, 'chromium-999999'));
  assert.equal((await check('browsers', p, fakeProbe({ env: { PLAYWRIGHT_BROWSERS_PATH: cache } }))).status, 'pass');
});

/** The platform name as the browser-test package this repository pins computes it, on this machine. */
function pinnedHostPlatform(): string {
  const pkg = createRequire(join(ROOT, 'package.json')).resolve(`${BROWSER_TEST}/package.json`);
  const core = createRequire(pkg)(`${BROWSER_TEST}-core/lib/coreBundle`) as { utils: { hostPlatform: string } };
  return core.utils.hostPlatform;
}
const BROWSER_TEST = 'playwright';

/** A project using the browser-test package, its browsers.json listing chromium as given, and an empty browser cache. */
function browserProject(chromium: object) {
  const p = project(GOOD, {
    'package.json': JSON.stringify({ devDependencies: { [BROWSER_TEST]: '1.0.0' } }),
    [`node_modules/${BROWSER_TEST}-core/browsers.json`]: JSON.stringify({ browsers: [{ name: 'chromium', ...chromium }, { name: 'firefox', revision: '1' }] }),
  });
  return { p, cache: mkdtempSync(join(tmpdir(), 'az-browsers-')) };
}

test('test browsers: a revision override for this platform is read as the package reads it — its revision, its own folder', async () => {
  const host = pinnedHostPlatform();
  const { p, cache } = browserProject({ revision: '999999', revisionOverrides: { [host]: '777777', 'no-such-platform': '555555' } });
  const probe = fakeProbe({ env: { PLAYWRIGHT_BROWSERS_PATH: cache } });
  // The default revision is installed, but this platform runs the override's.
  mkdirSync(join(cache, 'chromium-999999'));
  const missing = await check('browsers', p, probe);
  assert.equal(missing.status, 'warn', missing.line);
  assert.equal(missing.line, "test browsers: chromium 777777 is not installed — the project's browser tests can't start");
  mkdirSync(join(cache, `chromium_${host.replace(/-/g, '_')}_special-777777`));
  const ok = await check('browsers', p, probe);
  assert.deepEqual([ok.status, ok.line], ['pass', 'test browsers: chromium 777777 is installed']);
  // An override for another platform only: the default revision, in the default folder.
  const other = browserProject({ revision: '999999', revisionOverrides: { 'no-such-platform': '555555' } });
  mkdirSync(join(other.cache, 'chromium-999999'));
  assert.equal((await check('browsers', other.p, fakeProbe({ env: { PLAYWRIGHT_BROWSERS_PATH: other.cache } }))).line, 'test browsers: chromium 999999 is installed');
});

test('test browsers: the package\'s own platform override names the platform, as it does for the package', async () => {
  const { p, cache } = browserProject({ revision: '999999', revisionOverrides: { 'ubuntu22.04-x64': '424242' } });
  mkdirSync(join(cache, 'chromium_ubuntu22.04_x64_special-424242'));
  const r = await check('browsers', p, fakeProbe({ env: { PLAYWRIGHT_BROWSERS_PATH: cache, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'ubuntu22.04-x64' } }));
  assert.deepEqual([r.status, r.line], ['pass', 'test browsers: chromium 424242 is installed']);
});

test('browserPlatform: the package\'s names — macOS by darwin release and CPU, Linux by distribution, Windows', () => {
  const mac = (osRelease: string, cpu: string) => browserPlatform({ platform: 'darwin', arch: 'arm64', osRelease, cpuModels: [cpu] });
  assert.equal(mac('25.6.0', 'Apple M1'), 'mac26-arm64');
  assert.equal(mac('23.1.0', 'Apple M2'), 'mac14-arm64');
  assert.equal(mac('23.1.0', 'Intel(R) Core(TM) i7'), 'mac14');
  assert.equal(mac('19.6.0', 'Intel(R) Core(TM) i7'), 'mac10.15');
  assert.equal(mac('30.0.0', 'Apple M5'), 'mac26-arm64', 'a later macOS is named as the newest the package knows');
  const linux = (id: string, version: string, arch = 'x64') => browserPlatform({ platform: 'linux', arch, osRelease: '6.1', cpuModels: [], distro: { id, version } });
  assert.equal(linux('ubuntu', '22.04'), 'ubuntu22.04-x64');
  assert.equal(linux('ubuntu', '25.10', 'arm64'), 'ubuntu24.04-arm64');
  assert.equal(linux('pop', '20.04'), 'ubuntu20.04-x64');
  assert.equal(linux('linuxmint', '21.3'), 'ubuntu22.04-x64');
  assert.equal(linux('debian', '12'), 'debian12-x64');
  assert.equal(linux('debian', ''), 'debian13-x64');
  assert.equal(linux('fedora', '40'), 'ubuntu24.04-x64');
  assert.equal(linux('ubuntu', '22.04', 'ia32'), '<unknown>');
  assert.equal(browserPlatform({ platform: 'linux', arch: 'x64', osRelease: '6.1', cpuModels: [] }), 'ubuntu24.04-x64', 'no os-release file');
  assert.equal(browserPlatform({ platform: 'win32', arch: 'x64', osRelease: '10.0', cpuModels: [] }), 'win64');
  assert.equal(browserPlatform({ platform: 'freebsd', arch: 'x64', osRelease: '14', cpuModels: [] }), '<unknown>');
  // CONTROL: on this machine, the same name the pinned package computes (on Linux the
  // distribution comes from /etc/os-release — the check-level test above covers it).
  if (process.platform !== 'linux') {
    assert.equal(browserPlatform({ platform: process.platform, arch: process.arch, osRelease: release(), cpuModels: cpus().map((c) => c.model) }), pinnedHostPlatform());
  }
});

/* ---- the project -------------------------------------------------------- */

test('compile: errors fail with the first one and the az check command', async () => {
  const r = await check('compile', project('az 1\nsite a\npage /\n  nonsense\n'));
  assert.equal(r.status, 'fail');
  assert.equal(r.line, 'site.az: 1 error, 0 warnings — the build stops');
  assert.match(r.fix![0], /^site\.az:4:3 AZ1201 nonsense: unknown word/);
  assert.equal(r.fix![1], 'run: az check site.az for every one');
  assert.equal((await check('compile', project(GOOD))).status, 'pass');
});

test('data lock: a file whose tables changed without a step fails with AZ1701 and the plan command', async () => {
  const r = await check('data-lock', project(BACKEND(RULED)));
  assert.equal(r.status, 'fail');
  assert.match(r.line, /^data lock: site\.data\.json is not current — AZ1701 /);
  assert.match(r.fix![0], /az backend plan site\.az/);
  // CONTROL: recorded, it passes.
  const p = project(BACKEND(RULED));
  const s = spawnSync(process.execPath, [BIN, 'backend', 'schema', p.file], { encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS } });
  assert.equal(s.status, 0, s.stderr);
  assert.equal((await check('data-lock', p)).status, 'pass');
  // A site without tables has no lock to check.
  assert.equal((await check('data-lock', project(GOOD))).status, 'skip');
});

test('table rules: a table with no allow lines is named; a hosted adapter is told to check its row rules', async () => {
  const bare = await check('table-rules', project(BACKEND(BARE)));
  assert.equal(bare.status, 'warn');
  assert.equal(bare.line, 'table rules: 1 table with no allow lines (notes) — only admins can reach it');
  assert.equal((await check('table-rules', project(BACKEND(RULED)))).status, 'pass');
  const hosted = await check('table-rules', project(`az 1\nsite s\n  auth\n    adapter hosted\npage /\n  auth login\n`));
  assert.equal(hosted.status, 'warn', hosted.line);
  assert.match(hosted.fix![0], /row-level security for every table/);
});

test('models: raw geometry warns with the exact optimiser command; Draco geometry passes', async () => {
  const p = project(MODEL_SITE('./assets/shoe.glb'), { 'assets/shoe.glb': glb(RAW_MODEL, 64), 'assets/p.webp': 'x' });
  const r = await check('models', p);
  assert.equal(r.status, 'warn');
  assert.equal(r.line, "models: 'shoe.glb' not Draco-compressed — raw geometry stalls a phone");
  assert.equal(r.fix![0], 'npx @gltf-transform/cli@4.4.2 draco ./assets/shoe.glb ./assets/shoe-draco.glb --method edgebreaker');
  // Run from elsewhere, the command first goes to the project.
  const away = await doctor({ ...options(p), cwd: tmpdir(), checks: CHECKS.filter((c) => c.id === 'models') });
  assert.match(away.checks[0].fix![0], /^cd \S+ && npx /);
  const d = project(MODEL_SITE('./assets/shoe.glb'), { 'assets/shoe.glb': glb(DRACO_MODEL, 64), 'assets/p.webp': 'x' });
  assert.equal((await check('models', d)).status, 'pass');
  assert.deepEqual(await glbGeometry(join(d.dir, 'assets/shoe.glb')), { meshes: 1, compressed: true });
  assert.deepEqual(await glbGeometry(join(d.dir, 'assets/p.webp')), { problem: 'is not a glTF 2.0 binary' });
});

test('models: a file name that is shell syntax is quoted in the command, never run', async () => {
  const name = "assets/$(touch pwned)'x.glb";
  const p = project(MODEL_SITE(`"./${name}"`), { [name]: glb(RAW_MODEL), 'assets/p.webp': 'x' });
  assert.equal((await check('compile', p)).status, 'pass', 'the grammar takes the quoted path');
  const r = await check('models', p);
  assert.equal(r.status, 'warn', r.line);
  assert.ok(r.fix![0].includes(`'./assets/$(touch pwned)'\\''x.glb'`), r.fix![0]);
  assert.ok(!existsSync(join(p.dir, 'pwned')), 'nothing ran');
  assert.equal(shellQuote("a'b c"), "'a'\\''b c'");
  assert.equal(shellQuote('plain/path.glb'), 'plain/path.glb');
});

test('assets: a file named twice keeps its tightest budget', async () => {
  const p = project(
    `az 1\nsite s\npage /\n  gallery\n    image ./assets/a.webp\n      alt "A"\n    image ./assets/b.webp\n      alt "B"\n  cta\n    title "Go"\n    media ./assets/a.webp\n`,
    { 'assets/a.webp': Buffer.alloc(600 * 1024), 'assets/b.webp': 'x' },
  );
  const r = await check('assets', p);
  assert.equal(r.status, 'warn', r.line);
  assert.equal(r.fix!.length, 1);
});

test('SECURITY: a named pipe where a file is read is refused, never opened — the run still ends', async () => {
  const p = project(BACKEND(), SERVER);
  const fifo = spawnSync('mkfifo', [join(p.out, '.env'), join(p.out, 'server/.env')]);
  assert.equal(fifo.status, 0, String(fifo.stderr));
  const started = Date.now();
  const r = await doctor({ ...options(p), checks: CHECKS.filter((c) => c.id === 'backend-env' || c.id === 'build-secrets'), deadlineMs: 5_000 });
  assert.ok(Date.now() - started < 4_000, 'answered without waiting on the pipe');
  assert.deepEqual(r.checks.map((c) => c.status), ['fail', 'pass']);
  assert.match(r.checks[0].line, /is not a regular file$/);
});

test('assets: a big GLB and an over-budget gallery image warn with their manifest budgets; a missing file fails', async () => {
  const big = Buffer.alloc(600 * 1024);
  const p = project(
    `az 1\nsite s\npage /\n  hero center 3d\n    title "x"\n    model ./assets/m.glb\n    poster ./assets/p.webp\n    describe "a shoe"\n  gallery\n    image ./assets/a.webp\n      alt "A"\n    image ./assets/b.webp\n      alt "B"\n`,
    { 'assets/m.glb': glb(DRACO_MODEL, 6 * 1024 * 1024), 'assets/a.webp': big, 'assets/b.webp': 'small', 'assets/p.webp': 'x' },
  );
  const r = await check('assets', p);
  assert.equal(r.status, 'warn');
  assert.equal(r.line, 'assets: 2 files over budget — the page loads slowly on a phone');
  assert.deepEqual(r.fix, [
    "'./assets/m.glb' is 6.0MB (hero model, budget 5.0MB) — Draco-compress it (see the models line)",
    "'./assets/a.webp' is 600KB (gallery image src, budget 500KB) — export it under 500KB",
  ]);
  const gone = await check('assets', project(MODEL_SITE('./assets/none.glb'), { 'assets/p.webp': 'x' }));
  assert.equal(gone.status, 'fail');
  assert.match(gone.line, /^assets: '\.\/assets\/none\.glb' does not exist — the build stops$/);
});

/* ---- the backend .env and the build's environment ----------------------- */

const SERVER = { '.az-build/server/az.config.json': JSON.stringify({ siteName: 'shop', database: 'sqlite', email: 'smtp' }) };
const FULL_ENV = 'AZ_SESSION_SECRET=planted-session-secret-value-0123456789abcdef\nAZ_BACKEND_PUBLIC_URL=http://localhost:8787\n'
  + 'AZ_ALLOWED_ORIGINS=http://localhost:5173\nAZ_EMAIL_FROM=a@b.c\nAZ_SMTP_HOST=smtp.invalid\nAZ_SMTP_PORT=587\n';

test('backend .env: missing warns with az backend init; group-readable fails with chmod; empty required keys are named', async () => {
  const p = project(BACKEND(), SERVER);
  const missing = await check('backend-env', p);
  assert.equal(missing.status, 'warn');
  assert.equal(missing.fix![0], 'run: az backend init .az-build/server');

  const env = join(p.out, 'server/.env');
  writeFileSync(env, FULL_ENV);
  chmodSync(env, 0o644);
  const open = await check('backend-env', p);
  assert.equal(open.status, 'fail');
  assert.equal(open.line, "backend .env: .az-build/server/.env is readable by others (mode 644) — it holds the server's secrets");
  assert.equal(open.fix![0], 'run: chmod 600 .az-build/server/.env');

  chmodSync(env, 0o600);
  assert.equal((await check('backend-env', p)).status, 'pass');
  writeFileSync(env, FULL_ENV.replace(/^AZ_SMTP_HOST=.*$/m, 'AZ_SMTP_HOST=') + 'AZ_OAUTH_PROVIDERS=work\n');
  const empty = await check('backend-env', p);
  assert.equal(empty.status, 'fail');
  assert.equal(empty.line, 'backend .env: the server would refuse 2 keys — AZ_SMTP_HOST, AZ_OAUTH_WORK_TYPE');
  // Set but refused by the server's own validation: named, and the values the server's messages quote are not.
  writeFileSync(env, FULL_ENV.replace(/^AZ_SESSION_SECRET=.*$/m, 'AZ_SESSION_SECRET=short') + 'AZ_OAUTH_PROVIDERS=Corp-Login,Corp-Login\nAZ_PORT=eighty\n');
  const refused = await check('backend-env', p);
  assert.equal(refused.line, 'backend .env: the server would refuse 3 keys — AZ_SESSION_SECRET, AZ_PORT, AZ_OAUTH_PROVIDERS');
  for (const value of ['short', 'Corp-Login', 'eighty']) assert.ok(!JSON.stringify(refused).includes(value), value);

  // A site with a backend that was never built is told to build.
  const unbuilt = await check('backend-env', project(BACKEND()));
  assert.equal(unbuilt.status, 'warn');
  assert.equal(unbuilt.fix![0], 'run: az build site.az');
  assert.equal((await check('backend-env', project(GOOD))).status, 'skip');
});

/** Shaped like a service key the build refuses (core secrets.ts) — planted, never real. */
const PLANTED = `sk_live_${'Q7v'.repeat(12)}`;

test('SECURITY: no secret value reaches the report, text or JSON — names only', async () => {
  const p = project(BACKEND(), {
    ...SERVER,
    '.az-build/.env.local': `AZ_PUBLIC_PAYMENT_KEY=${PLANTED}\n`,
  });
  writeFileSync(join(p.out, 'server/.env'), FULL_ENV.replace(/^AZ_SMTP_HOST=.*$/m, 'AZ_SMTP_HOST='), { mode: 0o644 });
  const r = await doctor(options(p, fakeProbe({ env: { AZ_PUBLIC_SERVICE_ROLE: PLANTED } })));
  const secrets = r.checks.find((c) => c.id === 'build-secrets')!;
  assert.equal(secrets.status, 'fail');
  assert.match(secrets.line, /AZ_PUBLIC_PAYMENT_KEY, AZ_PUBLIC_SERVICE_ROLE look like a service key/);
  for (const text of [formatReport(r), JSON.stringify(r)]) {
    assert.ok(!text.includes(PLANTED), 'the planted key must not appear');
    assert.ok(!text.includes('planted-session-secret'), 'the .env secret must not appear');
    assert.ok(!text.includes('Q7vQ7v'), 'no part of the key either');
  }
});

/* ---- deadlines ----------------------------------------------------------- */

test('DEADLINE: a hung check reports no answer and the run goes on', async () => {
  const hung: Check = { id: 'hung', title: 'hung step', run: () => new Promise(() => {}) };
  const fine: Check = { id: 'fine', title: 'fine', run: async () => ({ status: 'pass', line: 'fine' }) };
  const thrown: Check = { id: 'thrown', title: 'thrown', run: async () => { throw new Error('boom\nmore'); } };
  const ctx = { compiled: () => ({ error: 'unused' }) } as unknown as DoctorContext;
  const started = Date.now();
  const r = await runChecks([hung, fine, thrown], ctx, 150);
  assert.ok(Date.now() - started < 2_000, 'bounded by the deadline');
  assert.deepEqual(r.map((c) => [c.id, c.status, c.line]), [
    ['hung', 'fail', 'hung step: no answer after 0.2s'],
    ['fine', 'pass', 'fine'],
    ['thrown', 'fail', 'thrown: the check stopped (boom)'],
  ]);
});

/** A compile worker that never answers: a synchronous loop, which no timer on its own thread could end. */
function stuckCompiler(): URL {
  const file = join(mkdtempSync(join(tmpdir(), 'az-doctor-compiler-')), 'stuck.mjs');
  writeFileSync(file, 'for (;;) { /* never yields */ }\n');
  return pathToFileURL(file);
}

test('DEADLINE: a compile that never returns is ended at its timeout — the compile line says so, every other check finishes', async () => {
  const p = project(BACKEND(RULED));
  const ids = new Set(['node', 'platform', 'compile', 'data-lock', 'table-rules', 'models', 'assets', 'backend-env', 'build-secrets']);
  const started = Date.now();
  const r = await doctor({ ...options(p), checks: CHECKS.filter((c) => ids.has(c.id)), compiler: stuckCompiler(), compileMs: 400, deadlineMs: 5_000 });
  const took = Date.now() - started;
  assert.ok(took < 4_000, `ended at the compile's timeout, not the deadline (${took}ms)`);
  const by = new Map(r.checks.map((c) => [c.id, c]));
  assert.equal(by.get('compile')!.status, 'fail');
  assert.equal(by.get('compile')!.line, "site.az: can't be compiled (no answer after 0.4s)");
  // The checks that read the compile say it gave nothing; the rest answer for themselves.
  for (const id of ['data-lock', 'table-rules', 'models', 'assets', 'backend-env']) assert.equal(by.get(id)!.status, 'skip', `${id}: ${by.get(id)!.line}`);
  assert.equal(by.get('node')!.status, 'pass');
  assert.equal(by.get('platform')!.status, 'pass');
  assert.equal(by.get('build-secrets')!.status, 'pass');
  assert.ok(r.checks.every((c) => !/no answer after 5s/.test(c.line)), 'no check waited for the deadline');
});

test('DEADLINE: a check deadline shorter than the compile\'s ends the run, and the stuck compile with it', async () => {
  const p = project(GOOD);
  const started = Date.now();
  const r = await doctor({ ...options(p), checks: CHECKS.filter((c) => c.id === 'compile'), compiler: stuckCompiler(), compileMs: 60_000, deadlineMs: 300 });
  assert.ok(Date.now() - started < 3_000);
  assert.equal(r.checks[0].line, 'compile: no answer after 0.3s');
  // The worker is terminated once the report is in: if it were not, this test file would never exit.
});

test('compile: the real worker compiles the file — the result crosses the thread whole', async () => {
  const p = project(BACKEND(RULED));
  const r = await doctor({ ...options(p), checks: CHECKS.filter((c) => c.id === 'compile' || c.id === 'table-rules') });
  assert.deepEqual(r.checks.map((c) => c.status), ['pass', 'pass']);
  assert.equal(r.checks[1].line, 'table rules: every table has allow lines (1 table)');
});

test('DEADLINE: a child that never exits is killed at its timeout', async () => {
  const probe = systemProbe(findNpmCli);
  const started = Date.now();
  const r = await probe.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
  assert.deepEqual(r, { kind: 'timeout', ms: 300 });
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(await probe.run(join(tmpdir(), 'no-such-binary-az'), [], { timeoutMs: 1000 }), { kind: 'missing' });
});

/* ---- the binary, end to end --------------------------------------------- */

const az = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [...process.execArgv, BIN, 'doctor', ...args], { cwd, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, timeout: 60_000 });

test('E2E: az doctor on a planted project prints every check, exits 1, and --json says the same', () => {
  const p = project(BACKEND(BARE), {
    ...SERVER,
    '.az-build/server/.env': FULL_ENV,
  });
  chmodSync(join(p.out, 'server/.env'), 0o640);
  const text = az(p.dir);
  assert.equal(text.status, 1, text.stderr);
  const lines = text.stdout.split('\n');
  assert.equal(lines[0], 'az doctor');
  assert.ok(lines.includes('  ✗ backend .env: .az-build/server/.env is readable by others (mode 640) — it holds the server\'s secrets'), text.stdout);
  assert.ok(lines.some((l) => l.startsWith('  ✗ data lock: site.data.json is not current — AZ1701')), text.stdout);
  assert.ok(lines.includes('  ! table rules: 1 table with no allow lines (notes) — only admins can reach it'), text.stdout);
  assert.match(lines.at(-2)!, /^az doctor: 2 failures, \d+ warnings?, \d+ passed, \d+ skipped$/);
  assert.ok(!text.stdout.includes('planted-session-secret'));

  const json = az(p.dir, 'site.az', '--json');
  assert.equal(json.status, 1, json.stderr);
  const r = JSON.parse(json.stdout) as { ok: boolean; exit: number; checks: { id: string; status: string }[] };
  assert.equal(r.ok, false);
  assert.equal(r.exit, 1);
  assert.deepEqual(r.checks.map((c) => c.id), CHECKS.map((c) => c.id));
});

test('E2E: a clean project exits 0; a usage error exits 2', () => {
  const p = project(GOOD);
  const r = az(p.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ site\.az compiles — no errors, no warnings/);
  assert.equal(az(p.dir, '--bogus').status, 2);
  assert.equal(az(p.dir, 'missing.az').status, 2);
});

/* ---- the proxy (word-quality-gate §5.3) ---------------------------------- */

const SECRET_PROXY = 'http://ana:s3cr3t-pass@proxy.corp.test:8080/route?token=t0ken-value';
const WITH_FLAG = new Set(['--use-env-proxy']);

test('proxy: none set passes — the registry and the server\'s calls go direct', async () => {
  const r = await check('proxy', project(GOOD), fakeProbe({ env: {} }));
  assert.deepEqual([r.status, r.line], ['pass', "proxy: none set — the package registry and the server's outbound calls go direct"]);
});

test('SECURITY proxy: the proxy is shown as scheme, host and port — its user, password, path and query never', async () => {
  for (const env of [{ HTTPS_PROXY: SECRET_PROXY }, { https_proxy: SECRET_PROXY, http_proxy: SECRET_PROXY }]) {
    const p = project(BACKEND());
    const r = await doctor({ ...options(p, fakeProbe({ env, nodeFlags: WITH_FLAG })), checks: [CHECKS.find((c) => c.id === 'proxy')!] });
    const text = formatReport(r) + JSON.stringify(r);
    assert.match(text, /http:\/\/\*\*\*@proxy\.corp\.test:8080/);
    for (const secret of ['ana', 's3cr3t', 'route', 't0ken']) assert.ok(!text.includes(secret), `${secret} printed: ${text}`);
  }
});

test('proxy: with a backend and no NODE_USE_ENV_PROXY, the server\'s calls go direct — a warning naming the fix', async () => {
  const r = await check('proxy', project(BACKEND()), fakeProbe({ env: { HTTPS_PROXY: 'http://proxy.corp.test:3128' }, nodeFlags: WITH_FLAG }));
  assert.equal(r.status, 'warn');
  assert.equal(r.line, "proxy: the server's outbound calls (sign-in providers, the email API, the chat model) go direct: Node's fetch ignores HTTPS_PROXY/HTTP_PROXY"
    + ' — if they must pass the proxy, start the server with NODE_USE_ENV_PROXY=1; SMTP never uses an HTTP proxy');
  assert.ok(r.fix!.includes('HTTPS_PROXY: http://proxy.corp.test:3128'), JSON.stringify(r.fix));
  assert.ok(r.fix!.includes('npm reaches the package registry through the proxy'), JSON.stringify(r.fix));
  // On a Node without the support, the fix says so.
  const old = await check('proxy', project(BACKEND()), fakeProbe({ node: '22.18.0', env: { HTTPS_PROXY: 'http://proxy.corp.test:3128' }, nodeFlags: new Set() }));
  assert.match(old.line, /on a Node that supports it \(this 22\.18\.0 does not\)/);
});

test('proxy: with NODE_USE_ENV_PROXY=1 on a Node that has it, the server\'s calls use it except NO_PROXY\'s hosts; without the support it warns', async () => {
  const env = { HTTPS_PROXY: 'http://proxy.corp.test:3128', NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,.corp.test' };
  const on = await check('proxy', project(BACKEND()), fakeProbe({ env, nodeFlags: WITH_FLAG }));
  assert.equal(on.status, 'pass');
  assert.ok(on.fix!.some((f) => f.includes("go through the proxy, except NO_PROXY's hosts; SMTP never does")), JSON.stringify(on));
  const unsupported = await check('proxy', project(BACKEND()), fakeProbe({ node: '22.18.0', env, nodeFlags: new Set() }));
  assert.equal(unsupported.status, 'warn');
  assert.match(unsupported.line, /NODE_USE_ENV_PROXY=1 is set, but this Node \(22\.18\.0\) has no environment proxy support/);
});

test('proxy: a registry in NO_PROXY is reached direct; one not in it goes through the proxy', async () => {
  const base = { HTTPS_PROXY: 'http://proxy.corp.test:3128', npm_config_registry: 'https://registry.corp.test/npm/' };
  const direct = await check('proxy', project(GOOD), fakeProbe({ env: { ...base, NO_PROXY: '*.corp.test' } }));
  assert.ok([direct.line, ...(direct.fix ?? [])].includes('the package registry (registry.corp.test) is in NO_PROXY: npm reaches it direct'), JSON.stringify(direct));
  const through = await check('proxy', project(GOOD), fakeProbe({ env: { ...base, NO_PROXY: 'localhost' } }));
  assert.ok([through.line, ...(through.fix ?? [])].includes('npm reaches the package registry through the proxy (NO_PROXY does not name registry.corp.test)'), JSON.stringify(through));
  // Without a backend the direct server calls are a note, not a warning.
  assert.equal(through.status, 'pass');
  assert.ok(through.fix!.some((f) => f.endsWith('this project has no backend to make them')), JSON.stringify(through));
});

test('proxy: a value that is not a URL, or two spellings that differ, warn — still without printing the value', async () => {
  const bad = await check('proxy', project(GOOD), fakeProbe({ env: { HTTP_PROXY: 'corp-proxy-pass-word' } }));
  assert.equal(bad.status, 'warn');
  assert.equal(bad.line, "proxy: HTTP_PROXY is set but is not a URL — npm and Node can't use it; write it as http://host:port");
  assert.ok(!JSON.stringify(bad).includes('pass-word'));
  const two = await check('proxy', project(GOOD), fakeProbe({ env: { HTTPS_PROXY: 'http://a.test:1', https_proxy: 'http://b.test:2' } }));
  assert.equal(two.status, 'warn');
  assert.match(two.line, /HTTPS_PROXY and https_proxy are both set, to different values/);
});

/* ---- disk space ---------------------------------------------------------- */

/** A probe whose filesystem has `free` bytes; records every path it was asked about. */
function diskProbe(free: number | Error) {
  const asked: string[] = [];
  const probe = fakeProbe({
    statfs: async (path: string) => {
      asked.push(path);
      if (free instanceof Error) throw free;
      return { bavail: Math.floor(free / 4096), bsize: 4096 };
    },
  });
  return { probe, asked };
}

test('disk: under DISK_WARN_BYTES free where the build writes is a warning with the space left; plenty passes', async () => {
  const p = project(GOOD);
  const low = diskProbe(500 * 1024 * 1024);
  const r = await check('disk', p, low.probe);
  assert.equal(r.status, 'warn');
  assert.equal(r.line, `disk space: 500MB free for ${p.dir} — under 1.0GB, a build and its install may run out`);
  assert.ok(r.fix!.at(-1)!.includes('--out'), JSON.stringify(r.fix));
  assert.equal(DISK_WARN_BYTES, 1024 * 1024 * 1024);
  const plenty = await check('disk', p, diskProbe(20 * 1024 * 1024 * 1024).probe);
  assert.equal(plenty.status, 'pass');
  assert.equal(plenty.line, `disk space: 20.0GB free for ${p.dir}`);
  // The boundary: exactly the threshold is enough.
  assert.equal((await check('disk', p, diskProbe(DISK_WARN_BYTES).probe)).status, 'pass');
});

test('disk: an output folder not made yet is measured at its nearest folder that is, and one filesystem is measured once', async () => {
  const p = project(GOOD);
  const d = diskProbe(5 * 1024 * 1024 * 1024);
  const r = await doctor({ ...options({ ...p, out: join(p.dir, 'not', 'made', 'yet') }, d.probe), checks: [CHECKS.find((c) => c.id === 'disk')!] });
  assert.equal(r.checks[0].status, 'pass');
  assert.deepEqual(d.asked, [p.dir], 'the project and its unmade output share one filesystem: asked once, at a folder that exists');
});

test('disk: a filesystem that cannot be measured is skipped, not failed', async () => {
  const r = await check('disk', project(GOOD), diskProbe(Object.assign(new Error('nope'), { code: 'ENOSYS' })).probe);
  assert.equal(r.status, 'skip');
  assert.match(r.line, /^disk space: can't be read for .* \(ENOSYS\)$/);
});

/* ---- asset names on a case-insensitive disk ------------------------------ */

const GALLERY = (a: string, b: string) => `az 1\nsite s\npage /\n  gallery\n    image ${a}\n      alt "A"\n    image ${b}\n      alt "B"\n`;

test('asset names: two that differ only in case warn on every OS — one file on a case-insensitive disk', async () => {
  const r = await check('asset-case', project(GALLERY('./img/Hero.webp', './img/hero.webp')));
  assert.equal(r.status, 'warn');
  assert.equal(r.line, "asset names: './img/Hero.webp' and './img/hero.webp' differ only in case — on a case-insensitive disk (Windows, macOS) they are one file");
  assert.deepEqual(r.fix, ['rename one of each pair, and the path to it in the .az file']);
  // A folder differing in case is the same clash.
  assert.equal((await check('asset-case', project(GALLERY('./Img/a.webp', './img/a.webp')))).status, 'warn');
});

test('asset names: CONTROL — distinct names, or one name used twice, pass; no file skips', async () => {
  assert.deepEqual(await check('asset-case', project(GALLERY('./img/a.webp', './img/b.webp'))),
    { id: 'asset-case', status: 'pass', line: 'asset names: 2 files, no two differing only in case' });
  assert.equal((await check('asset-case', project(GALLERY('./img/a.webp', './img/a.webp')))).status, 'pass');
  assert.equal((await check('asset-case', { dir: tmpdir(), file: null, out: join(tmpdir(), 'none') })).status, 'skip');
});
