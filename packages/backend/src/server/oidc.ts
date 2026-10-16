/**
 * @az server oidc
 * Purpose: provider sign-in: OpenID Connect discovery and ID-token checks, plain OAuth 2.
 * Spec: docs/auth-block-spec.md §3.4
 * Exports: createOidc, ProviderError
 * Edit guide: https only, no redirects on fetch, alg none refused, iss/aud/exp/nonce checked.
 * Tests: packages/backend/test/security.test.ts
 */

/**
 * Provider sign-in — OpenID Connect and plain OAuth 2 (auth-spec §3.4,
 * backend-spec §6). Generic: every provider is configuration.
 *
 * ID tokens are verified here with node:crypto, and only these algorithms
 * are accepted: RS256, PS256, ES256, EdDSA with keys from the issuer's JWKS,
 * and HS256 with the client secret (a confidential client's option in OIDC
 * Core §10.1). `none` is refused, and an HMAC algorithm is never checked
 * against a public key — the classic algorithm-confusion attack.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { createHmac, createPublicKey, verify as verifySig, constants, type KeyObject, type webcrypto } from 'node:crypto';

/** A JWKS entry: a JSON Web Key plus its key id (RFC 7517 §4.5). */
type JsonWebKey = webcrypto.JsonWebKey & { readonly kid?: string };
import { safeEqual } from './crypto.ts';
import { urlProblem, type Provider } from './env.ts';
import { BodyTooLarge, readCapped } from './outbound.ts';

export interface Discovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string | null;
  readonly userinfoEndpoint: string | null;
}

type Fetch = typeof fetch;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;
const FETCH_TIMEOUT_MS = 10_000;
/**
 * The most a provider answer may hold. Discovery documents, key sets, token
 * and profile answers are a few kilobytes; one this size is hostile, so the
 * read stops there instead of buffering whatever the provider sends.
 */
const BODY_LIMIT_BYTES = 256 * 1024;

export class ProviderError extends Error {}

/** The body as text, read until BODY_LIMIT_BYTES (outbound.ts); past it the read is cancelled, which drops the connection. */
async function readBody(response: Response, host: string): Promise<string> {
  try {
    return await readCapped(response, BODY_LIMIT_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLarge) throw new ProviderError(`${host} answered more than ${BODY_LIMIT_BYTES} bytes`);
    throw e;
  }
}

async function getJson(fetchFn: Fetch, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  const host = new URL(url).host;
  if (!response.ok) {
    // Only the status is used. A body left unread held the provider's
    // connection open until the response was collected, and a hostile one
    // could keep streaming into it; cancelled, the connection closes now.
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(`${host} answered ${response.status}`);
  }
  const body: unknown = JSON.parse(await readBody(response, host));
  if (!body || typeof body !== 'object') throw new ProviderError('provider answered with no JSON object');
  return body as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function createOidc(fetchFn: Fetch, now: () => number = Date.now) {
  const discoveries = new Map<string, Promise<Discovery>>();
  const jwks = new Map<string, { at: number; keys: JsonWebKey[] }>();

  async function discover(p: Provider): Promise<Discovery> {
    if (p.type === 'oauth2') {
      return { issuer: '', authorizationEndpoint: p.authorizeUrl!, tokenEndpoint: p.tokenUrl!, jwksUri: null, userinfoEndpoint: p.userinfoUrl! };
    }
    const issuer = p.issuer!.replace(/\/+$/, '');
    let found = discoveries.get(p.id);
    if (!found) {
      found = (async () => {
        const doc = await getJson(fetchFn, `${issuer}/.well-known/openid-configuration`);
        // OIDC Discovery §4.3: the document's issuer MUST equal the configured one.
        if (str(doc.issuer).replace(/\/+$/, '') !== issuer) throw new ProviderError('issuer in discovery does not match');
        const endpoints = {
          authorizationEndpoint: str(doc.authorization_endpoint),
          tokenEndpoint: str(doc.token_endpoint),
        };
        for (const [k, v] of Object.entries(endpoints)) {
          if (!v || urlProblem(v, { base: false })) throw new ProviderError(`discovery ${k} is not a safe URL`);
        }
        const jwksUri = str(doc.jwks_uri) || null;
        if (jwksUri && urlProblem(jwksUri, { base: false })) throw new ProviderError('discovery jwks_uri is not a safe URL');
        return { issuer: str(doc.issuer), ...endpoints, jwksUri, userinfoEndpoint: str(doc.userinfo_endpoint) || null };
      })();
      discoveries.set(p.id, found);
      // A failed discovery is not cached — the next sign-in tries again.
      found.catch(() => discoveries.delete(p.id));
    }
    return found;
  }

  /** The issuer's signing keys, cached; refetched once when a `kid` is unknown (key rotation). */
  async function keyFor(uri: string, kid: string | undefined): Promise<JsonWebKey | null> {
    const pick = (keys: JsonWebKey[]) => (kid ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : undefined) ?? null;
    let cached = jwks.get(uri);
    if (!cached || now() - cached.at > JWKS_TTL_MS) cached = undefined;
    let key = cached ? pick(cached.keys) : null;
    if (!key && (!cached || now() - cached.at > JWKS_REFRESH_MIN_MS)) {
      const doc = await getJson(fetchFn, uri);
      const keys = Array.isArray(doc.keys) ? doc.keys as JsonWebKey[] : [];
      cached = { at: now(), keys };
      jwks.set(uri, cached);
      key = pick(keys);
    }
    return key;
  }

  function checkSignature(alg: string, input: string, sig: Buffer, key: KeyObject | Buffer): boolean {
    const data = Buffer.from(input);
    switch (alg) {
      case 'HS256': {
        const mac = createHmac('sha256', key as Buffer).update(data).digest();
        return safeEqual(mac.toString('base64url'), sig.toString('base64url'));
      }
      case 'RS256': return verifySig('sha256', data, key as KeyObject, sig);
      case 'PS256': return verifySig('sha256', data, { key: key as KeyObject, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
      case 'ES256': return verifySig('sha256', data, { key: key as KeyObject, dsaEncoding: 'ieee-p1363' }, sig);
      case 'EdDSA': return verifySig(null, data, key as KeyObject, sig);
      default: return false;
    }
  }

  const KTY: Readonly<Record<string, string>> = { RS256: 'RSA', PS256: 'RSA', ES256: 'EC', EdDSA: 'OKP' };

  /** Verify an ID token and return its claims, or throw. */
  async function verifyIdToken(p: Provider, d: Discovery, token: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new ProviderError('id_token is not a JWT');
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      throw new ProviderError('id_token is not readable');
    }
    const alg = str(header.alg);
    let key: KeyObject | Buffer;
    if (alg === 'HS256') {
      key = Buffer.from(p.clientSecret);
    } else if (KTY[alg]) {
      if (!d.jwksUri) throw new ProviderError('provider publishes no keys for an asymmetric token');
      const jwk = await keyFor(d.jwksUri, typeof header.kid === 'string' ? header.kid : undefined);
      if (!jwk || jwk.kty !== KTY[alg]) throw new ProviderError('no matching signing key');
      if (alg === 'ES256' && jwk.crv !== 'P-256') throw new ProviderError('ES256 key is not P-256');
      if (alg === 'EdDSA' && jwk.crv !== 'Ed25519') throw new ProviderError('EdDSA key is not Ed25519');
      key = createPublicKey({ key: jwk, format: 'jwk' });
    } else {
      throw new ProviderError(`id_token algorithm '${alg}' is not accepted`);
    }
    if (!checkSignature(alg, `${parts[0]}.${parts[1]}`, Buffer.from(parts[2], 'base64url'), key)) {
      throw new ProviderError('id_token signature does not verify');
    }
    const t = now() / 1000;
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (str(claims.iss) !== d.issuer) throw new ProviderError('id_token iss does not match');
    if (!audiences.includes(p.clientId)) throw new ProviderError('id_token aud does not include this client');
    if (audiences.length > 1 && claims.azp !== p.clientId) throw new ProviderError('id_token azp is not this client');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < t) throw new ProviderError('id_token has expired');
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > t) throw new ProviderError('id_token is issued in the future');
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) throw new ProviderError('id_token nonce does not match');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new ProviderError('id_token has no subject');
    return claims;
  }

  /** Exchange the authorization code; client_secret_post (RFC 6749 §2.3.1). */
  async function exchange(p: Provider, d: Discovery, code: string, verifier: string, redirectUri: string): Promise<Record<string, unknown>> {
    return getJson(fetchFn, d.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
        client_id: p.clientId, client_secret: p.clientSecret,
      }),
    });
  }

  async function userinfo(url: string, accessToken: string): Promise<Record<string, unknown>> {
    return getJson(fetchFn, url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  }

  return { discover, verifyIdToken, exchange, userinfo };
}

export type Oidc = ReturnType<typeof createOidc>;
