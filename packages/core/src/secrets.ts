/**
 * @az module secrets
 * Purpose: secret detection for env, bundles and literals — never prints a value.
 * Spec: docs/auth-block-spec.md §4 · docs/word-quality-gate.md §4
 * Exports: scanText, scanEnv, redact, envMessage, bundleMessage, ShippedPlace
 * Edit guide: patterns stay vendor-neutral; findings report name/offset and length only.
 * Tests: packages/core/test/secrets.test.ts, packages/cli/test/secrets.test.ts
 */

/**
 * Secret detection — auth-block-spec §4, word-quality-gate §4.
 *
 * A static bundler inlines public environment variables into the shipped
 * JavaScript, so a service key put in the wrong variable is readable by
 * anyone who opens dev tools. Three places look for one, all with these
 * patterns: the compiler (a key written into the .az file, AZ1411), the CLI
 * before it writes a project (the environment the build will inline), and
 * the generated project's build (the environment again, then the bundle).
 *
 * Pure and dependency-free on purpose: the CLI copies this file verbatim into
 * every generated project, where the build's guard plugin imports it. The
 * patterns are generic shapes, never a provider's name (CONVENTIONS §5).
 *
 * These checks are unsuppressible (auth-spec §11): nothing here reads a flag.
 */

/** The prefix a generated project exposes to the browser. Nothing else is inlined. */
export const PUBLIC_ENV_PREFIX = 'AZ_PUBLIC_';

/**
 * Variable names that say "this is not public" whatever their value is —
 * including the built-in backend's server-only settings (backend-spec §4),
 * so `AZ_PUBLIC_SMTP_PASSWORD` or `AZ_PUBLIC_DATABASE_URL` fails the site's
 * build instead of shipping a credential to every visitor.
 */
const PRIVATE_NAME = /SERVICE|SECRET|PRIVATE|PASSWORD|PASSWD|DATABASE_URL|SMTP|EMAIL_API_KEY/i;

/** JWT roles that bypass row-level security — a service key, not a public one. */
const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['service_role', 'service', 'admin']);

/** Shortest run the high-entropy rule considers; shorter strings are ids, not keys. */
const ENTROPY_MIN_LENGTH = 32;
/** Bits per character above which a mixed letter-and-digit run reads as a key. */
const ENTROPY_MIN_BITS = 4.0;

export interface SecretFinding {
  /** Which rule matched: `pem`, `secret-prefix`, `service-role`, `jwt-privileged`, `entropy`, `private-name`. */
  readonly rule: string;
  /** Where: an environment variable's name, or `@offset` in a text. */
  readonly where: string;
  /** A redacted excerpt — the finding must never print the secret it found. */
  readonly excerpt: string;
}

/**
 * No character of the value — build logs can be public, and even a prefix
 * narrows a key. The variable name or the file offset identifies it.
 */
export function redact(value: string): string {
  return `[redacted, ${value.length} chars]`;
}

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A JWT's payload, or null when the value is not one. */
function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const payload: unknown = JSON.parse(json);
    return payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A JWT whose role claim grants more than a public client should have. */
function privilegedJwt(token: string): boolean {
  const payload = jwtPayload(token);
  const role = payload?.role;
  return typeof role === 'string' && PRIVILEGED_ROLES.has(role.toLowerCase());
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const SECRET_PREFIX = /\b(?:sk|rk)_(?:live|test)?_?[A-Za-z0-9]{16,}/g;
const SERVICE_ROLE = /\bservice_role\b/g;
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{32,}/g;

/** A whole JS identifier — a name in code, which can never carry a value. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A graphics-API extension name as the Khronos registry spells it:
 * `WEBGL_compressed_texture_s3tc_srgb`, `KHR_materials_clearcoat`. A registry
 * prefix, then lowercase words — the shape of a public name, not of a key.
 */
const EXTENSION_NAME = /^(?:WEBGL|EXT|OES|KHR|ANGLE|OVR|ARB|NV|AMD|MOZ|WEBKIT)_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Secrets in a piece of text — a bundle, a source file, a value.
 *
 * `allow` lists values that are public by design (the site's own public
 * key, which must reach the browser), so the entropy rule does not fail a
 * build for shipping exactly what it should.
 */
export function scanText(text: string, allow: ReadonlySet<string> = new Set()): SecretFinding[] {
  const found: SecretFinding[] = [];
  const add = (rule: string, index: number, value: string) =>
    found.push({ rule, where: `@${index}`, excerpt: redact(value) });

  for (const m of text.matchAll(PEM)) add('pem', m.index ?? 0, m[0]);
  for (const m of text.matchAll(SECRET_PREFIX)) add('secret-prefix', m.index ?? 0, m[0]);
  for (const m of text.matchAll(SERVICE_ROLE)) add('service-role', m.index ?? 0, m[0]);

  const jwtSpans: [number, number][] = [];
  for (const m of text.matchAll(JWT)) {
    const at = m.index ?? 0;
    jwtSpans.push([at, at + m[0].length]);
    if (privilegedJwt(m[0])) add('jwt-privileged', at, m[0]);
  }

  for (const m of text.matchAll(HIGH_ENTROPY)) {
    const value = m[0];
    const at = m.index ?? 0;
    if (allow.has(value)) continue;
    // A JWT is judged by its role above; its parts are not separate keys.
    if (jwtSpans.some(([a, b]) => at >= a && at < b)) continue;
    // Inlined assets are base64 by design (a small image in a data: URL).
    if (/(?:data:[^,]{0,64},|base64,)$/.test(text.slice(Math.max(0, at - 72), at))) continue;
    if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) continue;
    // A property access (`gl.framebufferTexture2DMultisampleEXT`) is a name in
    // code, not a value. Identifier characters only, so a token inside a URL
    // path — which has a `/` — is still judged.
    if (text[at - 1] === '.' && IDENTIFIER.test(value)) continue;
    if (EXTENSION_NAME.test(value)) continue;
    if (value.length >= ENTROPY_MIN_LENGTH && entropy(value) >= ENTROPY_MIN_BITS) add('entropy', at, value);
  }
  return found;
}

/**
 * Secrets in the environment a build will inline.
 *
 * Only variables with the public prefix reach the browser, so only they are
 * judged — but every one of them is judged by name AND value: a variable
 * called AZ_PUBLIC_SERVICE_KEY is a service key someone is about to ship,
 * whatever it holds.
 */
export function scanEnv(env: Readonly<Record<string, string | undefined>>, prefix = PUBLIC_ENV_PREFIX): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!name.startsWith(prefix) || value === undefined) continue;
    if (PRIVATE_NAME.test(name.slice(prefix.length))) {
      found.push({ rule: 'private-name', where: name, excerpt: redact(value) });
      continue;
    }
    for (const f of scanText(value)) {
      // A public key is high-entropy by nature; only the shape rules apply here.
      if (f.rule === 'entropy') continue;
      found.push({ ...f, where: name });
    }
  }
  return found;
}

/** A value written into source that is shaped like a credential (AZ1411). */
export function isSecretLiteral(value: string): boolean {
  return scanText(value).length > 0 || jwtPayload(value) !== null;
}

/**
 * A value as a diagnostic may quote it: a credential-shaped value is never
 * repeated (it would land in terminals, CI logs and tool results), only its
 * length — the rule AZ1411 follows, applied to every message that echoes.
 */
export function quotable(value: string): string {
  return isSecretLiteral(value) ? `<a secret-looking value, ${value.length} characters>` : value;
}

/** auth-spec §11's messages, for the two unsuppressible errors. */
export function envMessage(f: SecretFinding): string {
  return `auth: '${f.where}' is a service key and would be readable in the shipped bundle — `
    + `use the public key here and keep the service key on your server (${f.rule}, ${f.excerpt})`;
}

/**
 * Where in a built site the build guard found a key: what Vite bundled, a
 * file it copied from `public/`, any other file in the output folder, or a
 * page the pre-render filled. Named in the message, so the author looks in
 * the right place.
 */
export type ShippedPlace = 'bundle' | 'public' | 'output' | 'page';

const PLACES: Readonly<Record<ShippedPlace, string>> = {
  bundle: 'the built bundle',
  public: 'a file copied from public/',
  output: 'a file in the output folder',
  page: 'a pre-rendered page',
};

export function bundleMessage(file: string, f: SecretFinding, place: ShippedPlace): string {
  return `auth: a service-key pattern was found in ${PLACES[place]} — remove it from source and rebuild `
    + `(${file}${f.where}, ${f.rule}, ${f.excerpt})`;
}
