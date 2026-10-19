/**
 * The chat library's packages in real browsers (chat-block-spec §22): what
 * an app runs in its own webview, served here as an app's bundler would
 * serve it — each package's TypeScript with its types stripped, its `#name/`
 * aliases resolved to the package, no build step — on a page whose policy
 * allows its own scripts only.
 *
 *     pnpm test:chat-lib      (also the last part of pnpm test:chat)
 *
 * In Chromium, Firefox and WebKit:
 *
 *   - the answer checker (#33): every case of the injection corpus
 *     (packages/chat-answer/test/fixtures/chat-attacks/) read by
 *     createAnswerChecker, at once and in three pieces, becomes exactly the
 *     events, drops and history Node expects of it;
 *   - its Web Crypto history tags are the built-in server's tags, byte for
 *     byte (chat-text.ts over node:crypto), and a tampered answer's tag fails;
 *   - the instruction builder (#35): buildInstructions gives the text Node
 *     gives for the same app input — rules, content, tools, rows;
 *   - no Content-Security-Policy violation (with a CONTROL that the watch
 *     sees one), and no request leaves the page's own origin.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { closeWithin, human, watchdog, within } from './lib/bounded.mjs';
import { violationControl, watchedContext } from './visual/csp.mjs';
import { chunksOf, corpusCases, corpusRules } from '../packages/chat-answer/test/corpus.ts';
import { historyKey, tagTurn } from '../packages/backend/src/server/chat-text.ts';
import { buildInstructions } from '../packages/chat-instructions/src/instructions.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* Deadlines (lib/bounded.mjs): three engines take well under a minute; 5 is several times that. */
const RUN_MS = 5 * 60 * 1000;
const STEP_MS = 30_000;
const CLOSE_MS = 10_000;
const progress = { last: 'start' };
const run = watchdog(RUN_MS, 'chat-lib-e2e', progress);

/** The packages an app's page may load, by the alias name it imports them with. */
const PACKAGES = ['chat-answer', 'chat-instructions'];

/** The page's policy: its own scripts and requests only — no inline script or style, nothing from elsewhere. */
const POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${POLICY}" />
<title>Chat library</title><script type="module" src="/harness.js"></script></head>
<body><main id="root"><h1>Chat library</h1></main></body></html>`;

/** The page's script: the packages' entry points, called from the test by name. */
const HARNESS = `import { createAnswerChecker } from '/pkg/chat-answer/checker.ts';
import { webCryptoTags } from '/pkg/chat-answer/history-tag.ts';
import { buildInstructions } from '/pkg/chat-instructions/instructions.ts';

async function* stream(pieces) { for (const p of pieces) yield p; }
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

window.azLib = {
  async corpus(cases, options) {
    const out = [];
    for (const c of cases) {
      const runs = [];
      for (const pieces of c.runs) {
        let text = '';
        const blocks = [];
        let done = null;
        for await (const e of createAnswerChecker(options).read(stream(pieces))) {
          if (e.type === 'text') text += e.s;
          else if (e.type === 'block') blocks.push(e.block);
          else if (e.type === 'done') done = e;
        }
        runs.push({ text, blocks, dropped: done ? [...done.dropped] : null, history: done ? done.history : null });
      }
      out.push({ name: c.name, runs });
    }
    return out;
  },
  instructions(input) { return buildInstructions(input); },
  async tags(secret, items) {
    const t = await webCryptoTags(bytes(secret));
    const out = [];
    for (const i of items) {
      const tag = await t.tag(i.conversation, i.index, i.text);
      out.push({ tag, ok: await t.check(i.conversation, i.index, i.text, tag), tampered: await t.check(i.conversation, i.index, i.text + '!', tag) });
    }
    return out;
  },
};
document.documentElement.dataset.azReady = 'yes';
`;

/** A package source as a browser module: its types stripped, its `#name/` aliases pointed at the served package. */
function moduleOf(name, file) {
  const path = join(ROOT, 'packages', name, 'src', `${file}.ts`);
  if (!existsSync(path)) return null;
  const js = stripTypeScriptTypes(readFileSync(path, 'utf8'));
  return js.replace(/from '#([a-z-]+)\/([a-z0-9-]+\.ts)'/g, (m, alias, f) => (PACKAGES.includes(alias) ? `from '/pkg/${alias}/${f}'` : m));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE);
  if (url.pathname === '/harness.js') return send(200, 'text/javascript; charset=utf-8', HARNESS);
  const m = /^\/pkg\/([a-z-]+)\/([a-z0-9-]+)\.ts$/.exec(url.pathname);
  const js = m && PACKAGES.includes(m[1]) ? moduleOf(m[1], m[2]) : null;
  if (js !== null) return send(200, 'text/javascript; charset=utf-8', js);
  return send(404, 'text/plain; charset=utf-8', 'not found');
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const RULES = corpusRules();
const OPTIONS = { components: RULES.show, quotes: RULES.quotes, destinations: RULES.destinations, ...(RULES.presets ? { presets: RULES.presets } : {}) };
const CASES = corpusCases();
const SECRET = randomBytes(32);
const TAGGED = [
  { conversation: 'abcdefghijklmnop0123', index: 1, text: 'Hello.' },
  { conversation: 'abcdefghijklmnop0123', index: 3, text: 'Two lines\nof history — with ünïcode' },
];
const KEY = historyKey(SECRET);
/** An app's instructions input, with every part a question can add. */
const APP_INPUT = {
  appName: 'Acme', components: ['faq', 'chart', 'cta', 'map'], destinations: ['/contact'], geocoder: true, page: '/help', rows: '{"status":"paid"}', asked: ['Do you ship?'],
  tables: [{ name: 'orders', fields: [{ name: 'status', type: 'choice', choices: ['paid', 'open'] }] }],
  tools: [{ name: 'standings', label: 'Race results', about: '', params: {}, fields: { driver: 'text', points: 'number' } }],
  content: { site: { name: 'Acme', description: 'Lamps.' }, pages: [{ route: '/help', blocks: [{ block: 'faq', title: 'Questions', questions: [{ question: 'Do you ship?', answer: 'Yes.' }] }] }], notes: ['Ships in two days — ünïcode.'] },
  rules: { extra: ['Answer in English.'] },
};

const failures = [];
const check = (engine, what, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${engine.padEnd(8)} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(`${engine}: ${what}`);
};

const started = Date.now();
try {
  if (CASES.length < 15) throw new Error('the injection corpus was not found');
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    progress.last = `${name}: launch`;
    const browser = await within(STEP_MS, `${name} launch`, () => engine.launch());
    try {
      const control = await violationControl(browser, `${origin}/control`, STEP_MS);
      check(name, 'CONTROL: the policy watch reports a refused inline script', control.length > 0);
      const sinks = {};
      const ctx = await watchedContext(browser, sinks);
      const away = [];
      ctx.on('request', (r) => { if (!r.url().startsWith(`${origin}/`)) away.push(r.url().slice(0, 80)); });
      const page = await ctx.newPage();
      progress.last = `${name}: page`;
      await page.goto(`${origin}/`, { waitUntil: 'load', timeout: STEP_MS });
      await page.waitForFunction(() => document.documentElement.dataset.azReady === 'yes', null, { timeout: STEP_MS });

      progress.last = `${name}: corpus`;
      const sent = CASES.map((c) => ({ name: c.name, runs: [[c.answer], chunksOf(c.answer)] }));
      const got = await within(STEP_MS, `${name} corpus`, () => page.evaluate(([cases, options]) => window.azLib.corpus(cases, options), [sent, OPTIONS]));
      let matched = 0;
      for (const c of CASES) {
        const r = got.find((g) => g.name === c.name);
        const ok = r !== undefined && r.runs.length === 2 && r.runs.every((x) => isDeepStrictEqual(
          { text: x.text, blocks: x.blocks, dropped: x.dropped, ...(c.expect.history !== undefined ? { history: x.history } : {}) }, c.expect));
        if (ok) matched++;
        else check(name, `corpus ${c.name}: the events Node expects`, false, JSON.stringify(r?.runs[0] ?? null).slice(0, 200));
      }
      check(name, `the injection corpus through createAnswerChecker: ${matched} of ${CASES.length} cases, at once and in pieces`, matched === CASES.length);
      // CONTROL: the comparison can fail — the legal case under a chat that shows nothing keeps none of its components.
      const legal = CASES.find((c) => c.name === 'legal');
      const [bare] = await within(STEP_MS, `${name} control`, () => page.evaluate(([cases, options]) => window.azLib.corpus(cases, options),
        [[{ name: 'legal', runs: [[legal.answer]] }], { ...OPTIONS, components: [] }]));
      check(name, 'CONTROL: the same answer under a chat that shows nothing is not what the corpus expects', bare.runs[0].blocks.length === 0 && !isDeepStrictEqual(bare.runs[0].blocks, legal.expect.blocks));

      progress.last = `${name}: tags`;
      const tags = await within(STEP_MS, `${name} tags`, () => page.evaluate(([s, items]) => window.azLib.tags(s, items), [SECRET.toString('base64'), TAGGED]));
      check(name, 'Web Crypto history tags are the server\'s tags, byte for byte', tags.every((t, i) => t.tag === tagTurn(KEY, TAGGED[i].conversation, TAGGED[i].index, TAGGED[i].text)));
      check(name, 'a tag checks for its own answer, and a tampered answer\'s fails', tags.every((t) => t.ok === true && t.tampered === false));

      progress.last = `${name}: instructions`;
      const told = await within(STEP_MS, `${name} instructions`, () => page.evaluate((input) => window.azLib.instructions(input), APP_INPUT));
      check(name, 'buildInstructions gives the text Node gives for the same app input', told === buildInstructions(APP_INPUT) && told.includes('from tool'), told.slice(0, 80));

      check(name, 'no Content-Security-Policy violation', (sinks[name] ?? []).length === 0, (sinks[name] ?? []).join(' | '));
      check(name, 'no request leaves the page\'s origin', away.length === 0, away.join(' '));
      await closeWithin(ctx, CLOSE_MS, `${name} context.close`);
    } finally {
      await closeWithin(browser, CLOSE_MS, `${name} browser.close`);
    }
  }
} catch (e) {
  failures.push(`run: ${e instanceof Error ? e.message : String(e)}`);
  console.log(`FAIL  ${progress.last}: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await closeWithin(server, CLOSE_MS, 'server.close');
  run.clear();
}

console.log(`\nchat-lib-e2e: ${failures.length === 0 ? 'all passed' : `${failures.length} failed`} in ${human(Date.now() - started)}`);
process.exitCode = failures.length === 0 ? 0 : 1;
