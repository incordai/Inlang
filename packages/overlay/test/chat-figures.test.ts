/**
 * The page's checks on an answer's tables, stat cards, image cards and
 * dashboards (chat-block-spec §20.2, §20.6), pure: every limit at the cap and
 * one past it, closed shapes, forged sources; images only by a build key or
 * the backend's exact row path — URL smuggling in every field refused;
 * links only on the allow-list; sorting; delta words that never rely on
 * colour; the announcements (§20.8); and the SVG writer, which sets only
 * geometry and a class.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIGURE_LIMITS, announceOf, deltaWords, sortedRows, validCards, validDashboard, validStats, validTable, writeSvg, type FigureContext,
} from '../src/runtime/chat-figures.ts';
import type { SvgNode } from '../src/runtime/chat-chart.ts';

const BACKEND = 'https://api.shop.test';
const ID = '0b7c3f8e-1d2a-4c5b-8e9f-0a1b2c3d4e5f';
const ctx: FigureContext = {
  assets: new Map([['summer-1', { src: '/assets/summer-1.webp', srcset: '/assets/summer-1-480.webp 480w', width: 1200, height: 800, alt: 'A linen shirt' }]]),
  allowed: (to) => to === '/shop' || to === '/contact',
  backend: BACKEND,
};
const table = (over: Record<string, unknown> = {}) => ({
  title: 'Plans', src: 'model',
  columns: [{ label: 'Plan', type: 'text' }, { label: 'Seats', type: 'number' }],
  rows: [['Team', 10], ['Business', 50]],
  ...over,
});
const rowImage = (over: Record<string, unknown> = {}) => ({
  row: { table: 'products', id: ID, field: 'photo' },
  url: `${BACKEND}/data/products/${ID}/photo?v=abc123`, width: 1600, height: 1200,
  variants: [{ url: `${BACKEND}/data/products/${ID}/photo?v=abc123&w=480`, width: 480 }],
  ...over,
});

test('validTable: a model table passes; limits hold at the cap and fail one past', () => {
  const t = validTable(table());
  assert.ok(t);
  assert.equal(t.src, 'model');
  const cols = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `c${i}`, type: 'text' }));
  const rows = (n: number, w: number) => Array.from({ length: n }, () => Array.from({ length: w }, () => 'x'));
  assert.ok(validTable(table({ columns: cols(FIGURE_LIMITS.columns), rows: rows(1, FIGURE_LIMITS.columns) })));
  assert.equal(validTable(table({ columns: cols(FIGURE_LIMITS.columns + 1), rows: rows(1, FIGURE_LIMITS.columns + 1) })), null);
  assert.ok(validTable(table({ columns: cols(1), rows: rows(FIGURE_LIMITS.rows, 1) })));
  assert.equal(validTable(table({ columns: cols(1), rows: rows(FIGURE_LIMITS.rows + 1, 1) })), null, '21 rows');
  assert.equal(validTable(table({ columns: cols(1), rows: rows(10_000, 1) })), null, 'a huge dataset');
  assert.equal(validTable(table({ rows: [['x'.repeat(FIGURE_LIMITS.cell + 1), 1]] })), null);
  assert.equal(validTable(table({ rows: [['Team', Number.NaN]] })), null);
  assert.equal(validTable(table({ rows: [['Team', Infinity]] })), null);
  assert.equal(validTable(table({ rows: [['Team', '10']] })), null, 'a number column holds numbers');
  assert.equal(validTable(table({ rows: [['Team']] })), null, 'a short row');
  assert.equal(validTable(table({ src: 'site' })), null, 'site figures carry their day');
  assert.ok(validTable(table({ src: 'site', asOf: '2026-10-15' })));
  assert.equal(validTable(table({ html: '<b>x</b>' })), null, 'an unknown key');
  assert.equal(validTable(table({ columns: [{ label: 'Plan', type: 'html' }, { label: 'Seats', type: 'number' }] })), null);
});

test('validStats: values are finite numbers; a delta\'s reference is the server\'s only', () => {
  const s = validStats([{ label: 'Orders', value: 41, unit: null, delta: 5, deltaOf: '2026-09', src: 'site', asOf: '2026-10-15' }]);
  assert.ok(s);
  assert.equal(s[0].delta, 5);
  assert.equal(validStats([{ label: 'Orders', value: 41, src: 'model', deltaOf: '2026-09' }]), null);
  assert.equal(validStats([{ label: 'Orders', value: Number.NaN, src: 'model' }]), null);
  assert.equal(validStats([{ label: 'Orders', value: 1e16, src: 'model' }]), null);
  assert.equal(validStats([{ label: 'Orders', value: '41', src: 'model' }]), null);
  assert.equal(validStats([{ label: 'x'.repeat(FIGURE_LIMITS.statLabel + 1), value: 1, src: 'model' }]), null);
  assert.equal(validStats(Array.from({ length: FIGURE_LIMITS.stats + 1 }, () => ({ label: 'a', value: 1, src: 'model' }))), null);
  assert.equal(validStats([{ label: 'Rate', value: 3.2, unit: '%', src: 'model' }]), null, 'units from the closed set only');
});

test('validCards: a tool\'s card carries its label and minute; a card claiming a source any other way is refused (chat-block-spec §19.11)', () => {
  const meta = { src: 'tool', source: 'Race results service', asOf: '2026-10-16T14:05Z' };
  const tool = validCards([{ title: 'Ana', text: 'Red', image: { asset: 'summer-1' }, ...meta }, { title: 'Ben', ...meta }], ctx);
  assert.ok(tool);
  assert.deepEqual(tool.map((c) => c.source), [{ label: 'Race results service', asOf: '2026-10-16T14:05Z' }, { label: 'Race results service', asOf: '2026-10-16T14:05Z' }]);
  assert.equal(tool[0].image?.src, '/assets/summer-1.webp', 'an image only by the site\'s own key');
  // CONTROL: a model's or a table's card says nothing of a source.
  assert.equal(validCards([{ title: 'Chair' }], ctx)?.[0].source, null);
  for (const bad of [
    { title: 'x', src: 'model' }, { title: 'x', src: 'site', asOf: '2026-10-16' }, { title: 'x', src: 'tool', source: 'S' },
    { title: 'x', src: 'tool', asOf: '2026-10-16T14:05Z' }, { title: 'x', source: 'S', asOf: '2026-10-16T14:05Z' },
    { title: 'x', ...meta, asOf: '2026-10-16' }, { title: 'x', ...meta, source: 'x'.repeat(41) },
  ]) assert.equal(validCards([bad], ctx), null, JSON.stringify(bad));
});

test('validCards: images by build key or the backend\'s exact row path — every smuggled URL is refused', () => {
  const asset = validCards([{ title: 'Linen shirt', image: { asset: 'summer-1' }, text: 'Breathable.', link: { label: 'See it', to: '/shop' } }], ctx);
  assert.ok(asset);
  assert.equal(asset[0].image?.src, '/assets/summer-1.webp');
  assert.equal(asset[0].image?.alt, 'A linen shirt', 'the author\'s alt, never the model\'s');
  const row = validCards([{ title: 'Chair', image: rowImage() }], ctx);
  assert.ok(row?.[0].image);
  assert.equal(row[0].image.src, `${BACKEND}/data/products/${ID}/photo?v=abc123`);
  assert.match(row[0].image.srcset ?? '', /&w=480 480w/);
  const smuggled: unknown[] = [
    { asset: 'https://collector.example/x.png' }, { asset: '//collector.example/x' }, { asset: 'summer-1?d=secret' },
    { asset: 'data:image/png;base64,AAAA' }, { asset: 'unknown-key' }, { url: 'https://collector.example/x.png' },
    'https://collector.example/x.png',
    rowImage({ url: `https://collector.example/data/products/${ID}/photo?v=abc123` }),
    rowImage({ url: `${BACKEND}/data/products/${ID}/photo?v=abc123&d=secret` }),
    rowImage({ url: `${BACKEND}/data/orders/${ID}/photo?v=abc123` }),
    rowImage({ url: `${BACKEND}/collect?d=${ID}` }),
    rowImage({ variants: [{ url: 'https://collector.example/x.png', width: 480 }] }),
    rowImage({ row: { table: 'products', id: '../../x', field: 'photo' } }),
    rowImage({ alt: 'model alt' }),
  ];
  for (const image of smuggled) {
    const c = validCards([{ title: 'Chair', image }], ctx);
    assert.ok(c, `the card keeps its text: ${JSON.stringify(image)}`);
    assert.equal(c[0].image, null, `no image from ${JSON.stringify(image)}`);
  }
  for (const link of [{ label: 'Claim', to: 'https://collector.example/?d=x' }, { label: 'x', to: 'javascript:alert(1)' }, { label: 'x', to: '/admin' }]) {
    assert.equal(validCards([{ title: 'Chair', link }], ctx), null, `a link off the allow-list drops the card: ${link.to}`);
  }
  assert.equal(validCards([{ title: 'x'.repeat(FIGURE_LIMITS.cardTitle + 1) }], ctx), null);
  assert.equal(validCards([{ title: 'Chair', text: 'x'.repeat(FIGURE_LIMITS.cardText + 1) }], ctx), null);
  assert.equal(validCards(Array.from({ length: FIGURE_LIMITS.cards + 1 }, () => ({ title: 'a' })), ctx), null);
});

test('validDashboard: 2–6 tiles, at most 4 charts or tables, never a dashboard in a dashboard', () => {
  const stat = { stat: { label: 'Orders', value: 41, src: 'site', asOf: '2026-10-15' } };
  const chart = { chart: { kind: 'bar', title: 'By status', unit: null, src: 'model', series: [{ name: 's', points: [['a', 1]] }] } };
  const d = validDashboard({ title: 'This month', tiles: [stat, chart] }, ctx);
  assert.ok(d);
  assert.deepEqual(d.tiles.map((t) => t.kind), ['stat', 'chart']);
  assert.equal(validDashboard({ title: 'x', tiles: [stat] }, ctx), null);
  assert.equal(validDashboard({ title: 'x', tiles: Array.from({ length: 7 }, () => stat) }, ctx), null);
  assert.equal(validDashboard({ title: 'x', tiles: [stat, chart, chart, chart, chart, chart] }, ctx), null);
  assert.equal(validDashboard({ title: 'x', tiles: [stat, { dashboard: { title: 'y', tiles: [stat, stat] } }] }, ctx), null);
  assert.equal(validDashboard({ title: 'x', tiles: [stat, { stat: stat.stat, chart: chart.chart }] }, ctx), null);
});

test('sortedRows: numbers numerically, text by the collator, empty cells last, stable', () => {
  const rows = [['b', 10], ['a', 2], ['c', null], ['a', 2]] as const;
  const coll = new Intl.Collator('en');
  assert.deepEqual(sortedRows(rows, 1, 'number', 'ascending', coll), [['a', 2], ['a', 2], ['b', 10], ['c', null]]);
  assert.deepEqual(sortedRows(rows, 1, 'number', 'descending', coll), [['b', 10], ['a', 2], ['a', 2], ['c', null]]);
  assert.deepEqual(sortedRows(rows, 0, 'text', 'ascending', coll).map((r) => r[0]), ['a', 'a', 'b', 'c']);
});

test('deltaWords: a sign, a glyph and a word — never colour alone', () => {
  const f = (n: number) => String(n);
  assert.deepEqual(deltaWords(5, f, '2026-09'), { glyph: '▲', words: 'up 5 vs 2026-09' });
  assert.deepEqual(deltaWords(-3, f, null), { glyph: '▼', words: 'down 3' });
  assert.deepEqual(deltaWords(0, f, null), { glyph: '', words: 'no change' });
});

test('announceOf: one sentence per finished component, naming the AI label when present', () => {
  const t = validTable(table());
  assert.ok(t);
  assert.equal(announceOf({ kind: 'table', data: t }), 'Table: Plans, 2 rows, AI-generated figures');
  const site = validTable(table({ src: 'site', asOf: '2026-10-15' }));
  assert.ok(site);
  assert.equal(announceOf({ kind: 'table', data: site }), 'Table: Plans, 2 rows');
});

/** A document just big enough for writeSvg. */
function fakeDocument() {
  interface El { tag: string; ns: string; attrs: Map<string, string>; children: El[]; textContent: string | null; setAttribute(k: string, v: string): void; appendChild(c: El): El }
  return {
    createElementNS(ns: 'http://www.w3.org/2000/svg', tag: string): El {
      const el: El = {
        tag, ns, attrs: new Map(), children: [], textContent: '',
        setAttribute(k, v) { el.attrs.set(k, v); },
        appendChild(c) { el.children.push(c); return c; },
      };
      return el;
    },
  };
}

test('writeSvg: SVG namespace, geometry attributes only, fill only as this tree\'s own pattern, a class per part', () => {
  const tree: SvgNode = {
    tag: 'svg', attrs: { viewBox: '0 0 10 10', onload: 'alert(1)', style: 'fill:red', href: 'https://collector.example/' },
    children: [
      { tag: 'defs', attrs: {}, children: [{ tag: 'pattern', attrs: { id: 'a1-p2' }, children: [] }] },
      { tag: 'rect', attrs: { x: '1', fill: 'url(#a1-p2)' }, part: 'patterned-2' },
      { tag: 'rect', attrs: { x: '2', fill: 'url(https://collector.example/x)' }, part: 'fill-1' },
      { tag: 'rect', attrs: { x: '3', fill: 'red' }, part: 'unknown' },
      { tag: 'text', attrs: { x: '4' }, part: 'label', text: '<img src=x onerror=alert(1)>' },
    ],
  };
  const doc = fakeDocument();
  const svg = writeSvg(doc, tree, (p) => (p === 'unknown' ? null : `c-${p}`));
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.deepEqual([...svg.attrs.keys()], ['viewBox']);
  const [, patterned, bad, unknown, label] = svg.children;
  assert.equal(patterned.attrs.get('fill'), 'url(#a1-p2)');
  assert.equal(patterned.attrs.get('class'), 'c-patterned-2');
  assert.equal(bad.attrs.has('fill'), false, 'a fill to anything but this tree\'s pattern is dropped');
  assert.equal(unknown.attrs.has('fill'), false);
  assert.equal(unknown.attrs.has('class'), false);
  assert.equal(label.textContent, '<img src=x onerror=alert(1)>', 'text is text');
  assert.equal(label.children.length, 0);
});

test('a tool\'s figures (chat-block-spec §21.2.4): src tool needs its UTC minute and the operator\'s label; nothing else may carry a label', async () => {
  const { validChart, SOURCE_MAX } = await import('../src/runtime/chat-chart.ts');
  const tool = { src: 'tool', source: 'Race results service', asOf: '2026-10-16T14:05Z' };
  const chart = (over: Record<string, unknown>) => ({ kind: 'bar', title: 'Points', unit: null, series: [{ name: 'Points', points: [['Ana', 25], ['Ben', 18]] }], ...over });
  assert.deepEqual(validTable(table(tool)), { title: 'Plans', columns: [{ label: 'Plan', type: 'text', unit: null }, { label: 'Seats', type: 'number', unit: null }], rows: [['Team', 10], ['Business', 50]], sortable: false, ...tool });
  assert.equal(validChart(chart({ ...tool, more: true }))?.source, 'Race results service');
  const stat = { label: 'Most', value: 25, unit: null, ...tool };
  assert.deepEqual(validStats([{ ...stat, delta: 2, deltaOf: '2026-10-15' }])?.[0], { label: 'Most', value: 25, unit: null, delta: 2, deltaOf: '2026-10-15', ...tool });
  const forged: Record<string, unknown>[] = [
    { src: 'tool', asOf: '2026-10-16T14:05Z' },
    { src: 'tool', source: '', asOf: '2026-10-16T14:05Z' },
    { src: 'tool', source: 'x'.repeat(SOURCE_MAX + 1), asOf: '2026-10-16T14:05Z' },
    { src: 'tool', source: 'Race results service' },
    { src: 'tool', source: 'Race results service', asOf: '2026-10-16' },
    { src: 'tool', source: 'Race results service', asOf: '2026-10-16T14:05:00Z' },
    { src: 'model', source: 'Race results service' },
    { src: 'site', source: 'Race results service', asOf: '2026-10-16' },
    { src: 'operator', source: 'Race results service', asOf: '2026-10-16T14:05Z' },
  ];
  for (const f of forged) {
    assert.equal(validTable(table(f)), null, JSON.stringify(f));
    assert.equal(validChart(chart(f)), null, JSON.stringify(f));
    assert.equal(validStats([{ label: 'Most', value: 25, ...f }]), null, JSON.stringify(f));
  }
  assert.equal(validTable(table({ ...tool, source: 'x'.repeat(SOURCE_MAX) }))?.source, 'x'.repeat(SOURCE_MAX), 'CONTROL: the label at its cap');
  // A tool's figures are not the model's: no AI label in what is announced.
  assert.equal(announceOf({ kind: 'table', data: validTable(table(tool))! }), 'Table: Plans, 2 rows');
});
