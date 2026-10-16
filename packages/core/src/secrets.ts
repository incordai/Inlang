/**
 * @az module secrets
 * Purpose: secret detection for env, bundles and literals — never prints a value.
 * Spec: docs/auth-block-spec.md §4 · docs/word-quality-gate.md §4
 * Exports: scanText, scanEnv, redact, envMessage, bundleMessage, ownNames, siteScanner, ShippedPlace
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
 * build instead of shipping a credential to every visitor. Nothing about
 * chat is public either (chat-block-spec §6.4): the page reaches it through
 * the backend's URL, so `AZ_PUBLIC_CHAT_KEY` is refused by name — a generic
 * `KEY` cannot be, since `AZ_PUBLIC_AUTH_KEY` is public by design.
 */
const PRIVATE_NAME = /SERVICE|SECRET|PRIVATE|PASSWORD|PASSWD|DATABASE_URL|SMTP|EMAIL_API_KEY|CHAT/i;

/** JWT roles that bypass row-level security — a service key, not a public one. */
const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['service_role', 'service', 'admin']);

/** Shortest run the high-entropy rule considers, its padding counted; shorter strings are ids, not keys. */
const ENTROPY_MIN_LENGTH = 32;
/** Bits per character above which a mixed letter-and-digit run reads as a key. */
const ENTROPY_MIN_BITS = 4.0;
/**
 * Shortest value judged when its name says it is a credential (`api_key=…`,
 * a query string, a config line, a cookie): the name is the evidence a bare
 * run lacks, so a shorter value is read.
 */
const NAMED_MIN_LENGTH = 16;
/**
 * Bits per character a named value needs. A random 16-character key of
 * letters and digits measures 3.2 or more in 999 of 1 000 draws; a repeated
 * or counted value (`abc123abc123abc123`, 2.6) does not reach it.
 */
const NAMED_MIN_BITS = 3.0;
/**
 * A named value of hex digits in one case. Hex carries 4 bits per character
 * at most, so the floor above misses random hex keys: of 10 000 random ones
 * a length, 14% of 16-character, 3% of 20 and 0.5% of 24 measure under 3.0
 * bits. A named hex value is judged by hex's own measure instead.
 */
const HEX_VALUE = /^(?:[0-9a-f]+|[0-9A-F]+)$/;
/** Hex this long set to a credential's name is a key whatever its entropy. */
const HEX_KEY_LENGTH = 24;
/**
 * Bits per character a named hex value of 16 to 23 characters needs, by
 * length from 16: the 0.5th percentile of 10 000 random hex values of that
 * length, rounded down to 0.05. Measured 2.608, 2.660, 2.732, 2.774, 2.839,
 * 2.879, 2.932, 2.947 (medians 3.20 at 16 to 3.46 at 23); a fresh 10 000 a
 * length were then found 99.49% to 99.81%. A few digits repeated
 * (`00000000deadbeef`, 2.08) do not reach it.
 */
const HEX_MIN_BITS: readonly number[] = [2.6, 2.65, 2.7, 2.75, 2.8, 2.85, 2.9, 2.9];
/**
 * The share of neighbouring digits one apart (`0123…`, `fedc…`) from which a
 * hex value is counted, not random: each step of random hex is one apart
 * with odds 1 in 8, and 10 000 random 16-character values reach 0.53 at most.
 */
const HEX_COUNTED_SHARE = 0.75;

export interface SecretFinding {
  /**
   * Which rule matched: `pem`, `secret-prefix`, `service-role`, `jwt-privileged`, `entropy` (a long random run,
   * or a shorter one a credential's name is set to), `private-name`.
   */
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

/** A token's characters: the base64url alphabet. */
const isTokenChar = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
/** The fewest characters each of a JWT's three parts is taken to have. */
const JWT_PART_MIN = 8;
/** How a JWT starts: its JSON header, `{"…`, in base64url. */
const JWT_HEADER = 'eyJ';

/** The end of the run of token characters that starts at `at`. */
function runEnd(text: string, at: number): number {
  let i = at;
  while (i < text.length && isTokenChar(text.charCodeAt(i))) i++;
  return i;
}

/**
 * Every JWT-shaped token in a text, left to right: `eyJ`, then three dot-
 * separated runs of at least JWT_PART_MIN token characters — the first
 * counted after `eyJ` — each run taken whole. A regular expression of that
 * shape restarts at every `eyJ` of a long run and reads it to its end each
 * time (quadratic: 40 000 `eyJ` took 9s); this reads each run at most three
 * times. A run with no part long enough after its first `eyJ` holds none
 * further on either, since every later start leaves less of it.
 */
function jwts(text: string): { readonly at: number; readonly value: string }[] {
  const out: { at: number; value: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isTokenChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const end = runEnd(text, i);
    const head = text.slice(i, end).indexOf(JWT_HEADER);
    const at = i + head;
    i = end;
    if (head < 0 || end - (at + JWT_HEADER.length) < JWT_PART_MIN || text[end] !== '.') continue;
    const second = runEnd(text, end + 1);
    if (second - (end + 1) < JWT_PART_MIN || text[second] !== '.') continue;
    const third = runEnd(text, second + 1);
    if (third - (second + 1) < JWT_PART_MIN) continue;
    out.push({ at, value: text.slice(at, third) });
    i = third;
  }
  return out;
}

const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
/**
 * A secret key's prefix: `sk_` or `rk_`, then its mode and the key. With a
 * mode (`sk_live_…`, `rk_test_…`) the shape is distinctive wherever it
 * starts — inside a longer name (`xsk_live_…`) too — and real keys of it
 * carry at least 10 characters after the mode. Without one, `sk_` must start
 * a name or follow `_` (`api_sk_…`), never sit inside a word (`task_list`),
 * and the key must be 16 characters or more.
 */
const SECRET_PREFIX = /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|(?<![A-Za-z0-9])(?:sk|rk)_[A-Za-z0-9]{16,}/g;
const SERVICE_ROLE = /\bservice_role\b/g;
/** The base64 and base64url alphabets: what a key's run is made of. */
const RUN = 'A-Za-z0-9+/_-';
/**
 * A key-shaped run: the alphabets, then `=` only as a trailing pad — one or
 * two, and only where no run character follows it. A key never holds `=`
 * inside it, so `NAME=value` in code is two runs, each judged by itself; a
 * pad is part of its key's length, so 30 characters and `==` (22 bytes in
 * base64) reach the rule's floor. Read in one pass: a pad that is not one is
 * left off without going back into the run.
 */
const HIGH_ENTROPY = new RegExp(`[${RUN}]{30,}(?:={1,2}(?![=${RUN}]))?`, 'g');
/** The same run, read only where it starts at the beginning of a text. */
const LEADING_RUN = new RegExp(HIGH_ENTROPY.source, 'y');
/**
 * A value set to a name that says credential, where a query string, a
 * config line or a cookie writes one: the name starts the text or follows
 * `?`, `&`, `#`, `;`, whitespace or a quote. The name is a whole word (its
 * test is the caller's: CREDENTIAL_NAME), so the read never backtracks into
 * it; the value is a run of the key alphabets with its pad, possibly empty.
 */
const NAMED_VALUE = new RegExp(`(?:^|[?&#;\\s"'\`])(\\w+)=([${RUN}]*(?:={1,2}(?![=${RUN}]))?)`, 'g');
/** A name that says its value is a credential. */
const CREDENTIAL_NAME = /key|token|secret|sig|signature|password|passwd|auth/i;

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
  for (const { at, value } of jwts(text)) {
    jwtSpans.push([at, at + value.length]);
    if (privilegedJwt(value)) add('jwt-privileged', at, value);
  }

  // Both lists run left to right and spans never overlap, so one cursor
  // walks the spans once instead of searching them for every run.
  let span = 0;
  const judged = new Set<number>();
  for (const m of text.matchAll(HIGH_ENTROPY)) {
    const value = m[0];
    const at = m.index ?? 0;
    while (span < jwtSpans.length && jwtSpans[span][1] <= at) span++;
    if (span < jwtSpans.length && jwtSpans[span][0] <= at) continue;
    // A property access (`gl.framebufferTexture2DMultisampleEXT`) is a name in
    // code, not a value. Identifier characters only, so a token inside a URL
    // path — which has a `/` — is still judged.
    if (text[at - 1] === '.' && IDENTIFIER.test(value)) continue;
    if (EXTENSION_NAME.test(value)) continue;
    if (keyLike(text, at, value, allow, ENTROPY_MIN_LENGTH, runIsDense)) {
      judged.add(at);
      add('entropy', at, value);
    }
  }
  // A shorter value a credential's name is set to (`?api_key=…`): the name is
  // the evidence. A value the run rule above already reported is not repeated.
  span = 0;
  for (const m of text.matchAll(NAMED_VALUE)) {
    const value = m[2];
    const at = (m.index ?? 0) + m[0].length - value.length;
    if (!CREDENTIAL_NAME.test(m[1]) || judged.has(at)) continue;
    while (span < jwtSpans.length && jwtSpans[span][1] <= at) span++;
    if (span < jwtSpans.length && jwtSpans[span][0] <= at) continue;
    if (keyLike(text, at, value, allow, NAMED_MIN_LENGTH, namedIsDense)) add('entropy', at, value);
  }
  return found;
}

/**
 * A path segment that cannot be a key: all digits (an issue number), or
 * lowercase letters and hyphens (`issues`, `project-gl-js`) — empty between
 * two slashes too. Anything else, mixed-case letters included, is judged.
 */
const PLAIN_SEGMENT = /^(?:[0-9]*|[a-z][a-z-]*)$/;

/**
 * A key-shaped run with no name before it: ENTROPY_MIN_BITS per character.
 * Hex, 4 bits a character at most, does not reach it (no one of 10 000
 * random 32-, 40- or 64-character values did), so a bare content hash passes.
 */
const runIsDense = (value: string) => entropy(value) >= ENTROPY_MIN_BITS;

/**
 * A value a credential's name is set to: hex by hex's own measure — not a
 * unit repeated, not counted, then a key from HEX_KEY_LENGTH characters or
 * by HEX_MIN_BITS below it — and anything else by NAMED_MIN_BITS.
 */
function namedIsDense(value: string): boolean {
  if (!HEX_VALUE.test(value)) return entropy(value) >= NAMED_MIN_BITS;
  if (repeats(value) || counted(value)) return false;
  return value.length >= HEX_KEY_LENGTH || entropy(value) >= HEX_MIN_BITS[value.length - NAMED_MIN_LENGTH];
}

/**
 * A shorter unit repeated (`deadbeefdeadbeef`, `a1a1…`, a partial last copy
 * too): the value's shortest period is half its length or less. Read in one
 * pass by the prefix function, so a long value costs its length.
 */
function repeats(value: string): boolean {
  const border: number[] = new Array<number>(value.length).fill(0);
  for (let i = 1; i < value.length; i++) {
    let k = border[i - 1];
    while (k > 0 && value[i] !== value[k]) k = border[k - 1];
    border[i] = value[i] === value[k] ? k + 1 : k;
  }
  return value.length - border[value.length - 1] <= value.length / 2;
}

/** Hex digits counted up or down (`0123456789abcdef`): HEX_COUNTED_SHARE of neighbours one apart. */
function counted(value: string): boolean {
  let steps = 0;
  for (let i = 1; i < value.length; i++) {
    const d = (parseInt(value[i], 16) - parseInt(value[i - 1], 16) + 16) % 16;
    if (d === 1 || d === 15) steps++;
  }
  return steps >= HEX_COUNTED_SHARE * (value.length - 1);
}

/**
 * Whether a value found at `at` in `text` reads as a key: at least
 * `minLength` characters, its pad counted, mixing letters and digits, and
 * dense enough by `dense` — unless it is a public value (`allow`), inlined
 * data, or a path of plain words.
 */
function keyLike(
  text: string, at: number, value: string, allow: ReadonlySet<string>, minLength: number, dense: (value: string) => boolean,
): boolean {
  if (value.length < minLength || allow.has(value)) return false;
  // Inlined assets are base64 by design (a small image in a data: URL).
  if (/(?:data:[^,]{0,64},|base64,)$/.test(text.slice(Math.max(0, at - 72), at))) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  // A path of plain words (`com/org/project/issues/2907`, a link in a library's message). A key in a path is a
  // segment that is not plain, and the whole path is then judged.
  if (value.includes('/') && value.split('/').every((s) => PLAIN_SEGMENT.test(s))) return false;
  return dense(value);
}

/**
 * The names the build's own files go by in its text — the values `allow`
 * takes so that a chunk naming a file the bundler emitted (`/assets/x-Ab12cD34.mjs`,
 * its content hash and all) is not judged as a key. `emitted` is what the
 * bundler wrote, paths relative to the output folder: never a file copied
 * from `public/`, whose name the author chose. Only the run each name starts
 * with, as a reference to the file reads it — the path, the path after `/`,
 * the file name, the file name after `/`; a run anywhere else in a name is
 * judged wherever it appears.
 */
export function ownNames(emitted: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of emitted) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    for (const form of [p, `/${p}`, base, `/${base}`]) {
      LEADING_RUN.lastIndex = 0;
      const run = LEADING_RUN.exec(form);
      if (run !== null) out.add(run[0]);
    }
  }
  return [...out];
}

/**
 * The one scan every reader of a built site runs — the build guard, the
 * page scan after the pre-render, and `az audit` — so their rules cannot
 * drift: the public values the build inlined and the names of the files the
 * bundler emitted are allowed everywhere, and in each text the digests its
 * own policy pins for what it carries (`pinned`, csp.ts ownDigests: derived
 * from that text, so a digest is allowed only where it hashes something the
 * text holds). A public value is allowed whole and by each part the scan
 * would judge alone — its key-shaped runs and its named values — so a public
 * URL that carries its own public key (`…?key=…`) ships as it is meant to.
 * Everything else is judged by scanText.
 */
export function siteScanner(
  publicValues: Iterable<string>, emitted: readonly string[], pinned: (text: string) => readonly string[],
): (text: string) => SecretFinding[] {
  const parts: string[] = [];
  for (const v of publicValues) {
    parts.push(v);
    for (const m of v.matchAll(HIGH_ENTROPY)) parts.push(m[0]);
    for (const m of v.matchAll(NAMED_VALUE)) parts.push(m[2]);
  }
  const allowed = new Set([...parts, ...ownNames(emitted)]);
  return (text) => {
    const own = pinned(text);
    return scanText(text, own.length > 0 ? new Set([...allowed, ...own]) : allowed);
  };
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
