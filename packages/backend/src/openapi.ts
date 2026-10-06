/**
 * @az module openapi
 * Purpose: server/openapi.json — every /data route, parameter, body and error as OpenAPI 3.1, deterministic.
 * Spec: docs/data-spec.md §7, §5
 * Exports: openapi, DATA_ERROR_CODES, granted
 * Edit guide: describe only what data-api.ts accepts; keys sorted, no timestamps.
 * Tests: packages/backend/test/openapi.test.ts
 */

/**
 * The API document any other client can be generated from (data-spec §7).
 * An operation appears only when some rule grants it — a route no rule
 * opens is always 403 and is left out, as the typed client leaves it out.
 */

import { pascal, typeName, writeEcho, type SpecField, type SpecTable } from '../../core/src/data.ts';
import { generatedJson } from '../../core/src/generated.ts';

/** data-spec §5.3, closed. */
export const DATA_ERROR_CODES = [
  'invalid', 'required', 'too_long', 'bad_query', 'signin_required', 'forbidden', 'unknown',
  'not_found', 'taken', 'in_use', 'too_large', 'unsupported_type', 'rate_limited',
] as const;

const LIMITS: Partial<Record<SpecField['type'], number>> = { text: 200, longtext: 10_000, email: 254, url: 2048 };

/** The actions some rule grants on this table. */
export const granted = (t: SpecTable) => ({
  read: t.rules.read.length > 0,
  create: t.rules.create.length > 0,
  edit: t.rules.edit.length > 0,
  delete: t.rules.delete.length > 0,
});

type Schema = Record<string, unknown>;

function fieldSchema(f: SpecField): Schema {
  const base: Schema = (() => {
    switch (f.type) {
      case 'text': case 'longtext': return { type: 'string', maxLength: LIMITS[f.type] };
      case 'email': return { type: 'string', format: 'email', maxLength: LIMITS.email };
      case 'url': return { type: 'string', format: 'uri', maxLength: LIMITS.url };
      case 'choice': return { type: 'string', enum: [...(f.choices ?? [])] };
      case 'number': return { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
      case 'money': return { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: `minor units of ${f.currency!.toUpperCase()}` };
      case 'datetime': return { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'epoch milliseconds' };
      case 'flag': return { type: 'boolean' };
      case 'date': return { type: 'string', format: 'date' };
      case 'ref': return { type: 'string', format: 'uuid', description: `id of a ${f.ref!} row` };
      case 'image': return {
        type: 'object', required: ['url', 'width', 'height'], additionalProperties: false,
        properties: { url: { type: 'string', format: 'uri' }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } },
        description: 'uploaded with PUT …/{field}; the url changes on every upload',
      };
    }
  })();
  return f.type === 'flag' ? base : { ...base, type: [base.type, 'null'] };
}

/** Keys sorted at every level, so the file is byte-stable. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
  }
  return v;
}

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const ERRORS = {
  400: errorResponse('invalid, required, too_long or bad_query, with the field'),
  401: errorResponse('signin_required'),
  403: errorResponse('forbidden (no rule grants it), or unknown (origin or CSRF header refused)'),
  429: errorResponse('rate_limited'),
};

/** The OpenAPI document for every table, as the file's text. */
export function openapi(siteName: string, tables: readonly SpecTable[], version: number): string {
  const schemas: Record<string, Schema> = {
    Error: {
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'string', enum: [...DATA_ERROR_CODES] }, field: { type: 'string' } },
      additionalProperties: false,
    },
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const t of tables) {
    const name = typeName(t.name);
    // Operations are named by the table (one-to-one), schemas by its row type.
    const op = pascal(t.name);
    const g = granted(t);
    schemas[name] = {
      type: 'object',
      required: ['id', 'created', 'updated', 'mine', ...t.fields.map((f) => f.name)],
      properties: {
        id: { type: 'string', format: 'uuid' },
        created: { type: 'integer', description: 'epoch milliseconds' },
        updated: { type: 'integer', description: 'epoch milliseconds' },
        mine: { type: 'boolean', description: 'the caller owns this row' },
        ...Object.fromEntries(t.fields.map((f) => [f.name, { ...fieldSchema(f), ...(f.private ? { description: 'private: null unless the caller owns the row' } : {}) }])),
      },
      additionalProperties: false,
    };
    // An image is never in a JSON body: it is uploaded on its own route.
    const writable = t.fields.filter((f) => !f.locked && f.type !== 'image');
    schemas[`${name}Input`] = {
      type: 'object',
      required: writable.filter((f) => f.required && f.default === undefined).map((f) => f.name),
      properties: Object.fromEntries(writable.map((f) => [f.name, fieldSchema(f)])),
      additionalProperties: false,
    };
    const itemAs = (schema: Schema) => ({ content: { 'application/json': { schema: { type: 'object', required: ['item'], properties: { item: schema } } } } });
    const row = { $ref: `#/components/schemas/${name}` };
    const item = itemAs(row);
    // A write answers with its row only as the read rules grant it (writeEcho).
    const unread = { type: 'null', description: 'no read rule grants this row to the writer' };
    const echo = writeEcho(t.rules);
    const answer = (e: 'row' | 'none' | 'maybe') => (e === 'row' ? item : itemAs(e === 'none' ? unread : { anyOf: [row, unread] }));
    const edited = answer(echo.edit);
    const created = answer(echo.create);
    const body = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}Input` } } } };
    const notFound = { 404: errorResponse('not_found — absent, or not yours: the same answer') };
    const collection: Record<string, unknown> = {};
    const one: Record<string, unknown> = {};
    if (g.read) {
      collection.get = {
        operationId: `list${op}`,
        parameters: listParameters(t),
        responses: {
          200: {
            description: 'a page of rows',
            content: { 'application/json': { schema: {
              type: 'object', required: ['items', 'next'],
              properties: { items: { type: 'array', items: { $ref: `#/components/schemas/${name}` } }, next: { type: ['string', 'null'] } },
            } } },
          },
          ...ERRORS,
        },
      };
      one.get = { operationId: `get${op}`, responses: { 200: { description: 'the row', ...item }, ...ERRORS, ...notFound } };
    }
    if (g.create) {
      collection.post = {
        operationId: `create${op}`, requestBody: body,
        responses: { 201: { description: 'created', ...created }, ...ERRORS, 409: errorResponse('taken, with the field'), 413: errorResponse('too_large') },
      };
    }
    if (g.edit) {
      one.patch = {
        operationId: `update${op}`, requestBody: { ...body, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}Input`, description: 'any subset of the fields' } } } },
        responses: { 200: { description: 'updated', ...edited }, ...ERRORS, ...notFound, 409: errorResponse('taken, with the field'), 413: errorResponse('too_large') },
      };
    }
    if (g.delete) {
      one.delete = {
        operationId: `remove${op}`,
        responses: { 204: { description: 'deleted' }, ...ERRORS, ...notFound, 409: errorResponse('in_use — another table points at it') },
      };
    }
    const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }];
    if (Object.keys(collection).length > 0) paths[`/data/${t.name}`] = collection;
    if (Object.keys(one).length > 0) paths[`/data/${t.name}/{id}`] = { parameters: idParam, ...one };
    for (const f of t.fields.filter((x) => x.type === 'image')) {
      const ops: Record<string, unknown> = {};
      const field = pascal(f.name);
      if (g.read) {
        ops.get = {
          operationId: `get${op}${field}`,
          parameters: [{ name: 'v', in: 'query', required: false, schema: { type: 'string' }, description: 'the upload this url names; another one is not_found' }],
          responses: {
            200: { description: 'the image, re-encoded as WebP; no Origin needed (an <img> sends none)', content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } } },
            ...ERRORS, ...notFound,
          },
        };
      }
      if (g.edit && !f.locked) {
        ops.put = {
          operationId: `upload${op}${field}`,
          requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }, description: 'the raw bytes of a JPEG, PNG, WebP or AVIF image, judged by its first bytes' },
          responses: {
            200: { description: 'stored', ...edited }, ...ERRORS, ...notFound,
            413: errorResponse('too_large — over the upload cap, or more than 8000 px a side or 40 megapixels'),
            415: errorResponse('unsupported_type — not a JPEG, PNG, WebP or AVIF image'),
          },
        };
        ops.delete = { operationId: `clear${op}${field}`, responses: { 200: { description: 'cleared', ...edited }, ...ERRORS, ...notFound } };
      }
      if (Object.keys(ops).length > 0) {
        paths[`/data/${t.name}/{id}/${f.name}`] = { parameters: idParam, ...ops };
      }
    }
  }
  const doc = {
    // The root takes only `x-` extensions, so the generated-file note rides as one.
    'x-generated': generatedJson('every /data route, parameter, body and error as OpenAPI 3.1'),
    openapi: '3.1.0',
    info: {
      title: `${siteName} data API`,
      version: String(version),
      description: 'Generated by az from the site\'s data tables. Browser clients only: send credentials, the site\'s Origin, and x-az-request: 1 on every non-GET.',
    },
    paths,
    components: { schemas },
  };
  return `${JSON.stringify(sorted(doc), null, 2)}\n`;
}

/** The list route's parameters for this table (data-spec §5.1). */
function listParameters(t: SpecTable): unknown[] {
  const p = (name: string, schema: Schema, description: string) => ({ name, in: 'query', required: false, schema, description });
  const sortable = ['created', 'updated', ...t.fields.filter((f) => f.required && !f.private && ['text', 'number', 'money', 'date', 'datetime', 'choice'].includes(f.type)).map((f) => f.name)];
  const out = [
    p('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, 'rows per page'),
    p('after', { type: 'string' }, 'the previous page\'s next cursor'),
    p('sort', { type: 'string', enum: sortable.flatMap((s) => [s, `-${s}`]) }, 'one key; -key descends; default -created'),
    p('mine', { type: 'string', enum: ['1'] }, 'only rows the caller owns'),
  ];
  if (t.fields.some((f) => f.search && !f.private)) out.push(p('q', { type: 'string', minLength: 2, maxLength: 100 }, 'search the search fields'));
  for (const f of t.fields) {
    if (f.private) continue;
    if (['number', 'money', 'flag', 'date', 'datetime', 'choice', 'ref', 'email'].includes(f.type)) {
      out.push(p(f.name, f.type === 'flag' ? { type: 'string', enum: ['on', 'off'] } : { type: 'string' }, 'equals'));
    }
    if (['number', 'money', 'date', 'datetime'].includes(f.type)) {
      for (const op of ['lt', 'lte', 'gt', 'gte']) out.push(p(`${f.name}.${op}`, { type: 'string' }, op));
    }
    if (f.type === 'choice' || f.type === 'ref') out.push(p(`${f.name}.in`, { type: 'string' }, 'comma-separated, up to 20'));
  }
  return out;
}
