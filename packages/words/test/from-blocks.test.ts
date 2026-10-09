/**
 * data-spec §10.3: a `from` block emits a shell — skeleton, empty rows
 * container, a template item made by the word's OWN item code, a polite
 * status line, retry and sign-in controls, a noscript line — and a block
 * without `from` emits none of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFor, compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import { FROM_COPY, fromMark, type EmittedNode, type ThemeLike } from '../../core/src/emit-contract.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { emitBlock } from '../../target-web/src/tree.ts';
import { WEB_EMITTERS } from '../registry.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const w of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')))) {
  const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}
const T = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;

const HEAD = ['az 1', 'site shop', '  auth', '    adapter azbackend', '  backend', '    database sqlite', '    email smtp',
  '  data notes', '    title text required', '    body longtext', '    photo image', '    allow anyone read',
  '  data questions', '    question text required', '    answer longtext required', '    allow owner read', '    allow signedin create',
  'page /', '  hero center', '    title "x"'];
const TAIL = ['page /login', '  auth login', ''];

function block(lines: string[], word: string): SpecBlock {
  const r = compile([...HEAD, ...lines, ...TAIL].join('\n'), { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  return blocksFor(r.spec, r.spec.pages[0]).find((b) => b.word === word)!;
}
const emit = (b: SpecBlock) => emitBlock(b, T, WEB_EMITTERS, (p) => p, { name: 'shop' });
const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];
const texts = (n: EmittedNode | string): string[] =>
  typeof n === 'string' ? [n] : (n.children ?? []).flatMap(texts);
const has = (n: EmittedNode, attr: string) => n.attrs !== undefined && Object.hasOwn(n.attrs, attr);
const part = (root: EmittedNode, attr: string) => walk(root).find((n) => has(n, attr));

const FEATURE = ['  feature grid', '    title "Notes"', '    from notes', '      title title', '      text body',
  '      sort created desc', '      limit 4', '      empty "No notes yet"'];
const FAQ = ['  faq', '    title "Asked"', '    from questions', '      question question', '      text answer', '      limit 3'];

test('feature: the shell carries the checked query, the skeleton sized from limit, and the copy', () => {
  const out = emit(block(FEATURE, 'feature'));
  const host = part(out, 'data-az-from')!;
  assert.deepEqual(JSON.parse(host.attrs!['data-az-from']), {
    table: 'notes', label: 'title', query: { limit: 4, sort: '-created' },
    map: { text: 'body', title: 'title' }, types: { text: 'longtext', title: 'text' }, empty: 'No notes yet',
  });
  assert.equal(has(host, 'aria-busy'), false, 'never busy as shipped: with JavaScript off it would stay busy; the runtime sets it');
  assert.equal(host.attrs!['data-az-from-state'], 'loading');
  const skeleton = part(out, 'data-az-from-skeleton')!;
  assert.equal(skeleton.attrs!['aria-hidden'], 'true');
  assert.equal(skeleton.children?.length, 4, 'one skeleton item per row a load can bring');
  const rows = part(out, 'data-az-from-rows')!;
  assert.equal(rows.children, undefined, 'the rows container ships empty: the runtime owns its children');
  const status = part(out, 'data-az-from-status')!;
  assert.equal(status.attrs!.role, 'status');
  const retry = part(out, 'data-az-from-retry')!;
  assert.equal(retry.tag, 'button');
  assert.equal(retry.attrs!.type, 'button');
  assert.equal(retry.attrs!.hidden, 'hidden');
  assert.deepEqual(texts(retry), [FROM_COPY.retry]);
  assert.equal(part(out, 'data-az-from-signin'), undefined, 'anyone reads notes: no sign-in link');
  const noscript = walk(out).find((n) => n.tag === 'noscript')!;
  assert.deepEqual(texts(noscript), [FROM_COPY.noscript]);
});

test('feature: the template item is exactly the item the word emits for the same values', () => {
  const fromOut = emit(block(FEATURE, 'feature'));
  const template = part(fromOut, 'data-az-from-template')!;
  assert.equal(template.attrs!.hidden, 'hidden');
  assert.equal(template.children?.length, 1);
  // The same item written by hand, with the markers as its values.
  const authored = emit(block(['  feature grid', '    title "Notes"',
    `    item "${fromMark('title')}"`, `      text "${fromMark('text')}"`,
    `    item "second"`], 'feature'));
  const items = walk(authored).filter((n) => n.attrs?.class === 'az-feature-item');
  assert.deepEqual(template.children![0], items[0]);
  const list = walk(authored).find((n) => n.attrs?.class === 'az-feature-items')!;
  const { 'data-az-from-template': _t, hidden: _h, ...templateAttrs } = template.attrs!;
  assert.deepEqual(templateAttrs, list.attrs, 'the template list is the word\'s list');
  assert.deepEqual(template.style, list.style);
});

test('faq: the template is question() itself, collapsed by the runtime, with no FAQPage data', () => {
  const out = emit(block(FAQ, 'faq'));
  const template = part(out, 'data-az-from-template')!;
  assert.equal(template.attrs!['data-az-from-behaviour'], 'faq', 'the behaviour moves to the template, for its copies');
  assert.equal(has(template, 'data-az-behaviour'), false, 'the template itself is never wired');
  const toggle = walk(template).find((n) => n.attrs?.class === 'az-faq-toggle')!;
  assert.equal(toggle.attrs!['aria-controls'], 'az-row-panel');
  assert.equal(texts(toggle)[0], fromMark('question'));
  const panel = walk(template).find((n) => n.attrs?.id === 'az-row-panel')!;
  assert.equal(panel.attrs!.role, 'region', 'limit 3 ≤ 6: each answer is a region (faq §7.1)');
  assert.deepEqual(texts(panel), [fromMark('text')]);
  assert.equal(walk(out).some((n) => n.tag === 'script'), false, 'no FAQPage JSON-LD for rows that load later');
  // An owner-read table: some visitor may be signed out, so the sign-in link ships hidden.
  const signin = part(out, 'data-az-from-signin')!;
  assert.equal(signin.attrs!.href, '/login');
  assert.equal(signin.attrs!.hidden, 'hidden');
});

test('a block without from emits no shell; a from block emits the same bytes twice', () => {
  const plain = emit(block(['  feature grid', '    item "One"', '    item "Two"'], 'feature'));
  assert.equal(JSON.stringify(plain).includes('data-az-from'), false);
  const plainFaq = emit(block(['  faq', '    title "Q"', '    item "A?"', '      text "a"'], 'faq'));
  assert.equal(JSON.stringify(plainFaq).includes('data-az-from'), false);
  assert.equal(JSON.stringify(emit(block(FEATURE, 'feature'))), JSON.stringify(emit(block(FEATURE, 'feature'))));
  assert.equal(JSON.stringify(emit(block(FAQ, 'faq'))), JSON.stringify(emit(block(FAQ, 'faq'))));
});

test('reveal: a from block rises as one unit — no skeleton or template item is staggered', () => {
  const out = emit(block(['  feature grid reveal', ...FEATURE.slice(1)], 'feature'));
  assert.ok(has(out, 'data-az-reveal'));
  assert.equal(walk(out).some((n) => has(n, 'data-az-reveal-item')), false);
});

test('gallery: grid fills from a table — the template is the word\'s own image with markers, never an asset path', () => {
  const out = emit(block(['  gallery grid', '    from notes', '      src photo', '      alt title', '      caption title', '      limit 6'], 'gallery'));
  const host = part(out, 'data-az-from')!;
  const config = JSON.parse(host.attrs!['data-az-from']);
  assert.deepEqual([config.label, config.map, config.types], ['src', { alt: 'title', caption: 'title', src: 'photo' }, { alt: 'text', caption: 'text', src: 'image' }]);
  assert.equal(part(out, 'data-az-from-skeleton')!.children?.length, 6);
  const template = part(out, 'data-az-from-template')!;
  const img = walk(template).find((n) => n.tag === 'img')!;
  assert.deepEqual([img.attrs!.src, img.attrs!.alt, img.attrs!.loading], [fromMark('src'), fromMark('alt'), 'lazy']);
  assert.ok(walk(template).some((n) => n.tag === 'figcaption' && texts(n).includes(fromMark('caption'))), 'the caption marker');
  assert.equal(template.attrs!.class.split(' ').includes('az-gallery-items'), true, 'the word\'s own list');
  const plain = emit(block(['  gallery grid', '    image ./a.webp', '      alt "A"', '    image ./b.webp', '      alt "B"'], 'gallery'));
  assert.equal(part(plain, 'data-az-from'), undefined, 'CONTROL: no shell without from');
});

test('feature: media fills from an image field (rows), as a marker the runtime replaces', () => {
  const out = emit(block(['  feature rows', '    from notes', '      title title', '      media photo'], 'feature'));
  const template = part(out, 'data-az-from-template')!;
  const img = walk(template).find((n) => n.tag === 'img')!;
  assert.equal(img.attrs!.src, fromMark('media'));
  // data-spec §8: a row's image has width copies made at upload; the rows
  // runtime writes its srcset beside the same `sizes` a build file gets.
  const plain = emit(block(['  feature rows', '    item "A"', '      text "a"', '      media ./a.webp',
    '    item "B"', '      text "b"', '      media ./b.webp'], 'feature'));
  const own = walk(plain).find((n) => n.tag === 'img')!;
  assert.equal(typeof own.attrs!.sizes, 'string', 'CONTROL: a build file\'s media carries the layout\'s sizes');
  assert.equal(img.attrs!.sizes, own.attrs!.sizes, 'a row\'s media carries the same sizes');
  assert.equal(img.attrs!.srcset, undefined, 'its srcset is the runtime\'s, from the row');
  const bento = (lines: string[]) => walk(emit(block(['  feature bento', '    columns 3', ...lines], 'feature'))).find((n) => n.tag === 'img')!.attrs!.sizes;
  assert.equal(bento(['    from notes', '      title title', '      media photo']),
    bento(['    item "A"', '      media ./a.webp', '    item "B"', '      media ./b.webp', '    item "C"', '      media ./c.webp']), 'bento too');
});

test('gallery: a row\'s image carries the layout\'s sizes, the same as a build image; no cover hint (its file is unknown at build)', () => {
  for (const [head, extra] of [['  gallery grid', ['    columns 4']], ['  gallery grid', ['    ratio 4:3']], ['  gallery masonry', []]] as const) {
    const rows = emit(block([head, ...extra, '    from notes', '      src photo', '      alt title'], 'gallery'));
    const row = walk(part(rows, 'data-az-from-template')!).find((n) => n.tag === 'img')!;
    const plain = emit(block([head, ...extra, '    image ./a.webp', '      alt "A"', '    image ./b.webp', '      alt "B"'], 'gallery'));
    const own = walk(plain).find((n) => n.tag === 'img')!;
    assert.equal(typeof own.attrs!.sizes, 'string', `CONTROL ${head} ${extra.join(' ')}`);
    assert.equal(row.attrs!.sizes, own.attrs!.sizes, `${head} ${extra.join(' ')}`);
    assert.equal(has(row, 'data-az-cover'), false, 'no cover hint on a row');
  }
});
