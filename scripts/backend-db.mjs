/**
 * The built-in backend against REAL PostgreSQL and MySQL (backend-spec §3).
 *
 * The unit suite runs every flow on SQLite in memory; this runs the same
 * store and routes on the other two engines, in containers at pinned
 * versions, torn down afterwards. Needs Docker; not part of `pnpm test`,
 * which must never need a daemon or the network.
 *
 *     pnpm test:backend-db
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../packages/backend/src/server/app.ts';
import { migrate, openMysql, openPostgres } from '../packages/backend/src/server/db.ts';
import { loadConfig } from '../packages/backend/src/server/env.ts';
import { createOidc } from '../packages/backend/src/server/oidc.ts';
import { createStore } from '../packages/backend/src/server/store.ts';
import { dataSuite } from './backend-db-data.mjs';
import { closeWithin } from './lib/bounded.mjs';

/** A database connection that will not close is abandoned after this (rule 13: bound every wait). */
const DB_CLOSE_MS = 15_000;

/** Pinned images — the current PostgreSQL release and MySQL's long-term-support line. */
const IMAGES = { postgres: 'postgres:18.6-alpine', mysql: 'mysql:8.4.11' };
const READY_TIMEOUT_MS = 120_000;
const PASSWORD = randomBytes(12).toString('hex');       // throwaway, this run only
const SITE = 'http://127.0.0.1:5173';

const DOCKER = ['docker', '/Applications/Docker.app/Contents/Resources/bin/docker', '/usr/local/bin/docker']
  .find((d) => spawnSync(d, ['info'], { stdio: 'ignore' }).status === 0);
if (!DOCKER) {
  console.error('backend-db: Docker is not available — start it, or run this where it is');
  process.exit(2);
}
const docker = (...args) => execFileSync(DOCKER, args, { encoding: 'utf8' }).trim();

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};
/** A finding recorded as observed — not a pass or a fail. */
const info = (line) => console.log(`INFO  ${line}`);

async function until(fn, what) {
  const start = Date.now();
  let last;
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try { return await fn(); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} not ready: ${last?.message}`);
}

function startContainer(engine) {
  const env = engine === 'postgres'
    ? ['-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_DB=az']
    : ['-e', `MYSQL_ROOT_PASSWORD=${PASSWORD}`, '-e', 'MYSQL_DATABASE=az'];
  const port = engine === 'postgres' ? '5432' : '3306';
  const id = docker('run', '-d', '--rm', '-p', `127.0.0.1::${port}`, ...env, IMAGES[engine]);
  const host = docker('port', id, port).split('\n')[0].replace('0.0.0.0', '127.0.0.1');
  const url = engine === 'postgres'
    ? `postgres://postgres:${PASSWORD}@${host}/az`
    : `mysql://root:${PASSWORD}@${host}/az`;
  return { id, url };
}

async function suite(engine) {
  const c = startContainer(engine);
  console.log(`\n${engine} (${IMAGES[engine]})`);
  let db;
  try {
    db = await until(async () => {
      const d = engine === 'postgres' ? await openPostgres(c.url, false) : await openMysql(c.url, false);
      await d.get('SELECT 1 AS ok');
      return d;
    }, engine);
    check(`${engine}: migrations apply`, (await migrate(db)).join() === '1,2');
    check(`${engine}: migrations are a no-op the second time`, (await migrate(db)).length === 0);

    const secret = randomBytes(32);
    const store = createStore(db, secret);
    const u = await store.createUser({ email: 'Ada@Studio.test', name: "O'Brien; DROP TABLE az_users;--", passwordHash: 'h', location: null, verified: false });
    check(`${engine}: a user is created, the address lower-cased`, u !== 'taken' && u.email === 'ada@studio.test');
    check(`${engine}: a hostile name is stored literally`, (await store.userByEmail('ada@studio.test'))?.name === "O'Brien; DROP TABLE az_users;--");
    check(`${engine}: a second account for the same address (any case) is refused`,
      (await store.createUser({ email: 'ADA@studio.test', name: 'x', passwordHash: 'h', location: null, verified: false })) === 'taken');
    check(`${engine}: SQL in a lookup is a value`, (await store.userByEmail("' OR '1'='1")) === null);

    const s = await store.createSession(u.id);
    check(`${engine}: a session reads back, and times survive as numbers`, (await store.sessionUser(s.token))?.expiresAt === s.expiresAt);
    await store.deleteSession(s.token);
    check(`${engine}: a deleted session is gone`, (await store.sessionUser(s.token)) === null);

    const token = await store.createToken(u.id, 'reset', SITE);
    const spends = await Promise.all([store.spendToken(token, 'reset'), store.spendToken(token, 'reset'), store.spendToken(token, 'reset')]);
    check(`${engine}: three concurrent spends of one token — exactly one succeeds`,
      spends.filter((x) => x !== 'expired').length === 1, JSON.stringify(spends.map((x) => (x === 'expired' ? 'expired' : 'ok'))));

    await store.putOAuthState('st', { provider: 'work', verifier: 'v', nonce: 'n', next: '/', site: SITE });
    const takes = await Promise.all([store.takeOAuthState('st'), store.takeOAuthState('st')]);
    check(`${engine}: a provider state is taken once, even concurrently`, takes.filter(Boolean).length === 1);

    await store.linkOAuth('work', 'sub-1', u.id);
    await store.linkOAuth('work', 'sub-1', u.id);
    check(`${engine}: provider links are idempotent`, (await store.oauthAccount('work', 'sub-1')) === u.id);
    await store.prune();
    check(`${engine}: prune runs`, true);

    // The routes over HTTP on this engine.
    const loaded = loadConfig({
      AZ_SESSION_SECRET: secret.toString('base64url'), AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9', AZ_ALLOWED_ORIGINS: SITE,
      AZ_EMAIL_FROM: 'x <x@studio.test>', AZ_DATABASE_URL: c.url, AZ_EMAIL_API_URL: 'http://127.0.0.1:9/send', AZ_EMAIL_API_KEY: 'k',
    }, { database: engine, email: 'api' }, 'Studio');
    if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
    const mail = [];
    const app = createApp({ config: loaded.config, store, mailer: { send: async (m) => { mail.push(m); } }, oidc: createOidc(fetch), log: () => {} });
    const server = createServer((q, r) => { void app.handler(q, r); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, cookie = '') => fetch(`${base}${path}`, {
      method: 'POST', headers: { origin: SITE, 'x-az-request': '1', 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    });
    const pw = 'a-long-enough-password';
    const up = await post('/auth/sign-up', { name: 'Bea', email: 'bea@studio.test', password: pw, passwordConfirm: pw, location: 'Porto' });
    const upBody = await up.json();
    check(`${engine} HTTP: sign-up returns the profile with location`, up.status === 200 && upBody.session.user.location === 'Porto', JSON.stringify(upBody));
    const inOk = await post('/auth/sign-in', { email: 'BEA@studio.test', password: pw });
    const cookie = (inOk.headers.getSetCookie()[0] ?? '').split(';')[0];
    check(`${engine} HTTP: sign-in (address in another case) sets the session cookie`, inOk.status === 200 && cookie.startsWith('__Host-az_session='));
    const read = await (await fetch(`${base}/auth/session`, { headers: { origin: SITE, cookie } })).json();
    check(`${engine} HTTP: the session reads back`, read.session?.user?.name === 'Bea');
    await post('/auth/reset', { email: 'bea@studio.test' });
    await new Promise((r) => setTimeout(r, 50));
    const t = new URL(/https?:\/\/\S+/.exec(mail[0]?.text ?? '')?.[0] ?? 'http://x').searchParams.get('token');
    const set = await post('/auth/password', { token: t, password: 'another-long-password', passwordConfirm: 'another-long-password' });
    check(`${engine} HTTP: a reset link sets a new password`, set.status === 200);
    const again = await post('/auth/password', { token: t, password: 'third-long-password', passwordConfirm: 'third-long-password' });
    check(`${engine} HTTP: …once`, (await again.json()).error === 'expired_token');
    server.close();

    // The data tables on this engine (data-spec §14).
    await dataSuite(engine, db, () => (engine === 'postgres' ? openPostgres(c.url, false) : openMysql(c.url, false)), check, info);
  } finally {
    if (db) await closeWithin(db, DB_CLOSE_MS, `${engine} connection close`);
    docker('rm', '-f', c.id);
  }
}

for (const engine of ['postgres', 'mysql']) {
  try {
    await suite(engine);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${engine}: ${e.message}`);
  }
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
