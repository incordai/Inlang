/**
 * The chat setup, end to end in real browsers (chat-block-spec §19.15): the
 * smallest public chat site — `backend` with `database` and `model default`
 * only, no `auth`, no `email`, no sign-in page — built by the real CLI and
 * served as it ships, its generated server started with the `fake` model and
 * no map archive of its own.
 *
 *     pnpm test:chat        (after scripts/chat-e2e.mjs)
 *
 * In Chromium, Firefox and WebKit:
 *
 *   - #3: the build has no sign-in page and no auth runtime; the server keeps
 *     no accounts (every /auth path 404); signed out, the panel lets anyone
 *     ask, and the answer streams with no Content-Security-Policy violation;
 *   - #12: `show all` reached the server as every component (pricing too: a
 *     public page has a pricing block), and one answer draws a quote, an FAQ,
 *     a chart and a map;
 *   - #4: the map draws the default world basemap `az build` copied into the
 *     server — read by HTTP Range (206) from the backend, its credit under
 *     the map — and its picture is not a blank box: two colours, land and
 *     water, each cover a real share of the stage.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import sharp from 'sharp';
import { ROOT, buildSites } from './visual/pipeline.mjs';
import { closeWithin, watchdog, human } from './lib/bounded.mjs';
import { cspResult, violationControl, watchedContext } from './visual/csp.mjs';

/* Deadlines (lib/bounded.mjs): one site's build and three engines take a few minutes; 15 is several times that. */
const RUN_MS = 15 * 60_000;
const CLOSE_MS = 15_000;
const STATE_MS = 20_000;
const progress = { last: 'starting' };
const run = watchdog(RUN_MS, 'chat-public-e2e', progress);
console.log(`deadlines: run ${human(RUN_MS)} · state ${human(STATE_MS)} · close ${human(CLOSE_MS)}`);
let closed = true;
const csp = {};

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  progress.last = name;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

/** The smallest public chat, as issue #3 asked for it — plus `show all` (#12) and a public pricing page to quote. */
const SITE = `az 1
site beacon
  backend
    database sqlite
    model    default

page /
  hero center
    title "Beacon"
  chat panel
    title    "Ask Beacon"
    greeting "Ask about our lamps."
    show     all
    allow    anyone

page /pricing
  pricing cards
    title    "Plans"
    currency usd
    plan "Studio"
      monthly 12
      cta "Start" /pricing
`;

/** One answer with four components (an answer's most) of kinds `show all` brings: a quote, an FAQ, a chart and a coastal map (land and sea in view). */
const ANSWER = [
  'Here is everything at once.',
  'show pricing /pricing',
  'faq',
  '  item "Do you ship?"',
  '    text "Yes, everywhere."',
  'chart bar "Lamps by year"',
  '  point "2025" 500',
  '  point "2026" 700',
  'map "Our two shops"',
  '  pin "Lisbon" 38.722252 -9.139337',
  '  pin "Porto" 41.157944 -8.629105',
].join('\n');
const FAKE = { answers: [{ when: 'everything', chunks: [ANSWER], delayMs: 5 }, { chunks: ['A plain answer.'], delayMs: 5 }] };
/** What the bundled basemap credits (its data's own line, from the generator's pinned sources). */
const CREDIT = JSON.parse(readFileSync(join(ROOT, 'scripts/basemap/sources.json'), 'utf8')).attribution;
/** Every component an answer may hold, in core chat.ts's order: `show all` with a public pricing block. */
const ALL = ['pricing', 'faq', 'cta', 'feature', 'chart', 'table', 'stats', 'cards', 'dashboard', 'explore', 'map'];
const ENGINES = { chromium, firefox, webkit };

const freePort = () => new Promise((done) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

/** The built site, served as a static host serves it (an .mjs worker as JavaScript). */
function startSite(root) {
  const server = createHttpServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    for (const rel of extname(path) ? [path] : [join(path, 'index.html')]) {
      const file = normalize(join(root, rel));
      if (!file.startsWith(root + sep)) break;
      try {
        const body = await readFile(file);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type }).end(body);
        return;
      } catch { /* the next candidate */ }
    }
    res.writeHead(404).end();
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } })));
}

const work = mkdtempSync(join(tmpdir(), 'az-chat-public-e2e-'));
const serverPort = await freePort();
const backendUrl = `http://127.0.0.1:${serverPort}`;
process.env.AZ_PUBLIC_BACKEND_URL = backendUrl;
const site = { dir: join(work, 'beacon'), source: SITE };
await buildSites([site], work);
check('#3: the public chat site — no auth, no email, no sign-in pages — compiles and builds', Boolean(site.compiled && site.dist), site.error ?? '');
if (!site.dist) {
  console.log(`\n1 CHECK(S) FAILED — work dir kept: ${work}`);
  run.clear();
  process.exit(1);
}

const serverDir = join(site.proj, 'server');
{
  const pages = readdirSync(site.dist, { recursive: true }).filter((f) => String(f).endsWith('.html')).map(String).sort();
  check('#3: the build has no sign-in page — only the site\'s own pages and the shared-answer page', JSON.stringify(pages) === JSON.stringify(['chat/shared/index.html', 'index.html', 'pricing/index.html']), pages.join(' '));
  check('#3: the project has no auth config or session module — only the backend address check the build guard imports',
    JSON.stringify(readdirSync(join(site.proj, 'src/az-auth')).sort()) === JSON.stringify(['azbackend.ts', 'contract.ts', 'session.ts']));
  const config = JSON.parse(readFileSync(join(serverDir, 'az.config.json'), 'utf8'));
  check('#3: the server keeps no accounts: its config names no email', !('email' in config) && config.chat === true && config.map === true, JSON.stringify(config));
  const context = JSON.parse(readFileSync(join(serverDir, 'chat/context.json'), 'utf8'));
  check('#12: show all reached the server as every component, pricing included', JSON.stringify(context.chats['/']?.show) === JSON.stringify(ALL), JSON.stringify(context.chats['/']?.show));
  const basemap = join(serverDir, 'tiles/world.pmtiles');
  const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  check('#4: az build copied the default world basemap into the server', existsSync(basemap) && sha(basemap) === sha(join(ROOT, 'packages/backend/assets/basemap/world.pmtiles')));
}

const fakeFile = join(work, 'fake-model.json');
writeFileSync(fakeFile, JSON.stringify(FAKE));
const host = await startSite(normalize(site.dist));
// No AZ_MAP_WORLD and no AZ_MAP_ATTRIBUTION: the server draws the basemap the build copied, with its own credit. No mail key either.
const child = spawn(process.execPath, ['src/main.ts'], {
  cwd: serverDir,
  env: {
    PATH: process.env.PATH,
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
    AZ_BACKEND_PUBLIC_URL: backendUrl, AZ_PORT: String(serverPort), AZ_ALLOWED_ORIGINS: host.url,
    AZ_SQLITE_PATH: join(serverDir, 'data/test.db'),
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: fakeFile,
    AZ_CHAT_PER_ADDRESS: '500/hour',
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
  const poll = () => fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(2_000) }).then((r) => (r.ok ? done(true) : retry()), retry);
  poll();
});
check('#3: the generated server starts with no mail or session key, and #4 no map archive set', up, serverLog.trim().split('\n').slice(-3).join(' / '));

const browsers = [];
try {
  if (up) {
    for (const path of ['/auth/session', '/auth/providers']) {
      const r = await fetch(`${backendUrl}${path}`, { headers: { origin: host.url }, signal: AbortSignal.timeout(STATE_MS) });
      check(`#3: the server has no sign-in: ${path} is 404`, r.status === 404, String(r.status));
    }
    const served = await (await fetch(`${backendUrl}/tiles/map.json`, { headers: { origin: host.url }, signal: AbortSignal.timeout(STATE_MS) })).json();
    check('#4: map.json serves the bundled world to zoom 6, credited', JSON.stringify(served.archives) === JSON.stringify([{ name: 'world', minzoom: 0, maxzoom: 6 }])
      && served.attribution === CREDIT && served.glyphs === false, JSON.stringify(served));

    for (const [name, engine] of Object.entries(ENGINES)) {
      const b = await engine.launch();
      browsers.push(b);
      if (name === 'chromium') {
        const seen = await violationControl(b, `${host.url}/policy-control`, STATE_MS);
        check('CONTROL: the policy watch reports a page that breaks its own policy', seen.length > 0);
      }
      await engineFlow(b, name);
      await pixelFlow(b, name);
    }
  }
} catch (e) {
  check('the browser run completed', false, e.message.split('\n')[0]);
} finally {
  closed = (await Promise.all(browsers.map((b) => closeWithin(b, CLOSE_MS, `${b.browserType().name()}.close`)))).every(Boolean) && closed;
}

/** The colours of a PNG, quantised: the share of the picture each of its two commonest covers. */
async function twoColours(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = data.length / info.channels;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  return { first: top[0]?.[1] / total, second: (top[1]?.[1] ?? 0) / total, colours: counts.size, top: top.map(([k]) => k) };
}

async function engineFlow(b, name) {
  const ctx = await watchedContext(b, csp, {});
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(STATE_MS);
    const errors = [];
    // WebKit reports a resize observer that settles over more than one frame (the map library's, as the map is sized) as an
    // error event; it is the browser's notice that a frame was skipped, not a script failure, and the C8 suite meets it too.
    page.on('pageerror', (e) => { if (e.message !== 'ResizeObserver loop completed with undelivered notifications.') errors.push(e.message); });
    const ranges = [];
    ctx.on('response', (r) => { if (new URL(r.url()).pathname === '/tiles/world.pmtiles') ranges.push(r.status()); });
    await page.goto(`${host.url}/`);
    await page.waitForFunction(() => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === 'idle'
      && document.documentElement.hasAttribute('data-az-ready'), null, { timeout: STATE_MS });
    check(`${name}: #3 signed out, anyone may ask — no "Sign in to ask"`, !(await page.getByText('Sign in to ask').isVisible()));
    const input = page.locator('[data-az-chat] [data-az-chat-input]');
    await input.fill('Show me everything');
    await input.press('Enter');
    await page.waitForFunction(() => {
      const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
      const last = items[items.length - 1];
      const map = last?.querySelector('figure.az-chat-map')?.getAttribute('data-az-chat-map');
      return items.length > 1 && last.getAttribute('aria-busy') === 'false' && (map === 'ready' || map === 'list');
    }, null, { timeout: STATE_MS * 2 });
    const parts = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
      const last = items[items.length - 1];
      const m = last.querySelector('figure.az-chat-map');
      const slot = (n) => m?.querySelector(`[data-az-chat-slot="${n}"]`);
      return {
        quote: Boolean(last.querySelector('.az-chat-part .az-pricing')),
        faq: Boolean(last.querySelector('.az-chat-part .az-faq-item')),
        chart: Boolean(last.querySelector('figure.az-chat-figure svg[role="img"]')),
        map: m?.getAttribute('data-az-chat-map') ?? null,
        canvas: Boolean(slot('stage')?.querySelector('canvas')),
        attribution: slot('attribution') && !slot('attribution').hidden ? slot('attribution').textContent : null,
      };
    });
    check(`${name}: #12 one answer under show all draws a quote, an FAQ, a chart and a map`,
      parts.quote && parts.faq && parts.chart && parts.map !== null, JSON.stringify(parts));
    check(`${name}: #4 the map draws (not its list): a stage with the map's canvas, the basemap's credit under it`,
      parts.map === 'ready' && parts.canvas && parts.attribution === CREDIT, JSON.stringify(parts));
    check(`${name}: #4 the basemap is read from the backend by HTTP Range`, ranges.length > 0 && ranges.every((s) => s === 206), ranges.join(' '));
    check(`${name}: no page error (the browser's resize-observer notice aside)`, errors.length === 0, errors[0] ?? '');
  } catch (e) {
    check(`${name}: the flow completed`, false, e.message.split('\n')[0]);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} context close`)) && closed;
  }
}

/** Ask for the map, wait until it has drawn, and judge its stage's pixels — in a context whose policy is bypassed: WebKit's screenshot injects a stylesheet. */
async function pixelFlow(b, name) {
  const ctx = await b.newContext({ bypassCSP: true });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(STATE_MS);
    await page.goto(`${host.url}/`);
    await page.waitForFunction(() => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === 'idle'
      && document.documentElement.hasAttribute('data-az-ready'), null, { timeout: STATE_MS });
    const input = page.locator('[data-az-chat] [data-az-chat-input]');
    await input.fill('Show me everything');
    await input.press('Enter');
    await page.waitForFunction(() => {
      const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
      return items.length > 1 && items[items.length - 1].querySelector('figure.az-chat-map')?.getAttribute('data-az-chat-map') === 'ready';
    }, null, { timeout: STATE_MS * 2 });
    // Land and water each a real share of the picture — never one colour and a dot. Until the tiles have drawn, it is the bare background.
    const stage = page.locator('[data-az-chat-transcript] figure.az-chat-map [data-az-chat-slot="stage"]').last();
    let shot = await stage.screenshot();
    let c = await twoColours(shot);
    for (const until = Date.now() + STATE_MS; c.second < 0.1 && Date.now() < until;) {
      await page.waitForTimeout(250);
      shot = await stage.screenshot();
      c = await twoColours(shot);
    }
    writeFileSync(join(work, `map-${name}.png`), shot);
    check(`${name}: #4 the map is not a blank box — land and water each cover at least a tenth of it`, c.first >= 0.1 && c.second >= 0.1,
      `top two ${(c.first * 100).toFixed(1)}% ${(c.second * 100).toFixed(1)}% (${c.top.join(' | ')}), ${c.colours} colours`);
  } catch (e) {
    check(`${name}: the pixel flow completed`, false, e.message.split('\n')[0]);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} pixel context close`)) && closed;
  }
}

const violations = cspResult(Object.values(csp).flat());
check('no Content-Security-Policy violation in any engine', violations.pass, violations.detail);
check('the server\'s log is quiet: no failure line', !/failed|cannot start/.test(serverLog), serverLog.trim().split('\n').filter((l) => /failed|cannot/.test(l)).slice(0, 2).join(' / '));

child.kill('SIGTERM');
host.close();
if (failures === 0) rmSync(work, { recursive: true, force: true });
else console.log(`\nwork dir kept: ${work}\n--- server log ---\n${serverLog.slice(-1500)}`);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
run.clear();
if (!closed) process.exit();
