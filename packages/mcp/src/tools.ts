/**
 * @az module mcp-tools
 * Purpose: the tools az mcp offers, as data: schema, annotations and run.
 * Spec: docs/mcp.md
 * Exports: TOOLS, validate, ToolFailure, Toolbox
 * Edit guide: mark any tool that writes or runs project code; arguments are validated against own keys only.
 * Tests: packages/mcp/test/mcp.test.ts, packages/mcp/test/hardening.test.ts, packages/mcp/test/explain.test.ts
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
  /** May answer later (az_doctor waits on bounded child processes); the server awaits it. */
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
    description: 'Compile a .az file and report its diagnostics (errors and warnings with line and column). Writes nothing.',
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
    description: 'WRITES FILES AND RUNS PROJECT CODE. Compile a .az file into a runnable project in the output folder (default .az-build), copying referenced assets. Words the project owns (its words/ folder) are its own code and run during the build. Refuses to overwrite any file az did not generate, and removes files it generated before but no longer does. Returns the files written. Fails, writing nothing, on any compile error.',
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
    description: 'The cheapest lookup: one ≤60-character line per .az term, in context — "hero center" explains hero and its center variant; "hero height peek" a prop and its value; "backend database postgres" a keyword. Unknown terms get a did-you-mean. Writes nothing.',
    inputSchema: obj({ terms: 'Terms as written in .az, space-separated, e.g. "hero center" or "nav sticky mobile drawer".' }, ['terms']),
    annotations: READ,
    run: ({ terms }, box) => {
      const list = terms.split(/\s+/).filter(Boolean);
      if (list.length === 0) throw new ToolFailure('terms is empty — e.g. "hero center"');
      return box.explain(list);
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
