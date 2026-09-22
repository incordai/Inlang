/**
 * faq `schema` — FAQPage JSON-LD, faq-block-spec §7.5.
 *
 * The conditions are the point: bad structured data is worse than none, so
 * each one the spec states is asserted here — off suppresses, fewer than
 * three answered questions suppresses, and nothing an author writes can break
 * out of the <script> the data lives in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, THEMES } from '../../theme/src/index.ts';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../faq/emit.web.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');

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
      breakpoint: t.breakpoint as unknown as Record<string, number>,
      typeSize: t.typeSize as unknown as Record<string, string>,
    },
    target: 'web',
    site: { name: 'aurora' },
    slot: () => [],
    asset: (p) => p,
  };
}

const item = (question: string, text: string): SpecBlock => ({
  word: 'item', variant: null, modifiers: [], as: null, children: [],
  args: [{ kind: 'string', value: question }],
  props: text ? { text } : {},
});

const THREE = [
  item('How long does a pair take?', 'Four to six weeks.'),
  item('Can I return them?', 'Within thirty days.'),
  item('Do you ship abroad?', 'To most countries.'),
];

const faq = (props: Record<string, string>, children: SpecBlock[]): SpecBlock => ({
  word: 'faq', variant: 'list', modifiers: [], args: [], as: null,
  props: { title: 'Questions', ...props }, children,
});

/** Every <script> node in an emitted tree. */
function scripts(node: EmittedNode | string): EmittedNode[] {
  if (typeof node === 'string') return [];
  const own = node.tag === 'script' ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap(scripts)];
}

function schemaOf(block: SpecBlock): { node: EmittedNode; text: string } | null {
  const found = scripts(emit(block, context()));
  assert.ok(found.length <= 1, 'one FAQ block emits at most one FAQPage');
  if (found.length === 0) return null;
  return { node: found[0]!, text: String(found[0]!.children?.[0] ?? '') };
}

test('schema on: emits FAQPage JSON-LD describing every answered question', () => {
  const s = schemaOf(faq({ schema: 'on' }, THREE));
  assert.ok(s, 'schema on with three answered questions must emit JSON-LD');
  assert.equal(s.node.attrs?.type, 'application/ld+json');
  const data = JSON.parse(s.text);
  assert.equal(data['@context'], 'https://schema.org');
  assert.equal(data['@type'], 'FAQPage');
  assert.deepEqual(
    data.mainEntity.map((q: { name: string; acceptedAnswer: { text: string } }) =>
      [q.name, q.acceptedAnswer.text]),
    [
      ['How long does a pair take?', 'Four to six weeks.'],
      ['Can I return them?', 'Within thirty days.'],
      ['Do you ship abroad?', 'To most countries.'],
    ]);
});

test('CONTROL: schema off emits no JSON-LD for the same items', () => {
  assert.equal(schemaOf(faq({ schema: 'off' }, THREE)), null);
});

test('fewer than three answered questions emits nothing — §7.5', () => {
  assert.equal(schemaOf(faq({ schema: 'on' }, THREE.slice(0, 2))), null);
  // An unanswered question does not count toward the three, and is never
  // described: the markup must not claim an answer the page does not show.
  const withBlank = [...THREE.slice(0, 2), item('Is there a warranty?', '')];
  assert.equal(schemaOf(faq({ schema: 'on' }, withBlank)), null);
});

test('SECURITY: </script> and <!-- in an answer stay inert, and survive intact', () => {
  const evil = '</script><script>alert(1)</script><!-- & more\u2028end';
  const s = schemaOf(faq({ schema: 'on' }, [...THREE, item('Is this safe?', evil)]));
  assert.ok(s);
  assert.ok(!s.text.includes('<') && !s.text.includes('>'),
    `raw angle brackets reached the script body: ${s.text}`);
  assert.ok(!s.text.includes('&'), 'a raw & must not reach the script body either');
  assert.ok(!s.text.includes('\u2028'), 'a raw U+2028 line terminator must not reach the script body');
  // Escaped, not dropped: the JSON parses back to exactly what was written.
  const data = JSON.parse(s.text);
  assert.equal(data.mainEntity[3].acceptedAnswer.text, evil);
});

test('DETERMINISM: the same block emits identical JSON-LD twice', () => {
  const a = schemaOf(faq({ schema: 'on' }, THREE));
  const b = schemaOf(faq({ schema: 'on' }, THREE));
  assert.equal(a?.text, b?.text);
});

/** Manifests as the CLI loads them — a word IS its manifest (CONVENTIONS §3). */
function manifests(): Map<string, Manifest> {
  const out = new Map<string, Manifest>();
  for (const d of readdirSync(WORDS)) {
    const f = join(WORDS, d, 'word.json');
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    out.set(m.name, m);
  }
  return out;
}

test('schema defaults to on through the compiler, and off is honoured', () => {
  const source = (extra: string) =>
    'az 1\nsite a\npage /\n  faq\n    title "Questions"\n' + extra +
    '    item "How long does a pair take?"\n      text "Four to six weeks."\n' +
    '    item "Can I return them?"\n      text "Within thirty days."\n' +
    '    item "Do you ship abroad?"\n      text "To most countries."\n';
  const faqBlock = (src: string) => {
    const r = compile(src, { manifests: manifests() });
    assert.ok(r.ok && r.spec, JSON.stringify(r.diagnostics));
    return r.spec.pages[0]!.blocks.find((b) => b.word === 'faq')!;
  };
  assert.ok(schemaOf(faqBlock(source(''))), 'with no schema line the default must be on');
  assert.equal(schemaOf(faqBlock(source('    schema off\n'))), null);
});
