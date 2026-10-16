/**
 * @az server env
 * Purpose: the configuration: every key, validation, refuse to start naming bad keys.
 * Spec: docs/backend-spec.md §4 (chat keys: docs/chat-block-spec.md §11.1; tool keys: §21.2.2; map and geocoder keys: §21.4)
 * Exports: loadConfig, KEYS, urlProblem, CHAT_LIMITS, parseRate, ChatConfig, ChatRate, TOOL_KEYS, TOOL_LIMITS, TOOL_NAME, TOOL_WORD, toolKey,
 *   toolSecretKeys, paramValueOk, paramsProblem, isDay, ChatTool, ChatToolShape, ToolParam, ToolParamType, ToolFieldType, MapConfig,
 *   GeocoderConfig, MAP_KEYS_LIMITS
 * Edit guide: server keys are never AZ_PUBLIC_; defaults are safe.
 * Tests: packages/backend/test/backend.test.ts, packages/backend/test/chat-route.test.ts
 */

/**
 * The backend's configuration — every key, what it means, and whether the
 * chosen setup needs it (backend-spec §4).
 *
 * One schema serves three readers: the server validates its environment
 * against it at start-up and refuses to run, naming each problem; `az build`
 * writes `.env.example` from it; `az backend init` writes `.env` from it.
 * Nothing here is ever sent to a browser — none of these names carries the
 * `AZ_PUBLIC_` prefix that a site build inlines.
 *
 * Copied into a generated server; imports nothing.
 */

export type Database = 'sqlite' | 'postgres' | 'mysql';
export type EmailWay = 'smtp' | 'api';

export interface Setup {
  readonly database: Database;
  readonly email: EmailWay;
  /** The site declares data tables (data-spec): their keys are listed too. */
  readonly data?: boolean;
  /** A data table has an image field (data-spec §8): the upload keys are listed too. */
  readonly images?: boolean;
  /** A page shows a chat (chat-block-spec): the model keys are listed too. */
  readonly chat?: boolean;
  /** A chat shows maps (chat-block-spec §21.4): the tile, glyph and sprite keys are listed too. */
  readonly map?: boolean;
}

export interface KeySpec {
  readonly name: string;
  readonly about: string;
  /** Needed by this setup. */
  readonly when: (s: Setup) => boolean;
  readonly required: boolean;
  /** A value `.env` may be written with; secrets are generated, never defaulted. */
  readonly example?: string;
  readonly secret?: boolean;
}

const always = () => true;

/** data-spec §8: the upload cap's default and ceiling, in MB. */
export const UPLOAD_MB = { default: 5, max: 20 } as const;

/** Every key the server reads, in the order `.env.example` lists them. */
export const KEYS: readonly KeySpec[] = [
  { name: 'AZ_SESSION_SECRET', about: 'Random, at least 32 bytes. Keys every stored token digest. `az backend init` generates one; never reuse it between deployments.', when: always, required: true, secret: true },
  { name: 'AZ_BACKEND_PUBLIC_URL', about: 'This server\'s own public base URL (https; http only for localhost). Used in emailed links and provider callbacks.', when: always, required: true, example: 'http://localhost:8787' },
  { name: 'AZ_ALLOWED_ORIGINS', about: 'The site origin(s) allowed to call this server, comma-separated, exact (https://www.example.org). Also the only places a sign-in may redirect to.', when: always, required: true, example: 'http://localhost:5173' },
  { name: 'AZ_HOST', about: 'Interface to listen on. 127.0.0.1 behind a reverse proxy; 0.0.0.0 in a container.', when: always, required: false, example: '127.0.0.1' },
  { name: 'AZ_PORT', about: 'Port to listen on.', when: always, required: false, example: '8787' },
  { name: 'AZ_TRUST_PROXY', about: 'How many reverse proxies you control sit in front and append to X-Forwarded-For: `false` (none, the default), `true` (one) or a number. Rate limits then use the address the outermost of them appended — never the client-supplied first entry.', when: always, required: false, example: 'false' },
  { name: 'AZ_SESSION_IDLE_MINUTES', about: 'A session unused this long ends (default 1440, a day). ASVS level 2 asks for 30.', when: always, required: false, example: '1440' },
  { name: 'AZ_SESSION_MAX_HOURS', about: 'A session ends this long after sign-in however active (default 336, two weeks). ASVS level 2 asks for 12.', when: always, required: false, example: '336' },
  { name: 'AZ_COOKIE_SAMESITE', about: '`lax` when the site and this server share a site (recommended), `none` when they do not.', when: always, required: false, example: 'lax' },
  { name: 'AZ_SQLITE_PATH', about: 'SQLite database file. Created on first start.', when: (s) => s.database === 'sqlite', required: false, example: './data/app.db' },
  { name: 'AZ_DATABASE_URL', about: 'Database connection string, e.g. postgres://user:password@host:5432/db or mysql://user:password@host:3306/db.', when: (s) => s.database !== 'sqlite', required: true, secret: true },
  { name: 'AZ_DATABASE_TLS', about: '`require` to insist on an encrypted database connection (recommended off-host).', when: (s) => s.database !== 'sqlite', required: false, example: 'require' },
  { name: 'AZ_DATABASE_CA_FILE', about: 'Path to the database host\'s root certificate (PEM), when it is not one your system already trusts — managed databases often publish their own. Needs AZ_DATABASE_TLS=require; the certificate is still verified.', when: (s) => s.database !== 'sqlite', required: false, example: './certs/database-ca.pem' },
  { name: 'AZ_EMAIL_FROM', about: 'The From address of every email this server sends.', when: always, required: true, example: 'Studio <no-reply@example.org>' },
  { name: 'AZ_SMTP_HOST', about: 'SMTP server host.', when: (s) => s.email === 'smtp', required: true },
  { name: 'AZ_SMTP_PORT', about: 'SMTP port: 587 (STARTTLS) or 465 (TLS).', when: (s) => s.email === 'smtp', required: true, example: '587' },
  { name: 'AZ_SMTP_USER', about: 'SMTP user name, if the server requires sign-in.', when: (s) => s.email === 'smtp', required: false },
  { name: 'AZ_SMTP_PASSWORD', about: 'SMTP password.', when: (s) => s.email === 'smtp', required: false, secret: true },
  { name: 'AZ_EMAIL_API_URL', about: 'HTTPS endpoint that accepts POST { from, to, subject, text } as JSON (backend-spec §7).', when: (s) => s.email === 'api', required: true },
  { name: 'AZ_EMAIL_API_KEY', about: 'Sent as `Authorization: Bearer <key>` to the email endpoint.', when: (s) => s.email === 'api', required: true, secret: true },
  { name: 'AZ_RESET_PATH', about: 'The site page that sets a new password; reset emails link there.', when: always, required: false, example: '/reset' },
  { name: 'AZ_LINK_LANDING', about: 'Where a sign-in link lands on the site once it has signed the visitor in.', when: always, required: false, example: '/' },
  { name: 'AZ_OAUTH_PROVIDERS', about: 'Provider ids, comma-separated (lower-case letters, digits, -). Each needs its own AZ_OAUTH_<ID>_… keys below; empty for none.', when: always, required: false, example: '' },
  { name: 'AZ_ADMIN_EMAILS', about: 'Who may use /admin: verified account addresses, comma-separated. An unverified account with a listed address is not an admin. Empty: nobody.', when: (s) => s.data === true, required: false, example: '' },
  { name: 'AZ_FILES_DIR', about: 'Where uploaded images are stored, outside anything served statically. Created on first start; back it up with the database.', when: (s) => s.images === true, required: false, example: './data/files' },
  { name: 'AZ_UPLOAD_MAX_MB', about: `The largest image upload, in MB (default ${UPLOAD_MB.default}, at most ${UPLOAD_MB.max}).`, when: (s) => s.images === true, required: false, example: String(UPLOAD_MB.default) },
  { name: 'AZ_CHAT_API', about: 'The chat model\'s wire shape: `completions` (the common chat-completions streaming shape, hosted or a local model server). `fake` replays AZ_CHAT_FAKE_FILE and is refused unless AZ_BACKEND_PUBLIC_URL is on localhost.', when: (s) => s.chat === true, required: true, example: 'completions' },
  { name: 'AZ_CHAT_URL', about: 'The model API\'s base URL; answers are requested from <url>/chat/completions. https, or plain http only for localhost (a model server on this machine). Required for completions.', when: (s) => s.chat === true, required: false, example: '' },
  { name: 'AZ_CHAT_KEY', about: 'Sent as `Authorization: Bearer <key>` to the model API. May be empty for a local model server.', when: (s) => s.chat === true, required: false, secret: true },
  { name: 'AZ_CHAT_MODEL', about: 'The model id, passed to the API as written. Required for completions.', when: (s) => s.chat === true, required: false, example: '' },
  { name: 'AZ_CHAT_DAILY_TOKENS', about: 'Tokens (input + output) all chats together may spend per UTC day; past it every message answers budget_exhausted until midnight UTC (default 300000, 1000–100000000).', when: (s) => s.chat === true, required: false, example: '300000' },
  { name: 'AZ_CHAT_MAX_OUTPUT_TOKENS', about: 'The most tokens one answer may use (default 600, 100–2000).', when: (s) => s.chat === true, required: false, example: '600' },
  { name: 'AZ_CHAT_PER_ADDRESS', about: 'Messages one address may send: `<n>/hour`, `<n>/day`, or both comma-separated (default 20/hour,60/day). An IPv6 address counts as its /64.', when: (s) => s.chat === true, required: false, example: '20/hour,60/day' },
  { name: 'AZ_CHAT_PER_ACCOUNT', about: 'Messages one signed-in account may send, in the same form (default 100/day).', when: (s) => s.chat === true, required: false, example: '100/day' },
  { name: 'AZ_CHAT_CONCURRENCY', about: 'Answers streamed at once (default 4, 1–64); four times as many wait up to 10 s, then are told busy.', when: (s) => s.chat === true, required: false, example: '4' },
  { name: 'AZ_CHAT_TIMEOUT_SECONDS', about: 'The longest one answer may take, in seconds (default 60, 10–300). The first token must come within 15 s, and each next within 20 s.', when: (s) => s.chat === true, required: false, example: '60' },
  { name: 'AZ_CHAT_ENABLED', about: '`off` switches chat off at once (every message answers disabled); `on` is the default.', when: (s) => s.chat === true, required: false, example: 'on' },
  { name: 'AZ_CHAT_SHARES', about: '`off` stops new share links (chat-block-spec §20.7): the Share button is not offered and a share is refused; links already made keep working until they expire. `on` is the default.', when: (s) => s.chat === true, required: false, example: 'on' },
  { name: 'AZ_CHAT_SHARE_DAYS', about: 'Days a shared answer stays readable before it is deleted (default 30, 1–365).', when: (s) => s.chat === true, required: false, example: '30' },
  { name: 'AZ_CHAT_SHARE_MAX', about: 'Shared answers kept at once, all visitors together; past it a share is refused until older ones expire (default 10000, 1–1000000).', when: (s) => s.chat === true, required: false, example: '10000' },
  { name: 'AZ_CHAT_SHARES_PER_ADDRESS', about: 'Shares one address may make, in the form of AZ_CHAT_PER_ADDRESS (default 10/hour,30/day).', when: (s) => s.chat === true, required: false, example: '10/hour,30/day' },
  { name: 'AZ_CHAT_SHARES_PER_ACCOUNT', about: 'Shares one signed-in account may make (default 30/day).', when: (s) => s.chat === true, required: false, example: '30/day' },
  { name: 'AZ_CHAT_MODERATION_URL', about: 'Optional: an endpoint that judges each question before the model sees it. It is sent POST { "text": "…" } as JSON and must answer { "allow": true } or { "allow": false } within 3 s; any other answer, an error or no answer refuses the question (it fails closed). https, or plain http only for localhost.', when: (s) => s.chat === true, required: false, example: '' },
  { name: 'AZ_CHAT_MODERATION_KEY', about: 'Sent as `Authorization: Bearer <key>` to AZ_CHAT_MODERATION_URL; may be empty.', when: (s) => s.chat === true, required: false, secret: true },
  { name: 'AZ_CHAT_FAKE_FILE', about: 'With AZ_CHAT_API=fake only: a JSON file of scripted answers, for tests and local development.', when: (s) => s.chat === true, required: false, example: '' },
  { name: 'AZ_CHAT_TOOLS', about: 'Optional: the names of your own HTTP data endpoints a chart, table or stat may take figures "from tool" (lower-case letters and digits, at most 24 characters, at most 8, comma-separated). Each needs its AZ_CHAT_TOOL_<NAME>_… keys below. The server POSTs the typed parameters as JSON to the URL you set and shows the rows it answers to the visitor, labelled; the model never reads them.', when: (s) => s.chat === true, required: false, example: '' },
  { name: 'AZ_CHAT_TOOL_CALLS_PER_ADDRESS', about: 'Tool calls one address may cause, in the form of AZ_CHAT_PER_ADDRESS (default 120/hour); past it a tool\'s figures show as not loaded. A cached answer is not a call.', when: (s) => s.chat === true, required: false, example: '120/hour' },
  { name: 'AZ_MAP_WORLD', about: 'The world tile archive the chat\'s maps draw (one PMTiles file, zoom 0–6 covers the world in about 46 MB; docs/self-hosting.md says how to make one). This server serves it to the site with HTTP Range. Unset: maps show their list of places only.', when: (s) => s.map === true, required: false, example: '' },
  { name: 'AZ_MAP_REGION', about: 'Optional: a regional extract (one PMTiles file) drawn over the world for detail; maps zoom in as far as it goes.', when: (s) => s.map === true, required: false, example: '' },
  { name: 'AZ_MAP_GLYPHS', about: 'Optional: a folder of map label fonts as glyph ranges (<font name>/<start>-<end>.pbf). Unset: maps draw no place names.', when: (s) => s.map === true, required: false, example: '' },
  { name: 'AZ_MAP_SPRITES', about: 'Optional: a folder of map icons (light.json, light.png, dark.json, dark.png and their @2x copies). Unset: maps draw no icons.', when: (s) => s.map === true, required: false, example: '' },
  { name: 'AZ_MAP_ATTRIBUTION', about: 'The map data\'s attribution, shown under every map — the licence of your tile data requires it (one line, at most 200 characters). Required with AZ_MAP_WORLD.', when: (s) => s.map === true, required: false, example: '' },
  { name: 'AZ_GEOCODER_URL', about: 'Optional: an endpoint that finds an address\'s coordinates, so a map may place an address. The server sends GET <url>?q=<address> and reads the first result\'s lat and lon (a JSON array, or { "results": [...] }) within 2 s and 16 KB; the browser never calls it. https, or plain http only for localhost.', when: (s) => s.map === true, required: false, example: '' },
  { name: 'AZ_GEOCODER_PER_ADDRESS', about: 'Addresses one visitor\'s address may have looked up, in the form of AZ_CHAT_PER_ADDRESS (default 60/hour); a remembered address is not a call.', when: (s) => s.map === true, required: false, example: '60/hour' },
  { name: 'AZ_OAUTH_SIGNUP', about: '`allow` lets a provider create a new account for a verified email; `deny` (default) only signs in to existing ones.', when: always, required: false, example: 'deny' },
];

/**
 * Per-provider keys, `AZ_OAUTH_<ID>_<SUFFIX>` with the id upper-cased and
 * `-` as `_`. A provider is OpenID Connect (discovered from its issuer) or
 * plain OAuth 2 (three URLs), set by TYPE.
 */
export const PROVIDER_KEYS: readonly { suffix: string; about: string; secret?: boolean }[] = [
  { suffix: 'LABEL', about: 'Shown as "Continue with <label>", at most 40 characters.' },
  { suffix: 'TYPE', about: '`oidc` (issuer discovery) or `oauth2` (the three URLs below).' },
  { suffix: 'ISSUER', about: 'oidc: the issuer URL; /.well-known/openid-configuration is read from it.' },
  { suffix: 'AUTHORIZE_URL', about: 'oauth2: the authorization endpoint.' },
  { suffix: 'TOKEN_URL', about: 'oauth2: the token endpoint.' },
  { suffix: 'USERINFO_URL', about: 'oauth2: returns the signed-in user\'s profile as JSON.' },
  { suffix: 'CLIENT_ID', about: 'Issued by the provider.' },
  { suffix: 'CLIENT_SECRET', about: 'Issued by the provider.', secret: true },
  { suffix: 'SCOPES', about: 'Space-separated. oidc default: openid email profile.' },
  { suffix: 'EMAIL_FIELD', about: 'oauth2: the profile field holding the email (default email).' },
  { suffix: 'VERIFIED_FIELD', about: 'oauth2: the profile field that is true when the email is verified (default email_verified). Without one, the address counts as unverified and never links to an account.' },
];

export const providerKey = (id: string, suffix: string) =>
  `AZ_OAUTH_${id.toUpperCase().replace(/-/g, '_')}_${suffix}`;

/**
 * Per-tool keys (chat-block-spec §21.2.2), `AZ_CHAT_TOOL_<NAME>_<SUFFIX>`
 * with the name upper-cased. KEY is a secret: never in `.env.example`,
 * never in a message, looked for by `az audit` in what ships.
 */
export const TOOL_KEYS: readonly { suffix: string; about: string; secret?: boolean }[] = [
  { suffix: 'URL', about: 'The endpoint the server POSTs the parameters to, as JSON. https, or plain http only for localhost; no user name or password, no #. Required.' },
  { suffix: 'KEY', about: 'Optional: sent as `Authorization: Bearer <key>`.', secret: true },
  { suffix: 'PARAMS', about: 'The parameters, a JSON object: { "<name>": { "type": "int"|"number"|"bool"|"date"|"enum"|"text", "min", "max", "values", "maxLength", "required" } }; at most 6. Absent: none.' },
  { suffix: 'FIELDS', about: 'Each row\'s fields, a JSON object: { "<name>": "text"|"number"|"date"|"bool" }; 1 to 8. The endpoint answers a JSON array of rows of exactly these fields. Required.' },
  { suffix: 'LABEL', about: 'The source the visitor sees under the figures ("From <label>"), 1 to 40 characters. Required.' },
  { suffix: 'ABOUT', about: 'Optional: one sentence the model is told about the tool, at most 200 characters.' },
  { suffix: 'TIMEOUT_MS', about: 'The longest one call may take, request and body, in ms (default 2000, 100–5000).' },
  { suffix: 'SAMPLE', about: 'Parameters az doctor checks and az backend probe calls the tool with, a JSON object valid under PARAMS.' },
];

export const toolKey = (name: string, suffix: string) => `AZ_CHAT_TOOL_${name.toUpperCase()}_${suffix}`;

/** chat-block-spec §21.2.2 / §21.2.4: what a tool declaration may hold. */
export const TOOL_LIMITS = {
  tools: 8,
  params: 6,
  enumValues: 24,
  /** A text parameter's longest value, and the default when maxLength is not given. */
  text: 80,
  /** An enum value's longest. */
  enumValue: 40,
  fields: 8,
  label: 40,
  about: 200,
  timeoutMs: { default: 2_000, min: 100, max: 5_000 },
  callsPerAddress: '120/hour',
} as const;

/** A tool's name, as AZ_CHAT_TOOLS lists it and the model writes it. */
export const TOOL_NAME = /^[a-z][a-z0-9]{0,23}$/;
/** A parameter's or a field's name, as the model writes it. */
export const TOOL_WORD = /^[a-z][a-z0-9_]{0,31}$/;
/** Words that start the aggregate after the parameters: never a parameter's name, or a request would read two ways. */
const TOOL_RESERVED: ReadonlySet<string> = new Set(['count', 'sum', 'avg', 'min', 'max', 'columns', 'title', 'by', 'from', 'tool']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ToolParamType = 'int' | 'number' | 'bool' | 'date' | 'enum' | 'text';
export type ToolFieldType = 'text' | 'number' | 'date' | 'bool';

/** One declared parameter: bounds for int, number and date; values for enum; a length for text. */
export interface ToolParam {
  readonly type: ToolParamType;
  readonly min: number | string | null;
  readonly max: number | string | null;
  readonly values: readonly string[] | null;
  readonly maxLength: number;
  readonly required: boolean;
}

/** What the answer parser and the model know of a tool: never its URL or key. */
export interface ChatToolShape {
  readonly name: string;
  readonly params: Readonly<Record<string, ToolParam>>;
  readonly fields: Readonly<Record<string, ToolFieldType>>;
  readonly label: string;
  readonly about: string;
}

/** A tool as the server calls it. */
export interface ChatTool extends ChatToolShape {
  readonly url: string;
  readonly key: string;
  readonly timeoutMs: number;
  /** AZ_CHAT_TOOL_<NAME>_SAMPLE, valid under params; null when unset. */
  readonly sample: Readonly<Record<string, string | number | boolean>> | null;
}

/** A real calendar day written `YYYY-MM-DD`. */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Text an operator wrote for a person: one line, no control characters, within `max` characters. */
const plainText = (v: string, max: number) => v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v);

/** Whether `v`, a JSON value, is a value `p` takes — the one check for a sample and for every call's body. */
export function paramValueOk(p: ToolParam, v: unknown): boolean {
  switch (p.type) {
    case 'int':
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e15) return false;
      if (p.type === 'int' && !Number.isInteger(v)) return false;
      return (p.min === null || v >= (p.min as number)) && (p.max === null || v <= (p.max as number));
    case 'bool': return typeof v === 'boolean';
    case 'date': return isDay(v) && (p.min === null || v >= (p.min as string)) && (p.max === null || v <= (p.max as string));
    case 'enum': return typeof v === 'string' && (p.values ?? []).includes(v);
    case 'text': return typeof v === 'string' && v.trim() !== '' && [...v].length <= p.maxLength;
  }
}

/** `{ "<param>": value }` checked against `params`: every name declared, every required one there, every value its type. */
export function paramsProblem(params: Readonly<Record<string, ToolParam>>, v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'is not a JSON object';
  for (const [k, x] of Object.entries(v)) {
    const p = Object.hasOwn(params, k) ? params[k] : undefined;
    if (!p) return `names a parameter PARAMS does not declare`;
    if (!paramValueOk(p, x)) return 'holds a value its parameter does not take';
  }
  for (const [k, p] of Object.entries(params)) if (p.required && !Object.hasOwn(v, k)) return 'leaves out a required parameter';
  return null;
}

/** A JSON object from `text`, or null. */
function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** One parameter declaration, or why it is not one (never quoting a value). */
function toolParam(raw: unknown): ToolParam | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'is not an object';
  const x = raw as Record<string, unknown>;
  if (Object.keys(x).some((k) => !['type', 'min', 'max', 'values', 'maxLength', 'required'].includes(k))) return 'has a key other than type, min, max, values, maxLength, required';
  const type = x.type;
  if (type !== 'int' && type !== 'number' && type !== 'bool' && type !== 'date' && type !== 'enum' && type !== 'text') return 'has no type of int, number, bool, date, enum or text';
  if (x.required !== undefined && typeof x.required !== 'boolean') return 'has a required that is not true or false';
  const ranged = type === 'int' || type === 'number' || type === 'date';
  if (!ranged && (x.min !== undefined || x.max !== undefined)) return `takes no min or max as ${type}`;
  const bound = (b: unknown): number | string | null | false => {
    if (b === undefined) return null;
    if (type === 'date') return isDay(b) ? b : false;
    if (typeof b !== 'number' || !Number.isFinite(b) || Math.abs(b) > 1e15) return false;
    return type === 'int' && !Number.isInteger(b) ? false : b;
  };
  const min = bound(x.min);
  const max = bound(x.max);
  if (min === false || max === false) return type === 'date' ? 'has a min or max that is not a YYYY-MM-DD day' : `has a min or max that is not ${type === 'int' ? 'a whole number' : 'a number'}`;
  if (min !== null && max !== null && min > max) return 'has a min above its max';
  let values: string[] | null = null;
  if (type === 'enum') {
    if (!Array.isArray(x.values) || x.values.length < 1 || x.values.length > TOOL_LIMITS.enumValues) return `needs values, 1 to ${TOOL_LIMITS.enumValues} of them`;
    if (!x.values.every((s) => typeof s === 'string' && plainText(s, TOOL_LIMITS.enumValue) && s.trim() === s && !s.includes('"') && !s.includes('\\'))) {
      return `has a value that is not one line of 1–${TOOL_LIMITS.enumValue} characters without quotes or backslashes`;
    }
    if (new Set(x.values).size !== x.values.length) return 'lists a value twice';
    values = x.values as string[];
  } else if (x.values !== undefined) return `takes no values as ${type}`;
  let maxLength: number = TOOL_LIMITS.text;
  if (type === 'text') {
    if (x.maxLength !== undefined) {
      if (!Number.isInteger(x.maxLength) || (x.maxLength as number) < 1 || (x.maxLength as number) > TOOL_LIMITS.text) return `has a maxLength that is not 1–${TOOL_LIMITS.text}`;
      maxLength = x.maxLength as number;
    }
  } else if (x.maxLength !== undefined) return `takes no maxLength as ${type}`;
  return { type, min, max, values, maxLength, required: x.required === true };
}

/**
 * AZ_CHAT_TOOLS and each tool's keys (chat-block-spec §21.2.2), every
 * problem named by its key — a value is never quoted, the key least of all.
 */
function chatTools(env: Readonly<Record<string, string | undefined>>, get: (k: string) => string, problems: string[]): ChatTool[] {
  const names = get('AZ_CHAT_TOOLS').split(',').map((s) => s.trim()).filter(Boolean);
  const tools: ChatTool[] = [];
  if (names.length > TOOL_LIMITS.tools) problems.push(`AZ_CHAT_TOOLS lists ${names.length} tools — at most ${TOOL_LIMITS.tools}`);
  const seen = new Set<string>();
  for (const name of names.slice(0, TOOL_LIMITS.tools)) {
    if (!TOOL_NAME.test(name)) { problems.push(`AZ_CHAT_TOOLS has a name that is not lower-case letters and digits, starting with a letter, at most 24 characters`); continue; }
    if (seen.has(name)) { problems.push(`AZ_CHAT_TOOLS lists '${name}' twice`); continue; }
    seen.add(name);
    const k = (s: string) => toolKey(name, s);
    const before = problems.length;
    const url = get(k('URL'));
    if (!url) problems.push(`${k('URL')} is missing (tool '${name}')`);
    else {
      let u: URL | null = null;
      try { u = new URL(url); } catch { problems.push(`${k('URL')} is not a URL`); }
      if (u) {
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) problems.push(`${k('URL')} must use https (plain http only for localhost)`);
        if (u.username || u.password) problems.push(`${k('URL')} must not carry a user name or password`);
        if (u.hash || url.includes('#')) problems.push(`${k('URL')} must not have a #`);
      }
    }
    const paramsText = get(k('PARAMS'));
    const params: Record<string, ToolParam> = {};
    if (paramsText) {
      const o = jsonObject(paramsText);
      if (!o) problems.push(`${k('PARAMS')} is not a JSON object`);
      else if (Object.keys(o).length > TOOL_LIMITS.params) problems.push(`${k('PARAMS')} declares more than ${TOOL_LIMITS.params} parameters`);
      else {
        for (const [p, raw] of Object.entries(o)) {
          if (!TOOL_WORD.test(p) || TOOL_RESERVED.has(p)) { problems.push(`${k('PARAMS')} has a parameter name that is not lower-case letters, digits and _ (at most 32), or is one of ${[...TOOL_RESERVED].join(', ')}`); continue; }
          const d = toolParam(raw);
          if (typeof d === 'string') problems.push(`${k('PARAMS')}: parameter '${p}' ${d}`);
          else params[p] = d;
        }
      }
    }
    const fields: Record<string, ToolFieldType> = {};
    const fieldsText = get(k('FIELDS'));
    if (!fieldsText) problems.push(`${k('FIELDS')} is missing (tool '${name}') — the fields of each row it answers`);
    else {
      const o = jsonObject(fieldsText);
      const n = o ? Object.keys(o).length : 0;
      if (!o) problems.push(`${k('FIELDS')} is not a JSON object`);
      else if (n < 1 || n > TOOL_LIMITS.fields) problems.push(`${k('FIELDS')} must declare 1 to ${TOOL_LIMITS.fields} fields`);
      else {
        for (const [f, t] of Object.entries(o)) {
          if (!TOOL_WORD.test(f)) problems.push(`${k('FIELDS')} has a field name that is not lower-case letters, digits and _ (at most 32)`);
          else if (t !== 'text' && t !== 'number' && t !== 'date' && t !== 'bool') problems.push(`${k('FIELDS')}: field '${f}' is not text, number, date or bool`);
          else fields[f] = t;
        }
      }
    }
    const label = get(k('LABEL'));
    if (!label) problems.push(`${k('LABEL')} is missing (tool '${name}') — the source the visitor sees`);
    else if (!plainText(label, TOOL_LIMITS.label)) problems.push(`${k('LABEL')} must be one line of 1–${TOOL_LIMITS.label} characters`);
    const about = get(k('ABOUT'));
    if (about && !plainText(about, TOOL_LIMITS.about)) problems.push(`${k('ABOUT')} must be one line of at most ${TOOL_LIMITS.about} characters`);
    const timeoutMs = bounded(get, k('TIMEOUT_MS'), TOOL_LIMITS.timeoutMs, problems);
    let sample: Record<string, string | number | boolean> | null = null;
    const sampleText = get(k('SAMPLE'));
    if (sampleText) {
      const o = jsonObject(sampleText);
      const why = o ? paramsProblem(params, o) : 'is not a JSON object';
      if (why) problems.push(`${k('SAMPLE')} ${why}`);
      else sample = o as Record<string, string | number | boolean>;
    }
    if (problems.length === before) tools.push({ name, url, key: get(k('KEY')), params, fields, label, about, timeoutMs, sample });
  }
  // A tool's key for a name not listed is a typo or a leftover: said, never silently ignored.
  const suffixes = TOOL_KEYS.map((t) => t.suffix).join('|');
  const keyRe = new RegExp(`^AZ_CHAT_TOOL_([A-Z][A-Z0-9]*)_(${suffixes})$`);
  for (const [key, value] of Object.entries(env)) {
    const m = keyRe.exec(key);
    if (m && (value ?? '').trim() !== '' && !seen.has(m[1].toLowerCase())) problems.push(`${key} is set, but '${m[1].toLowerCase()}' is not in AZ_CHAT_TOOLS — add it there, or remove the key`);
  }
  return tools;
}

/** The names of the secret tool keys `env` sets values for — `az audit` looks for each value in what ships. */
export function toolSecretKeys(env: Readonly<Record<string, string | undefined>>): string[] {
  const names = (env.AZ_CHAT_TOOLS ?? '').split(',').map((s) => s.trim()).filter((n) => TOOL_NAME.test(n));
  return [...new Set(names)].flatMap((n) => TOOL_KEYS.filter((t) => t.secret).map((t) => toolKey(n, t.suffix)));
}

export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const LABEL_MAX = 40;
const MIN_SECRET_BYTES = 32;
/** More trusted proxies than this is a misconfiguration, not an architecture. */
const MAX_PROXY_HOPS = 10;
const MINUTE_MS = 60 * 1000;

/** chat-block-spec §21.4: the map keys' bounds. */
export const MAP_KEYS_LIMITS = {
  attribution: 200,
  geocoderPerAddress: '60/hour',
} as const;

/** The tile data this server serves to the site's maps (chat-block-spec §21.4.3): file and folder paths, as .env gives them. */
export interface MapConfig {
  readonly world: string | null;
  readonly region: string | null;
  readonly glyphs: string | null;
  readonly sprites: string | null;
  readonly attribution: string;
}

/** The operator's geocoder (chat-block-spec §21.4.2): its URL, and how many lookups one address may cause. */
export interface GeocoderConfig { readonly url: string; readonly perAddress: ChatRate }

/** chat-block-spec §6.5: each chat setting's default and bounds. */
export const CHAT_LIMITS = {
  dailyTokens: { default: 300_000, min: 1_000, max: 100_000_000 },
  maxOutputTokens: { default: 600, min: 100, max: 2_000 },
  concurrency: { default: 4, min: 1, max: 64 },
  timeoutSeconds: { default: 60, min: 10, max: 300 },
  perAddress: '20/hour,60/day',
  perAccount: '100/day',
  /** A model id is text passed through; this is its longest. */
  modelMax: 200,
  /** chat-block-spec §20.7: share links. */
  shareDays: { default: 30, min: 1, max: 365 },
  shareMax: { default: 10_000, min: 1, max: 1_000_000 },
  sharesPerAddress: '10/hour,30/day',
  sharesPerAccount: '30/day',
} as const;

/** A message allowance per hour and per day; an absent window is not limited. */
export interface ChatRate { readonly hour?: number; readonly day?: number }

/** `20/hour,60/day`, `100/day` or `5/hour` as a ChatRate, or null when it is not one. */
export function parseRate(value: string): ChatRate | null {
  const out: { hour?: number; day?: number } = {};
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length > 2) return null;
  for (const part of parts) {
    const m = /^(\d{1,7})\/(hour|day)$/.exec(part);
    if (!m || Number(m[1]) < 1 || m[2] in out) return null;
    out[m[2] as 'hour' | 'day'] = Number(m[1]);
  }
  return out;
}

/** The chat settings (chat-block-spec §11.1); present only for a site with chat. */
export interface ChatConfig {
  readonly api: 'completions' | 'fake';
  readonly url: string;
  readonly key: string;
  readonly model: string;
  readonly dailyTokens: number;
  readonly maxOutputTokens: number;
  readonly perAddress: ChatRate;
  readonly perAccount: ChatRate;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly enabled: boolean;
  readonly fakeFile: string;
  /** The input-moderation hook (chat-block-spec §6.8): null when AZ_CHAT_MODERATION_URL is unset. */
  readonly moderation: { readonly url: string; readonly key: string } | null;
  /** The operator's data tools (chat-block-spec §21.2), in AZ_CHAT_TOOLS order; none when unset. */
  readonly tools: readonly ChatTool[];
  /** AZ_CHAT_TOOL_CALLS_PER_ADDRESS: tool calls one address may cause. */
  readonly toolCallsPerAddress: ChatRate;
  /** The geocoder a map's `place` is looked up with (§21.4.2): null when AZ_GEOCODER_URL is unset or the chat shows no map. */
  readonly geocoder: GeocoderConfig | null;
  /** Share links (chat-block-spec §20.7): whether new ones may be made, how long they last, how many at once, how often. */
  readonly shares: {
    readonly enabled: boolean;
    readonly days: number;
    readonly max: number;
    readonly perAddress: ChatRate;
    readonly perAccount: ChatRate;
  };
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly type: 'oidc' | 'oauth2';
  readonly issuer?: string;
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
  readonly userinfoUrl?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: string;
  readonly emailField: string;
  readonly verifiedField: string;
}

export interface Config {
  readonly setup: Setup;
  readonly siteName: string;
  readonly secret: Buffer;
  readonly publicUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly host: string;
  readonly port: number;
  /** Trusted proxies in front, 0 for none (clientIp). */
  readonly proxyHops: number;
  readonly sessionIdleMs: number;
  readonly sessionMaxMs: number;
  readonly sameSite: 'Lax' | 'None';
  readonly sqlitePath: string;
  readonly databaseUrl: string;
  readonly databaseTls: boolean;
  /** AZ_DATABASE_CA_FILE: a PEM root certificate to verify the database against, or '' for the system's. */
  readonly databaseCaFile: string;
  readonly emailFrom: string;
  readonly smtp: { host: string; port: number; user: string; password: string };
  readonly emailApi: { url: string; key: string };
  readonly resetPath: string;
  readonly linkLanding: string;
  readonly providers: readonly Provider[];
  readonly oauthSignup: boolean;
  /** AZ_FILES_DIR: stored images (setup.images only). */
  readonly filesDir: string;
  /** AZ_UPLOAD_MAX_MB in bytes (setup.images only). */
  readonly uploadLimit: number;
  /** The chat settings (setup.chat only); null otherwise. */
  readonly chat: ChatConfig | null;
  /** The map tiles (setup.map only, chat-block-spec §21.4); null otherwise. */
  readonly map: MapConfig | null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why a URL is not acceptable as a server-to-browser address, or null. */
export function urlProblem(value: string, { base }: { base: boolean }): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return 'must use https (plain http only for localhost)';
  }
  if (url.username || url.password) return 'must not carry a user name or password';
  if (url.search || url.hash) return 'must not have ? or #';
  if (base && url.pathname !== '/' && url.pathname !== '') return 'must be an origin/base without a path';
  return null;
}

/** An exact origin, as a browser sends it in `Origin`. */
const originOf = (value: string) => new URL(value).origin;

const isPath = (v: string) => v.startsWith('/') && !v.startsWith('//') && !/[\s\\?#]/.test(v);

/**
 * Read and check the environment. Every problem is collected, so one start
 * names everything missing rather than one key per attempt.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>, setup: Setup, siteName: string):
  { ok: true; config: Config } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const get = (k: string) => (env[k] ?? '').trim();
  for (const k of KEYS) {
    if (k.when(setup) && k.required && !get(k.name)) problems.push(`${k.name} is missing — ${k.about}`);
  }

  const secretText = get('AZ_SESSION_SECRET');
  const secret = Buffer.from(secretText, 'base64url');
  if (secretText && (secret.length < MIN_SECRET_BYTES || !/^[A-Za-z0-9_-]+$/.test(secretText))) {
    problems.push(`AZ_SESSION_SECRET must be at least ${MIN_SECRET_BYTES} random bytes, base64url — run az backend init to generate one`);
  }

  const publicUrl = get('AZ_BACKEND_PUBLIC_URL');
  if (publicUrl) {
    const p = urlProblem(publicUrl, { base: false });
    if (p) problems.push(`AZ_BACKEND_PUBLIC_URL ${p}`);
  }
  const origins = get('AZ_ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of origins) {
    const p = urlProblem(o, { base: true });
    if (p) problems.push(`AZ_ALLOWED_ORIGINS entry '${o}' ${p}`);
  }

  const port = Number(get('AZ_PORT') || '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('AZ_PORT must be a port number');
  const sameSite = (get('AZ_COOKIE_SAMESITE') || 'lax').toLowerCase();
  if (sameSite !== 'lax' && sameSite !== 'none') problems.push('AZ_COOKIE_SAMESITE must be lax or none');
  const trust = (get('AZ_TRUST_PROXY') || 'false').toLowerCase();
  const proxyHops = trust === 'false' ? 0 : trust === 'true' ? 1 : /^\d+$/.test(trust) ? Number(trust) : NaN;
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > MAX_PROXY_HOPS) {
    problems.push(`AZ_TRUST_PROXY must be false, true or a number of proxies (0–${MAX_PROXY_HOPS})`);
  }

  const idleMinutes = Number(get('AZ_SESSION_IDLE_MINUTES') || '1440');
  const maxHours = Number(get('AZ_SESSION_MAX_HOURS') || '336');
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1) problems.push('AZ_SESSION_IDLE_MINUTES must be a whole number of minutes, at least 1');
  if (!Number.isInteger(maxHours) || maxHours < 1) problems.push('AZ_SESSION_MAX_HOURS must be a whole number of hours, at least 1');
  else if (Number.isInteger(idleMinutes) && idleMinutes > maxHours * 60) {
    problems.push('AZ_SESSION_IDLE_MINUTES cannot be longer than AZ_SESSION_MAX_HOURS');
  }

  if (setup.database !== 'sqlite' && get('AZ_DATABASE_URL')) {
    const scheme = setup.database === 'postgres' ? /^postgres(ql)?:\/\//i : /^mysql:\/\//i;
    if (!scheme.test(get('AZ_DATABASE_URL'))) {
      problems.push(`AZ_DATABASE_URL must be a ${setup.database} connection string (${setup.database === 'postgres' ? 'postgres://' : 'mysql://'}…)`);
    }
  }
  const dbTls = (get('AZ_DATABASE_TLS') || '').toLowerCase();
  if (dbTls && dbTls !== 'require' && dbTls !== 'off') problems.push('AZ_DATABASE_TLS must be require or off');
  if (get('AZ_DATABASE_CA_FILE') && dbTls !== 'require') {
    problems.push('AZ_DATABASE_CA_FILE is only used with AZ_DATABASE_TLS=require — set that too');
  }

  const smtpPort = Number(get('AZ_SMTP_PORT') || '0');
  if (setup.email === 'smtp' && get('AZ_SMTP_PORT') && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    problems.push('AZ_SMTP_PORT must be a port number');
  }
  if (setup.email === 'smtp' && Boolean(get('AZ_SMTP_USER')) !== Boolean(get('AZ_SMTP_PASSWORD'))) {
    problems.push('AZ_SMTP_USER and AZ_SMTP_PASSWORD go together — set both or neither');
  }
  if (setup.email === 'api' && get('AZ_EMAIL_API_URL')) {
    const p = urlProblem(get('AZ_EMAIL_API_URL'), { base: false });
    if (p) problems.push(`AZ_EMAIL_API_URL ${p}`);
  }

  const resetPath = get('AZ_RESET_PATH') || '/reset';
  const linkLanding = get('AZ_LINK_LANDING') || '/';
  if (!isPath(resetPath)) problems.push('AZ_RESET_PATH must be a path on the site, starting with one /');
  if (!isPath(linkLanding)) problems.push('AZ_LINK_LANDING must be a path on the site, starting with one /');

  const signup = (get('AZ_OAUTH_SIGNUP') || 'deny').toLowerCase();
  if (signup !== 'allow' && signup !== 'deny') problems.push('AZ_OAUTH_SIGNUP must be allow or deny');

  const providers: Provider[] = [];
  const ids = get('AZ_OAUTH_PROVIDERS').split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!PROVIDER_ID.test(id)) {
      problems.push(`AZ_OAUTH_PROVIDERS: '${id}' is not a provider id (lower-case letters, digits, -)`);
      continue;
    }
    if (providers.some((p) => p.id === id)) {
      problems.push(`AZ_OAUTH_PROVIDERS: '${id}' is listed twice`);
      continue;
    }
    const pk = (s: string) => get(providerKey(id, s));
    const need = (s: string) => {
      if (!pk(s)) problems.push(`${providerKey(id, s)} is missing (provider '${id}')`);
      return pk(s);
    };
    const type = pk('TYPE').toLowerCase();
    if (type !== 'oidc' && type !== 'oauth2') {
      problems.push(`${providerKey(id, 'TYPE')} must be oidc or oauth2 (provider '${id}')`);
      continue;
    }
    const label = need('LABEL');
    if (label.length > LABEL_MAX) problems.push(`${providerKey(id, 'LABEL')} is longer than ${LABEL_MAX} characters`);
    const urlKeys = type === 'oidc' ? ['ISSUER'] : ['AUTHORIZE_URL', 'TOKEN_URL', 'USERINFO_URL'];
    for (const k of urlKeys) {
      const v = need(k);
      const p = v ? urlProblem(v, { base: false }) : null;
      if (p) problems.push(`${providerKey(id, k)} ${p}`);
    }
    const scopes = pk('SCOPES') || (type === 'oidc' ? 'openid email profile' : '');
    if (type === 'oauth2' && !scopes) problems.push(`${providerKey(id, 'SCOPES')} is missing (provider '${id}')`);
    providers.push({
      id, label, type,
      ...(type === 'oidc' ? { issuer: pk('ISSUER') } : {
        authorizeUrl: pk('AUTHORIZE_URL'), tokenUrl: pk('TOKEN_URL'), userinfoUrl: pk('USERINFO_URL'),
      }),
      clientId: need('CLIENT_ID'),
      clientSecret: need('CLIENT_SECRET'),
      scopes,
      emailField: pk('EMAIL_FIELD') || 'email',
      verifiedField: pk('VERIFIED_FIELD') || 'email_verified',
    });
  }

  const uploadMb = Number(get('AZ_UPLOAD_MAX_MB') || String(UPLOAD_MB.default));
  if (setup.images === true && (!Number.isInteger(uploadMb) || uploadMb < 1 || uploadMb > UPLOAD_MB.max)) {
    problems.push(`AZ_UPLOAD_MAX_MB must be a whole number of MB, 1–${UPLOAD_MB.max}`);
  }

  const chat = setup.chat === true ? chatConfig(env, get, publicUrl, problems, setup.map === true) : null;
  const map = setup.chat === true && setup.map === true ? mapConfig(get, problems) : null;

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      setup, siteName, secret,
      publicUrl: publicUrl.replace(/\/+$/, ''),
      allowedOrigins: origins.map(originOf),
      host: get('AZ_HOST') || '127.0.0.1',
      port,
      proxyHops,
      sessionIdleMs: idleMinutes * MINUTE_MS,
      sessionMaxMs: maxHours * 60 * MINUTE_MS,
      sameSite: sameSite === 'none' ? 'None' : 'Lax',
      sqlitePath: get('AZ_SQLITE_PATH') || './data/app.db',
      databaseUrl: get('AZ_DATABASE_URL'),
      databaseTls: dbTls === 'require',
      databaseCaFile: get('AZ_DATABASE_CA_FILE'),
      emailFrom: get('AZ_EMAIL_FROM'),
      smtp: { host: get('AZ_SMTP_HOST'), port: smtpPort, user: get('AZ_SMTP_USER'), password: get('AZ_SMTP_PASSWORD') },
      emailApi: { url: get('AZ_EMAIL_API_URL'), key: get('AZ_EMAIL_API_KEY') },
      resetPath, linkLanding,
      providers,
      oauthSignup: signup === 'allow',
      filesDir: get('AZ_FILES_DIR') || './data/files',
      uploadLimit: uploadMb * 1024 * 1024,
      chat,
      map,
    },
  };
}

/** A whole number from `key` within `bounds`, its default when unset; a problem named otherwise. */
function bounded(get: (k: string) => string, key: string, bounds: { default: number; min: number; max: number }, problems: string[]): number {
  const raw = get(key);
  const n = raw === '' ? bounds.default : /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
    problems.push(`${key} must be a whole number, ${bounds.min}–${bounds.max}`);
  }
  return n;
}

/** Is a URL's host this machine? The `fake` model is for development only, which is a loopback server. */
function onLoopback(value: string): boolean {
  try {
    return LOOPBACK.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** A path as .env gives it: one line, no NUL; its file is opened when the server starts (main.ts), named if it cannot be. */
const pathOk = (v: string) => v.length <= 4096 && !/[\u0000-\u001f]/.test(v);

/** The map keys (chat-block-spec §21.4.3), every problem named — never a value quoted. */
function mapConfig(get: (k: string) => string, problems: string[]): MapConfig {
  const path = (key: string): string | null => {
    const v = get(key);
    if (v === '') return null;
    if (!pathOk(v)) { problems.push(`${key} must be a path on one line`); return null; }
    return v;
  };
  const world = path('AZ_MAP_WORLD');
  const region = path('AZ_MAP_REGION');
  const glyphs = path('AZ_MAP_GLYPHS');
  const sprites = path('AZ_MAP_SPRITES');
  const attribution = get('AZ_MAP_ATTRIBUTION');
  if (region !== null && world === null) problems.push('AZ_MAP_REGION is drawn over the world archive — set AZ_MAP_WORLD too');
  if ((glyphs !== null || sprites !== null) && world === null) problems.push('AZ_MAP_GLYPHS and AZ_MAP_SPRITES draw on the world archive — set AZ_MAP_WORLD too');
  if (world !== null && attribution === '') problems.push('AZ_MAP_ATTRIBUTION is missing — the tile data\'s licence requires its attribution under every map');
  else if (attribution !== '' && !plainText(attribution, MAP_KEYS_LIMITS.attribution)) problems.push(`AZ_MAP_ATTRIBUTION must be one line of at most ${MAP_KEYS_LIMITS.attribution} characters`);
  return { world, region, glyphs, sprites, attribution };
}

/**
 * AZ_GEOCODER_URL (chat-block-spec §21.4.2): https, or plain http only on
 * this machine; no user name, password or #; a query is kept (the operator's
 * own parameters), but not one named `q`, which the server sets.
 */
function geocoderUrlProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return 'must use https (plain http only for localhost)';
  if (u.username || u.password) return 'must not carry a user name or password';
  if (u.hash || value.includes('#')) return 'must not have a #';
  if (u.searchParams.has('q')) return 'must not set q — the server sends the address as q';
  return null;
}

/** The chat keys (chat-block-spec §11.1), every problem named. */
function chatConfig(env: Readonly<Record<string, string | undefined>>, get: (k: string) => string, publicUrl: string, problems: string[], map = false): ChatConfig {
  const api = get('AZ_CHAT_API').toLowerCase();
  if (api && api !== 'completions' && api !== 'fake') problems.push('AZ_CHAT_API must be completions or fake');
  const url = get('AZ_CHAT_URL');
  const model = get('AZ_CHAT_MODEL');
  const fakeFile = get('AZ_CHAT_FAKE_FILE');
  if (api === 'completions') {
    if (!url) problems.push('AZ_CHAT_URL is missing — the model API\'s base URL (required for completions)');
    else {
      const p = urlProblem(url, { base: false });
      if (p) problems.push(`AZ_CHAT_URL ${p}`);
    }
    if (!model) problems.push('AZ_CHAT_MODEL is missing — the model id (required for completions)');
    // A model id is one line of printable text.
    else if (model.length > CHAT_LIMITS.modelMax || /[\u0000-\u001f\u007f]/.test(model)) {
      problems.push(`AZ_CHAT_MODEL must be at most ${CHAT_LIMITS.modelMax} characters, without control characters`);
    }
    if (fakeFile) problems.push('AZ_CHAT_FAKE_FILE is only read with AZ_CHAT_API=fake — remove it');
  }
  if (api === 'fake') {
    if (!fakeFile) problems.push('AZ_CHAT_FAKE_FILE is missing — AZ_CHAT_API=fake replays scripted answers from it');
    if (publicUrl && !onLoopback(publicUrl)) {
      problems.push('AZ_CHAT_API=fake is for development only — it needs AZ_BACKEND_PUBLIC_URL on localhost; use completions for a real model');
    }
  }
  const rate = (key: string, fallback: string): ChatRate => {
    const parsed = parseRate(get(key) || fallback);
    if (!parsed) {
      problems.push(`${key} must be <n>/hour, <n>/day or both, comma-separated (e.g. ${fallback})`);
      return parseRate(fallback)!;
    }
    return parsed;
  };
  const enabled = (get('AZ_CHAT_ENABLED') || 'on').toLowerCase();
  if (enabled !== 'on' && enabled !== 'off') problems.push('AZ_CHAT_ENABLED must be on or off');
  const shares = (get('AZ_CHAT_SHARES') || 'on').toLowerCase();
  if (shares !== 'on' && shares !== 'off') problems.push('AZ_CHAT_SHARES must be on or off');
  const moderationUrl = get('AZ_CHAT_MODERATION_URL');
  const moderationKey = get('AZ_CHAT_MODERATION_KEY');
  if (moderationUrl) {
    const p = urlProblem(moderationUrl, { base: false });
    if (p) problems.push(`AZ_CHAT_MODERATION_URL ${p}`);
  } else if (moderationKey) {
    problems.push('AZ_CHAT_MODERATION_KEY is only sent to AZ_CHAT_MODERATION_URL — set that too, or remove the key');
  }
  return {
    api: api === 'fake' ? 'fake' : 'completions',
    url: url.replace(/\/+$/, ''),
    key: get('AZ_CHAT_KEY'),
    model,
    dailyTokens: bounded(get, 'AZ_CHAT_DAILY_TOKENS', CHAT_LIMITS.dailyTokens, problems),
    maxOutputTokens: bounded(get, 'AZ_CHAT_MAX_OUTPUT_TOKENS', CHAT_LIMITS.maxOutputTokens, problems),
    perAddress: rate('AZ_CHAT_PER_ADDRESS', CHAT_LIMITS.perAddress),
    perAccount: rate('AZ_CHAT_PER_ACCOUNT', CHAT_LIMITS.perAccount),
    concurrency: bounded(get, 'AZ_CHAT_CONCURRENCY', CHAT_LIMITS.concurrency, problems),
    timeoutMs: bounded(get, 'AZ_CHAT_TIMEOUT_SECONDS', CHAT_LIMITS.timeoutSeconds, problems) * 1000,
    enabled: enabled !== 'off',
    fakeFile,
    moderation: moderationUrl ? { url: moderationUrl, key: moderationKey } : null,
    tools: chatTools(env, get, problems),
    toolCallsPerAddress: rate('AZ_CHAT_TOOL_CALLS_PER_ADDRESS', TOOL_LIMITS.callsPerAddress),
    geocoder: map ? geocoderOf(get, rate, problems) : null,
    shares: {
      enabled: shares !== 'off',
      days: bounded(get, 'AZ_CHAT_SHARE_DAYS', CHAT_LIMITS.shareDays, problems),
      max: bounded(get, 'AZ_CHAT_SHARE_MAX', CHAT_LIMITS.shareMax, problems),
      perAddress: rate('AZ_CHAT_SHARES_PER_ADDRESS', CHAT_LIMITS.sharesPerAddress),
      perAccount: rate('AZ_CHAT_SHARES_PER_ACCOUNT', CHAT_LIMITS.sharesPerAccount),
    },
  };
}

/** The geocoder's keys, when a chat shows maps (§21.4.2): null without AZ_GEOCODER_URL. */
function geocoderOf(get: (k: string) => string, rate: (key: string, fallback: string) => ChatRate, problems: string[]): GeocoderConfig | null {
  const url = get('AZ_GEOCODER_URL');
  const perAddress = rate('AZ_GEOCODER_PER_ADDRESS', MAP_KEYS_LIMITS.geocoderPerAddress);
  if (url === '') return null;
  const p = geocoderUrlProblem(url);
  if (p) problems.push(`AZ_GEOCODER_URL ${p}`);
  return { url, perAddress };
}
