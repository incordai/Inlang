/**
 * @az server main
 * Purpose: start the backend: config, migrations, store, routes, HTTP server; --migrate --confirm for data steps; --images [--confirm] for the image backfill.
 * Spec: docs/backend-spec.md §8 · docs/data-spec.md §6.3, §8
 * Exports: (none — entry point)
 * Edit guide: refuse to start on invalid config or an unconfirmed destructive step; never let a handler rejection crash the process.
 * Tests: packages/backend/test/backend.test.ts
 */

/**
 * Start the backend (backend-spec §8).
 *
 *     node src/main.ts        (Node 22.18 or later — it runs TypeScript directly)
 *
 * Reads `.env` in the working directory if there is one, then the process
 * environment; validates everything and refuses to start, naming every
 * problem, if anything required is missing or unsafe. Migrates the database,
 * then listens.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createApp, type DataRoutes } from './app.ts';
import { MigrationBusy } from './claim.ts';
import type { DataStep } from './data-migrate.ts';
import { migrate, openMysql, openPostgres, openSqlite, type Db } from './db.ts';
import { createMailer } from './email.ts';
import { loadConfig, type Setup } from './env.ts';
import { createBackendServer } from './http.ts';
import { createOidc } from './oidc.ts';
import { createStore } from './store.ts';

const PRUNE_MS = 10 * 60 * 1000;
/** Rate-limit maps are swept often; each is also bounded (createLimiter). */
const SWEEP_MS = 60 * 1000;
/** Unreferenced image files are looked for this often (data-spec §8). */
const FILE_SWEEP_MS = 60 * 60 * 1000;

const site = JSON.parse(readFileSync(new URL('../az.config.json', import.meta.url), 'utf8')) as { siteName: string } & Setup;
if (existsSync('.env')) process.loadEnvFile('.env');

const loaded = loadConfig(process.env, { database: site.database, email: site.email, ...(site.images === true ? { images: true } : {}) }, site.siteName);
if (!loaded.ok) {
  process.stderr.write(`backend: cannot start — fix these in .env (see .env.example):\n${loaded.problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
const { config } = loaded;

/** AZ_DATABASE_CA_FILE, read once at start; a missing file stops the server with its name. */
function readCa(path: string): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    process.stderr.write(`backend: cannot start — AZ_DATABASE_CA_FILE: cannot read ${path}\n`);
    process.exit(1);
  }
}
const ca = readCa(config.databaseCaFile);

const db: Db = config.setup.database === 'sqlite'
  ? await openSqlite(config.sqlitePath)
  : config.setup.database === 'postgres'
    ? await openPostgres(config.databaseUrl, config.databaseTls, ca)
    : await openMysql(config.databaseUrl, config.databaseTls, ca);
/**
 * `--migrate --confirm <version>`: apply the data steps up to that version,
 * the destructive ones included, then exit (data-spec §6.3). Without
 * `--migrate` the server applies only safe steps and then serves.
 *
 * `--images`: count the stored images that have no width copies (data-spec
 * §8), then exit; `--images --confirm` makes them (the backfill), then
 * exits. `az backend images <server-dir>` runs these.
 */
function startArgs(argv: readonly string[]): { migrate: boolean; confirm: number; images: 'count' | 'make' | null } {
  const migrateOnly = argv.includes('--migrate');
  const imagesOnly = argv.includes('--images');
  const at = argv.indexOf('--confirm');
  if (imagesOnly) {
    if (migrateOnly || argv.some((a) => a !== '--images' && a !== '--confirm')) {
      process.stderr.write('backend: --images goes alone, or with --confirm: node src/main.ts --images --confirm\n');
      process.exit(1);
    }
    return { migrate: false, confirm: 0, images: at >= 0 ? 'make' : 'count' };
  }
  const raw = at >= 0 ? argv[at + 1] : undefined;
  if (at >= 0 && (!migrateOnly || raw === undefined || !/^[1-9]\d{0,5}$/.test(raw))) {
    process.stderr.write('backend: --confirm takes a step version and goes with --migrate: node src/main.ts --migrate --confirm 3\n');
    process.exit(1);
  }
  return { migrate: migrateOnly, confirm: raw === undefined ? 0 : Number(raw), images: null };
}
const args = startArgs(process.argv.slice(2));
/** The backfill starts no new image after this long; a second run resumes (data-spec §8). */
const IMAGES_RUN_MS = 20 * 60 * 1000;

/**
 * A refusal to migrate is the operator's to act on: its message, then exit —
 * never a stack. Any other failure is named by class and code only: a driver's
 * message may quote a row's value (a duplicate key), and the log is no place
 * for it.
 */
async function orStop<T>(run: () => Promise<T>, refusals: readonly (new (...a: never[]) => Error)[], what: string): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const err = e as { name?: unknown; code?: unknown; message?: unknown };
    const said = refusals.some((r) => e instanceof r)
      ? String(err.message)
      : `${what} failed (${typeof err?.name === 'string' ? err.name : 'Error'}${typeof err?.code === 'string' ? ` ${err.code}` : ''}) — fix the database, then start again`;
    process.stderr.write(`backend: cannot start — ${said}\n`);
    process.exit(1);
  }
}

const applied = await orStop(() => migrate(db), [MigrationBusy], 'the auth migration');
if (applied.length > 0) process.stdout.write(`backend: applied migrations ${applied.join(', ')}\n`);

// The data tables, only when the site declares them: `data.json` and the
// data modules are part of the build only then.
const dataFile = new URL('../data.json', import.meta.url);
let data: DataRoutes | undefined;
let sweepImages: (() => Promise<number>) | undefined;
// Claiming an unverified account deletes the rows it wrote (store.ts).
let ownedRows: string[] = [];
if (existsSync(dataFile)) {
  const { loadTables, ownedRowDeletes } = await import('./data-values.ts');
  const { migrateData, DestructivePending, GuardFailed } = await import('./data-migrate.ts');
  const { createData, parseAdminEmails } = await import('./data-api.ts');
  const model = JSON.parse(readFileSync(dataFile, 'utf8')) as { steps: DataStep[] };
  const tables = loadTables(model);
  ownedRows = ownedRowDeletes(db.dialect, tables);
  // AZ_ADMIN_EMAILS (data-spec §11): a malformed entry stops the server, named.
  const admins = parseAdminEmails(process.env.AZ_ADMIN_EMAILS);
  if (!admins.ok) {
    process.stderr.write(`backend: cannot start — fix this in .env (see .env.example):\n  - ${admins.problem}\n`);
    process.exit(1);
  }
  const steps = await orStop(() => migrateData(db, model.steps, { confirm: args.confirm }), [DestructivePending, GuardFailed, MigrationBusy], 'the data migration');
  if (steps.length > 0) process.stdout.write(`backend: applied data steps ${steps.join(', ')}\n`);
  // The image library loads only when a table has an image field (data-spec §8).
  const images = config.setup.images === true
    ? await (await import('./data-images.ts')).createImages({ dir: config.filesDir })
    : undefined;
  const api = createData({
    db, tables, admins: admins.emails, publicUrl: config.publicUrl,
    ...(images ? { images, uploadLimit: config.uploadLimit } : {}),
    log: (line) => process.stderr.write(`backend: ${line}\n`),
  });
  data = api;
  if (images) sweepImages = api.sweepImages;
  if (args.images !== null) {
    const r = await api.backfillImages({ confirm: args.images === 'make', deadline: Date.now() + IMAGES_RUN_MS });
    process.stdout.write(args.images === 'count'
      ? `backend: ${r.left} stored image(s) have no width copies${r.left > 0 ? ' — make them with: node src/main.ts --images --confirm' : ''}\n`
      : `backend: gave ${r.widened} stored image(s) their width copies; ${r.skipped} skipped (missing or unreadable)${r.left > 0 ? `; ${r.left} left — run again to continue` : ''}\n`);
    await db.close();
    process.exit(0);
  }
}
if (args.images !== null) {
  process.stdout.write('backend: this server has no data tables, so no stored images\n');
  await db.close();
  process.exit(0);
}
if (args.migrate) {
  process.stdout.write('backend: migrations are up to date\n');
  await db.close();
  process.exit(0);
}

const store = createStore(db, config.secret, Date.now, { idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs }, ownedRows);
const app = createApp({ config, store, mailer: await createMailer(config), oidc: createOidc((...a) => fetch(...a)), ...(data ? { data } : {}) });
// The handler answers its own failures; requestListener is the last line.
// Its 500, like the answer to a request Node cannot parse, carries the
// security headers like every other response.
const server = createBackendServer(app.handler, (line) => process.stderr.write(`backend: ${line}\n`));
// An image upload of up to AZ_UPLOAD_MAX_MB needs longer than a JSON body.
server.requestTimeout = config.setup.images === true ? 120_000 : 15_000;
server.headersTimeout = 10_000;

const sweep = setInterval(() => app.sweep(), SWEEP_MS);
sweep.unref();
const prune = setInterval(() => {
  store.prune().catch((e: unknown) => process.stderr.write(`backend: prune failed: ${(e as Error).name}\n`));
}, PRUNE_MS);
prune.unref();
const fileSweep = sweepImages && setInterval(() => {
  sweepImages!().then(
    (n) => { if (n > 0) process.stdout.write(`backend: removed ${n} unreferenced image file(s)\n`); },
    (e: unknown) => process.stderr.write(`backend: image sweep failed: ${(e as Error).name}\n`));
}, FILE_SWEEP_MS);
fileSweep?.unref();

server.listen(config.port, config.host, () => {
  process.stdout.write(`backend: listening on http://${config.host}:${config.port} for ${config.allowedOrigins.join(', ')}\n`);
});

const stop = () => {
  clearInterval(prune);
  clearInterval(sweep);
  if (fileSweep) clearInterval(fileSweep);
  server.close(() => { void db.close().then(() => process.exit(0)); });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
