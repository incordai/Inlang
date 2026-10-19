/**
 * The chart renderer's geometry (chat-block-spec §20.4) and its strict
 * validation (§20.2), pure: nice ticks over a table of domains, bars from
 * zero, line/area/pie/donut paths for fixed inputs, the full slice, label
 * thinning, rounding, determinism, the summary and table equivalent
 * (§20.8) — and every figure that is not a finite number in range refused
 * before geometry sees it. A source scan holds the module to paint by part.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHART_LIMITS, VALUE_MAX, chartBox, chartGeometry, chartRows, chartSummary, niceTicks, round2, thinned, validChart,
  CHART_MIN, ROUND_MAX, MARK_ATTR, chartLayout, markText, nearestMark, tipPlace,
  type ChartData, type SvgNode,
} from '../src/chat-chart.ts';

const fmt = (n: number) => String(n);
const model = (over: Record<string, unknown> = {}) => ({
  kind: 'bar', title: 'Signups', unit: null, src: 'model',
  series: [{ name: 'Signups', points: [['Free', 120], ['Team', 45], ['Business', 12]] }],
  ...over,
});
const chart = (over: Record<string, unknown> = {}): ChartData => {
  const c = validChart(model(over));
  assert.ok(c, 'fixture must be valid');
  return c;
};
const walk = (n: SvgNode, out: SvgNode[] = []): SvgNode[] => {
  out.push(n);
  for (const c of n.children ?? []) walk(c, out);
  return out;
};

test('niceTicks: 1, 2 or 5 × 10^k steps, 3 to 6 ticks, bounds covering the data', () => {
  const cases: [number, number, boolean, number[]][] = [
    [0, 1, true, [0, 0.2, 0.4, 0.6, 0.8, 1]],
    [0, 7, true, [0, 2, 4, 6, 8]],
    [3, 41, true, [0, 10, 20, 30, 40, 50]],
    [-5, 12, true, [-5, 0, 5, 10, 15]],
    [0.001, 0.009, false, [0, 0.002, 0.004, 0.006, 0.008, 0.01]],
    [1, 1e15, true, [0, 2e14, 4e14, 6e14, 8e14, 1e15]],
    [120, 180, false, [120, 140, 160, 180]],
  ];
  for (const [lo, hi, zero, want] of cases) {
    const t = niceTicks(lo, hi, zero);
    assert.deepEqual(t.values, want, `${lo}..${hi}`);
    assert.ok(t.values.length >= 3 && t.values.length <= 6, `${lo}..${hi}: ${t.values.length} ticks`);
    assert.ok(t.min <= Math.min(lo, zero ? 0 : lo) && t.max >= hi, `${lo}..${hi} covered`);
  }
});

test('niceTicks: 3 to 6 ticks covering the data on 5 000 seeded domains', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 5000; i++) {
    const scale = 10 ** Math.floor(rnd() * 16 - 4);
    const a = (rnd() * 2 - 1) * scale;
    const b = a + rnd() * scale;
    for (const zero of [true, false]) {
      const t = niceTicks(a, b, zero);
      assert.ok(t.values.length >= 3 && t.values.length <= 6, `${a}..${b}: ${t.values.length}`);
      assert.ok(t.min <= (zero ? Math.min(a, 0) : a) && t.max >= (zero ? Math.max(b, 0) : b), `${a}..${b} covered by ${t.min}..${t.max}`);
    }
  }
});

test('niceTicks: a flat domain opens around its value; zero is included when asked', () => {
  assert.deepEqual(niceTicks(0, 0, true).values.slice(0, 1), [0]);
  assert.ok(niceTicks(0, 0, true).max > 0);
  const flat = niceTicks(50, 50, false);
  assert.ok(flat.min < 50 && flat.max > 50);
  assert.equal(niceTicks(20, 30, true).min, 0);
});

test('validChart: a well-formed model chart passes and keeps its figures', () => {
  const c = chart();
  assert.equal(c.kind, 'bar');
  assert.equal(c.src, 'model');
  assert.deepEqual(c.series[0].points.map((p) => p[1]), [120, 45, 12]);
  assert.equal(c.asOf, null);
});

test('validChart: NaN, Infinity, out-of-range, strings and -0 — never a figure geometry sees', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity, VALUE_MAX * 10, '12', null, true, [1]]) {
    assert.equal(validChart(model({ series: [{ name: 's', points: [['a', bad], ['b', 1]] }] })), null, `refused ${String(bad)}`);
  }
  const zero = chart({ series: [{ name: 's', points: [['a', -0], ['b', 1]] }] });
  assert.ok(Object.is(zero.series[0].points[0][1], 0), '-0 becomes 0');
});

test('validChart: every limit holds at the cap and fails one past it', () => {
  const points = (n: number) => Array.from({ length: n }, (_, i) => [`p${i}`, i]);
  assert.ok(validChart(model({ series: [{ name: 's', points: points(CHART_LIMITS.points) }] })));
  assert.equal(validChart(model({ series: [{ name: 's', points: points(CHART_LIMITS.points + 1) }] })), null);
  const four = Array.from({ length: CHART_LIMITS.series }, (_, i) => ({ name: `s${i}`, points: points(3) }));
  assert.ok(validChart(model({ series: four })));
  assert.equal(validChart(model({ series: [...four, { name: 'x', points: points(3) }] })), null);
  assert.ok(validChart(model({ title: 't'.repeat(CHART_LIMITS.title) })));
  assert.equal(validChart(model({ title: 't'.repeat(CHART_LIMITS.title + 1) })), null);
  assert.ok(validChart(model({ series: [{ name: 's', points: [['l'.repeat(CHART_LIMITS.label), 1]] }] })));
  assert.equal(validChart(model({ series: [{ name: 's', points: [['l'.repeat(CHART_LIMITS.label + 1), 1]] }] })), null);
  // A 10 000-character label (a label-overflow attack) is refused whole.
  assert.equal(validChart(model({ series: [{ name: 's', points: [['x'.repeat(10_000), 1]] }] })), null);
  assert.equal(validChart(model({ kind: 'pie', series: [{ name: 's', points: points(CHART_LIMITS.slices + 1).map(([l]) => [l, 1]) }] })), null);
});

test('validChart: the shape is closed — unknown keys, forged sources and mismatched series are refused', () => {
  assert.equal(validChart(model({ href: 'https://example.invalid/' })), null);
  assert.equal(validChart(model({ src: 'server' })), null);
  assert.equal(validChart(model({ src: 'site' })), null, 'site figures carry the day they were read');
  assert.ok(validChart(model({ src: 'site', asOf: '2026-10-15' })));
  assert.equal(validChart(model({ asOf: '2026-10-15' })), null, 'a model chart has no as-of day');
  assert.equal(validChart(model({ more: true })), null);
  assert.equal(validChart(model({ unit: 'USD' })), null);
  assert.equal(validChart(model({ unit: 'javascript:' })), null);
  assert.ok(validChart(model({ unit: 'usd' })));
  assert.equal(validChart(model({ kind: 'scatter' })), null);
  assert.equal(validChart(model({ series: [
    { name: 'a', points: [['x', 1], ['y', 2]] }, { name: 'b', points: [['y', 1], ['x', 2]] },
  ] })), null, 'series labels in a different order');
  assert.equal(validChart(model({ series: [{ name: 'a', points: [['x', 1], ['x', 2]] }] })), null, 'a label twice');
  assert.equal(validChart(model({ kind: 'pie', series: [{ name: 'a', points: [['x', -1], ['y', 2]] }] })), null);
  assert.equal(validChart(model({ kind: 'pie', series: [{ name: 'a', points: [['x', 0], ['y', 0]] }] })), null);
  assert.equal(validChart(model({ kind: 'line', series: [{ name: 'a', points: [['x', 1]] }] })), null, 'a line needs two points');
});

test('chartGeometry: bars start at zero, sit in bands, and paint only by part', () => {
  const box = chartBox(640, 14);
  const g = chartGeometry(chart(), box, 'c1', fmt);
  const rects = walk(g).filter((n) => n.tag === 'rect');
  assert.equal(rects.length, 3);
  const bottoms = rects.map((r) => round2(Number(r.attrs.y) + Number(r.attrs.height)));
  assert.equal(new Set(bottoms).size, 1, 'every bar ends on the zero line');
  const heights = rects.map((r) => Number(r.attrs.height));
  assert.ok(heights[0] > heights[1] && heights[1] > heights[2]);
  assert.ok(rects.every((r) => r.part === 'fill-1'));
  for (const n of walk(g)) {
    assert.equal(n.attrs.style, undefined);
    assert.equal(n.attrs.stroke, undefined);
    assert.ok(n.attrs.fill === undefined || /^url\(#c1-p[2-6]\)$/.test(n.attrs.fill), `fill ${n.attrs.fill}`);
  }
  assert.equal(g.attrs.viewBox, '0 0 640 384');
});

test('chartGeometry: negative bars hang below the zero line', () => {
  const g = chartGeometry(chart({ series: [{ name: 's', points: [['a', -5], ['b', 12]] }] }), chartBox(640, 14), 'c', fmt);
  const [neg, pos] = walk(g).filter((n) => n.tag === 'rect');
  assert.equal(round2(Number(neg.attrs.y)), round2(Number(pos.attrs.y) + Number(pos.attrs.height)));
});

test('chartGeometry: series past the first are patterned, and the pattern is defined with the chart', () => {
  const g = chartGeometry(chart({ series: [
    { name: '2025', points: [['Free', 120], ['Team', 45]] },
    { name: '2026', points: [['Free', 160], ['Team', 70]] },
  ] }), chartBox(640, 14), 'a7', fmt);
  const nodes = walk(g);
  const patterns = nodes.filter((n) => n.tag === 'pattern');
  assert.deepEqual(patterns.map((p) => p.attrs.id), ['a7-p2']);
  const second = nodes.filter((n) => n.part === 'patterned-2');
  assert.equal(second.length, 2);
  assert.ok(second.every((n) => n.attrs.fill === 'url(#a7-p2)'));
});

test('chartGeometry: line and area paths for a fixed input, byte for byte', () => {
  const data = chart({ kind: 'line', series: [{ name: 'Visitors', points: [['Jan', 10], ['Feb', 30], ['Mar', 20]] }] });
  const g = chartGeometry(data, chartBox(400, 10), 'l', fmt);
  const line = walk(g).find((n) => n.part === 'line-1');
  assert.ok(line);
  assert.match(line.attrs.d, /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
  // Same input, same width: same bytes.
  assert.equal(JSON.stringify(g), JSON.stringify(chartGeometry(data, chartBox(400, 10), 'l', fmt)));
  const area = chartGeometry({ ...data, kind: 'area' }, chartBox(400, 10), 'l', fmt);
  const fill = walk(area).find((n) => n.tag === 'path' && n.part === 'fill-1' && n.attrs.d.endsWith('Z') && n.attrs.d.includes('L'));
  assert.ok(fill, 'an area is the line closed to the zero line');
  // Markers: one per point, plus the end label.
  assert.equal(walk(g).filter((n) => n.tag === 'path' && n.part === 'fill-1').length, 3);
  assert.equal(walk(g).filter((n) => n.part === 'label').length, 1);
});

test('chartGeometry: coordinates are rounded to 0.01', () => {
  const g = chartGeometry(chart({ kind: 'line', series: [{ name: 's', points: [['a', 1 / 3], ['b', 2 / 3], ['c', 1]] }] }), chartBox(333, 13), 'r', fmt);
  for (const n of walk(g)) {
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k === 'd') for (const num of v.match(/-?\d+(?:\.\d+)?/g) ?? []) assert.ok(!/\.\d{3,}/.test(num), `${k} ${num}`);
      else if (/^(x|y|x1|x2|y1|y2|width|height)$/.test(k)) assert.ok(!/\.\d{3,}/.test(v), `${k} ${v}`);
    }
  }
});

test('chartGeometry: pie and donut slices, clockwise from 12 o\'clock; a single slice is a full ring', () => {
  const data = chart({ kind: 'pie', series: [{ name: 'Status', points: [['Paid', 3], ['Open', 1]] }] });
  const box = chartBox(400, 10);
  const slices = walk(chartGeometry(data, box, 'p', fmt)).filter((n) => n.tag === 'path' && n.part !== 'pattern-ink');
  assert.equal(slices.length, 2);
  const cx = box.width / 2;
  const r = Math.min(box.width, box.height) / 2 - box.font;
  assert.ok(slices[0].attrs.d.startsWith(`M${round2(cx)} ${round2(box.height / 2 - r)}A`), slices[0].attrs.d);
  assert.match(slices[0].attrs.d, / 0 1 1 /, 'three quarters takes the large arc');
  const donut = walk(chartGeometry({ ...data, kind: 'donut' }, box, 'p', fmt)).filter((n) => n.tag === 'path' && n.part === 'fill-1');
  assert.equal((donut[0].attrs.d.match(/A/g) ?? []).length, 2, 'a donut slice has an outer and an inner arc');
  const whole = walk(chartGeometry(chart({ kind: 'pie', series: [{ name: 's', points: [['All', 5], ['None', 0]] }] }), box, 'p', fmt))
    .filter((n) => n.tag === 'path' && n.part === 'fill-1');
  assert.equal(whole.length, 1);
  assert.equal((whole[0].attrs.d.match(/A/g) ?? []).length, 2, 'two half arcs make the ring');
});

test('thinned: labels never overlap, first and last always kept', () => {
  const labels = Array.from({ length: 24 }, (_, i) => `Month ${i}`);
  const shown = thinned(labels, 12, 14);
  assert.equal(shown[0], 0);
  assert.equal(shown[shown.length - 1], 23);
  const step = shown[1] - shown[0];
  assert.ok(step * 12 >= 'Month 23'.length * 14 * 0.6, 'a gap wide enough for the widest label');
  assert.deepEqual(thinned(['a', 'b', 'c'], 100, 14), [0, 1, 2]);
  // Issue #29: a dashboard tile's three-bar chart, about 88 px a band, keeps all three labels — the estimate runs wide already.
  assert.deepEqual(thinned(['paid', 'open', 'cancelled'], 88, 14), [0, 1, 2]);
});

test('chartBox (issue #29): drawn at its own width from 200 to 960 px — a dashboard tile is not a scaled-down picture — three fifths as tall, at least 200', () => {
  // A 240-px tile is drawn 240 wide, so its text is the theme's size; before, it was drawn 280 wide and shrunk to fit.
  assert.deepEqual(chartBox(240, 14), { width: 240, height: 200, font: 14 });
  assert.deepEqual(chartBox(100, 14), { width: CHART_MIN, height: 200, font: 14 });
  assert.deepEqual(chartBox(2000, 14), { width: 960, height: 576, font: 14 });
  assert.deepEqual(chartBox(Number.NaN, 14), { width: CHART_MIN, height: 200, font: 14 });
});

test('chartBox (issue #29): a pie or donut is a square at most ROUND_MAX across plus its margin, whatever the width it is given', () => {
  assert.equal(ROUND_MAX, 200);
  assert.deepEqual(chartBox(640, 14, true), { width: ROUND_MAX + 28, height: ROUND_MAX + 28, font: 14 });
  assert.deepEqual(chartBox(220, 14, true), { width: 220, height: 220, font: 14 });
  assert.deepEqual(chartBox(Number.NaN, 14, true), { width: CHART_MIN, height: CHART_MIN, font: 14 });
  const box = chartBox(900, 14, true);
  const slices = walk(chartGeometry(chart({ kind: 'pie', series: [{ name: 's', points: [['a', 3], ['b', 1]] }] }), box, 'p', fmt))
    .filter((n) => n.tag === 'path' && n.part !== 'pattern-ink');
  const radius = Number(/A([\d.]+) /.exec(slices[0].attrs.d)?.[1]);
  assert.ok(radius * 2 <= ROUND_MAX, `a ${radius * 2}-px pie`);
});

test('niceTicks (issue #29): `most` caps the ticks — a short plot gets fewer ticks, not smaller text — three or more from a cap of four', () => {
  for (const most of [3, 4, 5, 6]) {
    for (const [lo, hi, zero] of [[0, 100, true], [3, 41, true], [-5, 12, true], [120, 180, false], [1, 1e15, true], [0.001, 0.009, false]] as const) {
      const t = niceTicks(lo, hi, zero, most);
      // A cap of three cannot always be met by nice steps of three ticks (0..41 is 0, 50): there the bounds alone.
      assert.ok(t.values.length >= (most >= 4 ? 3 : 2) && t.values.length <= most, `${lo}..${hi} at most ${most}: ${t.values.join(' ')}`);
      assert.ok(t.min <= (zero ? Math.min(lo, 0) : lo) && t.max >= hi, `${lo}..${hi} covered`);
    }
  }
  // The default is the six it always was.
  assert.deepEqual(niceTicks(0, 1, true).values, niceTicks(0, 1, true, 6).values);
  // A 200-px chart's plot holds five ticks at most; a 640-px one six.
  const ys = (w: number) => walk(chartGeometry(chart({ series: [{ name: 's', points: [['a', 0], ['b', 1]] }] }), chartBox(w, 14), 'y', fmt))
    .filter((n) => n.tag === 'text' && n.attrs['text-anchor'] === 'end').length;
  assert.ok(ys(200) <= 5, `${ys(200)} ticks at 200 px`);
  assert.equal(ys(640), 6);
});

test('chartLayout (issue #29): every bar, point and slice is a mark, in reading order — by label, then series — tagged on its node, anchored where its tooltip points', () => {
  const box = chartBox(640, 14);
  const one = chartLayout(chart(), box, 'm', fmt);
  assert.deepEqual(one.marks.map((m) => [m.label, m.series, m.value]), [['Free', 0, 120], ['Team', 0, 45], ['Business', 0, 12]]);
  const nodes = walk(one.svg).filter((n) => n.attrs[MARK_ATTR] !== undefined);
  assert.deepEqual(nodes.map((n) => [n.tag, n.attrs[MARK_ATTR]]), [['rect', '0'], ['rect', '1'], ['rect', '2']]);
  // A bar's tooltip points at the middle of its top.
  const bar = nodes[0].attrs;
  assert.deepEqual([one.marks[0].x, one.marks[0].y], [round2(Number(bar.x) + Number(bar.width) / 2), Number(bar.y)]);
  assert.equal(JSON.stringify(one.svg), JSON.stringify(chartGeometry(chart(), box, 'm', fmt)), 'the same nodes as chartGeometry');
  // Two series: label-major, so the arrow keys walk across a group before the next.
  const two = chartLayout(chart({ kind: 'line', series: [{ name: 'A', points: [['x', 1], ['y', 2]] }, { name: 'B', points: [['x', 3], ['y', 4]] }] }), box, 'l', fmt);
  assert.deepEqual(two.marks.map((m) => [m.label, m.series]), [['x', 0], ['x', 1], ['y', 0], ['y', 1]]);
  const tagged = walk(two.svg).filter((n) => n.attrs[MARK_ATTR] !== undefined).map((n) => [n.part, n.attrs[MARK_ATTR]]);
  assert.deepEqual(tagged, [['fill-1', '0'], ['fill-1', '2'], ['fill-2', '1'], ['fill-2', '3']], 'markers carry their reading-order index');
  // A slice is a mark with its angles; a slice of nothing is none.
  const pie = chartLayout(chart({ kind: 'pie', series: [{ name: 'Status', points: [['Paid', 3], ['None', 0], ['Open', 1]] }] }), chartBox(400, 10, true), 'p', fmt);
  assert.deepEqual(pie.marks.map((m) => [m.label, m.from, m.to]), [['Paid', 0, round2(Math.PI * 1.5)], ['Open', round2(Math.PI * 1.5), round2(Math.PI * 2)]]);
});

test('markText, nearestMark and tipPlace (issue #29): what a tooltip says, which mark a pointer is over, and where the tooltip sits — inside the chart', () => {
  const c = chart();
  const box = chartBox(640, 14);
  const { marks } = chartLayout(c, box, 'm', fmt);
  assert.equal(markText(c, marks[1], fmt), 'Team: 45');
  const two = chart({ series: [{ name: 'A', points: [['x', 1]] }, { name: 'B', points: [['x', 3]] }] });
  assert.equal(markText(two, chartLayout(two, box, 't', fmt).marks[1], fmt), 'x, B: 3');
  const pieData = chart({ kind: 'pie', series: [{ name: 'Status', points: [['Paid', 3], ['Open', 1]] }] });
  const pieBox = chartBox(400, 10, true);
  const pie = chartLayout(pieData, pieBox, 'p', fmt).marks;
  assert.equal(markText(pieData, pie[0], fmt), 'Paid: 3 (75%)');
  // A pointer anywhere over a bar's band finds that bar; over a slice, that slice; outside the ring, nothing.
  assert.equal(nearestMark(c, box, marks, marks[2].x + 3, box.height - 20), 2);
  assert.equal(nearestMark(pieData, pieBox, pie, pieBox.width / 2 + 30, pieBox.height / 2 - 10), 0, 'the upper right is Paid');
  assert.equal(nearestMark(pieData, pieBox, pie, pieBox.width / 2 - 30, pieBox.height / 2 - 30), 1, 'the upper left is Open');
  assert.equal(nearestMark(pieData, pieBox, pie, 0, 0), -1);
  assert.equal(nearestMark(c, box, [], 10, 10), -1);
  // Above its mark; below when there is no room above; never past an edge.
  assert.deepEqual(tipPlace({ label: 'a', series: 0, value: 1, x: 300, y: 100 }, box, 80, 24), { x: 260, y: 69 });
  assert.deepEqual(tipPlace({ label: 'a', series: 0, value: 1, x: 300, y: 10 }, box, 80, 24), { x: 260, y: 17 });
  assert.deepEqual(tipPlace({ label: 'a', series: 0, value: 1, x: 5, y: 100 }, box, 80, 24), { x: 0, y: 69 });
  assert.deepEqual(tipPlace({ label: 'a', series: 0, value: 1, x: 636, y: 100 }, box, 80, 24), { x: 560, y: 69 });
});

test('chartSummary and chartRows: the chart as a sentence and as a table', () => {
  const c = chart();
  assert.equal(chartSummary(c, fmt), 'Bar chart, Signups: 3 bars; from 12 (Business) to 120 (Free).');
  assert.deepEqual(chartRows(c, fmt), { head: ['', 'Signups'], rows: [['Free', '120'], ['Team', '45'], ['Business', '12']] });
  const pie = chart({ kind: 'pie', series: [{ name: 'Status', points: [['Paid', 3], ['Open', 1]] }] });
  assert.deepEqual(chartRows(pie, fmt).rows, [['Paid', '3', '75%'], ['Open', '1', '25%']]);
  const line = chart({ kind: 'line', src: 'site', asOf: '2026-10-15', more: true, series: [{ name: 's', points: [['a', 1], ['b', 3]] }] });
  assert.equal(chartSummary(line, fmt), 'Line chart, Signups: 2 points; from 1 (a) to 3 (b), last 3. More groups exist than are shown.');
});

test('the renderer paints by part only: no markup, no style, no colour in its source', () => {
  const src = readFileSync(new URL('../src/chat-chart.ts', import.meta.url), 'utf8');
  for (const banned of ['innerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.', "'style'", 'stroke:', '#fff']) {
    assert.ok(!src.includes(banned), `chat-chart.ts mentions ${banned}`);
  }
  assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b/i, 'no hex colour');
});
