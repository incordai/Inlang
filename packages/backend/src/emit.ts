/**
 * @az module backend-emit
 * Purpose: the server/ files az build writes for a site that declares backend.
 * Spec: docs/backend-spec.md §2
 * Exports: backendFiles, envExample, envFile, BACKEND_PINS, SERVER_DIR
 * Edit guide: dependencies only for the chosen database/email; pins exact.
 * Tests: packages/backend/test/emit.test.ts
 */

/**
 * The files `az build` writes for a site that declares a `backend`
 * (backend-spec §8), and the `.env` that `az backend init` writes.
 *
 * Pure — no filesystem; the CLI writes these and copies `src/server/` in
 * beside them. Nothing here holds a secret: `.env.example` lists names and
 * descriptions only; the one generated secret goes into `.env`, which is
 * never part of a build.
 */

import { randomBytes } from 'node:crypto';
import type { SpecBackend } from '../../core/src/backend.ts';
import type { SpecTable } from '../../core/src/data.ts';
import type { LockStep } from '../../core/src/data-lock.ts';
import { KEYS, PROVIDER_KEYS, type Setup } from './server/env.ts';
import { generatedJson, generatedMd } from '../../core/src/generated.ts';
import { dataSteps } from './data-ddl.ts';
import { openapi } from './openapi.ts';

/** The site's data tables and the lock's steps that build them (data-spec §6). */
export interface BackendData {
  readonly tables: readonly SpecTable[];
  readonly steps: readonly LockStep[];
}

/**
 * Exact pins for the drivers a generated server may need — vetted rows
 * (backend-spec §9). A test ties them to the repository's own dev
 * dependencies, which run the database tests.
 */
export const BACKEND_PINS = {
  pg: '8.23.0',
  mysql2: '3.24.4',
  nodemailer: '10.0.10',
} as const;

/** Node that runs TypeScript directly and ships `node:sqlite` unflagged. */
export const NODE_ENGINE = '>=22.18';

export const SERVER_DIR = 'server';

/** A `#`-comment file's first line — the same header as every generated file (core generated.ts). */
const hashHeader = (what: string): string => `# GENERATED ${generatedJson(what)}\n`;

export interface BackendFile { readonly path: string; readonly content: string }

/** Only the drivers this setup uses — a SQLite server installs none. */
export function serverDependencies(setup: Setup): Record<string, string> {
  return {
    ...(setup.database === 'postgres' ? { pg: BACKEND_PINS.pg } : {}),
    ...(setup.database === 'mysql' ? { mysql2: BACKEND_PINS.mysql2 } : {}),
    ...(setup.email === 'smtp' ? { nodemailer: BACKEND_PINS.nodemailer } : {}),
  };
}

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';

/** `.env.example` — every key this setup reads, described, with no secret values. */
export function envExample(setup: Setup): string {
  const lines = [
    '# The backend\'s settings. Copy to .env (or run: az backend init <this folder>)',
    '# and fill in. .env is never committed; this file is.',
    '',
  ];
  for (const k of KEYS.filter((key) => key.when(setup))) {
    lines.push(`# ${k.about}${k.required ? ' (required)' : ''}`);
    lines.push(`${k.name}=${k.secret ? '' : k.example ?? ''}`);
    lines.push('');
  }
  lines.push('# Provider sign-in: for each id in AZ_OAUTH_PROVIDERS, set AZ_OAUTH_<ID>_<SETTING>');
  lines.push('# (id upper-cased, - as _). Example for an id "work":');
  for (const p of PROVIDER_KEYS) lines.push(`#   AZ_OAUTH_WORK_${p.suffix}=    ${p.about}`);
  return `${lines.join('\n')}\n`;
}

/** `.env` for `az backend init`: the example, with a fresh 32-byte session secret filled in. */
export function envFile(setup: Setup): string {
  const secret = randomBytes(32).toString('base64url');
  return envExample(setup).replace(/^AZ_SESSION_SECRET=$/m, `AZ_SESSION_SECRET=${secret}`);
}

function readme(siteName: string, setup: Setup, data: BackendData | undefined): string {
  const db = { sqlite: 'SQLite (a file; no server to run)', postgres: 'PostgreSQL', mysql: 'MySQL' }[setup.database];
  const email = { smtp: 'SMTP', api: 'an HTTPS email API' }[setup.email];
  return `${generatedMd('how to run, configure and deploy the site\'s backend')}# ${siteName} — backend

The server behind this site's sign-in: accounts, sessions, password reset,
sign-in links and provider sign-in, over ${db}, sending email through ${email}.
It implements the \`azbackend\` protocol (auth-block-spec §3.4); the site talks
to it at \`AZ_PUBLIC_BACKEND_URL\`.

## Run it locally

For development, run \`az dev site.az\` in the site's folder instead: it serves
the site and this backend together with no .env — SQLite in .az-dev/, and
email shown in a local mailbox rather than sent (backend-spec §2a).

To run this production server itself on your machine:

\`\`\`sh
az backend init .        # writes .env with a fresh secret (once)
# edit .env: fill every empty required value
npm install
npm start                # node ${NODE_ENGINE.replace('>=', '')}+ runs src/main.ts directly
\`\`\`

It refuses to start, naming each problem, until .env is complete and safe.
Then build the site with \`AZ_PUBLIC_BACKEND_URL\` set to this server's URL.

## Keys

\`.env.example\` lists every key with its meaning. Secrets (\`AZ_SESSION_SECRET\`,
\`AZ_DATABASE_URL\`, \`AZ_SMTP_PASSWORD\`, \`AZ_EMAIL_API_KEY\`, provider client
secrets) live only in \`.env\` or your host's secret store — never in the
site's build, which only ever inlines \`AZ_PUBLIC_*\` values.

## Deploy

- Put it on the **same site** as the pages (\`api.example.org\` beside
  \`www.example.org\`) and keep \`AZ_COOKIE_SAMESITE=lax\`. On a different site
  set \`none\`; some browsers then block the cookie outright.
- Serve it over **https** (a reverse proxy in front, or a platform that
  terminates TLS). Set \`AZ_HOST=0.0.0.0\` inside a container.
- \`AZ_TRUST_PROXY\` is the number of proxies you control in front (\`true\`
  means one). Each must APPEND the client address to X-Forwarded-For; the
  server reads the entry that many places from the right. Leave it \`false\`
  when the server is reached directly — otherwise any visitor chooses their
  own rate-limit address.
- Sessions end after \`AZ_SESSION_IDLE_MINUTES\` unused (default a day) and
  \`AZ_SESSION_MAX_HOURS\` after sign-in (default two weeks). ASVS level 2
  asks for 30 minutes and 12 hours.
- \`AZ_ALLOWED_ORIGINS\` is the exact site origin(s); it is also the only
  place a sign-in may redirect to.
- Rate limits are counted per process. With several instances, put the
  limit in front (proxy or platform) as well.
- \`/health\` answers \`{"ok":true}\` for a load balancer.
- Migrations run on every start and are safe to repeat.
${data ? dataReadme(data) : ''}`;
}

/** The README's data section: the API, and the runbook for a step that loses data. */
function dataReadme(data: BackendData): string {
  return `
## Data

This server also serves the site's tables (${data.tables.map((t) => `\`${t.name}\``).join(', ')})
at \`/data/<table>\` — \`openapi.json\` describes every route. Who may read,
create, edit and delete is decided by the \`allow\` lines in the .az file and
checked inside each database statement. The Origin check stops other sites'
pages, not other programs: the rules are the access control.

The tables' history is \`data.json\`, built from the site's \`.data.json\`
lock. On start the server applies each new step, one statement at a time,
recorded so an interrupted step resumes. Several instances may start at once:
one applies each statement, the others wait.

**A step that loses data** (a drop, a rename, a removed choice, a new
unique) is never applied on start. The server refuses to start and names it.
Then:

1. Back up the database.
2. Run \`node src/main.ts --migrate --confirm <version>\` with the version it
   named. It applies the steps up to that version and exits; a removed choice
   or a new unique is refused while rows still hold the old value or share a
   value, with the count.
3. Start the server as usual.
`;
}

/** Everything under `server/` except the copied `src/`. */
export function backendFiles(siteName: string, backend: SpecBackend, data?: BackendData): BackendFile[] {
  const setup: Setup = { database: backend.database, email: backend.email };
  const deps = serverDependencies(setup);
  return [
    {
      path: `${SERVER_DIR}/package.json`,
      content: `${JSON.stringify({
        _generated: generatedJson('the backend\'s package: start script, Node engine, exact driver pins'),
        name: `${safeName(siteName)}-backend`,
        private: true,
        type: 'module',
        engines: { node: NODE_ENGINE },
        scripts: { start: 'node src/main.ts' },
        ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
      }, null, 2)}\n`,
    },
    {
      path: `${SERVER_DIR}/az.config.json`,
      content: `${JSON.stringify({
        _generated: generatedJson('the backend\'s choices from the .az source: database and email'),
        siteName, database: setup.database, email: setup.email,
      }, null, 2)}\n`,
    },
    { path: `${SERVER_DIR}/.env.example`, content: `${hashHeader('every backend key with its meaning; copy to .env (az backend init) and fill it')}${envExample(setup)}` },
    { path: `${SERVER_DIR}/.gitignore`, content: `${hashHeader('keeps .env, the SQLite data and node_modules out of version control')}.env\ndata/\nnode_modules/\n` },
    { path: `${SERVER_DIR}/README.md`, content: readme(siteName, setup, data) },
    // Only with tables, so a site without data gets exactly the files it got before.
    ...(data ? [
      {
        path: `${SERVER_DIR}/data.json`,
        content: `${JSON.stringify({
          _generated: generatedJson('the data tables, their rules, and the SQL that builds them, from the .az file and its .data.json lock'),
          tables: data.tables,
          steps: dataSteps(data.steps),
        }, null, 2)}\n`,
      },
      { path: `${SERVER_DIR}/openapi.json`, content: openapi(siteName, data.tables, data.steps.length) },
    ] : []),
  ];
}
