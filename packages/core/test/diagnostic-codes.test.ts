/**
 * Diagnostic IDs against GRAMMAR §7.4 and §7.5.
 *
 * §7.5's table is the allocation: each word owns a block of twenty AZ2xxx
 * IDs, and every row of its `checks` sits in that block. §7.4 splits the
 * space: below AZ2000 an ID is a class the compiler raises wherever it
 * occurs; from AZ2000 an ID is one manifest row, declared once. So across
 * the whole codebase no per-word ID is declared twice, none is raised by
 * compiler source, and every compiler ID lies in one of §7.4's stage ranges.
 * Each check is written as a function of its inputs so a CONTROL can feed it
 * a deliberately wrong one and require the failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const GRAMMAR = readFileSync(join(ROOT, 'docs/GRAMMAR.md'), 'utf8');

const BLOCK = 20;
const WORD_BASE = 2000;
const num = (code: string): number => Number(code.slice(2));

/** One section of GRAMMAR.md, from its heading to the next heading of any level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n### ${heading}\n`);
  assert.ok(start >= 0, `GRAMMAR.md has no '### ${heading}'`);
  const rest = doc.slice(start + heading.length + 6);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

interface Block { word: string; from: number; to: number }

/** §7.5's rows, `| word | AZnnnn–AZnnnn |`, and the next free block it states. */
function blocksIn(doc: string): { blocks: Block[]; next: number | null } {
  const text = section(doc, '7.5 Per-word ID blocks');
  const blocks = [...text.matchAll(/^\| ([a-z][a-z0-9]*) \| AZ(\d{4})–AZ(\d{4}) \|$/gm)]
    .map((m) => ({ word: m[1], from: Number(m[2]), to: Number(m[3]) }));
  const next = /next free block is \*\*AZ(\d{4})–AZ\d{4}\*\*/.exec(text);
  return { blocks, next: next ? Number(next[1]) : null };
}

/** §7.4's stage ranges below AZ2000, `| AZnnnn–AZnnnn | stage |`. */
function stageRanges(doc: string): { from: number; to: number }[] {
  return [...section(doc, '7.4 Diagnostic ID ranges').matchAll(/^\| AZ(\d{4})–AZ(\d{4}) \|/gm)]
    .map((m) => ({ from: Number(m[1]), to: Number(m[2]) }));
}

interface Declared { word: string; code: string }

function manifestCodes(): Declared[] {
  return readdirSync(WORDS)
    .filter((w) => existsSync(join(WORDS, w, 'word.json')))
    .flatMap((w) => {
      const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as { name: string; checks?: { code: string }[] };
      return (m.checks ?? []).map((c) => ({ word: m.name, code: c.code }));
    });
}

/** Every ID written as a string literal in non-test source under packages/ — what code raises. */
function sourceCodes(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir))) {
      if (e === 'node_modules' || e === 'test') continue;
      const p = join(dir, e);
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(e) && !/\.test\./.test(e)) {
        for (const m of readFileSync(join(ROOT, p), 'utf8').matchAll(/['"`](AZ\d{4})['"`]/g)) out.push({ file: p, code: m[1] });
      }
    }
  };
  walk('packages');
  return out;
}

/** Problems with the allocation table itself: shape, order, coverage of the words. */
function tableProblems(blocks: Block[], next: number | null, words: string[]): string[] {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    const from = WORD_BASE + BLOCK * i;
    if (b.from !== from || b.to !== from + BLOCK - 1) {
      out.push(`${b.word}: block AZ${b.from}–AZ${b.to}, the next in turn is AZ${from}–AZ${from + BLOCK - 1}`);
    }
  });
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.has(b.word)) out.push(`${b.word}: listed twice`);
    seen.add(b.word);
    if (!words.includes(b.word)) out.push(`${b.word}: has a block but no word.json`);
  }
  for (const w of words) if (!seen.has(w)) out.push(`${w}: has no block in GRAMMAR §7.5`);
  const free = WORD_BASE + BLOCK * blocks.length;
  if (next !== free) out.push(`the next free block is AZ${free}, GRAMMAR §7.5 says ${next === null ? 'nothing' : `AZ${next}`}`);
  return out;
}

/** Problems with where the declared IDs sit and how often each is used. */
function codeProblems(
  blocks: Block[], ranges: { from: number; to: number }[],
  declared: Declared[], raised: { file: string; code: string }[],
): string[] {
  const out: string[] = [];
  const blockOf = new Map(blocks.map((b) => [b.word, b]));
  const owner = new Map<string, string>();
  for (const { word, code } of declared) {
    const b = blockOf.get(word);
    const n = num(code);
    if (!b) out.push(`${word} ${code}: the word has no block`);
    else if (n < b.from || n > b.to) out.push(`${word} ${code}: outside its block AZ${b.from}–AZ${b.to}`);
    if (owner.has(code)) out.push(`${code}: declared by ${owner.get(code)} and ${word}`);
    owner.set(code, word);
  }
  for (const { file, code } of raised) {
    const n = num(code);
    if (n >= WORD_BASE) {
      out.push(`${file}: raises ${code}, a per-word ID${owner.has(code) ? ` owned by ${owner.get(code)}` : ''} — per-word IDs live only in word.json`);
    } else if (!ranges.some((r) => n >= r.from && n <= r.to)) {
      out.push(`${file}: raises ${code}, which is in no GRAMMAR §7.4 range`);
    }
  }
  return out;
}

const words = readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'word.json'))).sort();
const { blocks, next } = blocksIn(GRAMMAR);
const ranges = stageRanges(GRAMMAR);
const declared = manifestCodes();
const raised = sourceCodes();

test('CONTROL: there is something to check — blocks, ranges, declared rows and raised IDs', () => {
  assert.ok(blocks.length >= 11, `only ${blocks.length} blocks parsed from GRAMMAR §7.5`);
  assert.ok(ranges.length >= 8, `only ${ranges.length} ranges parsed from GRAMMAR §7.4`);
  assert.ok(declared.length >= 50, `only ${declared.length} manifest checks`);
  assert.ok(raised.length >= 100, `only ${raised.length} raised IDs in source`);
});

test('GRAMMAR §7.5 gives every word one block of twenty, in turn, and names the next free one', () => {
  assert.deepEqual(tableProblems(blocks, next, words), []);
});

test("every word's IDs sit in its block, no per-word ID is used twice, and compiler IDs sit in §7.4's ranges", () => {
  assert.deepEqual(codeProblems(blocks, ranges, declared, raised), []);
});

test('CONTROL: a deliberately wrong allocation fails', () => {
  const gap = blocks.map((b, i) => (i === 1 ? { ...b, from: b.from + BLOCK, to: b.to + BLOCK } : b));
  assert.ok(tableProblems(gap, next, words).some((p) => p.startsWith(`${blocks[1].word}: block`)));
  assert.ok(tableProblems(blocks.slice(0, -1), next, words).some((p) => p.includes('has no block')));
  assert.ok(tableProblems(blocks, (next ?? 0) + BLOCK, words).some((p) => p.startsWith('the next free block')));
});

test('CONTROL: an ID outside its block, an ID used twice, and a per-word ID in compiler source all fail', () => {
  const [first, second] = [blocks[0], blocks[1]];
  const outside = [{ word: first.word, code: `AZ${second.from}` }];
  assert.deepEqual(codeProblems(blocks, ranges, outside, []),
    [`${first.word} AZ${second.from}: outside its block AZ${first.from}–AZ${first.to}`]);

  const twice = [{ word: first.word, code: `AZ${first.from}` }, { word: first.word, code: `AZ${first.from}` }];
  assert.deepEqual(codeProblems(blocks, ranges, twice, []), [`AZ${first.from}: declared by ${first.word} and ${first.word}`]);

  const leaked = [{ file: 'packages/core/src/link.ts', code: `AZ${first.from}` }];
  assert.equal(codeProblems(blocks, ranges, [{ word: first.word, code: `AZ${first.from}` }], leaked).length, 1);
  assert.equal(codeProblems(blocks, ranges, [], [{ file: 'x.ts', code: 'AZ1999' }]).length, 1, 'AZ1999 is in no range');
});
