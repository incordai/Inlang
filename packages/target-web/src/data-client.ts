/**
 * @az module data-client
 * Purpose: src/data/client.ts — the site's typed client for its data tables: types and list/get/create/update/remove per table.
 * Spec: docs/data-spec.md §7
 * Exports: DATA_DIR, dataClient
 * Edit guide: only the actions some rule grants; no dependency; results are { ok } unions with the closed error codes.
 * Tests: packages/target-web/test/data-client.test.ts
 */

/**
 * The generated client a site (its blocks in D4, its admin pages in D2, a
 * `raw` component today) uses to reach `/data`. Plain `fetch`, the browser's
 * cookie (`credentials: "include"`), the CSRF header on every non-GET, the
 * backend's address from AZ_PUBLIC_BACKEND_URL exactly as the auth adapter
 * reads it. Every call resolves — a network failure or an answer the client
 * does not recognise is `{ ok: false, code: "unknown" }` — so a component
 * never needs a try/catch to stay up.
 */

import { BACKEND_ENV } from './auth.ts';
import { generated } from './generated.ts';
import { typeName, type SpecField, type SpecTable } from '../../core/src/data.ts';

export const DATA_DIR = 'src/data';

/** data-spec §5.3, closed — the same list the server's openapi.json names. */
const CODES = [
  'invalid', 'required', 'too_long', 'bad_query', 'signin_required', 'forbidden', 'unknown',
  'not_found', 'taken', 'in_use', 'too_large', 'unsupported_type', 'rate_limited',
] as const;

const str = (v: string) => JSON.stringify(v);

/** A field's TypeScript type as the API returns it. */
function valueType(f: SpecField): string {
  switch (f.type) {
    case 'number': case 'money': case 'datetime': return 'number';
    case 'flag': return 'boolean';
    case 'choice': return (f.choices ?? []).map(str).join(' | ');
    case 'image': throw new Error('data-client: image fields ship in D3');
    default: return 'string';
  }
}

const EQUALITY = new Set(['number', 'money', 'flag', 'date', 'datetime', 'choice', 'ref', 'email']);
const RANGE = new Set(['number', 'money', 'date', 'datetime']);
const SORTABLE = new Set(['text', 'number', 'money', 'date', 'datetime', 'choice']);

function tableBlock(t: SpecTable): string {
  const T = typeName(t.name);
  const row = t.fields.map((f) => {
    // A flag is never null (absent is off); a private field is null on
    // every row but the caller's own; an optional one may be empty.
    const nullable = f.type !== 'flag' && (!f.required || f.private);
    return `  readonly ${f.name}: ${valueType(f)}${nullable ? ' | null' : ''};`;
  });
  const writable = t.fields.filter((f) => !f.locked);
  const input = writable.map((f) => {
    const needed = f.required && f.default === undefined;
    return `  ${f.name}${needed ? '' : '?'}: ${valueType(f)}${f.required ? '' : ' | null'};`;
  });
  const patch = writable.map((f) => `  ${f.name}?: ${valueType(f)}${f.required ? '' : ' | null'};`);
  // Query keys: private fields only filter your own rows (mine), so they are offered too.
  const sortKeys = ['created', 'updated', ...t.fields.filter((f) => f.required && SORTABLE.has(f.type)).map((f) => f.name)];
  const query = [
    '  limit?: number;',
    '  after?: string;',
    `  sort?: ${sortKeys.flatMap((k) => [str(k), str(`-${k}`)]).join(' | ')};`,
    '  mine?: boolean;',
    ...(t.fields.some((f) => f.search) ? ['  q?: string;'] : []),
    ...t.fields.flatMap((f) => [
      ...(EQUALITY.has(f.type) ? [`  ${str(f.name)}?: ${valueType(f)};`] : []),
      ...(RANGE.has(f.type) ? ['lt', 'lte', 'gt', 'gte'].map((op) => `  ${str(`${f.name}.${op}`)}?: ${valueType(f)};`) : []),
      ...(f.type === 'choice' || f.type === 'ref' ? [`  ${str(`${f.name}.in`)}?: readonly (${valueType(f)})[];`] : []),
    ]),
  ];
  return `/** A row of \`${t.name}\`. \`mine\`: the signed-in account owns it. */
export interface ${T} {
  readonly id: string;
  readonly created: number;
  readonly updated: number;
  readonly mine: boolean;
${row.join('\n')}
}

/** A new row: the fields anyone writing may set (locked fields are admin-only). */
export interface ${T}Input {
${input.join('\n')}
}

/** A change: any of the same fields; null clears an optional one. */
export interface ${T}Patch {
${patch.join('\n')}
}

export interface ${T}Query {
${query.join('\n')}
}

`;
}

/** A table's routes in the `tables` object: only those its allow lines open. */
function tableRoutes(t: SpecTable): string {
  const T = typeName(t.name);
  const path = `/data/${t.name}`;
  const one = (id = 'id') => `\`${path}/\${encodeURIComponent(${id})}\``;
  const ops = [
    ...(t.rules.read.length > 0 ? [
      `    /** A page of rows; pass \`next\` back as \`after\` for the following page. */\n    list: (query: ${T}Query = {}) => call<{ items: ${T}[]; next: string | null }>("GET", \`${path}\${search(query)}\`),`,
      `    get: (id: string) => call<{ item: ${T} }>("GET", ${one()}),`,
    ] : []),
    ...(t.rules.create.length > 0 ? [`    create: (input: ${T}Input) => call<{ item: ${T} }>("POST", ${str(path)}, input),`] : []),
    ...(t.rules.edit.length > 0 ? [`    update: (id: string, changes: ${T}Patch) => call<{ item: ${T} }>("PATCH", ${one()}, changes),`] : []),
    ...(t.rules.delete.length > 0 ? [`    remove: (id: string) => call<Record<string, never>>("DELETE", ${one()}),`] : []),
  ];
  const what = ops.length === 0 ? 'no allow line opens it to the site (admins only)' : 'the routes its allow lines open';
  return `  /** \`${t.name}\` — ${what}. */\n  ${t.name}: {\n${ops.join('\n')}\n  },`;
}

/** The client module's text for these tables. */
export function dataClient(tables: readonly SpecTable[]): string {
  return `${generated('the typed client for the site\'s data tables: list/get/create/update/remove per table (data-spec §7)')}
/** Every refusal the server can answer (data-spec §5.3). */
export type DataErrorCode = ${CODES.map(str).join(' | ')};

export type DataResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly code: DataErrorCode; readonly field?: string };

const BASE: string = import.meta.env.${BACKEND_ENV[0]} ?? "";
const CODES: ReadonlySet<string> = new Set<DataErrorCode>([${CODES.map(str).join(', ')}]);

/** A query object as the server's parameters: flags on/off, lists comma-joined, mine as 1. */
function search(query: object): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (key === "mine") { if (value === true) p.set("mine", "1"); continue; }
    p.set(key, Array.isArray(value) ? value.join(",") : typeof value === "boolean" ? (value ? "on" : "off") : String(value));
  }
  const s = p.toString();
  return s ? \`?\${s}\` : "";
}

/** One request; always resolves, never throws. */
async function call<T>(method: string, path: string, body?: unknown): Promise<DataResult<T>> {
  let res: Response;
  try {
    res = await fetch(\`\${BASE}\${path}\`, {
      method,
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "x-az-request": "1" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, code: "unknown" };
  }
  if (res.status === 204) return { ok: true } as DataResult<T>;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, code: "unknown" };
  }
  const answer = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof answer.error === "string" && CODES.has(answer.error) ? answer.error as DataErrorCode : "unknown";
    return { ok: false, code, ...(typeof answer.field === "string" ? { field: answer.field } : {}) };
  }
  return { ok: true, ...answer } as DataResult<T>;
}

${tables.map(tableBlock).join('\n')}
/**
 * Every table, by its name in the .az file: \`tables.products.list()\`. One
 * object, so a table may be named anything the grammar allows — \`class\` or
 * \`delete\` are fine as keys, never as variable names.
 */
export const tables = {
${tables.map(tableRoutes).join('\n')}
} as const;
`;
}
