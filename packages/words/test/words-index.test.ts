/**
 * docs/WORDS.md and the root README's words catalogue are GENERATED
 * (scripts/gen-words-index.mjs) from each word's word.json, README and
 * emit.web.ts header. This test is what keeps them true: the committed files
 * must equal a fresh run, byte for byte, so a word, variant or key changed
 * without regenerating fails here instead of misleading the next reader.
 *
 * The README's own example and command table are checked too: the example
 * must compile, and every command the README lists must be one `az --help`
 * prints, and the other way round.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATALOGUE_END, CATALOGUE_START, INDEX_FILE, README_FILE, ROOT,
  catalogueSource, loadWords, withCatalogue, wordsIndexSource,
} from '../../../scripts/gen-words-index.mjs';
import { compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';

const REGENERATE = 'regenerate with: node scripts/gen-words-index.mjs';
const words = loadWords();
const index = readFileSync(join(ROOT, INDEX_FILE), 'utf8');
const readme = readFileSync(join(ROOT, README_FILE), 'utf8');

test('docs/WORDS.md is exactly the generator output — no hand edits, no drift', () => {
  assert.equal(index, wordsIndexSource(words), REGENERATE);
});

test('README.md holds exactly the generated words catalogue', () => {
  assert.equal(readme, withCatalogue(readme, words), REGENERATE);
  assert.equal(readme.split(CATALOGUE_START).length, 2, 'one catalogue start marker');
  assert.equal(readme.split(CATALOGUE_END).length, 2, 'one catalogue end marker');
});

test('every word, variant, modifier and key is in the index with its info line', () => {
  for (const { manifest: m } of words) {
    assert.ok(index.includes(`## \`${m.name}\`\n\n${m.description}\n`), `${m.name}: heading and info line`);
    const terms = m as unknown as {
      variants?: string[]; modifiers?: string[]; props?: Record<string, { description: string }>;
      descriptions?: { variants?: Record<string, string>; modifiers?: Record<string, string> };
    };
    for (const v of terms.variants ?? []) assert.ok(index.includes(terms.descriptions?.variants?.[v] ?? '\0'), `${m.name} ${v}`);
    for (const v of terms.modifiers ?? []) assert.ok(index.includes(terms.descriptions?.modifiers?.[v] ?? '\0'), `${m.name} ${v}`);
    for (const [k, p] of Object.entries(terms.props ?? {})) assert.ok(index.includes(`| \`${k}\` |`) && index.includes(p.description), `${m.name} ${k}`);
  }
});

test('CONTROL: a changed info line or a new variant changes both outputs', () => {
  const tampered = structuredClone(words);
  tampered[0].manifest.description = 'Changed without regenerating';
  tampered[1].manifest.variants = [...(tampered[1].manifest.variants ?? []), 'extra'];
  assert.notEqual(wordsIndexSource(tampered), index);
  assert.notEqual(catalogueSource(tampered), catalogueSource(words));
  assert.notEqual(withCatalogue(readme, tampered), readme);
});

test('CONTROL: a README without the catalogue markers is refused, not silently skipped', () => {
  assert.throws(() => withCatalogue('# no markers\n', words), /markers are missing/);
});

test("README.md's example compiles without errors", () => {
  const block = /```az\n([\s\S]*?)```/.exec(readme);
  assert.ok(block, 'README.md shows an ```az example');
  const manifests = new Map<string, Manifest>(words.map((w) => [w.manifest.name, w.manifest as unknown as Manifest]));
  const r = compile(block[1], { manifests });
  assert.ok(r.ok, formatDiagnostics(r.diagnostics, 'README.md example'));
  assert.equal(r.diagnostics.length, 0, formatDiagnostics(r.diagnostics, 'README.md example'));
});

test("README.md's command table matches `az --help`, both ways", () => {
  const help = spawnSync(process.execPath, [join(ROOT, 'packages/cli/bin/az.js'), '--help'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(help.status, 0, help.stderr);
  const commandsIn = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map((m) => m[1]));
  const helpCommands = commandsIn(help.stdout, /^ {2}az (\w+(?: (?:init|plan|schema|images))?)/gm);
  const readmeCommands = commandsIn(readme, /^\| `az (\w+(?: (?:init|plan|schema|images))?)[ `]/gm);
  assert.ok(helpCommands.size >= 15, `only ${helpCommands.size} commands parsed from --help`);
  assert.deepEqual([...readmeCommands].sort(), [...helpCommands].sort());
});
