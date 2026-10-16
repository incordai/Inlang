/**
 * @az module azmd
 * Purpose: writes AZ.md, the generated project's map — colour first, then pages, blocks → classes, files, runtimes, env, build.
 * Spec: docs/ARCHITECTURE.md §7
 * Exports: azMd, MapInput
 * Edit guide: keep it deterministic (input order only, no timestamps) and short — it is read to SAVE tokens.
 * Tests: packages/target-web/test/azmd.test.ts
 */

import type { EmittedNode } from '../../core/src/emit-contract.ts';
import { COMPONENT_TAG } from '../../core/src/emit-contract.ts';
import { generatedMd } from './generated.ts';
import { DEFAULT_THEME_NAME, colourChoicesMd, themeLinesAz } from '../../core/src/colour.ts';
import type { SpecTable } from '../../core/src/data.ts';
import type { SpecFrom } from '../../core/src/spec-block.ts';
import { DATA_DIR } from './data-client.ts';
import { ROWS_FILE } from './data-rows.ts';

export interface MapInput {
  readonly site: string;
  readonly theme: string;
  /** `theme accent` hue, or null for the theme's own (PRD §6.1a). */
  readonly accent: string | null;
  /** The second hue of an accent pair (theme-spec §13); absent for one hue. */
  readonly accent2?: string;
  /** `theme pattern` as "shape origin", or null when the site has none. */
  readonly pattern: string | null;
  /** `font` roles the site set: role → family (theme-spec §8.1). */
  readonly fonts: Readonly<Record<string, string>>;
  /** In the Spec's page order, with each page's emitted (styled) root nodes. */
  readonly pages: readonly { readonly route: string; readonly file: string; readonly nodes: readonly EmittedNode[] }[];
  readonly dirs: { readonly runtime: string; readonly user: string; readonly auth: string; readonly guard: string; readonly three: string };
  readonly auth: { readonly adapter: string; readonly profile: string; readonly protect: readonly string[] } | null;
  /** Public keys the build needs (they reach the browser). */
  readonly publicEnv: readonly string[];
  readonly three: boolean;
  readonly modules: readonly string[];
  readonly assets: readonly string[];
  readonly backend: { readonly database: string; readonly email: string } | null;
  /** The data tables (data-spec §4), or null without any. */
  readonly data: readonly SpecTable[] | null;
  /** Blocks with `from <table>` (data-spec §10), in page order; empty without any. */
  readonly from: readonly { readonly route: string; readonly word: string; readonly from: SpecFrom }[];
  /** Chat panels (chat-block-spec), in page order: who may ask, how long, what answers show, which blocks they quote; empty without any. */
  readonly chats?: readonly {
    readonly route: string; readonly allow: string; readonly limit: string;
    readonly show: readonly string[]; readonly quotes: readonly string[];
  }[];
}

/** `header.az-hero.az-hero--center.az-s-1a2b` — how a root element looks in the DOM. */
function selector(n: EmittedNode): string {
  if (n.tag === COMPONENT_TAG) return `your component ${n.attrs?.src ?? ''}`.trim();
  const cls = (n.attrs?.class ?? '').split(/\s+/).filter(Boolean);
  return [n.tag, ...cls].join('.');
}

/** The block a root element belongs to, from its word class: `hero center`. */
function blockOf(n: EmittedNode): string {
  if (n.tag === COMPONENT_TAG) return 'raw';
  const cls = (n.attrs?.class ?? '').split(/\s+/);
  const word = cls.find((c) => /^az-[a-z]+$/.test(c) && c !== 'az-page');
  if (!word) return n.tag;
  const variant = cls.find((c) => c.startsWith(`${word}--`));
  return `${word.slice(3)}${variant ? ` ${variant.slice(word.length + 2)}` : ''}`;
}

/** The generated AZ.md for one site. */
export function azMd(m: MapInput): string {
  const out: string[] = [];
  out.push(generatedMd('the map of this project for people and AI tools'));
  out.push(`# ${m.site} — project map`, '');
  out.push('The source of truth is the .az file this was built from. Change it and run `az build <file.az>`');
  out.push('(or `az dev <file.az>`); every file listed here is regenerated. To own a word\'s code for good,');
  out.push('`az eject <word>` copies it into your project (one-way).');
  out.push('What any term means: `az explain <term...>`, e.g. `az explain hero center`.', '');

  out.push('## Colour (change this first)', '');
  out.push('Colour is the first decision of a site, made before any section. Every colour comes from the theme:');
  out.push('there is no hex value or colour name to write, in the .az file or in a word.', '');
  out.push(`Now: theme \`${m.theme}\`. Accent: ${m.accent && m.accent2
    ? `\`${m.accent} ${m.accent2}\` — a gradient pair from two hue ramps, every point contrast-checked`
    : m.accent ? `\`${m.accent}\` — regenerated from its hue ramp, every step contrast-checked`
    : "the theme's own"}. Pattern: ${m.pattern ? `\`${m.pattern}\`, painted on the hero in the accent` : 'none'}.`, '');
  out.push(`The lines to edit, under \`site\` in the .az file (without a \`theme\` line the site gets \`${DEFAULT_THEME_NAME}\`):`, '');
  out.push('```az', ...themeLinesAz(m), '```', '');
  out.push('Then rebuild. `az explain theme` and `az explain theme accent` print the choices. The legal values:', '');
  out.push(...colourChoicesMd(m.theme), '');

  const set = ['display', 'body', 'mono'].filter((r) => m.fonts[r]).map((r) => `${r} ${m.fonts[r]}`);
  out.push(`Space and type come from the theme's tokens too. Fonts: ${set.length
    ? `${set.join(' · ')}; any role not set keeps the theme's family`
    : "the theme's own families"} (change with \`font\` in the .az; \`az explain font\`).`, '');

  out.push('## Pages', '', '| Route | File | Blocks, in order |', '|---|---|---|');
  for (const p of m.pages) {
    out.push(`| \`${p.route}\` | \`${p.file}\` | ${p.nodes.map(blockOf).join(' · ') || '—'} |`);
  }
  out.push('');

  out.push('## Blocks → classes', '');
  out.push('Each block\'s root element, as it appears in the page. `az-<word>` and `az-<word>--<variant>` are stable;');
  out.push('`az-s-…` classes are generated in `src/az.css` from the word\'s styles — change a style in the word or');
  out.push('theme, not in the CSS.', '');
  for (const p of m.pages) {
    for (const n of p.nodes) out.push(`- \`${p.route}\` · ${blockOf(n)} — \`${selector(n)}\``);
  }
  out.push('');

  out.push('## Files', '');
  out.push('- your `.az` file — the source of everything below');
  out.push('- `index.html`, `<route>/index.html` — one per page; the build pre-renders each, so it reads without JS');
  out.push('- `src/App.tsx` — every page as data (routes, blocks, styles)');
  out.push('- `src/runtime.tsx` — renders that data with React; `src/main.tsx` — browser entry (hydrates)');
  out.push('- `src/entry-server.tsx`, `az-vite/build.mjs` — the build: bundle, then pre-render every route and give it its Content-Security-Policy (`az-vite/csp.ts`)');
  out.push('- `src/az.css` — every block style as generated classes; `src/theme.css` — reset and colour schemes');
  out.push(`- \`${m.dirs.guard}/guard.ts\` — refuses any build that would ship a secret`);
  out.push('- `vite.config.ts`, `tsconfig.json`, `package.json` — tooling (exact pins)');
  out.push(`- \`${m.dirs.runtime}/\` — behaviour runtime: dialogs, dropdowns, nav scroll, FAQ, copy, billing, year, lightbox, carousel`);
  if (m.auth) out.push(`- \`${m.dirs.auth}/\` — auth runtime and config (adapter \`${m.auth.adapter}\`${m.auth.adapter === 'hosted' ? `, profile \`${m.auth.profile}\`` : ''})`);
  if (m.three) out.push(`- \`${m.dirs.three}/\` — the 3D runtime; loaded only by pages with a live 3D view`);
  if (m.modules.length > 0) out.push(`- \`${m.dirs.user}/\` — your components: ${m.modules.map((x) => `\`${x}\``).join(', ')}`);
  if (m.assets.length > 0) out.push(`- \`public/\` — your files, copied as-is: ${m.assets.map((x) => `\`${x}\``).join(', ')}`);
  if (m.backend) out.push(`- \`server/\` — the built-in backend (${m.backend.database}, email ${m.backend.email}); see \`server/README.md\``);
  if (m.data) out.push(`- \`${DATA_DIR}/client.ts\` — the typed client for the data tables: \`tables.<name>.list()\`, \`get\`, \`create\`, \`update\`, \`remove\``);
  out.push('');

  out.push('## Environment', '');
  if (m.publicEnv.length > 0) {
    out.push(`Public — these reach the browser (prefix AZ_PUBLIC_): ${m.publicEnv.map((k) => `\`${k}\``).join(', ')}.`);
  } else {
    out.push('No public keys are needed.');
  }
  if (m.auth && m.auth.protect.length > 0) out.push(`Protected routes (sign-in required): ${m.auth.protect.map((r) => `\`${r}\``).join(', ')}.`);
  if (m.backend) out.push('Server keys live in `server/.env` only (`az backend init server` writes it; `server/.env.example` lists every key). They never reach the browser.');
  out.push('');

  out.push('## Build, serve, deploy', '');
  out.push('- `npm install`, then `npm run dev` for a live preview — or `az dev <file.az>` to work from the source');
  out.push('- `npm run build` → `dist/`, every page pre-rendered');
  out.push('- Deploy `dist/` to any static host at a domain root (routes and assets are root-relative)');
  if (m.backend) out.push('- Run `server/` separately, over https on the same site as the pages — `server/README.md`');
  if (m.backend) {
    out.push('', '## Server', '');
    out.push(`The built-in backend (backend-spec): accounts, sessions, password reset, sign-in links and provider`);
    out.push(`sign-in over ${m.backend.database}, email by ${m.backend.email}. The site reaches it at \`AZ_PUBLIC_BACKEND_URL\``);
    out.push('with the `azbackend` protocol (auth-block-spec §3.4). Each `src/` file opens with an `@az` header saying what it does.', '');
    out.push('- `server/README.md` — run, configure and deploy it');
    out.push('- `server/package.json` — start script, Node engine, exact driver pins; `server/az.config.json` — the .az choices');
    out.push('- `server/.env.example` — every key and its meaning; `server/.env` holds the real values and is never generated');
    out.push('- `server/src/main.ts` — start: config, migrations, store, routes, HTTP server');
    out.push('- `server/src/app.ts` — the routes; `server/src/http.ts` — JSON, cookies, CORS, security headers, rate limits');
    out.push('- `server/src/store.ts`, `db.ts`, `migrations.ts`, `drivers.ts` — accounts, sessions, tokens over the database');
    out.push('- `server/src/claim.ts` — each migration claimed before it runs, so one of several starting servers applies it');
    out.push('- `server/src/email.ts` — reset and sign-in emails; `server/src/oidc.ts` — provider sign-in');
    out.push('- `server/src/env.ts` — every key, validated; `server/src/crypto.ts` — passwords, tokens, PKCE');
    out.push('- Change the backend\'s database or email in the .az source (`backend` under `site`), then rebuild');
  }
  if (m.data) {
    out.push('', '## Data', '');
    out.push('Tables from `data <name>` in the .az source, served at `/data/<name>` (data-spec §5; `server/openapi.json`).');
    out.push('Who may read, create, edit and delete is each table\'s `allow` lines, enforced inside every statement.', '');
    out.push('| Table | Fields | allow |', '|---|---|---|');
    for (const t of m.data) {
      const fields = t.fields.map((f) => `${f.name} ${f.type}${f.required ? '*' : ''}${f.private ? ' (private)' : ''}`).join(', ');
      const allow = (['anyone', 'signedin', 'owner'] as const)
        .map((who) => [who, (['read', 'create', 'edit', 'delete'] as const).filter((a) => t.rules[a].includes(who))] as const)
        .filter(([, actions]) => actions.length > 0)
        .map(([who, actions]) => `${who} ${actions.join(' ')}`).join('; ');
      out.push(`| \`${t.name}\` | ${fields} | ${allow || 'admins only'} |`);
    }
    out.push('', '`*` required. Change a table in the .az source, run `az backend plan <file.az>` then `az backend schema <file.az>`');
    out.push('(it records the step in `<file>.data.json`, the reviewed history), then rebuild.');
    out.push('- `server/src/data-api.ts` — the routes; `data-query.ts` — parameters, paging, search; `data-values.ts` — every value checked');
    out.push('- `server/src/data-migrate.ts` — applies `server/data.json`\'s steps; one that loses data waits for `--migrate --confirm`');
    const images = m.data.flatMap((t) => t.fields.filter((f) => f.type === 'image').map((f) => `\`${t.name}.${f.name}\``));
    if (images.length > 0) {
      out.push(`- Images (${images.join(', ')}; data-spec §8): \`tables.<name>.upload(id, field, file)\` / \`clear(id, field)\` once the row exists;`);
      out.push('  only JPEG, PNG, WebP and AVIF, stored re-encoded as WebP without metadata in `AZ_FILES_DIR` — `server/src/data-images.ts`');
    }
    out.push('', '## Admin', '');
    out.push('Generated pages, not pages of the .az file (data-spec §11): `/admin` lists the tables, their row counts and the');
    out.push(`audit log; ${m.data.map((t) => `\`/admin/${t.name}\``).join(', ')} list rows (search, sort, filter, pages), create, edit and delete.`);
    out.push('They carry `noindex` and sit inside `<Protected>`. `page /admin` in the .az file is an error (AZ1268).', '');
    out.push('- Who is an admin: a **verified** account whose address is in the server\'s `AZ_ADMIN_EMAILS` (`server/.env`).');
    out.push('  Empty: nobody. Read when the server starts: a change needs a restart, never a rebuild.');
    out.push('- The pages are UX, not security: the server checks every `/admin/...` request. Admins bypass `allow`, never validation;');
    out.push('  `locked` fields are writable. Every admin write is a row of `az_data_audit` (who, table, row, action, time — no values).');
    out.push(`- \`${DATA_DIR}/admin.tsx\` — the pages; \`${DATA_DIR}/admin-values.ts\` — the tables as data, inputs ↔ API values, codes → sentences`);
    out.push(`- \`${DATA_DIR}/client.ts\` — \`admin.tables()\`, \`list\`, \`get\`, \`create\`, \`update\`, \`remove\`, \`audit\`, \`upload\`, \`clear\``);
    out.push('- `server/src/data-api.ts` — the `/admin` routes (`handleAdmin`) and the audit; `.az-admin-*` styles are in `src/theme.css`');
  }
  if (m.from.length > 0) {
    out.push('', '## Data in blocks', '');
    out.push('Blocks with `from <table>` (data-spec §10) fill their items from a table after the page loads, AS THE VISITOR:');
    out.push('the table\'s `allow` lines apply to them. The build never calls the server, so each block ships a shell — a skeleton');
    out.push('sized from `limit`, an empty rows container, a hidden template item (the word\'s own item markup), a status line,');
    out.push('Try again and Sign in controls, a `<noscript>` line. Rows are not in the pre-rendered HTML.', '');
    out.push('| Page | Block | Table | Items from | Query |', '|---|---|---|---|---|');
    for (const b of m.from) {
      const mapping = Object.entries(b.from.map).map(([prop, field]) => `${prop} ← ${field}`).join(', ');
      const query = [`limit ${b.from.limit}`, ...(b.from.sort ? [`sort ${b.from.sort}`] : []),
        ...Object.entries(b.from.filter).map(([k, v]) => `${k} = ${v}`), ...(b.from.mine ? ['mine'] : [])].join(', ');
      out.push(`| \`${b.route}\` | ${b.word} | \`${b.from.table}\` | ${mapping} | ${query} |`);
    }
    out.push('');
    out.push(`- \`${ROWS_FILE}\` — hands each table's typed \`list\` to the runtime; App renders \`<RowsRuntime />\``);
    out.push(`- \`${m.dirs.runtime}/rows.ts\` — finds \`[data-az-from]\`, loads, fills copies of the template with text and checked`);
    out.push(`  attributes only, never HTML (a URL must be http(s)); \`${m.dirs.runtime}/rows-logic.ts\` — its pure rules`);
    out.push('- State: `data-az-from-state` is loading, rows, empty, signin or error; `aria-busy` while loading; the status line');
    out.push('  (`role=status`) says the `empty` copy or the error, politely. Copy and limits change in the .az source; rebuild.');
  }
  const chats = m.chats ?? [];
  if (chats.length > 0) {
    out.push('', '## Chat', '');
    out.push('`chat panel` blocks (chat-block-spec): a visitor asks, the site\'s own backend asks the model the operator chose in');
    out.push('`server/.env` (`AZ_CHAT_API`, `AZ_CHAT_URL`, `AZ_CHAT_MODEL`, `AZ_CHAT_KEY`), and the answer streams back. The .az file never');
    out.push('names a provider or a model. The page ships a shell — greeting, hidden form, hidden templates — and fills copies of the');
    out.push('templates with text only; nothing the model writes is ever markup.', '');
    out.push('| Page | Who may ask | Messages | Answers may show | Quotes |', '|---|---|---|---|---|');
    for (const c of chats) {
      out.push(`| \`${c.route}\` | ${c.allow === 'anyone' ? 'anyone' : 'signed-in visitors'} | ${c.limit} | ${c.show.length > 0 ? c.show.join(', ') : 'text only'} | ${c.quotes.length > 0 ? c.quotes.map((q) => `\`${q}\``).join(', ') : '—'} |`);
    }
    out.push('');
    out.push('- `show pricing faq cta feature` lists what an answer may hold besides text. `pricing` is quoted — the site\'s own block,');
    out.push('  as its page renders it, never prices the model wrote; `faq`, `feature` and `cta` are filled with the model\'s text. A call');
    out.push('  to action may point only at a destination this file declares. Anything else the model writes is text, or dropped.');
    out.push(`- \`${m.dirs.runtime}/chat.ts\` — sends the question, reads the event stream, fills the templates; \`${m.dirs.runtime}/chat-logic.ts\` —`);
    out.push('  the closed event shapes and the destination check; `src/chat/runtime.tsx` hands it the backend URL and the session');
    out.push(`- \`${m.dirs.runtime}/chat-markdown.ts\` and \`chat-prose.ts\` — an answer's formatting (bold, italic, code, lists, code blocks) read`);
    out.push('  into fixed elements and its follow-up questions as buttons; `chat-history.ts` — the conversation kept in the visitor\'s');
    out.push('  own browser for 7 days, with Clear history (nothing more is stored on the server)');
    out.push('- `server/chat/prompt.txt` — what the model is told (generated, readable); `server/chat/context.json` — the public page');
    out.push('  content it answers from, the quotable blocks and the destination allow-list');
    out.push('- `server/src/chat.ts` — `POST /chat`: limits, budget, queue, timeouts; `server/src/chat-answer.ts` — the answer parser:');
    out.push('  the model\'s text becomes typed events; `server/src/chat-adapters.ts` — the wire shapes (no provider SDK)');
    out.push('- Before going live: `az backend probe server` asks the configured model the real prompt and reports times, tokens and');
    out.push('  anything the parser dropped. Costs and limits are `AZ_CHAT_…` keys in `server/.env` (see `server/.env.example`).');
    out.push('- State: `data-az-chat-state` is idle, checking, signin, streaming or full; the answer is `aria-busy` while it streams;');
    out.push('  one polite status region hears finished sentences and one line per component.');
  }
  return out.join('\n') + '\n';
}
