/**
 * `az dev`'s development profile — the parts that decide safety and wiring,
 * without a browser. The full loop (serve, sign-up, mailbox, reload, Ctrl-C)
 * is scripts/dev-e2e.mjs (`pnpm test:dev`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertLoopback, CHAT_DEMO, devBackendEnv, devDir, devSecret, LOOPBACK, readEnvFile, startDevBackend, startMailbox, withoutSecure,
} from '../src/dev-backend.ts';
import { openerFor, freePort, devViteConfig, DEV_VITE_CONFIG } from '../src/serve.ts';
import { loadConfig } from '../../backend/src/server/env.ts';
import { build } from '../src/az.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const PORTS = { site: 5173, backend: 8787, mailbox: 9999 };
const tmp = () => mkdtempSync(join(tmpdir(), 'az-devserve-'));
const quiet = () => {};

test('the dev environment wires every address to loopback and passes the server\'s own checks', () => {
  const env = devBackendEnv(PORTS, 'x'.repeat(43), '/tmp/dev.db', 'k');
  assert.equal(env.AZ_BACKEND_PUBLIC_URL, 'http://127.0.0.1:8787');
  assert.equal(env.AZ_ALLOWED_ORIGINS, 'http://127.0.0.1:5173');
  assert.equal(env.AZ_HOST, LOOPBACK);
  assert.equal(env.AZ_EMAIL_API_URL, 'http://127.0.0.1:9999/send');
  const loaded = loadConfig(env, { database: 'sqlite', email: 'api' }, 'studio');
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.problems.join('; '));
});

test('extra keys from .az-dev/backend.env pass through, but never override the wiring', () => {
  const env = devBackendEnv(PORTS, 'x'.repeat(43), '/tmp/dev.db', 'k', {
    AZ_OAUTH_PROVIDERS: 'work',
    AZ_BACKEND_PUBLIC_URL: 'https://api.example.org',
    AZ_HOST: '0.0.0.0',
    AZ_SQLITE_PATH: '/var/lib/prod.db',
    AZ_EMAIL_API_URL: 'https://mail.example.org/send',
  });
  assert.equal(env.AZ_OAUTH_PROVIDERS, 'work', 'CONTROL: a provider for local sign-in is kept');
  assert.equal(env.AZ_BACKEND_PUBLIC_URL, 'http://127.0.0.1:8787');
  assert.equal(env.AZ_HOST, LOOPBACK);
  assert.equal(env.AZ_SQLITE_PATH, '/tmp/dev.db');
  assert.equal(env.AZ_EMAIL_API_URL, 'http://127.0.0.1:9999/send', 'dev email never reaches a real sender');
});

test('dev servers refuse to bind anything but loopback', () => {
  assert.throws(() => assertLoopback('0.0.0.0'), /127\.0\.0\.1 only/);
  assert.throws(() => assertLoopback('192.168.1.5'));
  assert.doesNotThrow(() => assertLoopback(LOOPBACK));
  assert.throws(() => startMailbox(0, quiet, '0.0.0.0'), /127\.0\.0\.1 only/);
});

test('.az-dev ignores itself, and the dev secret is owner-only and stable', () => {
  const dir = devDir(tmp());
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\*$/m);
  const first = devSecret(dir);
  assert.equal(statSync(join(dir, 'secret')).mode & 0o777, 0o600);
  assert.equal(devSecret(dir), first, 'the same project keeps its secret, so sessions survive a restart');
  assert.ok(Buffer.from(first, 'base64url').length >= 32);
});

test('readEnvFile reads KEY=value lines and ignores the rest', () => {
  const f = join(tmp(), 'backend.env');
  writeFileSync(f, '# a comment\nAZ_OAUTH_PROVIDERS=work\nexport AZ_OAUTH_WORK_LABEL="Work"\n\nnot a line\n');
  assert.deepEqual(readEnvFile(f), { AZ_OAUTH_PROVIDERS: 'work', AZ_OAUTH_WORK_LABEL: 'Work' });
  assert.deepEqual(readEnvFile(join(tmp(), 'absent.env')), {});
});

test('the mailbox keeps a message only with its per-run key, and shows it escaped', async () => {
  const printed: string[] = [];
  const mailbox = await startMailbox(await freePort(0), (l) => printed.push(l));
  try {
    const send = (key: string, body: object) => fetch(`${mailbox.url}send`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await send('wrong', { to: 'a@b.test', subject: 's', text: 't' })).status, 401);
    assert.equal(mailbox.messages.length, 0, 'a wrong key stores nothing');
    const hostile = { to: 'ada@studio.test', subject: '<script>alert(1)</script>', text: 'Open http://127.0.0.1:5173/reset?token=abc&email=a to reset.' };
    assert.equal((await send(mailbox.key, hostile)).status, 202);
    assert.equal(mailbox.messages.length, 1);
    assert.match(printed.join('\n'), /email to ada@studio\.test[\s\S]*http:\/\/127\.0\.0\.1:5173\/reset\?token=abc/);
    const page = await (await fetch(mailbox.url)).text();
    assert.ok(!page.includes('<script>alert(1)</script>'), 'the subject is escaped');
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page, /<a href="http:\/\/127\.0\.0\.1:5173\/reset\?token=abc&amp;email=a">/);
  } finally {
    await mailbox.close();
  }
});

test('the dev backend signs up over SQLite and mails the reset link to the mailbox', async () => {
  const project = tmp();
  const ports = { site: await freePort(0), backend: await freePort(0), mailbox: await freePort(0) };
  const mailbox = await startMailbox(ports.mailbox, quiet);
  const backend = await startDevBackend(project, 'studio', ports, mailbox, quiet);
  const origin = `http://127.0.0.1:${ports.site}`;
  const post = (path: string, body: object) => fetch(`${backend.url}/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-az-request': '1' },
    body: JSON.stringify(body),
  });
  try {
    const signup = await post('sign-up', { name: 'Ada', email: 'ada@studio.test', password: 'a-long-enough-password', passwordConfirm: 'a-long-enough-password' });
    assert.equal(signup.status, 200, await signup.text());
    assert.equal((await post('reset', { email: 'ada@studio.test' })).status, 200);
    const until = Date.now() + 5000;
    while (mailbox.messages.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.equal(mailbox.messages.length, 1, 'the reset email reached the mailbox, not the world');
    assert.match(mailbox.messages[0].text, new RegExp(`${origin}/reset\\?token=`));
    assert.ok(readdirSync(join(project, '.az-dev')).includes('dev.db'), 'the dev database lives in .az-dev/');
  } finally {
    await backend.close();
    await mailbox.close();
  }
});

test('az dev chats through the scripted demo, written once to .az-dev/, unless backend.env names a model', async () => {
  const project = tmp();
  const ports = { site: await freePort(0), backend: await freePort(0), mailbox: await freePort(0) };
  const mailbox = await startMailbox(ports.mailbox, quiet);
  const printed: string[] = [];
  const chat = {
    prompt: 'Answer about the studio.\n',
    context: JSON.stringify({ site: { name: 'studio' }, pages: [], chats: { '/': { allow: 'anyone', limit: 20 } }, routes: ['/'] }),
  };
  const backend = await startDevBackend(project, 'studio', ports, mailbox, (l) => printed.push(l), undefined, chat);
  try {
    const r = await fetch(`${backend.url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${ports.site}`, 'x-az-request': '1' },
      body: JSON.stringify({ page: '/', messages: [{ role: 'visitor', text: 'hello' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(r.status, 200);
    const body = await r.text();
    // Through the answer parser: a piece's last character waits for the next piece (it may carry a combining mark).
    assert.match(body, /event: text\ndata: \{"s":"This is the local demo answer from az dev\."\}/);
    assert.match(body, /event: done\n/);
    assert.deepEqual(JSON.parse(readFileSync(join(project, '.az-dev/chat-demo.json'), 'utf8')), CHAT_DEMO);
    assert.ok(printed.some((l) => l.includes('chat answers from the demo script')));
  } finally {
    await backend.close();
    await mailbox.close();
  }
  // A real model named in backend.env replaces the demo (here an invalid one, so the start names it).
  writeFileSync(join(project, '.az-dev/backend.env'), 'AZ_CHAT_API=completions\n');
  const mailbox2 = await startMailbox(await freePort(0), quiet);
  try {
    await assert.rejects(startDevBackend(project, 'studio', { ...ports, mailbox: 0 }, mailbox2, quiet, undefined, chat), /AZ_CHAT_URL is missing/);
  } finally {
    await mailbox2.close();
  }
});

test('a public chat\'s dev backend keeps no accounts: no mailbox, no mail keys, no /auth — and the demo answers anyone', async () => {
  const project = tmp();
  const ports = { site: await freePort(0), backend: await freePort(0), mailbox: 0 };
  const chat = {
    prompt: 'Answer about the demo.\n',
    context: JSON.stringify({ site: { name: 'demo' }, pages: [], chats: { '/': { allow: 'anyone', limit: 20 } }, routes: ['/'] }),
  };
  assert.equal('AZ_EMAIL_API_URL' in devBackendEnv(ports, 's'.repeat(43), ':memory:', null), false);
  const backend = await startDevBackend(project, 'demo', ports, null, quiet, undefined, chat);
  try {
    const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${ports.site}`, 'x-az-request': '1' };
    const r = await fetch(`${backend.url}/chat`, {
      method: 'POST', headers, body: JSON.stringify({ page: '/', messages: [{ role: 'visitor', text: 'hello' }] }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /This is the local demo answer from az dev/);
    const signUp = await fetch(`${backend.url}/auth/sign-up`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10_000) });
    assert.equal(signUp.status, 404);
  } finally {
    await backend.close();
  }
});

test('a chat that shows maps: az dev serves the bundled world basemap with its credit (§19.15)', async () => {
  const project = tmp();
  const ports = { site: await freePort(0), backend: await freePort(0), mailbox: 0 };
  const printed: string[] = [];
  const chat = {
    prompt: 'Answer.\n',
    context: JSON.stringify({ site: { name: 'demo' }, pages: [], chats: { '/': { allow: 'anyone', limit: 20, show: ['map'] } }, routes: ['/'] }),
    map: true,
  };
  const backend = await startDevBackend(project, 'demo', ports, null, (l) => printed.push(l), undefined, chat);
  try {
    const origin = `http://127.0.0.1:${ports.site}`;
    const r = await fetch(`${backend.url}/tiles/map.json`, { headers: { origin }, signal: AbortSignal.timeout(10_000) });
    assert.equal(r.status, 200);
    const served = await r.json() as { archives: { name: string; maxzoom: number }[]; attribution: string };
    assert.deepEqual(served.archives.map((a) => [a.name, a.maxzoom]), [['world', 6]]);
    assert.ok(served.attribution.length > 0);
    const range = await fetch(`${backend.url}/tiles/world.pmtiles`, { headers: { origin, range: 'bytes=0-126' }, signal: AbortSignal.timeout(10_000) });
    assert.equal(range.status, 206);
    assert.equal(Buffer.from(await range.arrayBuffer()).toString('latin1', 0, 7), 'PMTiles');
    assert.ok(printed.some((l) => l.includes('maps draw the bundled world basemap')));
  } finally {
    await backend.close();
  }
});

test('a production build carries no dev profile and no mailbox', () => {
  const dir = tmp();
  const file = join(dir, 'site.az');
  writeFileSync(file, 'az 1\nsite studio\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\npage /\n  hero center\n    title "x"\npage /login\n  auth login\n');
  const prev = process.env.AZ_PUBLIC_BACKEND_URL;
  process.env.AZ_PUBLIC_BACKEND_URL = 'https://api.example.org';
  try {
    const r = build({ source: file, outDir: join(dir, 'out'), wordsDir: WORDS });
    assert.ok(r.ok, r.report);
    assert.ok(r.files.some((f) => f.path.startsWith('server/')), 'CONTROL: the backend is in the build');
    for (const f of r.files) {
      // Code markers only: the server README may point at `az dev` in prose.
      assert.ok(!/startMailbox|startDevBackend|withoutSecure|messages\.json|az dev mailbox/.test(f.content), `${f.path} carries dev-only code`);
    }
  } finally {
    if (prev === undefined) delete process.env.AZ_PUBLIC_BACKEND_URL; else process.env.AZ_PUBLIC_BACKEND_URL = prev;
  }
});

test('dev cookies lose only the Secure attribute (WebKit drops Secure on http loopback)', () => {
  assert.equal(withoutSecure('az_session=v; HttpOnly; Secure; Path=/; SameSite=Lax'), 'az_session=v; HttpOnly; Path=/; SameSite=Lax');
  assert.deepEqual(withoutSecure(['a=1; Secure', 'b=2; HttpOnly']), ['a=1', 'b=2; HttpOnly']);
  assert.equal(withoutSecure('secureish=1; Path=/'), 'secureish=1; Path=/', 'CONTROL: a name containing "secure" is untouched');
});

test('the dev backend answers sign-up with an HttpOnly cookie that is not marked Secure', async () => {
  const project = tmp();
  const ports = { site: await freePort(0), backend: await freePort(0), mailbox: await freePort(0) };
  const mailbox = await startMailbox(ports.mailbox, quiet);
  const backend = await startDevBackend(project, 'studio', ports, mailbox, quiet);
  try {
    const r = await fetch(`${backend.url}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${ports.site}`, 'x-az-request': '1' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@studio.test', password: 'a-long-enough-password', passwordConfirm: 'a-long-enough-password' }),
    });
    const cookie = r.headers.get('set-cookie') ?? '';
    assert.match(cookie, /az_session=.*HttpOnly/);
    assert.doesNotMatch(cookie, /Secure/);
  } finally {
    await backend.close();
    await mailbox.close();
  }
});

test('the browser opener is a command and an argument list, never a shell line', () => {
  const url = 'http://127.0.0.1:5173/?a=1&b=$(rm -rf ~)';
  assert.deepEqual(openerFor('darwin', url), { file: 'open', args: [url] });
  assert.deepEqual(openerFor('linux', url), { file: 'xdg-open', args: [url] });
  assert.deepEqual(openerFor('win32', url), { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
});

test('the dev server reads the site\'s vite.config.ts through a config that never changes', async () => {
  // A page added mid-session rewrites vite.config.ts (its build input); Vite
  // restarts on a change to its config or the config's static imports, so
  // the dev config imports the site's config through a variable only.
  const out = mkdtempSync(join(tmpdir(), 'az-devconfig-"quoted"-'));
  writeFileSync(join(out, 'vite.config.ts'), 'export default { base: "./", envPrefix: "AZ_PUBLIC_" } as const;\n', 'utf8');
  mkdirSync(join(out, 'node_modules'));
  const text = devViteConfig(out);
  assert.doesNotMatch(text, /^\s*import\s/m, 'no static import for the bundler to follow');
  assert.ok(text.includes(JSON.stringify(pathToFileURL(join(out, 'vite.config.ts')).href)), 'the site config, by its file URL');
  writeFileSync(join(out, DEV_VITE_CONFIG), text, 'utf8');
  const loaded = (await import(pathToFileURL(join(out, DEV_VITE_CONFIG)).href)) as { default: unknown };
  assert.deepEqual(loaded.default, { base: './', envPrefix: 'AZ_PUBLIC_' }, 'it is the site config, unchanged');
});
