/**
 * `az add chat`, end to end (chat-block-spec §19.15): a fresh site with no
 * backend; `az add chat` writes the backend lines and a chat into it, backed
 * up; `az check` passes; a second run changes nothing; then the real `az dev`
 * serves it — a server without accounts (no mailbox, every /auth path 404) —
 * and in Chromium a suggested question is answered with the dev demo script,
 * with no page error and no sign-in page anywhere. Ctrl-C leaves no child
 * process and no open port.
 *
 * First run installs the generated project's dependencies (network).
 *
 * Run: pnpm test:dev
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closeWithin, watchdog, human } from './lib/bounded.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'packages/cli/bin/az.js');
const WORDS = join(ROOT, 'packages/words');
/** First run includes an npm install. */
const READY_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 60_000;
/* Deadlines (lib/bounded.mjs): a normal run takes well under a minute after the first install. */
const RUN_MS = 10 * 60_000;
const CLOSE_MS = 15_000;
const progress = { last: 'starting' };
const run = watchdog(RUN_MS, 'add-chat-e2e', progress);
console.log(`deadlines: run ${human(RUN_MS)} · step ${human(STEP_TIMEOUT_MS)} · close ${human(CLOSE_MS)}`);
let closed = true;

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  progress.last = name;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

/** A site as someone starts one: a page and a hero, no backend, no chat. */
const FRESH = `az 1

site lantern
  theme midnight

page /
  hero center
    title "Lantern"
    sub   "Lamps made by hand."
`;
/** CHAT_DEMO's first sentence (packages/cli/src/dev-backend.ts). */
const DEMO = 'This is the local demo answer from az dev.';

const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});
const portOpen = (port) => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
const childrenOf = (pid) => {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS });
  return r.stdout.split('\n').filter(Boolean).map(Number);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const dir = mkdtempSync(join(tmpdir(), 'az-add-chat-e2e-'));
const source = join(dir, 'site.az');
writeFileSync(source, FRESH, 'utf8');
const az = (...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL',
});

/* ---- az add chat on the fresh site ---- */
const added = az('add', 'chat', 'site.az', '--show', 'all');
check('az add chat exits 0 on a fresh site', added.status === 0, `${added.status} ${added.stderr.slice(-400)}`);
check('it says what it added, and ends with az check passing',
  /backend: added under site/.test(added.stdout) && /chat: added a chat panel on \/, open to anyone/.test(added.stdout) && /az: no problems found/.test(added.stdout),
  added.stdout.slice(-600));
const edited = readFileSync(source, 'utf8');
check('the file holds the backend lines and the chat, with no auth or email', /\n  backend\n    database sqlite\n    model    default\n/.test(edited)
  && /\n  chat panel\n[\s\S]*\n    show     all\n    allow    anyone\n/.test(edited) && !/auth|email/.test(edited));
check('the file as it was is in site.az.bak', readFileSync(join(dir, 'site.az.bak'), 'utf8') === FRESH);
const checked = az('check', 'site.az');
check('az check passes on the edited file', checked.status === 0 && /no problems found/.test(checked.stdout), checked.stderr.slice(-400));
const again = az('add', 'chat', 'site.az', '--show', 'all');
check('a second az add chat adds nothing and makes no second backup',
  again.status === 0 && /nothing to add/.test(again.stdout) && readFileSync(source, 'utf8') === edited && !readdirSync(dir).includes('site.az.bak.2'),
  again.stdout.slice(-300));

/* ---- az dev serves it: a working chat with the demo answers ---- */
const port = await freePort();
let out = '';
const dev = spawn(process.execPath, [CLI, 'dev', source, '--out', join(dir, '.az-build'), '--port', String(port)], {
  cwd: dir, env: { ...process.env, AZ_WORDS: WORDS }, stdio: ['ignore', 'pipe', 'pipe'],
});
progress.cleanup = () => dev.kill('SIGINT');
progress.children = [dev];
dev.stdout.setEncoding('utf8');
dev.stderr.setEncoding('utf8');
dev.stdout.on('data', (c) => { out += c; });
dev.stderr.on('data', (c) => { out += c; });
const ready = await new Promise((done) => {
  const until = Date.now() + READY_TIMEOUT_MS;
  const poll = () => {
    if (/watching for changes/.test(out)) done(true);
    else if (dev.exitCode !== null || Date.now() > until) done(false);
    else setTimeout(poll, 200);
  };
  poll();
});
check('az dev serves the site and its backend', ready, ready ? '' : out.slice(-800));
if (!ready) { dev.kill('SIGKILL'); run.clear(); process.exit(1); }
const siteUrl = /site\s+(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)?.[1];
const backendUrl = /backend\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
check('a backend without accounts: no mailbox is started, and it says so', Boolean(backendUrl) && !/mailbox/.test(out) && /no accounts/.test(out), out.slice(-400));
check('the chat answers from the demo script', /chat answers from the demo script/.test(out));
const origin = siteUrl.replace(/\/$/, '');
for (const path of ['/auth/session', '/auth/sign-up']) {
  const r = await fetch(`${backendUrl}${path}`, { method: path.endsWith('up') ? 'POST' : 'GET', headers: { origin, 'x-az-request': '1', 'content-type': 'application/json' }, ...(path.endsWith('up') ? { body: '{}' } : {}), signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
  check(`the backend has no sign-in: ${path} is 404`, r.status === 404, String(r.status));
}

const browsers = [];
try {
  const b = await chromium.launch();
  browsers.push(b);
  const page = await b.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(() => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === 'idle');
  check('the panel is ready for anyone, signed out — no "Sign in to ask"', !(await page.getByText('Sign in to ask').isVisible()));
  const asks = page.locator('[data-az-chat-ask]');
  check('the greeting and both suggested questions are shown',
    (await page.getByText('Hi! Ask me anything about this site.').count()) > 0 && (await asks.count()) === 2);
  await asks.first().click();
  await page.waitForFunction((demo) => [...document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site')]
    .some((m) => m.textContent?.includes(demo)), DEMO, { timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === 'idle');
  check('a suggested question is answered with the demo script', true);
  const signup = await page.goto(new URL('/signup', siteUrl).href);
  check('there is no sign-up page: the site has no auth', (await page.locator('form[data-flow]').count()) === 0, String(signup?.status()));
  check('no page errors in the browser', errors.length === 0, errors[0] ?? '');
} catch (e) {
  check('the browser run completed', false, e.message.split('\n')[0]);
} finally {
  closed = (await Promise.all(browsers.map((b) => closeWithin(b, CLOSE_MS, `${b.browserType().name()}.close`)))).every(Boolean) && closed;
}

/* ---- Ctrl-C: every child gone, every port closed ---- */
{
  const kids = childrenOf(dev.pid);
  const backendPort = Number(new URL(backendUrl).port);
  const exited = new Promise((done) => dev.once('exit', (code) => done(code)));
  dev.kill('SIGINT');
  const code = await Promise.race([exited, new Promise((done) => setTimeout(() => done('timeout'), EXIT_TIMEOUT_MS))]);
  check('Ctrl-C exits az dev cleanly', code === 0, `exit ${code}`);
  await new Promise((r) => setTimeout(r, 500));
  check('no child process outlives az dev', kids.every((pid) => !alive(pid)), kids.filter(alive).join(' '));
  const open = await Promise.all([port, backendPort].map(portOpen));
  check('the site and backend ports are closed', open.every((o) => !o), open.join(' '));
  if (code === 'timeout') dev.kill('SIGKILL');
}

if (failures === 0) rmSync(dir, { recursive: true, force: true });
else console.log(`\nwork dir kept: ${dir}\n--- az dev output ---\n${out.slice(-1500)}`);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
run.clear();
if (!closed) process.exit();
