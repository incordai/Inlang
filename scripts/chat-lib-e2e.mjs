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
 *   - <AzChat> (#38) in a box the page's stylesheet sizes, asking this
 *     server's /chat through the runtime's transport: the app's title,
 *     greeting and suggestions; a suggestion answered whole, the window
 *     filling its box and its transcript scrolling inside; Escape stopping
 *     an answer; Try again after a refusal; no inline style, no shared id;
 *     nothing after unmount; and its README example drawing;
 *   - no Content-Security-Policy violation (with a CONTROL that the watch
 *     sees one), and no request leaves the page's own origin.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { closeWithin, human, watchdog, within } from './lib/bounded.mjs';
import { violationControl, watchedContext } from './visual/csp.mjs';
import { chunksOf, corpusCases, corpusRules } from '../packages/chat-answer/test/corpus.ts';
import { historyKey, tagTurn } from '../packages/backend/src/server/chat-text.ts';
import { buildInstructions } from '../packages/chat-instructions/src/instructions.ts';
import { createAnswerChecker } from '../packages/chat-answer/src/checker.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* Deadlines (lib/bounded.mjs): three engines take well under a minute; 5 is several times that. */
const RUN_MS = 5 * 60 * 1000;
const STEP_MS = 30_000;
const CLOSE_MS = 10_000;
const progress = { last: 'start' };
const run = watchdog(RUN_MS, 'chat-lib-e2e', progress);

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

/** The answer page's script: the renderer core and <AzAnswer> (scripts/chat-lib-e2e/answer.js). */
const ANSWER_HARNESS = readFileSync(fileURLToPath(new URL('./chat-lib-e2e/answer.js', import.meta.url)), 'utf8');
/** The window page's script: <AzChat> over the chat runtime (scripts/chat-lib-e2e/window.js). */
const WINDOW_HARNESS = readFileSync(fileURLToPath(new URL('./chat-lib-e2e/window.js', import.meta.url)), 'utf8');
/** The window page's own stylesheet: the app gives the window's element (its className) its box. */
const APP_CSS = '.chat-box { block-size: 480px; inline-size: 360px; }\n';

/** The packages an app's page may load, by the alias name it imports them with. */
const PACKAGES = ['chat-answer', 'chat-instructions', 'chat-render', 'chat-react', 'chat-runtime'];

/** The page's policy: its own scripts, styles and requests only — no inline script or style, nothing from elsewhere. */
const POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

const page = (script, theme = null, css = null) => `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${POLICY}" />
<title>Chat library</title>${theme ? `<link rel="stylesheet" href="/pkg/chat-render/themes/${theme}.css" />` : ''}${css ? `<link rel="stylesheet" href="${css}" />` : ''}<script type="module" src="${script}"></script></head>
<body><main id="root"><h1>Chat library</h1><div id="app"></div><p id="status" role="status"></p></main></body></html>`;

/** React and React DOM as one module of their CommonJS builds, each run in its own scope — an app's bundler does the same. */
function reactBundle() {
  const need = createRequire(join(ROOT, 'packages/chat-react/package.json'));
  const dir = (pkg, from = need) => dirname(from.resolve(`${pkg}/package.json`));
  const dom = dir('react-dom');
  const files = {
    react: join(dir('react'), 'cjs/react.production.js'),
    scheduler: join(dir('scheduler', createRequire(join(dom, 'package.json'))), 'cjs/scheduler.production.js'),
    'react-dom': join(dom, 'cjs/react-dom.production.js'),
    'react-dom/client': join(dom, 'cjs/react-dom-client.production.js'),
  };
  const defs = Object.entries(files).map(([id, f]) => `${JSON.stringify(id)}: function (module, exports, require) {\n${readFileSync(f, 'utf8')}\n}`);
  return `const sources = {\n${defs.join(',\n')}\n};
const cache = {};
function require(id) {
  if (cache[id]) return cache[id].exports;
  const module = { exports: {} };
  cache[id] = module;
  sources[id](module, module.exports, require);
  return module.exports;
}
export const React = require('react');
export const ReactDOMClient = require('react-dom/client');
`;
}

/** The names the packages import from React, re-exported from the bundle. */
const REACT_NAMES = ['createElement', 'useEffect', 'useLayoutEffect', 'useRef', 'useState', 'useCallback', 'useMemo', 'useSyncExternalStore', 'Fragment'];
const REACT_MODULE = `import { React } from '/vendor/react-cjs.js';\n${REACT_NAMES.map((n) => `export const ${n} = React.${n};`).join('\n')}\nexport default React;\n`;
const REACT_DOM_MODULE = `import { ReactDOMClient } from '/vendor/react-cjs.js';\nexport const createRoot = ReactDOMClient.createRoot;\n`;

/** A package source as a browser module: its types stripped, its `#name/` aliases and React pointed at what is served. */
function moduleOf(name, path) {
  const file = join(ROOT, 'packages', name, /^(?:themes|examples)\//.test(path) ? '' : 'src', path);
  if (!existsSync(file)) return null;
  const js = stripTypeScriptTypes(readFileSync(file, 'utf8'));
  return js
    .replace(/(from |import\()'#([a-z-]+)\/((?:themes\/)?[a-z0-9-]+\.ts)'/g, (m, how, alias, f) => (PACKAGES.includes(alias) ? `${how}'/pkg/${alias}/${f}'` : m))
    .replace(/from '@az\/([a-z-]+)\/((?:themes\/)?[a-z0-9-]+\.ts)'/g, (m, pkg, f) => (PACKAGES.includes(pkg) ? `from '/pkg/${pkg}/${f}'` : m))
    .replace(/from 'react'/g, "from '/vendor/react.js'")
    .replace(/from 'react-dom\/client'/g, "from '/vendor/react-dom-client.js'");
}

/** Every request the pages make, by path: the tests read which modules a page loaded, and when. */
const requested = [];

/** The chat server's stand-in for the window (the chat API, chat-block-spec §4.2): the checker's events for MODEL_ANSWER. */
let windowEvents = null;
/** Questions refused once already: "Refuse once …" is refused (busy) the first time it is asked, answered the next. */
const refusedOnce = new Set();
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
async function chatAnswer(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) break;
  }
  let question = '';
  try {
    const body = JSON.parse(raw);
    const lastMessage = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
    if (typeof lastMessage?.text === 'string') question = lastMessage.text;
  } catch { /* no question: answered all the same */ }
  if (question.startsWith('Refuse once') && !refusedOnce.has(question)) {
    refusedOnce.add(question);
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'busy' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  if (question.startsWith('Wait')) {
    // An answer that stops coming: its first words, then nothing until the window stops it (or the step's deadline).
    res.write(sse('text', { s: 'Thinking about it' }));
    const end = setTimeout(() => res.end(), STEP_MS);
    res.on('close', () => clearTimeout(end));
    return;
  }
  windowEvents ??= await checkerEvents(MODEL_ANSWER);
  for (const e of windowEvents) {
    if (e.type === 'text') res.write(sse('text', { s: e.s }));
    else if (e.type === 'hold') res.write(sse('hold', { word: e.word }));
    else if (e.type === 'block') res.write(sse('block', e.block));
  }
  res.end(sse('done', { tag: 'a'.repeat(43), conversation: 'c'.repeat(22), text: 'An answer.', left: 2 }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  requested.push(url.pathname);
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', page('/harness.js'));
  if (url.pathname === '/answer.html') {
    const theme = url.searchParams.get('theme');
    return send(200, 'text/html; charset=utf-8', page('/answer.js', theme !== null && /^(?:midnight|paper|signal|clay|petal|volt)$/.test(theme) ? theme : 'midnight'));
  }
  if (url.pathname === '/chat' && req.method === 'POST') return void chatAnswer(req, res);
  if (url.pathname === '/window.html') return send(200, 'text/html; charset=utf-8', page('/window.js', 'midnight', '/app.css'));
  if (url.pathname === '/window.js') return send(200, 'text/javascript; charset=utf-8', WINDOW_HARNESS);
  if (url.pathname === '/app.css') return send(200, 'text/css; charset=utf-8', APP_CSS);
  if (url.pathname === '/harness.js') return send(200, 'text/javascript; charset=utf-8', HARNESS);
  if (url.pathname === '/answer.js') return send(200, 'text/javascript; charset=utf-8', ANSWER_HARNESS);
  if (url.pathname === '/vendor/react-cjs.js') return send(200, 'text/javascript; charset=utf-8', reactBundle());
  if (url.pathname === '/vendor/react.js') return send(200, 'text/javascript; charset=utf-8', REACT_MODULE);
  if (url.pathname === '/vendor/react-dom-client.js') return send(200, 'text/javascript; charset=utf-8', REACT_DOM_MODULE);
  const css = /^\/pkg\/chat-render\/themes\/([a-z]+)\.css$/.exec(url.pathname);
  if (css && existsSync(join(ROOT, 'packages/chat-render/themes', `${css[1]}.css`))) {
    return send(200, 'text/css; charset=utf-8', readFileSync(join(ROOT, 'packages/chat-render/themes', `${css[1]}.css`), 'utf8'));
  }
  const example = /^\/example\/([a-z-]+)\/([a-z0-9-]+)$/.exec(url.pathname);
  if (example && PACKAGES.includes(example[1]) && existsSync(join(ROOT, 'packages', example[1], 'examples', `${example[2]}.ts`))) {
    return send(200, 'text/html; charset=utf-8', page(`/pkg/${example[1]}/examples/${example[2]}.ts`, 'midnight'));
  }
  const m = /^\/pkg\/([a-z-]+)\/((?:themes\/|examples\/)?[a-z0-9-]+\.ts)$/.exec(url.pathname);
  const js = m && PACKAGES.includes(m[1]) ? moduleOf(m[1], m[2]) : null;
  if (js !== null) return send(200, 'text/javascript; charset=utf-8', js);
  return send(404, 'text/plain; charset=utf-8', 'not found');
});
/**
 * `--serve`: no tests — the pages stay up for a person to open, the packages' README examples among them
 * (/example/<package>/<name>), on SERVE_PORT, for at most SERVE_MS.
 */
const SERVING = process.argv.includes('--serve');
const SERVE_PORT = 4800;
const SERVE_MS = 30 * 60 * 1000;
await new Promise((ok) => server.listen(SERVING ? SERVE_PORT : 0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;
if (SERVING) {
  run.clear();
  console.log(`chat-lib-e2e --serve: ${origin}/example/chat-react/answer, ${origin}/example/chat-react/chat and ${origin}/example/chat-render/answer, for ${human(SERVE_MS)} (Ctrl+C ends it)`);
  setTimeout(() => process.exit(0), SERVE_MS).unref();
  await new Promise(() => undefined);
}

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

/** A model's answer with prose, components, an injection and a follow-up, as the answer checker turns it into events. */
const MODEL_ANSWER = `Here is **what we have**.

faq
  item "Do you ship?" "Yes, worldwide."

cta "Talk to us" /contact
cta "Elsewhere" https://elsewhere.example

<img src=x onerror=alert(1)> stays text.

chart bar "Orders"
  points "paid" 3 "open" 1

table "Plans" sortable
  columns "Plan" "Seats"
  row "Team" 10
  row "Solo" 1

ask "How do I cancel?"
`;
const MAP_ANSWER = 'Visit us:\n\nmap "Visit"\n  pin "Shop" 52.52 13.405\n';
const ANSWER_OPTIONS = { components: ['faq', 'cta', 'chart', 'table', 'map'], destinations: ['/contact'] };

/** The events the checker sends for `text`, in order. */
async function checkerEvents(text) {
  async function* one() { yield text; }
  const out = [];
  for await (const e of createAnswerChecker(ANSWER_OPTIONS).read(one())) out.push(e.type === 'done' ? { type: 'done' } : e);
  return out;
}

/**
 * <AzAnswer> and the renderer core in one engine (#36): an answer streamed in three renders — its prose, its placeholder while a
 * chart is read, then whole — drawn with the site's renderer; the injection inert; the theme applied; a map's library loaded only
 * when a map arrives; nothing left after unmount; the core alone, with no framework, drawing the same.
 */
async function answerChecks(name, ctx) {
  // Where this engine's requests start: the map module is judged by its own.
  const mark = requested.length;
  const events = await checkerEvents(MODEL_ANSWER);
  const hold = events.findIndex((e) => e.type === 'hold');
  const page = await ctx.newPage();
  await page.goto(`${origin}/answer.html?theme=midnight`, { waitUntil: 'load', timeout: STEP_MS });
  await page.waitForFunction(() => document.documentElement.dataset.azReady === 'yes', null, { timeout: STEP_MS });
  const render = (list, extra = {}) => within(STEP_MS, `${name} render`, () => page.evaluate(([e, o]) => window.azAnswer.render({ ...o, events: e }), [list, { ...ANSWER_OPTIONS, theme: 'midnight', ...extra }]));
  // The theme loads by name on first use: wait for its root, then stream.
  await render(events.slice(0, 1));
  await page.waitForFunction(() => document.querySelector('[data-az-chat-root]') !== null, null, { timeout: STEP_MS });
  const first = await render(events.slice(0, 1));
  check(name, '<AzAnswer>: the theme loads by name; the first words replace the dots, bold as bold, the answer busy', first.roots === 1 && first.theme === 'midnight'
    && first.thinking === 0 && first.strong === 1 && first.busy === 'true' && first.hiddenShell === true, JSON.stringify(first).slice(0, 200));
  const held = await render(events.slice(0, hold + 1));
  check(name, '<AzAnswer>: a held component stands as a placeholder of its shape while its figures are read', held.skeletons === 1 && held.faq.length === 1, JSON.stringify(held).slice(0, 200));
  const whole = await render(events);
  check(name, '<AzAnswer>: the whole answer — FAQ, the listed call to action only, a chart, a sortable table, the follow-up, the bar',
    whole.busy === 'false' && whole.skeletons === 0 && whole.faq[0] === 'Do you ship?' && JSON.stringify(whole.links) === '["/contact"]'
      && whole.svgMarks > 0 && whole.tableRows === 2 && whole.follows[0] === 'How do I cancel?' && whole.bar === 1,
    JSON.stringify({ ...whole, text: undefined }).slice(0, 400));
  check(name, '<AzAnswer>: the injection is text — no element, no style attribute, no handler from the answer',
    whole.text.includes('<img src=x onerror=alert(1)> stays text.') && whole.foreign === 0 && whole.styled === 0 && whole.handlers === 0, JSON.stringify({ foreign: whole.foreign, styled: whole.styled, handlers: whole.handlers }));
  const planted = await page.evaluate(() => {
    const li = document.querySelector('[data-az-chat-root] > ol > li');
    const img = document.createElement('img');
    // An on- attribute no event has and a style set through the CSSOM: counted, with nothing the policy refuses.
    img.setAttribute('onazcontrol', 'x');
    img.style.color = 'red';
    li.append(img);
    const seen = window.azAnswer.describe();
    img.remove();
    return seen;
  });
  check(name, 'CONTROL: an element, a style and a handler planted in the answer are each counted', planted.foreign === 1 && planted.styled === 1 && planted.handlers === 1);
  check(name, '<AzAnswer>: the theme\'s tokens reach the answer (the surface colour declared, the figure framed in a theme colour)',
    whole.surface !== '' && whole.figureBorder !== null && whole.figureBorder !== 'rgba(0, 0, 0, 0)', `${whole.surface} ${whole.figureBorder}`);
  await within(STEP_MS, `${name} follow-up`, () => page.evaluate(() => window.azAnswer.click('[data-az-chat-root] > ol .az-chat-follows button')));
  const asked = await page.evaluate(() => window.azAnswer.asked());
  const said = await page.evaluate(() => window.azAnswer.said());
  check(name, '<AzAnswer>: a follow-up\'s button asks its question; the status lines are sentences and one line a component', asked[0] === 'How do I cancel?'
    && said.includes('Answer finished. 1 follow-up question.') && said.includes('1 question and answer.') && new Set(said).size === said.length, JSON.stringify({ asked, said }).slice(0, 300));
  const before = requested.slice(mark).filter((p) => p.includes('chat-map-gl')).length;
  check(name, '<AzAnswer>: no map code is loaded while no answer holds a map', before === 0);
  await render(await checkerEvents(MAP_ANSWER));
  await page.waitForFunction(() => document.querySelector('[data-az-chat-root] .az-chat-map-list') !== null, null, { timeout: STEP_MS });
  const map = await page.evaluate(() => window.azAnswer.describe());
  for (const until = Date.now() + STEP_MS; !requested.slice(mark).some((p) => p.includes('chat-map-gl')) && Date.now() < until;) await new Promise((done) => setTimeout(done, 50));
  check(name, '<AzAnswer>: another answer starts the drawing again; its map is listed at once, and the map\'s module is asked for only now',
    map.mapList === 1 && map.faq.length === 0 && requested.slice(mark).some((p) => p.includes('chat-map-gl')), JSON.stringify(map).slice(0, 200));
  const gone = await within(STEP_MS, `${name} unmount`, () => page.evaluate(() => window.azAnswer.unmount()));
  check(name, '<AzAnswer>: unmounted, nothing of it is left in the page', gone.roots === 0 && gone.children === 0, JSON.stringify(gone));
  const core = await within(STEP_MS, `${name} core`, () => page.evaluate(([o, e]) => window.azAnswer.core(o, e), [ANSWER_OPTIONS, events]));
  check(name, 'the renderer core with no framework draws the same answer, and destroy() leaves nothing',
    core.faq[0] === 'Do you ship?' && JSON.stringify(core.links) === '["/contact"]' && core.tableRows === 2 && core.foreign === 0 && core.after === 0, JSON.stringify(core).slice(0, 200));
  await closeWithin(page, CLOSE_MS, `${name} answer page.close`);
  // The packages' README examples, as a person runs them (`--serve`): each draws its answer.
  for (const pkg of ['chat-react', 'chat-render']) {
    const ex = await ctx.newPage();
    await ex.goto(`${origin}/example/${pkg}/answer`, { waitUntil: 'load', timeout: STEP_MS });
    await ex.waitForFunction(() => document.documentElement.dataset.azExample === 'drawn', null, { timeout: STEP_MS });
    const drawn = await ex.evaluate(() => {
      const li = document.querySelector('[data-az-chat-root] > ol > li');
      return { svg: li?.querySelectorAll('svg').length ?? 0, links: [...(li?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href')), busy: li?.getAttribute('aria-busy') ?? null };
    });
    check(name, `the ${pkg} README example draws its answer: a chart, the listed link, finished`, drawn.svg > 0 && JSON.stringify(drawn.links) === '["/contact"]' && drawn.busy === 'false', JSON.stringify(drawn));
    await closeWithin(ex, CLOSE_MS, `${name} ${pkg} example.close`);
  }
}

/**
 * <AzChat> in one engine (#38): the window in a box the page's stylesheet sizes, the app's strings in it, asking the server's
 * /chat through the runtime: a suggestion answered whole; Escape stopping an answer; Try again after a refusal; nothing inline,
 * no id twice; nothing after unmount; and the README example drawing its window.
 */
async function windowChecks(name, ctx) {
  const page = await ctx.newPage();
  await page.goto(`${origin}/window.html`, { waitUntil: 'load', timeout: STEP_MS });
  await page.waitForFunction(() => document.documentElement.dataset.azReady === 'yes', null, { timeout: STEP_MS });
  const props = { ...ANSWER_OPTIONS, className: 'chat-box', theme: 'midnight', title: 'Ask Acme', greeting: 'Hi! Ask me about orders.', suggestions: ['How fast do you ship?', 'Do you ship abroad?'] };
  await within(STEP_MS, `${name} window render`, () => page.evaluate((p) => window.azWindow.render(p), props));
  await page.waitForFunction(() => document.querySelector('[data-az-chat-window] .az-chat-title') !== null, null, { timeout: STEP_MS });
  const describe = () => page.evaluate(() => window.azWindow.describe());
  const until = (what, fn) => within(STEP_MS, `${name} ${what}`, () => page.waitForFunction(fn, null, { timeout: STEP_MS }));
  const input = '[data-az-chat-window] [data-az-chat-input]';
  const first = await describe();
  check(name, '<AzChat>: the app\'s title, greeting and suggested questions, as text; the window fills the box the page gives it',
    first.title === 'Ask Acme' && first.greeting === 'Hi! Ask me about orders.' && JSON.stringify(first.asks) === JSON.stringify(props.suggestions)
      && first.asksShown && first.messages.length === 1 && JSON.stringify(first.root) === JSON.stringify(first.box) && first.box[1] === 480,
    JSON.stringify(first).slice(0, 300));

  await page.click('[data-az-chat-window] [data-az-chat-ask]');
  await until('answered', () => {
    const items = document.querySelectorAll('[data-az-chat-window] [data-az-chat-transcript] > li');
    return items.length === 3 && items[2].getAttribute('aria-busy') === 'false';
  });
  const answered = await describe();
  check(name, '<AzChat>: a suggestion is asked and answered whole — FAQ, the listed link only, a chart, the follow-up, the bar; the suggestions go',
    JSON.stringify(answered.messages) === '["site","visitor","site"]' && answered.faq[0] === 'Do you ship?' && JSON.stringify(answered.links) === '["/contact"]'
      && answered.svg > 0 && answered.follows[0] === 'How do I cancel?' && answered.bar === 1 && !answered.asksShown && answered.send && !answered.stop,
    JSON.stringify({ ...answered, lastText: undefined }).slice(0, 400));
  check(name, '<AzChat>: the status region says the answer, the note the questions left; the box holds the window, the transcript scrolls inside it',
    /follow-up question/.test(answered.status) && answered.note === '2 questions left in this chat.' && JSON.stringify(answered.root) === JSON.stringify(answered.box)
      && answered.transcriptInBox && answered.transcriptScrolls,
    JSON.stringify({ status: answered.status, note: answered.note, root: answered.root, box: answered.box, inBox: answered.transcriptInBox, scrolls: answered.transcriptScrolls }));

  await page.fill(input, 'Wait for it');
  await page.press(input, 'Enter');
  await until('streaming', () => document.querySelector('[data-az-chat-window] [data-az-chat-transcript] > li:last-child')?.textContent.includes('Thinking about it') === true);
  const coming = await describe();
  await page.keyboard.press('Escape');
  await until('stopped', () => document.querySelector('[data-az-chat-window] [data-az-chat-note]')?.textContent === 'Stopped.');
  const stopped = await describe();
  check(name, '<AzChat>: Enter sends; while it answers Stop shows; Escape stops it, the words it drew stay, focus stays in the input',
    coming.stop && !coming.send && coming.lastBusy === 'true' && stopped.send && !stopped.stop && stopped.lastText.includes('Thinking about it')
      && stopped.lastBusy === 'false' && stopped.focused && /Stopped\./.test(stopped.status),
    JSON.stringify({ coming: { stop: coming.stop, busy: coming.lastBusy }, stopped: { ...stopped, lastText: undefined } }).slice(0, 300));

  const refused = `Refuse once ${name}`;
  await page.fill(input, refused);
  await page.press(input, 'Enter');
  await until('refused', () => document.querySelector('[data-az-chat-window] [data-az-chat-retry]')?.hidden === false);
  const busy = await describe();
  await page.click('[data-az-chat-window] [data-az-chat-retry]');
  await until('retried', () => {
    const last = document.querySelector('[data-az-chat-window] [data-az-chat-transcript] > li:last-child');
    return last?.classList.contains('az-chat-message--site') === true && last.getAttribute('aria-busy') === 'false';
  });
  const retried = await describe();
  const visitors = (d) => d.messages.filter((m) => m === 'visitor').length;
  check(name, '<AzChat>: a refused question says the fixed copy and offers Try again; Try again asks it once more and it is answered',
    busy.error === 'Chat is busy — try again in a moment.' && busy.retry && busy.messages[busy.messages.length - 1] === 'visitor'
      && retried.error === '' && !retried.retry && retried.faq[0] === 'Do you ship?' && visitors(retried) === visitors(busy),
    JSON.stringify({ busy: { error: busy.error, retry: busy.retry }, retried: { error: retried.error, faq: retried.faq, messages: retried.messages } }));
  check(name, '<AzChat>: nothing inline — no style attribute, no handler — and no id twice', retried.styled === 0 && retried.handlers === 0 && retried.duplicateIds === 0,
    JSON.stringify({ styled: retried.styled, handlers: retried.handlers, duplicateIds: retried.duplicateIds }));
  const gone = await within(STEP_MS, `${name} window unmount`, () => page.evaluate(() => window.azWindow.unmount()));
  check(name, '<AzChat>: unmounted, nothing of it is left in the page', gone.windows === 0 && gone.children === 0, JSON.stringify(gone));
  await closeWithin(page, CLOSE_MS, `${name} window page.close`);

  // The README's window example, as a person runs it (`--serve`): its window, its suggestion answered.
  const ex = await ctx.newPage();
  await ex.goto(`${origin}/example/chat-react/chat`, { waitUntil: 'load', timeout: STEP_MS });
  await ex.waitForFunction(() => document.querySelector('[data-az-chat-window] .az-chat-title')?.textContent === 'Ask Acme', null, { timeout: STEP_MS });
  await ex.click('[data-az-chat-window] [data-az-chat-ask]');
  await ex.waitForFunction(() => {
    const last = document.querySelector('[data-az-chat-window] [data-az-chat-transcript] > li:last-child');
    return last?.getAttribute('aria-busy') === 'false' && last.querySelector('svg') !== null;
  }, null, { timeout: STEP_MS });
  check(name, 'the chat-react README window example draws its window, and its suggestion is answered with a chart', true);
  await closeWithin(ex, CLOSE_MS, `${name} chat example.close`);
}

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

      progress.last = `${name}: answer`;
      await answerChecks(name, ctx);

      progress.last = `${name}: window`;
      await windowChecks(name, ctx);

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
