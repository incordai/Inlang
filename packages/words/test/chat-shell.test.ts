/**
 * chat-block-spec §5.4, §7, §9: the chat word ships a shell the page runtime
 * runs — the greeting as text, a hidden form with a visible label, hidden
 * templates for both kinds of message, the follow-up controls as real
 * buttons, a polite status region, and its config — and nothing that runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFor, compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';
import { resolve, THEMES, withSeries } from '../../theme/src/index.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import { WEB_EMITTERS } from '../registry.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const w of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}
const T = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;

/** The chat block of a small site, emitted; `lines` go under `chat panel`. */
function chat(lines: string[] = [], { login = true } = {}): EmittedNode {
  const src = ['az 1', 'site aurora', '  auth', '    adapter azbackend', '  backend', '    database sqlite', '    email smtp',
    '    model default', 'page /pricing', '  chat panel', ...lines.map((l) => `    ${l}`),
    ...(login ? ['page /login', '  auth login', '    alt "Back" /pricing'] : []), ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b) => b.word === 'chat')!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

const walk = (n: EmittedNode | string): EmittedNode[] => (typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)]);
const texts = (n: EmittedNode | string): string[] => (typeof n === 'string' ? [n] : (n.children ?? []).flatMap(texts));
const marked = (root: EmittedNode, attr: string) => walk(root).filter((n) => n.attrs?.[attr] !== undefined);
const one = (root: EmittedNode, attr: string) => {
  const found = marked(root, attr);
  assert.equal(found.length, 1, `exactly one [${attr}]`);
  return found[0];
};

test('the config names the page, who may ask, the limit and the sign-in page — and nothing else', () => {
  const root = chat(['limit 12']);
  assert.deepEqual(JSON.parse(root.attrs!['data-az-chat']), { page: '/pricing', allow: 'signedin', limit: 12, signin: '/login' });
  assert.equal(root.attrs!['data-az-chat-state'], 'idle');
  const open = chat(['allow anyone']);
  assert.deepEqual(JSON.parse(open.attrs!['data-az-chat']), { page: '/pricing', allow: 'anyone', limit: 20, signin: null });
});

test('the greeting ships as the first message, as text; without one the transcript is empty', () => {
  const root = chat(['greeting "Hi! <b>Ask</b> me."']);
  const transcript = one(root, 'data-az-chat-transcript');
  assert.equal(transcript.tag, 'ol');
  assert.equal(transcript.attrs?.['aria-live'], undefined, '§9: the transcript is not a live region');
  assert.deepEqual(texts(transcript), ['Hi! <b>Ask</b> me.'], 'a string node: the target escapes it');
  assert.deepEqual(one(chat(), 'data-az-chat-transcript').children, []);
});

test('the form ships hidden, with a visible label tied to its textarea, and Send/Stop as real buttons', () => {
  const root = chat();
  const form = one(root, 'data-az-chat-form');
  assert.equal(form.tag, 'form');
  assert.equal(form.attrs?.hidden, 'hidden', 'with JavaScript off the form could not send, so it is not shown');
  const label = walk(form).find((n) => n.tag === 'label')!;
  const input = one(root, 'data-az-chat-input');
  assert.equal(input.tag, 'textarea');
  assert.equal(label.attrs?.for, input.attrs?.id);
  assert.deepEqual(texts(label), ['Your question']);
  assert.equal(input.attrs?.maxlength, '1000');
  assert.equal(one(root, 'data-az-chat-send').attrs?.type, 'submit');
  const stop = one(root, 'data-az-chat-stop');
  assert.deepEqual([stop.tag, stop.attrs?.type, stop.attrs?.hidden], ['button', 'button', 'hidden']);
});

test('both message templates ship hidden, each one paragraph of nothing', () => {
  const templates = one(chat(), 'data-az-chat-templates');
  assert.equal(templates.attrs?.hidden, 'hidden');
  const items = (templates.children ?? []) as EmittedNode[];
  assert.deepEqual(items.map((i) => i.attrs?.class), ['az-chat-message az-chat-message--visitor', 'az-chat-message az-chat-message--site']);
  for (const i of items) assert.deepEqual(texts(i), []);
  // §9: visitor messages on surface-alt, answers on surface — theme tokens only.
  assert.deepEqual(items.map((i) => i.style?.background), [T.color['surface-alt'], T.color.surface]);
});

test('suggested questions are buttons that never submit; none are emitted without any', () => {
  const root = chat(['ask "Which plan fits five?"', 'ask "Can I cancel?"']);
  const asks = one(root, 'data-az-chat-asks');
  assert.equal(asks.attrs?.hidden, 'hidden');
  const buttons = marked(root, 'data-az-chat-ask');
  assert.deepEqual(buttons.map((b) => [b.tag, b.attrs?.type, texts(b).join('')]),
    [['button', 'button', 'Which plan fits five?'], ['button', 'button', 'Can I cancel?']]);
  assert.equal(marked(chat(), 'data-az-chat-asks').length, 0);
});

test('Sign in to ask links to the sign-in page only when signed-in visitors alone may ask and a page signs them in', () => {
  const signin = marked(chat(), 'data-az-chat-signin');
  assert.equal(signin.length, 1);
  assert.equal(signin[0].attrs?.href, '/login');
  assert.equal(signin[0].attrs?.hidden, 'hidden');
  assert.equal(marked(chat(['allow anyone']), 'data-az-chat-signin').length, 0);
  assert.equal(marked(chat([], { login: false }), 'data-az-chat-signin').length, 0);
});

test('one polite status region, visually hidden; a noscript line; errors in color.danger', () => {
  const root = chat();
  const status = one(root, 'data-az-chat-status');
  assert.equal(status.attrs?.role, 'status');
  assert.equal(status.style?.position, 'absolute');
  assert.equal(one(root, 'data-az-chat-error').style?.color, T.color.danger);
  const noscript = walk(root).filter((n) => n.tag === 'noscript');
  assert.equal(noscript.length, 1);
  assert.deepEqual(texts(noscript[0]), ['Turn on JavaScript to ask a question.']);
});

test('CONTROL: nothing in the shell runs — no inline handler, no script, no style attribute, no image', () => {
  const nodes = walk(chat(['greeting "Hello"', 'ask "Why?"']));
  assert.ok(nodes.length > 20, 'CONTROL: the walk sees the shell');
  for (const n of nodes) {
    assert.ok(!['script', 'img', 'iframe', 'object', 'embed'].includes(n.tag), n.tag);
    for (const a of Object.keys(n.attrs ?? {})) assert.ok(!/^on/i.test(a) && a !== 'style', `${n.tag} ${a}`);
  }
});

/* ---- C2: the components' templates (chat-block-spec §5.4) ---------------- */

const SHOW_SITE = ['az 1', 'site aurora', '  auth', '    adapter azbackend', '  backend', '    database sqlite', '    email smtp', '    model default',
  'page /', '  hero center', '    title "Aurora"', '    cta "Docs" https://docs.aurora.example/start', '    alt "Mail" mailto:hi@aurora.example',
  '  pricing cards', '    title "Plans"', '    currency usd', '    plan "Team"', '      monthly 29', '      annual 290', '      cta "Start" /login',
  '    plan "Pro"', '      monthly 49', '      annual 490', '      cta "Start" /login',
  '  chat panel', '    show pricing faq cta feature', '    allow anyone',
  'page /login', '  auth login', '    alt "Back" /', ''].join('\n');

/** The site's first page: its pricing block and its chat, each emitted as a page emits them. */
function showPage(): { pricing: EmittedNode; chat: EmittedNode } {
  const r = compile(SHOW_SITE, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const blocks = blocksFor(r.spec, r.spec.pages[0]);
  const emit = (word: string) => emitBlock(blocks.find((b) => b.word === word)!, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
  return { pricing: emit('pricing'), chat: emit('chat') };
}
const partOf = (root: EmittedNode, key: string) => marked(root, 'data-az-chat-part').filter((n) => n.attrs?.['data-az-chat-part'] === key);
const classes = (n: EmittedNode) => walk(n).map((x) => x.attrs?.class ?? '').join(' ');
const MARK = (prop: string) => `${String.fromCharCode(0xe000)}${prop}${String.fromCharCode(0xe000)}`;
const marks = (n: EmittedNode) => texts(n).filter((t) => t.includes(String.fromCharCode(0xe000)));

test('with show, the config lists the words and the destinations the file declares', () => {
  const { chat: root } = showPage();
  assert.deepEqual(JSON.parse(root.attrs!['data-az-chat']), {
    page: '/', allow: 'anyone', limit: 20, signin: null,
    show: ['pricing', 'faq', 'cta', 'feature'], to: ['/', '/login', 'https://docs.aurora.example/start', 'mailto:hi@aurora.example'],
  });
  // CONTROL: a prose-only chat's config is as it was, and it ships no parts.
  assert.equal(marked(chat(), 'data-az-chat-parts').length, 0);
});

test('a quoted pricing block is the page\'s own block — the same markup and classes — with ids, radio groups and behaviour parked', () => {
  const { pricing, chat: root } = showPage();
  const parts = one(root, 'data-az-chat-parts');
  assert.equal(parts.attrs?.hidden, 'hidden');
  const [quote] = partOf(root, 'quote');
  assert.equal(quote.attrs?.['data-az-chat-quote'], '/#0');
  assert.equal(quote.attrs?.['data-az-chat-plans'], '2');
  const copy = (quote.children ?? [])[0] as EmittedNode;
  assert.equal(classes(copy), classes(pricing), 'every class is one the pricing word made for its page');
  assert.deepEqual(texts(copy), texts(pricing), 'the author\'s prices, word for word');
  // The page's own block keeps its ids and its switch; the template's never collide with them or get wired.
  const pageIds = new Set(walk(pricing).map((n) => n.attrs?.id).filter(Boolean));
  for (const n of walk(copy)) {
    if (n.attrs?.id) assert.ok(!pageIds.has(n.attrs.id), `id ${n.attrs.id} is suffixed`);
    assert.equal(n.attrs?.['data-az-behaviour'], undefined, 'parked, not live');
  }
  assert.ok(walk(copy).some((n) => n.attrs?.['data-az-chat-behaviour'] === 'billing'), 'the billing switch, parked');
  const radios = walk(copy).filter((n) => n.attrs?.type === 'radio');
  assert.ok(radios.length === 2 && radios.every((r) => r.attrs?.name !== 'az-billing'), 'its own radio group');
});

test('the faq and feature templates are those words\' own items, with markers where the answer\'s text goes', () => {
  const { chat: root } = showPage();
  const [faq] = partOf(root, 'faq');
  const list = (faq.children ?? [])[0] as EmittedNode;
  assert.equal(list.tag, 'ul');
  assert.equal(list.attrs?.hidden, undefined, 'the parts container is hidden; the list itself shows once filled');
  assert.equal(list.attrs?.['data-az-chat-behaviour'], 'faq');
  assert.equal((list.children ?? []).length, 1, 'one item to copy per question');
  assert.ok(classes(list).includes('az-faq-item') && classes(list).includes('az-faq-toggle'));
  assert.deepEqual(marks(list), [MARK('question'), MARK('text')]);
  const [feature] = partOf(root, 'feature');
  assert.deepEqual(marks(feature), [MARK('title'), MARK('text')]);
  assert.ok(classes(feature).includes('az-feature'));
});

test('one call-to-action template per way a destination is followed, each the button primitive', () => {
  const { chat: root } = showPage();
  const keys = marked(root, 'data-az-chat-part').map((n) => n.attrs?.['data-az-chat-part'] ?? '').filter((k) => k.startsWith('cta-'));
  assert.deepEqual(keys, ['cta-route', 'cta-https', 'cta-mailto']);
  for (const key of keys) {
    const a = (partOf(root, key)[0].children ?? [])[0] as EmittedNode;
    assert.equal(a.tag, 'a');
    assert.match(a.attrs?.class ?? '', /\baz-action\b/);
    assert.ok(texts(a).includes(MARK('label')));
  }
  const external = (partOf(root, 'cta-https')[0].children ?? [])[0] as EmittedNode;
  assert.equal(external.attrs?.rel, 'noopener noreferrer');
});

test('CONTROL: the parts run nothing either — no script, image, inline handler or style attribute', () => {
  const nodes = walk(one(showPage().chat, 'data-az-chat-parts'));
  assert.ok(nodes.length > 30);
  for (const n of nodes) {
    assert.ok(!['script', 'img', 'iframe', 'object', 'embed'].includes(n.tag), n.tag);
    for (const a of Object.keys(n.attrs ?? {})) assert.ok(!/^on/i.test(a) && a !== 'style', `${n.tag} ${a}`);
  }
});

/* ---- C2b: the rich components' templates (chat-block-spec §20.4, §20.6, §20.7) ---- */

const RICH_SITE = ['az 1', 'site aurora', '  auth', '    adapter azbackend', '  backend', '    database sqlite', '    email smtp', '    model default',
  'page /', '  hero center', '    title "Aurora"', '  gallery grid', '    image ./a.webp', '      alt "A workbench"', '    image ./b.webp', '      alt ""',
  '  chat panel', '    show chart table stats cards dashboard', '    allow anyone', ''].join('\n');
const SERIES_THEME = resolve(withSeries(THEMES.midnight), 'dark') as unknown as ThemeLike;

function richChat(): EmittedNode {
  const r = compile(RICH_SITE, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b) => b.word === 'chat')!;
  return emitBlock(block, SERIES_THEME, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

test('the paint template: each series part painted with its series token, as a class — never an attribute', () => {
  const [paint] = partOf(richChat(), 'paint');
  const painted = marked(paint, 'data-az-chat-paint');
  for (let n = 1; n <= 6; n++) {
    const fill = painted.find((p) => p.attrs?.['data-az-chat-paint'] === `fill-${n}`)!;
    assert.equal(fill.style?.fill, SERIES_THEME.color[`series-${n}`]);
    assert.equal(fill.attrs?.fill, undefined);
    const line = painted.find((p) => p.attrs?.['data-az-chat-paint'] === `line-${n}`)!;
    assert.equal(line.style?.stroke, SERIES_THEME.color[`series-${n}`]);
    // Lines past the first differ by their dash too: colour is never the only signal.
    assert.equal(Boolean(line.style?.strokeDasharray), n > 1);
  }
  assert.equal(painted.find((p) => p.attrs?.['data-az-chat-paint'] === 'tick')!.style?.fill, SERIES_THEME.color.muted);
});

test('the figure frame carries the AI label as fixed copy, and the source line; the table its real headers', () => {
  const root = richChat();
  const [figure] = partOf(root, 'figure');
  assert.deepEqual(texts(one(figure, 'data-az-chat-ai')), ['AI-generated figures']);
  assert.ok(texts(one(figure, 'data-az-chat-source')).join('').startsWith('From the site’s data'));
  const [table] = partOf(root, 'table');
  const th = walk(table).filter((n) => n.tag === 'th');
  assert.ok(th.length === 2 && th.every((n) => n.attrs?.scope === 'col'));
  assert.ok(walk(table).some((n) => n.tag === 'caption'));
  assert.equal(walk(table)[1].attrs?.tabindex, '0', 'a narrow table scrolls in a region the keyboard reaches');
});

test('an image card may show only a gallery image with its author\'s alt, by key; the row image template has no address', () => {
  const root = richChat();
  const assets = partOf(root, 'asset');
  assert.deepEqual(assets.map((a) => a.attrs?.['data-az-chat-asset']), ['i1'], 'the image without alt is not offered');
  const img = (assets[0].children ?? [])[0] as EmittedNode;
  assert.deepEqual([img.tag, img.attrs?.src, img.attrs?.alt], ['img', './a.webp', 'A workbench']);
  const row = (partOf(root, 'row-image')[0].children ?? [])[0] as EmittedNode;
  assert.deepEqual([row.tag, row.attrs?.src, row.attrs?.alt], ['img', undefined, '']);
});

test('the share control: a button, an unticked choice to include the question, and read-only link fields', () => {
  const [share] = partOf(richChat(), 'share');
  const open = marked(share, 'data-az-chat-slot').find((n) => n.attrs?.['data-az-chat-slot'] === 'open')!;
  assert.deepEqual([open.tag, open.attrs?.type, open.attrs?.['aria-expanded']], ['button', 'button', 'false']);
  const include = marked(share, 'data-az-chat-slot').find((n) => n.attrs?.['data-az-chat-slot'] === 'include')!;
  assert.equal(include.attrs?.type, 'checkbox');
  assert.equal(include.attrs?.checked, undefined, 'the question is left out unless chosen');
  for (const name of ['url', 'delete']) {
    const field = marked(share, 'data-az-chat-slot').find((n) => n.attrs?.['data-az-chat-slot'] === name)!;
    assert.equal(field.attrs?.readonly, 'readonly');
  }
});

/* ---- C3: the float and §9's polish ---- */

/** The site-level float as `route` shows it, emitted. */
function floatOn(route = '/pricing', lines: string[] = []): EmittedNode {
  const src = ['az 1', 'site aurora', '  auth', '    adapter azbackend', '  backend', '    database sqlite', '    email smtp',
    '    model default', '  chat float', '    title "Ask Aurora"', '    allow anyone', ...lines.map((l) => `    ${l}`),
    'page /pricing', '  hero center', '    title "Plans"', 'page /about', '  hero center', '    title "About"', ''].join('\n');
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages.find((p) => p.route === route)!).find((b) => b.word === 'chat')!;
  return emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

test('a float: a launcher named by the title, hidden until the runtime runs, that controls a dialog labelled by the same title', () => {
  const root = floatOn();
  assert.equal(root.tag, 'div', 'not a section: a launcher and its dialog are not a page region');
  const launcher = one(root, 'data-az-chat-launcher');
  assert.deepEqual([launcher.tag, launcher.attrs?.type, launcher.attrs?.hidden, launcher.attrs?.['aria-expanded'], launcher.attrs?.['aria-haspopup']],
    ['button', 'button', 'hidden', 'false', 'dialog']);
  assert.deepEqual(texts(launcher), ['Ask Aurora'], '§9: the launcher\'s name is the title');
  const dialog = walk(root).find((n) => n.tag === 'dialog')!;
  assert.equal(launcher.attrs?.['aria-controls'], dialog.attrs?.id);
  assert.equal(dialog.attrs?.['aria-labelledby'], 'az-chat-title');
  assert.equal(dialog.attrs?.open, undefined, 'closed until opened');
  assert.equal(dialog.attrs?.['data-az-behaviour'], undefined, 'the chat runtime opens it, not the generic modal wiring (it is not modal above sm)');
  const title = walk(dialog).find((n) => n.attrs?.id === 'az-chat-title')!;
  assert.deepEqual([title.tag, texts(title)], ['h2', ['Ask Aurora']]);
  const close = one(dialog, 'data-az-chat-close');
  assert.deepEqual([close.tag, close.attrs?.type, close.attrs?.['aria-label']], ['button', 'button', 'Close']);
});

test('a float\'s config says the width below which it is a sheet — the theme\'s sm — and its page; a panel\'s does not', () => {
  assert.deepEqual(JSON.parse(floatOn('/about').attrs!['data-az-chat']), { page: '/about', allow: 'anyone', limit: 20, signin: null, narrow: T.breakpoint.sm });
  assert.equal(JSON.parse(chat().attrs!['data-az-chat']).narrow, undefined);
});

test('the float holds the whole panel: transcript, Jump to latest, form, status — and below sm the sheet\'s place, from tokens only', () => {
  const root = floatOn();
  for (const attr of ['data-az-chat-transcript', 'data-az-chat-latest', 'data-az-chat-form', 'data-az-chat-status', 'data-az-chat-templates']) one(root, attr);
  const dialog = walk(root).find((n) => n.tag === 'dialog')!;
  assert.equal(dialog.style?.position, 'fixed');
  assert.equal(dialog.style?.zIndex, T.layer.modal);
  assert.equal(dialog.below?.sm?.insetBlockEnd, 0, 'the bottom edge');
  assert.equal(dialog.below?.sm?.width, '100%');
  assert.equal(dialog.states?.open?.opacity, 1, 'it enters by its open state (reduced motion: the target\'s net keeps only opacity)');
  assert.equal(dialog.style?.display, undefined, '§2: an overlay never sets display — the closed dialog stays hidden');
});

test('§9: the transcript scrolls on its own and is a keyboard stop; Jump to latest ships hidden, a real button', () => {
  for (const root of [chat(), floatOn()]) {
    const transcript = one(root, 'data-az-chat-transcript');
    assert.equal(transcript.attrs?.tabindex, '0');
    assert.equal(transcript.style?.overflowY, 'auto');
    assert.equal(transcript.attrs?.['aria-live'], undefined, 'still not a live region');
    const latest = one(root, 'data-az-chat-latest');
    assert.deepEqual([latest.tag, latest.attrs?.type, latest.attrs?.hidden, texts(latest).join('')], ['button', 'button', 'hidden', 'Jump to latest']);
  }
});

test('CONTROL: a float runs nothing — no inline handler, no script, no style attribute', () => {
  for (const n of walk(floatOn())) {
    assert.ok(!['script', 'iframe', 'object', 'embed', 'img'].includes(n.tag), n.tag);
    for (const a of Object.keys(n.attrs ?? {})) assert.ok(!/^on/i.test(a) && a !== 'style', `${n.tag} ${a}`);
  }
});

test('CONTROL: the rich parts run nothing — no script, no inline handler, no style attribute; images only the two templates', () => {
  const nodes = walk(one(richChat(), 'data-az-chat-parts'));
  for (const n of nodes) {
    assert.ok(!['script', 'iframe', 'object', 'embed'].includes(n.tag), n.tag);
    for (const a of Object.keys(n.attrs ?? {})) assert.ok(!/^on/i.test(a) && a !== 'style', `${n.tag} ${a}`);
  }
  assert.equal(nodes.filter((n) => n.tag === 'img').length, 2);
});
