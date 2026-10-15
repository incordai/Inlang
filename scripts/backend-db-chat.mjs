/**
 * The chat's usage table against REAL PostgreSQL and MySQL (the chat block
 * spec §6.5, §12): `az_chat_usage` created by its own migration, once; one
 * upsert statement per answer; two answers counted at once from two
 * connections both land; the UTC day rolls over; old days are swept; and a
 * chat answered through the route on this engine is counted. Run by
 * backend-db.mjs inside its containers.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { closeWithin } from './lib/bounded.mjs';
import { createApp } from '../packages/backend/src/server/app.ts';
import { createFakeAdapter } from '../packages/backend/src/server/chat-adapters.ts';
import { createChat, parseChatContext } from '../packages/backend/src/server/chat.ts';
import { createUsage, migrateChat, USAGE_KEEP_DAYS, utcDay } from '../packages/backend/src/server/chat-usage.ts';
import { loadConfig } from '../packages/backend/src/server/env.ts';
import { createOidc } from '../packages/backend/src/server/oidc.ts';
import { createStore } from '../packages/backend/src/server/store.ts';

const DB_CLOSE_MS = 15_000;
const FETCH_MS = 15_000;
const DAY = 24 * 60 * 60 * 1000;
const SITE = 'http://127.0.0.1:5173';

export async function chatSuite(engine, db, openAgain, check, url) {
  check(`${engine} chat: the usage migration applies`, (await migrateChat(db)).join() === '1');
  check(`${engine} chat: …and is a no-op the second time`, (await migrateChat(db)).length === 0);

  const usage = createUsage(db);
  const day = utcDay(Date.UTC(2026, 9, 15, 23, 59, 59));
  await usage.add(day, 100, 20, 0);
  await usage.add(day, 50, 5, 1);
  const row = await usage.row(day);
  check(`${engine} chat: one row per day, added to by one statement`, JSON.stringify(row) === JSON.stringify({ input: 150, output: 25, messages: 2, dropped: 1 }), JSON.stringify(row));

  // Two answers finishing at once, from two connections: both counted.
  const other = await openAgain();
  try {
    const fresh = utcDay(Date.UTC(2026, 9, 14));
    const second = createUsage(other);
    await Promise.all([
      ...Array.from({ length: 10 }, () => usage.add(fresh, 7, 3, 0)),
      ...Array.from({ length: 10 }, () => second.add(fresh, 7, 3, 0)),
    ]);
    const both = await usage.row(fresh);
    check(`${engine} chat: twenty concurrent answers over two connections are all counted (first row raced too)`,
      both?.messages === 20 && both.input === 140 && both.output === 60, JSON.stringify(both));
  } finally {
    await closeWithin(other, DB_CLOSE_MS, `${engine} second connection close`);
  }

  const next = utcDay(Date.UTC(2026, 9, 16, 0, 0, 0));
  await usage.add(next, 1, 1, 0);
  check(`${engine} chat: the day rolls over at 00:00 UTC into its own row`, (await usage.spent(next)) === 2 && (await usage.spent(day)) === 175);

  const now = Date.UTC(2026, 9, 16);
  await usage.add(utcDay(now - (USAGE_KEEP_DAYS + 3) * DAY), 9, 9, 0);
  check(`${engine} chat: the sweep removes only days past ${USAGE_KEEP_DAYS}`, (await usage.sweep(now)) === 1 && (await usage.spent(next)) === 2);

  // Through the route on this engine: an answer is counted in today's row.
  const loaded = loadConfig({
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'), AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9', AZ_ALLOWED_ORIGINS: SITE,
    AZ_EMAIL_FROM: 'x <x@studio.test>', AZ_DATABASE_URL: url, AZ_EMAIL_API_URL: 'http://127.0.0.1:9/send', AZ_EMAIL_API_KEY: 'k',
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: '/in-process.json',
  }, { database: engine, email: 'api', chat: true }, 'Studio');
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  // C2: the answer also holds a call to action off the allow-list, which the parser drops and the row counts.
  const context = parseChatContext(JSON.stringify({
    site: { name: 'Studio' }, pages: [], chats: { '/': { allow: 'anyone', limit: 5, show: ['cta'] } }, routes: ['/'],
    answer: { quotes: [], destinations: ['/'] },
  }));
  const chat = createChat({
    config: loaded.config.chat, secret: loaded.config.secret, db, prompt: 'Answer.', context,
    adapter: createFakeAdapter({ answers: [{ chunks: ['Hello.\ncta "Claim" https://evil.example/\n'], usage: { input: 40, output: 2 } }] }), log: () => {},
  });
  const app = createApp({ config: loaded.config, store: createStore(db, loaded.config.secret), mailer: { send: async () => {} }, oidc: createOidc(fetch), log: () => {}, chat });
  const server = createServer((q, r) => { void app.handler(q, r); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const before = await usage.spent(utcDay(Date.now()));
    const droppedBefore = (await usage.row(utcDay(Date.now())))?.dropped ?? 0;
    const r = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: 'POST', signal: AbortSignal.timeout(FETCH_MS),
      headers: { origin: SITE, 'x-az-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ page: '/', messages: [{ role: 'visitor', text: 'hi' }] }),
    });
    const body = await r.text();
    // The count is written just after the stream ends: wait for it, bounded.
    let after = before;
    for (const until = Date.now() + 5_000; after === before && Date.now() < until;) {
      after = await usage.spent(utcDay(Date.now()));
      if (after === before) await new Promise((res) => setTimeout(res, 50));
    }
    check(`${engine} chat: an answer through the route streams and is counted (42 tokens)`, r.status === 200 && /event: done/.test(body) && after - before === 42, `${r.status} ${after - before}`);
    const droppedAfter = (await usage.row(utcDay(Date.now())))?.dropped ?? 0;
    check(`${engine} chat: the component the parser dropped is counted in the day's row, and never sent`,
      droppedAfter - droppedBefore === 1 && !body.includes('evil.example') && !/event: block/.test(body), `${droppedAfter - droppedBefore}`);
  } finally {
    await closeWithin(server, DB_CLOSE_MS, `${engine} chat server close`);
  }
}
