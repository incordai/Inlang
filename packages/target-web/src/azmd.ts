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

export interface MapInput {
  readonly site: string;
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
  return out.join('\n') + '\n';
}
