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

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createApp } from './app.ts';
import { migrate, openMysql, openPostgres, openSqlite, type Db } from './db.ts';
import { createMailer } from './email.ts';
import { loadConfig, type Setup } from './env.ts';
import { createOidc } from './oidc.ts';
import { createStore } from './store.ts';

const PRUNE_MS = 10 * 60 * 1000;

const site = JSON.parse(readFileSync(new URL('../az.config.json', import.meta.url), 'utf8')) as { siteName: string } & Setup;
if (existsSync('.env')) process.loadEnvFile('.env');

const loaded = loadConfig(process.env, { database: site.database, email: site.email }, site.siteName);
if (!loaded.ok) {
  process.stderr.write(`backend: cannot start — fix these in .env (see .env.example):\n${loaded.problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
const { config } = loaded;

const db: Db = config.setup.database === 'sqlite'
  ? await openSqlite(config.sqlitePath)
  : config.setup.database === 'postgres'
    ? await openPostgres(config.databaseUrl, config.databaseTls)
    : await openMysql(config.databaseUrl, config.databaseTls);
const applied = await migrate(db);
if (applied.length > 0) process.stdout.write(`backend: applied migrations ${applied.join(', ')}\n`);

const store = createStore(db, config.secret);
const app = createApp({ config, store, mailer: await createMailer(config), oidc: createOidc((...a) => fetch(...a)) });
const server = createServer((req, res) => { void app.handler(req, res); });
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

const prune = setInterval(() => {
  app.sweep();
  store.prune().catch((e: unknown) => process.stderr.write(`backend: prune failed: ${(e as Error).name}\n`));
}, PRUNE_MS);
prune.unref();

server.listen(config.port, config.host, () => {
  process.stdout.write(`backend: listening on http://${config.host}:${config.port} for ${config.allowedOrigins.join(', ')}\n`);
});

const stop = () => {
  clearInterval(prune);
  server.close(() => { void db.close().then(() => process.exit(0)); });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
