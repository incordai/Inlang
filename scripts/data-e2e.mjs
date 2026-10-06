/**
 * The data tables end to end, in real browsers (data-spec §14): a site that
 * declares `data`, built by the real CLI with its schema lock, served as it
 * ships; the server `az build` generated for it, started as its own process
 * over SQLite; and the typed client (src/data/client.ts) used from a `raw`
 * component on the page — reads, writes, rules, private fields and error
 * codes through the browser's own cookie, CORS and CSRF handling.
 *
 *     pnpm test:data
 *
 * Chromium and Firefox run the signed-in flows. WebKit drops a Secure cookie
 * on plain-http loopback (dev-backend.ts notes the same), so against this
 * production server it runs the signed-out flows only.
 */

import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { CLI, ROOT, WORDS, buildSites } from './visual/pipeline.mjs';

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

const SITE = `az 1

site notebook
  auth
    adapter azbackend
  backend
    database sqlite
    email smtp
  data notes
    title   text     required search
    body    longtext
    contact email    private
    allow anyone   read
    allow signedin create
    allow owner    edit delete

page /
  hero center
    title "Notes"

page /signup
  auth signup
    terms /terms
    alt   "Sign in instead" /login

page /login
  auth login
    redirect /notes
    alt      "Create an account" /signup

page /terms
  text
    title "Terms"
    body  "Plain terms."

page /notes
  raw ./custom/Notes.tsx
`;

/** The author's component: the typed client, as a site uses it today. */
const NOTES_COMPONENT = `import { useEffect, useState } from "react";
import { tables, type Note } from "../../data/client.ts";

export default function Notes() {
  const [notes, setNotes] = useState<readonly Note[] | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    // For the test to drive the same client the component uses.
    (globalThis as { azData?: typeof tables }).azData = tables;
    void tables.notes.list({ sort: "title" }).then((r) => (r.ok ? setNotes(r.items) : setProblem(r.code)));
  }, []);
  if (problem) return <p data-notes="error">{problem}</p>;
  if (!notes) return <p data-notes="loading">Loading</p>;
  return (
    <ul data-notes="list">
      {notes.map((n) => <li key={n.id} data-mine={String(n.mine)}>{n.title}</li>)}
    </ul>
  );
}
`;

function startSite(root) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const candidates = extname(path) ? [path] : [join(path, 'index.html')];
    for (const rel of candidates) {
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
    done({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const freePort = () => new Promise((done) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

/** An SMTP listener that accepts and drops mail: sign-up sends none, but the server needs a host. */
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

const work = mkdtempSync(join(tmpdir(), 'az-data-e2e-'));
const serverPort = await freePort();
const serverUrl = `http://127.0.0.1:${serverPort}`;
process.env.AZ_PUBLIC_BACKEND_URL = serverUrl;

// The site's folder: its source, its component, and its schema lock — written
// by the real `az backend schema`, as an author would.
const site = { dir: join(work, 'notebook'), source: SITE };
mkdirSync(join(site.dir, 'custom'), { recursive: true });
writeFileSync(join(site.dir, 'site.az'), SITE);
writeFileSync(join(site.dir, 'custom/Notes.tsx'), NOTES_COMPONENT);
execFileSync(process.execPath, [CLI, 'backend', 'schema', join(site.dir, 'site.az')], { env: { ...process.env, AZ_WORDS: WORDS }, encoding: 'utf8' });
await buildSites([site], work);
check('the data site compiles and builds with its lock', Boolean(site.compiled && site.dist), site.error ?? '');
if (!site.dist) {
  console.log(`\n1 CHECK(S) FAILED — work dir kept: ${work}`);
  process.exit(1);
}

const smtp = await startSmtpSink();
const host = await startSite(normalize(site.dist));
const serverDir = join(site.proj, 'server');
mkdirSync(join(serverDir, 'node_modules'), { recursive: true });
symlinkSync(realpathSync(join(ROOT, 'node_modules/nodemailer')), join(serverDir, 'node_modules/nodemailer'), 'dir');
const child = spawn(process.execPath, ['src/main.ts'], {
  cwd: serverDir,
  env: {
    PATH: process.env.PATH,
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
    AZ_BACKEND_PUBLIC_URL: serverUrl, AZ_PORT: String(serverPort), AZ_ALLOWED_ORIGINS: host.url,
    AZ_SQLITE_PATH: join(serverDir, 'data/test.db'),
    AZ_EMAIL_FROM: 'Notebook <no-reply@notebook.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: String(smtp.port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (c) => { serverLog += c; });
child.stderr.on('data', (c) => { serverLog += c; });
const up = await new Promise((done) => {
  const until = Date.now() + 15_000;
  const poll = () => fetch(`${serverUrl}/health`).then((r) => done(r.ok), () => (Date.now() > until ? done(false) : setTimeout(poll, 200)));
  poll();
});
check('the generated server starts and applies the data step', up && /applied data steps 1/.test(serverLog), serverLog.trim().split('\n').slice(0, 3).join(' / '));

const PASSWORD = 'correct-horse-battery';
const SECRET_CONTACT = 'private-contact@notebook.test';

async function signUp(page, name) {
  await page.goto(`${host.url}/signup`);
  const form = page.locator('form[data-flow="signup"]');
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="email"]').fill(`${name.toLowerCase()}-${randomBytes(3).toString('hex')}@notebook.test`);
  await form.locator('input[name="password"]').fill(PASSWORD);
  await form.locator('input[name="passwordConfirm"]').fill(PASSWORD);
  await form.locator('input[name="terms"]').check();
  await form.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signup'));
}

/** Call the page's own typed client: `client.notes.<op>(...args)`. */
const use = (page, op, ...args) => page.evaluate(async ([o, a]) => {
  await new Promise((r) => { const t = setInterval(() => { if (globalThis.azData) { clearInterval(t); r(); } }, 20); });
  return globalThis.azData.notes[o](...a);
}, [op, args]);

const errors = [];
try {
  for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    const b = await engine.launch();
    try {
      const out = await b.newContext();
      const visitor = await out.newPage();
      visitor.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await visitor.goto(`${host.url}/notes`);
      // An empty table renders an empty (zero-height) list: attached, not visible.
      await visitor.locator('[data-notes="list"]').waitFor({ state: 'attached' });
      check(`${name}: signed out, the component lists the table through the typed client`, true);
      const refused = await use(visitor, 'create', { title: 'Hello' });
      check(`${name}: signed out, create answers signin_required`, refused.ok === false && refused.code === 'signin_required', JSON.stringify(refused));
      if (name === 'webkit') continue;

      const ownerCtx = await b.newContext();
      const owner = await ownerCtx.newPage();
      owner.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await signUp(owner, `Ada${name}`);
      await owner.goto(`${host.url}/notes`);
      const made = await use(owner, 'create', { title: `${name} note`, body: 'Two\nlines', contact: SECRET_CONTACT });
      check(`${name}: signed in, create returns the row, marked mine, owner never named`,
        made.ok === true && made.item.mine === true && made.item.title === `${name} note` && !('owner' in made.item), JSON.stringify(made).slice(0, 160));
      const bad = await use(owner, 'create', { title: 'x'.repeat(201) });
      check(`${name}: a value over its limit answers too_long with the field`, bad.ok === false && bad.code === 'too_long' && bad.field === 'title', JSON.stringify(bad));
      await owner.reload();
      await owner.locator(`[data-notes="list"] li[data-mine="true"]`, { hasText: `${name} note` }).waitFor();
      check(`${name}: after a reload the component shows the new row as mine`, true);

      const otherCtx = await b.newContext();
      const other = await otherCtx.newPage();
      other.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await signUp(other, `Bo${name}`);
      await other.goto(`${host.url}/notes`);
      const seen = await use(other, 'get', made.item.id);
      check(`${name}: another account reads the row with its private field null`, seen.ok === true && seen.item.contact === null && seen.item.mine === false, JSON.stringify(seen).slice(0, 160));
      const foreign = await use(other, 'update', made.item.id, { title: 'taken over' });
      const missing = await use(other, 'update', '00000000-0000-4000-8000-000000000000', { title: 'x' });
      check(`${name}: another account's edit is answered exactly like a missing row`, JSON.stringify(foreign) === JSON.stringify(missing) && foreign.code === 'not_found', JSON.stringify(foreign));
      const listed = await use(other, 'list', { q: `${name} NOTE` });
      check(`${name}: search finds it, case-insensitively`, listed.ok === true && listed.items.length === 1);

      const changed = await use(owner, 'update', made.item.id, { title: `${name} edited` });
      check(`${name}: its owner edits it`, changed.ok === true && changed.item.title === `${name} edited`);
      const removed = await use(owner, 'remove', made.item.id);
      check(`${name}: its owner deletes it`, removed.ok === true);
      const gone = await use(owner, 'get', made.item.id);
      check(`${name}: then it is not_found`, gone.ok === false && gone.code === 'not_found');
    } finally {
      await b.close();
    }
  }
  check('no page errors in any browser', errors.length === 0, errors.slice(0, 2).join(' | '));
  check('the server logged no private value', !serverLog.includes(SECRET_CONTACT) && !serverLog.includes(PASSWORD), serverLog.slice(0, 200));
} finally {
  child.kill('SIGTERM');
  host.close();
  smtp.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
if (failures === 0) rmSync(work, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
