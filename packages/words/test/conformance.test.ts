/**
 * Emitter/manifest conformance.
 *
 * The manifest is the single source of truth (ARCHITECTURE §3). An emitter
 * that reads `block.props.title` for a word whose manifest never declares
 * `title` is reading a value the linker will never populate — it fails
 * silently, forever, and no type checks it because props are a string map.
 *
 * This caught `scene` growing a heading from a shared template. It is a test
 * rather than a one-off script because the drift recurs on every manifest
 * edit, and only a test runs on the edit that causes it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

interface Manifest {
  readonly variants?: readonly string[];
  readonly props?: Readonly<Record<string, unknown>>;
  readonly slots?: Readonly<Record<string, unknown>>;
}

const dirs = readdirSync(WORDS).filter((d) =>
  statSync(join(WORDS, d)).isDirectory() &&
  existsSync(join(WORDS, d, 'word.json')) &&
  existsSync(join(WORDS, d, 'emit.web.ts')));

const all = (src: string, re: RegExp): string[] =>
  [...new Set([...src.matchAll(re)].map((m) => m[1]))];

test('CONTROL: there are emitters to check', () => {
  // Without this the loop below could pass by iterating over nothing.
  assert.ok(dirs.length >= 9, `only ${dirs.length} emitters found: ${dirs.join(',')}`);
});

test('every emitter reads only props, slots and variants its manifest declares', () => {
  const problems: string[] = [];

  for (const w of dirs) {
    const src = readFileSync(join(WORDS, w, 'emit.web.ts'), 'utf8');
    const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;

    const declaredProps = Object.keys(m.props ?? {});
    const declaredSlots = Object.keys(m.slots ?? {});
    const declaredVariants = m.variants ?? [];

    for (const p of all(src, /block\.props\.([A-Za-z][A-Za-z0-9]*)/g)) {
      if (!declaredProps.includes(p)) {
        problems.push(`${w}: reads prop '${p}', manifest declares [${declaredProps.join(', ')}]`);
      }
    }
    for (const s of all(src, /ctx\.slot\('([^']+)'\)/g)) {
      if (!declaredSlots.includes(s)) {
        problems.push(`${w}: reads slot '${s}', manifest declares [${declaredSlots.join(', ')}]`);
      }
    }
    // Both the compared variants AND the fallback default must be real: a
    // default that is not in the list makes `az` emit a variant the language
    // has no word for.
    const compared = all(src, /variant === '([^']+)'/g);
    const fallback = /block\.variant \?\? '([^']+)'/.exec(src)?.[1];
    for (const v of fallback ? [...compared, fallback] : compared) {
      if (!declaredVariants.includes(v)) {
        problems.push(`${w}: uses variant '${v}', manifest declares [${declaredVariants.join(', ')}]`);
      }
    }
  }

  assert.deepEqual(problems, [], '\n  ' + problems.join('\n  '));
});

test('CONTROL: the check FAILS on a word that reads an undeclared prop', () => {
  // The test above passes when the codebase is clean, which is also what it
  // would do if the regexes matched nothing at all. This proves they match.
  const src = `const x = block.props.nonesuch; const y = ctx.slot('ghost');`;
  assert.deepEqual(all(src, /block\.props\.([A-Za-z][A-Za-z0-9]*)/g), ['nonesuch']);
  assert.deepEqual(all(src, /ctx\.slot\('([^']+)'\)/g), ['ghost']);
});
