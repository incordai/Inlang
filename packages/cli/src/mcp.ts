/**
 * @az module mcp-cli
 * Purpose: the CLI's operations handed to the MCP server as a toolbox.
 * Spec: docs/mcp.md
 * Exports: toolbox, runMcp
 * Edit guide: each tool calls the same function its CLI command does, so they cannot drift.
 * Tests: packages/mcp/test/mcp.test.ts, packages/mcp/test/explain.test.ts, packages/mcp/test/palette.test.ts, packages/mcp/test/prompt.test.ts
 */

/**
 * `az mcp` — the CLI's operations, handed to the MCP server.
 *
 * packages/mcp owns the protocol, the tool schemas and the root sandbox; it
 * may not import from cli (ARCHITECTURE §2). So the CLI, the composition
 * root, builds the Toolbox here from the same functions its own commands run
 * — a tool call and the matching command cannot drift apart.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, explain, serialiseSpec, STRUCTURE_DESCRIPTIONS, type Diagnostic } from '../../core/src/index.ts';
import { colourChoices, colourChoicesJson, filterColourChoices } from '../../core/src/colour.ts';
import { serve } from '../../mcp/src/server.ts';
import type { KeywordEntry, Toolbox, ToolDiagnostic, WordEntry } from '../../mcp/src/tools.ts';
import { buildPrompt, promptJson, promptOptionsFrom } from '../../core/src/prompt.ts';
import { build, compileReader, promptInput, wordsFor } from './az.ts';
import { initBackendEnv } from './backend-init.ts';
import { addChat } from './add-chat.ts';
import { lockOption } from './data-schema.ts';
import { lintWords } from './lint.ts';
import { GRAMMAR_VERSION, migrate } from './migrate.ts';
import { BUNDLED_WORDS, eject, loadWords } from './words.ts';
import { doctor } from './doctor-checks.ts';
import { systemProbe } from './doctor.ts';
import { findNpmCli } from './serve.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(REPO, 'packages/cli/package.json'), 'utf8')) as { version: string }).version;

const toDiagnostic = (d: Diagnostic): ToolDiagnostic =>
  ({ code: d.code, severity: d.severity, line: d.pos.line, col: d.pos.col, message: d.message });

/** The words a file in this project compiles with: bundled, overridden by the project's own. */
const wordsDir = () => process.env.AZ_WORDS ?? BUNDLED_WORDS;

/**
 * Compile to diagnostics or a Spec — manifests only. A read-only tool never
 * runs the project's word code: an agent pointed at an untrusted folder can
 * check and read it without anything in it executing. Only az_build (marked
 * destructive, so a client asks first) loads the project's emitters.
 */
function compileFile(file: string) {
  const words = wordsFor({ source: file, wordsDir: wordsDir() }, false);
  return compile(readFileSync(file, 'utf8'), { manifests: words.manifests, lock: lockOption(file), readBytes: compileReader(file) });
}

export function toolbox(root: string): Toolbox {
  const projectWords = join(root, 'words');
  const rel = (abs: string) => relative(root, abs).split(sep).join('/');

  return {
    check: (file) => compileFile(file).diagnostics.map(toDiagnostic),

    spec: (file) => {
      const r = compileFile(file);
      return {
        spec: r.ok && r.spec ? JSON.parse(serialiseSpec(r.spec)) : null,
        diagnostics: r.diagnostics.map(toDiagnostic),
      };
    },

    build: (file, outDir) => {
      const r = build({ source: file, outDir, wordsDir: wordsDir() });
      return { ok: r.ok, files: r.files.map((f) => f.path), assets: r.assets, diagnostics: r.report };
    },

    lint: (dir) => {
      const target = dir ?? (existsSync(projectWords) ? projectWords : wordsDir());
      return lintWords(target);
    },

    words: () => {
      const { manifests } = loadWords(wordsDir(), projectWords, { code: false });
      return [...manifests.values()]
        .filter((m) => m.kind === undefined || m.kind === 'block')
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((m): WordEntry => ({
          name: m.name,
          description: m.description ?? '',
          descriptions: {
            variants: { ...m.descriptions?.variants },
            modifiers: { ...m.descriptions?.modifiers },
            ...(m.descriptions?.children ? { children: { ...m.descriptions.children } } : {}),
          },
          variants: m.variants ?? [],
          modifiers: m.modifiers ?? [],
          props: m.props ?? {},
          slots: (m as { slots?: Record<string, unknown> }).slots ?? {},
          docs: `docs/${m.name}-block-spec.md`,
        }));
    },

    wordDocs: (word) => {
      if (!/^[a-z][a-z0-9-]*$/.test(word)) return null;
      for (const dir of [projectWords, wordsDir()]) {
        const readme = join(dir, word, 'README.md');
        if (existsSync(join(dir, word, 'word.json')) && existsSync(readme)) return readFileSync(readme, 'utf8');
      }
      return null;
    },

    migrate: (file) => {
      const r = migrate(readFileSync(file, 'utf8'));
      if (!r.ok) return r;
      if (r.changed) writeFileSync(file, r.source, 'utf8');
      return { ok: true, changed: r.changed, from: r.from, to: GRAMMAR_VERSION };
    },

    eject: (word, projectDir) => {
      const r = eject(word, projectDir, wordsDir());
      return r.ok
        ? {
          ok: true,
          files: r.files.map((f) => rel(resolve(projectDir, f))),
          // Node cannot unload a module once loaded, so this process keeps
          // the first copy of an ejected emitter it builds with.
          note: 'restart the az mcp server after editing the ejected word — az_build keeps the version it first loaded',
        }
        : r;
    },

    backendInit: (serverDir) => {
      const r = initBackendEnv(serverDir);
      return r.ok ? { ok: true, path: r.path } : { ok: false, message: r.message };
    },

    // The same edit `az add chat` makes; the file is inside the root (the sandbox), and so is the .az-dev/ beside it.
    addChat: (file, options) => {
      const r = addChat({ file, ...options, wordsDir: wordsDir() });
      return r.ok ? r : { ok: false, message: r.message };
    },

    grammar: () => readFileSync(join(REPO, 'docs/GRAMMAR.md'), 'utf8'),

    keywords: () => Object.entries(STRUCTURE_DESCRIPTIONS)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, k]): KeywordEntry => ({
        name,
        description: k.description,
        settings: { ...(k.settings ?? {}) },
        values: Object.fromEntries(Object.entries(k.values ?? {}).map(([s, v]) => [s, { ...v }])),
      })),

    // Manifests only, and no module from the project's folders is loaded:
    // the built server's image library is left to `az doctor` in a terminal.
    // Paths print relative to the root as the sandbox resolved it (symlinks followed).
    doctor: (file, outDir) => doctor({
      source: file, outDir, cwd: realpathSync(root), wordsDir: wordsDir(), probe: systemProbe(findNpmCli), projectModules: false,
    }),

    // The build's output, read only; the advisory query only when asked.
    // Loaded on the first call, so az's start-up does not carry it.
    audit: async (outDir, online) => (await import('./audit.ts')).audit({ outDir, cwd: realpathSync(root), probe: systemProbe(findNpmCli), online }),

    // core's colour tables only: the same choices `az palette --json` prints.
    palette: (filter) => {
      const r = filterColourChoices(colourChoices(), filter);
      return r.ok ? { ok: true, palette: colourChoicesJson(r.choices) } : r;
    },

    // Manifests and previews as data (no project code runs): the same JSON `az prompt --json` prints.
    prompt: (raw) => {
      const parsed = promptOptionsFrom(raw);
      if (!parsed.ok) return parsed;
      const r = buildPrompt(promptInput(projectWords), parsed.options);
      return r.ok ? { ok: true, prompt: promptJson(r.prompt) } : r;
    },

    // Manifests only (no project code runs), like every read-only tool.
    explain: (terms) => explain(terms, loadWords(wordsDir(), projectWords, { code: false }).manifests),
  };
}

/** Serve MCP on stdio until the client closes stdin. */
export function runMcp(rootDir: string): Promise<void> {
  const root = resolve(rootDir);
  return serve({ root, toolbox: toolbox(root), version: VERSION });
}
