/**
 * The page's explore (chat-block-spec §21.3), pure: validExplore holds every
 * cap at the cap and one past it, closed shapes, forged keys and types; the
 * computation engine — each operator and each aggregate on fixed rows,
 * byte-compared; empty results; empty cells; a missing variable; days across
 * a leap day; NaN and Infinity refused; 200 rows; unicode categories; the
 * controls' values (a slider snapped to its step, days and numbers held to
 * their bounds); and a send form's question, filled and checked as a
 * visitor's own words before the button shows it. No DOM, no eval: the
 * sink scan over these files is overlay chat.test.ts's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPLORE_CAPS, EXPLORE_TEXT, computeView, controlValue, groupLabel, initialVars, matches, sendText, validExplore, viewChart,
  type ExploreData, type ExploreView,
} from '../src/runtime/chat-explore.ts';

/** The spec's plan-cost example (§21.3.2), as the server binds it. */
const PLANS = () => ({
  title: 'Plan cost', src: 'model',
  columns: [{ label: 'Plan', type: 'text', unit: null }, { label: 'Seats', type: 'number', unit: null }, { label: 'Price', type: 'number', unit: null }],
  rows: [['Solo', 1, 9], ['Team', 10, 29], ['Business', 50, 99]],
  controls: [
    { kind: 'slider', name: 'seats', label: 'Team size', min: 1, max: 50, step: 1, value: 5 },
    { kind: 'toggle', name: 'period', label: 'Billing', options: ['Monthly', 'Annual'], value: 'Monthly' },
  ],
  views: [
    { kind: 'table', where: { column: 1, op: '>=', value: { var: 'seats' } } },
    { kind: 'stat', label: 'Cheapest that fits', fn: 'min', column: 2, where: { column: 1, op: '>=', value: { var: 'seats' } }, unit: 'usd' },
    { kind: 'chart', chart: 'bar', title: 'Price by plan', fn: 'sum', column: 2, by: 0, where: { column: 1, op: '>=', value: { var: 'seats' } }, unit: null },
  ],
});
const valid = (over: Record<string, unknown> = {}) => validExplore({ ...PLANS(), ...over });
/** One view that reads no variable, for controls tested on their own. */
const PLAIN = [{ kind: 'table', where: null }];
const must = (over: Record<string, unknown> = {}): ExploreData => {
  const x = valid(over);
  assert.ok(x, 'valid');
  return x;
};

test('validExplore: the spec\'s example passes, as sent; every unknown key, a wrong source, a missing part refuses it whole', () => {
  const x = must();
  assert.equal(x.src, 'model');
  assert.equal(x.views.length, 3);
  for (const bad of [
    { extra: 1 }, { src: 'site' }, { src: 'tool', asOf: '2026-10-16T10:00Z' }, { src: 'model', asOf: '2026-10-16' }, { src: 'model', source: 'Svc' },
    { title: '' }, { title: 'x'.repeat(81) }, { columns: [] }, { rows: [] }, { views: [] }, { controls: 'none' },
  ]) assert.equal(valid(bad), null, JSON.stringify(bad));
  // A server source carries its day; a tool's its label and minute.
  assert.ok(valid({ src: 'site', asOf: '2026-10-16' }));
  assert.ok(valid({ src: 'tool', source: 'Race results', asOf: '2026-10-16T10:05Z' }));
  assert.equal(valid({ title: 'x'.repeat(80) })?.title.length, 80);
});

test('validExplore: data caps — 1–6 columns, 1–200 rows, cells of their column\'s type, at the cap and one past', () => {
  const col = (i: number) => ({ label: `C${i}`, type: 'number', unit: null });
  const wide = (n: number) => ({ columns: Array.from({ length: n }, (_, i) => col(i)), rows: [Array.from({ length: n }, () => 1)], controls: [], views: [{ kind: 'table', where: null }] });
  assert.ok(valid(wide(6)));
  assert.equal(valid(wide(7)), null);
  const tall = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => [`P${i % 24}`, i, i]) });
  assert.ok(valid(tall(200)));
  assert.equal(valid(tall(201)), null);
  // NaN, Infinity, past 10^15, a number as text, text as a number, an impossible day: refused, never repaired.
  for (const cell of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e15 + 2, '10', true, {}]) {
    assert.equal(valid({ rows: [['Solo', cell, 9]] }), null, String(cell));
  }
  assert.ok(valid({ rows: [['Solo', null, 9]] }), 'an empty cell (a site row without a value)');
  assert.ok(valid({ rows: [['Solo', 1e15, -1e15]] }));
  const dated = (d: unknown) => valid({ columns: [{ label: 'Day', type: 'date', unit: null }], rows: [[d]], controls: [], views: [{ kind: 'table', where: null }] });
  assert.ok(dated('2024-02-29'), 'a leap day');
  for (const d of ['2023-02-29', '2024-13-01', '2024-2-1', '20240201', 20240201]) assert.equal(dated(d), null, String(d));
  // A text category is at most 24 code points; a heading 40; the same heading twice is no data set.
  assert.ok(valid({ rows: [['x'.repeat(24), 1, 9]] }));
  assert.equal(valid({ rows: [['x'.repeat(25), 1, 9]] }), null);
  assert.equal(valid({ columns: [{ label: 'Plan', type: 'text', unit: null }, { label: 'Plan', type: 'number', unit: null }, { label: 'Price', type: 'number', unit: null }] }), null);
  assert.equal(valid({ columns: [{ label: 'Plan', type: 'text', unit: 'usd' }, PLANS().columns[1], PLANS().columns[2]] }), null, 'a unit on text');
  assert.equal(valid({ columns: [{ label: 'Plan', type: 'formula', unit: null }, PLANS().columns[1], PLANS().columns[2]] }), null);
});

test('validExplore: controls — ≤ 4, names unique, a slider\'s bounds, step and ≤ 1 000 steps, days 1900–2100, 2–4 toggle options of ≤ 24', () => {
  const slider = (o: Record<string, unknown>) => valid({ controls: [{ kind: 'slider', name: 'seats', label: 'Team size', min: 1, max: 50, step: 1, value: 5, ...o }] });
  assert.ok(slider({}));
  for (const bad of [{ min: 50 }, { step: 0 }, { step: -1 }, { step: 50 }, { value: 0 }, { value: 51 }, { value: 2.5 }, { name: 'Seats' }, { name: 's'.repeat(17) }, { label: '' }, { label: 'x'.repeat(41) }, { min: Number.NaN }]) {
    assert.equal(slider(bad), null, JSON.stringify(bad));
  }
  assert.ok(slider({ min: 0, max: 1000, step: 1, value: 0 }), '1 000 steps');
  assert.equal(slider({ min: 0, max: 1001, step: 1, value: 0 }), null, '1 001 steps');
  assert.ok(slider({ min: 0, max: 1, step: 0.1, value: 0.3 }), 'a decimal step');
  const date = (o: Record<string, unknown>) => valid({ views: PLAIN, controls: [{ kind: 'date', name: 'since', label: 'From', min: '2024-01-01', max: '2024-12-31', value: '2024-02-29', ...o }] });
  assert.ok(date({}));
  for (const bad of [{ min: '1899-12-31' }, { max: '2101-01-01' }, { value: '2025-01-01' }, { value: '2024-02-30' }, { min: '2024-12-31', max: '2024-01-01' }]) assert.equal(date(bad), null, JSON.stringify(bad));
  assert.ok(date({ min: '1900-01-01', max: '2100-12-31', value: '1900-01-01' }));
  const toggle = (options: unknown[], value = options[0]) => valid({ views: PLAIN, controls: [{ kind: 'toggle', name: 'period', label: 'Billing', options, value }] });
  assert.ok(toggle(['A', 'B']));
  assert.ok(toggle(['A', 'B', 'C', 'D']));
  for (const bad of [['A'], ['A', 'B', 'C', 'D', 'E'], ['A', 'A'], ['A', 'x'.repeat(25)], ['A', '']]) assert.equal(toggle(bad), null, JSON.stringify(bad));
  assert.equal(toggle(['A', 'B'], 'B'), null, 'it starts at its first option');
  const five = Array.from({ length: 5 }, (_, i) => ({ kind: 'slider', name: `s${i}`, label: 'S', min: 0, max: 1, step: 1, value: 0 }));
  assert.ok(valid({ views: PLAIN, controls: five.slice(0, 4) }));
  assert.equal(valid({ views: PLAIN, controls: five }), null, 'a fifth control');
  assert.equal(valid({ views: PLAIN, controls: [five[0], five[0]] }), null, 'a name twice');
});

test('validExplore: a form owns the fields written since the one before; a send form\'s template holes only its own fields', () => {
  const fields = [
    { kind: 'field', name: 'budget', label: 'Budget', type: 'number', min: 0, max: 500, value: 0 },
    { kind: 'field', name: 'tier', label: 'Tier', type: 'choice', options: ['Basic', 'Pro'], value: 'Basic' },
  ];
  const send = { kind: 'form', label: 'Find a plan', action: 'send', fields: ['budget', 'tier'], template: ['Which ', { var: 'tier' }, ' plan fits ', { var: 'budget' }, '?'] };
  assert.ok(valid({ views: PLAIN, controls: [...fields, send] }));
  assert.ok(valid({ views: PLAIN, controls: [...fields, { kind: 'form', label: 'Try', action: 'apply', fields: ['budget', 'tier'] }] }));
  for (const bad of [
    [...fields],                                                                  // fields with no form
    [send],                                                                       // a form with no fields
    [...fields, { ...send, fields: ['budget'] }],                                // a field left unowned
    [...fields, { ...send, template: ['Which ', { var: 'seats' }, '?'] }],        // a hole that is not its own field
    [...fields, { ...send, template: ['No holes at all'] }],
    [...fields, { ...send, template: ['Two\nlines ', { var: 'tier' }] }],
    [...fields, { ...send, template: ['A {smuggled} brace ', { var: 'tier' }] }],
    [...fields, { ...send, template: ['x'.repeat(161), { var: 'tier' }] }],
    [...fields, { ...send, template: Array.from({ length: 9 }, () => ({ var: 'tier' })) }],
    [...fields, { ...send, action: 'post' }],
    [...fields, { ...send, template: ['Ask ', { var: 'tier', code: 'alert(1)' }] }],
    [{ ...fields[0], value: 5 }, { kind: 'form', label: 'Try', action: 'apply', fields: ['budget'] }],   // a number field starts at its min
    [{ ...fields[1], options: ['Only'] }, { kind: 'form', label: 'Try', action: 'apply', fields: ['tier'] }],
  ]) assert.equal(valid({ views: PLAIN, controls: bad }), null, JSON.stringify(bad));
  assert.ok(valid({ views: PLAIN, controls: [...fields, { ...send, template: [...Array.from({ length: 8 }, () => ({ var: 'tier' }))] }] }), 'eight holes');
});

test('validExplore: views — 1–4, columns by index in range, an operand of its column\'s type, a variable a control the page changes', () => {
  const view = (v: Record<string, unknown>) => valid({ views: [v] });
  const where = (o: Record<string, unknown>) => view({ kind: 'table', where: { column: 1, op: '>=', value: { var: 'seats' }, ...o } });
  assert.ok(where({}));
  for (const bad of [
    { column: 3 }, { column: -1 }, { column: 1.5 }, { op: '=>' }, { op: '+' }, { op: '&&' }, { value: { var: 'nobody' } }, { value: { var: 'period' } },
    { value: { text: '10' } }, { value: { number: Number.NaN } }, { value: { number: 1, text: 'x' } }, { value: '$seats + 1' }, { value: { expr: 'seats + 1' } },
  ]) assert.equal(where(bad), null, JSON.stringify(bad));
  // Text compares only as equal or not, against a text or a text variable.
  assert.ok(view({ kind: 'table', where: { column: 0, op: '=', value: { var: 'period' } } }));
  assert.ok(view({ kind: 'table', where: { column: 0, op: '!=', value: { text: 'Solo' } } }));
  assert.equal(view({ kind: 'table', where: { column: 0, op: '<', value: { text: 'Solo' } } }), null);
  assert.equal(view({ kind: 'table', where: { column: 0, op: '=', value: { var: 'seats' } } }), null);
  // An aggregate of a number column; count of none.
  assert.equal(view({ kind: 'stat', label: 'x', fn: 'sum', column: 0, where: null, unit: null }), null);
  assert.equal(view({ kind: 'stat', label: 'x', fn: 'count', column: 2, where: null, unit: null }), null);
  assert.equal(view({ kind: 'stat', label: 'x', fn: 'median', column: 2, where: null, unit: null }), null);
  assert.equal(view({ kind: 'stat', label: 'x', fn: 'sum', column: 2, where: null, unit: 'bitcoin' }), null);
  assert.ok(view({ kind: 'stat', label: 'x', fn: 'count', column: null, where: null, unit: null }));
  // A chart's grouping fits it: a line needs two groups; a pie at most six, never of a negative measure.
  const chart = (o: Record<string, unknown>, rows?: unknown[]) => valid({ ...(rows ? { rows } : {}), views: [{ kind: 'chart', chart: 'bar', title: 'C', fn: 'sum', column: 2, by: 0, where: null, unit: null, ...o }] });
  assert.ok(chart({}));
  assert.ok(chart({ chart: 'line' }));
  assert.equal(chart({ chart: 'line' }, [['Solo', 1, 9]]), null, 'one group cannot be a line');
  assert.equal(chart({ chart: 'pie' }, [['Solo', 1, -9], ['Team', 2, 9]]), null);
  assert.ok(chart({ chart: 'pie', fn: 'count', column: null }, [['Solo', 1, -9], ['Team', 2, 9]]), 'a count is never negative');
  assert.equal(chart({ chart: 'pie' }, Array.from({ length: 7 }, (_, i) => [`P${i}`, i, i])), null);
  assert.equal(chart({}, Array.from({ length: 25 }, (_, i) => [`P${i}`, i, i])), null);
  assert.ok(chart({}, Array.from({ length: 24 }, (_, i) => [`P${i}`, i, i])));
  assert.equal(chart({ chart: 'radar' }), null);
  assert.equal(valid({ views: Array.from({ length: 5 }, () => ({ kind: 'table', where: null })) }), null, 'a fifth view');
  // A send form's fields only ever ask: no view reads them.
  const sendForm = [
    { kind: 'field', name: 'budget', label: 'Budget', type: 'number', min: 0, max: 500, value: 0 },
    { kind: 'form', label: 'Ask', action: 'send', fields: ['budget'], template: ['Fits ', { var: 'budget' }, '?'] },
  ];
  assert.equal(valid({ controls: sendForm, views: [{ kind: 'table', where: { column: 2, op: '<=', value: { var: 'budget' } } }] }), null);
  assert.ok(valid({ controls: [sendForm[0], { kind: 'form', label: 'Try', action: 'apply', fields: ['budget'] }], views: [{ kind: 'table', where: { column: 2, op: '<=', value: { var: 'budget' } } }] }));
});

/** Rows for the engine: a category, two numbers (one with an empty cell), a day across a leap day. */
const ENGINE = (): ExploreData => must({
  columns: [
    { label: 'Plan', type: 'text', unit: null }, { label: 'Seats', type: 'number', unit: null },
    { label: 'Price', type: 'number', unit: 'usd' }, { label: 'Day', type: 'date', unit: null },
  ],
  rows: [
    ['Solo', 1, 9, '2024-02-28'],
    ['Team', 10, 29, '2024-02-29'],
    ['Business', 50, 99, '2024-03-01'],
    ['Team', 20, null, '2024-03-01'],
  ],
  controls: [
    { kind: 'slider', name: 'seats', label: 'Team size', min: 1, max: 50, step: 1, value: 10 },
    { kind: 'date', name: 'since', label: 'From', min: '2024-01-01', max: '2024-12-31', value: '2024-02-29' },
    { kind: 'toggle', name: 'plan', label: 'Plan', options: ['Team', 'Solo'], value: 'Team' },
  ],
  views: [{ kind: 'table', where: null }],
});

test('every operator, on numbers, days and text, byte-compared — an empty cell matches nothing', () => {
  const x = ENGINE();
  const vars = initialVars(x);
  const plans = (column: number, op: string, value: Record<string, unknown>) =>
    JSON.stringify(matches(x, { column, op: op as never, value: value as never }, vars).map((r) => r[0]));
  assert.equal(plans(1, '=', { var: 'seats' }), '["Team"]');
  assert.equal(plans(1, '!=', { var: 'seats' }), '["Solo","Business","Team"]');
  assert.equal(plans(1, '<', { var: 'seats' }), '["Solo"]');
  assert.equal(plans(1, '<=', { var: 'seats' }), '["Solo","Team"]');
  assert.equal(plans(1, '>', { var: 'seats' }), '["Business","Team"]');
  assert.equal(plans(1, '>=', { number: 20 }), '["Business","Team"]');
  // Days compare as days — across the leap day.
  assert.equal(plans(3, '>=', { var: 'since' }), '["Team","Business","Team"]');
  assert.equal(plans(3, '<', { var: 'since' }), '["Solo"]');
  assert.equal(plans(3, '=', { date: '2024-02-29' }), '["Team"]');
  assert.equal(plans(3, '>', { date: '2024-02-29' }), '["Business","Team"]');
  // Text equals or not.
  assert.equal(plans(0, '=', { var: 'plan' }), '["Team","Team"]');
  assert.equal(plans(0, '!=', { text: 'Team' }), '["Solo","Business"]');
  // An empty cell matches neither = nor != (SQL's rule).
  assert.equal(plans(2, '!=', { number: 9 }), '["Team","Business"]');
  assert.equal(plans(2, '=', { number: 9 }), '["Solo"]');
  // A variable the page does not hold matches nothing — never a guess.
  assert.equal(JSON.stringify(matches(x, { column: 1, op: '>', value: { var: 'ghost' } }, vars)), '[]');
  assert.equal(matches(x, null, vars).length, 4);
});

const stat = (fn: string, column: number | null, where: unknown = null): ExploreView => ({ kind: 'stat', label: 'S', fn, column, where, unit: null }) as ExploreView;

test('every aggregate, byte-compared; empty cells left out of a measure; no row is "No rows match."', () => {
  const x = ENGINE();
  const vars = initialVars(x);
  const of = (v: ExploreView) => JSON.stringify(computeView(x, v, vars));
  assert.equal(of(stat('count', null)), '{"kind":"value","value":4}');
  assert.equal(of(stat('sum', 2)), '{"kind":"value","value":137}');
  assert.equal(of(stat('avg', 2)), '{"kind":"value","value":45.6666666666667}');
  assert.equal(of(stat('min', 2)), '{"kind":"value","value":9}');
  assert.equal(of(stat('max', 2)), '{"kind":"value","value":99}');
  assert.equal(of(stat('sum', 1)), '{"kind":"value","value":81}');
  const none = { column: 1, op: '>', value: { number: 1000 } };
  for (const fn of ['count', 'sum', 'avg', 'min', 'max']) assert.equal(of(stat(fn, fn === 'count' ? null : 2, none)), '{"kind":"empty"}', fn);
  // Rows match, but the measure has no value among them.
  assert.equal(of(stat('max', 2, { column: 1, op: '=', value: { number: 20 } })), '{"kind":"none"}');
  assert.equal(of(stat('count', null, { column: 1, op: '=', value: { number: 20 } })), '{"kind":"value","value":1}');
  assert.equal(EXPLORE_TEXT.empty, 'No rows match.');
  // Floating sums are held to 15 significant digits: 0.1 + 0.2 is 0.3.
  const tenths = must({ rows: [['Solo', 1, 0.1], ['Team', 2, 0.2]] });
  assert.equal(JSON.stringify(computeView(tenths, stat('sum', 2), initialVars(tenths))), '{"kind":"value","value":0.3}');
});

test('a chart\'s groups: text in the data\'s first order, numbers and days ascending; groups with no value left out', () => {
  const x = ENGINE();
  const vars = initialVars(x);
  const chart = (by: number, fn = 'sum', column: number | null = 2, where: unknown = null): ExploreView =>
    ({ kind: 'chart', chart: 'bar', title: 'C', fn, column, by, where, unit: null }) as ExploreView;
  assert.equal(JSON.stringify(computeView(x, chart(0), vars)), '{"kind":"groups","groups":[["Solo",9],["Team",29],["Business",99]]}');
  assert.equal(JSON.stringify(computeView(x, chart(0, 'count', null), vars)), '{"kind":"groups","groups":[["Solo",1],["Team",2],["Business",1]]}');
  assert.equal(JSON.stringify(computeView(x, chart(3, 'count', null), vars)), '{"kind":"groups","groups":[["2024-02-28",1],["2024-02-29",1],["2024-03-01",2]]}');
  assert.equal(JSON.stringify(computeView(x, chart(1, 'max'), vars)), '{"kind":"groups","groups":[["1",9],["10",29],["50",99]]}');
  // Filtered by a variable: only the groups whose rows are kept.
  assert.equal(JSON.stringify(computeView(x, chart(0, 'sum', 2, { column: 1, op: '>=', value: { var: 'seats' } }), vars)), '{"kind":"groups","groups":[["Team",29],["Business",99]]}');
  // The page's own chart check draws it; a line of one group cannot be drawn (the note), as the view is fixed when it is checked.
  const v = chart(0) as Extract<ExploreView, { kind: 'chart' }>;
  const drawn = viewChart(x, v, [['Solo', 9], ['Team', 29]]);
  assert.equal(drawn?.series[0].points.length, 2);
  assert.equal(drawn?.src, 'model');
  assert.equal(viewChart(x, { ...v, chart: 'line' }, [['Solo', 9]]), null);
  assert.equal(viewChart(x, { ...v, chart: 'pie' }, [['Solo', 0], ['Team', 0]]), null, 'a pie of nothing');
  assert.equal(groupLabel(0.0000001), '0.0000001');
  assert.equal(groupLabel(1234567), '1234567');
});

test('huge and hostile data: 200 rows, figures past 10^15 are the overflow note, unicode categories group exactly', () => {
  const rows = Array.from({ length: 200 }, (_, i) => [`P${i % 24}`, i, 1e15]);
  const big = must({ rows });
  const vars = initialVars(big);
  assert.equal(JSON.stringify(computeView(big, stat('sum', 2), vars)), '{"kind":"overflow"}');
  assert.equal(JSON.stringify(computeView(big, stat('max', 2), vars)), '{"kind":"value","value":1000000000000000}');
  assert.equal(JSON.stringify(computeView(big, stat('count', null), vars)), '{"kind":"value","value":200}');
  const table = computeView(big, { kind: 'table', where: { column: 1, op: '>=', value: { number: 100 } } }, vars);
  assert.deepEqual(table.kind === 'rows' ? [table.rows.length, table.total] : table, [EXPLORE_CAPS.shown, 100]);
  // Categories in any script, with combining marks and emoji, group as written — and markup is a category like any text.
  const uni = must({ rows: [['Café', 1, 1], ['Café', 2, 2], ['東京', 3, 3], ['🚀 Launch', 4, 4], ['<img src=x>', 5, 5], ['東京', 6, 6]] });
  const g = computeView(uni, { kind: 'chart', chart: 'bar', title: 'C', fn: 'sum', column: 2, by: 0, where: null, unit: null }, initialVars(uni));
  assert.equal(JSON.stringify(g), JSON.stringify({ kind: 'groups', groups: [['Café', 1], ['Café', 2], ['東京', 9], ['🚀 Launch', 4], ['<img src=x>', 5]] }));
});

test('control state: a slider snaps to its step within its bounds; days and numbers outside their bounds are no value', () => {
  const slider = { kind: 'slider', name: 's', label: 'S', min: 0, max: 1, step: 0.1, value: 0 } as const;
  assert.equal(controlValue(slider, '0.30000000000000004'), 0.3);
  assert.equal(controlValue(slider, '0.34'), 0.3);
  assert.equal(controlValue(slider, '7'), 1);
  assert.equal(controlValue(slider, '-7'), 0);
  for (const raw of ['', 'NaN', 'Infinity', '1e400', 'abc', '$s + 1']) assert.equal(controlValue(slider, raw), null, raw);
  const date = { kind: 'date', name: 'd', label: 'D', min: '2024-02-28', max: '2024-03-01', value: '2024-02-28' } as const;
  assert.equal(controlValue(date, '2024-02-29'), '2024-02-29');
  for (const raw of ['', '2024-03-02', '2024-02-27', '2023-02-29', '2024-02-29T00:00']) assert.equal(controlValue(date, raw), null, raw);
  const field = { kind: 'field', name: 'n', label: 'N', type: 'number', min: 0, max: 500, value: 0 } as const;
  assert.equal(controlValue(field, '250.5'), 250.5);
  for (const raw of ['', '-1', '501', 'NaN', 'Infinity']) assert.equal(controlValue(field, raw), null, raw);
  const choice = { kind: 'field', name: 'c', label: 'C', type: 'choice', options: ['A', 'B'], value: 'A' } as const;
  assert.equal(controlValue(choice, 'B'), 'B');
  assert.equal(controlValue(choice, 'C'), null);
  const toggle = { kind: 'toggle', name: 't', label: 'T', options: ['Monthly', 'Annual'], value: 'Monthly' } as const;
  assert.equal(controlValue(toggle, 'Annual'), 'Annual');
  assert.equal(controlValue(toggle, '<script>'), null);
  // Positions are never kept: a restored explore starts at its written values (O9).
  const x = must();
  assert.deepEqual([...initialVars(x)], [['seats', 5], ['period', 'Monthly']]);
});

test('a send form\'s question: holes filled with its fields\' values, then checked as a visitor\'s words — exactly what the button shows', () => {
  const form = { kind: 'form', label: 'Find', action: 'send', fields: ['seats', 'tier'], template: ['Find ', { var: 'tier' }, ' plans for ', { var: 'seats' }, ' seats'] } as const;
  const format = (n: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 20 }).format(n);
  const q = sendText(form, new Map<string, number | string>([['seats', 1500], ['tier', 'Pro']]), format);
  assert.equal(q, 'Find Pro plans for 1,500 seats');
  assert.equal(EXPLORE_TEXT.ask(q!), 'Ask: Find Pro plans for 1,500 seats');
  // A value the form does not hold is no question.
  assert.equal(sendText(form, new Map([['seats', 5]]), format), null);
  // Control characters in a choice are not sent (visitorText); markup stays the words it is.
  assert.equal(sendText(form, new Map<string, number | string>([['seats', 5], ['tier', 'P\u0007ro <b>']]), format), 'Find Pro <b> plans for 5 seats');
});
