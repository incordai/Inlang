/**
 * `az dev`, end to end — PRD §6.7: "compile, serve, watch, hot-reload, open
 * browser", and for a site with a backend, the whole of it locally with no
 * setup (backend-spec, Local development).
 *
 * Spawns the real `az dev` on a site that declares `backend`, then in a real
 * browser: signs up, asks for a password reset, reads the link from the dev
 * mailbox, sets a new password, signs in — in Chromium, and signs in again in
 * Firefox and WebKit (the dev profile's loopback cookie). Edits the .az
 * file and waits for the open page to change by itself. Checks the dev state
 * never reaches a production build, then sends Ctrl-C (SIGINT) and requires
 * every child process to be gone and every port closed.
 *
 * First run installs the generated project's dependencies (network).
 *
 * Run: pnpm test:dev
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'packages/cli/bin/az.js');
const WORDS = join(ROOT, 'packages/words');
/** First run includes an npm install. */
const READY_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 15_000;

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

const SITE = `az 1

site studio
  auth
    adapter azbackend
    protect /account
  backend
    database sqlite
    email smtp

page /
  hero center
    title "The studio"

page /login
  auth login
    title    "Welcome back"
    redirect /account
    alt      "Create an account" /signup
    alt      "Forgot your password" /reset

page /signup
  auth signup
    terms /terms
    alt   "Sign in instead" /login

page /reset
  auth reset
    alt "Back to sign in" /login

page /account
  hero center
    title "Your orders"

page /terms
  text
    title "Terms"
    body  "Plain terms, in plain words."
`;

const USER = { name: 'Ada', email: 'ada@studio.test', password: 'a-long-enough-password', next: 'an-even-longer-password' };

const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});
const portOpen = (port) => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
/** Direct children of a process (macOS and Linux both have pgrep -P). */
const childrenOf = (pid) => {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map(Number);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const dir = mkdtempSync(join(tmpdir(), 'az-dev-e2e-'));
const source = join(dir, 'site.az');
writeFileSync(source, SITE, 'utf8');
const port = await freePort();

let out = '';
const az = spawn(process.execPath, [CLI, 'dev', source, '--out', join(dir, '.az-build'), '--port', String(port)], {
  cwd: dir,
  env: { ...process.env, AZ_WORDS: WORDS },
  stdio: ['ignore', 'pipe', 'pipe'],
});
az.stdout.setEncoding('utf8');
az.stderr.setEncoding('utf8');
az.stdout.on('data', (c) => { out += c; });
az.stderr.on('data', (c) => { out += c; });

const ready = await new Promise((done) => {
  const until = Date.now() + READY_TIMEOUT_MS;
  const poll = () => {
    if (/watching for changes/.test(out)) done(true);
    else if (az.exitCode !== null || Date.now() > until) done(false);
    else setTimeout(poll, 200);
  };
  poll();
});
check('az dev serves the site, backend and mailbox, and says where', ready, ready ? '' : out.slice(-600));
if (!ready) { az.kill('SIGKILL'); process.exit(1); }

const siteUrl = /site\s+(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)?.[1];
const backendUrl = /backend\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
const mailboxUrl = /mailbox\s+(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)?.[1];
check('every address is on 127.0.0.1', Boolean(siteUrl && backendUrl && mailboxUrl), `${siteUrl} ${backendUrl} ${mailboxUrl}`);
const at = (path) => new URL(path, siteUrl).href;
const devDir = join(dir, '.az-dev');
check('.az-dev ignores itself and keeps an owner-only secret',
  /^\*$/m.test(readFileSync(join(devDir, '.gitignore'), 'utf8')) && (statSync(join(devDir, 'secret')).mode & 0o777) === 0o600);

const mailFor = async (to, n) => {
  const until = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const all = await (await fetch(`${mailboxUrl}messages.json`)).json();
    const mine = all.filter((m) => m.to === to);
    if (mine.length >= n) return mine[0];
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
};

const browsers = [];
try {
  const b = await chromium.launch();
  browsers.push(b);
  const page = await b.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const form = (flow) => page.locator(`form[data-flow="${flow}"]`);

  /* sign up, with the retype */
  await page.goto(at('/signup'));
  await form('signup').locator('input[name="name"]').fill(USER.name);
  await form('signup').locator('input[name="email"]').fill(USER.email);
  await form('signup').locator('input[name="password"]').fill(USER.password);
  await form('signup').locator('input[name="passwordConfirm"]').fill(USER.password);
  await form('signup').locator('input[name="terms"]').check();
  await form('signup').getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signup'));
  check('sign-up works against the local backend with no .env', true, page.url().replace(siteUrl, '/'));

  /* forgot password → the dev mailbox → the link → a new password */
  await page.goto(at('/account'));
  await page.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  await page.goto(at('/reset'));
  await form('reset').locator('input[name="email"]').fill(USER.email);
  await form('reset').getByRole('button', { name: 'Email me a link' }).click();
  const mail = await mailFor(USER.email, 1);
  const link = mail && /https?:\/\/\S+/.exec(mail.text)?.[0];
  check('the reset email lands in the dev mailbox, not the world', Boolean(link), mail?.subject ?? 'no message');
  check('az dev prints the email and its link in the terminal', Boolean(link) && out.includes(link));
  const inbox = await (await fetch(mailboxUrl)).text();
  check('the mailbox page lists it', inbox.includes('Reset your password'));
  await page.goto(link);
  await form('reset-set').locator('input[name="password"]').fill(USER.next);
  await form('reset-set').locator('input[name="passwordConfirm"]').fill(USER.next);
  await form('reset-set').getByRole('button', { name: 'Save new password' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/reset'));
  check('the emailed link sets a new password', true);

  /* sign in with the new password, in each engine */
  const signIn = async (engine, name) => {
    const browser = engine === chromium ? b : await engine.launch();
    if (browser !== b) browsers.push(browser);
    const p = await browser.newPage();
    p.setDefaultTimeout(STEP_TIMEOUT_MS);
    try {
      await p.goto(at('/login'));
      const login = p.locator('form[data-flow="login"]');
      await login.locator('input[name="email"]').fill(USER.email);
      await login.locator('input[name="password"]').fill(USER.next);
      await login.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForURL(/\/account/);
      await p.locator('.az-session').waitFor();
      check(`${name}: signs in over http://127.0.0.1 and reaches the protected page`, true);
    } catch (e) {
      check(`${name}: signs in over http://127.0.0.1 and reaches the protected page`, false, e.message.split('\n')[0]);
    } finally {
      await p.close();
    }
  };
  await signIn(chromium, 'chromium');
  await signIn(firefox, 'firefox');
  await signIn(webkit, 'webkit');

  /* edit the .az file: the open page changes by itself */
  await page.goto(at('/'));
  await page.locator('h1').waitFor();
  check('CONTROL: the page shows the title as written', (await page.locator('h1').textContent())?.includes('The studio'));
  writeFileSync(source, SITE.replace('title "The studio"', 'title "The workshop"'), 'utf8');
  try {
    await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('The workshop'), null, { timeout: STEP_TIMEOUT_MS });
    check('a save updates the open page with no manual reload', true);
  } catch {
    check('a save updates the open page with no manual reload', false, await page.locator('h1').textContent());
  }
  check('no page errors in the browser', errors.length === 0, errors[0] ?? '');
} catch (e) {
  check('the browser run completed', false, e.message.split('\n')[0]);
} finally {
  await Promise.all(browsers.map((b) => b.close()));
}

/* the dev profile never reaches a production build */
{
  const prod = join(dir, 'prod');
  execFileSync(process.execPath, [CLI, 'build', source, '--out', prod], {
    cwd: dir, env: { ...process.env, AZ_WORDS: WORDS, AZ_PUBLIC_BACKEND_URL: 'https://api.example.org' }, stdio: 'ignore',
  });
  // Code markers only: the server README may point at `az dev` in prose.
  const grep = spawnSync('grep', ['-rlE', 'startMailbox|startDevBackend|withoutSecure|messages\\.json|az dev mailbox', prod], { encoding: 'utf8' });
  check('a production az build carries no dev mailbox or dev profile', grep.stdout.trim() === '', grep.stdout.trim());
}

/* Ctrl-C: every child gone, every port closed */
{
  const kids = childrenOf(az.pid);
  check('CONTROL: az dev runs the dev server as a child process', kids.length > 0, `children: ${kids.join(' ')}`);
  const backendPort = Number(new URL(backendUrl).port);
  const mailboxPort = Number(new URL(mailboxUrl).port);
  const exited = new Promise((done) => az.once('exit', (code) => done(code)));
  az.kill('SIGINT');
  const code = await Promise.race([exited, new Promise((done) => setTimeout(() => done('timeout'), EXIT_TIMEOUT_MS))]);
  check('Ctrl-C exits az dev cleanly', code === 0, `exit ${code}`);
  await new Promise((r) => setTimeout(r, 500));
  check('no child process outlives az dev', kids.every((pid) => !alive(pid)), kids.filter(alive).join(' '));
  const open = await Promise.all([port, backendPort, mailboxPort].map(portOpen));
  check('the site, backend and mailbox ports are all closed', open.every((o) => !o), open.join(' '));
  if (code === 'timeout') az.kill('SIGKILL');
}

if (failures === 0) rmSync(dir, { recursive: true, force: true });
else console.log(`\nwork dir kept: ${dir}\n--- az dev output ---\n${out.slice(-1500)}`);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
