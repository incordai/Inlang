/**
 * `az prompt` (prompt.ts): the system-prompt block any model can write .az
 * from. Generated, never hand-written — so every word, variant, modifier,
 * key and colour choice the compiler accepts must be in the full prompt,
 * every example in it must compile with no diagnostic at all, the same input
 * must give the same bytes, and --budget must drop parts in TRIM_ORDER.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, formatDiagnostics, type Manifest, type PropSpec } from '../src/index.ts';
import {
  ERROR_CASES, TRIM_ORDER, approxTokens, buildPrompt, caseCode, dataExample, minimalExample, promptJson, promptOptionsFrom,
  type Prompt, type PromptInput, type PromptOptions,
} from '../src/prompt.ts';
import { colourChoices } from '../src/colour.ts';
import { FONT_FAMILIES, SITE_WIDTHS } from '../src/link.ts';
import { DATA_MODIFIERS, DATA_TYPES } from '../src/data.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

function bundled(): PromptInput {
  const manifests = new Map<string, Manifest>();
  const examples = new Map<string, string>();
  for (const dir of readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json'))).sort()) {
    const m = JSON.parse(readFileSync(join(WORDS, dir, 'word.json'), 'utf8')) as Manifest;
    manifests.set(m.name, m);
    examples.set(m.name, readFileSync(join(WORDS, dir, 'preview.az'), 'utf8'));
  }
  return { manifests, examples };
}

const INPUT = bundled();

function built(options: PromptOptions = {}, input: PromptInput = INPUT): Prompt {
  const r = buildPrompt(input, options);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r.prompt;
}

/** The compact size bound: a small context window's share, stated here and in docs/USAGE.md §6. */
const COMPACT_MAX_CHARS = 12_000;

/** One word's section of the prompt: from its heading to the next heading. */
function section(markdown: string, word: string): string {
  const start = markdown.indexOf(`\n### \`${word}\``);
  assert.ok(start >= 0, `no section for ${word}`);
  const rest = markdown.slice(start + 1);
  const end = rest.slice(4).search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end + 4);
}

type SlotDef = { props?: Record<string, PropSpec>; slots?: Record<string, SlotDef> };

/** Every key an author may write under a word: props, slots, their props and slots, children, from mappings. */
function keysOf(m: Manifest): string[] {
  const out: string[] = [];
  const walk = (props: Record<string, PropSpec> | undefined, slots: Record<string, SlotDef> | undefined) => {
    out.push(...Object.keys(props ?? {}));
    for (const [k, s] of Object.entries(slots ?? {})) {
      out.push(k);
      walk(s.props, s.slots);
    }
  };
  walk(m.props, m.slots as Record<string, SlotDef> | undefined);
  out.push(...(m.children ?? []));
  for (const k of Object.keys(m.from?.map ?? {})) out.push(`${k} <field>`);
  return out;
}

test('the full prompt names every word, variant, modifier, key and enum value, each in its own section', () => {
  const p = built();
  assert.deepEqual(p.words, [...INPUT.manifests.keys()].sort());
  for (const m of INPUT.manifests.values()) {
    const s = section(p.markdown, m.name);
    assert.ok(m.description && s.includes(m.description), `${m.name}: its info line`);
    for (const v of [...(m.variants ?? []), ...(m.modifiers ?? [])]) assert.ok(s.includes(`- \`${v}\``), `${m.name} ${v}`);
    for (const k of keysOf(m)) assert.ok(s.includes(`\`${k}\``), `${m.name} key ${k}`);
    for (const p2 of Object.values(m.props ?? {})) {
      if (Array.isArray(p2.values)) assert.ok(s.includes(p2.values.join('|')), `${m.name} values ${p2.values}`);
    }
  }
});

test('the compact prompt keeps every word, variant, modifier and key — only the info lines go', () => {
  const p = built({ compact: true });
  for (const m of INPUT.manifests.values()) {
    const s = section(p.markdown, m.name);
    for (const v of m.variants ?? []) assert.match(s, new RegExp(`Variants: .*\\b${v}\\b`), `${m.name} ${v}`);
    for (const v of m.modifiers ?? []) assert.match(s, new RegExp(`Modifiers: (.* )?${v}( |$)`, 'm'), `${m.name} ${v}`);
    for (const k of keysOf(m)) assert.ok(s.includes(`\`${k}\``), `${m.name} key ${k}`);
    assert.ok(!m.description || !s.includes(m.description), `${m.name}: info lines are dropped`);
  }
});

test('every theme, hue, pair, pattern, origin, width, font family and data type is in the full prompt', () => {
  const { markdown } = built();
  const c = colourChoices();
  for (const t of c.themes) {
    assert.ok(markdown.includes(`\`${t.name}\` — ${t.description}`), `theme ${t.name}`);
  }
  for (const h of c.hues) assert.ok(markdown.includes(`\`${h.name}\``), `hue ${h.name}`);
  for (const p of c.patterns) assert.ok(markdown.includes(`\`${p.name}\` — ${p.description}`), `pattern ${p.name}`);
  for (const o of c.origins) assert.ok(markdown.includes(`\`${o.name}\``), `origin ${o.name}`);
  for (const w of Object.keys(SITE_WIDTHS)) assert.ok(markdown.includes(`- \`${w}\``), `width ${w}`);
  for (const f of Object.keys(FONT_FAMILIES)) assert.ok(markdown.includes(`- \`${f}\``), `family ${f}`);
  for (const t of [...DATA_TYPES, ...DATA_MODIFIERS]) assert.ok(markdown.includes(`- \`${t}\``), `data ${t}`);
  // Every allowed pair of every theme: a theme that refuses one says so.
  for (const t of c.themes) {
    for (const [a, b] of t.pairs) assert.match(markdown, new RegExp(`\`${a}\` with [^\\n]*\\b${b}\\b`), `${t.name}: ${a} ${b}`);
  }
});

test('the compact prompt keeps every theme, hue, pair and shape', () => {
  const { markdown } = built({ compact: true });
  const c = colourChoices();
  for (const t of c.themes) assert.match(markdown, new RegExp(`theme <name>\`: [^\\n]*\\b${t.name}\\b`), t.name);
  for (const t of c.themes) for (const [a, b] of t.pairs) assert.match(markdown, new RegExp(`  - ${a}: [^\\n]*\\b${b}\\b`), `${a} ${b}`);
  for (const p of c.patterns) assert.match(markdown, new RegExp(`pattern <shape> \\[<origin>\\]\`: [^\\n]*\\b${p.name}\\b`), p.name);
});

test('CONTROL: a word added to the tables appears with no edit to the generator', () => {
  const manifests = new Map(INPUT.manifests);
  manifests.set('badge', {
    name: 'badge', description: 'A small label', variants: ['pill', 'flat'], modifiers: ['glow'],
    descriptions: { variants: { pill: 'Rounded', flat: 'Square' }, modifiers: { glow: 'Lit' } },
    props: { tone: { type: 'enum', values: ['calm', 'loud'], description: 'How loud it is' } },
  });
  const s = section(built({}, { manifests, examples: INPUT.examples }).markdown, 'badge');
  for (const t of ['A small label', '`pill` Rounded', '`flat` Square', '`glow` Lit', '`tone` calm|loud', 'How loud it is']) {
    assert.ok(s.includes(t), t);
  }
  assert.ok(!built().markdown.includes('### `badge`'), 'and only when it is there');
});

test('every example in the prompt compiles with zero diagnostics — errors and warnings', () => {
  for (const options of [{}, { compact: true }]) {
    const blocks = [...built(options).markdown.matchAll(/^```az\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
    assert.ok(blocks.length >= 1, 'the minimal example is always there');
    for (const src of blocks) {
      const r = compile(src, { manifests: new Map(INPUT.manifests) });
      assert.deepEqual(r.diagnostics, [], `${formatDiagnostics(r.diagnostics, 'example')}\n${src}`);
    }
  }
  // Full: the minimal site, one example per word, and the data example.
  const full = [...built().markdown.matchAll(/^```az$/gm)].length;
  assert.equal(full, 1 + INPUT.manifests.size + 1);
});

test('CONTROL: an example that does not compile clean is left out, not shown', () => {
  const examples = new Map(INPUT.examples);
  examples.set('hero', 'az 1\n\nsite s\n\npage /\n  hero center split\n    title "Two layouts"\n');
  const s = section(built({}, { manifests: INPUT.manifests, examples }).markdown, 'hero');
  assert.ok(!s.includes('Example:'), 'the broken example is not printed');
  assert.ok(section(built().markdown, 'hero').includes('Example:'), 'the clean one is');
});

test('the minimal and data examples are built from the tables and compile clean', () => {
  for (const ex of [minimalExample(INPUT.manifests), dataExample(INPUT.manifests)]) {
    assert.ok(ex);
    const r = compile(ex.join('\n'), { manifests: new Map(INPUT.manifests) });
    assert.deepEqual(r.diagnostics, [], formatDiagnostics(r.diagnostics, 'example'));
  }
  assert.equal(minimalExample(new Map()), null, 'CONTROL: without its words there is no example');
});

test('every common error is shown with the compiler\'s own message for it', () => {
  const { markdown } = built();
  const base = minimalExample(INPUT.manifests)!;
  for (const c of ERROR_CASES) {
    const id = caseCode(c, INPUT.manifests);
    assert.ok(id, `${JSON.stringify(c.code)} names an ID`);
    const at = base.indexOf(c.change[0]);
    assert.ok(at >= 0, `${id}: '${c.change[0]}' is a line of the minimal example`);
    const broken = [...base.slice(0, at), c.change[1], ...base.slice(at + 1)].join('\n');
    const first = compile(broken, { manifests: new Map(INPUT.manifests) }).diagnostics[0];
    assert.equal(first?.code, id, `${id}: the broken line raises it first`);
    assert.ok(markdown.includes(`→ \`${id}\` ${first.message}`), `${id} is in the prompt`);
  }
});

test('CONTROL: a case whose broken line raises another ID is not shown', () => {
  const hero = INPUT.manifests.get('hero')!;
  const manifests = new Map(INPUT.manifests);
  // hero's one-per-page row gone: two heroes raise nothing, so the case is left out.
  manifests.set('hero', { ...hero, checks: (hero.checks ?? []).filter((c) => c.kind !== 'perPage') });
  const perPage = caseCode({ code: { word: 'hero', check: 'perPage' }, change: ['', ''] }, INPUT.manifests);
  assert.ok(perPage && built().markdown.includes(`→ \`${perPage}\``));
  assert.ok(!built({}, { manifests, examples: INPUT.examples }).markdown.includes(`→ \`${perPage}\``));
});

test('the allow rules are the closed matrix the compiler enforces', () => {
  assert.match(built().markdown, /Allowed: anyone read\|create; signedin read\|create; owner read\|edit\|delete\./);
});

test('the same input gives the same bytes, whatever order the manifests arrive in', () => {
  const a = built().markdown;
  const reversed: PromptInput = {
    manifests: new Map([...INPUT.manifests].reverse()), examples: new Map([...INPUT.examples].reverse()),
  };
  assert.equal(built({}, reversed).markdown, a);
  assert.equal(built().markdown, a);
  assert.equal(built({ compact: true }).markdown, built({ compact: true }, reversed).markdown);
});

test(`--compact is under ${COMPACT_MAX_CHARS} characters; the sizes are characters and chars/4 tokens`, (t) => {
  const full = built();
  const compact = built({ compact: true });
  t.diagnostic(`full: ${full.chars} characters, about ${full.tokens} tokens`);
  t.diagnostic(`compact: ${compact.chars} characters, about ${compact.tokens} tokens`);
  assert.ok(compact.chars <= COMPACT_MAX_CHARS, `compact is ${compact.chars} characters`);
  assert.ok(compact.chars < full.chars / 2, 'compact is well under half the full prompt');
  assert.equal(full.chars, full.markdown.length);
  assert.equal(full.tokens, Math.ceil(full.chars / 4));
  assert.equal(approxTokens('abcde'), 2);
  assert.deepEqual(compact.dropped, TRIM_ORDER);
  assert.deepEqual(full.dropped, []);
});

test('--budget drops parts one at a time, in TRIM_ORDER, and each result fits', () => {
  const full = built();
  assert.deepEqual(built({ budget: full.tokens }).dropped, [], 'a budget the full prompt fits drops nothing');
  const gone: Record<string, (md: string) => boolean> = {
    examples: (md) => !md.includes('Example:'),
    rules: (md) => !md.includes('Rules:'),
    info: (md) => !md.includes(INPUT.manifests.get('hero')!.description!),
    data: (md) => !md.includes('## Backend and data'),
    errors: (md) => !md.includes('## Common errors'),
  };
  let budget = full.tokens - 1;
  for (let n = 1; n <= TRIM_ORDER.length; n++) {
    const p = built({ budget });
    assert.deepEqual(p.dropped, TRIM_ORDER.slice(0, n), `budget ${budget}`);
    assert.ok(p.tokens <= budget, `${p.tokens} tokens fit ${budget}`);
    const part = TRIM_ORDER[n - 1];
    assert.ok(gone[part](p.markdown), `${part} is gone`);
    assert.ok(!gone[part](built({ budget: budget + 1e6 }).markdown), `CONTROL: ${part} is there with room`);
    budget = p.tokens - 1;
  }
  assert.equal(built({ budget: budget + 1 }).markdown, built({ compact: true }).markdown, 'the last step is --compact');
  const below = buildPrompt(INPUT, { budget });
  assert.equal(below.ok, false, 'below the compact prompt there is nothing to drop');
  assert.match(below.ok ? '' : below.message, /smallest prompt is \d+ tokens/);
});

test('--words keeps only those words; the order, syntax, colour and errors stay', () => {
  const p = built({ words: ['hero', 'cta'] });
  assert.deepEqual(p.words, ['cta', 'hero']);
  assert.ok(p.markdown.includes('### `hero`') && p.markdown.includes('### `cta`'));
  for (const w of INPUT.manifests.keys()) {
    if (w !== 'hero' && w !== 'cta') assert.ok(!p.markdown.includes(`### \`${w}\``), `${w} is left out`);
  }
  for (const h of ['## Order of work', '## Syntax', '## Colour', '## Common errors']) assert.ok(p.markdown.includes(h), h);
  assert.ok(p.chars < built().chars);
});

test('CONTROL: a word that is not one, or no words, is refused with a suggestion', () => {
  const r = buildPrompt(INPUT, { words: ['heros'] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.message, /'heros' is not a word — use auth, .*did you mean 'hero'/);
  assert.equal(buildPrompt(INPUT, { words: [] }).ok, false);
});

test('the options as a command line writes them: comma lists, a whole-number budget', () => {
  assert.deepEqual(promptOptionsFrom({ words: 'hero, cta,' }), { ok: true, options: { words: ['hero', 'cta'] } });
  assert.deepEqual(promptOptionsFrom({ budget: '4000', compact: true }), { ok: true, options: { compact: true, budget: 4000 } });
  for (const budget of ['0', '-5', '1.5', 'abc', '']) assert.equal(promptOptionsFrom({ budget }).ok, false, budget);
  assert.equal(promptOptionsFrom({ words: ' , ' }).ok, false);
});

test('the JSON form carries the prompt, its size, the rule and what was dropped', () => {
  const j = promptJson(built({ compact: true }));
  assert.equal(j.prompt.length, j.chars);
  assert.equal(j.tokens, Math.ceil(j.chars / 4));
  assert.match(j.tokenRule, /characters \/ 4/);
  assert.deepEqual(j.dropped.map((d) => d.part), TRIM_ORDER);
  assert.deepEqual(j.trimOrder, TRIM_ORDER);
});
