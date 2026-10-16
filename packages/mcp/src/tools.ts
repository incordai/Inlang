/**
 * @az module mcp-tools
 * Purpose: the tools az mcp offers, as data: schema, annotations and run.
 * Spec: docs/mcp.md
 * Exports: TOOLS, validate, ToolFailure, Toolbox
 * Edit guide: mark any tool that writes or runs project code; arguments are validated against own keys only.
 * Tests: packages/mcp/test/mcp.test.ts, packages/mcp/test/hardening.test.ts, packages/mcp/test/explain.test.ts, packages/mcp/test/palette.test.ts,
 *   packages/mcp/test/prompt.test.ts
 */

/**
 * The tools `az mcp` offers, as data an agent can read.
 *
 * Each tool's operation is INJECTED (`Toolbox`): the CLI is the composition
 * root (ARCHITECTURE §2 — nothing imports from cli), so it hands this package
 * the same functions its own commands run. This file owns only the names,
 * the input schemas, the sandbox, and the shape of what comes back.
 */

import { existsSync } from 'node:fs';
import { SandboxError, shown, type Sandbox } from './sandbox.ts';

/** One compiler diagnostic, as a client sees it. */
export interface ToolDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly line: number;
  readonly col: number;
  readonly message: string;
}

/** A word in the catalogue: everything an author may write under it. */
export interface WordEntry {
  readonly name: string;
  /** ≤60 characters each — what the word, its variants and modifiers mean. */
  readonly description: string;
  readonly descriptions: {
    readonly variants: Record<string, string>;
    readonly modifiers: Record<string, string>;
    readonly children?: Record<string, string>;
  };
  readonly variants: string[];
  readonly modifiers: string[];
  readonly props: Record<string, unknown>;
  readonly slots: Record<string, unknown>;
  readonly docs: string;
}

/** A structure keyword: its meaning, what can follow it, and closed values — each ≤60 characters. */
export interface KeywordEntry {
  readonly name: string;
  readonly description: string;
  readonly settings: Record<string, string>;
  readonly values: Record<string, Record<string, string>>;
}

/**
 * What the CLI supplies. Paths arriving here are already absolute and inside
 * the project root.
 */
export interface Toolbox {
  readonly check: (file: string) => ToolDiagnostic[];
  readonly spec: (file: string) => { spec: unknown | null; diagnostics: ToolDiagnostic[] };
  readonly build: (file: string, outDir: string) =>
    { ok: boolean; files: string[]; assets: string[]; diagnostics: string };
  readonly lint: (wordsDir: string | null) => { words: string[]; findings: unknown[] };
  readonly words: () => WordEntry[];
  /** Structure keywords (site, backend, data, allow…): no manifest, so listed apart from the words. */
  readonly keywords: () => KeywordEntry[];
  readonly wordDocs: (word: string) => string | null;
  readonly migrate: (file: string) =>
    { ok: true; changed: boolean; from: number; to: number } | { ok: false; message: string };
  readonly eject: (word: string, projectDir: string) =>
    { ok: true; files: string[]; note: string } | { ok: false; message: string };
  readonly backendInit: (serverDir: string) =>
    { ok: true; path: string } | { ok: false; message: string };
  /**
   * az add chat (chat-block-spec §19.15): the .az file edited in place — the
   * backend lines, a chat — and the dev server's model keys beside it, each
   * file backed up first; ends with az check. Refuses, changing nothing, on
   * a file that does not compile or an edit that would not.
   */
  readonly addChat: (file: string, options: { float: boolean; page: string | null; show: string[] | null; outDir: string }) =>
    { ok: true; changes: readonly string[]; kept: readonly string[]; backups: readonly string[]; check: string } | { ok: false; message: string };
  readonly grammar: () => string;
  /**
   * az doctor (word-quality-gate §5): this machine and the project, one line
   * and a fix per check. Reads only, installs nothing, never loads code from
   * the project, never reports an environment value.
   */
  readonly doctor: (file: string | null, outDir: string) => Promise<{
    ok: boolean;
    exit: number;
    counts: Record<string, number>;
    checks: readonly { id: string; status: string; line: string; fix?: readonly string[] }[];
  }>;
  /**
   * az audit (word-quality-gate §5): a build's output, one line and a fix
   * per check. Reads only; a secret is reported by file, offset and shape,
   * never by value; the network only when `online`.
   */
  readonly audit: (outDir: string, online: boolean) => ReturnType<Toolbox['doctor']>;
  /**
   * az palette --json (theme-spec §14; core's colour.ts): every colour
   * choice — themes, hues, pairs, patterns, origins — each with the `.az`
   * line that makes it; filtered by theme and hue. A filter naming no theme
   * or hue is `{ ok: false }`.
   */
  readonly palette: (filter: { theme?: string; accent?: string }) =>
    { ok: true; palette: unknown } | { ok: false; message: string };
  /**
   * az prompt --json (core's prompt.ts): the Markdown instructions any model
   * needs to write .az, generated from the compiler's tables, with its size.
   * `words` comma-separated, `budget` approximate tokens; a word that is not
   * one or a budget below the smallest prompt is `{ ok: false }`.
   */
  readonly prompt: (options: { words?: string; compact?: boolean; budget?: string }) =>
    { ok: true; prompt: unknown } | { ok: false; message: string };
  /** One line per term (`hero center` → hero, center); unknown terms get a suggestion. */
  readonly explain: (terms: string[]) => {
    lines: { term: string; kind: string; of: string; text: string }[];
    unknown: { term: string; suggestion: string | null }[];
  };
}

interface Schema {
  readonly type: 'object';
  readonly properties: Record<string, { type: 'string'; description: string }>;
  readonly required: string[];
  readonly additionalProperties: false;
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  /** MCP tool annotations: whether the tool can change files. */
  readonly annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  /** May answer later (az_doctor and az_audit wait on bounded child processes); the server awaits it. */
  readonly run: (args: Record<string, string>, box: Toolbox, sb: Sandbox) => unknown;
}

const obj = (props: Record<string, string>, required: string[]): Schema => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: 'string', description: d }])),
  required,
  additionalProperties: false,
});

/** Reads files only, and never runs the project's own code. */
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
/** Writes only files az generates or creates; refuses to replace one the user owns. */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
/**
 * May run the project's own code (its ejected or custom words' emitters, as
 * a build does) — so a client should ask before calling it on a folder it
 * does not trust. It also rewrites files it generated before.
 */
const RUNS_PROJECT_CODE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
/** Rewrites a file the author owns, in place. */
const REWRITES_SOURCE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

const FILE = 'Path to a .az file, relative to the project root.';

/** A tool reports failure in its result, not as a protocol error (MCP). */
export class ToolFailure extends Error {}

/** A file argument that must already exist; a clear tool error when it does not. */
function existing(sb: Sandbox, path: string): string {
  const abs = sb.resolve(path);
  if (!existsSync(abs)) throw new ToolFailure(`'${path}' does not exist in the project`);
  return abs;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'az_check',
    description: 'Compile a .az file and report its diagnostics (errors and warnings with line and column). A site without a theme line gets midnight: choose the colour (theme, accent, pattern) with the user first. Writes nothing.',
    inputSchema: obj({ file: FILE }, ['file']),
    annotations: READ,
    run: ({ file }, box, sb) => ({ diagnostics: box.check(existing(sb, file)) }),
  },
  {
    name: 'az_spec',
    description: 'Compile a .az file and return its resolved Spec (the target-agnostic JSON the web target renders), or null with diagnostics when it does not compile. Writes nothing.',
    inputSchema: obj({ file: FILE }, ['file']),
    annotations: READ,
    run: ({ file }, box, sb) => box.spec(existing(sb, file)),
  },
  {
    name: 'az_build',
    description: 'WRITES FILES AND RUNS PROJECT CODE. Compile a .az file into a runnable project in the output folder (default .az-build), copying referenced assets. Words the project owns (its words/ folder) are its own code and run during the build. Refuses to overwrite any file az did not generate, and removes files it generated before but no longer does. Returns the files written; the project\'s AZ.md opens with the site\'s colour lines and their legal values. Fails, writing nothing, on any compile error.',
    inputSchema: obj({ file: FILE, out: 'Output folder, relative to the project root. Default: .az-build' }, ['file']),
    annotations: RUNS_PROJECT_CODE,
    run: ({ file, out }, box, sb) => {
      const r = box.build(existing(sb, file), sb.resolve(out ?? '.az-build'));
      return { ...r, out: shown(sb.root, sb.resolve(out ?? '.az-build')) };
    },
  },
  {
    name: 'az_lint',
    description: 'Theme-token lint over word packs (raw colours, off-scale px, font-family, z-index, raw conditions). Default: the project\'s words/ folder if it has one, else the bundled words. Writes nothing.',
    inputSchema: obj({ wordsDir: 'Folder of word packs, relative to the project root.' }, []),
    annotations: READ,
    run: ({ wordsDir }, box, sb) => box.lint(wordsDir ? sb.resolve(wordsDir) : null),
  },
  {
    name: 'az_words',
    description: 'The word catalogue: every block word with its variants, modifiers, properties (type, allowed values, default, required) and slots; and every structure keyword (site, backend, data, allow…) with its settings. Use it to write valid .az. Writes nothing.',
    inputSchema: obj({}, []),
    annotations: READ,
    run: (_a, box) => ({ words: box.words(), keywords: box.keywords() }),
  },
  {
    name: 'az_explain',
    description: 'The cheapest lookup: one ≤60-character line per .az term, in context — "hero center" explains hero and its center variant; "hero height peek" a prop and its value; "backend database postgres" a keyword. For the colour step, which comes first: "theme" lists the themes, "theme accent" the hues and their gradient pairs. Unknown terms get a did-you-mean. Writes nothing.',
    inputSchema: obj({ terms: 'Terms as written in .az, space-separated, e.g. "hero center" or "nav sticky mobile drawer".' }, ['terms']),
    annotations: READ,
    run: ({ terms }, box) => {
      const list = terms.split(/\s+/).filter(Boolean);
      if (list.length === 0) throw new ToolFailure('terms is empty — e.g. "hero center"');
      return box.explain(list);
    },
  },
  {
    name: 'az_palette',
    description: 'Colour comes first: every theme (with its character), the accent hues each allows, the gradient pairs each allows, the pattern shapes and origins — each choice with the exact .az line that makes it, and an example block to paste under site. Optional filters: theme, accent. The same choices `az palette` shows as a gallery page. Writes nothing.',
    inputSchema: obj({ theme: 'Optional theme name, e.g. clay: only that theme.', accent: 'Optional hue, e.g. violet: only that hue and the pairs it is in.' }, []),
    annotations: READ,
    run: ({ theme, accent }, box) => {
      const r = box.palette({ ...(theme !== undefined ? { theme } : {}), ...(accent !== undefined ? { accent } : {}) });
      if (!r.ok) throw new ToolFailure(r.message);
      return r.palette;
    },
  },
  {
    name: 'az_prompt',
    description: 'The whole .az vocabulary as one Markdown block to put in a model\'s instructions: the authoring order (colour first), the syntax with a minimal site that compiles, the colour choices, every word with its variants and keys (types and allowed values), the backend and data rules, the common errors with their fixes. Generated from the compiler\'s tables, the same text `az prompt` prints. Optional: words (comma-separated), compact ("true"), budget (approximate tokens = characters / 4). Writes nothing.',
    inputSchema: obj({
      words: 'Optional comma-separated words, e.g. "hero,cta": only these in the words section.',
      compact: '"true" for the smallest prompt; default "false".',
      budget: 'Optional whole number of approximate tokens (characters / 4) to fit; parts drop in a fixed order.',
    }, []),
    annotations: READ,
    run: ({ words, compact, budget }, box) => {
      if (compact !== undefined && compact !== 'true' && compact !== 'false') throw new ToolFailure('compact is "true" or "false"');
      const r = box.prompt({
        ...(words !== undefined ? { words } : {}), compact: compact === 'true', ...(budget !== undefined ? { budget } : {}),
      });
      if (!r.ok) throw new ToolFailure(r.message);
      return r.prompt;
    },
  },
  {
    name: 'az_doctor',
    description: 'Check this machine and the project: Node and npm versions, known-bad combinations, the image library, that the file compiles, the data lock, tables without allow rules, unoptimised 3D models, files over budget, the backend .env (present, owner-only, required keys — names only, never values) and service keys a build would refuse. Each check: pass, warn, fail or skip, one line and the exact fix. Installs nothing, writes nothing.',
    inputSchema: obj({ file: 'Optional .az file, relative to the project root; without it only the machine is checked.', out: 'Output folder of a build, relative to the project root. Default: .az-build' }, []),
    annotations: READ,
    run: ({ file, out }, box, sb) => box.doctor(file ? existing(sb, file) : null, sb.resolve(out ?? '.az-build')),
  },
  {
    name: 'az_audit',
    description: 'Check a build\'s output (the folder az_build wrote, after its own npm run build): key-shaped strings in the files the site ships (file and offset only, never the value), Content-Security-Policy on every page and on the backend\'s responses, links that open a new tab without rel="noopener", and — only with online "true", a network call — dependency advisories for the build\'s lockfiles. Each check: pass, warn, fail or skip, one line and the exact fix. Installs nothing, writes nothing.',
    inputSchema: obj({ out: 'Output folder of a build, relative to the project root. Default: .az-build', online: '"true" to ask the advisory service for the dependencies (a network call); default "false".' }, []),
    annotations: READ,
    run: ({ out, online }, box, sb) => {
      if (online !== undefined && online !== 'true' && online !== 'false') throw new ToolFailure('online is "true" or "false"');
      return box.audit(sb.resolve(out ?? '.az-build'), online === 'true');
    },
  },
  {
    name: 'az_word_docs',
    description: 'The README of one word: purpose, example, variants, properties, accessibility notes and status. Writes nothing.',
    inputSchema: obj({ word: 'A word name, e.g. hero.' }, ['word']),
    annotations: READ,
    run: ({ word }, box) => {
      const text = box.wordDocs(word);
      if (text === null) throw new ToolFailure(`there is no word '${word}' — call az_words for the list`);
      return { word, readme: text };
    },
  },
  {
    name: 'az_grammar',
    description: 'The .az grammar reference (GRAMMAR.md): syntax, indentation, values, where each statement is legal, diagnostics. Also available as the resource az://grammar. Writes nothing.',
    inputSchema: obj({}, []),
    annotations: READ,
    run: (_a, box) => ({ grammar: box.grammar() }),
  },
  {
    name: 'az_migrate',
    description: 'REWRITES THE .az FILE IN PLACE. Upgrade a .az file to this compiler\'s grammar version, rewriting it only when a migration step changes it.',
    inputSchema: obj({ file: FILE }, ['file']),
    annotations: REWRITES_SOURCE,
    run: ({ file }, box, sb) => {
      const r = box.migrate(existing(sb, file));
      if (!r.ok) throw new ToolFailure(r.message);
      return r;
    },
  },
  {
    name: 'az_eject',
    description: 'WRITES FILES, ONE-WAY. Copy a bundled word into the project\'s words/ folder so the project owns and edits it; az never updates it again. Refuses if the word is already ejected.',
    inputSchema: obj({ word: 'The word to take ownership of, e.g. hero.' }, ['word']),
    annotations: WRITE,
    run: ({ word }, box, sb) => {
      const r = box.eject(word, sb.root);
      if (!r.ok) throw new ToolFailure(r.message);
      return { word, oneWay: true, files: r.files, note: r.note };
    },
  },
  {
    name: 'az_add_chat',
    description: 'REWRITES THE .az FILE IN PLACE, WRITES FILES AND RUNS PROJECT CODE. Add a working chat to a .az file: the backend lines it needs (database sqlite, model default), a chat panel on a page (default /, made when missing) or a chat float on every page, with a greeting and two suggested questions, open to anyone unless the site keeps accounts; and the model\'s keys, commented, in .az-dev/backend.env beside it. Backs up every file it changes (<file>.bak, never over an older backup), and ends with az check, which builds in memory with the project\'s own words. Refuses, changing nothing, when the file does not compile, is a link, or the edit would not pass az check. A second call adds nothing.',
    inputSchema: obj({
      file: FILE,
      page: 'The page the chat panel goes on, e.g. /help. Default: /.',
      float: '"true" for a chat float under site, on every page, instead of a panel.',
      show: 'What answers may hold besides text, comma-separated: all, a group (figures, sections) or components (faq,cta,chart…).',
    }, ['file']),
    annotations: REWRITES_SOURCE,
    run: ({ file, page, float, show }, box, sb) => {
      if (float !== undefined && float !== 'true' && float !== 'false') throw new ToolFailure("'float' is \"true\" or \"false\"");
      if (float === 'true' && page !== undefined) throw new ToolFailure('a float is on every page; page puts a panel on one — give one of them');
      const words = show === undefined ? null : show.split(',').map((w) => w.trim()).filter(Boolean);
      if (words !== null && words.length === 0) throw new ToolFailure("'show' needs a component or a group, e.g. all");
      const r = box.addChat(existing(sb, file), { float: float === 'true', page: page ?? null, show: words, outDir: sb.resolve('.az-build') });
      if (!r.ok) throw new ToolFailure(r.message);
      return { changes: r.changes, kept: r.kept, backups: r.backups.map((b) => shown(sb.root, b)), check: r.check };
    },
  },
  {
    name: 'az_backend_init',
    description: 'WRITES FILES. Create the built-in backend\'s .env (owner read/write only) in a built server/ folder, with a fresh session secret and empty slots for the rest. Returns the path, never the secret. Refuses to overwrite an existing .env.',
    inputSchema: obj({ serverDir: 'The server/ folder of a build, relative to the project root.' }, ['serverDir']),
    annotations: WRITE,
    run: ({ serverDir }, box, sb) => {
      const r = box.backendInit(sb.resolve(serverDir));
      if (!r.ok) throw new ToolFailure(r.message);
      return { path: shown(sb.root, r.path) };
    },
  },
];

/** Check arguments against a tool's schema: known keys, strings, required present. */
export function validate(tool: ToolDef, args: unknown): Record<string, string> {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolFailure('arguments must be an object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    // Own keys only: `constructor` or `toString` is not a declared argument.
    if (!Object.hasOwn(tool.inputSchema.properties, k)) throw new ToolFailure(`unknown argument '${k}'`);
    if (typeof v !== 'string') throw new ToolFailure(`'${k}' must be a string`);
    out[k] = v;
  }
  for (const k of tool.inputSchema.required) {
    if (!(k in out)) throw new ToolFailure(`missing required argument '${k}'`);
  }
  return out;
}

export const isUserError = (e: unknown): e is Error =>
  e instanceof ToolFailure || e instanceof SandboxError;
