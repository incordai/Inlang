/**
 * @az module data-client
 * Purpose: src/data/client.ts — the typed client for the data tables: list/get/create/update/remove/upload/clear per table, and the admin routes.
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
import { typeName, writeEcho, type SpecField, type SpecTable } from '../../core/src/data.ts';

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
    case 'image': return 'DataImage';
    default: return 'string';
  }
}

const EQUALITY = new Set(['number', 'money', 'flag', 'date', 'datetime', 'choice', 'ref', 'email']);
const RANGE = new Set(['number', 'money', 'date', 'datetime']);
const SORTABLE = new Set(['text', 'number', 'money', 'date', 'datetime', 'choice']);

const hasImages = (tables: readonly SpecTable[]) => tables.some((t) => t.fields.some((f) => f.type === 'image'));
/** The image fields a caller other than an admin may upload to (locked ones are admin-only). */
const uploadable = (t: SpecTable) => (t.rules.edit.length > 0 ? t.fields.filter((f) => f.type === 'image' && !f.locked) : []);

function tableBlock(t: SpecTable): string {
  const T = typeName(t.name);
  const row = t.fields.map((f) => {
    // A flag is never null (absent is off); a private field is null on
    // every row but the caller's own; an optional one (every image) may be empty.
    const nullable = f.type !== 'flag' && (!f.required || f.private || f.type === 'image');
    return `  readonly ${f.name}: ${valueType(f)}${nullable ? ' | null' : ''};`;
  });
  // An image is never in a JSON body: it has its own upload route.
  const writable = t.fields.filter((f) => !f.locked && f.type !== 'image');
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
  // A write answers with its row only as the read rules grant it to the writer.
  const echo = writeEcho(t.rules);
  const answer = (e: 'row' | 'none' | 'maybe') => (e === 'row' ? T : e === 'none' ? 'null' : `${T} | null`);
  const [created, edited] = [answer(echo.create), answer(echo.edit)];
  const ops = [
    ...(t.rules.read.length > 0 ? [
      `    /** A page of rows; pass \`next\` back as \`after\` for the following page. */\n    list: (query: ${T}Query = {}) => call<{ items: ${T}[]; next: string | null }>("GET", \`${path}\${search(query)}\`),`,
      `    get: (id: string) => toRow<{ item: ${T} }>("GET", rowPath(${str(path)}, id)),`,
    ] : []),
    ...(t.rules.create.length > 0 ? [`    create: (input: ${T}Input) => call<{ item: ${created} }>("POST", ${str(path)}, input),`] : []),
    ...(t.rules.edit.length > 0 ? [`    update: (id: string, changes: ${T}Patch) => toRow<{ item: ${edited} }>("PATCH", rowPath(${str(path)}, id), changes),`] : []),
    ...(t.rules.delete.length > 0 ? [`    remove: (id: string) => toRow<Record<string, never>>("DELETE", rowPath(${str(path)}, id)),`] : []),
    ...(uploadable(t).length > 0 ? (() => {
      const fields = uploadable(t).map((f) => str(f.name)).join(' | ');
      return [
        `    /** Upload an image file (JPEG, PNG, WebP or AVIF) to an image field of a row you own; it is stored re-encoded, without metadata. */\n    upload: (id: string, field: ${fields}, file: Blob) => toRow<{ item: ${edited} }>("PUT", rowPath(${str(path)}, id, field), file),`,
        `    clear: (id: string, field: ${fields}) => toRow<{ item: ${edited} }>("DELETE", rowPath(${str(path)}, id, field)),`,
      ];
    })() : []),
  ];
  const what = ops.length === 0 ? 'no allow line opens it to the site (admins only)' : 'the routes its allow lines open';
  return `  /** \`${t.name}\` — ${what}. */\n  ${t.name}: {\n${ops.join('\n')}\n  },`;
}

/** The admin's view of the chat's counts (chat-block-spec §11.4), on a site with chat only. */
const CHAT_USAGE_TYPE = `/** One day of chat, as the server counts it (chat-block-spec §11.4): counts only, never a message. */
export interface ChatUsageDay {
  readonly day: string;
  readonly messages: number;
  readonly input: number;
  readonly output: number;
  readonly dropped: number;
  readonly shares: number;
}

/** Today's spend against the day's budget, the last 30 days with anything counted (newest first), the shares kept. */
export interface ChatUsage {
  readonly today: string;
  readonly budget: { readonly daily: number; readonly spent: number; readonly left: number };
  readonly days: readonly ChatUsageDay[];
  readonly shares: { readonly enabled: boolean; readonly kept: number };
}

`;

const CHAT_USAGE_ROUTE = `
  /** The chat's daily counts and the budget left (chat-block-spec §11.4) — never a message. */
  chatUsage: () => call<{ usage: ChatUsage }>("GET", "/admin/chat"),`;

/** The client module's text for these tables; `chat`: the site shows a chat, so its admins may read its usage. */
export function dataClient(tables: readonly SpecTable[], chat = false): string {
  // Only a site with image fields gets the image type and raw-body uploads, so the others' client is unchanged.
  const images = hasImages(tables);
  return `${generated('the typed client for the site\'s data tables: list/get/create/update/remove per table (data-spec §7)')}
/** Every refusal the server can answer (data-spec §5.3). */
export type DataErrorCode = ${CODES.map(str).join(' | ')};

export type DataResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly code: DataErrorCode; readonly field?: string };
${images ? `
/** An uploaded image (data-spec §8): its address changes with every upload. */
export interface DataImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** Narrower copies of it, widest last (480, 768, 1200 below its width); none for an image stored before copies were made. */
  readonly variants: readonly { readonly url: string; readonly width: number }[];
}

/**
 * An image's \`srcset\` (gallery-spec §7 rule 3): each copy and the image
 * itself at its width — or undefined when it has no copy, so the <img>
 * keeps its \`src\` alone. Give it a \`sizes\` saying how wide it is drawn.
 */
export function imageSrcset(image: DataImage): string | undefined {
  if (image.variants.length === 0) return undefined;
  return [...image.variants, image].map((v) => \`\${v.url} \${v.width}w\`).join(", ");
}
` : ''}
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

/** One request — JSON, or a file's raw bytes for an image upload; always resolves, never throws. */
async function call<T>(method: string, path: string, body?: unknown): Promise<DataResult<T>> {
  let res: Response;
  const raw = body instanceof Blob;
  try {
    res = await fetch(\`\${BASE}\${path}\`, {
      method,
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "content-type": raw ? "application/octet-stream" : "application/json" }),
        ...(method === "GET" ? {} : { "x-az-request": "1" }),
      },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
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

/** A row id as the server makes one (a random UUID, data-spec §3); a field or table name as the compiler writes one. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9]*$/;

/**
 * The path to one row (or one of its image fields), or null when the id or
 * field cannot be one. Checked here, before any URL is built: \`..\` survives
 * encodeURIComponent and fetch resolves it, so \`get("..")\` would otherwise
 * call the table's list, and \`clear(id, "..")\` the row's DELETE.
 */
function rowPath(base: string, id: string, field?: string): string | null {
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (field !== undefined && (typeof field !== "string" || !NAME.test(field))) return null;
  return field === undefined ? \`\${base}/\${id}\` : \`\${base}/\${id}/\${field}\`;
}

/** A request to one row; a path that names none is answered as the server answers it, not_found, with no request. */
function toRow<T>(method: string, path: string | null, body?: unknown): Promise<DataResult<T>> {
  return path === null ? Promise.resolve({ ok: false, code: "not_found" }) : call<T>(method, path, body);
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

/** A table's name, as the admin routes take it. */
export type TableName = ${tables.map((t) => str(t.name)).join(' | ')};

/** An admin path to one row of a table, checked as rowPath checks one. */
const adminRow = (table: TableName, id: string, field?: string) =>
  typeof table === "string" && NAME.test(table) ? rowPath(\`/admin/data/\${table}\`, id, field) : null;

/** A row as an admin reads it: every field, private ones too, and the owner's address. */
export interface AdminRow {
  readonly id: string;
  readonly created: number;
  readonly updated: number;
  readonly mine: boolean;
  readonly ownerEmail: string | null;
  readonly [field: string]: unknown;
}

${chat ? CHAT_USAGE_TYPE : ''}/** One admin write: who, which row, when — never a value (data-spec §11). */
export interface AuditEntry {
  readonly id: string;
  readonly table: TableName;
  readonly row: string;
  readonly action: "create" | "edit" | "delete";
  readonly at: number;
  /** The admin's address; null once that account is gone. */
  readonly admin: string | null;
}

/**
 * The admin routes (data-spec §11): every table and row, rules bypassed,
 * values still checked. The server answers only a verified account listed in
 * its AZ_ADMIN_EMAILS — anyone else gets \`forbidden\`, whatever calls this.
 */
export const admin = {
  /** Every table with its row count. */
  tables: () => call<{ tables: { name: TableName; count: number }[] }>("GET", "/admin/data"),
  /** A page of rows, with \`count\`: the rows the query matches. */
  list: (table: TableName, query: Record<string, string | number | boolean> = {}) =>
    call<{ items: AdminRow[]; next: string | null; count: number }>("GET", \`/admin/data/\${table}\${search(query)}\`),
  get: (table: TableName, id: string) => toRow<{ item: AdminRow }>("GET", adminRow(table, id)),
  create: (table: TableName, input: Record<string, unknown>) => call<{ item: AdminRow }>("POST", \`/admin/data/\${table}\`, input),
  update: (table: TableName, id: string, changes: Record<string, unknown>) =>
    toRow<{ item: AdminRow }>("PATCH", adminRow(table, id), changes),
  remove: (table: TableName, id: string) => toRow<Record<string, never>>("DELETE", adminRow(table, id)),
  /** Admin writes, newest first; pass \`next\` back as \`after\`. */
  audit: (query: { limit?: number; after?: string } = {}) =>
    call<{ items: AuditEntry[]; next: string | null }>("GET", \`/admin/audit\${search(query)}\`),
  /** Upload an image file to any row's image field, locked ones included (audited as an edit). */
  upload: (table: TableName, id: string, field: string, file: Blob) =>
    toRow<{ item: AdminRow }>("PUT", adminRow(table, id, field), file),
  clear: (table: TableName, id: string, field: string) =>
    toRow<{ item: AdminRow }>("DELETE", adminRow(table, id, field)),${chat ? CHAT_USAGE_ROUTE : ''}
} as const;
`;
}
