/**
 * The generated admin pages (data-spec §11): emitted only with tables, kept
 * out of search results, routed inside <Protected>, styled from tokens; and
 * the value rules of src/data/admin-values.ts — loaded as the browser runs
 * them — agree with the server's own checks (data-values.ts), so a mistake
 * gets the same code, and so the same sentence, wherever it is caught.
 * The pages in real browsers are scripts/data-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { dataClient } from '../src/data-client.ts';
import { adminCss, adminTsx, adminValuesTs } from '../src/data-admin.ts';
import { checkValue, loadTables } from '../../backend/src/server/data-values.ts';
import type { ThemeLike } from '../../core/src/emit-contract.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}
const HEAD = 'az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n';
const SITE = (data: string) => `${HEAD}${data}page /\n  hero center\n    title "Hi"\npage /login\n  auth login\n`;
const DATA = `  data products
    name text required search
    blurb longtext
    price money usd required
    yen money jpy
    status choice draft live default draft
    featured flag
    contact email private
    link url
    due date
    at datetime
    count number
    stock number locked default 0
    allow anyone read
    allow signedin create
    allow owner edit delete
  data reviews
    product ref products required
    allow anyone create
  data notes
    body text required
`;
const specOf = (data: string) => {
  const r = compile(SITE(data), { manifests });
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  return r.spec!;
};
const files = (data: string) => new Map(emitProject(specOf(data), { emitters: {} }).files.map((f) => [f.path, f.content]));

test('a site with tables gets /admin and /admin/<table>: noindex, inside <Protected>, styled', () => {
  const out = files(DATA);
  for (const route of ['admin', 'admin/products', 'admin/reviews', 'admin/notes']) {
    const html = out.get(`${route}/index.html`);
    assert.ok(html, route);
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
    assert.match(html, /<title>Admin · shop<\/title>/);
  }
  assert.ok(!/noindex/.test(out.get('index.html')!), 'CONTROL: the site\'s own pages are indexed');
  const app = out.get('src/App.tsx')!;
  assert.match(app, /import \{ Admin \} from "\.\/data\/admin\.tsx";/);
  assert.match(app, /const ADMIN = new Set<string>\(\[\n {2}"\/admin",\n {2}"\/admin\/products",\n {2}"\/admin\/reviews",\n {2}"\/admin\/notes"\n\]\);/);
  assert.match(app, /<Protected lead=\{null\}><Admin route=\{routeOf\(route\)\} \/><\/Protected>/);
  assert.match(out.get('vite.config.ts')!, /"admin\/products": "admin\/products\/index\.html"/, 'each admin page is a built entry');
  assert.match(out.get('src/theme.css')!, /\.az-admin-confirm\[data-state="open"\] \{ opacity: 1; transform: none;/, 'the confirm is the popup preset');
  assert.ok(out.has('src/data/admin.tsx') && out.has('src/data/admin-values.ts'));
  assert.match(out.get('src/data/admin.tsx')!, /the admin pages are UX, not security/);
  assert.match(out.get('src/data/client.ts')!, /export const admin = \{/);
  const md = out.get('AZ.md')!;
  assert.match(md, /## Admin/);
  assert.match(md, /AZ_ADMIN_EMAILS/);
  assert.match(md, /`\/admin\/products`, `\/admin\/reviews`, `\/admin\/notes`/);
});

test('a site with tables and a chat: /admin shows the chat\'s usage (chat-block-spec §11.4) — the route, its types, a table with a caption; CONTROL without chat, none', () => {
  const chat = SITE(DATA).replace('    email smtp\n', '    email smtp\n    model default\n').replace('    title "Hi"\n', '    title "Hi"\n  chat panel\n    allow anyone\n');
  const r = compile(chat, { manifests });
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  const withChat = new Map(emitProject(r.spec!, { emitters: {} }).files.map((f) => [f.path, f.content]));
  const tsx = withChat.get('src/data/admin.tsx')!;
  const client = withChat.get('src/data/client.ts')!;
  assert.match(client, /chatUsage: \(\) => call<\{ usage: ChatUsage \}>\("GET", "\/admin\/chat"\),/);
  assert.match(client, /export interface ChatUsage \{/);
  assert.match(tsx, /import \{ admin, type AdminRow, type AuditEntry, type ChatUsage, type DataErrorCode, type TableName \} from "\.\/client\.ts";/);
  assert.match(tsx, /<\/section>\n {10}<ChatUsageView \/>\n {10}<Audit \/>/);
  assert.match(tsx, /<caption id="az-admin-chat-days">The last 30 days, newest first \(UTC\)<\/caption>/);
  assert.match(tsx, /<th scope="col">Messages<\/th>/);
  assert.match(tsx, /<th scope="col">Blocked by moderation<\/th>/);
  assert.match(tsx, /<td>\{n\(d\.blocked\)\}<\/td>/);
  // §19.16: the input the provider read from its prompt cache, beside the input.
  assert.match(tsx, /<th scope="col">Cached input tokens<\/th>[\s\S]*<td>\{n\(d\.input\)\}<\/td>\s*<td>\{n\(d\.cached\)\}<\/td>/);
  // §19.17: the answers the server gave from the site's own presets and quotes, the model not asked.
  assert.match(tsx, /<th scope="col">Answered without the model<\/th><th scope="col">Shares made<\/th>[\s\S]*<td>\{n\(d\.site\)\}<\/td><td>\{n\(d\.shares\)\}<\/td>/);
  // One fixed grouping in every engine and every visitor's locale (chat-block-spec §19.11): never the browser's own.
  assert.match(tsx, /const COUNTS = new Intl\.NumberFormat\("en-US"\);/);
  assert.match(tsx, /const n = \(v: number\) => COUNTS\.format\(v\);/);
  assert.doesNotMatch(tsx, /toLocaleString\(\)\s*;?\s*\n\s*return \(\n\s*<section aria-labelledby="az-admin-chat">/);
  assert.doesNotMatch(tsx.slice(tsx.indexOf('function ChatUsageView'), tsx.indexOf('const ACTION_TEXT')), /toLocaleString/);
  // The admin's share delete (chat-block-spec §20.7): the route, a labelled field, a confirm that names the share.
  assert.match(client, /removeChatShare: \(id: string\) => call<Record<string, never>>\("DELETE", "\/admin\/chat\/shares\/" \+ encodeURIComponent\(id\)\),/);
  assert.match(tsx, /<label htmlFor="az-admin-share">Its link or id<\/label>/);
  assert.match(tsx, /"Delete shared answer " \+ confirming \+ "\? Its link stops working for everyone\."/);
  assert.match(tsx, /e\.table === CHAT_SHARES \? " shared chat answer " \+ e\.row/);
  // Counts only: nothing in the view could hold a message.
  assert.doesNotMatch(tsx, /question|events|\.text\b/);
  // CONTROL: a site with tables and no chat gets exactly what it got before.
  const plain = files(DATA);
  assert.equal(plain.get('src/data/admin.tsx'), adminTsx());
  assert.equal(adminTsx(), adminTsx(false));
  assert.doesNotMatch(plain.get('src/data/admin.tsx')!, /ChatUsage|\/admin\/chat/);
  assert.doesNotMatch(plain.get('src/data/client.ts')!, /ChatUsage|\/admin\/chat/);
});

test('CONTROL: a site without tables has no admin page, module, route or style', () => {
  const out = files('');
  assert.ok(![...out.keys()].some((p) => p.startsWith('admin/') || p.startsWith('src/data/')));
  assert.ok(!/Admin|ADMIN/.test(out.get('src/App.tsx')!));
  assert.ok(!/az-admin/.test(out.get('src/theme.css')!));
  assert.ok(!/## Admin/.test(out.get('AZ.md')!));
});

test('deterministic: the same tables give the same admin files', () => {
  const a = files(DATA);
  const b = files(DATA);
  for (const p of ['src/data/admin.tsx', 'src/data/admin-values.ts', 'src/App.tsx', 'src/theme.css']) assert.equal(a.get(p), b.get(p), p);
});

/** admin-values.ts and its client, loaded as modules from a temporary folder. */
async function loadValues() {
  const dir = mkdtempSync(join(tmpdir(), 'az-admin-'));
  const data = specOf(DATA).site.data!;
  writeFileSync(join(dir, 'client.ts'), dataClient(data).replace(/import\.meta\.env\.AZ_PUBLIC_BACKEND_URL/, '"https://api.studio.test"'));
  writeFileSync(join(dir, 'admin-values.ts'), adminValuesTs(data));
  type Field = { name: string; type: string; required: boolean; needed: boolean; private: boolean; locked: boolean; digits?: number; max?: number; ref?: string; sorts?: string[] };
  type Parsed = { ok: true; value: unknown } | { ok: false; code: string };
  return await import(pathToFileURL(join(dir, 'admin-values.ts')).href) as {
    TABLES: { name: string; fields: Field[]; sorts: string[]; search: boolean; anyoneCreates: boolean; adminOnly: boolean }[];
    fromInput(f: Field, raw: string | boolean): Parsed;
    toInput(f: Field, v: unknown): string | boolean;
    problemText(code: string, field?: string): string;
    money(minor: number, digits: number): string;
  };
}

test('the tables as data: flags, limits, currency digits, sort keys, moderation', async () => {
  const v = await loadValues();
  const [products, reviews, notes] = v.TABLES;
  const field = (n: string) => products.fields.find((f) => f.name === n)!;
  assert.deepEqual([field('price').digits, field('yen').digits, field('name').max, field('blurb').max], [2, 0, 200, 10000]);
  assert.deepEqual([field('stock').locked, field('contact').private, field('status').needed, field('name').needed], [true, true, false, true]);
  assert.deepEqual(products.sorts, ['created', 'updated', 'name', 'price'], 'required sortable fields only, as the server keysets');
  assert.deepEqual([products.anyoneCreates, reviews.anyoneCreates, notes.adminOnly, products.adminOnly], [false, true, true, false]);
  assert.equal(reviews.fields[0].ref, 'products');
});

test('inputs become the values the server accepts, refused with the server\'s own code', async () => {
  const v = await loadValues();
  const spec = specOf(DATA).site.data!;
  const server = loadTables(JSON.parse(JSON.stringify({ tables: spec })));
  const sField = (t: string, n: string) => server.find((x) => x.name === t)!.fields.find((f) => f.name === n)!;
  const cField = (t: string, n: string) => v.TABLES.find((x) => x.name === t)!.fields.find((f) => f.name === n)!;
  const cases: [string, string, string | boolean, unknown | string][] = [
    ['products', 'price', '19.99', 1999],
    ['products', 'price', '19.9', 1990],
    ['products', 'price', '19', 1900],
    ['products', 'price', '19.999', 'invalid'],
    ['products', 'price', '-1', 'invalid'],
    ['products', 'price', '1e3', 'invalid'],
    ['products', 'yen', '500', 500],
    ['products', 'yen', '5.5', 'invalid'],
    ['products', 'count', '-12', -12],
    ['products', 'count', '1.5', 'invalid'],
    ['products', 'count', '9007199254740993', 'invalid'],
    ['products', 'name', '  Chair  ', 'Chair'],
    ['products', 'name', 'a'.repeat(200), 'a'.repeat(200)],
    ['products', 'name', 'a'.repeat(201), 'too_long'],
    ['products', 'name', '😀'.repeat(200), '😀'.repeat(200)],
    ['products', 'blurb', 'Two\nlines', 'Two\nlines'],
    ['products', 'featured', true, true],
    ['products', 'featured', false, false],
    ['products', 'due', '2024-02-29', '2024-02-29'],
    ['products', 'contact', 'ana@studio.test', 'ana@studio.test'],
    ['products', 'link', 'https://studio.test/a', 'https://studio.test/a'],
    ['reviews', 'product', '0F8B3F4E-0000-4000-8000-00000000000A', '0f8b3f4e-0000-4000-8000-00000000000a'],
    ['reviews', 'product', 'not-an-id', 'invalid'],
  ];
  for (const [t, n, raw, want] of cases) {
    const got = v.fromInput(cField(t, n), raw);
    const label = `${t}.${n} ${JSON.stringify(raw).slice(0, 30)}`;
    if (typeof want === 'string' && ['invalid', 'too_long', 'required'].includes(want)) {
      assert.deepEqual(got, { ok: false, code: want }, label);
    } else {
      assert.deepEqual(got, { ok: true, value: want }, label);
      // What the page sends, the server stores: the same value, accepted.
      const s = checkValue(sField(t, n), want);
      assert.ok(s.ok, `${label}: the server refuses what the page sends`);
    }
  }
  // Empty is null: a new row then takes the default, an edit clears the field (the caller decides).
  assert.deepEqual(v.fromInput(cField('products', 'name'), '   '), { ok: true, value: null });
  // Shown the way it is typed: money in major units, back to the same minor units.
  for (const minor of [0, 5, 99, 1999, 100000]) {
    assert.deepEqual(v.fromInput(cField('products', 'price'), v.toInput(cField('products', 'price'), minor) as string), { ok: true, value: minor }, String(minor));
  }
  assert.equal(v.toInput(cField('products', 'yen'), 500), '500');
  const at = Date.UTC(2026, 9, 5, 12, 30);
  assert.deepEqual(v.fromInput(cField('products', 'at'), v.toInput(cField('products', 'at'), at) as string), { ok: true, value: at }, 'datetime round-trips to the minute');
});

test('every closed code has its own sentence; none shows a raw code', async () => {
  const v = await loadValues();
  const codes = ['invalid', 'required', 'too_long', 'bad_query', 'signin_required', 'forbidden', 'unknown',
    'not_found', 'taken', 'in_use', 'too_large', 'unsupported_type', 'rate_limited'];
  const sentences = new Set<string>();
  for (const c of codes) {
    const s = v.problemText(c, 'price');
    assert.ok(s.length > 10 && !s.includes('_') && s.endsWith('.'), `${c}: ${s}`);
    sentences.add(s);
  }
  assert.equal(sentences.size, codes.length, 'each code reads differently');
  assert.equal(v.problemText('required', 'name'), 'Name is required.');
});

test('live regions stay in the page while empty; busy and paging controls are aria-disabled, never disabled', () => {
  const css = adminCss(resolve(THEMES.midnight, 'dark') as unknown as ThemeLike);
  const empty = css.split('\n').filter((l) => l.includes(':empty'));
  assert.ok(empty.length > 0, 'an empty status or error has its own rule');
  for (const rule of empty) assert.doesNotMatch(rule, /display:\s*none/, 'a region shown only with its message may not be heard');
  assert.match(css, /\.az-admin-status:empty \{ position: absolute/, 'out of sight, out of the layout');
  assert.match(css, /\.az-admin-button:is\(:disabled, \[aria-disabled="true"\]\)/, 'aria-disabled looks disabled');
  const tsx = adminTsx();
  assert.doesNotMatch(tsx, /\sdisabled=\{/, 'no control is disabled while it may hold focus');
  assert.match(tsx, /aria-disabled=\{busy \|\| undefined\}/);
  // The editor's ids have their own namespace, apart from the filter form's.
  assert.match(tsx, /"az-admin-edit-" \+ table \+ "-" \+ field/);
  assert.doesNotMatch(tsx, /"az-admin-" \+ table\.name \+ "-" \+ f\.name/);
});
