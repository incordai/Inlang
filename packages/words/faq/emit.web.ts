/**
 * @az word faq
 * Purpose: questions with expandable answers, plus FAQPage structured data.
 * Spec: docs/faq-block-spec.md · terms: az explain faq
 * Renders: section.az-faq.az-faq--{variant} > h2.az-faq-title? · p.az-faq-sub? ·
 *   ul.az-faq-items[data-az-behaviour=faq][data-single] > li.az-faq-item >
 *     h3|h2.az-faq-question#faq-{slug} > button.az-faq-toggle[aria-expanded][aria-controls] + svg chevron ·
 *     div.az-faq-answer#faq-{slug}-panel[role=region ≤6 items] > p (the answer) + more links ·
 *   script[type=application/ld+json]? (≥3 answered questions, schema on)
 * Variants: list — one column at the body measure · columns — two-column grid, one column below sm.
 * Modifiers: single — data-single=true, the runtime keeps one answer open · reveal — data-az-reveal on the block (revealed as one unit); the overlay runtime hides by script, once.
 * Props: title → h2.az-faq-title · sub → p.az-faq-sub · schema → FAQPage JSON-LD on/off ·
 *   item "question" → the question button; its text → the answer paragraph; more → link-hierarchy action.
 * Styling: theme tokens only; hairline dividers between rows; row padding grows below sm (tap target);
 *   focusVisible ring on the toggle; states.open rotates the chevron.
 * Behaviour: packages/overlay runtime (wireFaq) collapses answers to hidden="until-found" after load;
 *   answers ship open, so they read without JS.
 * Edit guide: question markup → question(); ids → questionIds() (stable, deterministic); JSON-LD → faqSchema().
 *   Keep: JSON-LD escaping of < > & U+2028/9; question ids stable across builds; no skipped heading level.
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/faq-schema.test.ts, packages/words/test/faq-rows.test.ts, packages/words/test/behaviour-markup.test.ts
 */

/**
 * `faq` — web emitter.
 *
 * faq-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { framed, px, revealed, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** faq-block-spec §7.5 — a two-question FAQPage is noise, so none is emitted. */
const SCHEMA_MIN_ITEMS = 3;

/** §7.1: past this many items every answer as a landmark floods the rotor. */
const REGION_MAX_ITEMS = 6;

/**
 * §7.4: a stable id per question — lowercase, non-alphanumerics to hyphens,
 * collisions suffixed -2, -3 — so a deep link survives a rebuild and two
 * builds are byte-identical.
 */
export function questionIds(questions: readonly string[]): string[] {
  const used = new Set<string>();
  return questions.map((q) => {
    const base = `faq-${q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'question'}`;
    // Numbered against every id already given, not just this slug's count:
    // "A", "A", "A 2" would otherwise give faq-a-2 twice.
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

/**
 * One question — §7.1's disclosure: the <button> inside the <h3>, the answer
 * in a panel it controls. The markup ships every answer OPEN: with JS off
 * every panel reads (§8), and the behaviour runtime collapses them to
 * hidden="until-found" before first paint, so find-in-page still reaches
 * each one (§7.3).
 */
function question(item: SpecBlock, id: string, region: boolean, ctx: EmitContext, heading: 'h2' | 'h3'): EmittedNode[] {
  const t = ctx.theme;
  const more = item.children.filter((c) => c.word === 'more');
  return [
    {
      tag: heading,
      attrs: { id, class: 'az-faq-question' },
      style: { margin: 0, fontSize: t.typeSize.lg, lineHeight: t.type['leading-tight'], fontFamily: t.type.display },
      children: [{
        tag: 'button',
        attrs: {
          type: 'button', id: `${id}-btn`, class: 'az-faq-toggle',
          'aria-expanded': 'true', 'aria-controls': `${id}-panel`, 'data-az-disclosure': '',
        },
        style: {
          display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
          gap: px(t.space[16]), minHeight: px(t.size.tap), padding: 0, textAlign: 'start',
          background: 'transparent', border: 0, color: t.color.text,
          font: 'inherit', cursor: 'pointer',
        },
        // §8: a color.focus ring on the whole row, never outline: none.
        states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
        children: [
          item.args[0]?.value ?? '',
          {
            tag: 'svg',
            attrs: {
              'aria-hidden': 'true', focusable: 'false', viewBox: '0 0 24 24', fill: 'none',
              stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'data-az-chevron': '',
            },
            style: { width: '1em', height: '1em', flexShrink: 0, transition: `transform ${t.motion.fast}ms ${t.motion.ease}` },
            // The runtime marks the chevron open with aria-expanded (§8).
            states: { open: { transform: 'rotate(180deg)' } },
            children: [{ tag: 'path', attrs: { d: 'M6 9l6 6 6-6' } }],
          },
        ],
      }],
    },
    {
      tag: 'div',
      attrs: {
        id: `${id}-panel`, class: 'az-faq-answer',
        ...(region ? { role: 'region', 'aria-labelledby': `${id}-btn` } : {}),
      },
      style: { paddingTop: px(t.space[8]) },
      children: [
        {
          tag: 'p',
          style: {
            margin: 0, fontSize: t.typeSize.base, lineHeight: t.type['leading-body'],
            color: t.color.muted, maxWidth: `${t.size['measure-body']}ch`,
          },
          children: [item.props.text ?? ''],
        },
        ...more.map((c) => ctx.action(c, { hierarchy: 'link' })),
      ],
    },
  ];
}

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

  const questions = block.children.filter((c) => c.word === 'item');
  const ids = questionIds(questions.map((q) => q.args[0]?.value ?? ''));
  const region = questions.length <= REGION_MAX_ITEMS;
  if (questions.length > 0) {
    // Slot fills are <li>; their container must be a list to be valid HTML.
    children.push({
      tag: 'ul',
      attrs: {
        class: 'az-faq-items',
        // The runtime's hook; `single` opts into one open at a time (§7.2).
        'data-az-behaviour': 'faq',
        'data-single': String(block.modifiers.includes('single')),
      },
      style: {
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: variant === 'columns' ? 'grid' : 'block',
        gridTemplateColumns: variant === 'columns' ? 'repeat(2, minmax(0, 1fr))' : 'none',
        columnGap: px(t.space[48]),
        maxWidth: `${t.size['measure-body']}ch`,
      },
      // §6: `columns` collapses to one column below sm, in declared order —
      // row-major DOM order, so one column reads 1, 2, 3.
      below: variant === 'columns' ? { sm: { gridTemplateColumns: 'minmax(0, 1fr)' } } : undefined,
      // §3: rows are separated by one hairline, not boxed — dividers, not
      // cards. §6: below sm the row padding GROWS (the row is the tap
      // target), from the question padding space.16 to space.24.
      children: questions.map((q, i): EmittedNode => ({
        tag: 'li',
        attrs: { class: 'az-faq-item' },
        style: {
          listStyle: 'none',
          paddingBlock: px(t.space[16]),
          borderBottom: `1px solid ${t.color.border}`,
        },
        below: { sm: { paddingBlock: px(t.space[24]) } },
        children: question(q, ids[i], region, ctx, block.props.title ? 'h3' : 'h2'),
      })),
    });
  }

  const schema = faqSchema(block);
  if (schema) children.push(schema);

  return revealed(block, t, {
    tag: 'section',
    attrs: { class: `az-faq az-faq--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: framed(t),
      background: t.color.bg,
      color: t.color.text,
    },
    // §6: the container drops to the mobile gutter (theme-spec §1).
    below: { sm: { paddingInline: px(t.size['gutter-sm']) } },
    children,
  });
}
