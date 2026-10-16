/**
 * The rich components (chat-block-spec §20.2, §20.3), through the answer
 * parser: every form reads to its event; model numbers are `src: model`,
 * never anything the model wrote; numbers are the grammar's or the
 * component goes (NaN, Infinity, exponents, hex, separators); labels are
 * clamped at a grapheme boundary; an image is a build key or nothing; a link
 * off the allow-list drops the cards; depth, counts and the answer's caps
 * hold. Then resolveRich: `from` figures become `src: site` with the day,
 * a request that does not parse drops the component, a read that timed out
 * becomes the unavailable note — never the model's numbers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerParser, type AnswerEvent, type AnswerRules } from '../src/server/chat-answer.ts';
import { RICH_LIMITS, clampText, parseNumber, resolveRich, type FiguresRun, type RichBlock } from '../src/server/chat-rich.ts';

const RULES: AnswerRules = {
  show: ['cta', 'chart', 'table', 'stats', 'cards', 'dashboard'],
  quotes: [],
  destinations: ['/', '/shop', '/contact'],
  images: ['i1', 'i2'],
};

function run(answer: string, rules: AnswerRules = RULES): { blocks: unknown[]; text: string; dropped: string[]; record: string } {
  const p = createAnswerParser(rules);
  const events: AnswerEvent[] = [...p.push(answer), ...p.end()];
  return {
    blocks: events.filter((e) => e.type === 'block').map((e) => (e as { block: unknown }).block),
    text: events.filter((e) => e.type === 'text').map((e) => (e as { s: string }).s).join(''),
    dropped: [...p.dropped],
    record: p.record,
  };
}

test('chart: model points become a model chart; one series is named by its title', () => {
  const r = run('Here.\nchart bar "Signups"\n  point "Free" 120\n  point "Team" 45\n');
  assert.deepEqual(r.blocks, [{ chart: { kind: 'bar', title: 'Signups', unit: null, src: 'model', series: [{ name: 'Signups', points: [['Free', 120], ['Team', 45]] }] } }]);
  assert.equal(r.text, 'Here.\n');
  assert.match(r.record, /chart bar "Signups"\n {2}point "Free" 120\n/);
});

test('chart: series, a unit, from; the head shape decides component or prose', () => {
  const two = run('chart line "Visits"\n  unit percent\n  series "2025"\n    point "Jan" 1.5\n    point "Feb" 2\n  series "2026"\n    point "Jan" 3\n    point "Feb" 4\n');
  assert.equal((two.blocks[0] as { chart: { series: unknown[]; unit: string } }).chart.series.length, 2);
  assert.equal((two.blocks[0] as { chart: { unit: string } }).chart.unit, 'percent');
  assert.deepEqual(run('chart bar "By status" from orders count by status\n').blocks, [{ chart: { kind: 'bar', title: 'By status', from: ['orders', 'count', 'by', 'status'] } }]);
  // A sentence that starts with the word is prose.
  assert.deepEqual(run('chart the course of history\n').blocks, []);
  assert.equal(run('chart the course of history\n').text, 'chart the course of history\n');
  assert.equal(run('table of contents\n').text, 'table of contents\n');
});

test('numbers: the grammar\'s or none — NaN, Infinity, exponents, hex, separators and percent signs drop the chart', () => {
  for (const bad of ['NaN', 'Infinity', '-Infinity', '1e9', '0x10', '1,000', '12%', '1.', '.5', '--1', '01', '1234567890123456', '9999999999999999.5']) {
    const r = run(`chart bar "x"\n  point "a" ${bad}\n  point "b" 1\n`);
    assert.deepEqual(r.blocks, [], bad);
    assert.ok(r.dropped.includes('number') || r.dropped.includes('shape'), `${bad}: ${r.dropped.join()}`);
  }
  assert.equal(parseNumber('-0'), 0);
  assert.ok(Object.is(parseNumber('-0'), 0));
  assert.equal(parseNumber('1000000000000000'), 1e15);
  assert.equal(parseNumber('3.25'), 3.25);
  assert.equal(parseNumber('"5"'), null);
});

test('labels are clamped at a grapheme boundary; past the line cap the component goes whole', () => {
  const r = run(`chart bar "${'T'.repeat(500)}"\n  point "${'L'.repeat(1_500)}" 1\n`);
  assert.deepEqual(run(`chart bar "x"\n  point "${'L'.repeat(10_000)}" 1\n`).dropped, ['too_long'], 'a 10 000-character label');
  const c = (r.blocks[0] as { chart: { title: string; series: { points: [string, number][] }[] } }).chart;
  assert.equal([...c.title].length, RICH_LIMITS.title);
  assert.ok(c.title.endsWith('…'));
  assert.equal([...c.series[0].points[0][0]].length, RICH_LIMITS.label);
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  // Kept within the cap in code points, as the page counts, never split: a family is five of them.
  assert.equal(clampText(family.repeat(3), 11), `${family}${family}…`);
  assert.equal(clampText(family.repeat(3), 2), '…');
});

test('caps: series, points, slices, mismatched labels, negative slices', () => {
  const pts = (n: number, pad = '  ') => Array.from({ length: n }, (_, i) => `${pad}point "p${i}" ${i + 1}`).join('\n');
  assert.equal(run(`chart bar "x"\n${pts(RICH_LIMITS.points)}\n`).blocks.length, 1);
  assert.deepEqual(run(`chart bar "x"\n${pts(RICH_LIMITS.points + 1)}\n`).dropped, ['too_many']);
  assert.deepEqual(run(`chart pie "x"\n${pts(RICH_LIMITS.slices + 1)}\n`).dropped, ['too_many']);
  const series = (n: number) => Array.from({ length: n }, (_, s) => `  series "s${s}"\n${pts(2, '    ')}`).join('\n');
  assert.equal(run(`chart line "x"\n${series(4)}\n`).blocks.length, 1);
  assert.deepEqual(run(`chart line "x"\n${series(5)}\n`).dropped, ['too_many']);
  assert.deepEqual(run('chart line "x"\n  series "a"\n    point "x" 1\n    point "y" 2\n  series "b"\n    point "y" 1\n    point "x" 2\n').dropped, ['shape']);
  assert.deepEqual(run('chart pie "x"\n  point "a" -1\n  point "b" 2\n').dropped, ['number']);
  assert.deepEqual(run('chart bar "x"\n  point "a" 1\n  point "a" 2\n').dropped, ['shape'], 'a label twice');
  // Depth 3 is no form: a series of series.
  assert.deepEqual(run('chart line "x"\n  series "a"\n    point "x" 1\n      point "y" 2\n').blocks, []);
});

test('the answer\'s caps: 240 points and 6 requests across components', () => {
  const chart = (title: string) => `chart bar "${title}"\n${Array.from({ length: 24 }, (_, i) => `  point "p${i}" ${i}`).join('\n')}\n`;
  // Four components of 24 are 96 points: within. The answer's component cap is 4 (C2).
  assert.equal(run([1, 2, 3, 4].map((i) => chart(`c${i}`)).join('\n')).blocks.length, 4);
  // Two full tables are 2 × 20 × 6 = 240 points: the cap. A third component of figures is dropped.
  const table = `table "t"\n  columns "a" "b" "c" "d" "e" "f"\n${Array.from({ length: 20 }, () => '  row 1 2 3 4 5 6').join('\n')}\n`;
  const full = run(`${table}${table}${chart('one more')}`);
  assert.equal(full.blocks.length, 2);
  assert.deepEqual(full.dropped, ['too_many']);
  const many = ['stats', ...Array.from({ length: 4 }, (_, i) => `  stat "s${i}" from orders count`)].join('\n');
  const dash = ['dashboard "d"', '  stat "a" from orders count', '  stat "b" from orders count', '  stat "c" from orders count'].join('\n');
  const r = run(`${many}\n${dash}\n`);
  assert.equal(r.blocks.length, 1, 'the second component would make 7 requests');
  assert.deepEqual(r.dropped, ['too_many']);
});

test('table: model columns and rows; a number column only when every cell is a number', () => {
  const r = run('table "Plans" sortable\n  columns "Plan" "Seats"\n  row "Team" 10\n  row "Business" 50\n');
  assert.deepEqual(r.blocks, [{ table: { title: 'Plans', sortable: true, src: 'model', columns: [{ label: 'Plan', type: 'text' }, { label: 'Seats', type: 'number' }], rows: [['Team', 10], ['Business', 50]] } }]);
  assert.deepEqual(run('table "x"\n  columns "a"\n  row "t"\n  row 5\n').dropped, ['shape'], 'a mixed column');
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `  row "r${i}"`).join('\n');
  assert.equal(run(`table "x"\n  columns "a"\n${rows(20)}\n`).blocks.length, 1);
  assert.deepEqual(run(`table "x"\n  columns "a"\n${rows(21)}\n`).dropped, ['too_many']);
  assert.deepEqual(run('table "x"\n  columns "a" "b" "c" "d" "e" "f" "g"\n  row 1 2 3 4 5 6 7\n').dropped, ['too_many']);
  assert.deepEqual(run('table "Top" from orders columns item total\n').blocks, [{ table: { title: 'Top', sortable: false, from: ['orders', 'columns', 'item', 'total'] } }]);
});

test('stats: model values with unit and delta; a closed unit list', () => {
  const r = run('stats\n  stat "Conversion" 3.2 unit percent delta 0.4\n  stat "Orders" from orders count\n');
  assert.deepEqual(r.blocks, [{ stats: [
    { label: 'Conversion', value: 3.2, unit: 'percent', delta: 0.4, src: 'model' },
    { label: 'Orders', from: ['orders', 'count'] },
  ] }]);
  assert.deepEqual(run('stats\n  stat "x" 3 unit %\n').dropped, ['shape']);
  assert.deepEqual(run('stats\n  stat "x" 3 unit USD\n').dropped, ['shape']);
  assert.deepEqual(run(`stats\n${Array.from({ length: 5 }, (_, i) => `  stat "s${i}" ${i}`).join('\n')}\n`).dropped, ['too_many']);
});

test('cards: an image only by a build key — every address is dropped, the card kept; a link only on the allow-list', () => {
  const r = run('cards\n  card "Linen shirt"\n    image i1\n    text "Breathable."\n    link "See it" /shop\n');
  assert.deepEqual(r.blocks, [{ cards: [{ title: 'Linen shirt', text: 'Breathable.', image: { asset: 'i1' }, link: { label: 'See it', to: '/shop' } }] }]);
  for (const image of ['https://collector.example/x.png', '"https://collector.example/x.png"', '//collector.example/x', 'data:image/png;base64,AA', '/assets/i1.webp', 'i1?d=secret', 'i9', '../i1']) {
    const c = run(`cards\n  card "Chair"\n    image ${image}\n`);
    assert.deepEqual(c.blocks, [{ cards: [{ title: 'Chair' }] }], image);
    assert.deepEqual(c.dropped, ['image'], image);
  }
  for (const to of ['https://collector.example/?d=x', 'javascript:alert(1)', '/admin', '/shop?x=1']) {
    assert.deepEqual(run(`cards\n  card "Chair"\n    link "Go" ${to}\n`).dropped, ['destination'], to);
  }
  assert.deepEqual(run('cards from products title name image photo\n').blocks, [{ cards: { from: ['products', 'title', 'name', 'image', 'photo'] } }]);
});

test('dashboard: tiles one level down, their lines one more; never a dashboard inside; 2–6 tiles', () => {
  const r = run('dashboard "This month"\n  stat "Orders" from orders count\n  chart line "Expected"\n    point "Nov" 140\n    point "Dec" 180\n  card "Note"\n    text "Estimates are ours."\n');
  const d = (r.blocks[0] as { dashboard: { title: string; tiles: unknown[] } }).dashboard;
  assert.equal(d.title, 'This month');
  assert.deepEqual(d.tiles.map((t) => Object.keys(t as object)[0]), ['stat', 'chart', 'card']);
  assert.deepEqual(run('dashboard "d"\n  stat "a" 1\n').dropped, ['empty']);
  assert.deepEqual(run('dashboard "d"\n  stat "a" 1\n  dashboard "e"\n').dropped, ['shape']);
  // A series inside a dashboard chart is depth 3: no form.
  assert.deepEqual(run('dashboard "d"\n  stat "a" 1\n  chart line "c"\n    series "s"\n').dropped, ['shape']);
  assert.deepEqual(run('dashboard "d"\n  stat "a" 1\n  stat "b" 2\n', { ...RULES, show: ['dashboard', 'chart'] }).dropped, ['not_shown'], 'a stat tile needs stats in show');
});

test('not shown: a rich word the page does not list is dropped whole', () => {
  assert.deepEqual(run('chart bar "x"\n  point "a" 1\n', { ...RULES, show: ['cta'] }).dropped, ['not_shown']);
});

test('the model cannot write src: a `src` line, a src word, a site-looking line are shapes, not sources', () => {
  for (const a of ['chart bar "x" src site\n  point "a" 1\n', 'chart bar "x"\n  src site\n  point "a" 1\n', 'stats\n  stat "x" 1 src site\n']) {
    const r = run(a);
    assert.ok(!JSON.stringify(r.blocks).includes('"site"'), a);
  }
});

/* ---- resolveRich ----------------------------------------------------------- */

const DAY = '2026-10-15';
const figures = (groups: [string, number][] | null, value: number | null = null, dated = false) =>
  ({ kind: 'figures' as const, unit: null, value, groups, more: false, dated });

test('resolveRich: model figures stay model; `from` figures are the site\'s, with the day', async () => {
  const modelBlock: RichBlock = { chart: { kind: 'bar', title: 'x', unit: null, src: 'model', series: [{ name: 'x', points: [['a', 1]] }] } };
  assert.deepEqual(await resolveRich(modelBlock, null, DAY), { chart: { kind: 'bar', title: 'x', unit: null, src: 'model', series: [{ name: 'x', points: [['a', 1]] }] } });
  const run: FiguresRun = async () => figures([['paid', 3], ['open', 1]]);
  const r = await resolveRich({ chart: { kind: 'bar', title: 'By status', from: ['orders', 'count', 'by', 'status'] } }, run, DAY);
  assert.deepEqual(r, { chart: { kind: 'bar', title: 'By status', unit: null, src: 'site', asOf: DAY, more: false, series: [{ name: 'By status', points: [['paid', 3], ['open', 1]] }] } });
});

test('resolveRich: a stat over months is the latest month and its change', async () => {
  const run: FiguresRun = async () => figures([['2026-09', 30], ['2026-10', 41]], null, true);
  assert.deepEqual(await resolveRich({ stats: [{ label: 'Orders', from: ['orders', 'count', 'by', 'placed', 'month'] }] }, run, DAY),
    { stats: [{ label: 'Orders', value: 41, unit: null, src: 'site', asOf: DAY, delta: 11, deltaOf: '2026-09' }] });
  const cats: FiguresRun = async () => figures([['paid', 3]]);
  assert.equal(await resolveRich({ stats: [{ label: 'x', from: ['orders', 'count', 'by', 'status'] }] }, cats, DAY), null, 'a stat over categories is no stat');
});

test('resolveRich: an unknown request drops; a timed-out read is the note, never a guess; no data at all drops', async () => {
  const block: RichBlock = { chart: { kind: 'bar', title: 'Orders', from: ['orders', 'count', 'by', 'note'] } };
  assert.equal(await resolveRich(block, async () => null, DAY), null);
  assert.deepEqual(await resolveRich(block, async () => 'unavailable', DAY), { unavailable: { title: 'Orders' } });
  assert.equal(await resolveRich(block, null, DAY), null);
  // In a dashboard, one tile's note; the rest stands.
  const d = await resolveRich({ dashboard: { title: 'D', tiles: [
    { stat: { label: 'Orders', from: ['orders', 'count'] } },
    { stat: { label: 'Mine', value: 3, unit: null, src: 'model' } },
  ] } }, async () => 'unavailable', DAY);
  assert.deepEqual(d, { dashboard: { title: 'D', tiles: [{ unavailable: { title: 'Orders' } }, { stat: { label: 'Mine', value: 3, unit: null, src: 'model' } }] } });
});

test('resolveRich: table from figures and from rows; cards from rows carry the server\'s row image', async () => {
  const t = await resolveRich({ table: { title: 'T', sortable: false, from: ['orders', 'sum', 'total', 'by', 'status'] } }, async () => figures([['paid', 35]]), DAY);
  assert.deepEqual(t, { table: { title: 'T', sortable: false, src: 'site', asOf: DAY, columns: [{ label: 'status', type: 'text', unit: null }, { label: 'sum total', type: 'number', unit: null }], rows: [['paid', 35]] } });
  const row = { table: 'products', id: '0b7c3f8e-1d2a-4c5b-8e9f-0a1b2c3d4e5f', field: 'photo' };
  const image = { url: 'https://api.shop.test/data/products/0b7c3f8e-1d2a-4c5b-8e9f-0a1b2c3d4e5f/photo?v=a', width: 800, height: 600, variants: [] };
  const c = await resolveRich({ cards: { from: ['products', 'title', 'name', 'image', 'photo'] } },
    async () => ({ kind: 'cards', items: [{ title: 'Chair', text: null, image, row }] }), DAY);
  assert.deepEqual(c, { cards: [{ title: 'Chair', image: { row, ...image } }] });
});
