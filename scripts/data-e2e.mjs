/**
 * The data tables end to end, in real browsers (data-spec §14): a site that
 * declares `data`, built by the real CLI with its schema lock, served as it
 * ships; the server `az build` generated for it, started as its own process
 * over SQLite; and the typed client (src/data/client.ts) used from a `raw`
 * component on the page — reads, writes, rules, private fields and error
 * codes through the browser's own cookie, CORS and CSRF handling; image
 * uploads (data-spec §8) through the client and the admin editor, shown by
 * an <img> across origins, stored without a photo's location, and removed
 * with their row.
 *
 *     pnpm test:data
 *
 * Blocks with `from <table>` (data-spec §10, D4) are checked here too: the
 * pre-rendered shell with no rows and a <noscript> line; public rows filled
 * as text (an HTML payload stays text); FAQ rows that open; the empty copy;
 * an error with a retry that recovers; `mine` signed out (the sign-in link)
 * and signed in (only the visitor's rows, on a protected page whose content
 * arrives late); axe on every state.
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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { CLI, COMPILE_MS, ROOT, WORDS, buildSites } from './visual/pipeline.mjs';
import { metadataFindings, phoneJpeg, plainJpeg, SVG } from '../packages/backend/test/image-fixtures.ts';
import { closeWithin, watchdog, human } from './lib/bounded.mjs';

/*
 * Deadlines (lib/bounded.mjs): page.evaluate and close() have no timeout of
 * their own. A normal run takes under a minute. Past RUN_MS (15× that) the
 * run is stuck: the watchdog names the last check that finished, stops what
 * this run started, and ends the process (which kills the browsers). Each
 * close is bounded on its own.
 */
const RUN_MS = 15 * 60_000;
const CLOSE_MS = 15_000;
const progress = { last: 'starting' };
const run = watchdog(RUN_MS, 'test:data', progress);
console.log(`deadlines: run ${human(RUN_MS)} · close ${human(CLOSE_MS)}`);
let closed = true;

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  progress.last = name;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

const SITE = `az 1

site notebook
  auth
    adapter azbackend
    protect /private
  backend
    database sqlite
    email smtp
  data notes
    title   text     required search
    body    longtext
    contact email    private
    photo   image
    allow anyone   read
    allow signedin create
    allow owner    edit delete
  data messages
    email   email    required private
    allow anyone   create
  data questions
    question text     required
    answer   longtext required
    allow anyone   read
    allow signedin create
  data quotes
    line    text     required
    allow anyone   read

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

page /board
  hero center
    title "Board"
  feature grid
    title "From the notebook"
    from notes
      title title
      text  body
      sort  created asc
      empty "No notes yet"
  faq
    title "Asked here"
    from questions
      question question
      text     answer
      sort     created asc
      limit    3

page /quotes
  hero center
    title "Quotes"
  feature grid
    title "Quotes"
    from quotes
      title line
      empty "Nothing quoted yet"

page /mine
  hero center
    title "Mine"
  feature grid
    title "Your notes"
    from notes
      title title
      mine
      empty "Sign in to see your notes"

page /photos
  hero center
    title "Photos"
  gallery grid
    title "Photos"
    from notes
      src     photo
      alt     title
      empty   "No photos yet"

page /private
  hero center
    title "Private"
  feature grid
    title "Private notes"
    from notes
      title title
      mine
      empty "You have no notes yet"
`;

/** The author's component: the typed client, as a site uses it today. */
const NOTES_COMPONENT = `import { useEffect, useState } from "react";
import { tables, type NotesRow } from "../../data/client.ts";

export default function Notes() {
  const [notes, setNotes] = useState<readonly NotesRow[] | null>(null);
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
      {notes.map((n) => (
        <li key={n.id} data-mine={String(n.mine)}>
          {n.title}
          {n.photo ? <img src={n.photo.url} width={n.photo.width} height={n.photo.height} alt={"Photo for " + n.title} /> : null}
        </li>
      ))}
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
    done({ url: `http://localhost:${server.address().port}`, close: () => server.close() })));
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
// The site and its server by NAME, as a deployment addresses them: Chromium
// judges two IP-literal origins never same-site, so a private image's
// `Cross-Origin-Resource-Policy: same-site` would block it between
// 127.0.0.1 ports while allowing it between localhost ports (measured).
const serverUrl = `http://localhost:${serverPort}`;
process.env.AZ_PUBLIC_BACKEND_URL = serverUrl;

// The site's folder: its source, its component, and its schema lock — written
// by the real `az backend schema`, as an author would.
const site = { dir: join(work, 'notebook'), source: SITE };
mkdirSync(join(site.dir, 'custom'), { recursive: true });
writeFileSync(join(site.dir, 'site.az'), SITE);
writeFileSync(join(site.dir, 'custom/Notes.tsx'), NOTES_COMPONENT);
execFileSync(process.execPath, [CLI, 'backend', 'schema', join(site.dir, 'site.az')], {
  env: { ...process.env, AZ_WORDS: WORDS }, encoding: 'utf8', timeout: COMPILE_MS, killSignal: 'SIGKILL',
});
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
// The image library the generated package.json pins (data-spec §8): the repository's tested copy.
symlinkSync(realpathSync(join(ROOT, 'node_modules/sharp')), join(serverDir, 'node_modules/sharp'), 'dir');
const filesDir = join(serverDir, 'data/files');
/** The stored images and leftover temporaries right now. */
const stored = () => ({
  files: existsSync(filesDir) ? readdirSync(filesDir).filter((n) => n.endsWith('.webp')).length : 0,
  temp: existsSync(join(filesDir, '.tmp')) ? readdirSync(join(filesDir, '.tmp')).length : 0,
});
const child = spawn(process.execPath, ['src/main.ts'], {
  cwd: serverDir,
  env: {
    PATH: process.env.PATH,
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
    AZ_BACKEND_PUBLIC_URL: serverUrl, AZ_PORT: String(serverPort), AZ_ALLOWED_ORIGINS: host.url,
    AZ_SQLITE_PATH: join(serverDir, 'data/test.db'),
    AZ_FILES_DIR: filesDir,
    AZ_EMAIL_FROM: 'Notebook <no-reply@notebook.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: String(smtp.port),
    // One admin per signed-in browser, and a listed address nobody verifies.
    AZ_ADMIN_EMAILS: [...BROWSERS.map((b) => adminEmail(b)), ...BROWSERS.map((b) => `unverified-${b}@notebook.test`)].join(','),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
progress.children = [child];
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

/** Upload bytes through the page's own typed client, as a file input's File would be sent. */
const uploadVia = (page, id, bytes) => page.evaluate(async ([i, b]) => {
  await new Promise((r) => { const t = setInterval(() => { if (globalThis.azData) { clearInterval(t); r(); } }, 20); });
  return globalThis.azData.notes.upload(i, 'photo', new Blob([new Uint8Array(b)], { type: 'image/jpeg' }));
}, [id, [...bytes]]);

/**
 * Images through the typed client (data-spec §8, §13): a phone photo stored
 * rotated and without its location, shown by an <img> on the site's own page
 * across origins, served with the §8 headers; renamed SVG refused; another
 * account refused; deleting the row removes the file.
 */
async function imageFlow(name, owner, other) {
  const made = await use(owner, 'create', { title: `${name} with photo` });
  const up = await uploadVia(owner, made.item.id, await phoneJpeg(640, 320, 6));
  check(`${name}: the owner uploads a phone photo; it comes back rotated, as { url, width, height }`,
    up.ok === true && up.item.photo?.width === 320 && up.item.photo?.height === 640 && up.item.photo.url.startsWith(`${serverUrl}/data/notes/`), JSON.stringify(up).slice(0, 200));
  const res = await fetch(up.item.photo.url);
  const bytes = Buffer.from(await res.arrayBuffer());
  check(`${name}: the stored image carries no EXIF, GPS, XMP, ICC or comment`, res.ok && metadataFindings(bytes).length === 0, metadataFindings(bytes).join(', '));
  const h = Object.fromEntries(['content-type', 'x-content-type-options', 'content-security-policy', 'cache-control', 'cross-origin-resource-policy', 'content-disposition'].map((k) => [k, res.headers.get(k)]));
  check(`${name}: served with the §8 headers`, JSON.stringify(h) === JSON.stringify({
    'content-type': 'image/webp', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'public, max-age=31536000, immutable', 'cross-origin-resource-policy': 'cross-origin', 'content-disposition': 'inline',
  }), JSON.stringify(h));
  await owner.reload();
  const img = owner.locator(`img[alt="Photo for ${name} with photo"]`);
  await img.waitFor();
  await owner.waitForFunction((alt) => { const i = document.querySelector(`img[alt="${alt}"]`); return i?.complete && i.naturalWidth > 0; }, `Photo for ${name} with photo`);
  check(`${name}: the site's page shows it with an <img> from the server's origin`, await img.evaluate((i) => i.naturalWidth === 320 && i.naturalHeight === 640));
  // A `from` gallery (data-spec §10): one image per row that has one, sized from the row.
  await owner.goto(`${host.url}/photos`);
  const gallery = await settled(owner, 'gallery');
  const shown = owner.locator('section.az-gallery [data-az-from-rows] img');
  await owner.waitForFunction(() => [...document.querySelectorAll('section.az-gallery [data-az-from-rows] img')].every((i) => i.complete && i.naturalWidth > 0));
  const pics = await shown.evaluateAll((is) => is.map((i) => ({ alt: i.alt, w: i.getAttribute('width'), h: i.getAttribute('height'), nw: i.naturalWidth, src: i.src })));
  check(`${name}: a from gallery shows the row's image — sized from the row, alt from its title; rows without one are not shown`,
    gallery.state === 'rows' && pics.length === 1 && pics[0].alt === `${name} with photo` && pics[0].w === '320' && pics[0].h === '640'
      && pics[0].nw === 320 && pics[0].src === up.item.photo.url, JSON.stringify({ gallery, pics }));
  const galleryAxe = await axeViolations(owner);
  check(`${name}: axe finds nothing on the from gallery`, galleryAxe.length === 0, galleryAxe.join(', '));
  await owner.goto(`${host.url}/notes`);
  const svg = await uploadVia(owner, made.item.id, SVG);
  check(`${name}: an SVG sent as a photo is refused as unsupported_type`, svg.ok === false && svg.code === 'unsupported_type' && svg.field === 'photo', JSON.stringify(svg));
  const theirs = await uploadVia(other, made.item.id, await plainJpeg(20, 20));
  check(`${name}: another account's upload to the row is not_found`, theirs.ok === false && theirs.code === 'not_found', JSON.stringify(theirs));
  const before = stored();
  await use(owner, 'remove', made.item.id);
  const after = stored();
  const gone = await fetch(up.item.photo.url);
  check(`${name}: deleting the row removes its file; the url is then not_found`, after.files === before.files - 1 && after.temp === 0 && gone.status === 404, `${JSON.stringify(before)} → ${JSON.stringify(after)}, ${gone.status}`);
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
  return result.violations.map((v) => `${v.id}×${v.nodes.length} at ${v.nodes[0]?.target.join(' ')}: ${v.nodes[0]?.failureSummary?.replace(/\s+/g, ' ').slice(0, 160)}`);
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

  // The image field: saved on its own, at once — upload, refused type, replace, remove.
  const photoInput = page.locator('#az-admin-notes-photo');
  /** The image requests the page made, with what the server answered — named when a preview does not show. */
  const imageAnswers = [];
  page.on('response', (r) => { if (r.request().resourceType() === 'image') imageAnswers.push(`${r.status()} ${r.headers()['content-type'] ?? ''} ${r.headers()['cross-origin-resource-policy'] ?? ''}`); });
  page.on('requestfailed', (r) => { if (r.resourceType() === 'image') imageAnswers.push(`failed: ${r.failure()?.errorText}`); });
  await photoInput.setInputFiles({ name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: await phoneJpeg(400, 200, 6) });
  await page.getByText('Photo saved.').waitFor();
  const preview = page.locator('img.az-admin-preview[alt="The current photo"]');
  const shown = await page.waitForFunction(() => { const i = document.querySelector('img.az-admin-preview'); return i?.complete && i.naturalWidth > 0; }, null, { timeout: 10_000 })
    .then(() => true, () => false);
  // What the browser got, named on failure: the preview's address, and the same address fetched with the cookie.
  const probe = await page.evaluate(async () => {
    const i = document.querySelector('img.az-admin-preview');
    if (!i) return 'no preview';
    const r = await fetch(i.src, { credentials: 'include' }).catch((e) => ({ status: String(e), headers: new Headers() }));
    return `${i.src} complete=${i.complete} natural=${i.naturalWidth}x${i.naturalHeight} fetch=${r.status} ${r.headers.get('content-type')}`;
  }) + ` img: ${imageAnswers.join(', ')}`;
  const first = (await preview.getAttribute('src').catch(() => null)) ?? '';
  check(`${name} admin: an uploaded photo previews (rotated, from the admin route)`,
    shown && /natural=200x400/.test(probe) && first.startsWith(`${serverUrl}/admin/data/notes/`), probe);
  const imageAxe = await axeViolations(page);
  check(`${name} admin: axe finds nothing with the image field and its preview`, imageAxe.length === 0, imageAxe.join(', '));
  await photoInput.setInputFiles({ name: 'vector.jpg', mimeType: 'image/jpeg', buffer: SVG });
  await page.getByText('Photo is not a supported file type.').waitFor();
  check(`${name} admin: an SVG named .jpg is refused with the field's sentence; focus on the file input`,
    await photoInput.evaluate((el) => document.activeElement === el && el.getAttribute('aria-invalid') === 'true'));
  await photoInput.setInputFiles({ name: 'other.png', mimeType: 'image/jpeg', buffer: await plainJpeg(300, 100) });
  await page.waitForFunction((old) => { const i = document.querySelector('img.az-admin-preview'); return i && i.getAttribute('src') !== old && i.complete && i.naturalWidth === 300; }, first);
  const replacedOld = await page.evaluate(async (u) => (await fetch(u, { credentials: 'include' })).status, first);
  check(`${name} admin: replacing shows the new image; the old one is gone (404)`, replacedOld === 404, String(replacedOld));
  await page.getByRole('button', { name: 'Remove photo' }).click();
  await page.getByText('Photo removed.').waitFor();
  check(`${name} admin: Remove clears it; no preview remains`, (await preview.count()) === 0 && (await use(owner, 'get', target.item.id)).item?.photo === null);
  await photoInput.setInputFiles({ name: 'keep.jpg', mimeType: 'image/jpeg', buffer: await plainJpeg(64, 64) });
  await page.getByText('Photo saved.').waitFor();

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
  // Judged once the enter transition has finished: mid-fade, axe measures
  // the half-transparent colours, not the ones a person reads.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#az-admin-confirm')).opacity === '1');
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
  check(`${name} admin: the deleted row's image file went with it`, stored().files === 0 && stored().temp === 0, JSON.stringify(stored()));

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
  closed = (await closeWithin(ctx, CLOSE_MS, `${name} context.close`)) && closed;
}

/* ---- from <table> in blocks (data-spec §10, D4) -------------------------- */

/** A note title that is markup: it must arrive as text, in every browser. */
const PAYLOAD = '<img src=x onerror="window.azXss=1">Bold <b>claim</b>';
const SEEDED = ['First seeded note', PAYLOAD];
const QUESTIONS = [
  ['How long does it take?', 'About a week.\n\nSometimes two,\nif the post is slow.'],
  ['Can I change my order?', 'Yes, until it ships.'],
  ['Do you ship abroad?', 'To most countries.'],
];

/** POST a row as the signed-in page: the browser's own cookie, CORS and CSRF header. */
const insert = (page, table, body) => page.evaluate(async ([base, t, b]) => (await fetch(`${base}/data/${t}`, {
  method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-az-request': '1' },
  body: JSON.stringify(b),
})).status, [serverUrl, table, body]);

/** One block's `from` shell on the page, by the word it sits in. */
const fromHost = (page, word) => page.locator(`section.az-${word} [data-az-from]`);

/** Wait until a block leaves loading, then read its state, status line and controls. */
async function settled(page, word) {
  await page.waitForFunction((w) => {
    const el = document.querySelector(`section.az-${w} [data-az-from]`);
    return el !== null && el.getAttribute('data-az-from-state') !== 'loading';
  }, word);
  return fromHost(page, word).evaluate((el) => {
    const signin = el.querySelector('[data-az-from-signin]');
    return {
      state: el.getAttribute('data-az-from-state'),
      busy: el.getAttribute('aria-busy'),
      status: el.querySelector('[data-az-from-status]')?.textContent ?? '',
      skeletonHidden: el.querySelector('[data-az-from-skeleton]')?.hidden === true,
      retry: el.querySelector('[data-az-from-retry]')?.hidden === false,
      signin: signin && !signin.hidden ? signin.getAttribute('href') : null,
    };
  });
}

/**
 * Seed the board once, as a signed-in account: two notes (one an HTML
 * payload) and three questions. The server allows ten sign-ups an hour from
 * one address, and the flows below already use them, so the first browser's
 * owner seeds.
 */
async function seedBoard(page) {
  const made = [];
  for (const [i, title] of SEEDED.entries()) {
    made.push(await insert(page, 'notes', { title, body: i === 0 ? 'One paragraph.\n\nAnd a second,\nwith a break.' : null }));
  }
  for (const [question, answer] of QUESTIONS) made.push(await insert(page, 'questions', { question, answer }));
  check('from: the board is seeded through the API as a signed-in account', made.every((s) => s === 201), made.join(' '));
}

/** Signed out, in one browser: the shell without JS, rows, FAQ, empty, error + retry, mine. */
async function fromSignedOut(b, name) {
  // The shell as it ships: no rows in the HTML, a skeleton, the noscript line.
  if (name === 'chromium') {
    const html = await (await fetch(`${host.url}/board/`)).text();
    check('from: /board ships a shell — skeleton, busy, noscript line, no row in the HTML',
      html.includes('data-az-from-skeleton') && html.includes('aria-busy="true"') && html.includes('Turn on JavaScript to load this list.')
        && !html.includes('First seeded note') && !html.includes('How long does it take?'), String(html.length));
  }
  const off = await b.newContext({ javaScriptEnabled: false });
  const still = await off.newPage();
  await still.goto(`${host.url}/board`);
  const noscript = await still.locator('.az-from-noscript').first().isVisible();
  const skeletonShown = await still.locator('section.az-feature [data-az-from-skeleton]').isVisible();
  check(`${name} from: without JavaScript the skeleton and the noscript line show`, noscript && skeletonShown);
  await off.close();

  const ctx = await b.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name} from: ${e.message}`));
  // A hydration mismatch is a console error, not a page error: React
  // recovers by rendering again, which the rows runtime must not cause.
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(`${host.url}/board`);
  const feature = await settled(page, 'feature');
  const faq = await settled(page, 'faq');
  check(`${name} from: the board hydrates and fills with no console error`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  check(`${name} from: public rows load for a signed-out visitor; not busy; skeleton hidden`,
    feature.state === 'rows' && faq.state === 'rows' && feature.busy === 'false' && feature.skeletonHidden && faq.skeletonHidden,
    JSON.stringify({ feature, faq }));
  const items = page.locator('section.az-feature [data-az-from-rows] .az-feature-item');
  const titles = await items.locator('.az-feature-item-title').allTextContents();
  check(`${name} from: each row is the word's own item, its title as text`, SEEDED.every((t) => titles.includes(t)), titles.join(' | '));
  const xss = await page.evaluate(() => ({
    ran: 'azXss' in window,
    img: document.querySelectorAll('[data-az-from-rows] img, [data-az-from-rows] b').length,
  }));
  check(`${name} from: an HTML payload in a row stays text — no element made, nothing ran`, !xss.ran && xss.img === 0, JSON.stringify(xss));
  const first = items.filter({ hasText: 'First seeded note' });
  const paras = await first.locator('.az-feature-item-text').evaluateAll((ps) => ps.map((p) => ({ text: p.textContent, br: p.querySelectorAll('br').length })));
  check(`${name} from: a longtext keeps its paragraphs and line breaks, as elements not markup`,
    paras.length === 2 && paras[0].text === 'One paragraph.' && paras[1].br === 1, JSON.stringify(paras));
  const payloadRow = items.filter({ hasText: 'Bold' });
  check(`${name} from: a row whose optional field is empty has no text paragraph`, await payloadRow.locator('.az-feature-item-text').count() === 0);

  const questions = page.locator('section.az-faq [data-az-from-rows] .az-faq-item');
  const asked = await questions.locator('.az-faq-toggle').allTextContents();
  check(`${name} from: the faq shows the three questions in order`, JSON.stringify(asked) === JSON.stringify(QUESTIONS.map((q) => q[0])), asked.join(' | '));
  const toggle = questions.first().locator('.az-faq-toggle');
  check(`${name} from: faq rows arrive collapsed by the behaviour runtime`, await toggle.getAttribute('aria-expanded') === 'false');
  await toggle.click();
  const panel = page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
  check(`${name} from: a faq row opens; its answer keeps its paragraphs`,
    await toggle.getAttribute('aria-expanded') === 'true' && await panel.isVisible() && await panel.locator('p').count() === 2);
  const duplicates = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[id]')].map((e) => e.id);
    return all.length - new Set(all).size;
  });
  check(`${name} from: every id on the page is unique (each row's are suffixed)`, duplicates === 0, String(duplicates));
  await toggle.click();
  // No layout jump: the faq skeleton (limit 3) is the height of three closed rows.
  const heights = await page.evaluate(() => {
    const el = document.querySelector('section.az-faq [data-az-from]');
    const skeleton = el.querySelector('[data-az-from-skeleton]');
    const rows = el.querySelector('[data-az-from-rows]');
    skeleton.hidden = false;
    const s = skeleton.getBoundingClientRect().height;
    skeleton.hidden = true;
    return { skeleton: s, rows: rows.getBoundingClientRect().height };
  });
  check(`${name} from: the faq skeleton is as tall as the rows that replace it`, Math.abs(heights.skeleton - heights.rows) <= 1, JSON.stringify(heights));
  const boardAxe = await axeViolations(page);
  check(`${name} from: axe finds nothing on the board with its rows`, boardAxe.length === 0, boardAxe.join(', '));

  // The empty copy, politely.
  await page.goto(`${host.url}/quotes`);
  const quotes = await settled(page, 'feature');
  check(`${name} from: no rows shows the block's empty copy, nothing to retry`,
    quotes.state === 'empty' && quotes.status === 'Nothing quoted yet' && !quotes.retry, JSON.stringify(quotes));
  const emptyAxe = await axeViolations(page);
  check(`${name} from: axe finds nothing in the empty state`, emptyAxe.length === 0, emptyAxe.join(', '));

  // An error and a retry that recovers: the API unreachable, then back.
  const blocked = `${serverUrl}/data/notes**`;
  await page.route(blocked, (r) => r.abort());
  await page.goto(`${host.url}/board`);
  const failed = await settled(page, 'feature');
  check(`${name} from: an unreachable API shows one fixed line and Try again`,
    failed.state === 'error' && failed.status === 'This list could not load. Check the connection, then try again.' && failed.retry, JSON.stringify(failed));
  const errorAxe = await axeViolations(page);
  check(`${name} from: axe finds nothing in the error state`, errorAxe.length === 0, errorAxe.join(', '));
  await page.unroute(blocked);
  await fromHost(page, 'feature').getByRole('button', { name: 'Try again' }).click();
  const recovered = await settled(page, 'feature');
  const focused = await fromHost(page, 'feature').evaluate((el) => document.activeElement === el);
  check(`${name} from: Try again loads the rows; focus stays on the block, not the page`, recovered.state === 'rows' && focused, JSON.stringify(recovered));

  // `mine`, signed out: the empty copy and the way to sign in.
  await page.goto(`${host.url}/mine`);
  const mine = await settled(page, 'feature');
  check(`${name} from: mine signed out says so and links to sign in`,
    mine.state === 'signin' && mine.status === 'Sign in to see your notes' && mine.signin === '/login', JSON.stringify(mine));
  const signinAxe = await axeViolations(page);
  check(`${name} from: axe finds nothing in the sign-in state`, signinAxe.length === 0, signinAxe.join(', '));
  closed = (await closeWithin(ctx, CLOSE_MS, `${name} from context.close`)) && closed;
}

/**
 * Signed in: `mine` lists exactly the rows the API says are the visitor's —
 * and not a row another account made — on a page and behind <Protected>,
 * whose content arrives after the session check (late content).
 */
async function fromSignedIn(page, name) {
  await page.goto(`${host.url}/notes`);
  const own = await use(page, 'create', { title: `${name} own note` });
  const mineRows = await use(page, 'list', { mine: true, sort: 'created' });
  const everyone = await use(page, 'list', { sort: 'created' });
  const expected = mineRows.ok ? mineRows.items.map((n) => n.title) : [];
  const foreign = everyone.ok ? everyone.items.filter((n) => !n.mine).map((n) => n.title) : [];
  for (const route of ['/mine', '/private']) {
    await page.goto(`${host.url}${route}`);
    const state = await settled(page, 'feature');
    const titles = await page.locator('section.az-feature [data-az-from-rows] .az-feature-item-title').allTextContents();
    check(`${name} from: ${route} signed in lists exactly this account's rows`,
      own.ok === true && state.state === 'rows' && titles.includes(`${name} own note`)
        && JSON.stringify([...titles].sort()) === JSON.stringify([...expected].sort()) && !titles.some((t) => foreign.includes(t)),
      `${JSON.stringify(state)} ${titles.join(' | ')}`);
  }
  // The first browser's owner seeded the board, so only a later browser has another account's rows to leave out.
  if (name !== 'chromium') {
    check(`${name} from: some public row belongs to another account, so mine filtered something`, foreign.length > 0, String(foreign.length));
  }
  await page.goto(`${host.url}/notes`);
  await use(page, 'remove', own.item.id);
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
      if (name === 'webkit') {
        await fromSignedOut(b, name);
        continue;
      }

      const ownerCtx = await b.newContext();
      const owner = await ownerCtx.newPage();
      owner.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await signUp(owner, `Ada${name}`);
      await owner.goto(`${host.url}/notes`);
      if (name === 'chromium') await seedBoard(owner);
      await fromSignedOut(b, name);
      await fromSignedIn(owner, name);
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
      await imageFlow(name, owner, other);
      await adminFlow(b, name, owner);
    } finally {
      closed = (await closeWithin(b, CLOSE_MS, `${name}.close`)) && closed;
    }
  }
  check('no page errors in any browser', errors.length === 0, errors.slice(0, 2).join(' | '));
  check('the server logged no private value', !serverLog.includes(SECRET_CONTACT) && !serverLog.includes(PASSWORD), serverLog.slice(0, 200));
  check('no image file outlived its row: the files folder is empty, no temporary left', stored().files === 0 && stored().temp === 0, JSON.stringify(stored()));
} finally {
  child.kill('SIGTERM');
  host.close();
  smtp.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
if (failures === 0) rmSync(work, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
run.clear();
// A browser that would not close is still running: ending the process is
// what kills it (Playwright kills what it launched on exit).
if (!closed) process.exit();
