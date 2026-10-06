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
import AxeBuilder from '@axe-core/playwright';
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
  data messages
    email   email    required private
    allow anyone   create

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

/**
 * An SMTP listener that keeps every message: sign-up sends none, but an
 * admin proves their address with a sign-in link (data-spec §11: only a
 * verified account is an admin), and the test opens that link.
 */
function startSmtpSink() {
  const messages = [];
  const server = createNetServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 sink\r\n');
    let data = null;
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\r\n');
      pending = lines.pop();
      for (const line of lines) {
        if (data !== null) {
          if (line === '.') { messages.push(data.join('\r\n')); data = null; socket.write('250 ok\r\n'); } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (/^DATA/i.test(line)) { data = []; socket.write('354 go\r\n'); } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n'); else if (line) socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ port: server.address().port, messages, close: () => server.close() })));
}

/** A message body as text: quoted-printable soft breaks and escapes undone. */
const unquote = (raw) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

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

/** The browsers that run signed-in flows (WebKit drops the Secure cookie here — see the header). */
const BROWSERS = ['chromium', 'firefox'];
const adminEmail = (browser) => `boss-${browser}@notebook.test`;

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
    // One admin per signed-in browser, and a listed address nobody verifies.
    AZ_ADMIN_EMAILS: [...BROWSERS.map((b) => adminEmail(b)), ...BROWSERS.map((b) => `unverified-${b}@notebook.test`)].join(','),
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

// The admin pages ship pre-rendered as a shell: the sign-in check, no rows.
const shell = await (await fetch(`${host.url}/admin/notes/`)).text();
check('/admin/notes is pre-rendered as a shell: noindex, the sign-in check, no data',
  shell.includes('<meta name="robots" content="noindex, nofollow" />') && shell.includes('Checking that you are signed in') && !shell.includes('az-admin-table'),
  shell.slice(0, 120));

const PASSWORD = 'correct-horse-battery';
const SECRET_CONTACT = 'private-contact@notebook.test';

async function signUp(page, name, email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@notebook.test`) {
  await page.goto(`${host.url}/signup`);
  const form = page.locator('form[data-flow="signup"]');
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="email"]').fill(email);
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

/**
 * Sign up with `email`, then prove the address as a person would: ask for a
 * sign-in link, open it from the mail. The account is then verified — the
 * only way an address in AZ_ADMIN_EMAILS makes an admin (data-spec §11).
 */
async function verifiedAccount(page, name, email) {
  await signUp(page, name, email);
  const before = smtp.messages.length;
  const status = await page.evaluate(async ([base, address]) => (await fetch(`${base}/auth/link`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-az-request': '1' },
    body: JSON.stringify({ email: address }),
  })).status, [serverUrl, email]);
  const pattern = new RegExp(`${serverUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/auth/link/verify\\?token=[A-Za-z0-9_-]+`);
  let link = null;
  for (const until = Date.now() + 5_000; !link && Date.now() < until;) {
    link = smtp.messages.slice(before).map(unquote).filter((m) => m.includes(email)).map((m) => pattern.exec(m)?.[0]).find(Boolean) ?? null;
    if (!link) await new Promise((r) => setTimeout(r, 50));
  }
  if (status !== 200 || !link) throw new Error(`no sign-in link for ${email} (status ${status})`);
  await page.goto(link);
  await page.waitForURL((u) => u.origin === host.url);
}

/** axe on the page as it is now: violations as "rule×count", none expected. */
async function axeViolations(page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations.map((v) => `${v.id}×${v.nodes.length}`);
}

/**
 * The admin area in one browser (data-spec §11, §14): a verified, listed
 * account lists, searches, edits — refused by the same validation and copy
 * as the API — deletes behind a named confirm with the keyboard, moderates
 * an anyone-create table, and reads the audit, which holds no value. A
 * signed-in account that is not an admin, and a listed one that is not
 * verified, see the refusal; the server refuses them too.
 */
async function adminFlow(b, name, owner) {
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name} admin: ${e.message}`));
  await verifiedAccount(page, 'Boss', adminEmail(name));

  const target = await use(owner, 'create', { title: `${name} for review`, contact: SECRET_CONTACT });
  const stranger = await (await b.newContext()).newPage();
  await stranger.goto(`${host.url}/`);
  const spam = await stranger.evaluate(async (base) => (await fetch(`${base}/data/messages`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-az-request': '1' },
    body: JSON.stringify({ email: 'spam@junk.test' }),
  })).status, serverUrl);
  check(`${name}: a stranger adds a row to the anyone-create table`, target.ok === true && spam === 201, `${spam}`);

  await page.goto(`${host.url}/admin`);
  const tables = page.locator('section[aria-labelledby="az-admin-tables"]');
  await tables.getByRole('link', { name: 'notes', exact: true }).waitFor();
  const listText = await tables.innerText();
  check(`${name} admin: /admin lists every table with its count`, /notes\s+\d+ rows?/.test(listText) && /messages\s+\d+ rows?/.test(listText), listText.replace(/\s+/g, ' '));
  const homeAxe = await axeViolations(page);
  check(`${name} admin: axe finds nothing on /admin`, homeAxe.length === 0, homeAxe.join(', '));

  await tables.getByRole('link', { name: 'notes', exact: true }).click();
  await page.waitForURL(`${host.url}/admin/notes`);
  await page.getByLabel('Search').fill(`${name} for review`);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.locator('.az-admin-count', { hasText: '1 row matches' }).waitFor();
  const row = page.locator('.az-admin-table tbody tr');
  check(`${name} admin: search narrows the rows; the private field and the owner show`,
    (await row.count()) === 1 && (await row.innerText()).includes(SECRET_CONTACT) && /ada/i.test(await row.innerText()), (await row.first().innerText()).replace(/\s+/g, ' '));

  // The editor: its heading takes focus; the same checks and sentences as the API.
  await page.getByRole('button', { name: `Edit “${name} for review”` }).click();
  const heading = page.locator('#az-admin-editor-title');
  await heading.waitFor();
  check(`${name} admin: the editor opens with focus on its heading`, await heading.evaluate((h) => document.activeElement === h));
  const title = page.locator('#az-admin-notes-title');
  await title.fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Title is required.').waitFor();
  check(`${name} admin: an emptied required field is refused, named, and focused`,
    await title.evaluate((el) => document.activeElement === el && el.getAttribute('aria-invalid') === 'true'));
  await title.fill('x'.repeat(201));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Title is too long.').waitFor();
  check(`${name} admin: over the limit is too long, as the API says it`, true);
  await title.fill(`${name} edited by admin`);
  await page.locator('#az-admin-notes-contact').fill('not-an-address');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Contact is not valid.').waitFor();
  check(`${name} admin: a value only the server refuses comes back as the same sentence, on its field`,
    await page.locator('#az-admin-notes-contact').getAttribute('aria-invalid') === 'true');
  const editorAxe = await axeViolations(page);
  check(`${name} admin: axe finds nothing with the editor and its errors open`, editorAxe.length === 0, editorAxe.join(', '));
  await page.locator('#az-admin-notes-contact').fill(SECRET_CONTACT);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText(`Saved “${name} edited by admin”.`).waitFor();
  const seen = await use(owner, 'get', target.item.id);
  check(`${name} admin: the edit is the owner's row now, still theirs`, seen.ok === true && seen.item.title === `${name} edited by admin` && seen.item.mine === true, JSON.stringify(seen).slice(0, 120));

  // Delete, by keyboard: the confirm names the row; Escape cancels and focus returns.
  await page.getByLabel('Search').fill(`${name} edited`);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.locator('.az-admin-count', { hasText: '1 row matches' }).waitFor();
  const del = page.getByRole('button', { name: `Delete “${name} edited by admin”` });
  await del.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('#az-admin-confirm');
  await page.locator('#az-admin-confirm[data-state="open"]').waitFor();
  const named = await dialog.innerText();
  check(`${name} admin: the confirm names the row and the table`, named.includes(`“${name} edited by admin” will be deleted from notes`), named.replace(/\s+/g, ' '));
  check(`${name} admin: focus starts on Cancel, not on Delete`, await page.evaluate(() => document.activeElement?.textContent === 'Cancel'));
  const dialogAxe = await axeViolations(page);
  check(`${name} admin: axe finds nothing with the confirm open`, dialogAxe.length === 0, dialogAxe.join(', '));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#az-admin-confirm')?.open);
  await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, `Delete “${name} edited by admin”`);
  check(`${name} admin: Escape closes it, nothing deleted, focus back on the row's Delete`, (await use(owner, 'get', target.item.id)).ok === true);
  await page.keyboard.press('Enter');
  await page.locator('#az-admin-confirm[data-state="open"]').waitFor();
  await page.keyboard.press('Tab');
  check(`${name} admin: Tab reaches Delete inside the confirm`, await page.evaluate(() => document.activeElement?.textContent === 'Delete'));
  await page.keyboard.press('Enter');
  await page.getByText(`Deleted “${name} edited by admin”.`).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('az-admin-count'));
  const gone = await use(owner, 'get', target.item.id);
  check(`${name} admin: deleted; focus lands on the row count, the owner's row is not_found`, gone.ok === false && gone.code === 'not_found', JSON.stringify(gone));

  // Moderation: the anyone-create table says so; the stranger's row is removable.
  await page.goto(`${host.url}/admin/messages`);
  await page.getByText('Anyone can add rows to this table').waitFor();
  const spamRow = page.locator('.az-admin-table tbody tr', { hasText: 'spam@junk.test' }).first();
  await spamRow.waitFor();
  await spamRow.getByRole('button', { name: /^Delete/ }).click();
  await page.locator('#az-admin-confirm[data-state="open"]').waitFor();
  await page.locator('#az-admin-confirm').getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Deleted “spam@junk.test”.').waitFor();
  check(`${name} admin: a stranger's row in an anyone-create table is moderated away`, true);

  // The audit: who and what happened, never a value.
  await page.goto(`${host.url}/admin`);
  const audit = page.locator('section[aria-labelledby="az-admin-audit"]');
  await audit.getByText(`${adminEmail(name)} deleted a row in messages`).waitFor();
  const auditText = await audit.innerText();
  check(`${name} admin: the audit shows the edit and the deletes`, auditText.includes(`${adminEmail(name)} edited a row in notes`) && auditText.includes(`${adminEmail(name)} deleted a row in notes`));
  check(`${name} admin: the audit holds no value`, !auditText.includes(SECRET_CONTACT) && !auditText.includes('edited by admin') && !auditText.includes('spam@junk.test'));

  // Refused: a signed-in account that is not an admin, and a listed one never verified.
  for (const [who, email] of [['an unlisted account', undefined], ['a listed but unverified account', `unverified-${name}@notebook.test`]]) {
    const other = await (await b.newContext()).newPage();
    other.on('pageerror', (e) => errors.push(`${name} refused: ${e.message}`));
    await signUp(other, 'Eve', email);
    await other.goto(`${host.url}/admin`);
    await other.getByText('This account is not an admin of this site.').waitFor();
    const direct = await other.evaluate(async (base) => (await fetch(`${base}/admin/data/notes`, { credentials: 'include' })).status, serverUrl);
    check(`${name}: ${who} sees the refusal; the server answers it 403`, direct === 403, String(direct));
  }
  await ctx.close();
}

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
      // The admin pages are inside <Protected>: signed out, /admin sends the visitor to sign in.
      await visitor.goto(`${host.url}/admin/notes`);
      await visitor.waitForURL((u) => u.pathname === '/login');
      check(`${name}: signed out, /admin/notes goes to the login page with next`, new URL(visitor.url()).searchParams.get('next') === '/admin/notes', visitor.url());
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
      await adminFlow(b, name, owner);
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
