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

/** Every key the server reads, in the order `.env.example` lists them. */
export const KEYS: readonly KeySpec[] = [
  { name: 'AZ_SESSION_SECRET', about: 'Random, at least 32 bytes. Keys every stored token digest. `az backend init` generates one; never reuse it between deployments.', when: always, required: true, secret: true },
  { name: 'AZ_BACKEND_PUBLIC_URL', about: 'This server\'s own public base URL (https; http only for localhost). Used in emailed links and provider callbacks.', when: always, required: true, example: 'http://localhost:8787' },
  { name: 'AZ_ALLOWED_ORIGINS', about: 'The site origin(s) allowed to call this server, comma-separated, exact (https://www.example.org). Also the only places a sign-in may redirect to.', when: always, required: true, example: 'http://localhost:5173' },
  { name: 'AZ_HOST', about: 'Interface to listen on. 127.0.0.1 behind a reverse proxy; 0.0.0.0 in a container.', when: always, required: false, example: '127.0.0.1' },
  { name: 'AZ_PORT', about: 'Port to listen on.', when: always, required: false, example: '8787' },
  { name: 'AZ_TRUST_PROXY', about: '`true` only when a reverse proxy you control sets X-Forwarded-For; rate limits then use its first address.', when: always, required: false, example: 'false' },
  { name: 'AZ_COOKIE_SAMESITE', about: '`lax` when the site and this server share a site (recommended), `none` when they do not.', when: always, required: false, example: 'lax' },
  { name: 'AZ_SQLITE_PATH', about: 'SQLite database file. Created on first start.', when: (s) => s.database === 'sqlite', required: false, example: './data/app.db' },
  { name: 'AZ_DATABASE_URL', about: 'Database connection string, e.g. postgres://user:password@host:5432/db or mysql://user:password@host:3306/db.', when: (s) => s.database !== 'sqlite', required: true, secret: true },
  { name: 'AZ_DATABASE_TLS', about: '`require` to insist on an encrypted database connection (recommended off-host).', when: (s) => s.database !== 'sqlite', required: false, example: 'require' },
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

export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const LABEL_MAX = 40;
const MIN_SECRET_BYTES = 32;

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
  readonly trustProxy: boolean;
  readonly sameSite: 'Lax' | 'None';
  readonly sqlitePath: string;
  readonly databaseUrl: string;
  readonly databaseTls: boolean;
  readonly emailFrom: string;
  readonly smtp: { host: string; port: number; user: string; password: string };
  readonly emailApi: { url: string; key: string };
  readonly resetPath: string;
  readonly linkLanding: string;
  readonly providers: readonly Provider[];
  readonly oauthSignup: boolean;
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
  if (trust !== 'true' && trust !== 'false') problems.push('AZ_TRUST_PROXY must be true or false');

  if (setup.database !== 'sqlite' && get('AZ_DATABASE_URL')) {
    const scheme = setup.database === 'postgres' ? /^postgres(ql)?:\/\//i : /^mysql:\/\//i;
    if (!scheme.test(get('AZ_DATABASE_URL'))) {
      problems.push(`AZ_DATABASE_URL must be a ${setup.database} connection string (${setup.database === 'postgres' ? 'postgres://' : 'mysql://'}…)`);
    }
  }
  const dbTls = (get('AZ_DATABASE_TLS') || '').toLowerCase();
  if (dbTls && dbTls !== 'require' && dbTls !== 'off') problems.push('AZ_DATABASE_TLS must be require or off');

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

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      setup, siteName, secret,
      publicUrl: publicUrl.replace(/\/+$/, ''),
      allowedOrigins: origins.map(originOf),
      host: get('AZ_HOST') || '127.0.0.1',
      port,
      trustProxy: trust === 'true',
      sameSite: sameSite === 'none' ? 'None' : 'Lax',
      sqlitePath: get('AZ_SQLITE_PATH') || './data/app.db',
      databaseUrl: get('AZ_DATABASE_URL'),
      databaseTls: dbTls === 'require',
      emailFrom: get('AZ_EMAIL_FROM'),
      smtp: { host: get('AZ_SMTP_HOST'), port: smtpPort, user: get('AZ_SMTP_USER'), password: get('AZ_SMTP_PASSWORD') },
      emailApi: { url: get('AZ_EMAIL_API_URL'), key: get('AZ_EMAIL_API_KEY') },
      resetPath, linkLanding,
      providers,
      oauthSignup: signup === 'allow',
    },
  };
}
