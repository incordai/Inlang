/**
 * @az server chat-report
 * Purpose: az backend usage — the chat's daily counts read from this server's database and printed for the operator; reads only.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §11.4)
 * Exports: usageText
 * Edit guide: read-only — no migration, no write; counts only, never a message, a share's text, an address or an account; a database failure is named by class and code, never its message.
 * Tests: packages/backend/test/chat-usage.test.ts, packages/cli/test/backend.test.ts
 */

/**
 * `node src/chat-report.ts [--json]` (run by `az backend usage <server-dir>`).
 *
 * The operator's view of what chat spent (§11.4), for any site with chat —
 * the one with data tables also shows it to its admins on /admin. It reads
 * the server's own `.env` as main.ts does, opens the database, and prints
 * today's spend against the daily budget, each of the last 30 days with
 * anything counted, and the shared answers kept. It changes nothing: a
 * server that has never started has no chat tables, and is told so.
 *
 * Copied into a generated server with a chat; imports only its siblings and node built-ins.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { UsageReport } from './chat-usage.ts';

const n = (v: number) => v.toLocaleString('en-US');

/** The report a person reads: today and the budget, the shares, then one row per day. */
export function usageText(r: UsageReport): string {
  const lines = [
    `chat usage — today is ${r.today} (UTC)`,
    `  budget ${n(r.budget.daily)} tokens a day · spent today ${n(r.budget.spent)} · left ${n(r.budget.left)}`,
    `  shared answers: ${r.shares.enabled ? 'on' : 'off (AZ_CHAT_SHARES=off)'} · ${n(r.shares.kept)} kept now`,
  ];
  if (r.days.length === 0) {
    lines.push('  nothing counted in the last 30 days');
  } else {
    const head = ['day', 'messages', 'input tokens', 'output tokens', 'dropped', 'shares'];
    const rows = r.days.map((d) => [d.day, n(d.messages), n(d.input), n(d.output), n(d.dropped), n(d.shares)]);
    const width = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    const line = (cells: readonly string[]) => `  ${cells.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ')}`;
    lines.push(line(head), ...rows.map(line));
  }
  return `${lines.join('\n')}\n`;
}

/** A database failure in one line: its class and code, never its message (a driver's may quote the URL). */
const failure = (e: unknown) => {
  const err = e as { name?: unknown; code?: unknown };
  return `${typeof err?.name === 'string' ? err.name : 'Error'}${typeof err?.code === 'string' ? ` ${err.code}` : ''}`;
};

/** Run from the server folder: its .env and its database, as main.ts reads them. */
async function main(argv: readonly string[]): Promise<number> {
  if (argv.some((a) => a !== '--json')) {
    process.stderr.write('backend: try: node src/chat-report.ts [--json]\n');
    return 2;
  }
  const { loadConfig } = await import('./env.ts');
  const site = JSON.parse(readFileSync(new URL('../az.config.json', import.meta.url), 'utf8')) as { siteName: string; database: 'sqlite' | 'postgres' | 'mysql'; email: 'smtp' | 'api'; images?: boolean; chat?: boolean };
  if (site.chat !== true) {
    process.stderr.write('backend: this site shows no chat — there is no chat usage\n');
    return 1;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  const loaded = loadConfig(process.env, { database: site.database, email: site.email, ...(site.images ? { images: true } : {}), chat: true }, site.siteName);
  if (!loaded.ok) {
    process.stderr.write(`backend: cannot read usage — fix these in .env (see .env.example):\n${loaded.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  const { config } = loaded;
  const chat = config.chat!;
  // A SQLite file that is not there yet is not made by a report.
  if (config.setup.database === 'sqlite' && !existsSync(config.sqlitePath)) {
    process.stderr.write(`backend: no database at ${config.sqlitePath} yet — start the server once; there is no usage to read\n`);
    return 1;
  }
  let ca: string | undefined;
  if (config.databaseCaFile) {
    try {
      ca = readFileSync(config.databaseCaFile, 'utf8');
    } catch {
      process.stderr.write(`backend: cannot read usage — AZ_DATABASE_CA_FILE: cannot read ${config.databaseCaFile}\n`);
      return 1;
    }
  }
  const { openMysql, openPostgres, openSqlite } = await import('./db.ts');
  const { usageReport } = await import('./chat-usage.ts');
  let db;
  try {
    db = config.setup.database === 'sqlite'
      ? await openSqlite(config.sqlitePath)
      : config.setup.database === 'postgres'
        ? await openPostgres(config.databaseUrl, config.databaseTls, ca)
        : await openMysql(config.databaseUrl, config.databaseTls, ca);
  } catch (e) {
    process.stderr.write(`backend: cannot read usage — the database did not open (${failure(e)})\n`);
    return 1;
  }
  try {
    const report = await usageReport(db, { dailyTokens: chat.dailyTokens, sharesEnabled: chat.shares.enabled }, Date.now());
    process.stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : usageText(report));
    return 0;
  } catch (e) {
    process.stderr.write(`backend: cannot read usage (${failure(e)}) — has the server started with chat once? It makes az_chat_usage then\n`);
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
