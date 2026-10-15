/**
 * Every fill declares its line, and its emitter reads nothing past it.
 *
 * A fill's line is the values written after its name — `link "Shoes" /shoes`,
 * `image ./a.jpg`, `item "Sewn" lead`. The link stage refuses a value past
 * the declared line (AZ1406), so the declaration must be what the emitter
 * actually reads: shorter, and a value that renders is refused; longer, and
 * a value is accepted that nothing draws. Before the declaration existed,
 * only buttons were checked (`cta` and `alt`), and `link "Shoes" /shoes
 * extra` compiled and dropped `extra` without a word.
 *
 * So this is measured, not asserted from reading the emitters: every fill in
 * every word's previews is emitted with its line filled and then with one
 * more value, and the two outputs must be byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { WEB_EMITTERS } from '../registry.ts';
import { compile, type Manifest } from '../../core/src/index.ts';
import { ACTION_WORDS } from '../../core/src/actions.ts';
import type { FillLine, LineValue } from '../../core/src/link.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext } from '../../core/src/emit-contract.ts';
import { actionsFor } from '../../target-web/src/actions.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const ROLES: readonly string[] = ['label', 'destination', 'value', 'file'];

const dirs = readdirSync(WORDS).filter((d) =>
  statSync(join(WORDS, d)).isDirectory() && existsSync(join(WORDS, d, 'word.json')));
const manifests = new Map<string, Manifest>(dirs.map((d) => {
  const m = JSON.parse(readFileSync(join(WORDS, d, 'word.json'), 'utf8')) as Manifest;
  return [m.name, m];
}));

interface SlotDef {
  readonly line?: unknown;
  readonly props?: Record<string, { type: string }>;
  readonly slots?: Record<string, SlotDef>;
}

/** Every fill a manifest declares: its path, its line as written, and the props a flag may name. */
function fills(m: Manifest): { path: string; line: unknown; props: Record<string, { type: string }> }[] {
  const out: { path: string; line: unknown; props: Record<string, { type: string }> }[] = [];
  const walk = (slots: Record<string, SlotDef> | undefined, prefix: string) => {
    for (const [name, def] of Object.entries(slots ?? {})) {
      out.push({ path: `${prefix}${name}`, line: def.line, props: def.props ?? {} });
      walk(def.slots, `${prefix}${name}.`);
    }
  };
  walk(m.slots as Record<string, SlotDef> | undefined, '');
  for (const child of m.children ?? []) {
    out.push({ path: child, line: m.childLines?.[child]?.line, props: {} });
  }
  return out;
}

const validValue = (v: unknown, props: Record<string, { type: string }>): boolean =>
  typeof v === 'string' ? ROLES.includes(v)
    : typeof v === 'object' && v !== null && Object.keys(v).length === 1
      && typeof (v as { flag?: unknown }).flag === 'string'
      && props[(v as { flag: string }).flag]?.type === 'flag';

test('CONTROL: there are manifests with fills to check', () => {
  const total = [...manifests.values()].reduce((n, m) => n + fills(m).length, 0);
  assert.ok(manifests.size >= 12 && total >= 25, `${manifests.size} manifests, ${total} fills`);
});

test('every fill declares its line: roles in order, a flag naming a flag prop of the fill', () => {
  const problems: string[] = [];
  for (const m of manifests.values()) {
    for (const f of fills(m)) {
      if (!Array.isArray(f.line) || f.line.length === 0) problems.push(`${m.name}.${f.path}: no line`);
      else if (!f.line.every((v) => validValue(v, f.props))) problems.push(`${m.name}.${f.path}: ${JSON.stringify(f.line)}`);
      else if (f.line[0] !== 'label' && f.line[0] !== 'file') problems.push(`${m.name}.${f.path}: starts with ${JSON.stringify(f.line[0])}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('CONTROL: a line that is missing or names an unknown role is caught', () => {
  assert.equal(validValue('colour', {}), false);
  assert.equal(validValue({ flag: 'lead' }, {}), false, 'a flag must be a flag prop of the fill');
  assert.equal(validValue({ flag: 'lead' }, { lead: { type: 'flag' } }), true);
});

test('a button is a label and a destination wherever it is a fill (buttons §1.1)', () => {
  for (const m of manifests.values()) {
    for (const f of fills(m)) {
      if (!ACTION_WORDS.has(f.path.split('.').at(-1)!)) continue;
      assert.deepEqual(f.line, ['label', 'destination'], `${m.name}.${f.path}`);
    }
  }
});

test('childLines names only children, and holds only children', () => {
  for (const m of manifests.values()) {
    for (const [child, decl] of Object.entries(m.childLines ?? {})) {
      assert.ok(m.children?.includes(child), `${m.name}: childLines.${child} is not a child`);
      for (const h of decl.holds ?? []) assert.ok(m.children?.includes(h), `${m.name}: ${child} holds unknown '${h}'`);
    }
  }
});

/* ---- measured: the emitter reads nothing past the line ------------------- */

function context(): EmitContext {
  const t = resolve(THEMES.midnight, 'dark');
  return {
    theme: {
      color: t.color as unknown as Record<string, string>,
      size: t.size as unknown as Record<string, number>,
      type: t.type as unknown as Record<string, string | number>,
      radius: t.radius as unknown as Record<string, number>,
      shadow: t.shadow as unknown as Record<string, string>,
      space: t.space as unknown as Record<string, number>,
      motion: t.motion as unknown as Record<string, string | number>,
      layer: t.layer as unknown as Record<string, number>,
      breakpoint: t.breakpoint,
      typeSize: t.typeSize as unknown as Record<string, string>,
    },
    target: 'web',
    site: { name: 'aurora' },
    slot: () => [],
    asset: (p) => p,
    ...actionsFor(t as unknown as EmitContext['theme'], { asset: (p) => p }),
  };
}

/** A value that fills one position of a line, so the extra value lands past it. */
function filler(v: LineValue): SpecBlock['args'][number] {
  if (typeof v !== 'string') return { kind: 'word', value: v.flag };
  if (v === 'destination') return { kind: 'route', value: '/' };
  if (v === 'file') return { kind: 'path', value: './pad.webp' };
  return { kind: 'string', value: `Pad ${v}` };
}

const EXTRA = { kind: 'string', value: 'Zq value past the line' } as const;

/** The block with one block in its tree replaced. */
function replace(b: SpecBlock, target: SpecBlock, next: SpecBlock): SpecBlock {
  if (b === target) return next;
  return { ...b, children: b.children.map((c) => replace(c, target, next)) };
}

/** The block with one fill's args replaced. */
const withArgs = (b: SpecBlock, target: SpecBlock, args: SpecBlock['args']): SpecBlock =>
  replace(b, target, { ...target, args });

/** Each fill in a block with its declared line (slots by their own defs, children by childLines). */
function linedFills(b: SpecBlock, m: Manifest): { fill: SpecBlock; line: FillLine; path: string }[] {
  const out: { fill: SpecBlock; line: FillLine; path: string }[] = [];
  const walk = (kids: readonly SpecBlock[], slots: Record<string, SlotDef> | undefined, prefix: string) => {
    for (const c of kids) {
      const def = slots?.[c.word];
      // A `children` word, and the children it holds, are read from childLines.
      const line = (def?.line ?? m.childLines?.[c.word]?.line) as FillLine | undefined;
      if (!line) continue;
      out.push({ fill: c, line, path: `${prefix}${c.word}` });
      walk(c.children, def?.slots, `${prefix}${c.word}.`);
    }
  };
  walk(b.children, m.slots as Record<string, SlotDef> | undefined, '');
  return out;
}

/** Every block of every word's previews, as compiled. */
function previewBlocks(): SpecBlock[] {
  const out: SpecBlock[] = [];
  for (const d of dirs) {
    for (const f of readdirSync(join(WORDS, d)).filter((n) => /^preview(\.[a-z]+)?\.az$/.test(n))) {
      const r = compile(readFileSync(join(WORDS, d, f), 'utf8'), { manifests: new Map(manifests) });
      assert.ok(r.spec, `${d}/${f} compiles`);
      out.push(...r.spec.site.inherited, ...r.spec.pages.flatMap((p) => p.blocks));
    }
  }
  return out;
}

test('CONTROL: a value inside the line does change the output', () => {
  const hero = previewBlocks().find((b) => b.word === 'hero' && b.children.some((c) => c.word === 'cta'))!;
  const cta = hero.children.find((c) => c.word === 'cta')!;
  const emit = (b: SpecBlock) => JSON.stringify(WEB_EMITTERS.hero.emit(b, context()));
  assert.notEqual(emit(hero), emit(withArgs(hero, cta, [cta.args[0], { kind: 'route', value: '/elsewhere' }])));
});

/**
 * Fills whose emitter would draw a value past the line, were one passed.
 *
 * MEASURED, both directions: an entry that stops reading past its line
 * fails too. pricing-spec §7.4 makes a feature row a label and a value, and
 * that is the line; the cards list and the shared-row key join every value
 * the row has, so a third value would render in cards and vanish in the
 * transposed panel. The link stage refuses it (AZ1406), so no compiled
 * site carries one.
 */
const READS_PAST_LINE: readonly string[] = ['pricing.plan.feature'];

test('no emitter reads a value past its fill\'s declared line', () => {
  const read: string[] = [];
  const seen = new Set<string>();
  for (const block of previewBlocks()) {
    const m = manifests.get(block.word);
    const emitter = WEB_EMITTERS[block.word];
    if (!m || !emitter) continue;
    for (const { fill, line, path } of linedFills(block, m)) {
      const padded = line.map((v, i) => fill.args[i] ?? filler(v));
      const base = JSON.stringify(emitter.emit(withArgs(block, fill, padded), context()));
      const more = JSON.stringify(emitter.emit(withArgs(block, fill, [...padded, EXTRA]), context()));
      seen.add(`${block.word}.${path}`);
      if (base !== more) read.push(`${block.word}.${path}`);
    }
  }
  // A fill no preview writes is added to a preview block of its word (under
  // the first fill of its parent slot), so every declared line is measured.
  const blocks = previewBlocks();
  for (const m of manifests.values()) {
    const emitter = WEB_EMITTERS[m.name];
    const block = blocks.find((b) => b.word === m.name);
    if (!emitter || !block) continue;
    for (const f of fills(m)) {
      if (seen.has(`${m.name}.${f.path}`)) continue;
      const parts = f.path.split('.');
      const parent = parts.length === 1 ? block : block.children.find((c) => c.word === parts[0]);
      if (!parent || !Array.isArray(f.line)) continue;
      const line = f.line as FillLine;
      const fill: SpecBlock = { word: parts.at(-1)!, variant: null, modifiers: [], as: null, props: {}, children: [],
        args: line.map(filler) };
      const add = (args: SpecBlock['args']): string => JSON.stringify(emitter.emit(
        replace(block, parent, { ...parent, children: [...parent.children, { ...fill, args }] }), context()));
      seen.add(`${m.name}.${f.path}`);
      // Rendered at all, or "reads nothing past its line" would hold of a fill nothing draws.
      assert.ok(add(fill.args).includes(fill.args[0].value), `${m.name}.${f.path}: the added fill is drawn`);
      if (add(fill.args) !== add([...fill.args, EXTRA])) read.push(`${m.name}.${f.path}`);
    }
  }
  const declared = [...manifests.values()].flatMap((m) => WEB_EMITTERS[m.name] ? fills(m).map((f) => `${m.name}.${f.path}`) : []);
  assert.deepEqual(declared.filter((d) => !seen.has(d)), [], 'every declared fill is measured');
  for (const known of READS_PAST_LINE) assert.ok(seen.has(known), `${known} was not exercised`);
  assert.deepEqual([...new Set(read)].sort(), [...READS_PAST_LINE].sort());
});
