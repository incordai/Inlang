/**
 * @az word pricing
 * Purpose: plans and prices, with a monthly/annual switch.
 * Spec: docs/pricing-block-spec.md · terms: az explain pricing
 * Renders: section.az-pricing.az-pricing--{variant} > h2.az-pricing-title? · p.az-pricing-sub? ·
 *   fieldset.az-pricing-billing[data-az-behaviour]? > legend + label > input[type=radio] ×2 (when any annual) ·
 *   (cards) div.az-pricing-plans > article.az-plan(.az-plan--highlight)[aria-label] >
 *     p.az-plan-badge? · h3|h2.az-plan-name · p.az-plan-price · p.az-plan-period · ul.az-plan-features ·
 *     div.az-plan-action · (table) table.az-pricing-plans (hidden below sm) + div.az-pricing-panels (below sm) +
 *     div.az-pricing-shared > h3|h2.az-pricing-shared-title + ul.az-pricing-shared-items ; panels use dl.az-plan-rows
 * Variants: cards — one card per plan, one column below sm, highlighted first · table — comparison table,
 *   transposed to per-plan panels below sm; rows equal in every plan collapse into the shared list.
 * Modifiers: reveal — data-az-reveal on the block, data-az-reveal-item on plan cards; the overlay runtime hides by script, once.
 * Props: title → h2 · sub → p · currency / locale → formatPrice() · billing → which price shows first ·
 *   period → p.az-plan-period · plan monthly/annual → data prices · highlight → accent border ·
 *   badge → p.az-plan-badge · feature children → the feature rows · cta → div.az-plan-action.
 * Styling: theme tokens only; highlight uses color.accent at size.edge-emphasis; below.sm restacks.
 * Behaviour: packages/overlay runtime (wireBilling) swaps prices and keeps ?billing= current.
 * Edit guide: one plan → plan(); prices → formatPrice(); shared rows → sharedRows()/everyPlan().
 *   Keep: both DOM forms for table (one hidden per width); radio names unique per block.
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/pricing.test.ts, packages/words/test/pricing-shared.test.ts
 */

/**
 * `pricing` — web emitter.
 *
 * pricing-block-spec.md §7.2 settles the two questions this word raises:
 *
 *   Prices are DECLARED, never computed. PRD principle 7 forbids expressions
 *   in `.az`, so `monthly 29` and `annual 290` are independent declarations
 *   and the compiler must never grow a way to say "annual is monthly × 10".
 *   A saving is a declared string, because the compiler cannot calculate one
 *   and must not appear to.
 *
 *   Currency is FORMATTING, not arithmetic — no value changes, only its
 *   presentation — so `Intl.NumberFormat` runs at EMIT time and the output is
 *   a static string, which is what keeps the byte-identical-build rule
 *   (CONVENTIONS §6) true.
 *
 * The hazard §7.2 does not mention: `Intl` output depends on the ICU data
 * bundled with the running Node. A build on small-icu, or on a future ICU with
 * revised locale data, can produce different bytes for the same source. That
 * is real, and it is why pricing.test.ts PINS the formatted output for known
 * inputs — including the U+00A0 before the euro sign — so an ICU change
 * surfaces as a failing test rather than as a diff nobody can explain.
 *
 * A plan may carry a STRING price — `monthly "Custom"` — which is exempt from
 * formatting and renders no currency symbol.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { framed, px, revealed, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/**
 * Format a declared price.
 *
 * Returns the input untouched when it is not a number: `monthly "Custom"` is
 * a legal price and putting a currency symbol in front of it would be wrong.
 */
export function formatPrice(value: string, currency: string, locale: string): string {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) return value;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(n);
  } catch {
    // An unknown currency or locale must not take the build down — the value
    // still reaches the page, just unformatted.
    return value;
  }
}

/** One plan. `cards` gets an <article>, `table` a column of cells. */
function plan(p: SpecBlock, ctx: EmitContext, opts: {
  currency: string; locale: string; billing: string; period: string; table: boolean;
  /** Feature rows every plan shares, shown once in the "in every plan" list. */
  shared?: ReadonlySet<string>;
  /** §6: a phone panel of a transposed table — rows as label/value pairs. */
  panel?: boolean;
  /** <h3> under the section title, <h2> when there is none — no skipped level. */
  heading: 'h2' | 'h3';
}): EmittedNode {
  const t = ctx.theme;
  const name = p.args[0]?.value ?? '';
  const highlighted = p.props.highlight === 'on';

  // §7.1: the toggle's source of truth is the query string, defaulting to the
  // `billing` prop. Both prices are emitted; the runtime shows one. Emitting
  // only the current one would make the toggle a page load.
  const shown = opts.billing === 'annual' && p.props.annual ? p.props.annual : p.props.monthly;

  const body: EmittedNode[] = [];

  // §7.3: the badge is real text in the flow, a <p> BEFORE the plan name —
  // not a floated pill that a screen reader meets after the price.
  if (p.props.badge) {
    body.push({
      tag: 'p',
      attrs: { class: 'az-plan-badge' },
      style: { margin: 0, fontSize: t.typeSize.xs, color: t.color.accent },
      children: [p.props.badge],
    });
  }

  body.push({
    // §9: <h3> per plan name (<h2> with no section title). Never <h1>.
    tag: opts.heading,
    attrs: { class: 'az-plan-name' },
    style: {
      margin: `0 0 ${px(t.space[12])}`,
      fontSize: t.typeSize.lg,
      fontFamily: t.type.display,
    },
    children: [name],
  });

  if (shown) {
    body.push({
      tag: 'p',
      attrs: {
        class: 'az-plan-price',
        // Both figures ride along so the toggle is a DOM update, not a fetch.
        'data-monthly': formatPrice(p.props.monthly ?? '', opts.currency, opts.locale),
        ...(p.props.annual
          ? { 'data-annual': formatPrice(p.props.annual, opts.currency, opts.locale) }
          : {}),
      },
      style: {
        margin: `0 0 ${px(t.space[4])}`,
        fontSize: t.typeSize['2xl'],
        fontFamily: t.type.display,
        // §3: not cosmetic. Without tabular figures the price jumps sideways
        // when the toggle swaps it for a different-width number.
        fontVariantNumeric: 'tabular-nums',
      },
      children: [formatPrice(shown, opts.currency, opts.locale)],
    });
  }

  // §3: the period note sits one step down and muted, under the price.
  if (opts.period) {
    body.push({
      tag: 'p',
      attrs: { class: 'az-plan-period' },
      style: {
        margin: `0 0 ${px(t.space[24])}`,
        fontSize: t.typeSize.sm,
        color: t.color.muted,
      },
      children: [opts.period],
    });
  }

  const features = p.children.filter((c) => c.word === 'feature' && !opts.shared?.has(rowKey(c)));
  if (features.length > 0 && opts.panel) {
    // §6: in a transposed table every row is a `label / value` pair, so the
    // row's label is read with its value rather than lost with the header.
    body.push({
      tag: 'dl',
      attrs: { class: 'az-plan-rows' },
      style: { margin: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: `${px(t.space[8])} ${px(t.space[16])}` },
      children: features.flatMap((f): EmittedNode[] => [
        { tag: 'dt', style: { fontSize: t.typeSize.sm, color: t.color.muted }, children: [f.args[0]?.value ?? ''] },
        { tag: 'dd', style: { margin: 0, fontSize: t.typeSize.sm }, children: [f.args[1]?.value ?? ''] },
      ]),
    });
  } else if (features.length > 0) {
    body.push({
      tag: 'ul',
      attrs: { class: 'az-plan-features' },
      style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: px(t.space[8]) },
      children: features.map((f): EmittedNode => ({
        tag: 'li',
        style: { fontSize: t.typeSize.sm, color: t.color.muted },
        children: [f.args.map((a) => a.value).filter(Boolean).join(' — ')],
      })),
    });
  }

  // §4: only the highlighted plan's CTA is primary; the rest are secondary,
  // or every card shouts at once. The button primitive draws both.
  for (const c of p.children.filter((c) => c.word === 'cta')) {
    body.push({
      tag: 'div',
      attrs: { class: 'az-plan-action' },
      style: { marginTop: px(t.space[16]) },
      children: [ctx.action(c, { hierarchy: highlighted ? 'primary' : 'secondary', fill: true })],
    });
  }

  if (opts.table) {
    // §9: a real table cell, so the price is announced with its plan.
    return { tag: 'td', attrs: { class: 'az-plan' }, children: body };
  }

  return {
    // §9: each cards plan is an <article> labelled by its name.
    tag: 'article',
    attrs: { class: `az-plan${highlighted ? ' az-plan--highlight' : ''}`, 'aria-label': name },
    style: {
      padding: px(t.space[24]),
      background: highlighted ? t.color['surface-alt'] : t.color.surface,
      // §7.3: the highlight edge is `color.accent`, never `color.border` (a
      // decorative hairline with no contrast floor). Weight AND badge text
      // carry it too, so it survives without colour.
      border: highlighted
        ? `${px(t.size['edge-emphasis'])} solid ${t.color.accent}`
        : `1px solid ${t.color.border}`,
      borderRadius: px(t.radius.md),
    },
    // §7.3: on a phone the highlighted plan moves to the top of the stack by
    // grid `order`, so DOM, tab and screen-reader order still agree with each
    // other. Visual order then differs from focus order (WCAG 2.4.3) — the
    // spec's choice, and why it moves only one card.
    below: highlighted ? { sm: { order: -1 } } : undefined,
    children: body,
  };
}

/** A feature row's identity: its label and value, as the author wrote them. */
const rowKey = (f: SpecBlock) => f.args.map((a) => a.value).join('\u0000');

/** Rows every plan declares identically — only meaningful with two or more plans. */
function sharedRows(plans: SpecBlock[]): Set<string> {
  if (plans.length < 2) return new Set();
  const rows = plans.map((p) => new Set(p.children.filter((c) => c.word === 'feature').map(rowKey)));
  return new Set([...rows[0]].filter((k) => rows.every((r) => r.has(k))));
}

/** §6: the shared list, once, after the plans — in the first plan's order. */
function everyPlan(first: SpecBlock, shared: ReadonlySet<string>, ctx: EmitContext, heading: 'h2' | 'h3'): EmittedNode {
  const t = ctx.theme;
  const rows = first.children.filter((c) => c.word === 'feature' && shared.has(rowKey(c)));
  return {
    tag: 'div',
    attrs: { class: 'az-pricing-shared' },
    style: { marginTop: px(t.space[32]) },
    children: [
      {
        tag: heading,
        attrs: { class: 'az-pricing-shared-title' },
        style: { margin: `0 0 ${px(t.space[12])}`, fontSize: t.typeSize.lg, fontFamily: t.type.display },
        children: ['In every plan'],
      },
      {
        tag: 'ul',
        attrs: { class: 'az-pricing-shared-items' },
        style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: px(t.space[8]) },
        children: rows.map((f): EmittedNode => ({
          tag: 'li',
          style: { fontSize: t.typeSize.sm, color: t.color.muted },
          children: [f.args.map((a) => a.value).filter(Boolean).join(' — ')],
        })),
      },
    ],
  };
}

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'cards';
  const table = variant === 'table';
  // The outline never skips a level: plan names are <h3> under the section's
  // <h2> title, and <h2> themselves when there is no title (§8).
  const heading = block.props.title ? 'h3' : 'h2';

  const currency = block.props.currency ?? 'usd';
  const locale = block.props.locale ?? 'en-US';
  const billing = block.props.billing ?? 'monthly';
  const period = block.props.period ?? '';

  const children: EmittedNode[] = [];

  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-pricing-title' },
      style: {
        fontSize: t.typeSize['2xl'],
        lineHeight: t.type['leading-tight'],
        fontFamily: t.type.display,
        fontWeight: t.type['weight-display'],
        maxWidth: `${t.size['measure-display']}ch`,
        margin: `0 0 ${px(t.space[16])}`,
      },
      children: [block.props.title],
    });
  }

  if (block.props.sub) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-pricing-sub' },
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

  const plans = block.children.filter((c) => c.word === 'plan');

  // §7.1: the toggle is a radio GROUP under a visible legend, not a switch —
  // "Monthly" and "Annual" are two named choices, and a switch cannot say
  // which state means which. Only emitted when there is a second price to
  // toggle to.
  if (plans.some((p) => p.props.annual)) {
    children.push({
      tag: 'fieldset',
      // The runtime swaps the prices and keeps ?billing= current (§7.1).
      attrs: { class: 'az-pricing-billing', 'data-billing': billing, 'data-az-behaviour': 'billing' },
      style: { border: '0', margin: `0 0 ${px(t.space[24])}`, padding: 0 },
      children: [
        {
          tag: 'legend',
          style: { fontSize: t.typeSize.sm, color: t.color.muted },
          children: ['Billing period'],
        },
        ...['monthly', 'annual'].map((option): EmittedNode => ({
          tag: 'label',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: px(t.space[8]),
            minHeight: px(t.size.tap),
            marginRight: px(t.space[16]),
            fontSize: t.typeSize.sm,
          },
          children: [
            {
              tag: 'input',
              attrs: {
                type: 'radio',
                name: 'az-billing',
                value: option,
                ...(option === billing ? { checked: 'checked' } : {}),
              },
            },
            option === 'monthly' ? 'Monthly' : 'Annual',
          ],
        })),
      ],
    });
  }

  if (plans.length > 0) {
    // §6: in `table`, rows identical in every plan collapse into ONE shared
    // "in every plan" list, at all widths. `cards` keeps each card whole; its
    // repeats get the validator's warning instead (§11).
    const shared = table ? sharedRows(plans) : new Set<string>();
    const rendered = plans.map((p) => plan(p, ctx, { currency, locale, billing, period, table, shared, heading }));
    // §6 below sm: `cards` is one column, full width, in declared order (the
    // highlighted card moves first, §7.3); `table` TRANSPOSES to stacked
    // per-plan panels — no horizontal scroll. The transposition needs a
    // second DOM form, so both are emitted and one is display:none at each
    // width (decision D5); display:none also takes the hidden form out of
    // the accessibility tree, so nothing is announced twice.
    const stack: EmittedNode = {
      tag: 'div',
      attrs: { class: table ? 'az-pricing-panels' : 'az-pricing-plans' },
      style: table
        ? { display: 'none' }
        : { display: 'grid', gridTemplateColumns: `repeat(${plans.length}, minmax(0, 1fr))`, gap: px(t.space[24]) },
      below: table
        ? { sm: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: px(t.space[24]) } }
        : { sm: { gridTemplateColumns: 'minmax(0, 1fr)' } },
      children: table
        ? plans.map((p) => plan(p, ctx, { currency, locale, billing, period, table: false, panel: true, shared, heading }))
        : rendered,
    };
    if (table) {
      children.push({
        tag: 'table',
        attrs: { class: 'az-pricing-plans' },
        style: { width: '100%', borderCollapse: 'collapse' },
        below: { sm: { display: 'none' } },
        children: [
          { tag: 'caption', children: [block.props.title ?? 'Pricing'] },
          { tag: 'tbody', children: [{ tag: 'tr', children: rendered }] },
        ],
      });
    }
    children.push(stack);
    if (shared.size > 0) children.push(everyPlan(plans[0], shared, ctx, heading));
  }

  return revealed(block, t, {
    tag: 'section',
    attrs: {
      class: `az-pricing az-pricing--${variant}`,
      'data-currency': currency,
      'data-locale': locale,
    },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: framed(t),
      background: t.color.bg,
      color: t.color.text,
    },
    // The mobile gutter below sm (theme-spec §1).
    below: { sm: { paddingInline: px(t.size['gutter-sm']) } },
    children,
  }, 'az-plan');
}
