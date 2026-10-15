/**
 * Every block spec's worked example must compile.
 *
 * The docs are the source of truth for what a word accepts (ARCHITECTURE §3),
 * so an example a spec presents as valid AZ is a promise the compiler makes.
 * Nothing was checking that promise, and it was being broken: the faq spec's
 * own example failed with `AZ1207 text: 'body' is required`, because a slot
 * fill resolved its children against the ENCLOSING word's manifest instead of
 * the slot's own definition (link.ts) — so `text` under an `item` fell through
 * to the `text` BLOCK.
 *
 * Compiling the docs is the only check that scales: it re-reads all eleven
 * specs on every run, and a manifest that drifts from its spec fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/index.ts';
import { lex } from '../src/lex.ts';
import { routePath } from '../src/checks.ts';
import type { Manifest } from '../src/link.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCS = join(ROOT, 'docs');
const WORDS = join(ROOT, 'packages/words');

const manifests = new Map<string, Manifest>();
for (const n of readdirSync(WORDS)) {
  try {
    const m = JSON.parse(readFileSync(join(WORDS, n, 'word.json'), 'utf8')) as Manifest;
    manifests.set(m.name, m);
  } catch { /* not a word directory */ }
}

/** The first fenced block that starts with the `az 1` version line. */
function firstExample(md: string): string | null {
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^```/.test(lines[i])) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !/^```/.test(lines[j]); j++) body.push(lines[j]);
    if (body[0]?.trim() === 'az 1') return body.join('\n') + '\n';
    i = j;
  }
  return null;
}

/**
 * Make a fragment into a whole file.
 *
 * Most specs show a bare block, because a spec for `faq` should not have to
 * restate the site header. A file needs one, so it is added here — and the
 * example's own lines are indented under `page /` rather than rewritten.
 * The rest of that site is supplied the same way: a route the block links
 * to (`cta "Reserve" /reserve`) must be a declared page (GRAMMAR §4.1), and
 * those pages are the part of the site a block spec does not show. An
 * example that is a whole file (`site` at column 0) declares its own; one
 * that writes its own pages (`page` at column 0) is given only the header.
 */
function wholeFile(example: string): string {
  const body = example.split('\n').slice(1); // drop `az 1`
  if (body.some((l) => /^site\s/.test(l))) return example;
  const ownPages = body.filter((l) => /^page\s/.test(l)).map((l) => routePath(l.split(/\s+/)[1] ?? '/'));
  const main = ownPages.length > 0 ? body.join('\n')
    : `page /\n${body.map((l) => (l.trim() === '' ? '' : '  ' + l)).join('\n')}`;
  const declared = new Set(['/', ...ownPages]);
  const linked = [...new Set(lex(example).tokens.filter((t) => t.kind === 'route').map((t) => routePath(t.value)))]
    .filter((r) => !declared.has(r));
  return `az 1\nsite probe\n\n${main}\n${linked.map((r) => `page ${r}\n`).join('')}`;
}

const specs = readdirSync(DOCS).filter((f) => f.endsWith('-block-spec.md')).sort();

test('CONTROL: the block specs were found and each carries an example', () => {
  // If the glob or the extractor broke, the real test below would pass by
  // compiling nothing at all.
  assert.ok(specs.length >= 9, `only found ${specs.length}: ${specs.join(',')}`);
  const missing = specs.filter((f) => firstExample(readFileSync(join(DOCS, f), 'utf8')) === null);
  assert.deepEqual(missing, [], 'these specs have no `az 1` example to check');
});

for (const file of specs) {
  test(`${file} — its worked example compiles with no errors`, () => {
    const example = firstExample(readFileSync(join(DOCS, file), 'utf8'))!;
    const result = compile(wholeFile(example), { manifests });
    const errors = result.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.code} line ${d.pos.line}: ${d.message}`);
    assert.deepEqual(errors, [], '\n  ' + errors.join('\n  ') + '\n\nsource:\n' + wholeFile(example));
  });
}

test('CONTROL: a deliberately broken example IS rejected', () => {
  // Proves the assertions above can fail. Without it, a `compile` that
  // returned no diagnostics at all would make every test above pass.
  const bad = compile('az 1\nsite probe\n\npage /\n  nonesuchword wide\n', { manifests });
  assert.ok(bad.diagnostics.some((d) => d.severity === 'error'),
    'an unknown word must be an error');
});
