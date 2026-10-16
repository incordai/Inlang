/**
 * @az module doctor-chat
 * Purpose: az doctor's chat checks — the chat keys in the server's .env, the budget against one answer's cost, the built context against the tables.
 * Spec: docs/chat-block-spec.md §11.2 (and §6.4, §6.5, §8.1, §8.2, §20.7, §21.2.7, §21.4.3) · docs/word-quality-gate.md §5
 * Exports: CHAT_DOCTOR_CHECKS, chatEnvProblems, chatToolsProblems, chatMapState, answerCost, ChatServer
 * Edit guide: detect and instruct only; names, never values — a key's value, the model URL and the model id are never printed; a site without chat is a skip.
 * Tests: packages/cli/test/doctor-chat.test.ts
 */

/**
 * A site with chat has four more things that can be wrong before it goes
 * live, each its own line:
 *
 * - **chat .env** — the server's own validation of the chat keys
 *   (env.ts loadConfig) reduced to key names, and what it lets through but a
 *   deployment must not have: the scripted `fake` model, and a model URL
 *   that already ends in `/chat/completions` (the server adds that path).
 * - **chat tools** — the operator's data tools (§21.2), when any is
 *   declared: each declaration and its `_SAMPLE` as the server loads them,
 *   by key name; a tool the probe cannot call (required parameters and no
 *   sample); tools no chat can use.
 * - **chat budget** — whether AZ_CHAT_DAILY_TOKENS can pay for even one
 *   answer at the server's own estimate (§6.5: the prompt, the context and
 *   the most history, at CHARS_PER_TOKEN, plus AZ_CHAT_MAX_OUTPUT_TOKENS);
 *   a budget that cannot refuses every question (the tools' lines in the
 *   system text count too). The default left in place,
 *   and the kill switch on, are said too.
 * - **chat map** — a chat that shows maps (§21.4.3): the tile archives,
 *   glyph and sprite folders and attribution `.env` names, opened as the
 *   server opens them at start; maps that can only be lists (no archive);
 *   and a third-party tile archive the build was given
 *   (AZ_PUBLIC_MAP_TILES_URL), named by its origin — it learns where every
 *   visitor looks.
 * - **chat context** — the built `server/chat/context.json` as the server
 *   reads it: the tables a chat knows must still be ones a signed-out
 *   visitor may read and only admins write (the start-up check,
 *   chat-knows.ts knowsProblems), and their rules must be the ones the .az
 *   file has now — a table changed since the build is a rebuild away. A page
 *   the context cap leaves out (AZ1257) is a warning, judged by az build's own
 *   context builder (az.ts chatContextFor), text bodies kept in files read.
 */

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { SERVER_DIR } from '../../backend/src/emit.ts';
import { BUNDLED_WORLD, loadConfig, toolKey, type Setup } from '../../backend/src/server/env.ts';
import type { Check, CheckResult, DoctorContext } from './doctor.ts';
import { readRegular } from './shipped.ts';
import { DOTENV_FILES, parseDotenv } from './az.ts';

/** What the built server says of itself (az.config.json): its setup, and whether it has a chat. */
export type ChatServer = Setup & { readonly chat: boolean };

/** The built server's setup, or null when there is none az wrote. */
async function chatServer(serverDir: string): Promise<ChatServer | null> {
  let o: { database?: unknown; email?: unknown; data?: unknown; images?: unknown; chat?: unknown; map?: unknown };
  try {
    const text = await readRegular(join(serverDir, 'az.config.json'));
    if (text === null) return null;
    o = JSON.parse(text) as typeof o;
  } catch {
    return null;
  }
  const { database, email } = o ?? {};
  if (database !== 'sqlite' && database !== 'postgres' && database !== 'mysql') return null;
  // No email: a server without accounts (chat-block-spec §19.15); any other value is not a config az wrote.
  if (email !== undefined && email !== 'smtp' && email !== 'api') return null;
  return {
    database, ...(email !== undefined ? { email } : {}), ...(o.data === true ? { data: true } : {}), ...(o.images === true ? { images: true } : {}), chat: o.chat === true,
    ...(o.map === true ? { map: true } : {}),
  };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The path the completions shape is asked at; the server adds it to AZ_CHAT_URL. */
const COMPLETIONS_PATH = '/chat/completions';

/**
 * Why a deployment must not run with these chat keys: the server's own
 * refusals (key names only — some of its messages quote a value), the fake
 * model, and a URL with the completions path already on it.
 */
export function chatEnvProblems(setup: ChatServer, env: Readonly<Record<string, string>>): string[] {
  const loaded = loadConfig(env, { database: setup.database, email: setup.email, ...(setup.images === true ? { images: true } : {}), chat: true }, 'site');
  // A tool's keys are the chat tools line's.
  const refused = loaded.ok ? [] : [...new Set(loaded.problems.map((p) => /^AZ_[A-Z0-9_]+/.exec(p)?.[0] ?? '').filter((k) => k.startsWith('AZ_CHAT_') && !k.startsWith('AZ_CHAT_TOOL')))];
  const out = refused.map((k) => `${k} is refused by the server`);
  const api = (env.AZ_CHAT_API ?? '').trim().toLowerCase();
  if (api === 'fake') out.push('AZ_CHAT_API=fake answers from a script, for development only');
  const url = (env.AZ_CHAT_URL ?? '').trim();
  if (api === 'completions' && url !== '') {
    let path = '';
    try {
      path = new URL(url).pathname.replace(/\/+$/, '');
    } catch {
      // A URL the server refuses is named above.
    }
    if (path.endsWith(COMPLETIONS_PATH)) out.push(`AZ_CHAT_URL ends in ${COMPLETIONS_PATH} — the server adds that path, so it would ask ${COMPLETIONS_PATH}${COMPLETIONS_PATH}`);
  }
  return out;
}

/**
 * One answer's cost by the server's own estimate (chat.ts): the system text
 * (the prompt and the context; with `knows`, the most rows) and the most
 * history, at CHARS_PER_TOKEN, plus the output cap. `least` has no history
 * and no rows — the cheapest any question can be.
 */
export function answerCost(o: { readonly prompt: number; readonly context: number; readonly knows: number; readonly maxOutput: number; readonly charsPerToken: number; readonly historyChars: number; readonly tableChars: number }): { least: number; most: number } {
  const tokens = (chars: number) => Math.ceil(chars / o.charsPerToken);
  return {
    least: tokens(o.prompt + o.context) + o.maxOutput,
    most: tokens(o.prompt + o.context + o.historyChars + o.knows * o.tableChars) + o.maxOutput,
  };
}

/** The built server and its .env, for the two .env checks: a CheckResult when there is nothing to check. */
async function serverAndEnv(ctx: DoctorContext, title: string): Promise<{ setup: ChatServer; env: Record<string, string>; server: string } | CheckResult> {
  const server = join(ctx.outDir, SERVER_DIR);
  const setup = await chatServer(server);
  if (!setup) return { status: 'skip', line: `${title}: no built server — see the backend .env line` };
  if (!setup.chat) return { status: 'skip', line: `${title}: the site shows no chat` };
  const file = join(server, '.env');
  const s = await stat(file).catch(() => null);
  // backend .env says what is wrong with the file itself.
  if (!s?.isFile()) return { status: 'skip', line: `${title}: no server .env to read — see the backend .env line` };
  return { setup, env: parseEnv((await readRegular(file)) ?? '') as Record<string, string>, server };
}

const chatEnv: Check = {
  id: 'chat-env',
  title: 'chat .env',
  run: async (ctx) => {
    const got = await serverAndEnv(ctx, 'chat .env');
    if ('status' in got) return got;
    const problems = chatEnvProblems(got.setup, got.env);
    const example = '.env.example says what each takes';
    if (problems.length > 0) {
      return {
        status: 'fail',
        line: `chat .env: ${count(problems.length, 'problem')} — ${problems[0]}`,
        fix: [
          ...problems.slice(1),
          'set AZ_CHAT_API=completions with AZ_CHAT_URL (the API\'s base, …/v1) and AZ_CHAT_MODEL; az dev uses the fake model without any of them',
          example,
        ],
      };
    }
    const moderation = (got.env.AZ_CHAT_MODERATION_URL ?? '').trim() !== '' ? 'moderation hook on (it fails closed)' : 'no moderation hook (optional)';
    const shares = (got.env.AZ_CHAT_SHARES ?? 'on').trim().toLowerCase() === 'off' ? 'new shares off' : 'shares on';
    return { status: 'pass', line: `chat .env: the model keys are valid; ${moderation}; ${shares} — names checked, no value printed` };
  },
};

const chatBudget: Check = {
  id: 'chat-budget',
  title: 'chat budget',
  run: async (ctx) => {
    const got = await serverAndEnv(ctx, 'chat budget');
    if ('status' in got) return got;
    const loaded = loadConfig(got.env, { database: got.setup.database, email: got.setup.email, chat: true }, 'site');
    // A key the server refuses is the chat .env or backend .env line's; the budget is judged once every key is valid.
    if (!loaded.ok || !loaded.config.chat) {
      const chatKey = !loaded.ok ? loaded.problems.find((p) => p.startsWith('AZ_CHAT_')) : undefined;
      const which = chatKey === undefined ? 'backend .env' : chatKey.startsWith('AZ_CHAT_TOOL') ? 'chat tools' : 'chat .env';
      return { status: 'skip', line: `chat budget: judged once the server's keys are valid — see the ${which} line` };
    }
    const chat = loaded.config.chat;
    const context = await readRegular(join(got.server, 'chat', 'context.json'));
    // Each chat's own prompt file (chat-block-spec §19.16): the cheapest and the dearest bound one answer.
    const promptFiles = (() => {
      try {
        const chats = (JSON.parse(context ?? '') as { chats?: unknown }).chats;
        const files = chats && typeof chats === 'object' ? Object.values(chats).map((c) => (c as { prompt?: unknown } | null)?.prompt) : [];
        return files.every((f) => typeof f === 'string' && /^prompt-[0-9]+\.txt$/.test(f)) ? [...new Set(files as string[])] : [];
      } catch {
        return [];
      }
    })();
    const prompts = await Promise.all(promptFiles.map((f) => readRegular(join(got.server, 'chat', f))));
    if (context === null || promptFiles.length === 0 || prompts.some((p) => p === null)) {
      return { status: 'fail', line: 'chat budget: server/chat/ has no context.json, or not every prompt-<n>.txt it names — the server won\'t start', fix: ['rebuild with az build'] };
    }
    const lengths = prompts.map((p) => p!.length);
    const { CHARS_PER_TOKEN } = await import('../../backend/src/server/chat.ts');
    const { HISTORY_CHARS } = await import('../../backend/src/server/chat-text.ts');
    const known = (() => {
      try {
        const k = (JSON.parse(context) as { knows?: unknown }).knows;
        return Array.isArray(k) ? k.length : 0;
      } catch {
        return 0;
      }
    })();
    // chat-knows.ts KNOWS_LIMITS.tableChars, read only when a chat knows a table (that module ships with tables only).
    const tableChars = known > 0 ? (await import('../../backend/src/server/chat-knows.ts')).KNOWS_LIMITS.tableChars : 0;
    // The tools' lines in the per-request system text (chat-tools.ts toolsText), on a page that may use them.
    const toolChars = chat.tools.length > 0 ? (await import('../../backend/src/server/chat-tools.ts')).toolsText(chat.tools).length : 0;
    const costOf = (prompt: number) => answerCost({
      prompt: prompt + toolChars, context: context.length, knows: known, maxOutput: chat.maxOutputTokens,
      charsPerToken: CHARS_PER_TOKEN, historyChars: HISTORY_CHARS, tableChars,
    });
    const cost = { least: costOf(Math.min(...lengths)).least, most: costOf(Math.max(...lengths)).most };
    const daily = chat.dailyTokens;
    if (daily < cost.least) {
      return {
        status: 'fail',
        line: `chat budget: AZ_CHAT_DAILY_TOKENS ${daily} can't pay for one answer (at least ${cost.least} tokens by the server's estimate) — every question would answer budget_exhausted`,
        fix: [`raise AZ_CHAT_DAILY_TOKENS to at least ${cost.most} (one answer at its largest), or lower AZ_CHAT_MAX_OUTPUT_TOKENS`],
      };
    }
    const answers = Math.floor(daily / cost.most);
    const notes: string[] = [];
    if ((got.env.AZ_CHAT_DAILY_TOKENS ?? '').trim() === '') notes.push(`AZ_CHAT_DAILY_TOKENS is not set — the default ${daily} applies`);
    if (!chat.enabled) notes.push('AZ_CHAT_ENABLED=off — chat answers disabled to everyone');
    const line = `${daily} tokens a day pays for about ${answers} ${answers === 1 ? 'answer' : 'answers'} at the largest (${cost.most} tokens each by the server's estimate; ${chat.maxOutputTokens} out)`;
    if (notes.length > 0) {
      return {
        status: 'warn',
        line: `chat budget: ${notes.join('; ')}`,
        fix: [line, 'set AZ_CHAT_DAILY_TOKENS knowingly: past it chat answers budget_exhausted until 00:00 UTC; az backend usage shows what each day spent'],
      };
    }
    return { status: 'pass', line: `chat budget: ${line}` };
  },
};

/** A table as it decides what a chat may send: its rules, and each field's name, type and privacy. */
const tableShape = (t: { readonly rules: unknown; readonly fields: readonly { readonly name: string; readonly type: string; readonly private?: boolean }[] }) =>
  JSON.stringify({ rules: t.rules, fields: t.fields.map((f) => ({ name: f.name, type: f.type, private: f.private === true })) });

const chatContext: Check = {
  id: 'chat-context',
  title: 'chat context',
  run: async (ctx) => {
    const server = join(ctx.outDir, SERVER_DIR);
    const text = await readRegular(join(server, 'chat', 'context.json'));
    const c = ctx.source ? await ctx.compiled() : null;
    const spec = c !== null && 'result' in c ? c.result.spec : undefined;
    if (text === null) {
      return spec && (await import('../../target-web/src/chat.ts')).usesChat(spec)
        ? { status: 'warn', line: 'chat context: the site shows a chat, but its server is not built yet', fix: ['run: az build'] }
        : { status: 'skip', line: 'chat context: the build has no chat' };
    }
    const { parseChatContext } = await import('../../backend/src/server/chat.ts');
    const context = parseChatContext(text);
    if (typeof context === 'string') return { status: 'fail', line: `chat context: server/chat/context.json ${context} — the server won't start`, fix: ['rebuild with az build'] };
    const problems: string[] = [];
    if (context.knows.length > 0) {
      const data = await readRegular(join(server, 'data.json'));
      const { loadTables } = await import('../../backend/src/server/data-values.ts');
      let built: ReturnType<typeof loadTables> | undefined;
      try {
        built = data === null ? undefined : loadTables(JSON.parse(data));
      } catch {
        built = undefined;
      }
      const { knowsProblems } = await import('../../backend/src/server/chat-knows.ts');
      problems.push(...knowsProblems(context.knows, built));
      // The .az file's tables now, against the build's: a known table changed since is not what the server checks.
      const now = spec?.site.data;
      if (now && built) {
        for (const k of context.knows) {
          const a = now.find((t) => t.name === k.name);
          const b = built.find((t) => t.name === k.name);
          if (a && b && tableShape(a) !== tableShape(b)) problems.push(`the rules or fields of '${k.name}', which a chat knows, changed since the build`);
        }
      }
    }
    if (problems.length > 0) {
      return {
        status: 'fail',
        line: `chat context: ${problems[0]}`,
        fix: [...problems.slice(1), 'rebuild with az build — the server refuses to start when a known table is not public-read and admin-written, and reads the rules it was built with'],
      };
    }
    // AZ1257: a page the context's cap leaves out — judged by az build's own builder, text bodies kept in files read
    // through the same sandbox, so doctor and the build name the same pages.
    let omitted: readonly string[] = [];
    if (spec && ctx.source) {
      const { chatContextFor } = await import('./az.ts');
      const { PathEscapeError } = await import('../../target-web/src/emit.ts');
      const { MarkdownError } = await import('../../target-web/src/markdown.ts');
      try {
        omitted = chatContextFor(spec, dirname(ctx.source))?.omitted ?? [];
      } catch (e) {
        // The build refuses the same file, and says why; doctor names the check it could not finish.
        if (e instanceof PathEscapeError || e instanceof MarkdownError) {
          return { status: 'fail', line: 'chat context: a text body kept in a file cannot be read into the context — az build refuses it too', fix: ['run: az build, and fix what it names'] };
        }
        throw e;
      }
    }
    if (omitted.length > 0) {
      return {
        status: 'warn',
        line: `chat context: AZ1257 — ${count(omitted.length, 'page')} left out of what the model is told (${omitted.join(', ')}): the context is past its cap`,
        fix: ['shorten those pages, or show chat on fewer pages; az build names every page it leaves out'],
      };
    }
    return { status: 'pass', line: `chat context: matches the tables${context.knows.length > 0 ? ` — ${count(context.knows.length, 'known table')}, readable signed out, written by admins only` : ''}` };
  },
};

/**
 * The operator's data tools (chat-block-spec §21.2.7) as the server would
 * load them: each declaration and its `_SAMPLE`, by key name only. Names
 * what the server refuses, a tool `az backend probe` cannot call (required
 * parameters and no sample), and tools no chat can use (no `show` with a
 * chart, a table, stats or cards).
 */
export function chatToolsProblems(setup: ChatServer, env: Readonly<Record<string, string>>): { refused: string[]; unsampled: string[]; tools: string[] } {
  const loaded = loadConfig(env, { database: setup.database, email: setup.email, ...(setup.images === true ? { images: true } : {}), chat: true }, 'site');
  const refused = loaded.ok ? [] : [...new Set(loaded.problems.map((p) => /^AZ_CHAT_TOOL[A-Z0-9_]*/.exec(p)?.[0] ?? '').filter((k) => k !== ''))];
  const tools = loaded.ok && loaded.config.chat ? loaded.config.chat.tools : [];
  const unsampled = tools.filter((t) => t.sample === null && Object.values(t.params).some((p) => p.required)).map((t) => toolKey(t.name, 'SAMPLE'));
  return { refused, unsampled, tools: tools.map((t) => t.name) };
}

const chatToolsCheck: Check = {
  id: 'chat-tools',
  title: 'chat tools',
  run: async (ctx) => {
    const got = await serverAndEnv(ctx, 'chat tools');
    if ('status' in got) return got;
    if ((got.env.AZ_CHAT_TOOLS ?? '').trim() === '' && !Object.keys(got.env).some((k) => k.startsWith('AZ_CHAT_TOOL_') && k !== 'AZ_CHAT_TOOL_CALLS_PER_ADDRESS')) {
      return { status: 'skip', line: 'chat tools: none declared (AZ_CHAT_TOOLS is optional)' };
    }
    const { refused, unsampled, tools } = chatToolsProblems(got.setup, got.env);
    if (refused.length > 0) {
      return {
        status: 'fail',
        line: `chat tools: ${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} refused by the server — it won't start`,
        fix: ['each tool needs _URL (https, or http on localhost), _FIELDS and _LABEL; _PARAMS, _SAMPLE and _TIMEOUT_MS as .env.example says', 'names checked, no value printed'],
      };
    }
    // context.json says which chats show a chart, a table, stats, cards or an explore: only those may use a tool (§21.2.8 O5, §19.11, §21.3).
    const context = await readRegular(join(got.server, 'chat', 'context.json'));
    let usable = true;
    if (context !== null) {
      const { parseChatContext } = await import('../../backend/src/server/chat.ts');
      const c = parseChatContext(context);
      if (typeof c !== 'string') usable = Object.values(c.chats).some((x) => x.show.some((w) => w === 'chart' || w === 'table' || w === 'stats' || w === 'cards' || w === 'explore'));
    }
    const notes = [
      ...(unsampled.length > 0 ? [`${unsampled.join(', ')} ${unsampled.length === 1 ? 'is' : 'are'} not set — az backend probe can't call ${unsampled.length === 1 ? 'that tool' : 'those tools'} (${unsampled.length === 1 ? 'it requires' : 'they require'} parameters)`] : []),
      ...(usable ? [] : ['no chat shows a chart, a table, stats, cards or an explore, so no answer can use a tool']),
    ];
    const line = `${count(tools.length, 'tool')} declared (${tools.join(', ')}), each URL, parameter shape, field shape, label and sample valid`;
    if (notes.length > 0) return { status: 'warn', line: `chat tools: ${notes.join('; ')}`, fix: [line, 'set a _SAMPLE the endpoint answers, then run az backend probe'] };
    return { status: 'pass', line: `chat tools: ${line} — names checked, no value printed` };
  },
};

/** What a map check found (§21.4.3): the keys the server refuses, a file it cannot open, or what it serves. */
export type MapState =
  | { readonly kind: 'refused'; readonly keys: readonly string[] }
  | { readonly kind: 'unreadable'; readonly problem: string }
  | {
    readonly kind: 'ok'; readonly world: number | null; readonly region: number | null; readonly glyphs: boolean; readonly sprites: boolean; readonly geocoder: boolean;
    /** The world is the basemap the build bundled (chat-block-spec §19.15), not the operator's AZ_MAP_WORLD. */
    readonly bundled: boolean;
  };

/**
 * The map keys as the server reads them, and their files opened as it opens
 * them at start-up (backend chat-tiles.ts openTiles), each path taken from
 * the server's folder, where it runs. Key names only, never a value.
 */
export async function chatMapState(setup: ChatServer, env: Readonly<Record<string, string>>, server: string): Promise<MapState> {
  // The basemap the build copied, as the server finds it beside its src/ (§19.15).
  const bundled = join(server, BUNDLED_WORLD);
  const loaded = loadConfig(env, { database: setup.database, email: setup.email, ...(setup.images === true ? { images: true } : {}), chat: true, map: true }, 'site',
    { bundledWorld: existsSync(bundled) ? bundled : null });
  const refused = loaded.ok ? [] : [...new Set(loaded.problems.map((p) => /^AZ_(?:MAP|GEOCODER)_[A-Z_]+/.exec(p)?.[0] ?? '').filter((k) => k !== ''))];
  if (refused.length > 0) return { kind: 'refused', keys: refused };
  if (!loaded.ok || !loaded.config.map) return { kind: 'refused', keys: [] };
  const m = loaded.config.map;
  const at = (p: string | null) => (p === null || isAbsolute(p) ? p : join(server, p));
  const { openTiles, TilesProblem } = await import('../../backend/src/server/chat-tiles.ts');
  try {
    const files = await openTiles({ ...m, world: at(m.world), region: at(m.region), glyphs: at(m.glyphs), sprites: at(m.sprites) });
    return {
      kind: 'ok', world: files.archives.world?.header.maxZoom ?? null, region: files.archives.region?.header.maxZoom ?? null,
      glyphs: files.glyphs !== null, sprites: files.sprites !== null, geocoder: loaded.config.chat?.geocoder !== null && loaded.config.chat?.geocoder !== undefined,
      bundled: m.bundled,
    };
  } catch (e) {
    if (e instanceof TilesProblem) return { kind: 'unreadable', problem: e.message };
    throw e;
  }
}

const chatMap: Check = {
  id: 'chat-map',
  title: 'chat map',
  run: async (ctx) => {
    const got = await serverAndEnv(ctx, 'chat map');
    if ('status' in got) return got;
    if (got.setup.map !== true) return { status: 'skip', line: 'chat map: no chat shows a map' };
    const state = await chatMapState(got.setup, got.env, got.server);
    if (state.kind === 'refused') {
      return {
        status: 'fail', line: `chat map: ${state.keys.join(', ') || 'a map key'} ${state.keys.length === 1 ? 'is' : 'are'} refused by the server — it won't start`,
        fix: ['.env.example says what each map key takes — names checked, no value printed'],
      };
    }
    if (state.kind === 'unreadable') return { status: 'fail', line: `chat map: ${state.problem} — the server won't start`, fix: ['set the path from the server\'s folder, to a PMTiles v3 file or a folder the server can read'] };
    // The build's own environment, as az build reads it (the output folder's .env files, then the process): a third-party archive is the operator's choice, said.
    const files: Record<string, string> = {};
    for (const name of DOTENV_FILES) {
      const text = await readRegular(join(ctx.outDir, name));
      if (text !== null) parseDotenv(text, files);
    }
    const { MAP_TILES_ENV } = await import('../../target-web/src/chat.ts');
    const third = ({ ...files, ...ctx.probe.env } as Record<string, string | undefined>)[MAP_TILES_ENV]?.trim() ?? '';
    let origin: string | null = null;
    if (third !== '') {
      try {
        origin = new URL(third).origin;
      } catch {
        return { status: 'fail', line: `chat map: ${MAP_TILES_ENV} is not a URL — the build refuses it`, fix: [`set ${MAP_TILES_ENV} to the archive's https URL, or remove it to serve the tiles from this server`] };
      }
    }
    if (state.world === null && origin === null) {
      return {
        status: 'warn', line: `chat map: AZ_MAP_WORLD is not set and the server has no ${BUNDLED_WORLD} — every map shows its list of places only`,
        fix: ['rebuild the site: az build copies the default world basemap into the server', 'or make a world archive (zoom 0–6) and set AZ_MAP_WORLD and AZ_MAP_ATTRIBUTION; docs/self-hosting.md says how'],
      };
    }
    const parts = [
      origin !== null ? 'the world archive from a third party'
        : state.bundled ? `the bundled world basemap to zoom ${state.world} (land, lakes, borders)` : `the world archive to zoom ${state.world}`,
      ...(state.region !== null ? [`a regional extract to zoom ${state.region}`] : []),
      state.glyphs ? 'labels' : 'no labels (AZ_MAP_GLYPHS unset)',
      state.sprites ? 'icons' : 'no icons (AZ_MAP_SPRITES unset)',
      'attribution set',
      state.geocoder ? 'addresses placed by the geocoder' : 'no geocoder (optional)',
    ];
    if (origin !== null) {
      return {
        status: 'warn', line: `chat map: tiles come from ${origin} (${MAP_TILES_ENV}) — that third party learns where every visitor's maps look`,
        fix: [parts.join('; '), `remove ${MAP_TILES_ENV} and set AZ_MAP_WORLD to serve the tiles from this server only`],
      };
    }
    return { status: 'pass', line: `chat map: ${parts.join('; ')}; tiles, glyphs and sprites from this server only` };
  },
};

/** The chat's doctor checks, in the order they print. */
export const CHAT_DOCTOR_CHECKS: readonly Check[] = [chatEnv, chatToolsCheck, chatMap, chatBudget, chatContext];
