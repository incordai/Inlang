/**
 * @az module data-admin
 * Purpose: the generated /admin pages: table list, audit, rows with search/sort/filter/paging, editor, delete confirm.
 * Spec: docs/data-spec.md §11
 * Exports: adminRoutes, adminValuesTs, adminTsx, adminCss, ADMIN_FILE, ADMIN_VALUES_FILE
 * Edit guide: UX only — the server decides who is an admin on every request; error copy comes from the closed codes.
 * Tests: packages/target-web/test/data-admin.test.ts
 */

/**
 * The admin area for a site with `data` (data-spec §11): `/admin` lists the
 * tables with their row counts and the audit log; `/admin/<table>` lists
 * rows (search, sort, filter by choice/flag/ref, keyset pages), opens an
 * editor generated from the field types, and deletes behind a confirm that
 * names the row. Not a block: generated routes, wrapped in <Protected>.
 *
 * Generated here: `src/data/admin-values.ts` (the site's tables as data, and
 * the rules turning inputs into API values and codes into sentences — plain
 * TypeScript, tested directly) and `src/data/admin.tsx` (the pages, the same
 * for every site). Their styles (adminCss) join theme.css; App.tsx routes to
 * them. Every request goes through `admin` in src/data/client.ts.
 */

import { CURRENCY_DIGITS } from '../../core/src/currencies.ts';
import { TEXT_LIMITS, type SpecField, type SpecTable } from '../../core/src/data.ts';
import { framed, px, type ThemeLike } from '../../core/src/emit-contract.ts';
import { popup } from '../../overlay/src/index.ts';
import { DATA_DIR } from './data-client.ts';
import { generated } from './generated.ts';
import { declarations } from './stylesheet.ts';

/** Where the admin pages and their value rules live in a generated project. */
export const ADMIN_FILE = `${DATA_DIR}/admin.tsx`;
export const ADMIN_VALUES_FILE = `${DATA_DIR}/admin-values.ts`;

/** The generated routes: the table list, then one per table, in file order. */
export function adminRoutes(tables: readonly SpecTable[]): string[] {
  return ['/admin', ...tables.map((t) => `/admin/${t.name}`)];
}

/** Keyset paging needs a non-null key: the server sorts on these only (data-spec §5.1). */
const SORTABLE = new Set(['text', 'number', 'money', 'date', 'datetime', 'choice']);

/** A field as the admin module carries it: what its input and checks need. */
function fieldInfo(f: SpecField): Record<string, unknown> {
  const max = (TEXT_LIMITS as Readonly<Record<string, number>>)[f.type];
  return {
    name: f.name,
    type: f.type,
    required: f.required,
    needed: f.required && f.default === undefined,
    private: f.private,
    locked: f.locked,
    ...(f.choices ? { choices: f.choices } : {}),
    ...(f.ref ? { ref: f.ref } : {}),
    ...(f.currency ? { currency: f.currency, digits: CURRENCY_DIGITS[f.currency] ?? 0 } : {}),
    ...(max !== undefined && f.type !== 'choice' ? { max } : {}),
    ...(f.default !== undefined ? { default: f.default } : {}),
  };
}

function tableInfo(t: SpecTable): Record<string, unknown> {
  const rules = [t.rules.read, t.rules.create, t.rules.edit, t.rules.delete];
  return {
    name: t.name,
    fields: t.fields.map(fieldInfo),
    sorts: ['created', 'updated', ...t.fields.filter((f) => f.required && SORTABLE.has(f.type)).map((f) => f.name)],
    search: t.fields.some((f) => f.search),
    anyoneCreates: t.rules.create.includes('anyone'),
    adminOnly: rules.every((r) => r.length === 0),
  };
}

/**
 * Data as a TypeScript literal: valid JSON, with the characters that could
 * end a surrounding script or break a string literal spelled as escapes —
 * the value is unchanged (the same rule App.tsx's page data follows).
 */
const literal = (value: unknown) => JSON.stringify(value, null, 2)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * src/data/admin-values.ts for these tables: the tables as data and the
 * value rules (input ↔ API value, code → sentence). No React and no JSX, so
 * the rules are tested as the browser runs them (data-admin.test.ts).
 */
export function adminValuesTs(tables: readonly SpecTable[]): string {
  return `${generated('the admin pages\' tables and value rules: inputs to API values, codes to sentences')}import type { AdminRow, DataErrorCode, TableName } from "./client.ts";

export type FieldType = "text" | "longtext" | "number" | "money" | "flag" | "date" | "datetime" | "email" | "url" | "choice" | "image" | "ref";

export interface FieldInfo {
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  /** Required with no default: a new row must give it. */
  readonly needed: boolean;
  readonly private: boolean;
  readonly locked: boolean;
  readonly choices?: readonly string[];
  readonly ref?: TableName;
  readonly currency?: string;
  /** money: the currency's minor-unit digits (usd 2, jpy 0). */
  readonly digits?: number;
  /** The most characters the server takes. */
  readonly max?: number;
  readonly default?: string | number | boolean;
}

export interface TableInfo {
  readonly name: TableName;
  readonly fields: readonly FieldInfo[];
  /** The sort keys the server accepts: created, updated and required sortable fields. */
  readonly sorts: readonly string[];
  readonly search: boolean;
  /** \`allow anyone create\`: strangers add rows, so the page says to moderate them. */
  readonly anyoneCreates: boolean;
  /** No allow line: only admins reach it. */
  readonly adminOnly: boolean;
}

/** The site's tables, from its .az file. */
export const TABLES: readonly TableInfo[] = ${literal(tables.map(tableInfo))};

export const PAGE_SIZE = 20;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** data-spec §5.3's codes as sentences — the server never writes one. */
export function problemText(code: DataErrorCode, field?: string): string {
  const what = field ? label(field) : "A value";
  switch (code) {
    case "required": return what + " is required.";
    case "too_long": return what + " is too long.";
    case "invalid": return what + " is not valid.";
    case "taken": return what + ": another row already has this value.";
    case "in_use": return "Other rows point at this row. Change or delete them first.";
    case "not_found": return "This row no longer exists.";
    case "forbidden": return "This account is not an admin of this site.";
    case "signin_required": return "Your session has ended. Sign in again.";
    case "rate_limited": return "Too many changes in a short time. Wait a few minutes, then try again.";
    case "too_large": return field ? what + " is too large: use a smaller file, at most 8000 pixels a side." : "This row is too large to save.";
    case "bad_query": return "That search, sort or filter is not available here.";
    case "unsupported_type": return what + " is not a supported file type.";
    default: return "Something went wrong. Check the connection and try again.";
  }
}

/** Minor units as the amount a person types: 1999 → "19.99" for usd. */
export function money(minor: number, digits: number): string {
  if (digits === 0) return String(minor);
  const s = String(minor).padStart(digits + 1, "0");
  return s.slice(0, -digits) + "." + s.slice(-digits);
}

const two = (n: number) => String(n).padStart(2, "0");

/** Epoch ms as a datetime-local input's value, in the browser's time zone. */
function localDateTime(ms: number): string {
  const d = new Date(ms);
  return String(d.getFullYear()).padStart(4, "0") + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate())
    + "T" + two(d.getHours()) + ":" + two(d.getMinutes());
}

/** A stored value as its input shows it. */
export function toInput(f: FieldInfo, v: unknown): string | boolean {
  if (f.type === "flag") return v === true;
  if (v === null || v === undefined) return "";
  if (f.type === "money") return money(Number(v), f.digits ?? 0);
  if (f.type === "datetime") return localDateTime(Number(v));
  return String(v);
}

export type Parsed = { readonly ok: true; readonly value: string | number | boolean | null } | { readonly ok: false; readonly code: DataErrorCode };
const invalid: Parsed = { ok: false, code: "invalid" };

/**
 * An input as the API value, with the server's first checks and its codes —
 * so a mistake shows the same sentence wherever it is caught. Empty is null;
 * whether null may be sent is the caller's (it knows create from edit).
 */
export function fromInput(f: FieldInfo, raw: string | boolean): Parsed {
  if (f.type === "flag") return { ok: true, value: raw === true };
  const text = String(raw).trim();
  if (text === "") return { ok: true, value: null };
  switch (f.type) {
    case "number":
      return /^-?\\d{1,16}$/.test(text) && Number.isSafeInteger(Number(text)) ? { ok: true, value: Number(text) } : invalid;
    case "money": {
      const digits = f.digits ?? 0;
      const m = /^(\\d{1,16})(?:\\.(\\d+))?$/.exec(text);
      if (!m || (m[2] ?? "").length > digits) return invalid;
      const minor = Number(m[1] + (m[2] ?? "").padEnd(digits, "0"));
      return Number.isSafeInteger(minor) ? { ok: true, value: minor } : invalid;
    }
    case "datetime": {
      const ms = new Date(text).getTime();
      return Number.isSafeInteger(ms) && ms >= 0 ? { ok: true, value: ms } : invalid;
    }
    case "ref":
      return UUID.test(text.toLowerCase()) ? { ok: true, value: text.toLowerCase() } : invalid;
    case "longtext": {
      const value = String(raw);
      return f.max !== undefined && [...value].length > f.max ? { ok: false, code: "too_long" } : { ok: true, value };
    }
    default:
      return f.max !== undefined && [...text].length > f.max ? { ok: false, code: "too_long" } : { ok: true, value: text };
  }
}

/** A value as a table cell shows it. */
export function cellText(f: FieldInfo, v: unknown): string {
  if (f.type === "flag") return v === true ? "Yes" : "No";
  if (v === null || v === undefined || v === "") return "—";
  if (f.type === "money") return money(Number(v), f.digits ?? 0) + " " + (f.currency ?? "").toUpperCase();
  if (f.type === "datetime") return new Date(Number(v)).toLocaleString();
  return String(v);
}

/** How a row is named to a person: its first text value, else its id. */
export function rowName(t: TableInfo, row: AdminRow): string {
  for (const f of t.fields) {
    const v = row[f.name];
    if ((f.type === "text" || f.type === "email") && typeof v === "string" && v.trim() !== "") return v;
  }
  return row.id;
}

/** The columns a row list shows: the short fields, at most five. */
export const columnsOf = (t: TableInfo) => t.fields.filter((f) => f.type !== "longtext" && f.type !== "image").slice(0, 5);

/** An image field's value as the API returns it, or null. */
export function imageOf(v: unknown): { url: string; width: number; height: number } | null {
  if (!v || typeof v !== "object") return null;
  const { url, width, height } = v as Record<string, unknown>;
  return typeof url === "string" && typeof width === "number" && typeof height === "number" ? { url, width, height } : null;
}

export const hrefOf = (table: string, row?: string) => "/admin/" + table + (row ? "?row=" + encodeURIComponent(row) : "");
`;
}

/**
 * The chat's usage on /admin (chat-block-spec §11.4), on a site with chat:
 * today against the daily budget, the last 30 days' counts, the shares kept.
 * The server answers it to admins only; it never holds a message.
 */
const CHAT_USAGE_VIEW = `/**
 * Every count on the chat's usage view, grouped one fixed way: a site has no
 * declared locale (the page is lang="en"; pricing's locale is one block's),
 * so the browser's own would show 281,362 as 2,81,362 in one engine and
 * 281 362 in another. "en-US" is what az backend usage prints too.
 */
const COUNTS = new Intl.NumberFormat("en-US");

/** The chat's daily counts (chat-block-spec §11.4): counts only — no message is kept to be shown. */
function ChatUsageView() {
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | DataErrorCode>("loading");
  useEffect(() => {
    let alive = true;
    void admin.chatUsage().then((r) => {
      if (!alive) return;
      if (r.ok) { setUsage(r.usage); setState("ready"); } else setState(r.code);
    });
    return () => { alive = false; };
  }, []);
  const n = (v: number) => COUNTS.format(v);
  return (
    <section aria-labelledby="az-admin-chat">
      <h2 id="az-admin-chat">Chat usage</h2>
      {state !== "ready" && state !== "loading" ? <p role="alert">{problemText(state)}</p> : null}
      <p role="status" className="az-admin-status">{state === "loading" ? "Loading the chat's counts…" : ""}</p>
      {usage ? (
        <>
          <p>{"Today (" + usage.today + ", UTC): " + n(usage.budget.spent) + " of " + n(usage.budget.daily) + " tokens spent, " + n(usage.budget.left) + " left."}</p>
          <p>{(usage.shares.kept === 1 ? "1 shared answer" : n(usage.shares.kept) + " shared answers") + " kept" + (usage.shares.enabled ? "." : "; new shares are off (AZ_CHAT_SHARES=off).")}</p>
          {usage.days.length === 0 ? <p>Nothing counted in the last 30 days.</p> : (
            <div className="az-admin-scroll" role="region" aria-labelledby="az-admin-chat-days" tabIndex={0}>
              <table className="az-admin-table">
                <caption id="az-admin-chat-days">The last 30 days, newest first (UTC)</caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th><th scope="col">Messages</th><th scope="col">Input tokens</th>
                    <th scope="col">Cached input tokens</th><th scope="col">Output tokens</th><th scope="col">Dropped components</th><th scope="col">Blocked by moderation</th>
                    <th scope="col">Answered without the model</th><th scope="col">Shares made</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.days.map((d) => (
                    <tr key={d.day}>
                      <th scope="row">{d.day}</th><td>{n(d.messages)}</td><td>{n(d.input)}</td>
                      <td>{n(d.cached)}</td><td>{n(d.output)}</td><td>{n(d.dropped)}</td><td>{n(d.blocked)}</td><td>{n(d.site)}</td><td>{n(d.shares)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      <ChatShareDelete />
    </section>
  );
}

/** A share id's shape (the server's): 16 random bytes, base64url. */
const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * The share id in what an admin pasted: the id, a share link
 * (/chat/shared#<id>) or its delete link (#<id>&<token>) — the token is never
 * sent. Null when it holds none.
 */
function shareIdOf(text: string): string | null {
  const hash = text.indexOf("#");
  const id = (hash >= 0 ? text.slice(hash + 1) : text).split("&")[0].trim();
  return SHARE_ID.test(id) ? id : null;
}

/**
 * Delete one shared answer someone reported (chat-block-spec §20.7): its
 * link or id, then a confirm that names it. The server audits it by id; the
 * answer itself is never read here.
 */
function ChatShareDelete() {
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [said, say] = useAnnounce();
  const [problem, setProblem] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);
  const remove = (id: string) => {
    void admin.removeChatShare(id).then((r) => {
      setConfirming(null);
      inputRef.current?.focus();
      if (r.ok) { setTyped(""); setProblem(""); say("Shared answer " + id + " is deleted."); return; }
      setProblem(r.code === "not_found" ? "No shared answer has that id — it may already be gone (deleted or expired)." : problemText(r.code));
    });
  };
  return (
    <form className="az-admin-tools" aria-labelledby="az-admin-share-delete"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const id = shareIdOf(typed);
        if (id === null) { setProblem("That is not a shared answer's link or id."); return; }
        setProblem("");
        setConfirming(id);
      }}>
      <h3 id="az-admin-share-delete">Delete a shared answer</h3>
      <div className="az-admin-field" data-invalid={problem ? "" : undefined}>
        <label htmlFor="az-admin-share">Its link or id</label>
        <input id="az-admin-share" ref={inputRef} value={typed} maxLength={2048} aria-describedby="az-admin-share-hint az-admin-share-error"
          aria-invalid={problem ? true : undefined} onChange={(e) => { setTyped(e.target.value); setConfirming(null); }} />
        <p id="az-admin-share-hint" className="az-admin-hint">The link a visitor reported, or the id after its #.</p>
      </div>
      <p id="az-admin-share-error" role="alert" className="az-admin-error">{problem}</p>
      {confirming ? (
        <div className="az-admin-actions">
          <p>{"Delete shared answer " + confirming + "? Its link stops working for everyone."}</p>
          <button type="button" ref={confirmRef} className="az-admin-button az-admin-button--danger" onClick={() => remove(confirming)}>Delete it</button>
          <button type="button" className="az-admin-button" onClick={() => { setConfirming(null); inputRef.current?.focus(); }}>Cancel</button>
        </div>
      ) : <button type="submit" className="az-admin-button">Delete…</button>}
      <p role="status" className="az-admin-status">{said}</p>
    </form>
  );
}

`;
/** src/data/admin.tsx: the pages, the same for every site (the tables are in admin-values.ts); `chat` adds the chat's usage to /admin. */
export function adminTsx(chat = false): string {
  return `${generated('the /admin pages: tables, rows, editor, delete confirm, audit (data-spec §11)')}/*
 * data-spec §11 — the admin pages are UX, not security.
 *
 * Anyone can load this file. Every request it makes goes to /admin/... on the
 * backend, which answers only a VERIFIED account whose address is listed in
 * the server's AZ_ADMIN_EMAILS — on every request, whatever this page shows.
 * <Protected> around it only spares a signed-out visitor an empty page.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { admin, type AdminRow, type AuditEntry, ${chat ? 'type ChatUsage, ' : ''}type DataErrorCode, type TableName } from "./client.ts";
import {
  cellText, columnsOf, fromInput, hrefOf, imageOf, label, money, PAGE_SIZE, problemText, rowName, TABLES, toInput, UUID,
  type FieldInfo, type TableInfo,
} from "./admin-values.ts";

/** How long a live region stays empty before its message, so a repeat is heard again. */
const ANNOUNCE_GAP_MS = 100;

/**
 * A live region's text: every message is set after the region is cleared and
 * a pause, so a screen reader announces the same sentence twice in a row
 * ("Saved …" after another save). The region itself is always in the page.
 */
function useAnnounce(): [string, (text: string) => void] {
  const [text, setText] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const announce = (next: string) => {
    window.clearTimeout(timer.current);
    setText("");
    if (next) timer.current = window.setTimeout(() => setText(next), ANNOUNCE_GAP_MS);
  };
  return [text, announce];
}

/** An editor field's id: its own namespace, so no table or field name meets the filter form's ids. */
const fieldId = (table: string, field: string) => "az-admin-edit-" + table + "-" + field;

/** Focus fell to the page: the element that had it is gone. */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

/** The admin area: the route decides which page. */
export function Admin({ route }: { route: string }) {
  const name = route.startsWith("/admin/") ? route.slice("/admin/".length) : null;
  const table = TABLES.find((t) => t.name === name) ?? null;
  return (
    <div className="az-admin">
      <nav className="az-admin-nav" aria-label="Admin">
        <a href="/admin" aria-current={table ? undefined : "page"}>All tables</a>
        {TABLES.map((t) => (
          <a key={t.name} href={hrefOf(t.name)} aria-current={table?.name === t.name ? "page" : undefined}>{t.name}</a>
        ))}
        <a href="/">View the site</a>
      </nav>
      {table ? <TablePage table={table} /> : <Home />}
    </div>
  );
}

/** A refusal that ends the page: not an admin, signed out, or the server unreachable. */
function Refused({ code }: { code: DataErrorCode }) {
  return (
    <div className="az-admin-note" role="alert">
      <p>{problemText(code)}</p>
      {code === "forbidden"
        ? <p>Admins are the verified accounts whose addresses the server lists in AZ_ADMIN_EMAILS.</p>
        : null}
    </div>
  );
}

/** /admin: every table with its row count, and the audit log. */
function Home() {
  const [tables, setTables] = useState<{ name: TableName; count: number }[] | null>(null);
  const [refused, setRefused] = useState<DataErrorCode | null>(null);
  useEffect(() => {
    let alive = true;
    void admin.tables().then((r) => {
      if (!alive) return;
      if (r.ok) setTables(r.tables); else setRefused(r.code);
    });
    return () => { alive = false; };
  }, []);
  return (
    <>
      <h1>Admin</h1>
      {refused ? <Refused code={refused} /> : !tables ? <p role="status">Loading the tables…</p> : (
        <>
          <section aria-labelledby="az-admin-tables">
            <h2 id="az-admin-tables">Tables</h2>
            <ul className="az-admin-list">
              {tables.map((t) => (
                <li key={t.name}>
                  <a href={hrefOf(t.name)}>{t.name}</a>
                  <span>{t.count === 1 ? "1 row" : t.count + " rows"}</span>
                </li>
              ))}
            </ul>
          </section>${chat ? '\n          <ChatUsageView />' : ''}
          <Audit />
        </>
      )}
    </>
  );
}

${chat ? CHAT_USAGE_VIEW : ''}const ACTION_TEXT: Record<AuditEntry["action"], string> = { create: "created", edit: "edited", delete: "deleted" };${chat ? `
/** The audit log's name for a shared chat answer an admin deleted (the server's CHAT_SHARES_AUDIT): never a table's name. */
const CHAT_SHARES = "chat_shares";` : ''}

/** The audit log, newest first: who changed which row, when — never a value. */
function Audit() {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | DataErrorCode>("loading");
  const load = (after: string | null) => {
    setState("loading");
    void admin.audit(after ? { limit: PAGE_SIZE, after } : { limit: PAGE_SIZE }).then((r) => {
      if (!r.ok) { setState(r.code); return; }
      setItems((was) => (after ? [...was, ...r.items] : r.items));
      setNext(r.next);
      setState("ready");
    });
  };
  const heading = useRef<HTMLHeadingElement>(null);
  /** An older page was asked for: its button may go once the oldest is in. */
  const paged = useRef(false);
  useEffect(() => { load(null); }, []);
  // The oldest page is in: "Show older changes" is gone, and its focus goes to the heading, not the page.
  useEffect(() => { if (paged.current && next === null && focusLost()) heading.current?.focus(); }, [next]);
  return (
    <section aria-labelledby="az-admin-audit">
      <h2 id="az-admin-audit" ref={heading} tabIndex={-1}>Recent admin changes</h2>
      {state !== "ready" && state !== "loading" ? <p role="alert">{problemText(state)}</p> : null}
      {state === "ready" && items.length === 0 ? <p>No admin has changed a row yet.</p> : null}
      {items.length > 0 ? (
        <ul className="az-admin-list">
          {items.map((e) => (
            <li key={e.id}>
              <span>{new Date(e.at).toLocaleString()}</span>
${chat ? `              <span>{(e.admin ?? "A removed account") + " " + ACTION_TEXT[e.action] + (e.table === CHAT_SHARES ? " shared chat answer " + e.row : " a row in " + e.table)}</span>
              {e.action === "delete" || e.table === CHAT_SHARES ? null : <a href={hrefOf(e.table, e.row)}>Open the row</a>}` : `              <span>{(e.admin ?? "A removed account") + " " + ACTION_TEXT[e.action] + " a row in " + e.table}</span>
              {e.action === "delete" ? null : <a href={hrefOf(e.table, e.row)}>Open the row</a>}`}
            </li>
          ))}
        </ul>
      ) : null}
      <p role="status" className="az-admin-status">{state === "loading" ? "Loading the changes…" : ""}</p>
      {next ? (
        <button type="button" className="az-admin-button" aria-disabled={state === "loading" || undefined}
          onClick={() => { if (state !== "loading") { paged.current = true; load(next); } }}>Show older changes</button>
      ) : null}
    </section>
  );
}

/** "1 row", "20 rows"; "1 row matches" when narrowed. */
function countText(n: number, narrowed: boolean): string {
  const rows = n === 1 ? "1 row" : n + " rows";
  return narrowed ? rows + (n === 1 ? " matches" : " match") : rows;
}

/** A sort key as the options list says it. */
function sortOptions(t: TableInfo): [string, string][] {
  const out: [string, string][] = [["-created", "Newest first"], ["created", "Oldest first"], ["-updated", "Recently changed"]];
  for (const key of t.sorts.filter((k) => k !== "created" && k !== "updated")) {
    out.push([key, label(key) + ", ascending"], ["-" + key, label(key) + ", descending"]);
  }
  return out;
}

/** The fields a list may be narrowed by (data-spec §11: choice, flag, ref). */
const filtersOf = (t: TableInfo) => t.fields.filter((f) => f.type === "choice" || f.type === "flag" || f.type === "ref");

/** /admin/<table>: rows, the editor and the delete confirm. */
function TablePage({ table }: { table: TableInfo }) {
  const [sort, setSort] = useState("-created");
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  /** Ref filters as typed; applied with the form, once each is a row id. */
  const [refIds, setRefIds] = useState<Record<string, string>>({});
  /** The \`after\` cursor of each page so far: the last is the page shown. */
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState<{ items: AdminRow[]; next: string | null; count: number } | null>(null);
  const [refused, setRefused] = useState<DataErrorCode | null>(null);
  /** A list that could not load: said where the rows are, with Try again — the editor and its values stay. */
  const [listError, setListError] = useState<DataErrorCode | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [message, announce] = useAnnounce();
  const [editing, setEditing] = useState<AdminRow | "new" | null>(null);
  const [doomed, setDoomed] = useState<AdminRow | null>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const settle = useRef(false);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const loaded = useRef(false);
  /** The row whose editor just closed ("" for a new row): focus returns to its Edit button. */
  const returnTo = useRef<string | null>(null);
  /** A reload may take away the element focus is on: once it renders, focus that fell to the page goes to the count. */
  const refocus = useRef(false);

  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let alive = true;
    const query: Record<string, string | number> = { limit: PAGE_SIZE, sort };
    if (search) query.q = search;
    for (const [k, v] of Object.entries(filters)) if (v !== "") query[k] = v;
    if (cursor) query.after = cursor;
    void admin.list(table.name, query).then((r) => {
      if (!alive) return;
      setRetrying(false);
      if (r.ok) {
        loaded.current = true;
        setPage({ items: r.items, next: r.next, count: r.count });
        setListError(null);
      } else if (r.code === "bad_query") {
        announce(problemText(r.code));
      } else if (!loaded.current && (r.code === "forbidden" || r.code === "signin_required")) {
        // Not an admin (or no longer signed in) before anything loaded: the page ends, nothing is lost.
        setRefused(r.code);
      } else {
        setListError(r.code);
      }
      // After a delete the row's button is gone: focus lands on the count, not
      // <body>. While the confirm is still closing, it would hand focus back
      // to that gone button afterwards — so the count waits for its close.
      if (settle.current) {
        settle.current = false;
        const dialog = confirmRef.current;
        if (dialog?.open) dialog.addEventListener("close", () => countRef.current?.focus(), { once: true });
        else countRef.current?.focus();
      }
    });
    return () => { alive = false; };
  }, [table.name, sort, search, filters, cursor, tick]);

  // The editor closed: focus goes back to the row's Edit button, or to the
  // count when there is none (a new row) — never to the page.
  useEffect(() => {
    const id = returnTo.current;
    if (editing !== null || id === null) return;
    returnTo.current = null;
    const back = id ? document.querySelector<HTMLElement>("[data-az-admin-edit=\\"" + id + "\\"]") : null;
    (back ?? countRef.current)?.focus();
  }, [editing]);

  // A reload that took away the focused element (a saved row that left the
  // page, a Try again that worked) hands focus to the count.
  useEffect(() => {
    if (!refocus.current || retrying) return;
    refocus.current = false;
    if (focusLost()) countRef.current?.focus();
  }, [page, listError, retrying]);

  // A followed ref (?row=<id>) opens that row's editor.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("row");
    if (!id) return;
    if (!UUID.test(id)) { announce(problemText("not_found")); return; }
    void admin.get(table.name, id).then((r) => {
      if (r.ok) setEditing(r.item); else announce(problemText(r.code));
    });
  }, [table.name]);

  const restart = () => setCursors([null]);

  const closeEditor = (id: string) => {
    returnTo.current = id;
    setEditing(null);
  };

  const retry = () => {
    refocus.current = true;
    setRetrying(true);
    setTick((n) => n + 1);
  };

  const remove = async () => {
    const row = doomed;
    if (!row) return;
    const r = await admin.remove(table.name, row.id);
    if (r.ok) {
      announce("Deleted “" + rowName(table, row) + "”.");
      if (editing !== null && editing !== "new" && editing.id === row.id) setEditing(null);
      settle.current = true;
      setTick((n) => n + 1);
    } else {
      announce(problemText(r.code));
    }
  };

  if (refused) return <><h1>{table.name}</h1><Refused code={refused} /></>;
  const columns = columnsOf(table);
  return (
    <>
      <h1>{table.name}</h1>
      {table.anyoneCreates ? (
        <p className="az-admin-note">Anyone can add rows to this table, signed in or not. Review new rows and delete spam.</p>
      ) : null}
      {table.adminOnly ? <p className="az-admin-note">No allow line opens this table to the site: only admins see it.</p> : null}

      <form className="az-admin-tools" role="search" aria-label={"Find rows in " + table.name}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          // A ref filter is a row id: checked here, as the server would, before it is sent.
          const refs = filtersOf(table).filter((f) => f.type === "ref");
          const bad = refs.find((f) => (refIds[f.name] ?? "") !== "" && !UUID.test(refIds[f.name]));
          if (bad) { announce(problemText("invalid", bad.name)); return; }
          announce("");
          setFilters({ ...filters, ...Object.fromEntries(refs.map((f) => [f.name, refIds[f.name] ?? ""])) });
          setSearch(typed.trim());
          restart();
        }}>
        {table.search ? (
          <div className="az-admin-field">
            <label htmlFor="az-admin-q">Search</label>
            <input id="az-admin-q" type="search" value={typed} maxLength={100} onChange={(e) => setTyped(e.target.value)} />
          </div>
        ) : null}
        <div className="az-admin-field">
          <label htmlFor="az-admin-sort">Sort</label>
          <select id="az-admin-sort" value={sort} onChange={(e) => { setSort(e.target.value); restart(); }}>
            {sortOptions(table).map(([v, text]) => <option key={v} value={v}>{text}</option>)}
          </select>
        </div>
        {filtersOf(table).map((f) => (
          <div className="az-admin-field" key={f.name}>
            <label htmlFor={"az-admin-filter-" + f.name}>{label(f.name)}</label>
            {f.type === "ref" ? (
              <input id={"az-admin-filter-" + f.name} value={refIds[f.name] ?? ""} aria-describedby={"az-admin-filter-" + f.name + "-hint"}
                onChange={(e) => setRefIds({ ...refIds, [f.name]: e.target.value.trim().toLowerCase() })} />
            ) : (
              <select id={"az-admin-filter-" + f.name} value={filters[f.name] ?? ""}
                onChange={(e) => { setFilters({ ...filters, [f.name]: e.target.value }); restart(); }}>
                <option value="">Any</option>
                {f.type === "flag"
                  ? [<option key="on" value="on">Yes</option>, <option key="off" value="off">No</option>]
                  : (f.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {f.type === "ref" ? <p id={"az-admin-filter-" + f.name + "-hint"} className="az-admin-hint">{"A row id in " + (f.ref ?? "")}</p> : null}
          </div>
        ))}
        {table.search || filtersOf(table).some((f) => f.type === "ref")
          ? <button type="submit" className="az-admin-button">{table.search ? "Search" : "Apply"}</button>
          : null}
      </form>

      <div className="az-admin-actions">
        <button type="button" className="az-admin-button az-admin-button--primary" data-az-admin-edit="new"
          onClick={() => setEditing("new")}>New row</button>
      </div>
      <p role="status" className="az-admin-status">{message}</p>

      {editing ? (
        <Editor key={editing === "new" ? "new" : editing.id} table={table} row={editing === "new" ? null : editing}
          onCancel={() => closeEditor(editing === "new" ? "new" : editing.id)}
          onImage={() => setTick((n) => n + 1)}
          onSaved={(row, created) => {
            // A new row has no Edit button yet: focus goes to the count.
            closeEditor(created ? "" : row.id);
            refocus.current = true;
            announce((created ? "Created “" : "Saved “") + rowName(table, row) + "”.");
            setTick((n) => n + 1);
          }} />
      ) : null}

      <p ref={countRef} tabIndex={-1} className="az-admin-count">
        {page ? countText(page.count, Boolean(search) || Object.values(filters).some(Boolean)) : "Loading rows…"}
      </p>
      <div className="az-admin-actions">
        <p role="alert" className="az-admin-error">{listError && !retrying ? problemText(listError) : ""}</p>
        {listError ? <button type="button" className="az-admin-button" onClick={retry}>Try again</button> : null}
      </div>
      {page && page.items.length > 0 ? (
        <div className="az-admin-scroll" role="region" aria-label={table.name + " rows"} tabIndex={0}>
          <table className="az-admin-table">
            <thead>
              <tr>
                {columns.map((f) => <th key={f.name} scope="col">{label(f.name)}</th>)}
                <th scope="col">Owner</th>
                <th scope="col">Changed</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((row) => (
                <tr key={row.id}>
                  {columns.map((f) => (
                    <td key={f.name}>
                      {f.type === "ref" && f.ref && typeof row[f.name] === "string"
                        ? <a href={hrefOf(f.ref, row[f.name] as string)}>{cellText(f, row[f.name])}</a>
                        : cellText(f, row[f.name])}
                    </td>
                  ))}
                  <td>{row.ownerEmail ?? "—"}</td>
                  <td>{new Date(row.updated).toLocaleString()}</td>
                  <td>
                    <div className="az-admin-actions">
                      <button type="button" className="az-admin-button" aria-label={"Edit “" + rowName(table, row) + "”"}
                        data-az-admin-edit={row.id} onClick={() => setEditing(row)}>Edit</button>
                      <button type="button" className="az-admin-button" aria-controls="az-admin-confirm"
                        aria-label={"Delete “" + rowName(table, row) + "”"} onClick={() => setDoomed(row)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : page ? <p>No rows.</p> : null}

      <nav className="az-admin-actions" aria-label="Pages">
        {/* aria-disabled, not disabled: the last page turns Next off while it has focus, and a disabled button drops it. */}
        <button type="button" className="az-admin-button" aria-disabled={cursors.length < 2 || undefined}
          onClick={() => { if (cursors.length >= 2) setCursors(cursors.slice(0, -1)); }}>Previous page</button>
        <button type="button" className="az-admin-button" aria-disabled={!page?.next || undefined}
          onClick={() => { if (page?.next) setCursors([...cursors, page.next]); }}>Next page</button>
      </nav>

      {/* The overlay runtime opens this from the Delete buttons (aria-controls):
          a modal, focus inside, Escape and the backdrop close it, focus returns. */}
      <dialog ref={confirmRef} id="az-admin-confirm" className="az-admin-confirm" data-az-overlay="popup" data-az-behaviour="dialog"
        aria-labelledby="az-admin-confirm-title" aria-describedby="az-admin-confirm-text">
        <h2 id="az-admin-confirm-title">Delete this row?</h2>
        <p id="az-admin-confirm-text">
          {doomed ? "“" + rowName(table, doomed) + "” will be deleted from " + table.name + ". This cannot be undone." : ""}
        </p>
        <div className="az-admin-actions">
          <button type="button" className="az-admin-button" data-az-close="">Cancel</button>
          <button type="button" className="az-admin-button az-admin-button--danger" data-az-close="" onClick={() => { void remove(); }}>Delete</button>
        </div>
      </dialog>
    </>
  );
}

/** A field's line under its label: what it is and who sees it. */
function hintOf(f: FieldInfo): string {
  const parts: string[] = [];
  if (f.type === "money") parts.push("In " + (f.currency ?? "").toUpperCase() + (f.digits ? ", like " + money(1999, f.digits) : ""));
  if (f.type === "ref") parts.push("The id of a row in " + (f.ref ?? "") + ".");
  if (f.private) parts.push("Private: only its owner and admins see it.");
  if (f.locked) parts.push("Locked: only admins can change it.");
  return parts.join(" ");
}

/** One field's control, generated from its type. */
function FieldInput({ table, f, value, error, onChange }: {
  table: TableInfo; f: FieldInfo; value: string | boolean; error: string; onChange: (v: string | boolean) => void;
}): ReactNode {
  const id = fieldId(table.name, f.name);
  const hint = hintOf(f);
  const describedBy = [hint ? id + "-hint" : "", error ? id + "-error" : ""].filter(Boolean).join(" ") || undefined;
  const common = {
    id, name: f.name, "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined, "aria-required": f.required ? true : undefined,
  };
  const text = typeof value === "string" ? value : "";
  let control: ReactNode;
  if (f.type === "flag") {
    control = <input {...common} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  } else if (f.type === "choice") {
    control = (
      <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
        {f.required ? null : <option value="">None</option>}
        {f.required && text === "" ? <option value="" disabled>Choose…</option> : null}
        {(f.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  } else if (f.type === "longtext") {
    control = <textarea {...common} rows={6} value={text} onChange={(e) => onChange(e.target.value)} />;
  } else {
    const type = f.type === "email" ? "email" : f.type === "url" ? "url" : f.type === "date" ? "date"
      : f.type === "datetime" ? "datetime-local" : "text";
    const mode = f.type === "number" ? "numeric" : f.type === "money" ? "decimal" : undefined;
    control = <input {...common} type={type} inputMode={mode} value={text} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={f.type === "flag" ? "az-admin-field az-admin-field--check" : "az-admin-field"} data-invalid={error ? "" : undefined}>
      <label htmlFor={id}>{label(f.name)}{f.required ? " (required)" : ""}</label>
      {control}
      {hint ? <p id={id + "-hint"} className="az-admin-hint">{hint}</p> : null}
      {f.type === "ref" && f.ref && UUID.test(text) ? <a href={hrefOf(f.ref, text)}>Open the {f.ref} row</a> : null}
      {error ? <p id={id + "-error"} className="az-admin-error">{error}</p> : null}
    </div>
  );
}

/** The image types the server accepts, by their content (data-spec §8). */
const IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/avif";

/**
 * An image field: its preview, and upload, replace or remove — each saved at
 * once, apart from the form, because an image is uploaded to a row that
 * exists (data-spec §5). A new row's image waits until the row is created.
 */
function ImageField({ table, row, f, onChanged }: {
  table: TableInfo; row: AdminRow | null; f: FieldInfo; onChanged: () => void;
}): ReactNode {
  const id = fieldId(table.name, f.name);
  const [image, setImage] = useState(row ? imageOf(row[f.name]) : null);
  const [status, setStatus] = useAnnounce();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // A refusal moves focus to the file input, after the render that shows it.
  useEffect(() => { if (error) input.current?.focus(); }, [error]);
  // Removed: the Remove button that had focus is gone, so focus goes to the upload control.
  useEffect(() => { if (!image && focusLost()) input.current?.focus(); }, [image]);
  const hint = [hintOf(f), "JPEG, PNG, WebP or AVIF. It is stored as WebP, without its metadata, such as where a photo was taken."]
    .filter(Boolean).join(" ");
  if (!row) {
    return (
      <div className="az-admin-field">
        <p className="az-admin-legend">{label(f.name)}</p>
        <p className="az-admin-hint">Create the row first, then upload its image.</p>
      </div>
    );
  }
  const act = async (run: () => ReturnType<typeof admin.clear>, done: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("Saving…");
    const r = await run();
    setBusy(false);
    if (input.current) input.current.value = "";
    if (r.ok) {
      setImage(imageOf(r.item[f.name]));
      setStatus(done);
      onChanged();
    } else {
      setStatus("");
      setError(problemText(r.code, f.name));
    }
  };
  return (
    <fieldset className="az-admin-field az-admin-image" data-invalid={error ? "" : undefined}>
      <legend className="az-admin-legend">{label(f.name)}</legend>
      {image
        ? <img className="az-admin-preview" src={image.url} width={image.width} height={image.height} alt={"The current " + f.name} />
        : <p className="az-admin-hint">No image yet.</p>}
      <label htmlFor={id}>{image ? "Replace with another file" : "Upload a file"}</label>
      {/* Busy is aria-disabled with a guard, never disabled: a disabled control drops the focus it has. */}
      <input ref={input} id={id} type="file" accept={IMAGE_TYPES} aria-disabled={busy || undefined}
        aria-describedby={id + "-hint" + (error ? " " + id + "-error" : "")} aria-invalid={error ? true : undefined}
        onClick={(e) => { if (busy) e.preventDefault(); }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void act(() => admin.upload(table.name, row.id, f.name, file), label(f.name) + " saved.");
        }} />
      <p id={id + "-hint"} className="az-admin-hint">{hint}</p>
      {image ? (
        <div className="az-admin-actions">
          <button type="button" className="az-admin-button" aria-disabled={busy || undefined}
            onClick={() => { void act(() => admin.clear(table.name, row.id, f.name), label(f.name) + " removed."); }}>
            {"Remove " + f.name}
          </button>
        </div>
      ) : null}
      <p role="status" className="az-admin-status">{status}</p>
      {error ? <p id={id + "-error"} className="az-admin-error">{error}</p> : null}
    </fieldset>
  );
}

/** Create or edit one row: every field, the server's checks and its copy. Images are saved on their own (ImageField). */
function Editor({ table, row, onCancel, onSaved, onImage }: {
  table: TableInfo; row: AdminRow | null; onCancel: () => void; onSaved: (row: AdminRow, created: boolean) => void; onImage: () => void;
}) {
  const fields = table.fields.filter((f) => f.type !== "image");
  const start = () => Object.fromEntries(fields.map((f) => [f.name, toInput(f, row ? row[f.name] : f.default)]));
  const [values, setValues] = useState<Record<string, string | boolean>>(start);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useAnnounce();
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  const showErrors = (found: Record<string, string>) => {
    setErrors(found);
    const first = fields.find((f) => found[f.name]);
    if (first) form.current?.querySelector<HTMLElement>("#" + fieldId(table.name, first.name))?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Busy is aria-disabled with this guard, never disabled: the submit keeps its focus while the save runs.
    if (busy) return;
    const body: Record<string, unknown> = {};
    const found: Record<string, string> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (row && raw === toInput(f, row[f.name])) continue;           // unchanged: not sent
      const p = fromInput(f, raw);
      if (!p.ok) { found[f.name] = problemText(p.code, f.name); continue; }
      if (p.value === null) {
        // Empty: a new row takes the field's default; an edit clears it.
        if (row ? f.required : f.needed) found[f.name] = problemText("required", f.name);
        else if (row) body[f.name] = null;
        continue;
      }
      body[f.name] = p.value;
    }
    setFormError("");
    if (Object.keys(found).length > 0) { showErrors(found); return; }
    setErrors({});
    if (row && Object.keys(body).length === 0) { setFormError("Nothing has changed."); return; }
    setBusy(true);
    const r = row ? await admin.update(table.name, row.id, body) : await admin.create(table.name, body);
    setBusy(false);
    if (r.ok) { onSaved(r.item, !row); return; }
    if (r.field && fields.some((f) => f.name === r.field)) showErrors({ [r.field]: problemText(r.code, r.field) });
    else setFormError(problemText(r.code));
  };

  const title = row ? "Edit “" + rowName(table, row) + "”" : "New row in " + table.name;
  return (
    <form ref={form} className="az-admin-editor" noValidate aria-labelledby="az-admin-editor-title" onSubmit={(e) => { void submit(e); }}>
      <h2 id="az-admin-editor-title" ref={heading} tabIndex={-1}>{title}</h2>
      {row ? <p className="az-admin-hint">{"Owner: " + (row.ownerEmail ?? "nobody") + " · id " + row.id}</p> : null}
      {fields.map((f) => (
        <FieldInput key={f.name} table={table} f={f} value={values[f.name]} error={errors[f.name] ?? ""}
          onChange={(v) => setValues({ ...values, [f.name]: v })} />
      ))}
      {table.fields.filter((f) => f.type === "image").map((f) => (
        <ImageField key={f.name} table={table} row={row} f={f} onChanged={onImage} />
      ))}
      <p role="alert" className="az-admin-error">{formError}</p>
      <div className="az-admin-actions">
        <button type="submit" className="az-admin-button az-admin-button--primary" aria-disabled={busy || undefined} aria-busy={busy || undefined}>
          {row ? "Save changes" : "Create row"}
        </button>
        <button type="button" className="az-admin-button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
`;
}

/** CSS declarations as text. */
const decls = (style: Readonly<Record<string, string | number | undefined>>) =>
  declarations(style as Record<string, string | number>).map(([k, v]) => `${k}: ${v};`).join(' ');

/**
 * The admin pages' styles, from theme tokens (A7), in theme.css because the
 * module renders no emitted node. Buttons match the button primitive's
 * metrics (tap size, radius, ring); the delete confirm is the overlay
 * `popup` preset's own style and open state.
 */
export function adminCss(t: ThemeLike): string {
  const confirm = popup(t, 'Delete this row?');
  const ring = `outline: ${px(t.size.ring)} solid var(--az-color-focus); outline-offset: ${px(t.size['ring-offset'])};`;
  return `
/* Admin (data-spec §11): the generated /admin pages. */
.az-admin { display: grid; gap: ${px(t.space[24])}; padding-block: ${px(t.space[32])}; padding-inline: ${framed(t)}; color: var(--az-color-text); }
@media (max-width: ${t.breakpoint.sm - 1}px) { .az-admin { padding-inline: ${px(t.size['gutter-sm'])}; } }
.az-admin h1 { margin: 0; font-size: ${t.typeSize.xl}; }
.az-admin h2 { margin: 0; font-size: ${t.typeSize.lg}; }
.az-admin p { margin: 0; }
.az-admin section { display: grid; gap: ${px(t.space[16])}; }
.az-admin a { color: var(--az-color-accent); }
.az-admin :is(a, input, select, textarea, [tabindex]):focus-visible { ${ring} }
.az-admin-nav { display: flex; flex-wrap: wrap; gap: ${px(t.space[8])} ${px(t.space[16])}; font-size: ${t.typeSize.sm}; }
.az-admin-nav a { display: inline-flex; align-items: center; min-height: ${px(t.size.tap)}; }
.az-admin-nav a[aria-current="page"] { color: var(--az-color-text); font-weight: ${t.type['weight-bold']}; }
.az-admin-list { list-style: none; display: grid; gap: ${px(t.space[8])}; }
.az-admin-list li { display: flex; flex-wrap: wrap; gap: ${px(t.space[8])} ${px(t.space[16])}; align-items: center; min-height: ${px(t.size.tap)};
  border-bottom: 1px solid var(--az-color-border); }
.az-admin-note { display: grid; gap: ${px(t.space[8])}; padding: ${px(t.space[12])} ${px(t.space[16])}; background: var(--az-color-surface-alt);
  border-inline-start: ${px(t.space[4])} solid var(--az-color-accent); border-radius: ${px(t.radius.sm)}; }
.az-admin-button { display: inline-flex; align-items: center; justify-content: center; gap: ${px(t.space[8])}; min-height: ${px(t.size.tap)};
  min-width: ${px(t.size.tap)}; padding-inline: ${px(t.space[16])}; border-radius: ${px(t.radius.sm)}; font: inherit; font-weight: ${t.type['weight-bold']};
  line-height: ${t.type['leading-tight']}; cursor: pointer; color: var(--az-color-text); background: transparent; border: 1px solid var(--az-color-border-strong); }
.az-admin-button:hover { background: var(--az-color-surface-alt); }
.az-admin-button:focus-visible { ${ring} }
.az-admin-button--primary { color: var(--az-color-accent-contrast); background: var(--az-color-accent); border-color: var(--az-color-accent); }
.az-admin-button--primary:hover { background: var(--az-color-accent-hover); border-color: var(--az-color-accent-hover); }
.az-admin-button--danger { color: var(--az-color-danger-contrast); background: var(--az-color-danger); border-color: var(--az-color-danger); }
.az-admin-button--danger:hover { background: var(--az-color-danger); text-decoration: underline; }
.az-admin-button:is(:disabled, [aria-disabled="true"]) { color: var(--az-color-muted); background: var(--az-color-surface-alt); border-color: var(--az-color-border); cursor: not-allowed; }
.az-admin-actions { display: flex; flex-wrap: wrap; gap: ${px(t.space[8])}; align-items: center; }
.az-admin-tools { display: flex; flex-wrap: wrap; gap: ${px(t.space[16])}; align-items: end; }
.az-admin-field { display: grid; gap: ${px(t.space[4])}; min-width: 0; }
.az-admin-tools .az-admin-field { flex: 1 1 ${px(t.space[128] + t.space[64])}; }
.az-admin-field label { font-weight: ${t.type['weight-bold']}; font-size: ${t.typeSize.sm}; }
.az-admin-field :is(input:not([type="checkbox"]), select, textarea) { width: 100%; min-height: ${px(t.size.tap)}; padding: ${px(t.space[8])} ${px(t.space[12])};
  font: inherit; color: var(--az-color-text); background: var(--az-color-bg); border: 1px solid var(--az-color-border-strong); border-radius: ${px(t.radius.sm)}; }
.az-admin-field[data-invalid] :is(input, select, textarea) { border-color: var(--az-color-danger); }
.az-admin-field--check { grid-template-columns: auto 1fr; align-items: center; column-gap: ${px(t.space[12])}; }
.az-admin-field--check label { grid-column: 2; grid-row: 1; }
.az-admin-field--check input { grid-column: 1; grid-row: 1; width: ${px(t.space[24])}; height: ${px(t.space[24])}; margin: 0; }
.az-admin-field--check > :not(label, input) { grid-column: 1 / -1; }
.az-admin-hint { color: var(--az-color-muted); font-size: ${t.typeSize.sm}; }
.az-admin-error { color: var(--az-color-danger); font-size: ${t.typeSize.sm}; font-weight: ${t.type['weight-bold']}; }
/* An empty live region stays in the page, out of sight and out of the layout: a region that appears with its message may not be heard. */
.az-admin-error:empty, .az-admin-status:empty { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0; }
.az-admin-editor { display: grid; gap: ${px(t.space[16])}; max-width: ${t.size['measure-body']}ch; padding: ${px(t.space[24])};
  background: var(--az-color-surface); border: 1px solid var(--az-color-border); border-radius: ${px(t.radius.md)}; }
.az-admin-count { font-size: ${t.typeSize.sm}; color: var(--az-color-muted); }
.az-admin-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--az-color-border); border-radius: ${px(t.radius.sm)}; }
.az-admin-scroll:focus-visible { ${ring} }
.az-admin-table { width: 100%; border-collapse: collapse; font-size: ${t.typeSize.sm}; }
.az-admin-table :is(th, td) { padding: ${px(t.space[8])} ${px(t.space[12])}; text-align: start; vertical-align: top;
  border-bottom: 1px solid var(--az-color-border); max-width: ${t.size['measure-display']}ch; overflow-wrap: anywhere; }
.az-admin-table th { background: var(--az-color-surface-alt); white-space: nowrap; }
.az-admin-image { margin: 0; padding: 0; border: 0; gap: ${px(t.space[8])}; }
.az-admin-legend { padding: 0; font-weight: ${t.type['weight-bold']}; font-size: ${t.typeSize.sm}; }
.az-admin-image label { font-weight: normal; }
.az-admin-preview { display: block; max-width: 100%; height: auto; max-height: ${px(t.space[128] * 2)}; object-fit: contain;
  background: var(--az-color-surface-alt); border: 1px solid var(--az-color-border); border-radius: ${px(t.radius.sm)}; }
.az-admin-image input[type="file"] { min-height: ${px(t.size.tap)}; font: inherit; max-width: 100%; }
.az-admin-image input[type="file"][aria-disabled="true"] { color: var(--az-color-muted); cursor: not-allowed; }
.az-admin-confirm { ${decls(confirm.style)} }
.az-admin-confirm[data-state="open"] { ${decls(confirm.states.open)} }
.az-admin-confirm > * + * { margin-top: ${px(t.space[16])}; }
.az-admin-confirm h2 { margin-block: 0; font-size: ${t.typeSize.lg}; }
`;
}
