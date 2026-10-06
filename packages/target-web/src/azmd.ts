/**
 * @az module azmd
 * Purpose: writes AZ.md, the generated project's map — pages, blocks → classes, files, runtimes, env, build.
 * Spec: docs/ARCHITECTURE.md §7
 * Exports: azMd, MapInput
 * Edit guide: keep it deterministic (input order only, no timestamps) and short — it is read to SAVE tokens.
 * Tests: packages/target-web/test/azmd.test.ts
 */

import type { EmittedNode } from '../../core/src/emit-contract.ts';
import { COMPONENT_TAG } from '../../core/src/emit-contract.ts';
import { generatedMd } from './generated.ts';
import type { SpecTable } from '../../core/src/data.ts';
import { DATA_DIR } from './data-client.ts';

export interface MapInput {
  readonly site: string;
  readonly theme: string;
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

  const set = ['display', 'body', 'mono'].filter((r) => m.fonts[r]).map((r) => `${r} ${m.fonts[r]}`);
  out.push(`Theme \`${m.theme}\` — colours, space and type come from its tokens. Fonts: ${set.length
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
  out.push('- `src/entry-server.tsx`, `az-vite/build.mjs` — the build: bundle, then pre-render every route');
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
  }
  return out.join('\n') + '\n';
}
