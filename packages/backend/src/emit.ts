/**
 * @az module backend-emit
 * Purpose: the server/ files az build writes for a site that declares backend.
 * Spec: docs/backend-spec.md §2
 * Exports: backendFiles, envExample, envFile, BACKEND_PINS, SERVER_DIR, BASEMAP_SOURCE, SERVER_PACKAGES, serverImports
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
import { fileURLToPath } from 'node:url';
import type { SpecBackend } from '../../core/src/backend.ts';
import type { SpecTable } from '../../core/src/data.ts';
import type { LockStep } from '../../core/src/data-lock.ts';
import { KEYS, keepsAccounts, PROVIDER_KEYS, TOOL_KEYS, toolKey, type Setup } from './server/env.ts';
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
  pg: '8.23.1',
  mysql2: '3.24.5',
  nodemailer: '10.1.0',
  /** The image library (data-spec §8, §16 Q6): only a site with an image field installs it. */
  sharp: '0.35.5',
} as const;

/** Node that runs TypeScript directly and ships `node:sqlite` unflagged. */
export const NODE_ENGINE = '>=22.18';

export const SERVER_DIR = 'server';

/**
 * The chat packages a generated server imports by `#<name>/<file>.ts`
 * (ARCHITECTURE §2): each package's `src/` is copied whole into
 * `server/src/<name>/` — the same files the repository runs, never a second
 * copy — and the server's package.json maps the alias there. A server
 * without a chat gets only `withoutChat`: the files the modules every server
 * has import (env.ts reads a tool's shape and check from the answer checker).
 */
export const SERVER_PACKAGES: readonly { readonly name: string; readonly withoutChat: readonly string[] }[] = [
  { name: 'chat-answer', withoutChat: ['tool-shape.ts'] },
];

/** The server's package.json `imports`: each alias to its copied folder. */
export const serverImports = (): Record<string, string> =>
  Object.fromEntries(SERVER_PACKAGES.map((p) => [`#${p.name}/*`, `./src/${p.name}/*`]));

/**
 * The default world basemap (chat-block-spec §19.15): made by
 * scripts/gen-basemap.mjs from pinned public-domain data, copied by the build
 * to `server/<BUNDLED_WORLD>` for a site whose chat shows maps. The server
 * draws it when AZ_MAP_WORLD is unset; the operator's own archive replaces it.
 */
export const BASEMAP_SOURCE = fileURLToPath(new URL('../assets/basemap/world.pmtiles', import.meta.url));

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
  // Provider sign-in only for a server that keeps accounts; one that keeps none signs nobody in.
  if (keepsAccounts(setup)) {
    lines.push('# Provider sign-in: for each id in AZ_OAUTH_PROVIDERS, set AZ_OAUTH_<ID>_<SETTING>');
    lines.push('# (id upper-cased, - as _). Example for an id "work":');
    for (const p of PROVIDER_KEYS) lines.push(`#   AZ_OAUTH_WORK_${p.suffix}=    ${p.about}`);
  }
  if (setup.chat === true) {
    if (keepsAccounts(setup)) lines.push('');
    lines.push('# Chat data tools (optional): for each name in AZ_CHAT_TOOLS, set AZ_CHAT_TOOL_<NAME>_<SETTING>');
    lines.push('# (name upper-cased). Example for a tool "standings":');
    for (const t of TOOL_KEYS) lines.push(`#   ${toolKey('standings', t.suffix)}=    ${t.about}`);
  }
  return `${lines.join('\n')}\n`;
}

/** `.env` for `az backend init`: the example, with a fresh 32-byte session secret filled in. */
export function envFile(setup: Setup): string {
  const secret = randomBytes(32).toString('base64url');
  return envExample(setup).replace(/^AZ_SESSION_SECRET=$/m, `AZ_SESSION_SECRET=${secret}`);
}

/** What the server is for, in the README's first lines: its accounts and mail, or that it keeps none. */
function readmeIntro(setup: Setup, db: string): string {
  if (setup.email === undefined) {
    return `The server behind this site's chat, over ${db}. It keeps **no accounts**:
nothing on the site signs in, so it has no sign-in routes, no sessions and
sends no mail (chat-block-spec §19.15). The site talks to it at
\`AZ_PUBLIC_BACKEND_URL\`. A chat for signed-in visitors, data tables or the
site's own sign-in need accounts — the \`.az\` file then declares \`email\` and
\`auth\` / \`adapter azbackend\`, and \`az check\` says which line needs them.`;
  }
  const email = { smtp: 'SMTP', api: 'an HTTPS email API' }[setup.email];
  return `The server behind this site's sign-in: accounts, sessions, password reset,
sign-in links and provider sign-in, over ${db}, sending email through ${email}.
It implements the \`azbackend\` protocol (auth-block-spec §3.4); the site talks
to it at \`AZ_PUBLIC_BACKEND_URL\`.`;
}

function readme(siteName: string, setup: Setup, data: BackendData | undefined): string {
  const db = { sqlite: 'SQLite (a file; no server to run)', postgres: 'PostgreSQL', mysql: 'MySQL' }[setup.database];
  return `${generatedMd('how to run, configure and deploy the site\'s backend')}# ${siteName} — backend

${readmeIntro(setup, db)}

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
\`POST /chat\`; this server sends it, with the chat's own instructions
(\`chat/prompt-<n>.txt\`, one per chat, each teaching only the components that
chat shows; \`chat/context.json\` says which chat reads which) and the site's
public pages from \`chat/context.json\` (all generated by \`az build\`, all
readable), to the model named in \`.env\`, and streams the answer back. The
\`.az\` file never names a provider or a model.

- **What reaches the page.** The model's text is parsed here
  (\`src/chat-answer/\`, the answer checker) before a byte is sent: prose becomes text events;
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
- **The model is yours to choose, in \`.env\`** — a restart changes it, never a
  rebuild. \`AZ_CHAT_API\` names the wire shape your provider or model server
  speaks, and the server asks at \`AZ_CHAT_URL\` plus that shape's path:
  \`completions\` (the common chat-completions streaming shape,
  \`/chat/completions\`, which hosted APIs and local model servers offer),
  \`messages\` (named stream events, \`/messages\`; the fixed part of the
  system text is sent with a prompt-cache marker), \`contents\`
  (\`/models/<AZ_CHAT_MODEL>:streamGenerateContent\`; set
  \`AZ_CHAT_KEY_HEADER\` to the header your provider reads the key from) or
  \`local\` (one JSON object per line, \`/api/chat\`, as local model servers
  answer — no key needed). \`AZ_CHAT_MODEL\` is the model id; there is no
  default. \`AZ_CHAT_URL\` is https, or plain http only for a model server
  on localhost. \`AZ_CHAT_KEY\` stays in \`.env\` and is sent only to that
  URL; a header your provider also requires (a version header, say) goes
  in \`AZ_CHAT_HEADERS\` as \`name=value\`. A provider's error body is never
  shown or logged — only its HTTP status.
- \`AZ_CHAT_API=fake\` replays the answers in \`AZ_CHAT_FAKE_FILE\`; it is
  refused unless \`AZ_BACKEND_PUBLIC_URL\` is on localhost (development).
- **Cost.** Per answer: input = the chat's \`chat/prompt-<n>.txt\` + \`chat/context.json\`
  (≤ 24 000 characters of pages) + the rows of the tables a chat knows
  (≤ 12 000 characters each) + the conversation (≤ 12 000 characters);
  output ≤ \`AZ_CHAT_MAX_OUTPUT_TOKENS\`. When the provider reports no
  usage the server counts 3 characters a token, which over-counts. A day
  costs at most

      AZ_CHAT_DAILY_TOKENS × <HIGHER_OF_YOUR_TWO_PRICES_PER_TOKEN>

  and a day's real cost is

      input tokens × <PRICE_PER_INPUT_TOKEN> + output tokens × <PRICE_PER_OUTPUT_TOKEN>

  with the day's counts from \`az backend usage\` and your provider's prices.
  \`az doctor\` says how many answers the budget pays for at their largest.
  Past the budget chat answers \`budget_exhausted\` until 00:00 UTC.
  \`AZ_CHAT_ENABLED=off\` switches it off at once.
- **Moderation (optional).** Set \`AZ_CHAT_MODERATION_URL\` (and
  \`AZ_CHAT_MODERATION_KEY\`, sent as a bearer token) to have every
  question judged before the model sees it: the server POSTs
  \`{ "text": "…" }\` — the visitor's words in the conversation, nothing
  about the visitor — and needs \`{ "allow": true }\` or
  \`{ "allow": false }\` within 3 s. It fails closed: a block answers
  \`blocked\`, and an error, a late or malformed answer answers
  \`unavailable\`; the model is not asked either way. Answers are not
  moderated: what they can show is bounded by the parser above.
- **Data tools (optional).** List your own HTTP endpoints in
  \`AZ_CHAT_TOOLS\` and declare each with its \`AZ_CHAT_TOOL_<NAME>_…\` keys
  (\`.env.example\` lists them): a chart, table or stat may then take live
  figures \`from tool <name> …\`. The model only names a declared tool and
  typed parameter values; the server POSTs those values as a JSON object to
  the URL you set (https, or http on localhost; redirects are refused), with
  \`AZ_CHAT_TOOL_<NAME>_KEY\` as a bearer token when set, and needs a \`200\`
  \`application/json\` reply within the tool's timeout (≤ 5 s): an array of at
  most 200 rows of exactly the declared fields, at most 256 KB. Anything else
  shows the visitor "These figures could not be loaded." Figures show "From
  <label>"; the rows go to the page only and are **never sent to the model**.
  At most 3 calls an answer, \`AZ_CHAT_TOOL_CALLS_PER_ADDRESS\` per address,
  each reply cached 60 s. **Your endpoint must treat the parameters as
  untrusted input** — they are what a model wrote, checked only against the
  types you declared. Logs say \`chat: tool <name> <outcome> <ms> <rows>\` —
  never a parameter, a value or the key.
- **Limits.** Per address and per account (\`AZ_CHAT_PER_ADDRESS\`,
  \`AZ_CHAT_PER_ACCOUNT\`), \`AZ_CHAT_CONCURRENCY\` answers at once with four
  times as many waiting up to 10 s, and \`AZ_CHAT_TIMEOUT_SECONDS\` per answer.
  The chat's rate limits (messages, share creates, tool calls) and the budget are
  counted in the database, so every instance on it shares them (\`az_chat_limits\`
  holds keyed hashes and counts, never an address or an account); the answer
  queue, a shared answer's read and delete limits and the 60 s caches are
  each instance's own.
- **A reverse proxy must not buffer \`/chat\`**, or the answer arrives all at
  once: turn response buffering off for that path (the server sends
  \`x-accel-buffering: no\`).
- **Nothing is stored** but per-day counts in \`az_chat_usage\` (tokens and
  messages, no text, no person), kept 400 days, the rate-limit counts above,
  and the answers visitors chose to share (\`az_chat_shares\`, until they expire). Logs carry an
  outcome, a duration and token counts — never a message, an address or an
  account.
- **Usage.** \`az backend usage <this folder>\` prints today's spend against
  the budget, the last 30 days' messages, tokens (with the input the
  provider read from its prompt cache, when it says), dropped components,
  questions the moderation hook blocked and shares, and the shares kept — counts only, read from the database without
  changing it. A site with data tables shows the same on \`/admin\` to the
  addresses in \`AZ_ADMIN_EMAILS\` (\`GET /admin/chat\`, admins only).

### Chat runbook

1. **Before going live**: \`az doctor\` (the chat keys by name, a model URL
   given with \`/chat/completions\` on it, the fake model left on, a budget
   that cannot pay for one answer, the known tables against their rules),
   \`az audit\` after the site's build (no server key in what ships, the
   shared-answer page's policy and \`noindex\`, \`chat/context.json\` holding
   public fields only, no HTML sink in the chat's page runtime), then
   \`az backend probe <this folder>\` against the model you mean to pin.
2. **The budget ran out** (\`budget_exhausted\`, one log line): chat is off
   until 00:00 UTC. Raise \`AZ_CHAT_DAILY_TOKENS\` knowingly and restart, or
   wait.
3. **Abuse or a runaway bill**: \`AZ_CHAT_ENABLED=off\` and restart — every
   question answers \`disabled\`. Lower \`AZ_CHAT_PER_ADDRESS\`,
   \`AZ_CHAT_PER_ACCOUNT\` or the budget, consider a moderation hook, then
   switch it back on.
4. **A shared answer must go**: \`az backend shares <this folder> --delete <its link or id>\`
   (it prints one audit line, never the answer); on a site with data tables an
   admin can do the same on \`/admin\`. \`AZ_CHAT_SHARES=off\` stops new ones.
5. **Rotating the model key**: set the new \`AZ_CHAT_KEY\`, restart; nothing
   else holds it. A tool's key the same way (\`AZ_CHAT_TOOL_<NAME>_KEY\`).
6. **A tool misbehaves** (slow, failing, answering the wrong shape — its log
   line says which): remove its name from \`AZ_CHAT_TOOLS\` and restart; its
   figures then drop from answers. \`az backend probe\` calls each tool once
   with its \`_SAMPLE\`.
- What a provider receives is the prompt, the context and the conversation —
  no cookie, address or account. Its terms for that data are yours to accept.
`;
}

/** The README's maps section (chat-block-spec §21.4.3), only for a site whose chat shows maps. */
function mapReadme(): string {
  return `
### Maps

A chat on this site may answer with a map. The map's tiles, label fonts and
icons come from this server — never a third party unless you choose one —
under \`/tiles/\`, to the site's origins only, by HTTP Range.

- **The default basemap**, \`tiles/world.pmtiles\`: \`az build\` put it here —
  land, lakes and country borders to zoom 6, about 1 MB, from public-domain
  data, credited by its own metadata. The maps draw it while
  \`AZ_MAP_WORLD\` is unset. It has no place names.
- **\`AZ_MAP_WORLD\`** (optional): your own PMTiles archive, drawn instead (a
  full basemap's world to zoom 6 is about 46 MB, with places and labels).
  docs/self-hosting.md says how to make one with \`pmtiles extract\`.
- **\`AZ_MAP_REGION\`** (optional): a regional extract drawn over the world —
  yours or the default; maps zoom in as far as it goes.
- **\`AZ_MAP_GLYPHS\`**, **\`AZ_MAP_SPRITES\`** (optional): the label fonts
  (\`<font>/<start>-<end>.pbf\`) and icons (\`light.json\`, \`light.png\`,
  \`dark.json\`, \`dark.png\`, their \`@2x\` copies). Without them, maps draw
  no place names or icons.
- **\`AZ_MAP_ATTRIBUTION\`**: the line your tile data's licence requires
  under every map. The server will not start with an archive or a region of
  yours and without it; with the default basemap its credit follows yours.
- **\`AZ_GEOCODER_URL\`** (optional): your geocoder, so an answer may place an
  address. The server asks it \`GET <url>?q=<address>\` and reads the first
  result's \`lat\` and \`lon\`; the browser never calls it. Each address is
  remembered a day; \`AZ_GEOCODER_PER_ADDRESS\` bounds the calls a visitor
  can cause. Logs say \`chat: geocode <found|none|why> <ms>\` — never the
  address.

Each file is opened when the server starts: a missing or foreign archive
stops it, named by its key. \`az doctor\` checks the same, and names a
third-party tile archive the site's build was given
(\`AZ_PUBLIC_MAP_TILES_URL\`).
`;
}

/** Everything under `server/` except the copied `src/`. */
export function backendFiles(siteName: string, backend: SpecBackend, data?: BackendData, chat?: BackendChat): BackendFile[] {
  // `data` only when there are tables, so a site without them gets exactly the files it got before; `chat` the same.
  const setup: Setup = {
    database: backend.database, email: backend.email,
    ...(data ? { data: true } : {}), ...(hasImages(data) ? { images: true } : {}), ...(chat ? { chat: true } : {}),
    ...(chat?.map ? { map: true } : {}),
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
        imports: serverImports(),
        ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
      }, null, 2)}\n`,
    },
    {
      path: `${SERVER_DIR}/az.config.json`,
      content: `${JSON.stringify({
        _generated: generatedJson('the backend\'s choices from the .az source: database and email'),
        siteName, database: setup.database, email: setup.email, ...(setup.data ? { data: true } : {}), ...(setup.images ? { images: true } : {}),
        ...(setup.chat ? { chat: true } : {}), ...(setup.map ? { map: true } : {}),
      }, null, 2)}\n`,
    },
    { path: `${SERVER_DIR}/.env.example`, content: `${hashHeader('every backend key with its meaning; copy to .env (az backend init) and fill it')}${envExample(setup)}` },
    { path: `${SERVER_DIR}/.gitignore`, content: `${hashHeader('keeps .env, the SQLite data and node_modules out of version control')}.env\ndata/\nnode_modules/\n` },
    { path: `${SERVER_DIR}/README.md`, content: `${readme(siteName, setup, data)}${chat ? chatReadme() : ''}${setup.map ? mapReadme() : ''}` },
    // Only with a chat, so a site without one gets exactly the files it got before.
    ...(chat ? [
      ...chat.prompts.map((p) => ({
        path: `${SERVER_DIR}/chat/${p.file}`,
        content: `${hashHeader('what one chat\'s model is told before the site content; read by the server, never sent to a browser')}${p.text}`,
      })),
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
