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
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

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
    // §9: <h3> per plan name. Never <h1> — hero owns that.
    tag: 'h3',
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

  const features = p.children.filter((c) => c.word === 'feature');
  if (features.length > 0) {
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

  for (const c of p.children.filter((c) => c.word === 'cta')) {
    body.push({
      tag: 'a',
      attrs: { class: 'az-plan-cta', href: c.args[1]?.value ?? '#' },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: px(t.size.tap),
        marginTop: px(t.space[16]),
        paddingInline: px(t.space[16]),
        borderRadius: px(t.radius.sm),
        textDecoration: 'none',
        // §4: only the highlighted plan's CTA is primary; the rest are
        // secondary, or every card shouts at once.
        background: highlighted ? t.color.accent : 'transparent',
        color: highlighted ? t.color['accent-contrast'] : t.color.text,
        border: highlighted ? '0' : `1px solid ${t.color.border}`,
      },
      children: [c.args[0]?.value ?? ''],
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
      border: `1px solid ${highlighted ? t.color['border-strong'] : t.color.border}`,
      borderRadius: px(t.radius.md),
    },
    children: body,
  };
}

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'cards';
  const table = variant === 'table';

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
      attrs: { class: 'az-pricing-billing', 'data-billing': billing },
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
    const rendered = plans.map((p) => plan(p, ctx, { currency, locale, billing, period, table }));
    children.push(table
      ? {
          tag: 'table',
          attrs: { class: 'az-pricing-plans' },
          style: { width: '100%', borderCollapse: 'collapse' },
          children: [
            { tag: 'caption', children: [block.props.title ?? 'Pricing'] },
            { tag: 'tbody', children: [{ tag: 'tr', children: rendered }] },
          ],
        }
      : {
          tag: 'div',
          attrs: { class: 'az-pricing-plans' },
          style: {
            display: 'grid',
            gridTemplateColumns: `repeat(${plans.length}, minmax(0, 1fr))`,
            gap: px(t.space[24]),
          },
          children: rendered,
        });
  }

  return {
    tag: 'section',
    attrs: {
      class: `az-pricing az-pricing--${variant}`,
      'data-currency': currency,
      'data-locale': locale,
    },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.bg,
      color: t.color.text,
    },
    children,
  };
}
