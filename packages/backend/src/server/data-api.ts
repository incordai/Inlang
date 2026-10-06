/**
 * @az server data-api
 * Purpose: the /data/<table> routes and the /admin routes: rules in every statement, allow-listed bodies, closed codes, audit, limits.
 * Spec: docs/data-spec.md §4.7, §5, §11
 * Exports: createData, parseAdminEmails, DATA_BODY_LIMIT, DATA_LIMITS, isForeignKeyViolation
 * Edit guide: deny unless a rule grants; the owner check lives in the SQL; unreadable is answered exactly like absent (404).
 *   Admins (verified, listed) bypass rules, never validation; every admin write is audited without values.
 * Tests: packages/backend/test/data-api.test.ts
 */

/**
 * The REST API over the declared tables (data-spec §5). The file names who
 * may do what from two closed lists (§4.7); here each grant becomes part of
 * the one statement that does the work — `AND owner = ?` on an owner's edit,
 * a private column nulled by `CASE` for everyone but its owner — so there is
 * no check that runs apart from the query and could be skipped.
 *
 * Every refusal is a code from the closed set; a row the caller may not see
 * or change is answered exactly like a row that does not exist (404), so an
 * answer never says whether someone else's row is there.
 *
 * Copied into a generated server only when the site declares data; imports
 * only its siblings and node built-ins.
 */

import { randomUUID } from 'node:crypto';
import type { DataRequest, DataRoutes } from './app.ts';
import { isUniqueViolation, type Db, type Value } from './db.ts';
import { BodyError, createLimiter } from './http.ts';
import { adminCount, adminSelectList, adminSelectOne, cursorOf, LIMIT_DEFAULT, LIMIT_MAX, parseQuery, QueryError, selectList, selectOne } from './data-query.ts';
import { isEmail } from './app.ts';
import { checkValue, isUuid, outRow, physical, q, storedDefault, type Stored, type Table, type Who } from './data-values.ts';

/** A full longtext is up to 40 KB of UTF-8; auth routes keep 16 KB (data-spec §5.2). */
export const DATA_BODY_LIMIT = 64 * 1024;

const MINUTE = 60 * 1000;
/** data-spec §5.5 — fixed in v1, per process. */
export const DATA_LIMITS = {
  readsPerAddress: [600, 10 * MINUTE],
  writesPerAddress: [60, 10 * MINUTE],
  anyoneCreatePerAddressTable: [10, 60 * MINUTE],
  writesPerAccount: [120, 10 * MINUTE],
  /** data-spec §11: stricter than the public writes, per admin account. */
  adminWritesPerAccount: [300, 10 * MINUTE],
} as const;

/**
 * `AZ_ADMIN_EMAILS` (data-spec §11): comma-separated, compared lower-cased.
 * An empty list is legal — the admin routes then answer 403 to everyone. A
 * malformed entry stops the server, naming it: a typo here would otherwise
 * silently lock the owner out (or, worse, name someone else).
 */
export function parseAdminEmails(raw: string | undefined): { ok: true; emails: string[] } | { ok: false; problem: string } {
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of entries) {
    if (!isEmail(e)) return { ok: false, problem: `AZ_ADMIN_EMAILS entry '${e.length > 60 ? `${e.slice(0, 60)}…` : e}' is not an email address` };
  }
  return { ok: true, emails: [...new Set(entries.map((e) => e.toLowerCase()))].sort() };
}

type Result = { status: number; body?: unknown };
const fail = (status: number, error: string, field?: string): Result => ({ status, body: { error, ...(field ? { field } : {}) } });
const NOT_FOUND = fail(404, 'not_found');

/** A foreign-key violation, whichever engine raised it. */
export function isForeignKeyViolation(e: unknown): boolean {
  const err = e as { code?: unknown; errno?: unknown; errcode?: unknown; message?: unknown };
  // PostgreSQL raises restrict_violation (23001) for ON DELETE RESTRICT and
  // foreign_key_violation (23503) for a missing target — found on the real
  // engine (scripts/backend-db-data.mjs), not in the driver's docs.
  return err?.code === '23503' || err?.code === '23001'
    || err?.errno === 1451 || err?.errno === 1452                  // MySQL row is referenced / no referenced row
    || err?.errcode === 787                                        // SQLite SQLITE_CONSTRAINT_FOREIGNKEY
    || (typeof err?.message === 'string' && /FOREIGN KEY constraint failed/.test(err.message));
}

type Grant = { ok: true; ownerOnly: boolean } | { ok: false; result: Result };

/**
 * Whether a rule list grants an action to this caller, and whether only on
 * their own rows. No rule at all is 403 for everyone (signing in would not
 * help); a rule that needs a session is 401 without one.
 */
function grant(who: readonly Who[], user: string | null): Grant {
  if (who.includes('anyone')) return { ok: true, ownerOnly: false };
  if (who.length === 0) return { ok: false, result: fail(403, 'forbidden') };
  if (user === null) return { ok: false, result: fail(401, 'signin_required') };
  return { ok: true, ownerOnly: !who.includes('signedin') };
}

export interface DataDeps {
  readonly db: Db;
  readonly tables: readonly Table[];
  /** Lower-cased admin addresses (parseAdminEmails); empty = no admins. */
  readonly admins?: readonly string[];
  readonly now?: () => number;
}

/** An audit row as the admin area lists it — ids, names and times, never a value. */
const AUDIT_ACTIONS = ['create', 'edit', 'delete'] as const;
type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function createData(deps: DataDeps): DataRoutes {
  const { db } = deps;
  const d = db.dialect;
  const now = deps.now ?? Date.now;
  const tables = new Map(deps.tables.map((t) => [t.name, t]));
  const limits = {
    readsPerAddress: createLimiter(...DATA_LIMITS.readsPerAddress, now),
    writesPerAddress: createLimiter(...DATA_LIMITS.writesPerAddress, now),
    anyoneCreate: createLimiter(...DATA_LIMITS.anyoneCreatePerAddressTable, now),
    writesPerAccount: createLimiter(...DATA_LIMITS.writesPerAccount, now),
    adminWrites: createLimiter(...DATA_LIMITS.adminWritesPerAccount, now),
  };
  const admins = new Set((deps.admins ?? []).map((e) => e.toLowerCase()));

  /**
   * The body's keys and values, against the fields a caller may write. An
   * admin may also write `locked` fields (data-spec §4.5, §11) — but every
   * value is still checked: rules are bypassed for admins, validation never.
   */
  function readFields(t: Table, body: Record<string, unknown>, creating: boolean, admin = false): { ok: true; values: Map<string, Stored> } | { ok: false; result: Result } {
    const writable = new Map(t.fields.filter((f) => admin || !f.locked).map((f) => [f.name, f]));
    for (const key of Object.keys(body)) {
      if (!writable.has(key)) return { ok: false, result: fail(400, 'invalid', key) };
    }
    const values = new Map<string, Stored>();
    for (const f of t.fields) {
      const given = Object.hasOwn(body, f.name);
      if (given) {
        const r = checkValue(f, body[f.name]);
        if (!r.ok) return { ok: false, result: fail(400, r.problem, f.name) };
        if (r.value === null && f.required) return { ok: false, result: fail(400, 'required', f.name) };
        values.set(f.name, r.value);
      } else if (creating) {
        const fallback = storedDefault(f);
        if (fallback === undefined && f.required) return { ok: false, result: fail(400, 'required', f.name) };
        values.set(f.name, fallback ?? null);
      }
    }
    return { ok: true, values };
  }

  /** Each ref value names a row that exists — so the answer can name the field. */
  async function missingRef(t: Table, values: Map<string, Stored>): Promise<string | null> {
    for (const f of t.fields) {
      const v = values.get(f.name);
      if (f.type !== 'ref' || v === null || v === undefined) continue;
      const found = await db.get(`SELECT 1 AS x FROM ${q(d, physical(f.ref!))} WHERE ${q(d, 'id')} = ?`, [v]);
      if (!found) return f.name;
    }
    return null;
  }

  /** After a unique violation: the first written unique field another row already holds. */
  async function takenField(t: Table, values: Map<string, Stored>, id: string): Promise<string | undefined> {
    for (const f of t.fields) {
      const v = values.get(f.name);
      if (!f.unique || v === null || v === undefined) continue;
      const row = await db.get(`SELECT 1 AS x FROM ${q(d, physical(t.name))} WHERE ${q(d, f.name)} = ? AND ${q(d, 'id')} <> ?`, [v, id]);
      if (row) return f.name;
    }
    return undefined;
  }

  async function readOne(t: Table, id: string, user: string | null): Promise<Record<string, unknown> | null> {
    const s = selectOne(d, t, id, user, false);
    const row = await db.get(s.sql, s.params);
    return row ? outRow(t, row, user) : null;
  }

  async function write(t: Table, values: Map<string, Stored>, id: string, run: () => Promise<number>): Promise<Result | number> {
    const missing = await missingRef(t, values);
    if (missing) return fail(400, 'invalid', missing);
    try {
      return await run();
    } catch (e) {
      if (isUniqueViolation(e)) return fail(409, 'taken', await takenField(t, values, id));
      if (isForeignKeyViolation(e)) {
        // A ref target removed between the check and the write.
        const ref = t.fields.find((f) => f.type === 'ref' && values.get(f.name) != null);
        return fail(400, 'invalid', ref?.name);
      }
      throw e;
    }
  }

  async function list(t: Table, req: DataRequest, user: string | null): Promise<Result> {
    const g = grant(t.rules.read, user);
    if (!g.ok) return g.result;
    let lq;
    try {
      lq = parseQuery(t, req.url.searchParams, g.ownerOnly);
    } catch (e) {
      if (e instanceof QueryError) return fail(400, 'bad_query', e.field);
      throw e;
    }
    if (lq.mine && user === null) return fail(401, 'signin_required');
    const s = selectList(d, t, lq, user, g.ownerOnly);
    const rows = await db.all(s.sql, s.params);
    const page = rows.slice(0, lq.limit);
    return {
      status: 200,
      body: {
        items: page.map((r) => outRow(t, r, user)),
        next: rows.length > lq.limit ? cursorOf(lq.sort, page[page.length - 1]) : null,
      },
    };
  }

  async function getOne(t: Table, id: string, user: string | null): Promise<Result> {
    const g = grant(t.rules.read, user);
    if (!g.ok) return g.result;
    const s = selectOne(d, t, id, user, g.ownerOnly);
    const row = await db.get(s.sql, s.params);
    return row ? { status: 200, body: { item: outRow(t, row, user) } } : NOT_FOUND;
  }

  async function create(t: Table, body: Record<string, unknown>, user: string | null): Promise<Result> {
    const read = readFields(t, body, true);
    if (!read.ok) return read.result;
    const id = randomUUID();
    const at = now();
    const cols = ['id', 'owner', 'created', 'updated', ...read.values.keys()];
    const params: Value[] = [id, user, at, at, ...read.values.values()];
    const outcome = await write(t, read.values, id, () =>
      db.run(`INSERT INTO ${q(d, physical(t.name))} (${cols.map((c) => q(d, c)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params));
    if (typeof outcome !== 'number') return outcome;
    return { status: 201, body: { item: await readOne(t, id, user) } };
  }

  async function update(t: Table, id: string, body: Record<string, unknown>, user: string): Promise<Result> {
    const read = readFields(t, body, false);
    if (!read.ok) return read.result;
    const sets = [...read.values.keys()].map((c) => `${q(d, c)} = ?`);
    const params: Value[] = [...read.values.values(), now(), id, user];
    const outcome = await write(t, read.values, id, () =>
      db.run(`UPDATE ${q(d, physical(t.name))} SET ${[...sets, `${q(d, 'updated')} = ?`].join(', ')} WHERE ${q(d, 'id')} = ? AND ${q(d, 'owner')} = ?`, params));
    if (typeof outcome !== 'number') return outcome;
    if (outcome === 0) return NOT_FOUND;
    return { status: 200, body: { item: await readOne(t, id, user) } };
  }

  async function remove(t: Table, id: string, user: string): Promise<Result> {
    try {
      const n = await db.run(`DELETE FROM ${q(d, physical(t.name))} WHERE ${q(d, 'id')} = ? AND ${q(d, 'owner')} = ?`, [id, user]);
      return n === 0 ? NOT_FOUND : { status: 204 };
    } catch (e) {
      if (isForeignKeyViolation(e)) return fail(409, 'in_use');
      throw e;
    }
  }

  /* ---- the admin routes (data-spec §11) ------------------------------- */

  /** A row for an admin: the API's shape plus the owner's address. */
  const adminRow = (t: Table, row: Record<string, unknown>, admin: string) =>
    ({ ...outRow(t, row, admin), ownerEmail: row.az_owner_email == null ? null : String(row.az_owner_email) });

  /** Who wrote what row, when — never a value (data-spec §11, backend-spec §5). */
  async function audit(admin: string, table: string, rowId: string, action: AuditAction): Promise<void> {
    await db.run('INSERT INTO az_data_audit (id, admin, tbl, row_id, action, at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), admin, table, rowId, action, now()]);
  }

  /**
   * The caller is an admin: a VERIFIED account whose address is listed. An
   * unverified account with a listed address is not one — anyone could sign
   * up with the owner's address (data-spec §11, threat "Admin takeover").
   * Decided before any table is looked up, so a non-admin learns nothing
   * about which tables exist.
   */
  async function adminOf(req: DataRequest): Promise<{ ok: true; id: string } | { ok: false; result: Result }> {
    if (admins.size === 0) return { ok: false, result: fail(403, 'forbidden') };
    const a = await req.account();
    if (a === null) return { ok: false, result: fail(401, 'signin_required') };
    if (!a.verified || !admins.has(a.email.toLowerCase())) return { ok: false, result: fail(403, 'forbidden') };
    return { ok: true, id: a.id };
  }

  /** Every table with its row count: the admin area's first page. */
  async function adminTables(): Promise<Result> {
    const out = [];
    for (const t of tables.values()) {
      const row = await db.get(`SELECT COUNT(*) AS n FROM ${q(d, physical(t.name))}`, []);
      out.push({ name: t.name, count: Number(row?.n ?? 0) });
    }
    return { status: 200, body: { tables: out } };
  }

  /** The audit log, newest first, keyset-paged on (at, id). */
  async function adminAudit(params: URLSearchParams): Promise<Result> {
    let limit = LIMIT_DEFAULT;
    let after: [number, string] | null = null;
    const seen = new Set<string>();
    for (const [k, v] of params) {
      // A repeated parameter is refused, as parseQuery refuses it.
      if (seen.has(k)) return fail(400, 'bad_query', k);
      seen.add(k);
      if (k === 'limit') {
        if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > LIMIT_MAX) return fail(400, 'bad_query', k);
        limit = Number(v);
      } else if (k === 'after') {
        let decoded: unknown;
        try {
          decoded = /^[A-Za-z0-9_-]{1,200}$/.test(v) ? JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) : null;
        } catch {
          decoded = null;
        }
        if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isSafeInteger(decoded[0]) || !isUuid(decoded[1])) return fail(400, 'bad_query', k);
        after = [decoded[0] as number, decoded[1] as string];
      } else {
        return fail(400, 'bad_query', k);
      }
    }
    const where = after ? ' WHERE (at < ? OR (at = ? AND id < ?))' : '';
    const rows = await db.all(
      `SELECT id, admin, tbl, row_id, action, at, (SELECT u.email FROM az_users u WHERE u.id = a.admin) AS admin_email FROM az_data_audit a${where} ORDER BY at DESC, id DESC LIMIT ${Math.trunc(limit) + 1}`,
      after ? [after[0], after[0], after[1]] : []);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      status: 200,
      body: {
        items: page.map((r) => ({
          id: String(r.id), table: String(r.tbl), row: String(r.row_id), action: String(r.action),
          at: Number(r.at), admin: r.admin_email == null ? null : String(r.admin_email),
        })),
        next: rows.length > limit ? Buffer.from(JSON.stringify([Number(last.at), String(last.id)]), 'utf8').toString('base64url') : null,
      },
    };
  }

  async function adminList(t: Table, req: DataRequest, admin: string): Promise<Result> {
    let lq;
    try {
      // `own: true` — an admin may filter, sort and search private fields.
      lq = parseQuery(t, req.url.searchParams, true);
    } catch (e) {
      if (e instanceof QueryError) return fail(400, 'bad_query', e.field);
      throw e;
    }
    const s = adminSelectList(d, t, lq, admin);
    const rows = await db.all(s.sql, s.params);
    const page = rows.slice(0, lq.limit);
    const c = adminCount(d, t, lq, admin);
    const count = Number((await db.get(c.sql, c.params))?.n ?? 0);
    return {
      status: 200,
      body: {
        items: page.map((r) => adminRow(t, r, admin)),
        next: rows.length > lq.limit ? cursorOf(lq.sort, page[page.length - 1]) : null,
        count,
      },
    };
  }

  async function adminGet(t: Table, id: string, admin: string): Promise<Result> {
    const s = adminSelectOne(d, t, id);
    const row = await db.get(s.sql, s.params);
    return row ? { status: 200, body: { item: adminRow(t, row, admin) } } : NOT_FOUND;
  }

  async function adminRead(t: Table, id: string, admin: string): Promise<Record<string, unknown> | null> {
    const s = adminSelectOne(d, t, id);
    const row = await db.get(s.sql, s.params);
    return row ? adminRow(t, row, admin) : null;
  }

  async function adminCreate(t: Table, body: Record<string, unknown>, admin: string): Promise<Result> {
    const read = readFields(t, body, true, true);
    if (!read.ok) return read.result;
    const id = randomUUID();
    const at = now();
    const cols = ['id', 'owner', 'created', 'updated', ...read.values.keys()];
    const params: Value[] = [id, admin, at, at, ...read.values.values()];
    const outcome = await write(t, read.values, id, () =>
      db.run(`INSERT INTO ${q(d, physical(t.name))} (${cols.map((c) => q(d, c)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params));
    if (typeof outcome !== 'number') return outcome;
    await audit(admin, t.name, id, 'create');
    return { status: 201, body: { item: await adminRead(t, id, admin) } };
  }

  async function adminEdit(t: Table, id: string, body: Record<string, unknown>, admin: string): Promise<Result> {
    const read = readFields(t, body, false, true);
    if (!read.ok) return read.result;
    const sets = [...read.values.keys()].map((c) => `${q(d, c)} = ?`);
    const params: Value[] = [...read.values.values(), now(), id];
    const outcome = await write(t, read.values, id, () =>
      db.run(`UPDATE ${q(d, physical(t.name))} SET ${[...sets, `${q(d, 'updated')} = ?`].join(', ')} WHERE ${q(d, 'id')} = ?`, params));
    if (typeof outcome !== 'number') return outcome;
    if (outcome === 0) return NOT_FOUND;
    await audit(admin, t.name, id, 'edit');
    return { status: 200, body: { item: await adminRead(t, id, admin) } };
  }

  async function adminDelete(t: Table, id: string, admin: string): Promise<Result> {
    let n: number;
    try {
      n = await db.run(`DELETE FROM ${q(d, physical(t.name))} WHERE ${q(d, 'id')} = ?`, [id]);
    } catch (e) {
      if (isForeignKeyViolation(e)) return fail(409, 'in_use');
      throw e;
    }
    if (n === 0) return NOT_FOUND;
    await audit(admin, t.name, id, 'delete');
    return { status: 204 };
  }

  async function handleAdmin(req: DataRequest, parts: readonly string[]): Promise<Result> {
    // '', 'admin', 'data'|'audit', table?, id?
    const isRead = req.method === 'GET';
    if (isRead && !limits.readsPerAddress.take(req.ip)) return fail(429, 'rate_limited');
    const who = await adminOf(req);
    // A refused write counts against the address, as a public write would; an
    // admin's writes are bounded per account instead (adminWrites below), so
    // moderation is not stopped at the public 60 per address.
    if (!who.ok) return !isRead && !limits.writesPerAddress.take(req.ip) ? fail(429, 'rate_limited') : who.result;
    const admin = who.id;

    if (parts[2] === 'audit') {
      if (parts.length !== 3 || !isRead) return NOT_FOUND;
      return adminAudit(req.url.searchParams);
    }
    if (parts[2] !== 'data' || parts.length < 3 || parts.length > 5) return NOT_FOUND;
    if (parts.length === 3) {
      if (!isRead) return NOT_FOUND;
      const stray = req.url.searchParams.keys().next().value;
      return stray === undefined ? adminTables() : fail(400, 'bad_query', stray);
    }
    const t = tables.get(parts[3]);
    if (!t) return NOT_FOUND;
    const id = parts[4];
    if (id !== undefined && !isUuid(id)) return NOT_FOUND;
    const route = id === undefined
      ? ({ GET: 'list', POST: 'create' } as const)[req.method as 'GET' | 'POST']
      : ({ GET: 'get', PATCH: 'edit', DELETE: 'delete' } as const)[req.method as 'GET' | 'PATCH' | 'DELETE'];
    if (route === undefined) return NOT_FOUND;
    const stray = route === 'list' ? undefined : req.url.searchParams.keys().next().value;
    if (stray !== undefined) return fail(400, 'bad_query', stray);
    if (route === 'list') return adminList(t, req, admin);
    if (route === 'get') return adminGet(t, id!, admin);
    if (!limits.adminWrites.take(admin)) return fail(429, 'rate_limited');
    if (route === 'delete') return adminDelete(t, id!, admin);
    let body: Record<string, unknown>;
    try {
      body = await req.body(DATA_BODY_LIMIT);
    } catch (e) {
      if (e instanceof BodyError) return e.message === 'too large' ? fail(413, 'too_large') : fail(400, 'invalid');
      throw e;
    }
    return route === 'create' ? adminCreate(t, body, admin) : adminEdit(t, id!, body, admin);
  }

  async function handle(req: DataRequest): Promise<Result> {
    const parts = req.url.pathname.split('/');
    if (parts[1] === 'admin') return handleAdmin(req, parts);
    // '', 'data', table, id?
    const t = parts.length >= 3 && parts.length <= 4 ? tables.get(parts[2]) : undefined;
    if (!t || parts[1] !== 'data') return NOT_FOUND;
    const id = parts[3];
    if (id !== undefined && !isUuid(id)) return NOT_FOUND;
    // The five routes; any other method or shape is absent.
    const route = id === undefined
      ? ({ GET: 'list', POST: 'create' } as const)[req.method as 'GET' | 'POST']
      : ({ GET: 'get', PATCH: 'edit', DELETE: 'delete' } as const)[req.method as 'GET' | 'PATCH' | 'DELETE'];
    if (route === undefined) return NOT_FOUND;
    const isRead = route === 'list' || route === 'get';
    if (!(isRead ? limits.readsPerAddress : limits.writesPerAddress).take(req.ip)) return fail(429, 'rate_limited');
    // Only a list takes parameters; anything on another route is unknown.
    const stray = route === 'list' ? undefined : req.url.searchParams.keys().next().value;
    if (stray !== undefined) return fail(400, 'bad_query', stray);

    const user = await req.user();
    if (route === 'list') return list(t, req, user);
    if (route === 'get') return getOne(t, id!, user);

    const action = route;
    const g = grant(t.rules[action], user);
    if (!g.ok) return g.result;
    if (user !== null && !limits.writesPerAccount.take(user)) return fail(429, 'rate_limited');
    if (action === 'create' && user === null && !limits.anyoneCreate.take(`${t.name}\u0000${req.ip}`)) return fail(429, 'rate_limited');
    if (action === 'delete') return remove(t, id!, user!);

    let body: Record<string, unknown>;
    try {
      body = await req.body(DATA_BODY_LIMIT);
    } catch (e) {
      if (e instanceof BodyError) return e.message === 'too large' ? fail(413, 'too_large') : fail(400, 'invalid');
      throw e;
    }
    return action === 'create' ? create(t, body, user) : update(t, id!, body, user!);
  }

  return {
    handle,
    sweep: () => { for (const l of Object.values(limits)) l.sweep(); },
  };
}
