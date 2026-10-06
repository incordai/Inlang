/**
 * `data <table>` — the grammar, every link-stage diagnostic of data-spec §12
 * (D1), and the closed rule matrix of §4.7.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../src/index.ts';
import { ACTIONS, WHO, isDate, textOk } from '../src/data.ts';
import { CURRENCY_DIGITS } from '../src/currencies.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(f)) continue;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const HEAD = 'az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n';
const site = (data: string, head = HEAD) => `${head}${data}page /\n  hero center\n    title "Shop"\n`;
const run = (src: string) => compile(src, { manifests });
const codes = (src: string) => run(src).diagnostics.map((d) => d.code);
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

const PRODUCTS = `  data products
    name     text     required search
    blurb    longtext search
    price    money    usd required
    stock    number   default 0 locked
    category ref      categories
    status   choice   draft live sold default draft
    allow anyone   read
    allow signedin create
    allow owner    edit delete
  data categories
    name     text     required unique
    allow anyone read
`;

test('the spec example compiles to tables with typed fields and sorted rules', () => {
  const r = run(site(PRODUCTS));
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  const data = r.spec?.site.data;
  assert.ok(data, 'the Spec carries the tables');
  assert.deepEqual(data.map((t) => t.name), ['products', 'categories']);
  const products = data[0];
  assert.deepEqual(products.rules, { read: ['anyone'], create: ['signedin'], edit: ['owner'], delete: ['owner'] });
  const byName = Object.fromEntries(products.fields.map((f) => [f.name, f]));
  assert.equal(byName.price.currency, 'usd');
  assert.equal(byName.price.required, true);
  assert.equal(byName.stock.default, 0);
  assert.equal(byName.stock.locked, true);
  assert.equal(byName.category.ref, 'categories');
  assert.deepEqual(byName.status.choices, ['draft', 'live', 'sold']);
  assert.equal(byName.status.default, 'draft');
  assert.equal(byName.name.search, true);
});

test('CONTROL: a site without data serialises with no data key', () => {
  const r = run(site(''));
  assert.equal(r.spec?.site.data, undefined);
});

test('the rule matrix: exactly the cells data-spec §4.7 allows', () => {
  const allowed: Record<string, string[]> = {
    anyone: ['read', 'create'], signedin: ['read', 'create'], owner: ['read', 'edit', 'delete'],
  };
  const refusal: Record<string, string> = {
    'anyone edit': 'AZ1241', 'anyone delete': 'AZ1241',
    'signedin edit': 'AZ1242', 'signedin delete': 'AZ1242',
    'owner create': 'AZ1243',
  };
  for (const who of WHO) {
    for (const action of ACTIONS) {
      const src = site(`  data notes\n    body text\n    allow ${who} ${action}\n`);
      const errs = errors(src);
      if (allowed[who].includes(action)) {
        assert.deepEqual(errs, [], `${who} ${action} is legal`);
        const rules = run(src).spec!.site.data![0].rules;
        assert.deepEqual(rules[action], [who]);
      } else {
        assert.deepEqual(errs, [refusal[`${who} ${action}`]], `${who} ${action} is refused`);
      }
    }
  }
});

const CASES: [string, string, string][] = [
  ['AZ1226', 'data outside site', 'az 1\nsite shop\npage /\n  data products\n    name text\n'],
  ['AZ1227', 'data without backend', 'az 1\nsite shop\n  data products\n    name text\npage /\n'],
  ['AZ1228', 'a table declared twice', site('  data notes\n    body text\n  data notes\n    body text\n')],
  ['AZ1229', 'a reserved table name', site('  data users\n    body text\n')],
  ['AZ1229', 'a system field name', site('  data notes\n    id text\n')],
  ['AZ1229', 'a query-parameter field name', site('  data notes\n    sort text\n')],
  ['AZ1229', 'a hyphenated field name', site('  data notes\n    first-name text\n')],
  ['AZ1229', 'a one-letter table name', site('  data n\n    body text\n')],
  ['AZ1230', 'no fields', site('  data notes\n    allow anyone read\n')],
  ['AZ1231', 'an unknown type', site('  data notes\n    colour hue\n')],
  ['AZ1231', 'no type', site('  data notes\n    body\n')],
  ['AZ1232', 'money with no currency', site('  data notes\n    price money required\n')],
  ['AZ1415', 'money with an unknown currency', site('  data notes\n    price money zzz\n')],
  ['AZ1233', 'a choice with one value', site('  data notes\n    status choice draft\n')],
  ['AZ1233', 'a choice value twice', site('  data notes\n    status choice draft draft\n')],
  ['AZ1234', 'a ref with no table', site('  data notes\n    parent ref\n')],
  ['AZ1235', 'a ref to an undeclared table', site('  data notes\n    parent ref cats\n')],
  ['AZ1236', 'unique on longtext', site('  data notes\n    body longtext unique\n')],
  ['AZ1236', 'required on a flag', site('  data notes\n    done flag required\n')],
  ['AZ1236', 'search on a number', site('  data notes\n    n number search\n')],
  ['AZ1236', 'locked on a ref', site('  data notes\n    parent ref notes locked\n')],
  ['AZ1236', 'an unknown modifier', site('  data notes\n    body text shiny\n')],
  ['AZ1236', 'private and search together', site('  data notes\n    body text private search\n')],
  ['AZ1237', 'a default that is not a number', site('  data notes\n    n number default ten\n')],
  ['AZ1237', 'a default outside the choices', site('  data notes\n    s choice a b default c\n')],
  ['AZ1237', 'an impossible date default', site('  data notes\n    d date default 2023-02-29\n')],
  ['AZ1237', 'a text default that is not quoted', site('  data notes\n    t text default hello\n')],
  ['AZ1237', 'a default with no value', site('  data notes\n    n number default\n')],
  ['AZ1239', 'a field declared twice', site('  data notes\n    body text\n    body text\n')],
  ['AZ1240', 'an unknown who', site('  data notes\n    body text\n    allow everyone read\n')],
  ['AZ1240', 'an unknown action', site('  data notes\n    body text\n    allow anyone update\n')],
  ['AZ1244', 'owner rules on a table strangers fill', site('  data notes\n    body text\n    allow anyone create\n    allow owner read\n')],
  ['AZ1245', 'five search fields', site('  data notes\n    a text search\n    b text search\n    c text search\n    d text search\n    e text search\n')],
  ['AZ1249', 'a scheme pair in a data line', site('  data notes\n    body text default mailto:a@b.c\n')],
  ['AZ1249', 'a route in a data line', site('  data notes\n    body text /home\n')],
  ['AZ1249', 'a path in a data line', site('  data notes\n    body text ./x.ts\n')],
  ['AZ1214', 'an image field before uploads ship', site('  data notes\n    photo image\n')],
  ['AZ1219', 'lines beneath a field', site('  data notes\n    body text\n      nested text\n')],
];

for (const [code, what, src] of CASES) {
  test(`${code}: ${what}`, () => {
    assert.ok(codes(src).includes(code), `expected ${code}, got ${codes(src).join(', ') || 'nothing'}`);
  });
}

test('AZ1238: 21 tables and 31 fields are each past the wall', () => {
  const tables = Array.from({ length: 21 }, (_, i) => `  data t${i}x\n    body text\n`).join('');
  assert.ok(codes(site(tables)).includes('AZ1238'));
  const fields = Array.from({ length: 31 }, (_, i) => `    f${i} text\n`).join('');
  assert.ok(codes(site(`  data notes\n${fields}`)).includes('AZ1238'));
});

test('warnings: no allow lines (AZ1246), strangers create (AZ1247), a readable email (AZ1248)', () => {
  const r = run(site('  data notes\n    body text\n  data waitlist\n    email email\n    allow anyone create\n    allow anyone read\n'));
  const warnings = r.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code).sort();
  assert.deepEqual(warnings, ['AZ1246', 'AZ1247', 'AZ1248']);
  assert.equal(r.ok, true, 'warnings never block');
});

test('CONTROL: a private email on a public table does not warn', () => {
  const r = run(site('  data notes\n    contact email private\n    allow anyone read\n'));
  assert.ok(!r.diagnostics.some((d) => d.code === 'AZ1248'));
});

test('a self-reference is legal (a category with a parent category)', () => {
  assert.deepEqual(errors(site('  data categories\n    name text required\n    parent ref categories\n    allow anyone read\n')), []);
});

test('defaults are typed like their field', () => {
  const src = site(`  data notes
    title text default "Untitled"
    done flag default on
    due date default 2024-02-29
    cents money eur default 1999
    kind choice a b default b
`);
  const r = run(src);
  assert.deepEqual(errors(src), []);
  const f = Object.fromEntries(r.spec!.site.data![0].fields.map((x) => [x.name, x.default]));
  assert.deepEqual(f, { title: 'Untitled', done: true, due: '2024-02-29', cents: 1999, kind: 'b' });
});

test('validators: dates are real days, text has no control characters', () => {
  assert.ok(isDate('2024-02-29') && !isDate('2023-02-29') && !isDate('2024-13-01') && !isDate('0000-01-01'));
  assert.ok(textOk('a line', 200, false) && !textOk('two\nlines', 200, false) && textOk('two\nlines', 200, true));
  assert.ok(!textOk('   ', 200, false) && !textOk('x'.repeat(201), 200, false));
});

test('the currency table carries minor-unit digits', () => {
  assert.equal(CURRENCY_DIGITS.usd, 2);
  assert.equal(CURRENCY_DIGITS.jpy, 0);
  assert.equal(CURRENCY_DIGITS.bhd, 3);
  assert.ok(!Object.hasOwn(CURRENCY_DIGITS, 'zzz'));
});

test('CONTROL: inherited object keys are not currencies or types', () => {
  assert.ok(codes(site('  data notes\n    p money constructor\n')).includes('AZ1415'));
  assert.ok(codes(site('  data notes\n    p tostring\n')).includes('AZ1231'));
  assert.deepEqual(errors(site('  data notes\n    body text\n')), []);
});
