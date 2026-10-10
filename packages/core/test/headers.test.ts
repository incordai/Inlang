/**
 * Every source file in scope opens with a true `@az` header — the owner's rule
 * that an AI can learn what a file renders, exports and how to edit it without
 * reading the whole file. Wrong docs are worse than none, so the header is
 * CHECKED against the code, not just for presence:
 *   - words: every manifest variant, modifier and prop is named, and every
 *     block class the emitter writes appears under Renders
 *   - modules: every name under Exports is exported by the file
 *   - both: every Tests path exists, every docs/…md under Spec exists
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Directories whose every .ts file must carry a header (recursively for runtimes). */
const SCOPE: [string, boolean][] = [
  ['packages/core/src', false], ['packages/cli/src', false], ['packages/mcp/src', false],
  ['packages/theme/src', false], ['packages/target-web/src', false],
  ['packages/overlay/src', true], ['packages/scene-runtime/src', true],
  ['packages/auth-runtime/src', true], ['packages/backend/src', true],
  // The words folder's own modules (registry.ts); each word's emitter is added below.
  ['packages/words', false],
];

const WORD_FIELDS = ['Purpose', 'Spec', 'Renders', 'Variants', 'Modifiers', 'Props', 'Styling', 'Behaviour', 'Edit guide', 'Tests'];
const MODULE_FIELDS = ['Purpose', 'Spec', 'Exports', 'Edit guide', 'Tests'];
const KINDS = new Set(['word', 'module', 'runtime', 'server']);

function files(): string[] {
  const out: string[] = [];
  const walk = (dir: string, deep: boolean) => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const p = join(dir, e);
      if (statSync(join(ROOT, p)).isDirectory()) { if (deep) walk(p, deep); }
      else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const [d, deep] of SCOPE) walk(d, deep);
  for (const w of readdirSync(join(ROOT, 'packages/words'))) {
    const f = join('packages/words', w, 'emit.web.ts');
    if (existsSync(join(ROOT, f))) out.push(f);
  }
  return out.sort();
}

interface Header { kind: string; name: string; fields: Record<string, string> }

/** Parse the leading `/** @az … *\/` block; null when there is none. */
export function parseHeader(src: string): Header | null {
  const m = /^\/\*\*\n \* @az (\S+) (\S+)\n([\s\S]*?)\n \*\/\n/.exec(src);
  if (!m) return null;
  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const raw of m[3].split('\n')) {
    const line = raw.replace(/^ \* ?/, '');
    const field = /^([A-Z][a-z]+(?: [a-z]+)?): (.*)$/.exec(line);
    if (field && !line.startsWith('  ')) { current = field[1]; fields[current] = field[2]; }
    else if (current) fields[current] += ` ${line.trim()}`;
  }
  return { kind: m[1], name: m[2], fields };
}

/** What is wrong with a header, as messages; empty when it is complete and true. */
function problems(file: string, src: string): string[] {
  const h = parseHeader(src);
  if (!h) return ['no @az header at the top of the file'];
  const out: string[] = [];
  if (!KINDS.has(h.kind)) out.push(`unknown kind '${h.kind}'`);
  const required = h.kind === 'word' ? WORD_FIELDS : MODULE_FIELDS;
  for (const f of required) if (!h.fields[f]?.trim()) out.push(`missing field '${f}'`);

  for (const t of (h.fields.Tests ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!existsSync(join(ROOT, t))) out.push(`Tests names '${t}', which does not exist`);
  }
  for (const d of (h.fields.Spec ?? '').match(/docs\/[A-Za-z0-9_.-]+\.md/g) ?? []) {
    if (!existsSync(join(ROOT, d))) out.push(`Spec names '${d}', which does not exist`);
  }

  if (h.kind === 'word') {
    const word = file.split('/')[2];
    if (h.name !== word) out.push(`header names '${h.name}', the folder is '${word}'`);
    const m = JSON.parse(readFileSync(join(ROOT, 'packages/words', word, 'word.json'), 'utf8'));
    const has = (field: string, term: string) => new RegExp(`(^|[^a-z0-9-])${term}([^a-z0-9-]|$)`).test(h.fields[field] ?? '');
    for (const v of m.variants ?? []) if (!has('Variants', v)) out.push(`Variants does not mention '${v}'`);
    for (const v of m.modifiers ?? []) if (!has('Modifiers', v)) out.push(`Modifiers does not mention '${v}'`);
    for (const p of Object.keys(m.props ?? {})) if (!has('Props', p)) out.push(`Props does not mention '${p}'`);
    const prefix = word === 'pricing' ? '(?:pricing|plan)' : word;
    const classes = new Set(src.match(new RegExp(`az-${prefix}(?:-[a-z0-9]+)+`, 'g')) ?? []);
    for (const c of classes) {
      if (c.endsWith('-') || c.startsWith(`az-${word}--`)) continue;
      if (!(h.fields.Renders ?? '').includes(c)) out.push(`Renders does not mention class '${c}'`);
    }
  } else {
    const exports = h.fields.Exports ?? '';
    if (!exports.trim().startsWith('(')) {
      for (const name of exports.split(',').map((s) => s.trim()).filter(Boolean)) {
        const declared = new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|class|interface|type|let)\\s+${name}\\b`).test(src);
        const listed = new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src);
        if (!declared && !listed) out.push(`Exports names '${name}', which the file does not export`);
      }
    }
  }
  return out;
}

test('CONTROL: the checker rejects a header that is missing, incomplete or false', () => {
  assert.deepEqual(problems('packages/core/src/x.ts', 'export const a = 1;\n'), ['no @az header at the top of the file']);
  const partial = '/**\n * @az module x\n * Purpose: p\n * Exports: a, ghost\n */\nexport const a = 1;\n';
  const found = problems('packages/core/src/x.ts', partial);
  assert.ok(found.includes("missing field 'Spec'"));
  assert.ok(found.includes("Exports names 'ghost', which the file does not export"));
  assert.ok(!found.some((f) => f.includes("'a'")), 'a real export is accepted');
  const badTest = '/**\n * @az module x\n * Purpose: p\n * Spec: docs/nope.md\n * Exports: a\n * Edit guide: e\n * Tests: packages/nope.test.ts\n */\nexport const a = 1;\n';
  assert.deepEqual(problems('packages/core/src/x.ts', badTest).sort(), [
    "Spec names 'docs/nope.md', which does not exist",
    "Tests names 'packages/nope.test.ts', which does not exist",
  ]);
});

test('CONTROL: the scope covers every package and every word', () => {
  const all = files();
  assert.ok(all.length >= 85, `only ${all.length} files in scope`);
  for (const d of ['core', 'cli', 'mcp', 'theme', 'target-web', 'overlay', 'scene-runtime', 'auth-runtime', 'backend', 'words']) {
    assert.ok(all.some((f) => f.startsWith(`packages/${d}/`)), d);
  }
  assert.ok(all.includes('packages/words/registry.ts'), 'the emitter registry is in scope');
});

for (const file of files()) {
  test(`${relative(ROOT, join(ROOT, file))} has a complete, true @az header`, () => {
    const found = problems(file, readFileSync(join(ROOT, file), 'utf8'));
    assert.deepEqual(found, []);
  });
}
