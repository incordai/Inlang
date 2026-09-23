/**
 * @az module mcp-cli
 * Purpose: the CLI's operations handed to the MCP server as a toolbox.
 * Spec: docs/mcp.md
 * Exports: toolbox, runMcp
 * Edit guide: each tool calls the same function its CLI command does, so they cannot drift.
 * Tests: packages/mcp/test/mcp.test.ts, packages/mcp/test/explain.test.ts
 */

/**
 * `az mcp` — the CLI's operations, handed to the MCP server.
 *
 * packages/mcp owns the protocol, the tool schemas and the root sandbox; it
 * may not import from cli (ARCHITECTURE §2). So the CLI, the composition
 * root, builds the Toolbox here from the same functions its own commands run
 * — a tool call and the matching command cannot drift apart.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, explain, serialiseSpec, type Diagnostic } from '../../core/src/index.ts';
import { serve } from '../../mcp/src/server.ts';
import type { Toolbox, ToolDiagnostic, WordEntry } from '../../mcp/src/tools.ts';
import { build, wordsFor } from './az.ts';
import { initBackendEnv } from './backend-init.ts';
import { lintWords } from './lint.ts';
import { GRAMMAR_VERSION, migrate } from './migrate.ts';
import { BUNDLED_WORDS, eject, loadWords } from './words.ts';

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
  return compile(readFileSync(file, 'utf8'), { manifests: words.manifests });
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

    grammar: () => readFileSync(join(REPO, 'docs/GRAMMAR.md'), 'utf8'),

    // Manifests only (no project code runs), like every read-only tool.
    explain: (terms) => explain(terms, loadWords(wordsDir(), projectWords, { code: false }).manifests),
  };
}

/** Serve MCP on stdio until the client closes stdin. */
export function runMcp(rootDir: string): Promise<void> {
  const root = resolve(rootDir);
  return serve({ root, toolbox: toolbox(root), version: VERSION });
}
