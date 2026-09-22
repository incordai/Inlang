/**
 * `faq` — web emitter.
 *
 * faq-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** faq-block-spec §7.5 — a two-question FAQPage is noise, so none is emitted. */
const SCHEMA_MIN_ITEMS = 3;

/**
 * FAQPage JSON-LD — faq-block-spec §7.5.
 *
 * Built as a value and serialised by JSON.stringify, never concatenated
 * (CONVENTIONS §6). The text sits inside a <script>, where HTML escaping does
 * not apply, so the characters that could end the element or open a comment
 * are spelled as JSON unicode escapes: the JSON parses back to exactly the
 * author's text, and `</script>` or `<!--` in an answer stays inert.
 * U+2028/U+2029 are escaped for the same reason target-web's stableJson does.
 *
 * Only items with both a question and an answer are described — the answer is
 * rendered in the page by the item's own markup, so the markup never claims
 * content a visitor cannot find.
 */
function faqSchema(block: SpecBlock): EmittedNode | null {
  if (block.props.schema === 'off') return null;

  const questions = block.children
    .filter((c) => c.word === 'item')
    .map((c) => ({ name: c.args[0]?.value ?? '', text: c.props.text ?? '' }))
    .filter((q) => q.name && q.text);
  if (questions.length < SCHEMA_MIN_ITEMS) return null;

  const json = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: questions.map((q) => ({
      '@type': 'Question',
      name: q.name,
      acceptedAnswer: { '@type': 'Answer', text: q.text },
    })),
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return { tag: 'script', attrs: { type: 'application/ld+json' }, children: [json] };
}

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'list';
  const children: EmittedNode[] = [];

  // A section heading is an <h2>: the hero owns the page's only <h1>
  // (hero-spec §4), so the outline stays valid at exactly one level down.
  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-faq-title' },
      style: {
        fontSize: t.typeSize['2xl'],
        lineHeight: t.type['leading-tight'],
        fontFamily: t.type.display,
        fontWeight: t.type['weight-display'],
        // The MEASURE goes on the text, never the container — hero-spec §3.
        maxWidth: `${t.size['measure-display']}ch`,
        margin: `0 0 ${px(t.space[16])}`,
      },
      children: [block.props.title],
    });
  }

  if (block.props.sub) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-faq-sub' },
      style: {
        fontSize: t.typeSize.lg,
        lineHeight: t.type['leading-body'],
        color: t.color.muted,
        maxWidth: `${t.size['measure-body']}ch`,
        margin: `0 0 ${px(t.space[48])}`,
      },
      children: [block.props.sub],
    });
  }

  const items = ctx.slot('item');
  if (items.length > 0) {
    // Slot fills are <li>; their container must be a list to be valid HTML.
    children.push({
      tag: 'ul',
      attrs: { class: 'az-faq-items' },
      style: {
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: variant === 'columns' ? 'grid' : 'block',
        gridTemplateColumns: variant === 'columns' ? 'repeat(2, minmax(0, 1fr))' : 'none',
        columnGap: px(t.space[48]),
        maxWidth: `${t.size['measure-body']}ch`,
      },
      children: items,
    });
  }

  const schema = faqSchema(block);
  if (schema) children.push(schema);

  return {
    tag: 'section',
    attrs: { class: `az-faq az-faq--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.bg,
      color: t.color.text,
    },
    children,
  };
}
