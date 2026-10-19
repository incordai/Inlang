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
 *     water, each cover a real share of the stage;
 *   - #22, #23, #24 (chat-block-spec §19.17): a suggested question with an
 *     answer of its own (`use pricing`, a preset `show all` made) is drawn
 *     from the site with no model call; a typed question that clearly asks
 *     for an faq item is answered with it, under "Ask the AI instead",
 *     which asks the model;
 *   - the chat's UI (spec §19.18): #31 the suggested questions are pill chips
 *     in one sideways-scrolling row on a phone; with a dashboard, a pie and
 *     everything answered, at 320–1440 px no page overflow and no box whose
 *     text runs past it, the transcript at least 60% of the panel on a phone,
 *     the panel at 1440 centred and its title inside; #20 every stat's value
 *     whole and no stat beside a taller chart; #29 every chart's text 11 px
 *     or more, a pie 200 px across at most with its legend beside it where
 *     there is room, the tile chart's labels kept, a chart's values by
 *     keyboard (focus, arrows, End, Escape) and by pointer, a legend entry
 *     marking its slice; #28 the dots before the first words, the caret while
 *     they arrive, both gone at the end, messages moving in — none of it under
 *     reduced motion — the working state said once; #30 the answer's bar,
 *     faint at rest and plain when pointed at or on a touch screen, Copy's
 *     text, tooltips on focus; #21 a city's pins fitted past the basemap's
 *     zoom 6 with the no-street-detail note; axe in each new state; and, in
 *     Chromium, snapshots of the panel at five widths in both schemes, each
 *     drawn twice and byte-compared, written to .visual-out/chat-panel/.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
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
    ask      "What does it cost?" use pricing
    ask      "How bright is the desk lamp at night?"
    ask      "Does it ship abroad, and how long does it take?"
    ask      "Which bulb fits the large linen shade?"

page /help
  faq
    title "Questions"
    item "Do you ship abroad?"
      text "Yes, to most countries."
    item "Is there a warranty?"
      text "Two years on every lamp."
    item "Can I return a lamp?"
      text "Yes, within 30 days."

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
/** Issues #20, #29, #31: a dashboard whose stats sit beside charts, a three-digit money value among them ("$270.00"). */
const DASHBOARD = [
  'Here is the month.',
  'dashboard "This month"',
  '  stat "Orders" 12',
  '  stat "Revenue" 270 unit usd',
  '  chart bar "Orders by status"',
  '    point "paid" 7',
  '    point "open" 3',
  '    point "cancelled" 2',
  '  chart pie "Revenue by status"',
  '    point "paid" 190',
  '    point "open" 50',
  '    point "cancelled" 30',
].join('\n');
/** Issue #29: a pie on its own, in a single answer. */
const PIE = ['Here is the split.', 'chart pie "Revenue by plan"', '  point "Solo" 120', '  point "Team" 90', '  point "Business" 60'].join('\n');
/** Issue #21: two pins about 2 km apart in one city, and a walk between them. */
const CITY = [
  'Two places.',
  'map "Where to find us"',
  '  pin "Workshop" 52.520008 13.404954',
  '  pin "Shop" 52.5163 13.3777',
  '  route "Walk"',
  '    point 52.520008 13.404954',
  '    point 52.5163 13.3777',
].join('\n');
const FAKE = {
  answers: [
    { when: 'everything', chunks: [ANSWER], delayMs: 5 },
    { when: 'dashboard please', chunks: [DASHBOARD], delayMs: 5 },
    { when: 'a pie please', chunks: [PIE], delayMs: 5 },
    { when: 'the city map', chunks: [CITY], delayMs: 5 },
    // Issue #28: the first words come late, and the second later still — time to see the dots, then the caret.
    { when: 'take your time', chunks: ['Here is a considered answer. ', 'It took a moment.'], delayMs: 1500 },
    { chunks: ['A plain answer.'], delayMs: 5 },
  ],
};
/** What the bundled basemap credits (its data's own line, from the generator's pinned sources). */
const CREDIT = JSON.parse(readFileSync(join(ROOT, 'scripts/basemap/sources.json'), 'utf8')).attribution;
/** Every component an answer may hold, in core chat.ts's order: `show all` with a public pricing block. */
const ALL = ['pricing', 'faq', 'cta', 'feature', 'chart', 'table', 'stats', 'cards', 'dashboard', 'explore', 'map'];
const ENGINES = { chromium, firefox, webkit };
/** The panel widths the layout checks run at (issue #31), the narrowest chart text a visitor should read (#29), and where the panel's snapshots go. */
const WIDTHS = [320, 360, 390, 600, 768, 900, 1024, 1440];
const CHART_TEXT_MIN_PX = 11;
const PANEL_OUT = join(ROOT, '.visual-out/chat-panel');

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
  check('#3: the build has no sign-in page — only the site\'s own pages and the shared-answer page', JSON.stringify(pages) === JSON.stringify(['chat/shared/index.html', 'help/index.html', 'index.html', 'pricing/index.html']), pages.join(' '));
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
      await siteAnswerFlow(b, name);
      await pixelFlow(b, name);
      await layoutFlow(b, name);
      await workingFlow(b, name);
      await barFlow(b, name);
      await cityMapFlow(b, name);
      if (name === 'chromium') {
        // The snapshots' own Chromium, without partial raster (chat-e2e.mjs SNAP_ARGS says why: Send's corners came out two ways).
        const snap = await chromium.launch({ args: ['--disable-partial-raster'] });
        browsers.push(snap);
        await panelSnapshots(snap);
      }
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

/** The answer after the `before`-th, once it is no longer busy: whether it quotes pricing or an faq item, its prose, its buttons. */
async function settledAnswer(page, before) {
  await page.waitForFunction((n) => {
    const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
    return items.length > n && items[items.length - 1].getAttribute('aria-busy') === 'false';
  }, before, { timeout: STATE_MS });
  return page.evaluate(() => {
    const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
    const last = items[items.length - 1];
    return {
      quote: Boolean(last.querySelector('.az-chat-part .az-pricing')),
      faq: [...last.querySelectorAll('.az-chat-part .az-faq-item')].map((i) => i.textContent.trim().split('\n')[0]),
      prose: [...last.querySelectorAll(':scope > p')].map((p) => p.textContent).join(''),
      buttons: [...last.querySelectorAll('.az-chat-follows button')].map((x) => x.textContent),
    };
  });
}

/** §19.17: answers without the model — a suggested question's own, and a clear match with "Ask the AI instead". */
async function siteAnswerFlow(b, name) {
  const ctx = await watchedContext(b, csp, {});
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(STATE_MS);
    await page.goto(`${host.url}/`);
    await page.waitForFunction(() => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === 'idle'
      && document.documentElement.hasAttribute('data-az-ready'), null, { timeout: STATE_MS });
    const count = () => page.evaluate(() => document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site').length);
    const logBefore = serverLog.length;
    let before = await count();
    await page.locator('[data-az-chat] [data-az-chat-asks]').getByRole('button', { name: 'What does it cost?' }).click();
    const suggested = await settledAnswer(page, before);
    check(`${name}: #22 a suggested question with its own answer draws the site's pricing, and no model answer`,
      suggested.quote && suggested.prose === '' && suggested.buttons.length === 0, JSON.stringify(suggested));
    before = await count();
    const input = page.locator('[data-az-chat] [data-az-chat-input]');
    await input.fill('do you ship abroad');
    await input.press('Enter');
    const matched = await settledAnswer(page, before);
    check(`${name}: #24 a typed question that clearly asks for an faq item is answered with it, under Ask the AI instead`,
      matched.faq.length === 1 && matched.faq[0].includes('Do you ship abroad?') && JSON.stringify(matched.buttons) === JSON.stringify(['Ask the AI instead']), JSON.stringify(matched));
    before = await count();
    await page.locator('[data-az-chat-transcript] > .az-chat-message--site').last().getByRole('button', { name: 'Ask the AI instead' }).click();
    const instead = await settledAnswer(page, before);
    check(`${name}: #24 Ask the AI instead asks the model the same question`, instead.prose === 'A plain answer.' && instead.buttons.length === 0, JSON.stringify(instead));
    const said = serverLog.slice(logBefore);
    check(`${name}: the server logged the two answers it gave without the model, with no token spent`,
      /tokens 0\/0 site suggested/.test(said) && /tokens 0\/0 site match/.test(said) && !said.includes('ship abroad'), said.trim().split('\n').filter((l) => l.includes('chat:')).join(' / '));
  } catch (e) {
    check(`${name}: the site-answer flow completed`, false, e.message.split('\n')[0]);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} site-answer context close`)) && closed;
  }
}

/** Ask for the map, wait until it has drawn, and judge its stage's pixels — in a context whose policy is bypassed: WebKit's screenshot injects a stylesheet. */
async function pixelFlow(b, name) {
  const ctx = await b.newContext({ bypassCSP: true });
  // What this context asked of the basemap, and what went wrong, so a blank picture names its cause.
  const tiles = [];
  const trouble = [];
  ctx.on('response', (r) => { if (new URL(r.url()).pathname === '/tiles/world.pmtiles') tiles.push(`${r.request().headers().range ?? 'whole'} ${r.status()}`); });
  ctx.on('requestfailed', (r) => trouble.push(`${new URL(r.url()).pathname} ${r.failure()?.errorText ?? 'failed'}`));
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(STATE_MS);
    page.on('console', (m) => { if (m.type() === 'error') trouble.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => trouble.push(`pageerror: ${e.message.slice(0, 160)}`));
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
      `top two ${(c.first * 100).toFixed(1)}% ${(c.second * 100).toFixed(1)}% (${c.top.join(' | ')}), ${c.colours} colours; tiles [${tiles.join(', ')}]${trouble.length ? `; ${trouble.join(' | ')}` : ''}`);
  } catch (e) {
    check(`${name}: the pixel flow completed`, false, e.message.split('\n')[0]);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} pixel context close`)) && closed;
  }
}

/* ---- the chat UI issues #20, #21, #28, #29, #30, #31 (chat-block-spec §19.18) ---- */

/** The panel's runtime has decided who may ask, and the page is hydrated. */
function idle(page) {
  return page.waitForFunction(() => document.querySelector('[data-az-chat]')?.getAttribute('data-az-chat-state') === 'idle'
    && document.documentElement.hasAttribute('data-az-ready'), null, { timeout: STATE_MS });
}
/** Two frames painted: what the last change asked of layout (and a chart's redraw on resize) is on screen. */
function painted(page) {
  return page.waitForFunction(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))), null, { timeout: STATE_MS });
}
/** Ask `text` from the input and wait for its answer to finish — and its map, if it holds one, to settle. */
async function askFor(page, text) {
  const before = await page.evaluate(() => document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site').length);
  const input = page.locator('[data-az-chat] [data-az-chat-input]');
  await input.fill(text);
  await input.press('Enter');
  await page.waitForFunction((n) => {
    const items = document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site');
    const last = items[items.length - 1];
    if (items.length <= n || last.getAttribute('aria-busy') !== 'false') return false;
    const map = last.querySelector('figure.az-chat-map')?.getAttribute('data-az-chat-map');
    return map === undefined || map === 'ready' || map === 'list';
  }, before, { timeout: STATE_MS * 2 });
}
/** What the status region hears from now on (read with `said(page)`). */
function listen(page) {
  return page.evaluate(() => {
    const status = document.querySelector('[data-az-chat-status]');
    globalThis.azSaid = [];
    new MutationObserver(() => { if (status.textContent) globalThis.azSaid.push(status.textContent); }).observe(status, { childList: true, characterData: true, subtree: true });
  });
}
function said(page) {
  return page.evaluate(() => globalThis.azSaid ?? []);
}

/**
 * The panel as laid out now (issues #20, #29, #31): page overflow; every box
 * whose content runs past it (not a scroll container, not the map library's
 * own stage); each stat's value and card; the smallest chart text as drawn;
 * each pie's size and where its legend sits; any stat beside a taller chart;
 * the transcript's share of the panel; where the panel and its title are.
 */
function layoutOf(page) {
  return page.evaluate(layoutNow);
}
function layoutNow() {
  const panel = document.querySelector('.az-chat-panel');
  const box = (el) => el.getBoundingClientRect();
  const shown = (el) => el.getClientRects().length > 0 && !el.closest('[hidden]');
  const overflowing = [];
  for (const el of panel.querySelectorAll('*')) {
    if (el instanceof SVGElement || !shown(el) || el.closest('.az-chat-map-stage, .az-visually-hidden')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'inline' || cs.display === 'contents' || ['auto', 'scroll'].includes(cs.overflowX) || el.clientWidth <= 1) continue;
    if (el.scrollWidth > el.clientWidth + 1) overflowing.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.textContent ?? '').trim().slice(0, 24)}" ${el.scrollWidth}>${el.clientWidth}`);
  }
  // What sticks out of the page, deepest first: the cause of a page overflow, named.
  const page = document.documentElement.clientWidth;
  const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
  const deepest = [...document.body.querySelectorAll('*')].filter((el) => !(el instanceof SVGElement) && shown(el) && box(el).right > page + 1
    && ![...el.children].some((c) => box(c).right > page + 1));
  const outside = deepest.slice(0, 3).map((el) => `${name(el)} right ${Math.round(box(el).right)}`);
  // …and the first one's ancestors, each with its width: where the width came from.
  for (let el = deepest[0]?.parentElement; el && el !== document.body && outside.length < 12; el = el.parentElement) outside.push(`${name(el)} ${Math.round(box(el).width)}`);
  // The answers only: the hidden templates hold a card and a figure of each kind too.
  const transcript = panel.querySelector('[data-az-chat-transcript]');
  const stats = [...transcript.querySelectorAll('.az-chat-stat')].map((card) => {
    const value = card.querySelector('[data-az-chat-slot="value"]');
    return { text: value?.textContent ?? '', fits: card.scrollWidth <= card.clientWidth + 1 && (value ? value.scrollWidth <= value.clientWidth + 1 : true) };
  });
  const fonts = [...transcript.querySelectorAll('figure.az-chat-figure svg[role="img"]')].flatMap((svg) => {
    const scale = box(svg).width / svg.viewBox.baseVal.width;
    return [...svg.querySelectorAll('text')].map((t) => Number.parseFloat(getComputedStyle(t).fontSize) * scale);
  });
  const pies = [...transcript.querySelectorAll('figure.az-chat-figure')].filter((f) => /^Pie chart/.test(f.querySelector('[data-az-chat-slot="summary"]')?.textContent ?? '')).map((f) => {
    const svg = f.querySelector('svg[role="img"]');
    const slices = [...svg.querySelectorAll('path')].map(box).filter((r) => r.width > 0);
    const left = Math.min(...slices.map((r) => r.left));
    const right = Math.max(...slices.map((r) => r.right));
    const legend = f.querySelector('.az-chat-legend');
    const s = box(svg);
    const l = legend ? box(legend) : null;
    return { across: Math.round(right - left), beside: l !== null && l.left >= s.right - 1 && l.top < s.bottom, room: box(f).width };
  });
  // The dashboard's bar chart: how many of its three category labels are drawn.
  const barChart = [...transcript.querySelectorAll('figure.az-chat-figure')].find((f) => f.textContent.includes('Orders by status'));
  const categories = barChart ? [...barChart.querySelectorAll('svg[role="img"] text[text-anchor="middle"]')].map((t) => t.textContent) : [];
  const beside = [];
  for (const dash of panel.querySelectorAll('.az-chat-dashboard')) {
    for (const stat of dash.querySelectorAll('.az-chat-stat')) {
      for (const fig of dash.querySelectorAll('figure.az-chat-figure')) {
        const a = box(stat);
        const b = box(fig);
        if (a.top < b.bottom - 1 && b.top < a.bottom - 1 && b.height > a.height * 1.25) beside.push(`${Math.round(a.height)} beside ${Math.round(b.height)}`);
      }
    }
  }
  const p = box(panel);
  const section = box(panel.closest('section'));
  const style = getComputedStyle(panel.closest('section'));
  const inner = { left: section.left + Number.parseFloat(style.paddingLeft), right: section.right - Number.parseFloat(style.paddingRight) };
  return {
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, outside,
    overflowing, stats, fonts, pies, beside, categories,
    share: box(panel.querySelector('[data-az-chat-transcript]')).height / p.height,
    panel: { width: Math.round(p.width), off: Math.round(Math.abs((p.left - inner.left) - (inner.right - p.right))), title: Boolean(panel.querySelector('#az-chat-title')) },
  };
}

/** The suggested questions as laid out before a question: whether they share one row, scroll sideways, and stay in the panel. */
function chipsOf(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-az-chat-asks]');
    const chips = [...list.querySelectorAll('button')];
    const panel = document.querySelector('.az-chat-panel').getBoundingClientRect();
    return {
      count: chips.length, rows: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size, scrolls: getComputedStyle(list).overflowX,
      inside: chips.every((c) => c.getBoundingClientRect().right <= panel.right + 1) || getComputedStyle(list).overflowX === 'auto',
      radius: getComputedStyle(chips[0]).borderTopLeftRadius,
    };
  });
}

async function layoutFlow(b, name) {
  const ctx = await watchedContext(b, csp, { viewport: { width: 390, height: 844 } });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(STATE_MS);
    await page.goto(`${host.url}/`);
    await idle(page);
    // #31: before a question the suggested questions are small pills — one row that scrolls on a phone, wrapping on a wide panel.
    const phone = await chipsOf(page);
    check(`${name}: #31 at 390 the suggested questions are pill chips in one row that scrolls sideways`,
      phone.count === 4 && phone.rows === 1 && phone.scrolls === 'auto' && Number.parseFloat(phone.radius) >= 100, JSON.stringify(phone));
    await page.setViewportSize({ width: 1024, height: 900 });
    await painted(page);
    const wide = await chipsOf(page);
    check(`${name}: #31 at 1024 the chips wrap inside the panel`, wide.inside && wide.scrolls !== 'auto', JSON.stringify(wide));
    await page.setViewportSize({ width: 390, height: 844 });
    // §9: the visitor stays at the end, so the transcript follows every line an answer adds — its bar and its charts redrawn
    // at their own width too — and Jump to latest is not offered.
    const ends = [];
    for (const q of ['dashboard please', 'a pie please', 'Show me everything']) {
      await askFor(page, q);
      await painted(page);
      ends.push(await page.evaluate((asked) => {
        const t = document.querySelector('[data-az-chat-transcript]');
        return { asked, gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight), latest: document.querySelector('[data-az-chat-latest]').hidden };
      }, q));
    }
    check(`${name}: #28 #30 after each answer the transcript is at its end and offers no Jump to latest`, ends.every((e) => e.gap <= 24 && e.latest), JSON.stringify(ends));
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
      await painted(page);
      const l = await layoutOf(page);
      check(`${name} ${width}: #31 nothing runs past its box — no page overflow, no clipped text`, l.pageOverflow <= 0 && l.overflowing.length === 0,
        `page +${l.pageOverflow}px (${l.outside.join(', ')}); ${l.overflowing.slice(0, 4).join(' | ')}`);
      check(`${name} ${width}: #20 every stat's value fits its card ("$270.00" whole)`, l.stats.length === 2 && l.stats.every((s) => s.fits) && l.stats.some((s) => s.text === '$270.00'),
        JSON.stringify(l.stats));
      check(`${name} ${width}: #20 a dashboard's stats never sit beside a taller chart`, l.beside.length === 0, l.beside.join(', '));
      const smallest = Math.min(...l.fonts);
      check(`${name} ${width}: #29 every chart's text is drawn at ${CHART_TEXT_MIN_PX}px or more`, l.fonts.length > 0 && smallest >= CHART_TEXT_MIN_PX, `${l.fonts.length} texts, smallest ${smallest.toFixed(1)}px`);
      if (width >= 600) {
        check(`${name} ${width}: #29 the dashboard's bar chart, drawn at its tile's width, keeps all three category labels`,
          JSON.stringify(l.categories) === '["paid","open","cancelled"]', JSON.stringify(l.categories));
      }
      check(`${name} ${width}: #29 a pie is 200 px across at most, its legend beside it where there is room`,
        l.pies.length === 2 && l.pies.every((p) => p.across <= 201 && (p.room < 420 || p.beside)), JSON.stringify(l.pies));
      if (width <= 390) check(`${name} ${width}: #31 the transcript has at least 60% of the panel on a phone`, l.share >= 0.6, l.share.toFixed(2));
      if (width === 1440) {
        check(`${name} 1440: #31 the panel grows to a readable width, centred, its title inside it`, l.panel.width >= 700 && l.panel.off <= 2 && l.panel.title, JSON.stringify(l.panel));
      }
    }
    // #29: a chart's values by keyboard — focus, the arrow keys, End, Escape — each said in the status region.
    await page.setViewportSize({ width: 900, height: 900 });
    await painted(page);
    await listen(page);
    const bars = page.locator('[data-az-chat-transcript] figure.az-chat-figure', { hasText: 'Orders by status' }).locator('svg[role="img"]');
    await bars.focus();
    // The tooltip is the chart's last child: a group of a box and a line of text (the axis labels' group has no box).
    const tip = () => page.evaluate(() => {
      const svg = document.activeElement;
      const last = svg?.lastElementChild;
      const text = last?.querySelector(':scope > rect') ? last.querySelector(':scope > text') : null;
      const open = [...(svg?.querySelectorAll?.('[data-az-chat-mark][data-state="open"]') ?? [])].map((m) => m.getAttribute('data-az-chat-mark'));
      return { focused: svg?.tagName?.toLowerCase(), text: text?.textContent ?? null, open };
    });
    const first = await tip();
    await page.keyboard.press('ArrowRight');
    const second = await tip();
    await page.keyboard.press('End');
    const end = await tip();
    await page.keyboard.press('Escape');
    const gone = await tip();
    const heard = await said(page);
    check(`${name}: #29 by keyboard a chart shows each mark's label and value — focus, →, End — the mark marked, the status region told; Escape hides it`,
      first.focused === 'svg' && first.text === 'paid: 7' && JSON.stringify(first.open) === '["0"]' && second.text === 'open: 3' && JSON.stringify(second.open) === '["1"]'
      && end.text === 'cancelled: 2' && gone.text === null && gone.focused === 'svg' && ['paid: 7', 'open: 3', 'cancelled: 2'].every((t) => heard.some((h) => h.includes(t))),
      JSON.stringify({ first, second, end, gone, heard }));
    // A pointer over a bar shows it quietly; over a pie's legend entry, its slice is marked with it.
    // Hovered where it is: the transcript scrolls it into view first.
    await bars.locator('[data-az-chat-mark="1"]').hover();
    const hovered = await page.waitForFunction(() => [...document.querySelectorAll('figure.az-chat-figure svg[role="img"] g > text')].some((t) => t.textContent === 'open: 3'), null, { timeout: STATE_MS }).then(() => true, () => false);
    const entry = page.locator('[data-az-chat-transcript] figure.az-chat-figure', { hasText: 'Revenue by plan' }).locator('.az-chat-legend-item').nth(1);
    await entry.hover();
    const pointed = await page.evaluate(() => {
      const f = [...document.querySelectorAll('[data-az-chat-transcript] figure.az-chat-figure')].find((x) => x.textContent.includes('Revenue by plan'));
      return { entry: f.querySelectorAll('.az-chat-legend-item')[1].getAttribute('data-state'), marks: [...f.querySelectorAll('[data-az-chat-mark][data-state="open"]')].map((m) => m.getAttribute('data-az-chat-mark')) };
    });
    check(`${name}: #29 a pointer over a bar shows its value; over a legend entry, that slice and its entry are marked`,
      hovered && pointed.entry === 'open' && JSON.stringify(pointed.marks) === '["1"]', JSON.stringify({ hovered, pointed }));
  } catch (e) {
    check(`${name}: the layout flow completed`, false, e.message.split('\n')[0]);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} layout context close`)) && closed;
  }
}

/** Issue #28: the dots before the first words, the caret while words arrive, both gone at the end; messages move in — none of it under reduced motion. */
async function workingFlow(b, name) {
  for (const still of [false, true]) {
    const ctx = await watchedContext(b, csp, still ? { reducedMotion: 'reduce' } : {});
    const label = `${name}${still ? ' (reduced motion)' : ''}`;
    try {
      const page = await ctx.newPage();
      page.setDefaultTimeout(STATE_MS);
      await page.goto(`${host.url}/`);
      await idle(page);
      await listen(page);
      // Each message as it is added: whether it was moving as it came in.
      await page.evaluate(() => {
        globalThis.azAdded = [];
        new MutationObserver((records) => {
          for (const r of records) for (const n of r.addedNodes) {
            if (n instanceof Element && n.matches('.az-chat-message')) globalThis.azAdded.push({ site: n.matches('.az-chat-message--site'), moving: n.getAnimations().length > 0 });
          }
        }).observe(document.querySelector('[data-az-chat-transcript]'), { childList: true });
      });
      const input = page.locator('[data-az-chat] [data-az-chat-input]');
      await input.fill('take your time');
      await input.press('Enter');
      const last = '[data-az-chat-transcript] > .az-chat-message--site:last-child';
      await page.waitForFunction((sel) => {
        const item = document.querySelector(sel);
        return item !== null && item.querySelector('.az-chat-thinking') !== null;
      }, last, { timeout: STATE_MS });
      const waiting = await page.evaluate((sel) => {
        const item = document.querySelector(sel);
        const dots = item.querySelector('.az-chat-thinking');
        return {
          busy: item.getAttribute('aria-busy'), hidden: dots.getAttribute('aria-hidden'), seen: dots.getClientRects().length > 0, words: item.textContent.trim(),
          moving: dots.getAnimations({ subtree: true }).length > 0, alone: item.children.length === 1,
        };
      }, last);
      check(`${label}: #28 before the first words the answer's place holds the dots, alone — aria-hidden, ${still ? 'still' : 'pulsing'}`,
        waiting.busy === 'true' && waiting.hidden === 'true' && waiting.seen && waiting.words === '' && waiting.alone && waiting.moving === !still, JSON.stringify(waiting));
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('considered'), last, { timeout: STATE_MS });
      const streaming = await page.evaluate((sel) => {
        const item = document.querySelector(sel);
        return { dots: item.querySelector('.az-chat-thinking') !== null, caret: item.querySelector('p > .az-chat-caret:last-child') !== null, hidden: item.querySelector('.az-chat-caret')?.getAttribute('aria-hidden') ?? null };
      }, last);
      check(`${label}: #28 the first words take the dots' place; ${still ? 'no caret under reduced motion' : 'a caret ends the words while they arrive'}`,
        !streaming.dots && streaming.caret === !still && (still || streaming.hidden === 'true'), JSON.stringify(streaming));
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-busy') === 'false', last, { timeout: STATE_MS });
      const done = await page.evaluate((sel) => ({ caret: document.querySelector(sel).querySelector('.az-chat-caret') !== null, dots: document.querySelector(sel).querySelector('.az-chat-thinking') !== null }), last);
      check(`${label}: #28 the finished answer keeps neither the caret nor the dots`, !done.caret && !done.dots, JSON.stringify(done));
      const added = await page.evaluate(() => globalThis.azAdded);
      check(`${label}: #28 the question and its answer ${still ? 'appear at once' : 'move in as they are added'}`,
        added.length === 2 && added.every((a) => a.moving === !still), JSON.stringify(added));
      const heard = await said(page);
      check(`${label}: #28 the status region says once that the question is being answered, then the answer's sentences`,
        heard.filter((h) => h.includes('Answering your question.')).length === 1 && heard.some((h) => h.includes('It took a moment.')), JSON.stringify(heard));
      const stopped = await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: STATE_MS }).then(() => true, () => false);
      check(`${label}: #28 nothing is left moving once the answer is in`, stopped);
    } catch (e) {
      check(`${label}: the working flow completed`, false, e.message.split('\n')[0]);
    } finally {
      closed = (await closeWithin(ctx, CLOSE_MS, `${label} working context close`)) && closed;
    }
  }
}

/** Issue #30: the bar under a finished answer — last in it, faint until pointed at, Copy and Share by name, tooltips on hover and focus. */
async function barFlow(b, name) {
  const ctx = await watchedContext(b, csp, name === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(STATE_MS);
    await page.goto(`${host.url}/`);
    await idle(page);
    await askFor(page, 'a pie please');
    await page.mouse.move(0, 0);
    // The answer laid out and still (its chart redrawn for its width, the transcript at its end) before it is pointed at.
    await painted(page);
    const answer = page.locator('[data-az-chat-transcript] > .az-chat-message--site').last();
    const state = () => answer.evaluate((item) => {
      const bar = item.querySelector(':scope > .az-chat-bar');
      return {
        last: item.lastElementChild === bar, group: bar?.getAttribute('role'), name: bar?.getAttribute('aria-label'),
        buttons: [...(bar?.querySelectorAll('.az-chat-bar-button') ?? [])].map((x) => x.getAttribute('aria-label')),
        colour: bar ? getComputedStyle(bar).color : null, text: getComputedStyle(item.querySelector(':scope > p')).color,
        open: bar?.getAttribute('data-state') ?? null, big: [...item.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Share this answer'),
      };
    });
    const resting = await state();
    check(`${name}: #30 a finished answer ends with its bar — a named group of small buttons, Copy answer and Share this answer — and no full-size Share`,
      resting.last && resting.group === 'group' && resting.name === 'Answer actions' && JSON.stringify(resting.buttons) === '["Copy answer","Share this answer"]' && !resting.big,
      JSON.stringify(resting));
    // Pointed at inside the answer but not on the bar (whose own hover turns it too) — near its end, in view: an answer taller
    // than the transcript can have its middle scrolled out of sight.
    await answer.locator('.az-chat-summary').hover();
    // The colour eases over motion.fast: the settled colour is the one judged (bounded — a bar that never turns fails below).
    await page.waitForFunction(() => {
      const item = [...document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site')].at(-1);
      const bar = item.querySelector(':scope > .az-chat-bar');
      return bar.getAnimations().length === 0 && getComputedStyle(bar).color === getComputedStyle(item.querySelector(':scope > p')).color;
    }, null, { timeout: STATE_MS }).catch(() => undefined);
    const pointed = await state();
    check(`${name}: #30 the bar is faint at rest and the text's colour while its answer is pointed at`,
      resting.colour !== resting.text && pointed.open === 'open' && pointed.colour === pointed.text,
      JSON.stringify({ resting: resting.colour, pointed: pointed.colour, open: pointed.open, text: pointed.text }));
    // Focused without a pointer (WebKit's Tab skips buttons by default, so focus is put there): the tooltip shows; Escape hides it, focus kept.
    const copy = answer.getByRole('button', { name: 'Copy answer' });
    await copy.focus();
    const tipShown = await copy.evaluate((x) => x.parentElement.querySelector('[data-az-chat-tip]')?.hidden === false && document.activeElement === x);
    await page.keyboard.press('Escape');
    const tipGone = await copy.evaluate((x) => x.parentElement.querySelector('[data-az-chat-tip]')?.hidden === true && document.activeElement === x);
    check(`${name}: #30 a bar button's tooltip shows its name on keyboard focus; Escape hides it and focus stays`, tipShown && tipGone, JSON.stringify({ tipShown, tipGone }));
    await listen(page);
    await copy.click();
    progress.last = `${name}: #30 Copy clicked, waiting for the status region`;
    await page.waitForFunction(() => (globalThis.azSaid ?? []).some((s) => /Answer copied\.|Copy did not work/.test(s)), null, { timeout: STATE_MS });
    if (name === 'chromium') {
      const text = await page.evaluate(() => navigator.clipboard.readText());
      check(`${name}: #30 Copy puts the answer's words and its chart's text form on the clipboard — never its controls`,
        text.startsWith('Here is the split.') && text.includes('Revenue by plan') && /Solo\t\$?120/.test(text) && !text.includes('Show the figures as a table') && !text.includes('Copy answer'),
        JSON.stringify(text.slice(0, 300)));
    }
    const heard = await said(page);
    check(`${name}: #30 the status region says how Copy went`, heard.some((s) => /Answer copied\.|Copy did not work/.test(s)), JSON.stringify(heard));
    // Share opens today's share flow, from its small button.
    await answer.getByRole('button', { name: 'Share this answer' }).click();
    const create = answer.getByRole('button', { name: 'Create link' });
    check(`${name}: #30 Share opens the share flow under the bar`, await create.isVisible());
    await axe(page, `${name} answer bar`);
  } catch (e) {
    check(`${name}: the bar flow completed`, false, `${e.message.split('\n')[0]} (after "${progress.last}")`);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} bar context close`)) && closed;
  }
  // A touch screen has no hover: the bar is always plain there. (Firefox has no mobile emulation to ask for.)
  if (name === 'firefox') return;
  const touch = await watchedContext(b, csp, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await touch.newPage();
    page.setDefaultTimeout(STATE_MS);
    await page.goto(`${host.url}/`);
    await idle(page);
    await askFor(page, 'a pie please');
    const t = await page.evaluate(() => {
      const item = [...document.querySelectorAll('[data-az-chat-transcript] > .az-chat-message--site')].at(-1);
      const bar = item.querySelector(':scope > .az-chat-bar');
      return { open: bar?.getAttribute('data-state'), colour: getComputedStyle(bar).color, text: getComputedStyle(item.querySelector(':scope > p')).color, hover: matchMedia('(hover: none)').matches };
    });
    check(`${name}: #30 on a touch screen the bar is always fully visible`, t.hover && t.open === 'open' && t.colour === t.text, JSON.stringify(t));
  } catch (e) {
    check(`${name}: the touch bar flow completed`, false, e.message.split('\n')[0]);
  } finally {
    closed = (await closeWithin(touch, CLOSE_MS, `${name} touch context close`)) && closed;
  }
}

/** axe on the page as it is: zero violations. */
async function axe(page, label) {
  // The page at rest: a message fading in (issue #28) is not yet its colours; the working dots' endless pulse is aria-hidden.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    null, { timeout: STATE_MS });
  const r = await new AxeBuilder({ page }).analyze();
  check(`${label}: axe finds no violation`, r.violations.length === 0, r.violations.map((v) => `${v.id} (${v.nodes.length}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')})`).join(', '));
}

/** Issue #21: two pins 2 km apart in one city, on the bundled basemap alone — fitted past its tiles, told apart, said to have no street detail. */
async function cityMapFlow(b, name) {
  const ctx = await watchedContext(b, csp, {});
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(STATE_MS);
    page.on('pageerror', () => undefined);
    await page.goto(`${host.url}/`);
    await idle(page);
    await askFor(page, 'the city map');
    const m = await page.evaluate(() => {
      const f = [...document.querySelectorAll('[data-az-chat-transcript] figure.az-chat-map')].at(-1);
      const slot = (n) => f.querySelector(`[data-az-chat-slot="${n}"]`);
      return {
        state: f.getAttribute('data-az-chat-map'), zoomIn: slot('zoom-in')?.getAttribute('aria-disabled'), reset: slot('reset')?.getAttribute('aria-disabled'),
        detail: slot('detail') && !slot('detail').hidden ? slot('detail').textContent : null,
      };
    });
    check(`${name}: #21 a city's two pins on the bundled basemap open fitted past its zoom 6 — Zoom in still free, the fitted view Reset's — with the no-street-detail note`,
      m.state === 'ready' && m.zoomIn === 'false' && m.reset === 'true' && m.detail === 'This map has no street detail at this zoom.', JSON.stringify(m));
    await axe(page, `${name} city map`);
  } catch (e) {
    check(`${name}: the city map flow completed`, false, e.message.split('\n')[0]);
  } finally {
    closed = (await closeWithin(ctx, CLOSE_MS, `${name} city map context close`)) && closed;
  }
}

/**
 * Issue #31, in Chromium (gate item 3's engine): at 360, 390, 768, 1024 and
 * 1440 wide, in both schemes, the panel before a question (its chips), then
 * with a dashboard and a pie answered — the panel at the end, and each answer
 * whole (a tall window, so the transcript holds it). Each picture drawn twice
 * from a fresh page and byte-compared (the fake model makes it
 * deterministic), light and dark told apart, the PNGs written to
 * .visual-out/chat-panel/ for review.
 */
async function panelSnapshots(b) {
  mkdirSync(PANEL_OUT, { recursive: true });
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  const still = async (page) => {
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: STATE_MS });
    await painted(page);
  };
  const shots = async (width, scheme) => {
    const ctx = await watchedContext(b, csp, { viewport: { width, height: 2000 }, colorScheme: scheme, reducedMotion: 'reduce' });
    try {
      const page = await ctx.newPage();
      page.setDefaultTimeout(STATE_MS);
      await page.goto(`${host.url}/`);
      await idle(page);
      await still(page);
      const out = { chips: await page.locator('.az-chat-panel').screenshot({ animations: 'disabled', caret: 'hide' }) };
      await askFor(page, 'dashboard please');
      await askFor(page, 'a pie please');
      await still(page);
      const answers = page.locator('[data-az-chat-transcript] > .az-chat-message--site');
      out.dashboard = await answers.nth(1).screenshot({ animations: 'disabled', caret: 'hide' });
      out.pie = await answers.nth(2).screenshot({ animations: 'disabled', caret: 'hide' });
      out.panel = await page.locator('.az-chat-panel').screenshot({ animations: 'disabled', caret: 'hide' });
      return out;
    } finally {
      closed = (await closeWithin(ctx, CLOSE_MS, `panel snapshot ${width} ${scheme} close`)) && closed;
    }
  };
  const unstable = [];
  const alike = [];
  let count = 0;
  for (const width of [360, 390, 768, 1024, 1440]) {
    const byScheme = {};
    for (const scheme of ['light', 'dark']) {
      const first = await shots(width, scheme);
      const second = await shots(width, scheme);
      for (const [state, png] of Object.entries(first)) {
        if (sha(png) !== sha(second[state])) {
          unstable.push(`${width} ${scheme} ${state}`);
          writeFileSync(join(PANEL_OUT, `${state}-${width}-${scheme}.second.png`), second[state]);
        }
        writeFileSync(join(PANEL_OUT, `${state}-${width}-${scheme}.png`), png);
        count++;
      }
      byScheme[scheme] = first;
    }
    for (const state of Object.keys(byScheme.light)) if (sha(byScheme.light[state]) === sha(byScheme.dark[state])) alike.push(`${state} ${width}`);
  }
  check('#31 panel snapshots: before a question, each answer and the answered panel, at 360, 390, 768, 1024 and 1440, render byte-identically twice in each scheme', unstable.length === 0, unstable.join(', '));
  check('#31 panel snapshots: light and dark differ in every picture', alike.length === 0, alike.join(', '));
  console.log(`panel snapshots: ${count} PNGs in ${PANEL_OUT}`);
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
