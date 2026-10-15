/**
 * @az module backend-emit
 * Purpose: the server/ files az build writes for a site that declares backend.
 * Spec: docs/backend-spec.md §2
 * Exports: backendFiles, envExample, envFile, BACKEND_PINS, SERVER_DIR
 * Edit guide: dependencies only for the chosen database/email; pins exact.
 * Tests: packages/backend/test/emit.test.ts, packages/backend/test/chat-context.test.ts
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
import type { BackendChat } from './chat-context.ts';
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
  /** The image library (data-spec §8, §16 Q6): only a site with an image field installs it. */
  sharp: '0.35.5',
} as const;

/** Node that runs TypeScript directly and ships `node:sqlite` unflagged. */
export const NODE_ENGINE = '>=22.18';

export const SERVER_DIR = 'server';

/** A `#`-comment file's first line — the same header as every generated file (core generated.ts). */
const hashHeader = (what: string): string => `# GENERATED ${generatedJson(what)}\n`;

export interface BackendFile { readonly path: string; readonly content: string }

/** Only the drivers this setup uses — a SQLite server installs none; only image fields bring the image library. */
export function serverDependencies(setup: Setup): Record<string, string> {
  return {
    ...(setup.database === 'postgres' ? { pg: BACKEND_PINS.pg } : {}),
    ...(setup.database === 'mysql' ? { mysql2: BACKEND_PINS.mysql2 } : {}),
    ...(setup.email === 'smtp' ? { nodemailer: BACKEND_PINS.nodemailer } : {}),
    ...(setup.images === true ? { sharp: BACKEND_PINS.sharp } : {}),
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
  const images = hasImages(data) ? `
**Images.** An image field is uploaded with \`PUT /data/<table>/<id>/<field>\`
(the raw bytes, at most \`AZ_UPLOAD_MAX_MB\`) after its row exists. Only
JPEG, PNG, WebP and AVIF are accepted, by their first bytes; each is decoded
and stored re-encoded as WebP, at most 2048 px a side, with no metadata — a
photo's location never reaches the disk — and as copies 480, 768 and 1200 px
wide where narrower, for the pages' \`srcset\`. Files live in \`AZ_FILES_DIR\`
under generated names; back that folder up with the database. Files no row
names are removed hourly once an hour old.

Images uploaded before width copies existed are served as they are, without
copies. \`node src/main.ts --images\` counts them; \`node src/main.ts --images
--confirm\` makes their copies (resumable, safe while the server runs; from a
machine with the CLI: \`az backend images server --confirm\`).

The image library is a native package (libvips, LGPL-3.0-or-later, bundled
per platform): \`npm install\` on the machine that runs the server, not a copy
of another machine's \`node_modules\`.
` : '';
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
${images}`;
}

/** A table has an image field: the image library and the upload keys are needed. */
const hasImages = (data: BackendData | undefined) => data !== undefined && data.tables.some((t) => t.fields.some((f) => f.type === 'image'));

/** The README's chat section: the keys, the cost, and what is and is not kept. */
function chatReadme(): string {
  return `
## Chat

A page of this site shows a chat. The browser posts each question to
\`POST /chat\`; this server sends it, with \`chat/prompt.txt\` and the site's
public pages from \`chat/context.json\` (both generated by \`az build\`, both
readable), to the model named in \`.env\`, and streams the answer back. The
\`.az\` file never names a provider or a model.

- **What reaches the page.** The model's text is parsed here
  (\`src/chat-answer.ts\`) before a byte is sent: prose becomes text events;
  the components a chat's \`show\` lists — the site's own pricing block,
  quoted; an FAQ, a feature list and a call to action, composed — become
  checked events; anything else is text, or dropped and counted
  (\`az_chat_usage.dropped\`). A call to action can only point where the
  \`.az\` file already points.
- **Before going live**, run \`az backend probe <this folder>\`: it sends the
  real prompt and context to the model in \`.env\`, one question per
  component, and reports per answer whether it streamed, the time to its
  first text and in total, the provider's token counts and what the parser
  dropped — never the key, never the answer's words. It exits 1 when an
  answer is empty, fails, or holds a component the parser refused; try
  another model then.
- \`AZ_CHAT_API=completions\` speaks the common chat-completions streaming
  shape (\`POST <AZ_CHAT_URL>/chat/completions\`, \`stream: true\`), which hosted
  APIs and local model servers offer. \`AZ_CHAT_URL\` is https, or plain http
  only for a model server on localhost. \`AZ_CHAT_KEY\` stays in \`.env\`.
- \`AZ_CHAT_API=fake\` replays the answers in \`AZ_CHAT_FAKE_FILE\`; it is
  refused unless \`AZ_BACKEND_PUBLIC_URL\` is on localhost (development).
- **Cost.** Per answer roughly: input = prompt + context (≤ 24 000
  characters) + the conversation; output ≤ \`AZ_CHAT_MAX_OUTPUT_TOKENS\`.
  A day costs at most \`AZ_CHAT_DAILY_TOKENS\` tokens: about
  \`input tokens × <PRICE_PER_INPUT_TOKEN> + output tokens × <PRICE_PER_OUTPUT_TOKEN>\`
  at your provider's prices. Past the budget chat answers \`budget_exhausted\`
  until 00:00 UTC. \`AZ_CHAT_ENABLED=off\` switches it off at once.
- **Limits.** Per address and per account (\`AZ_CHAT_PER_ADDRESS\`,
  \`AZ_CHAT_PER_ACCOUNT\`), \`AZ_CHAT_CONCURRENCY\` answers at once with four
  times as many waiting up to 10 s, and \`AZ_CHAT_TIMEOUT_SECONDS\` per answer.
  Rate limits are per process; the budget is shared through the database.
- **A reverse proxy must not buffer \`/chat\`**, or the answer arrives all at
  once: turn response buffering off for that path (the server sends
  \`x-accel-buffering: no\`).
- **Nothing is stored** but per-day counts in \`az_chat_usage\` (tokens and
  messages, no text, no person), kept 400 days. Logs carry an outcome, a
  duration and token counts — never a message, an address or an account.
- What a provider receives is the prompt, the context and the conversation —
  no cookie, address or account. Its terms for that data are yours to accept.
`;
}

/** Everything under `server/` except the copied `src/`. */
export function backendFiles(siteName: string, backend: SpecBackend, data?: BackendData, chat?: BackendChat): BackendFile[] {
  // `data` only when there are tables, so a site without them gets exactly the files it got before; `chat` the same.
  const setup: Setup = {
    database: backend.database, email: backend.email,
    ...(data ? { data: true } : {}), ...(hasImages(data) ? { images: true } : {}), ...(chat ? { chat: true } : {}),
  };
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
        siteName, database: setup.database, email: setup.email, ...(setup.data ? { data: true } : {}), ...(setup.images ? { images: true } : {}),
        ...(setup.chat ? { chat: true } : {}),
      }, null, 2)}\n`,
    },
    { path: `${SERVER_DIR}/.env.example`, content: `${hashHeader('every backend key with its meaning; copy to .env (az backend init) and fill it')}${envExample(setup)}` },
    { path: `${SERVER_DIR}/.gitignore`, content: `${hashHeader('keeps .env, the SQLite data and node_modules out of version control')}.env\ndata/\nnode_modules/\n` },
    { path: `${SERVER_DIR}/README.md`, content: `${readme(siteName, setup, data)}${chat ? chatReadme() : ''}` },
    // Only with a chat, so a site without one gets exactly the files it got before.
    ...(chat ? [
      { path: `${SERVER_DIR}/chat/prompt.txt`, content: `${hashHeader('what the chat model is told before the site content; read by the server, never sent to a browser')}${chat.prompt}` },
      { path: `${SERVER_DIR}/chat/context.json`, content: chat.context },
    ] : []),
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
