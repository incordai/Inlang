/**
 * @az module add-chat
 * Purpose: `az add chat` — edit a .az file in place to add everything a working chat needs (the backend lines, a chat with a greeting and suggested questions), and the dev server's commented model keys; it ends with az check passing.
 * Spec: docs/chat-block-spec.md §19.15
 * Exports: planChat, addChat, ADD_CHAT_USAGE, ENV_MARK, ChatPlan, AddChatOptions, AddChatResult
 * Edit guide: refuse before writing anything — a file that does not compile, a link, an edit that would not compile; back up every file it changes (never over a backup); write by rename; a second run changes nothing.
 * Tests: packages/cli/test/add-chat.test.ts, scripts/add-chat-e2e.mjs
 */

/**
 * The words are easy ("add `chat panel`"); the lines around them were not:
 * a backend, a model, and — before chat-block-spec §19.15 — an auth adapter,
 * email and sign-in pages. This command writes what is needed and nothing
 * more, into the author's own file, keeping every line they wrote:
 *
 *   - `backend` with `database sqlite` and `model default` under `site`, or
 *     `model default` under the backend the file already has;
 *   - a `chat panel` at the end of a page (before its own footer) — `/` by
 *     default, `--page /help` for another, made when it does not exist — or
 *     `--float`, a `chat float` under `site` on every page; each with a
 *     title, a greeting, two suggested questions and, with `--show`, the
 *     components its answers may hold (`all`, a group, or words);
 *   - `allow anyone` when the site keeps no accounts (§19.15) — a chat for
 *     signed-in visitors would need email, an auth adapter and sign-in pages
 *     — and no `allow` line (signed-in visitors, the default) when it does;
 *   - in `.az-dev/backend.env`, the dev server's own settings, the model's
 *     four keys commented out with what each means: `az dev` answers from
 *     its demo script until one is filled in.
 *
 * Safety. It refuses, changing nothing, when the file is not a regular file
 * (a link is never written through), when it does not compile as it is,
 * when the edit would not pass `az check` (checked in memory first), or
 * when the target page leaves the chat out (`chat none`). Every file it
 * changes is copied to `<file>.bak` first (`<file>.bak.2`, … when one is
 * there: a backup is never overwritten), and written by rename, so a failed
 * write leaves the old file. A file that already has the chat, the backend
 * line and the keys is left as it is: running it twice adds nothing.
 */

import { copyFileSync, constants, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { lex } from '../../core/src/lex.ts';
import { parse, type Statement } from '../../core/src/parse.ts';
import { KEYS } from '../../backend/src/server/env.ts';
import { build, EXIT } from './az.ts';
import { DEV_DIR, devDir } from './dev-backend.ts';

export const ADD_CHAT_USAGE = `az add chat — add a working chat to a .az file, in place

  az add chat <file.az> [--page /route | --float] [--show all|<word>[,<word>…]]

  --page /route   a chat panel at the end of that page (default /); the page is made if missing
  --float         a chat float under site instead: a corner launcher on every page
  --show …        what answers may hold besides text: all, a group (figures, sections),
                  or components (faq,cta,chart…) — az explain show all lists them

It adds the backend lines a chat needs, the chat with a greeting and two
suggested questions, and the model's keys (commented) to ${DEV_DIR}/backend.env;
backs up every file it changes to <file>.bak; and ends with az check passing.
`;

/** The line `.az-dev/backend.env` gets once, before the keys: how a second run knows it is there. */
export const ENV_MARK = '# Chat model — written by az add chat';

/** The model keys the dev server reads to leave the demo script (env.ts KEYS, so their meanings are the server's own). */
const MODEL_KEYS = ['AZ_CHAT_API', 'AZ_CHAT_URL', 'AZ_CHAT_KEY', 'AZ_CHAT_MODEL'] as const;

const INDENT = '  ';
/** chat-block-spec §3.2: a title is at most 60 characters. */
const TITLE_MAX = 60;

export interface AddChatOptions {
  readonly file: string;
  /** A chat float under site; otherwise a panel on `page`. */
  readonly float: boolean;
  /** The page a panel goes on; `/` when null. */
  readonly page: string | null;
  /** `show`'s words as the author would write them, or null for none. */
  readonly show: readonly string[] | null;
  readonly wordsDir: string;
  /** Where `az check` looks for the build's `.env` files (its `--out`). */
  readonly outDir: string;
}

/** The edit, before anything is written: the new text, what changed and what was already there, a line each. */
export interface ChatPlan {
  readonly text: string;
  readonly changes: readonly string[];
  readonly kept: readonly string[];
  readonly allow: 'anyone' | 'signedin';
}

export type AddChatResult =
  | { readonly ok: true; readonly changes: readonly string[]; readonly kept: readonly string[]; readonly backups: readonly string[]; readonly check: string }
  | { readonly ok: false; readonly exit: number; readonly message: string };

/** The last line a statement and everything under it occupy (1-based). */
const lastLine = (s: Statement): number => Math.max(s.pos.line, ...s.children.map(lastLine));
const argOf = (s: Statement | undefined) => s?.args[0]?.value;

/** A quoted .az string: the text has no quote or backslash of its own (it is az's copy). */
const quoted = (s: string) => `"${s}"`;

/**
 * The edit `az add chat` makes to `text`, or why it cannot. Pure: the text
 * in, the text out; the caller checks and writes it. `text` compiled before
 * (the caller's check), so it has one site, and a backend with a database
 * if it has one at all.
 */
export function planChat(text: string, opts: Pick<AddChatOptions, 'float' | 'page' | 'show'>): ChatPlan | { readonly error: string } {
  const { file } = parse(lex(text).tokens);
  const site = file.body.find((s) => s.word === 'site');
  if (!site) return { error: 'the file has no site — every file needs: site <name>' };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // An insertion: after line `after` (1-based; 0 is the top), these lines.
  const inserts: { after: number; lines: string[] }[] = [];
  const changes: string[] = [];
  const kept: string[] = [];

  // ---- the backend: a model, and a database when there is no backend at all
  const backend = site.children.find((s) => s.word === 'backend');
  if (!backend) {
    inserts.push({ after: lastLine(site), lines: [`${INDENT}backend`, `${INDENT}${INDENT}database sqlite`, `${INDENT}${INDENT}model    default`] });
    changes.push('backend: added under site, with database sqlite and model default');
  } else if (!backend.children.some((s) => s.word === 'model')) {
    inserts.push({ after: lastLine(backend), lines: [`${INDENT}${INDENT}model    default`] });
    changes.push('backend: added model default (the operator picks the model in the server\'s .env)');
  } else {
    kept.push('backend: already talks to a model (model default)');
  }

  // ---- who may ask: a site with accounts keeps the default; one without opens the chat to anyone (§19.15)
  const auth = site.children.find((s) => s.word === 'auth');
  const accounts = argOf(auth?.children.find((s) => s.word === 'adapter')) === 'azbackend'
    && backend?.children.some((s) => s.word === 'email') === true;
  const allow = accounts ? 'signedin' : 'anyone';

  // ---- the chat
  const name = argOf(site) ?? 'this site';
  const title = `Ask ${name}`;
  const chatLines = (variant: 'panel' | 'float', depth: string) => [
    `${depth}chat ${variant}`,
    ...(title.length <= TITLE_MAX && !/["\\]/.test(title) ? [`${depth}${INDENT}title    ${quoted(title)}`] : []),
    `${depth}${INDENT}greeting ${quoted('Hi! Ask me anything about this site.')}`,
    `${depth}${INDENT}ask      ${quoted('What can you help me with?')}`,
    `${depth}${INDENT}ask      ${quoted('How do I get in touch?')}`,
    ...(opts.show && opts.show.length > 0 ? [`${depth}${INDENT}show     ${opts.show.join(' ')}`] : []),
    ...(allow === 'anyone' ? [`${depth}${INDENT}allow    anyone`] : []),
  ];
  const isChat = (s: Statement) => s.word === 'chat';
  const variantOf = (s: Statement) => argOf(s) ?? 'panel';
  const who = allow === 'anyone' ? 'open to anyone (allow anyone)' : 'for signed-in visitors (the site keeps accounts)';
  if (opts.float) {
    if (site.children.some((s) => isChat(s) && variantOf(s) === 'float')) {
      kept.push('chat: the site already has a chat float');
    } else {
      // The last of the site's lines — after a backend added above, which goes in at the same place first.
      inserts.push({ after: lastLine(site), lines: chatLines('float', INDENT) });
      changes.push(`chat: added a chat float under site, on every page, ${who}`);
    }
  } else {
    const route = opts.page ?? '/';
    const page = file.body.find((s) => s.word === 'page' && argOf(s) === route);
    if (page?.children.some((s) => isChat(s) && variantOf(s) === 'none')) {
      return { error: `page ${route} says chat none — remove that line first, or pick another page with --page` };
    }
    if (page?.children.some((s) => isChat(s))) {
      kept.push(`chat: page ${route} already has a chat`);
    } else if (page) {
      // At the end of the page, before its own footer, which always closes it.
      const footer = page.children.findIndex((s) => s.word === 'footer');
      const after = footer > 0 ? lastLine(page.children[footer - 1]) : footer === 0 ? page.pos.line : lastLine(page);
      inserts.push({ after, lines: chatLines('panel', INDENT) });
      changes.push(`chat: added a chat panel on ${route}, ${who}`);
    } else {
      // A new page at the end, a blank line before it; a file that ended with a newline still does.
      const end = lines.at(-1) === '' ? lines.length - 1 : lines.length;
      inserts.push({ after: end, lines: [...(end > 0 && lines[end - 1].trim() !== '' ? [''] : []), `page ${route}`, ...chatLines('panel', INDENT)] });
      changes.push(`page ${route}: added, with a chat panel ${who}`);
    }
  }

  if (inserts.length === 0) return { text, changes, kept, allow };
  // Bottom up, so each line number still names the line it did; at one place, the order written above.
  const out = [...lines];
  const ordered = inserts.map((ins, i) => ({ ...ins, i })).sort((a, b) => b.after - a.after || b.i - a.i);
  for (const ins of ordered) out.splice(ins.after, 0, ...ins.lines);
  return { text: out.join(newline), changes, kept, allow };
}

/** `.az-dev/backend.env` with the model's keys, commented, once; null when they are already there. */
function envPlan(current: string | null): string | null {
  if (current?.split(/\r?\n/).includes(ENV_MARK)) return null;
  const about = (k: string) => KEYS.find((x) => x.name === k)?.about ?? '';
  const block = [
    ENV_MARK,
    '# az dev answers from its demo script (.az-dev/chat-demo.json) until AZ_CHAT_API names a',
    '# real model: uncomment these and fill them in to try one. Keys live here or in the',
    '# built server\'s .env (az backend init), never in the .az file.',
    ...MODEL_KEYS.flatMap((k) => [`# ${about(k)}`, `# ${k}=${k === 'AZ_CHAT_API' ? 'completions' : ''}`]),
    '',
  ].join('\n');
  if (current === null || current === '') return block;
  return `${current}${current.endsWith('\n') ? '' : '\n'}\n${block}`;
}

/** The first `<path>.bak`, `<path>.bak.2`, … that does not exist: a backup is never overwritten. */
function backupPath(path: string): string {
  if (!existsSync(`${path}.bak`)) return `${path}.bak`;
  for (let n = 2; ; n++) if (!existsSync(`${path}.bak.${n}`)) return `${path}.bak.${n}`;
}

/** `text` to `path` by rename from a new file beside it: a failed write leaves the old file whole. A new file gets `mode`; an old one keeps its own. */
function writeByRename(path: string, text: string, mode = 0o644): void {
  const temp = `${path}.az-add.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: existsSync(path) ? lstatSync(path).mode & 0o777 : mode });
  try {
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** A regular file, or why it is not one to edit. */
function regularFile(path: string): string | null {
  if (!existsSync(path)) return `${path} does not exist`;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return `${path} is a link — az add chat edits the file itself; run it on the file the link points to`;
  if (!st.isFile()) return `${path} is not a file`;
  return null;
}

/**
 * `az add chat`: check the file as it is, plan the edit, check the edit in
 * memory, back up and write, then run `az check` on what was written. Any
 * failure before the writes changes nothing.
 */
export function addChat(opts: AddChatOptions): AddChatResult {
  const file = resolve(opts.file);
  const problem = regularFile(file);
  if (problem) return { ok: false, exit: EXIT.missing, message: problem };
  const check = (sourceText?: string) => build({ source: file, outDir: opts.outDir, wordsDir: opts.wordsDir, write: false, imageCache: null, ...(sourceText !== undefined ? { sourceText } : {}) });

  const before = check();
  if (!before.ok) {
    return { ok: false, exit: EXIT.missing, message: `${opts.file} does not compile as it is — fix it first, nothing was changed:\n${before.report}` };
  }
  const text = readFileSync(file, 'utf8');
  const plan = planChat(text, opts);
  if ('error' in plan) return { ok: false, exit: EXIT.missing, message: `${plan.error} — nothing was changed` };

  const envDir = join(dirname(file), DEV_DIR);
  if (existsSync(envDir) && lstatSync(envDir).isSymbolicLink()) {
    return { ok: false, exit: EXIT.missing, message: `${envDir} is a link — az add chat writes only beside the file; nothing was changed` };
  }
  const envFile = join(envDir, 'backend.env');
  const envProblem = existsSync(envFile) ? regularFile(envFile) : null;
  if (envProblem) return { ok: false, exit: EXIT.missing, message: `${envProblem} — nothing was changed` };
  const env = envPlan(existsSync(envFile) ? readFileSync(envFile, 'utf8') : null);

  if (plan.text === text && env === null) {
    return { ok: true, changes: [], kept: plan.kept, backups: [], check: `${before.report ? `${before.report}\n` : ''}az: no problems found` };
  }
  if (plan.text !== text) {
    const after = check(plan.text);
    if (!after.ok) {
      return { ok: false, exit: EXIT.missing, message: `the chat lines would not pass az check — nothing was changed:\n${after.report}` };
    }
  }

  // Every check passed: back up, then write — the .az file first, the dev keys after it.
  const backups: string[] = [];
  const changes = [...plan.changes];
  if (plan.text !== text) {
    const bak = backupPath(file);
    copyFileSync(file, bak, constants.COPYFILE_EXCL);
    backups.push(bak);
    writeByRename(file, plan.text);
  }
  if (env !== null) {
    try {
      devDir(dirname(file));
      if (existsSync(envFile)) {
        const bak = backupPath(envFile);
        copyFileSync(envFile, bak, constants.COPYFILE_EXCL);
        backups.push(bak);
      }
      // Owner-only when new: a model key may be filled in here.
      writeByRename(envFile, env, 0o600);
      changes.push(`${DEV_DIR}/backend.env: the model's keys, commented — az dev answers from its demo script until they are set`);
    } catch (e) {
      // The .az file is already written: put it back, so a failed run leaves both files as they were.
      if (plan.text !== text) writeByRename(file, text);
      return { ok: false, exit: EXIT.config, message: `${envFile} could not be written (${(e as Error).message}) — ${opts.file} was put back as it was` };
    }
  }

  const final = check();
  if (!final.ok) {
    // Cannot happen after the in-memory check of the same text; if it does, the file goes back.
    if (plan.text !== text) writeByRename(file, text);
    return { ok: false, exit: EXIT.missing, message: `az check failed after the edit, so ${opts.file} was put back as it was:\n${final.report}` };
  }
  return { ok: true, changes, kept: plan.kept, backups, check: `${final.report ? `${final.report}\n` : ''}az: no problems found` };
}
