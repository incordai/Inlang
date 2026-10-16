/**
 * scanText's rules written the plain way, as the oracle the equivalence test
 * compares the scanner against: the JWT rule as its old regular expression
 * with every span searched per run (legacy-secrets.ts), the key-shaped run
 * cut out of the text by hand, and a credential's named value read by one
 * regular expression that backtracks freely, a hex value's period found by
 * trying every one. Slow on long inputs by design;
 * only the tests use it.
 */

import { entropy, redact, type SecretFinding } from '../src/secrets.ts';

const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['service_role', 'service', 'admin']);

function privilegedJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    const role = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>).role : undefined;
    return typeof role === 'string' && PRIVILEGED_ROLES.has(role.toLowerCase());
  } catch {
    return false;
  }
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const SECRET_PREFIX = /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|(?<![A-Za-z0-9])(?:sk|rk)_[A-Za-z0-9]{16,}/g;
const SERVICE_ROLE = /\bservice_role\b/g;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EXTENSION_NAME = /^(?:WEBGL|EXT|OES|KHR|ANGLE|OVR|ARB|NV|AMD|MOZ|WEBKIT)_[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** The named value, as the review that asked for it wrote it: the credential word anywhere in the name. */
const NAMED = /(?:^|[?&#;\s"'`])(\w*(?:key|token|secret|sig|signature|password|passwd|auth)\w*)=([A-Za-z0-9+/_-]*)/gi;

const isRunChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9+/_-]/.test(ch);

/** Every maximal run of the key alphabets of 30 or more characters, with a pad of one or two `=` that nothing follows. */
function runs(text: string): { at: number; value: string }[] {
  const out: { at: number; value: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isRunChar(text[i])) {
      i++;
      continue;
    }
    let end = i;
    while (isRunChar(text[end])) end++;
    if (end - i >= 30) {
      let pads = 0;
      while (text[end + pads] === '=') pads++;
      const padded = (pads === 1 || pads === 2) && !isRunChar(text[end + pads]);
      out.push({ at: i, value: text.slice(i, padded ? end + pads : end) });
      if (padded) end += pads;
    }
    i = end;
  }
  return out;
}

/** The pad a named value ends with: one or two `=` that no run character or `=` follows. */
function withPad(text: string, end: number): number {
  let pads = 0;
  while (text[end + pads] === '=') pads++;
  return (pads === 1 || pads === 2) && !isRunChar(text[end + pads]) ? end + pads : end;
}

function keyLike(text: string, at: number, value: string, allow: ReadonlySet<string>, minLength: number, dense: (value: string) => boolean): boolean {
  if (value.length < minLength || allow.has(value)) return false;
  if (/(?:data:[^,]{0,64},|base64,)$/.test(text.slice(Math.max(0, at - 72), at))) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (value.includes('/') && value.split('/').every((s) => /^(?:[0-9]*|[a-z][a-z-]*)$/.test(s))) return false;
  return dense(value);
}

const HEX_DIGITS = '0123456789abcdef';
/** Bits a named hex value of 16 to 23 characters needs, by length from 16 (secrets.ts HEX_MIN_BITS, as measured). */
const HEX_BITS = [2.6, 2.65, 2.7, 2.75, 2.8, 2.85, 2.9, 2.9];

/**
 * A named value: hex in one case is not a unit repeated (every period up to
 * half its length tried), not counted (three in four neighbours one apart,
 * up or down), then a key from 24 characters or by its length's bits;
 * anything else needs 3.0 bits.
 */
function namedDense(value: string): boolean {
  if (!/^[0-9a-f]+$/.test(value) && !/^[0-9A-F]+$/.test(value)) return entropy(value) >= 3.0;
  for (let p = 1; p <= value.length / 2; p++) {
    if (value.slice(0, p).repeat(Math.ceil(value.length / p)).slice(0, value.length) === value) return false;
  }
  const digits = value.toLowerCase();
  let apart = 0;
  for (let i = 1; i < digits.length; i++) {
    const step = (HEX_DIGITS.indexOf(digits[i]) - HEX_DIGITS.indexOf(digits[i - 1]) + 16) % 16;
    if (step === 1 || step === 15) apart++;
  }
  if (apart / (digits.length - 1) >= 0.75) return false;
  return value.length >= 24 || entropy(value) >= HEX_BITS[value.length - 16];
}

export function referenceScanText(text: string, allow: ReadonlySet<string> = new Set()): SecretFinding[] {
  const found: SecretFinding[] = [];
  const add = (rule: string, index: number, value: string) => found.push({ rule, where: `@${index}`, excerpt: redact(value) });
  for (const m of text.matchAll(PEM)) add('pem', m.index ?? 0, m[0]);
  for (const m of text.matchAll(SECRET_PREFIX)) add('secret-prefix', m.index ?? 0, m[0]);
  for (const m of text.matchAll(SERVICE_ROLE)) add('service-role', m.index ?? 0, m[0]);
  const spans: [number, number][] = [];
  for (const m of text.matchAll(JWT)) {
    const at = m.index ?? 0;
    spans.push([at, at + m[0].length]);
    if (privilegedJwt(m[0])) add('jwt-privileged', at, m[0]);
  }
  const inJwt = (at: number) => spans.some(([a, b]) => at >= a && at < b);
  const judged = new Set<number>();
  for (const { at, value } of runs(text)) {
    if (inJwt(at)) continue;
    if (text[at - 1] === '.' && IDENTIFIER.test(value)) continue;
    if (EXTENSION_NAME.test(value)) continue;
    if (keyLike(text, at, value, allow, 32, (v) => entropy(v) >= 4.0)) {
      judged.add(at);
      add('entropy', at, value);
    }
  }
  for (const m of text.matchAll(NAMED)) {
    const at = (m.index ?? 0) + m[0].length - m[2].length;
    const value = text.slice(at, withPad(text, at + m[2].length));
    if (judged.has(at) || inJwt(at)) continue;
    if (keyLike(text, at, value, allow, 16, namedDense)) add('entropy', at, value);
  }
  return found;
}
