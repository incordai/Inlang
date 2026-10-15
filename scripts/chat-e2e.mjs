/**
 * The chat block end to end, in real browsers (chat-block-spec §12, C1): a
 * site with two chat panels, built by the real CLI and served as it ships;
 * the server `az build` generated for it, started as its own process with
 * the `fake` model adapter replaying scripted answers — so every run is
 * deterministic and no model is called.
 *
 *     pnpm test:chat
 *
 * In Chromium, Firefox and WebKit, over https (the site and the server's
 * TLS proxy use a certificate made at test time, lib/self-signed.mjs):
 *
 *   - signed out, the default `signedin` panel offers Sign in to ask and the
 *     server refuses the page's own request (401 signin_required);
 *   - an `allow anyone` panel streams an answer, as text in paragraphs,
 *     `aria-busy` while it streams; a follow-up carries the tagged history;
 *     past `limit` the panel says the chat is full and New chat starts over;
 *   - signed in, a suggested question asks itself;
 *   - an answer full of markup, images and links stays literal text: no
 *     element, no request anywhere but the site and the backend;
 *   - Stop (Escape) ends a stalled answer; a failed one offers Try again;
 *   - the status region hears sentences, not tokens: a long answer's
 *     updates are few;
 *   - keyboard: Tab reaches the input, Enter sends, Shift+Enter is a new
 *     line, focus stays in the input;
 *   - axe in every state; no Content-Security-Policy violation anywhere;
 *   - and the server's log never holds a visitor's or the model's words.
 */

import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { ROOT, buildSites } from './visual/pipeline.mjs';
import { closeWithin, watchdog, human } from './lib/bounded.mjs';
import { cspResult, violationControl, watchedContext } from './visual/csp.mjs';
import { selfSignedCert } from './lib/self-signed.mjs';

/* Deadlines (lib/bounded.mjs): a normal run takes about a minute. */
const RUN_MS = 10 * 60_000;
const CLOSE_MS = 15_000;
const CONTROL_MS = 10_000;
/** The longest any one UI state is waited for. */
const STATE_MS = 15_000;
const progress = { last: 'starting' };
const run = watchdog(RUN_MS, 'test:chat', progress);
console.log(`deadlines: run ${human(RUN_MS)} · state ${human(STATE_MS)} · close ${human(CLOSE_MS)}`);
let closed = true;
const csp = {};

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  progress.last = name;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

/** Words planted in a question and in an answer: the server's log must never hold either. */
const VISITOR_MARK = `visitor-mark-${randomBytes(4).toString('hex')}`;
const ANSWER_MARK = `answer-mark-${randomBytes(4).toString('hex')}`;
const HOSTILE = '<img src="https://evil.example/x.png" onerror="alert(1)"><script>alert(2)</script> ![x](https://evil.example/?q=1) [click](javascript:alert(3))';

const SITE = `az 1

site lantern
  auth
    adapter azbackend
  backend
    database sqlite
    email    smtp
    model    default

page /
  hero center
    title "Lantern"
  chat panel
    title    "Ask Lantern"
    greeting "Hi! Ask me about the lamps."
    ask      "How bright is it?"
    ask      "Does it ship abroad?"

page /open
  hero center
    title "Open chat"
  chat panel
    title    "Ask anyone"
    greeting "Anyone may ask here."
    allow    anyone
    limit    3

page /signup
  auth signup
    alt "Sign in instead" /login

page /login
  auth login
    redirect /
    alt      "Create an account" /signup
`;

/** The fake model's script (AZ_CHAT_FAKE_FILE): the first entry whose `when` the question holds. */
const FAKE = {
  answers: [
    { when: 'bright', chunks: ['It is bright: ', '800 lumens. ', 'Dimmable too.'], delayMs: 20 },
    { when: VISITOR_MARK, chunks: [`Planted ${ANSWER_MARK}. `, 'Second sentence.', '\n\nA new paragraph.'], delayMs: 20 },
    { when: 'hostile', chunks: [HOSTILE] },
    { when: 'stall', chunks: ['Starting', ' slowly'], stall: true },
    { when: 'fail', chunks: [], fail: 500 },
    // ~400 tokens, a sentence every 20 words: the status region must hear few updates, not 400.
    { when: 'long', chunks: Array.from({ length: 400 }, (_, i) => (i % 20 === 19 ? 'word. ' : 'word ')), delayMs: 3 },
    { chunks: ['A plain answer. ', 'Ask me anything else.'], delayMs: 10 },
  ],
};

const tls = selfSignedCert();
const CONTEXT = { ignoreHTTPSErrors: true };
const FETCH_MS = 15_000;

/** A Node-side https request that trusts the test's certificate (the server's health). */
const fetch = (url, init = {}) => new Promise((done, fail) => {
  const req = httpsRequest(url, { method: init.method ?? 'GET', headers: init.headers, ca: tls.cert, timeout: FETCH_MS }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('error', fail);
    res.on('end', () => done({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('timeout', () => req.destroy(new Error(`no answer after ${FETCH_MS / 1000}s: ${url}`)));
  req.on('error', fail);
  req.end(init.body);
});

/** Each engine as its own client address (TEST-NET-1), told by its user agent, so per-address limits count each apart. */
const CLIENT_ADDRESSES = [[/Firefox\//, '192.0.2.2'], [/Chrome\//, '192.0.2.1'], [/AppleWebKit\//, '192.0.2.3']];

/** TLS in front of the server's plain port, appending X-Forwarded-For as a deployment's proxy does; streams pass through. */
function startTlsProxy(port) {
  const server = createHttpsServer(tls, (req, res) => {
    const client = CLIENT_ADDRESSES.find(([agent]) => agent.test(req.headers['user-agent'] ?? ''))?.[1] ?? req.socket.remoteAddress;
    const forwarded = [req.headers['x-forwarded-for'], client].filter(Boolean).join(', ');
    const upstream = httpRequest({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': forwarded } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end(); });
    // The visitor went away (Stop): the server must see it too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `https://localhost:${server.address().port}`, close: () => server.close() })));
}

function startSite(root) {
  const server = createHttpsServer(tls, async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    for (const rel of extname(path) ? [path] : [join(path, 'index.html')]) {
      const file = normalize(join(root, rel));
      if (!file.startsWith(root + sep)) break;
      try {
        const body = await readFile(file);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type }).end(body);
        return;
      } catch { /* next candidate */ }
    }
    res.writeHead(404).end();
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `https://localhost:${server.address().port}`, close: () => server.close() })));
}

const freePort = () => new Promise((done) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

/** An SMTP listener that accepts and drops: sign-up sends no mail, but the server needs a relay to start. */
function startSmtpSink() {
  const server = createNetServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 sink\r\n');
    let data = false;
    socket.on('data', (chunk) => {
      for (const line of chunk.split('\r\n')) {
        if (data) { if (line === '.') { data = false; socket.write('250 ok\r\n'); } continue; }
        if (/^DATA/i.test(line)) { data = true; socket.write('354 go\r\n'); } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n'); else if (line) socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ port: server.address().port, close: () => server.close() })));
}

const work = mkdtempSync(join(tmpdir(), 'az-chat-e2e-'));
const serverPort = await freePort();
const proxy = await startTlsProxy(serverPort);
process.env.AZ_PUBLIC_BACKEND_URL = proxy.url;
const site = { dir: join(work, 'lantern'), source: SITE };
await buildSites([site], work);
check('the chat site compiles and builds', Boolean(site.compiled && site.dist), site.error ?? '');
if (!site.dist) {
  console.log(`\n1 CHECK(S) FAILED — work dir kept: ${work}`);
  run.clear();
  process.exit(1);
}

const smtp = await startSmtpSink();
const host = await startSite(normalize(site.dist));
const serverDir = join(site.proj, 'server');
mkdirSync(join(serverDir, 'node_modules'), { recursive: true });
symlinkSync(realpathSync(join(ROOT, 'node_modules/nodemailer')), join(serverDir, 'node_modules/nodemailer'), 'dir');
const fakeFile = join(work, 'fake-model.json');
writeFileSync(fakeFile, JSON.stringify(FAKE));
const child = spawn(process.execPath, ['src/main.ts'], {
  cwd: serverDir,
  env: {
    PATH: process.env.PATH,
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
    AZ_BACKEND_PUBLIC_URL: proxy.url, AZ_PORT: String(serverPort), AZ_ALLOWED_ORIGINS: host.url, AZ_TRUST_PROXY: 'true',
    AZ_SQLITE_PATH: join(serverDir, 'data/test.db'),
    AZ_EMAIL_FROM: 'Lantern <no-reply@lantern.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: String(smtp.port),
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: fakeFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
progress.children = [child];
let serverLog = '';
child.stdout.on('data', (c) => { serverLog += c; });
child.stderr.on('data', (c) => { serverLog += c; });
const up = await new Promise((done) => {
  const until = Date.now() + 15_000;
  const retry = () => (Date.now() > until ? done(false) : setTimeout(poll, 200));
  const poll = () => fetch(`${proxy.url}/health`).then((r) => (r.ok ? done(true) : retry()), retry);
  poll();
});
check('the generated server starts with the fake model adapter', up, serverLog.trim().split('\n').slice(0, 4).join(' / '));
if (!up) {
  child.kill('SIGTERM');
  proxy.close(); host.close(); smtp.close();
  console.log(`\n1 CHECK(S) FAILED — work dir kept: ${work}`);
  run.clear();
  process.exit(1);
}

const PASSWORD = 'correct-horse-battery';
const backendOrigin = new URL(proxy.url).origin;

/** Every request a page makes, by origin — anything but the site and the backend fails the run. */
function recordRequests(page, seen) {
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    seen.add(new URL(u).origin);
  });
}

async function signUp(page, name) {
  await page.goto(`${host.url}/signup`);
  const form = page.locator('form[data-flow="signup"]');
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="email"]').fill(`${name.toLowerCase()}-${randomBytes(3).toString('hex')}@lantern.test`);
  await form.locator('input[name="password"]').fill(PASSWORD);
  await form.locator('input[name="passwordConfirm"]').fill(PASSWORD);
  await form.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signup'), { timeout: STATE_MS });
}

const panel = (page) => page.locator('[data-az-chat]');
/** Wait until the panel's runtime has decided who may ask. */
const ready = (page, state = 'idle') => page.waitForFunction((s) => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === s
  && document.documentElement.hasAttribute('data-az-ready'), state, { timeout: STATE_MS });
/** The last answer's text, once it is no longer busy. */
async function lastAnswer(page) {
  await page.waitForFunction(() => {
    const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
    const last = items[items.length - 1];
    return items.length > 1 && last.getAttribute('aria-busy') === 'false';
  }, null, { timeout: STATE_MS });
  return page.evaluate(() => {
    const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
    const last = items[items.length - 1];
    return { paragraphs: [...last.querySelectorAll('p')].map((p) => p.textContent), elements: last.querySelectorAll('*').length };
  });
}
/** axe on the page as it is: zero violations. */
async function axe(page, label) {
  const r = await new AxeBuilder({ page }).analyze();
  check(`${label}: axe finds no violation`, r.violations.length === 0, r.violations.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
}
/** Count what the status region is told while `work` runs. */
async function announcements(page, work) {
  await page.evaluate(() => {
    const status = document.querySelector('[data-az-chat-status]');
    globalThis.azSaid = [];
    new MutationObserver(() => { if (status.textContent) globalThis.azSaid.push(status.textContent); })
      .observe(status, { childList: true, characterData: true, subtree: true });
  });
  await work();
  return page.evaluate(() => globalThis.azSaid);
}

async function anonymousFlow(b, name, origins) {
  const ctx = await watchedContext(b, csp, CONTEXT);
  try {
    const page = await ctx.newPage();
    recordRequests(page, origins);
    page.on('dialog', (d) => { check(`${name}: no dialog ever opens`, false, d.message()); void d.dismiss(); });

    // The default panel: signed-in visitors only.
    await page.goto(`${host.url}/`);
    await ready(page, 'signin');
    check(`${name}: signed out, the default panel offers Sign in to ask and hides the form`,
      await panel(page).locator('[data-az-chat-signin]').isVisible() && !(await panel(page).locator('[data-az-chat-form]').isVisible())
      && await panel(page).getByText('Hi! Ask me about the lamps.').isVisible());
    await axe(page, `${name} signed out`);
    const refused = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/chat`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-az-request': '1' },
        body: JSON.stringify({ page: '/', messages: [{ role: 'visitor', text: 'hello' }] }),
      });
      return { status: r.status, body: await r.json() };
    }, proxy.url);
    check(`${name}: the server refuses an anonymous question on a signedin chat (401 signin_required)`,
      refused.status === 401 && refused.body.error === 'signin_required', JSON.stringify(refused));

    // The open panel: anyone may ask.
    await page.goto(`${host.url}/open`);
    await ready(page);
    await axe(page, `${name} idle`);
    // Keyboard: Tab reaches the input; Shift+Enter is a new line; Enter sends; focus stays.
    const input = panel(page).locator('[data-az-chat-input]');
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await input.evaluate((el) => el === document.activeElement);
    }
    check(`${name}: Tab reaches the question input`, reached);
    await page.keyboard.type(`First line ${VISITOR_MARK}`);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    check(`${name}: Shift+Enter is a new line, not a send`, (await input.inputValue()) === `First line ${VISITOR_MARK}\nsecond line`);
    const said = await announcements(page, async () => {
      await page.keyboard.press('Enter');
      const busy = await page.waitForFunction(() => document.querySelector('.az-chat-transcript > .az-chat-message--site:last-child')?.getAttribute('aria-busy') === 'true', null, { timeout: STATE_MS }).then(() => true, () => false);
      check(`${name}: the answer is aria-busy while it streams`, busy);
      const answer = await lastAnswer(page);
      check(`${name}: the answer streams in as text, in paragraphs`,
        JSON.stringify(answer.paragraphs) === JSON.stringify([`Planted ${ANSWER_MARK}. Second sentence.`, 'A new paragraph.']),
        JSON.stringify(answer.paragraphs));
    });
    check(`${name}: focus stayed in the input`, await input.evaluate((el) => el === document.activeElement));
    check(`${name}: the status region heard whole sentences`, said.length > 0 && said.every((s) => /[.!?]$/.test(s)), JSON.stringify(said));
    await axe(page, `${name} answered`);

    // A follow-up sends the tagged history; the server accepts it (no `tampered`).
    await input.fill('And hostile?');
    await input.press('Enter');
    const hostile = await lastAnswer(page);
    check(`${name}: markup, images and links in an answer stay literal text — no element made`,
      hostile.paragraphs.join('') === HOSTILE && hostile.elements === 0, JSON.stringify(hostile));
    check(`${name}: nothing in the transcript is an image, script or link`,
      await page.locator('[data-az-chat-transcript] :is(img, script, a, iframe)').count() === 0);

    // The third question of three; after it the chat is full.
    await input.fill('One more?');
    await input.press('Enter');
    await lastAnswer(page);
    await page.waitForFunction(() => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === 'full', null, { timeout: STATE_MS });
    check(`${name}: past limit the panel says the chat is full and offers New chat`,
      await panel(page).getByText('This chat is full').isVisible() && await panel(page).locator('[data-az-chat-reset]').isVisible()
      && !(await panel(page).locator('[data-az-chat-form]').isVisible()));
    await panel(page).locator('[data-az-chat-reset]').click();
    await ready(page);
    check(`${name}: New chat starts over with the greeting alone`,
      await panel(page).locator('[data-az-chat-transcript] > li').count() === 1 && await panel(page).locator('[data-az-chat-form]').isVisible());

    // Stop: Escape ends a stalled answer.
    await input.fill('stall please');
    await input.press('Enter');
    await panel(page).locator('[data-az-chat-stop]').waitFor({ state: 'visible', timeout: STATE_MS });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[data-az-chat-note]')?.textContent === 'Stopped.', null, { timeout: STATE_MS });
    check(`${name}: Escape stops an answer; the panel says so and Send is back`,
      await panel(page).locator('[data-az-chat-send]').isVisible() && !(await panel(page).locator('[data-az-chat-stop]').isVisible()));

    // A failure offers Try again, in fixed copy.
    await input.fill('fail now');
    await input.press('Enter');
    await panel(page).locator('[data-az-chat-retry]').waitFor({ state: 'visible', timeout: STATE_MS });
    check(`${name}: a failed answer says so in fixed copy, with Try again`,
      await panel(page).getByText('The answer could not be finished — try again.').isVisible());
    await axe(page, `${name} error`);

    // A long answer: few status updates, not one per token.
    await panel(page).locator('[data-az-chat-reset]').click().catch(() => {});
    await ready(page);
    const long = await announcements(page, async () => {
      await input.fill('a long answer please');
      await input.press('Enter');
      await lastAnswer(page);
    });
    check(`${name}: a 400-token answer reaches the status region in a few updates, not 400`, long.length >= 1 && long.length <= 12, `${long.length} updates`);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} anonymous context close`)) && closed;
  }
}

async function signedInFlow(b, name, origins) {
  const ctx = await watchedContext(b, csp, CONTEXT);
  try {
    const page = await ctx.newPage();
    recordRequests(page, origins);
    await signUp(page, `Chat${name}`);
    await page.goto(`${host.url}/`);
    await ready(page);
    check(`${name}: signed in, the default panel shows its form and suggestions`,
      await panel(page).locator('[data-az-chat-form]').isVisible() && await panel(page).locator('[data-az-chat-asks]').isVisible());
    await panel(page).getByRole('button', { name: 'How bright is it?' }).click();
    const answer = await lastAnswer(page);
    check(`${name}: a suggested question asks itself and is answered`,
      answer.paragraphs.join('') === 'It is bright: 800 lumens. Dimmable too.', JSON.stringify(answer.paragraphs));
    check(`${name}: the suggestions are gone once a question is asked`, !(await panel(page).locator('[data-az-chat-asks]').isVisible()));
    await axe(page, `${name} signed in, answered`);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} signed-in context close`)) && closed;
  }
}

const errors = [];
try {
  for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    const b = await engine.launch();
    try {
      const caught = await violationControl(b, `${host.url}/az-policy-control/`, CONTROL_MS);
      check(`${name} CONTROL §2 B: the watch reports a page that breaks its policy`, !cspResult(caught).pass, caught[0] ?? 'nothing reported');
      const origins = new Set();
      await anonymousFlow(b, name, origins);
      await signedInFlow(b, name, origins);
      const others = [...origins].filter((o) => o !== host.url && o !== backendOrigin);
      check(`${name}: every request went to the site or its backend — nothing else`, others.length === 0 && origins.has(backendOrigin), [...origins].join(' '));
    } catch (e) {
      errors.push(`${name}: ${e.message.split('\n')[0]}`);
      check(`${name}: the flows ran to the end`, false, e.message.split('\n')[0]);
    } finally {
      closed = (await closeWithin(b, CLOSE_MS, `${name}.close`)) && closed;
    }
  }
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const { pass, detail } = cspResult(csp[engine] ?? []);
    check(`§2 B: no Content-Security-Policy violation on any page opened in ${engine}`, pass && engine in csp, detail || (engine in csp ? '' : 'no page was watched'));
  }
  check('the server logged answers (so the log was read)', /chat/i.test(serverLog), serverLog.split('\n').filter((l) => /chat/i.test(l)).slice(0, 2).join(' / '));
  check("the server's log holds no visitor's words and no model's words", !serverLog.includes(VISITOR_MARK) && !serverLog.includes(ANSWER_MARK)
    && !serverLog.includes('evil.example') && !serverLog.includes(PASSWORD));
} finally {
  child.kill('SIGTERM');
  proxy.close();
  host.close();
  smtp.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
if (failures === 0) rmSync(work, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
run.clear();
if (!closed) process.exit();
