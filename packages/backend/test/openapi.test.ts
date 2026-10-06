/**
 * server/openapi.json (data-spec §7): deterministic, OpenAPI 3.1, only the
 * operations some rule grants, locked fields not writable, private fields
 * not filterable, and the error codes exactly the set the server answers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '../../core/src/index.ts';
import { DATA_ERROR_CODES, openapi, typeName } from '../src/openapi.ts';
import { dataSite, manifests } from './data-fixture.ts';

const tablesOf = (data: string) => {
  const r = compile(dataSite(data), { manifests });
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  return r.spec!.site.data!;
};

const SHOP = `  data products
    name text required search
    price money usd required
    stock number locked default 0
    contact email private
    allow anyone read
    allow signedin create
    allow owner edit delete
  data waitlist
    email email required private
    allow anyone create
`;

test('deterministic and sorted: the same tables give the same bytes', () => {
  const a = openapi('Shop', tablesOf(SHOP), 1);
  assert.equal(a, openapi('Shop', tablesOf(SHOP), 1));
  const doc = JSON.parse(a);
  assert.deepEqual(Object.keys(doc), [...Object.keys(doc)].sort());
  assert.equal(doc.openapi, '3.1.0');
  assert.match(doc['x-generated'], /^BY AZ — /);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a), 'no timestamps');
});

test('only granted operations; locked fields are not input; private fields are not filters', () => {
  const doc = JSON.parse(openapi('Shop', tablesOf(SHOP), 1));
  assert.deepEqual(Object.keys(doc.paths['/data/products']).sort(), ['get', 'post']);
  assert.deepEqual(Object.keys(doc.paths['/data/products/{id}']).sort(), ['delete', 'get', 'parameters', 'patch']);
  assert.deepEqual(Object.keys(doc.paths['/data/waitlist']), ['post'], 'no read rule, no list');
  assert.equal(doc.paths['/data/waitlist/{id}'], undefined);
  assert.deepEqual(Object.keys(doc.components.schemas.ProductInput.properties).sort(), ['contact', 'name', 'price']);
  assert.deepEqual(doc.components.schemas.ProductInput.required, ['name', 'price']);
  const params = doc.paths['/data/products'].get.parameters.map((p: { name: string }) => p.name);
  assert.ok(params.includes('price.gte') && params.includes('q'));
  assert.ok(!params.some((p: string) => p.startsWith('contact')), 'a private field is no filter');
  assert.deepEqual(doc.components.schemas.Product.properties.price.type, ['integer', 'null']);
});

test('the error codes are exactly the ones the server answers on /data', () => {
  const api = readFileSync(new URL('../src/server/data-api.ts', import.meta.url), 'utf8');
  const values = readFileSync(new URL('../src/server/data-values.ts', import.meta.url), 'utf8');
  const answered = new Set([
    ...[...api.matchAll(/fail\(\d+, '([a-z_]+)'/g)].map((m) => m[1]),
    // checkValue's problems, answered as fail(400, r.problem, field).
    ...[...values.matchAll(/problem: '([a-z_]+)'/g)].map((m) => m[1]),
  ]);
  answered.add('unknown');            // the edge's CSRF/origin refusal and a 500 (app.ts)
  answered.add('unsupported_type');   // images, D3 — in the closed set from the start
  assert.deepEqual([...answered].sort(), [...DATA_ERROR_CODES].sort());
});

test('type names: one row of each table', () => {
  assert.deepEqual(['products', 'categories', 'boxes', 'notes', 'news', 'glass'].map(typeName), ['Product', 'Category', 'Box', 'Note', 'New', 'Glass']);
});
