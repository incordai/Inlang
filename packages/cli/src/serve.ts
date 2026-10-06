/**
 * @az module serve
 * Purpose: az dev's serving half: install once, Vite dev server, optional local backend.
 * Spec: docs/PRD.md §6.7 · docs/backend-spec.md §2a
 * Exports: serve, ensureInstalled, freePort, openerFor
 * Edit guide: everything started is stopped on failure and on Ctrl-C.
 * Tests: packages/cli/test/dev-serve.test.ts
 */

/**
 * `az dev`'s serving half — PRD §6.7: "compile, serve, watch, hot-reload,
 * open browser".
 *
 * dev.ts compiles on every save; this runs what was compiled: installs the
 * generated project's dependencies once, starts its Vite dev server (which
 * reloads the page when a save rewrites the output), and — for a site that
 * declares `backend` — the backend with its development profile and mailbox.
 * Everything listens on 127.0.0.1 only. Ctrl-C stops every part.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { LOOPBACK, startDevBackend, startMailbox, type DevBackend, type Mailbox } from './dev-backend.ts';

/** Vite's own default, so the printed address is the familiar one when free. */
export const DEFAULT_SITE_PORT = 5173;
/** The generated server's default port (backend-spec §4). */
export const DEFAULT_BACKEND_PORT = 8787;
/** How long the dev server may take to answer its first request. */
const START_TIMEOUT_MS = 60_000;
/** Grace for a child to exit on SIGTERM before it is killed. */
const STOP_GRACE_MS = 3_000;
/** Poll interval while waiting for the dev server to answer. */
const POLL_MS = 150;

/** npm's JS entry beside this node — the same lookup verify-build uses; no shell. */
function npmCli(): string {
  const dir = dirname(process.execPath);
  const found = [join(dir, 'node_modules/npm/bin/npm-cli.js'), join(dir, '../lib/node_modules/npm/bin/npm-cli.js')]
    .find((p) => existsSync(p));
  if (!found) throw new Error(`npm was not found beside node at ${dir}`);
  return found;
}

const hashOf = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** Records which package.json the installed node_modules belong to. */
const STAMP = 'node_modules/.az-installed';

/** True when node_modules exists and was installed from this package.json. */
export function installed(outDir: string): boolean {
  const stamp = join(outDir, STAMP);
  return existsSync(join(outDir, 'node_modules')) && existsSync(stamp)
    && readFileSync(stamp, 'utf8').trim() === hashOf(join(outDir, 'package.json'));
}

/** Install the generated project's dependencies, once per package.json. */
export function ensureInstalled(outDir: string, print: (line: string) => void): Promise<void> {
  if (installed(outDir)) return Promise.resolve();
  print('az dev: installing the site\'s dependencies (first run, or they changed)…');
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [npmCli(), 'install', '--no-audit', '--no-fund', '--loglevel', 'error'],
      { cwd: outDir, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code !== 0) { fail(new Error(`npm install failed (exit ${code}) in ${outDir}`)); return; }
      writeFileSync(join(outDir, STAMP), `${hashOf(join(outDir, 'package.json'))}\n`, 'utf8');
      done();
    });
  });
}

/** A free loopback port: `preferred` when it is free, otherwise any. */
export function freePort(preferred: number): Promise<number> {
  const attempt = (port: number) => new Promise<number | null>((done) => {
    const probe = createServer();
    probe.once('error', () => done(null));
    probe.listen(port, LOOPBACK, () => {
      const address = probe.address();
      const got = typeof address === 'object' && address ? address.port : null;
      probe.close(() => done(got));
    });
  });
  return attempt(preferred).then((got) => got ?? attempt(0).then((any) => {
    if (any === null) throw new Error('no free port on 127.0.0.1');
    return any;
  }));
}

/**
 * The OS command that opens a URL in the default browser, as file + args for
 * execFile — never a shell string, so the URL cannot be read as a command.
 */
export function openerFor(platform: NodeJS.Platform, url: string): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] };
  if (platform === 'win32') return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { file: 'xdg-open', args: [url] };
}

/** Resolve once `url` answers, or fail after the timeout. */
function waitFor(url: string, child: ChildProcess): Promise<void> {
  const until = Date.now() + START_TIMEOUT_MS;
  return new Promise((done, fail) => {
    const poll = () => {
      if (child.exitCode !== null) { fail(new Error(`the dev server exited (code ${child.exitCode}) before it answered`)); return; }
      fetch(url).then(() => done(), () => {
        if (Date.now() > until) fail(new Error(`the dev server did not answer at ${url} within ${START_TIMEOUT_MS / 1000}s`));
        else setTimeout(poll, POLL_MS);
      });
    };
    poll();
  });
}

/** SIGTERM, then SIGKILL if the child is still there after the grace period. */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('exit', () => { clearTimeout(kill); done(); });
    child.kill('SIGTERM');
  });
}

export interface ServeOptions {
  readonly source: string;
  readonly outDir: string;
  readonly sitePort: number;
  readonly open: boolean;
  /** The backend's site name, and its `server/data.json` when the site has tables; null without a `server/`. */
  readonly backend: { readonly siteName: string; readonly data?: string } | null;
  readonly print: (line: string) => void;
}

export interface Served {
  readonly siteUrl: string;
  readonly backendUrl: string | null;
  readonly mailboxUrl: string | null;
  readonly vite: ChildProcess;
  close(): Promise<void>;
}

/**
 * Start everything a compiled site needs locally. The site's build reads the
 * backend's address from AZ_PUBLIC_BACKEND_URL — set here, in the dev server's
 * environment only, to the loopback backend.
 */
export async function serve(options: ServeOptions): Promise<Served> {
  const { print } = options;
  // Absolute: the dev server runs with this as its cwd, so a relative path
  // would be resolved twice.
  const outDir = resolve(options.outDir);
  const projectDir = dirname(resolve(options.source));
  const sitePort = await freePort(options.sitePort);
  const siteUrl = `http://${LOOPBACK}:${sitePort}/`;

  let mailbox: Mailbox | null = null;
  let backend: DevBackend | null = null;
  let vite: ChildProcess | null = null;
  // Kill the dev server if this process ends any other way (an uncaught
  // error, a signal we did not handle) — it must never outlive `az dev`.
  const orphanGuard = () => { vite?.kill(); };
  const close = async () => {
    process.off('exit', orphanGuard);
    if (vite) await stopChild(vite);
    await backend?.close();
    await mailbox?.close();
  };

  // Everything started so far is stopped if a later step fails: a bad
  // .az-dev/backend.env or an offline first install used to leave the
  // mailbox and backend listening, and the process hung.
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.backend) {
      const backendPort = await freePort(DEFAULT_BACKEND_PORT);
      const mailboxPort = await freePort(0);
      mailbox = await startMailbox(mailboxPort, print);
      backend = await startDevBackend(projectDir, options.backend.siteName,
        { site: sitePort, backend: backendPort, mailbox: mailboxPort }, mailbox, print, options.backend.data);
      env.AZ_PUBLIC_BACKEND_URL = backend.url;
    }

    await ensureInstalled(outDir, print);
    const child = spawn(process.execPath,
      [join(outDir, 'node_modules/vite/bin/vite.js'), '--host', LOOPBACK, '--port', String(sitePort), '--strictPort', '--clearScreen', 'false'],
      { cwd: outDir, env, stdio: ['ignore', 'pipe', 'inherit'] });
    vite = child;
    process.on('exit', orphanGuard);
    // Vite's banner prints localhost, which is a different site from 127.0.0.1
    // for cookies; our own lines below give the address to use.
    child.stdout?.resume();
    await waitFor(siteUrl, child);

    print(`az dev: site     ${siteUrl}`);
    if (backend && mailbox) {
      print(`az dev: backend  ${backend.url}  (SQLite in .az-dev/, dev profile)`);
      print(`az dev: mailbox  ${mailbox.url}  (email is shown here, never sent)`);
    }
    print('az dev: watching for changes — Ctrl-C to stop');
    if (options.open) {
      const { file, args } = openerFor(process.platform, siteUrl);
      execFile(file, args, (e) => { if (e) print(`az dev: could not open a browser (${e.message}) — open ${siteUrl}`); });
    }
    return { siteUrl, backendUrl: backend?.url ?? null, mailboxUrl: mailbox?.url ?? null, vite: child, close };
  } catch (e) {
    await close();
    throw e;
  }
}
