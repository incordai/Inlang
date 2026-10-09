/**
 * scanText as it was before its JWT rule became a single pass (secrets.ts
 * `jwts`): the regular expression, and a search of every span per run.
 * Copied unchanged, with the helpers it needs; kept only as the oracle the
 * equivalence and cost tests compare the scanner against.
 */

import { entropy, redact, type SecretFinding } from '../src/secrets.ts';

const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['service_role', 'service', 'admin']);
const ENTROPY_MIN_LENGTH = 32;
const ENTROPY_MIN_BITS = 4.0;

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
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EXTENSION_NAME = /^(?:WEBGL|EXT|OES|KHR|ANGLE|OVR|ARB|NV|AMD|MOZ|WEBKIT)_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function legacyScanText(text: string, allow: ReadonlySet<string> = new Set()): SecretFinding[] {
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
    if (jwtSpans.some(([a, b]) => at >= a && at < b)) continue;
    if (/(?:data:[^,]{0,64},|base64,)$/.test(text.slice(Math.max(0, at - 72), at))) continue;
    if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) continue;
    if (text[at - 1] === '.' && IDENTIFIER.test(value)) continue;
    if (EXTENSION_NAME.test(value)) continue;
    if (value.length >= ENTROPY_MIN_LENGTH && entropy(value) >= ENTROPY_MIN_BITS) add('entropy', at, value);
  }
  return found;
}
