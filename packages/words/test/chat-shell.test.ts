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
import { GRADIENT_REFERENCES, resolve, THEMES, withAccentPair, withChat, withSeries, type AccentName } from '../../theme/src/index.ts';
import { ACCENT_PAIRS } from '../../core/src/accent-pairs.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import { WEB_EMITTERS } from '../registry.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const w of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}
/** A chat site's theme: the chat's tint is added to every site with a chat (target-web namedTheme). */
const T = resolve(withChat(THEMES.midnight), 'dark') as unknown as ThemeLike;

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
  // §9: the visitor's words on the accent's quiet tint; the answer on the panel's plain surface — no bubble of its own.
  assert.deepEqual(items.map((i) => i.style?.background), [T.color['chat-visitor'], undefined]);
  assert.ok(T.color['chat-visitor'], 'CONTROL: the chat theme carries the tint');
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
  assert.equal(root.style?.display, 'contents', 'the float takes no place in the page\'s flow or its frame');
  const handle = one(dialog, 'data-az-drag');
  assert.deepEqual([handle.attrs?.['aria-hidden'], handle.style?.display, handle.below?.sm?.display], ['true', 'none', 'flex'],
    'the sheet\'s drag handle: below sm only, hidden from assistive tech (Close and Escape serve everyone)');
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

/* ---- C7: an explore's templates (chat-block-spec §21.3.4, §21.3.6) ---- */

function exploreChat(show: string): EmittedNode {
  const r = compile(RICH_SITE.replace('    show chart table stats cards dashboard', `    show ${show}`), { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b) => b.word === 'chat')!;
  return emitBlock(block, SERIES_THEME, WEB_EMITTERS, (p) => p, { name: 'aurora' });
}

test('an explore ships real controls: a labelled range with an <output>, a date input, radios in a fieldset, a form of labelled fields and one submit', () => {
  const root = exploreChat('explore');
  const [part] = partOf(root, 'explore');
  assert.ok(part, 'the explore part');
  const slots = (name: string) => walk(part).filter((n) => n.attrs?.['data-az-chat-slot'] === name);
  const [section] = (part.children ?? []) as EmittedNode[];
  assert.equal(section.tag, 'section', 'a section, labelled by its title at run time');
  assert.equal(slots('title')[0].tag, 'h3');
  const [slider] = slots('slider');
  assert.deepEqual(walk(slider).filter((n) => ['label', 'input', 'output'].includes(n.tag)).map((n) => [n.tag, n.attrs?.type]), [['label', undefined], ['input', 'range'], ['output', undefined]]);
  assert.deepEqual(walk(slots('date')[0]).filter((n) => n.tag === 'input').map((n) => n.attrs?.type), ['date']);
  const [toggle] = slots('toggle');
  assert.equal(toggle.tag, 'fieldset');
  assert.deepEqual(walk(toggle).filter((n) => n.tag === 'legend' || n.tag === 'input').map((n) => n.attrs?.type ?? n.tag), ['legend', 'radio']);
  const [form] = slots('form');
  assert.equal(form.tag, 'form');
  assert.ok(walk(form).some((n) => n.tag === 'fieldset') && walk(form).some((n) => n.tag === 'legend'));
  const number = walk(slots('field-number')[0]).find((n) => n.tag === 'input')!;
  assert.deepEqual([number.attrs?.type, number.attrs?.step, number.attrs?.required], ['number', 'any', 'required']);
  assert.ok(walk(slots('field-choice')[0]).some((n) => n.tag === 'select'));
  const submit = slots('submit');
  assert.equal(submit.length, 1);
  assert.deepEqual([submit[0].tag, submit[0].attrs?.type], ['button', 'submit']);
  assert.deepEqual(texts(submit[0]).filter((t) => t.trim() !== ''), [], 'its words are the runtime\'s: Apply, or the question it asks');
  assert.equal(slots('view').length + slots('view-wide').length, 2);
  // It draws charts, tables and stat cards: their templates ship with it, and the series colours.
  for (const k of ['paint', 'figure', 'table', 'stats', 'unavailable']) assert.equal(partOf(root, k).length, 1, k);
  assert.equal(partOf(root, 'cards').length, 0);
  for (const n of walk(part)) {
    assert.ok(!['script', 'iframe', 'object', 'embed', 'img'].includes(n.tag), n.tag);
    for (const a of Object.keys(n.attrs ?? {})) assert.ok(!/^on/i.test(a) && a !== 'style' && a !== 'action' && a !== 'formaction', `${n.tag} ${a}`);
  }
  // CONTROL: a chat that does not show explore ships none of it.
  assert.equal(partOf(exploreChat('chart'), 'explore').length, 0);
});

/* ---- C8: a map's templates (chat-block-spec §21.4.3, §21.4.5) ---- */

test('a map ships its stage as a focusable image, az\'s own three buttons, the attribution line, the note and the list equivalent; the popup a part of its own', () => {
  const root = exploreChat('map');
  const [part] = partOf(root, 'map');
  assert.ok(part, 'the map part');
  const slots = (name: string) => walk(part).filter((n) => n.attrs?.['data-az-chat-slot'] === name);
  const [figure] = (part.children ?? []) as EmittedNode[];
  assert.deepEqual([figure.tag, figure.attrs?.['data-az-chat-map']], ['figure', 'loading']);
  const [stage] = slots('stage');
  assert.deepEqual([stage.attrs?.role, stage.attrs?.tabindex], ['img', '0'], 'an image the arrow and + − keys move');
  assert.equal((stage.children ?? []).length, 0, 'the library fills it');
  const buttons = walk(slots('controls')[0]).filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((b) => [b.attrs?.type, b.attrs?.['data-az-chat-slot'], texts(b).join('').trim()]),
    [['button', 'zoom-in', 'Zoom in'], ['button', 'zoom-out', 'Zoom out'], ['button', 'reset', 'Reset view']]);
  assert.equal(slots('attribution')[0].tag, 'p');
  assert.equal(slots('note')[0].attrs?.hidden, 'hidden');
  const [list] = slots('list');
  assert.equal(list.tag, 'details');
  assert.deepEqual(texts(walk(list).find((n) => n.tag === 'summary')!).join('').trim(), 'Show the places as a list');
  assert.equal(slots('pins')[0].tag, 'ol');
  assert.equal(slots('route')[0].attrs?.role, 'group');
  assert.notEqual(slots('route-title')[0].tag, 'h4', 'no heading inside the transcript\'s list');
  const [popup] = partOf(root, 'map-popup');
  assert.ok(popup, 'the popup part');
  assert.deepEqual(walk(popup).filter((n) => n.attrs?.['data-az-chat-slot']).map((n) => [n.tag, n.attrs?.['data-az-chat-slot']]), [['strong', 'label'], ['span', 'src']]);
  for (const n of [...walk(part), ...walk(popup)]) {
    assert.ok(!['script', 'iframe', 'object', 'embed', 'img', 'canvas'].includes(n.tag), n.tag);
    for (const a of Object.keys(n.attrs ?? {})) assert.ok(!/^on/i.test(a) && a !== 'style' && a !== 'href' && a !== 'src', `${n.tag} ${a}`);
  }
  // CONTROL: a chat that does not show maps ships none of it.
  assert.equal(partOf(exploreChat('chart'), 'map').length, 0);
  assert.equal(partOf(exploreChat('chart'), 'map-popup').length, 0);
});

/* ---- the chat's look (chat-block-spec §9) and issues #1 and #2 ---- */

test('§9: the panel and the float are on the theme\'s surface; the answer has no bubble, the visitor\'s words the accent tint', () => {
  const panelCard = walk(chat()).find((n) => n.attrs?.class === 'az-chat-panel')!;
  assert.deepEqual([panelCard.style?.background, panelCard.style?.border], [T.color.surface, `1px solid ${T.color.border}`]);
  const dialog = walk(floatOn()).find((n) => n.tag === 'dialog')!;
  assert.equal(dialog.style?.background, T.color.surface);
  const [visitor, site] = (one(chat(), 'data-az-chat-templates').children ?? []) as EmittedNode[];
  assert.equal(visitor.style?.justifySelf, 'end');
  assert.equal(site.style?.padding, undefined, 'the answer runs on the surface, not inside a box');
});

test('issue #1: a quoted block is drawn compact — no page padding or ground, a smaller heading — and the page\'s own block is unchanged', () => {
  const { pricing, chat: root } = showPage();
  const copy = (partOf(root, 'quote')[0].children ?? [])[0] as EmittedNode;
  assert.deepEqual([copy.style?.paddingBlock, copy.style?.paddingInline, copy.style?.background], [0, 0, 'transparent']);
  assert.equal(copy.below?.sm?.paddingInline, undefined, 'no mobile gutter either');
  const heading = (n: EmittedNode) => walk(n).find((x) => x.attrs?.class === 'az-pricing-title')!;
  assert.equal(heading(copy).style?.fontSize, T.typeSize.lg);
  // The page's own pricing block keeps its section padding and its heading — a style is its own class.
  assert.equal(pricing.style?.paddingBlock, `${T.space[96]}px`);
  assert.equal(heading(pricing).style?.fontSize, T.typeSize['2xl']);
  const plan = (n: EmittedNode) => walk(n).find((x) => (x.attrs?.class ?? '').split(' ').includes('az-plan'))!;
  assert.equal(plan(copy).style?.padding, `${T.space[12]}px`, 'its cards step down too');
  assert.equal(plan(pricing).style?.padding, `${T.space[24]}px`);
});

/** A chat site whose accent is a pair (theme-spec §13): the target hands words the gradients. */
function pairTheme(): ThemeLike {
  const hue = Object.keys(ACCENT_PAIRS.midnight).find((h) => ACCENT_PAIRS.midnight[h].length > 0)! as AccentName;
  const named = withChat(withAccentPair(THEMES.midnight, hue, ACCENT_PAIRS.midnight[hue][0] as AccentName));
  return { ...(resolve(named, 'dark') as unknown as ThemeLike), gradient: GRADIENT_REFERENCES };
}

test('§9: with an accent pair the gradient is painted on Send alone — the launcher and an answer\'s call to action are the solid accent', () => {
  const pair = pairTheme();
  const r = compile(SHOW_SITE.replace('  chat panel', '  chat float'), { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  const block = blocksFor(r.spec, r.spec.pages[0]).find((b) => b.word === 'chat')!;
  const root = emitBlock(block, pair, WEB_EMITTERS, (p) => p, { name: 'aurora' });
  const painted = walk(root).filter((n) => n.style?.backgroundImage === pair.gradient!.accent);
  assert.deepEqual(painted.map((n) => n.attrs?.['data-az-chat-send'] !== undefined), [true], 'one gradient: Send');
  const launcher = one(root, 'data-az-chat-launcher');
  assert.deepEqual([launcher.style?.backgroundImage, launcher.style?.color, launcher.style?.background], ['none', pair.color['accent-contrast'], pair.color.accent]);
  // An answer's call to action is outlined: the chat's one filled accent control is Send.
  for (const key of ['cta-route', 'cta-https', 'cta-mailto']) {
    const a = (partOf(root, key)[0].children ?? [])[0] as EmittedNode;
    assert.deepEqual([a.style?.background, a.style?.backgroundImage], ['transparent', undefined], key);
    assert.notEqual(a.states?.hover?.backgroundImage, pair.gradient!['accent-hover'], `${key} hover`);
  }
  // CONTROL: the same site with one hue paints no gradient anywhere, and the launcher is the target's primary unchanged.
  const flat = emitBlock(block, T, WEB_EMITTERS, (p) => p, { name: 'aurora' });
  assert.equal(walk(flat).filter((n) => n.style?.backgroundImage !== undefined).length, 0);
});

test('issue #2: the input is one line, not resizable, with Send beside it in one row', () => {
  const input = one(chat(), 'data-az-chat-input');
  assert.deepEqual([input.attrs?.rows, input.style?.resize], ['1', 'none']);
  const compose = walk(chat()).find((n) => n.attrs?.class === 'az-chat-compose')!;
  assert.equal(compose.style?.display, 'flex');
  assert.ok(walk(compose).some((n) => n.attrs?.['data-az-chat-send'] !== undefined), 'Send is in the input\'s row');
});

test('issue #2: Clear history ships hidden and the history note sits behind an info control; in a float both are in the head', () => {
  for (const root of [chat(['allow anyone']), floatOn()]) {
    const box = one(root, 'data-az-chat-history');
    assert.equal(box.attrs?.hidden, 'hidden', 'shown only where this browser can keep a chat');
    assert.equal(one(root, 'data-az-chat-clear').attrs?.hidden, 'hidden', 'shown once there is history');
    const about = one(root, 'data-az-chat-about');
    const note = one(root, 'data-az-chat-privacy');
    assert.deepEqual([about.tag, about.attrs?.type, about.attrs?.['aria-expanded'], about.attrs?.['aria-controls']],
      ['button', 'button', 'false', note.attrs?.id]);
    assert.equal(about.attrs?.['aria-label'], 'How this chat is kept');
    assert.equal(note.attrs?.hidden, 'hidden');
    assert.match(texts(note).join(''), /kept in this browser for 7 days; signing in clears it/);
  }
  const head = walk(floatOn()).find((n) => n.attrs?.class === 'az-chat-head')!;
  assert.ok(walk(head).some((n) => n.attrs?.['data-az-chat-history'] !== undefined), 'the float\'s history controls take no line of their own');
});

test('issue #2: Jump to latest is laid over the transcript\'s foot — it takes no height from the answer', () => {
  const latest = one(floatOn(), 'data-az-chat-latest');
  assert.match(String(latest.style?.marginBlockStart), /^calc\(-1 \* /);
  assert.equal(latest.style?.position, 'relative');
  assert.equal(latest.style?.background, T.color.surface);
});

test('§9: the float sheet below sm is the preset\'s tallest, one height while an answer streams', () => {
  const sheet = walk(floatOn()).find((n) => n.attrs?.class === 'az-chat-sheet')!;
  assert.deepEqual([sheet.below?.sm?.height, sheet.below?.sm?.maxHeight], ['85svh', '85svh']);
});

/* ---- issues #20, #21, #28, #29, #30, #31 (chat-block-spec §19.18) ---- */

const slotOf = (root: EmittedNode, name: string) => walk(root).filter((n) => n.attrs?.['data-az-chat-slot'] === name);

test('issue #31: the inline panel is one card — its title in its own head, beside the history controls — grown to 768 px and centred', () => {
  const root = chat(['allow anyone']);
  const card = walk(root).find((n) => n.attrs?.class === 'az-chat-panel')!;
  const head = (card.children ?? []).find((n): n is EmittedNode => typeof n !== 'string' && n.attrs?.class === 'az-chat-head');
  assert.ok(head, 'the card opens with its head');
  const title = walk(head).find((n) => n.attrs?.id === 'az-chat-title')!;
  assert.equal(title.tag, 'h2');
  assert.deepEqual([title.style?.fontSize, title.style?.fontWeight], [T.typeSize.base, T.type['weight-bold']], 'the float head\'s size, not a page heading\'s');
  assert.ok(walk(head).some((n) => n.attrs?.['data-az-chat-history'] !== undefined), 'the history controls take no line of their own');
  assert.equal((root.children ?? []).length, 1, 'nothing of the chat sits outside its card');
  assert.deepEqual([card.style?.maxWidth, card.style?.marginInline], [`calc(6 * ${T.space[128]}px)`, 'auto']);
  // The answer runs the card's width; its words keep the reading measure.
  const site = (one(root, 'data-az-chat-templates').children ?? [])[1] as EmittedNode;
  assert.equal(site.style?.maxWidth, undefined);
  assert.equal(((site.children ?? [])[0] as EmittedNode).style?.maxWidth, `${T.size['measure-body']}ch`);
});

test('issue #31: suggested questions are small pill chips that wrap, and below sm one row that scrolls sideways', () => {
  const list = one(chat(['ask "How bright is it?"', 'ask "Does it ship abroad?"']), 'data-az-chat-asks');
  assert.deepEqual([list.style?.flexWrap, list.below?.sm?.flexWrap, list.below?.sm?.overflowX], ['wrap', 'nowrap', 'auto']);
  for (const item of (list.children ?? []) as EmittedNode[]) {
    const chip = (item.children ?? [])[0] as EmittedNode;
    assert.equal(chip.tag, 'button');
    assert.deepEqual([chip.style?.borderRadius, chip.style?.fontSize], [`${T.radius.full}px`, T.typeSize.sm]);
    assert.equal(chip.below?.sm?.whiteSpace, 'nowrap');
    assert.equal(item.below?.sm?.flex, 'none');
  }
});

test('issue #20: a stat\'s value is set against its own card\'s width, between lg and 2xl, and wraps before a digit is hidden', () => {
  const [stats] = partOf(richChat(), 'stats');
  const card = walk(stats).find((n) => n.attrs?.class === 'az-chat-stat')!;
  assert.equal(card.style?.containerType, 'inline-size');
  const value = slotOf(stats, 'value')[0];
  assert.equal(value.style?.fontSize, `clamp(${SERIES_THEME.typeSize.lg}, 20cqi, ${SERIES_THEME.typeSize['2xl']})`);
  assert.equal(value.style?.overflowWrap, 'anywhere');
});

test('issues #20, #31: a dashboard holds its stats as one headline row over a dense grid of tiles two 128 steps wide; a table spans the row', () => {
  const [dash] = partOf(richChat(), 'dashboard');
  const section = (dash.children ?? [])[0] as EmittedNode;
  const [headline] = slotOf(section, 'stats');
  assert.ok(headline, 'a row for the stats');
  const [tiles] = slotOf(section, 'tiles');
  assert.equal(tiles.style?.gridAutoFlow, 'row dense');
  assert.equal(tiles.style?.gridTemplateColumns, `repeat(auto-fit, minmax(min(100%, calc(2 * ${SERIES_THEME.space[128]}px)), 1fr))`);
  const wide = slotOf(section, 'tile-wide')[0];
  assert.equal(wide.style?.gridColumn, '1 / -1');
  assert.equal(wide.below, undefined, 'a whole row at every width');
  const order = (section.children ?? []).map((n) => (typeof n === 'string' ? n : n.attrs?.['data-az-chat-slot']));
  assert.deepEqual(order, ['title', 'stats', 'tiles'], 'the stats come before the other tiles');
});

test('issue #29: the paint marks a pointed-at mark with the focus colour and draws the tooltip on the surface; the chart is a keyboard stop; the plot row holds the chart and its legend', () => {
  const root = richChat();
  const [paint] = partOf(root, 'paint');
  const p = (name: string) => marked(paint, 'data-az-chat-paint').find((n) => n.attrs?.['data-az-chat-paint'] === name)!;
  for (let n = 1; n <= 6; n++) {
    assert.equal(p(`fill-${n}`).states?.open?.stroke, SERIES_THEME.color.focus);
    assert.equal(p(`patterned-${n}`).states?.open?.stroke, SERIES_THEME.color.focus);
    assert.ok(p(`line-${n}`).states?.open?.strokeWidth);
  }
  assert.deepEqual([p('tip').style?.fill, p('tip').style?.stroke], [SERIES_THEME.color.surface, SERIES_THEME.color['border-strong']]);
  assert.deepEqual([p('tip-text').style?.fill, p('tip-text').style?.fontSize], [SERIES_THEME.color.text, SERIES_THEME.typeSize.sm]);
  assert.ok(p('svg').states?.focusVisible?.outline, 'a focused chart shows the ring');
  const [figure] = partOf(root, 'figure');
  const [plot] = slotOf(figure, 'plot');
  assert.deepEqual((plot.children ?? []).map((n) => (n as EmittedNode).attrs?.['data-az-chat-slot']), ['body', 'legend']);
  assert.equal(plot.style?.flexWrap, 'wrap', 'the legend sits beside a small chart when there is room, under it when not');
  assert.equal(slotOf(figure, 'legend-item')[0].states?.open?.textDecoration, 'underline');
});

test('issue #28: the working signs ship hidden in extras — dots, a caret, a placeholder per held shape — aria-hidden, moved by the theme\'s motion tokens', () => {
  const root = richChat();
  const extras = one(root, 'data-az-chat-extras');
  assert.equal(extras.attrs?.hidden, 'hidden');
  assert.deepEqual(JSON.parse(extras.attrs!['data-az-chat-motion']), {
    enter: SERIES_THEME.motion.emphasis, pulse: SERIES_THEME.motion.slow, slide: SERIES_THEME.motion.slide, ease: SERIES_THEME.motion.ease,
  });
  const [thinking] = slotOf(extras, 'thinking');
  assert.equal(thinking.attrs?.['aria-hidden'], 'true');
  assert.equal((thinking.children ?? []).length, 3);
  assert.equal(slotOf(extras, 'caret')[0].attrs?.['aria-hidden'], 'true');
  for (const name of ['skeleton-figure', 'skeleton-map', 'skeleton-table', 'skeleton-tiles']) assert.equal(slotOf(extras, name)[0]?.attrs?.['aria-hidden'], 'true', name);
  // A prose-only chat has the dots, the caret and the bar, and no placeholders: it holds no rich component.
  const plain = one(chat(['allow anyone']), 'data-az-chat-extras');
  assert.equal(slotOf(plain, 'skeleton-figure').length, 0);
  assert.equal(slotOf(plain, 'thinking').length, 1);
});

test('issue #30: the answer bar is a named group of small icon buttons — Copy here, Share from its part — each named, its tooltip aria-hidden; faint until open', () => {
  const root = richChat();
  const [bar] = slotOf(one(root, 'data-az-chat-extras'), 'bar');
  assert.deepEqual([bar.attrs?.role, bar.attrs?.['aria-label']], ['group', 'Answer actions']);
  assert.equal(bar.style?.color, SERIES_THEME.color['border-strong'], 'faint: the non-text edge colour, still 3:1');
  assert.deepEqual([bar.states?.open?.color, bar.states?.focusWithin?.color, bar.states?.hover?.color], Array(3).fill(SERIES_THEME.color.text));
  const copy = walk(bar).find((n) => n.tag === 'button')!;
  assert.deepEqual([copy.attrs?.type, copy.attrs?.['aria-label']], ['button', 'Copy answer']);
  const tip = walk(bar).find((n) => n.attrs?.['data-az-chat-tip'] !== undefined)!;
  assert.deepEqual([tip.attrs?.['aria-hidden'], tip.attrs?.hidden, texts(tip).join('')], ['true', 'hidden', 'Copy answer']);
  // Share is the same small button now, under the name it had: no full-size button under every answer.
  const [share] = partOf(root, 'share');
  const open = slotOf(share, 'open')[0];
  assert.deepEqual([open.attrs?.['aria-label'], open.attrs?.class], ['Share this answer', 'az-chat-bar-button']);
  assert.equal(texts(open).join(''), '', 'an icon, named by its label');
  assert.equal(((share.children ?? [])[0] as EmittedNode).style?.display, 'contents', 'its button joins the bar\'s row');
});

test('issue #21: a map ships a hidden note for a view deeper than its tiles', () => {
  const [map] = partOf(exploreChat('map'), 'map');
  const [detail] = slotOf(map, 'detail');
  assert.equal(detail.attrs?.hidden, 'hidden');
  assert.equal(detail.style?.color, SERIES_THEME.color.muted);
});
