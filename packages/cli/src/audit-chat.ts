/**
 * @az module audit-chat
 * Purpose: az audit's chat checks — the shared-answer page's policy and noindex, the server's chat context against its tables, the page runtime's sinks.
 * Spec: docs/chat-block-spec.md §11.2 (and §6.3, §8.1, §8.2, §20.7) · docs/word-quality-gate.md §5
 * Exports: CHAT_AUDIT_CHECKS, contextProblems, runtimeSinks, CONTEXT_FILE_MAX
 * Edit guide: read-only; a check of a site without chat is a skip, never a failure; a value is never printed — tables and fields by name, files by path.
 * Tests: packages/cli/test/audit-chat.test.ts, packages/cli/test/audit.test.ts
 */

/**
 * What a chat adds to a build, checked after it is built (az doctor checks
 * the source and the `.env`; this checks what ships and what the server
 * will read):
 *
 * - **the shared-answer page** (`/chat/shared`, §20.7) is opened by
 *   strangers from a link: it must say `noindex` and carry a strict policy;
 * - **the chat context** (`server/chat/context.json`) is sent to a model
 *   provider with every question: every table it names must be one a
 *   signed-out visitor may read, every field public, and every table a chat
 *   `knows` written by the site's admins only — the very checks the server
 *   makes before it starts (chat-knows.ts knowsProblems), here before it is
 *   deployed — and it must hold nothing shaped like a key;
 * - **the page runtime** copied into the site (`src/az/chat*.ts`) must have
 *   no way from a string to markup or code: no `innerHTML`,
 *   `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval` or
 *   `Function`. The bundle itself mixes the runtime with the UI library's
 *   own code, which uses some of these by design, so the runtime is judged
 *   in the copies the build bundled — and a copy that differs from az's own
 *   is said to.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../core/src/secrets.ts';
import { SERVER_DIR } from '../../backend/src/emit.ts';
import { RUNTIME_DIR } from '../../target-web/src/emit.ts';
import { CHAT_RUNTIME_FILES } from '../../target-web/src/chat.ts';
import type { ContextTable } from '../../backend/src/server/chat.ts';
import type { Table } from '../../backend/src/server/data-values.ts';
import type { AuditContext } from './audit.ts';
import type { Check } from './doctor.ts';
import { readRegular } from './shipped.ts';

/** context.json is at most a few tens of KB as a build writes it (§8.1's 24 000-character cap and the schemas); past this it is not one. */
export const CONTEXT_FILE_MAX = 1024 * 1024;

/** az's own copies of the page runtime, which a build copies verbatim. */
const RUNTIME_SOURCE = fileURLToPath(new URL('../../overlay/src/runtime/', import.meta.url));

/** §11.2: a way from a string to markup or code. */
const SINKS: readonly (readonly [RegExp, string])[] = [
  [/\binnerHTML\b/, 'innerHTML'], [/\bouterHTML\b/, 'outerHTML'], [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\bdocument\.write/, 'document.write'], [/\beval\s*\(/, 'eval('], [/\bFunction\s*\(/, 'Function('],
];

/** The sinks one runtime file's code uses — comments may name what the code never does, so they are left out. */
export function runtimeSinks(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return SINKS.filter(([re]) => re.test(code)).map(([, name]) => name);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Why the server's chat context must not be deployed with these tables:
 * what the server would refuse to start with (knowsProblems), and a table
 * figures are asked of that strangers can't read, or a field of it that is
 * private, an image or not there. Names only.
 */
export async function contextProblems(context: { readonly tables: readonly ContextTable[]; readonly knows: readonly ContextTable[] }, tables: readonly Table[] | undefined): Promise<string[]> {
  const { knowsProblems } = await import('../../backend/src/server/chat-knows.ts');
  const { grant } = await import('../../backend/src/server/data-api.ts');
  const out = knowsProblems(context.knows, tables);
  for (const c of context.tables) {
    const t = tables?.find((x) => x.name === c.name);
    if (!t) { out.push(`chat figures name '${c.name}', which the server has no table for`); continue; }
    const g = grant(t.rules.read, null);
    if (!g.ok || g.ownerOnly) out.push(`chat figures name '${c.name}', which signed-out visitors can't read`);
    for (const f of c.fields) {
      const field = t.fields.find((x) => x.name === f.name);
      if (!field) out.push(`chat figures name '${c.name}.${f.name}', which the table does not have`);
      else if (field.private) out.push(`chat figures name '${c.name}.${f.name}', which is private`);
      else if (field.type === 'image') out.push(`chat figures name '${c.name}.${f.name}', an image field`);
    }
  }
  return out;
}

const rebuild = 'rebuild with az build — server/chat/ is generated from the .az file, never edited';

const sharedPage: Check<AuditContext> = {
  id: 'chat-shared-page',
  title: 'chat shared page',
  run: async (ctx) => {
    const site = await ctx.site();
    if (site.kind === 'missing') return { status: 'skip', line: 'chat shared page: no built site — see the bundle secrets line' };
    if (site.kind === 'unanswered') return { status: 'skip', line: 'chat shared page: the built site was not read — see the bundle secrets line' };
    if (site.shared === null) return { status: 'skip', line: 'chat shared page: the site has no shared-answer page (no chat that shows components)' };
    const problems = [
      ...(site.shared.noindex ? [] : ['no robots noindex — search engines may list shared answers']),
      ...(site.shared.policies === 0 ? ['no Content-Security-Policy'] : site.shared.gaps),
    ];
    if (problems.length > 0) {
      return {
        status: 'fail',
        line: `chat shared page: /chat/shared — ${problems.join('; ')}`,
        fix: ['az build gives the page both (chat-block-spec §20.7): rebuild with this az, then npm run build in the output — the page is generated, never edited'],
      };
    }
    return { status: 'pass', line: 'chat shared page: /chat/shared says noindex and has a strict policy' };
  },
};

const chatContext: Check<AuditContext> = {
  id: 'chat-context',
  title: 'chat context',
  run: async (ctx) => {
    const server = join(ctx.outDir, SERVER_DIR);
    const file = join(server, 'chat', 'context.json');
    const s = await stat(file).catch(() => null);
    if (!s) return { status: 'skip', line: 'chat context: the build has no chat server' };
    if (!s.isFile() || s.size > CONTEXT_FILE_MAX) {
      return { status: 'fail', line: `chat context: server/chat/context.json is ${s.isFile() ? `over ${CONTEXT_FILE_MAX / 1024 / 1024}MB` : 'not a regular file'} — not one az build writes`, fix: [rebuild] };
    }
    const text = (await readRegular(file)) ?? '';
    const { parseChatContext } = await import('../../backend/src/server/chat.ts');
    const context = parseChatContext(text);
    if (typeof context === 'string') return { status: 'fail', line: `chat context: server/chat/context.json ${context} — the server would refuse to start`, fix: [rebuild] };
    // Shaped like a key: by its rule, never by a character of it.
    const keys = scanText(text).filter((f) => f.rule !== 'entropy');
    const named = context.tables.length + context.knows.length;
    let tables: Table[] | undefined;
    if (named > 0) {
      const data = await readRegular(join(server, 'data.json'));
      if (data !== null) {
        const { loadTables } = await import('../../backend/src/server/data-values.ts');
        try {
          tables = loadTables(JSON.parse(data));
        } catch {
          return { status: 'fail', line: 'chat context: server/data.json can\'t be read as the server reads it', fix: [rebuild] };
        }
      }
    }
    const problems = [...(await contextProblems(context, tables)), ...keys.map((k) => `a ${k.rule}-shaped string at ${k.where.replace(/^@/, 'offset ')}`)];
    if (problems.length > 0) {
      return {
        status: 'fail',
        line: `chat context: ${count(problems.length, 'problem')} in what every question sends the model — ${problems[0]}`,
        fix: [...problems.slice(1, 5), ...(problems.length > 5 ? [`and ${problems.length - 5} more`] : []), rebuild],
      };
    }
    return {
      status: 'pass',
      line: `chat context: public content only — ${count(context.tables.length, 'table')} for figures and ${count(context.knows.length, 'known table')}, each readable signed out, every field public${context.knows.length > 0 ? ', known tables written by admins only' : ''}`,
    };
  },
};

const chatRuntime: Check<AuditContext> = {
  id: 'chat-runtime',
  title: 'chat runtime',
  run: async (ctx) => {
    const found: string[] = [];
    const differs: string[] = [];
    let files = 0;
    for (const f of CHAT_RUNTIME_FILES) {
      const built = await readRegular(join(ctx.outDir, RUNTIME_DIR, f));
      if (built === null) continue;
      files++;
      for (const sink of runtimeSinks(built)) found.push(`${RUNTIME_DIR}/${f}: ${sink}`);
      const own = await readRegular(join(RUNTIME_SOURCE, f));
      if (own === null || own.replace(/\r\n/g, '\n') !== built.replace(/\r\n/g, '\n')) differs.push(`${RUNTIME_DIR}/${f}`);
    }
    if (files === 0) return { status: 'skip', line: 'chat runtime: the site has no chat' };
    if (found.length > 0) {
      return {
        status: 'fail',
        line: `chat runtime: ${count(found.length, 'way')} from a string to markup or code in the chat's page runtime — a model's words could run as code`,
        fix: [...found.slice(0, 5), 'the runtime is az\'s and copied verbatim: rebuild with az build, and never edit the copies'],
      };
    }
    if (differs.length > 0) {
      return {
        status: 'warn',
        line: `chat runtime: no sink, but ${differs.join(', ')} ${differs.length === 1 ? 'is' : 'are'} not what this az writes`,
        fix: ['rebuild with az build — the runtime is generated, never edited'],
      };
    }
    return { status: 'pass', line: `chat runtime: ${count(files, 'file')}, none with innerHTML, insertAdjacentHTML, outerHTML, document.write, eval or Function` };
  },
};

/** The chat's audit checks, in the order they print. */
export const CHAT_AUDIT_CHECKS: readonly Check<AuditContext>[] = [sharedPage, chatContext, chatRuntime];
