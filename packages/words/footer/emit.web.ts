/**
 * @az word footer
 * Purpose: the site footer — link groups, a legal row and the copyright line.
 * Spec: docs/footer-block-spec.md · terms: az explain footer
 * Renders: footer.az-footer.az-footer--{variant} >
 *   a.az-footer-logo? > img.az-footer-logo-img + visually hidden site name · p.az-footer-tagline? ·
 *   nav.az-footer-nav? > div.az-footer-columns > div.az-footer-column > h2.az-footer-column-title +
 *     ul.az-footer-column-items > li > a.az-footer-link ; ul.az-footer-loose (links and social) ·
 *   (mega, below sm) div.az-footer-accordion > details.az-footer-group > summary.az-footer-group-summary ·
 *   div.az-footer-bottom > p.az-footer-copyright (span[data-year] when year is dynamic) + ul.az-footer-legal
 * Variants: minimal — logo, tagline and legal row, flattened · columns — groups as flex columns, one below sm ·
 *   mega — grid of groups; below sm the groups become details accordions.
 * Modifiers: glass — blurred veil surface (translucent).
 * Props: logo → img.az-footer-logo-img · tagline → p.az-footer-tagline · copyright → the copyright line ·
 *   since / year → the year in that line (dynamic: runtime updates it).
 * Styling: theme tokens only; below.sm mobile gutter; minimal centres below sm; mega switches forms by width.
 * Behaviour: packages/overlay runtime (wireYear) rolls a dynamic year; accordions are native details.
 * Edit guide: link rendering → footerLink(); groups → the columns/accordion blocks; copyright → copyrightRow.
 *   Keep: no <h1> in the footer; the logo link is named by the site; legal links sit in the bottom row.
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/nav-footer.test.ts, packages/words/test/responsive.test.ts
 */

/**
 * `footer` — web emitter.
 *
 * footer-block-spec.md §9 is specific about the structure, and the details are
 * the kind that are invisible until someone uses a screen reader:
 *
 *   - links live in ONE `<nav aria-label="Footer">`, not one per column
 *   - column headings are `<h2>`; each column's `<ul>` is its own list
 *   - `minimal` with ≤3 links emits NO `<nav>` — a bare `<ul>`
 *   - `legal` links sit OUTSIDE the footer nav, in the copyright row: they are
 *     not navigation
 *   - never an `<h1>` — it would conflict with the hero
 *   - `year dynamic` emits the `since` literal as the FALLBACK, and the
 *     rolling year is written by the client (§5). The emitted bytes stay
 *     deterministic, which is the whole reason the fallback is a literal.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { glassSurface, px, visuallyHidden, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** `link "Shoes" /shoes` — one list item. */
function footerLink(child: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  return {
    tag: 'li',
    style: { listStyle: 'none' },
    children: [{
      tag: 'a',
      // A file destination ships through the asset sandbox, root-relative.
      attrs: { class: 'az-footer-link', href: child.args[1]?.kind === 'path' ? ctx.asset(child.args[1].value) : child.args[1]?.value ?? '#' },
      style: {
        // §9: footer link lists are the most commonly under-spaced targets in
        // the product, so the 44px minimum is enforced here rather than hoped
        // for from the line-height.
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: px(t.size.tap),
        color: t.color.muted,
        fontSize: t.typeSize.sm,
        textDecoration: 'none',
      },
      children: [child.args[0]?.value ?? ''],
    }],
  };
}

/** A `<ul>` of links, with no heading of its own. */
const linkList = (items: SpecBlock[], ctx: EmitContext, cls: string): EmittedNode => ({
  tag: 'ul',
  attrs: { class: cls },
  style: { margin: 0, padding: 0, listStyle: 'none' },
  children: items.map((c) => footerLink(c, ctx)),
});

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'minimal';

  const groups = block.children.filter((c) => c.word === 'group');
  const loose = block.children.filter((c) => c.word === 'link');
  const social = block.children.filter((c) => c.word === 'social');
  const legal = block.children.filter((c) => c.word === 'legal');

  const children: EmittedNode[] = [];

  if (block.props.logo) {
    children.push({
      tag: 'a',
      attrs: { class: 'az-footer-logo', href: '/' },
      style: { display: 'inline-flex', minHeight: px(t.size.tap), alignItems: 'center' },
      // The image is decorative; the site name is the link's name (§9).
      children: [
        {
          tag: 'img',
          attrs: { src: ctx.asset(block.props.logo), alt: '', class: 'az-footer-logo-img' },
          style: { display: 'block', height: px(t.space[24]) },
        },
        visuallyHidden(ctx.site.name),
      ],
    });
  }

  if (block.props.tagline) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-footer-tagline' },
      style: {
        color: t.color.muted,
        fontSize: t.typeSize.sm,
        maxWidth: `${t.size['measure-body']}ch`,
        margin: `0 0 ${px(t.space[24])}`,
      },
      children: [block.props.tagline],
    });
  }

  // §2: `minimal` is "invisible by design" — it does not render columns at
  // all. Its groups flatten into one list, because a footer that lays out
  // three labelled columns is `columns`, whatever the author typed.
  const flatten = variant === 'minimal';
  const columnGroups = flatten ? [] : groups;
  const flattened = flatten ? groups.flatMap((g) => g.children.filter((c) => c.word === 'link')) : [];

  // §9: ONE nav for all footer navigation — but `minimal` with three links or
  // fewer is not navigation worth a landmark, and gets a bare list instead.
  const navLinks = [...columnGroups, ...loose, ...social, ...flattened];
  const bareList = flatten && navLinks.length <= 3;

  if (navLinks.length > 0) {
    const columns: EmittedNode[] = columnGroups.map((g) => ({
      tag: 'div',
      attrs: { class: 'az-footer-column' },
      children: [
        {
          // A group heading is an <h2>: the hero owns the page's only <h1>,
          // and footer-spec §9 makes an <h1> here an outright error.
          tag: 'h2',
          attrs: { class: 'az-footer-column-title' },
          style: {
            fontSize: t.typeSize.sm,
            fontFamily: t.type.body,
            color: t.color.text,
            margin: `0 0 ${px(t.space[8])}`,
          },
          children: [g.args[0]?.value ?? ''],
        },
        linkList(g.children.filter((c) => c.word === 'link'), ctx, 'az-footer-column-items'),
      ],
    }));

    const looseAndSocial = [...loose, ...social, ...flattened];
    if (looseAndSocial.length > 0) {
      columns.push(linkList(looseAndSocial, ctx, 'az-footer-loose'));
    }

    const grid: EmittedNode = {
      tag: 'div',
      attrs: { class: 'az-footer-columns' },
      style: {
        // §2: `mega` is the multi-product layout — a real grid that keeps its
        // columns as the count grows. `columns` wraps, which is what makes
        // 2-5 groups read as a set rather than a table.
        display: variant === 'mega' ? 'grid' : 'flex',
        gridTemplateColumns: variant === 'mega'
          ? `repeat(auto-fit, minmax(${px(t.size['column-min'])}, 1fr))`
          : undefined,
        flexWrap: variant === 'mega' ? undefined : 'wrap',
        gap: px(t.space[32]),
        marginBottom: px(t.space[32]),
      },
      // §8 below sm: `columns` collapses to ONE column, groups in source
      // order with their headings — never two-across. `mega` swaps to its
      // accordion form instead (below).
      below: variant === 'mega'
        ? { sm: { display: 'none' } }
        : { sm: { flexDirection: 'column' } },
      children: columns,
    };

    // §8: on a phone `mega`'s groups become <details> accordions, all closed
    // except the first. Two forms, switched by width (decision D5): a closed
    // <details> cannot be forced open on desktop by CSS in every engine, and
    // `display: none` removes the inactive form from the accessibility tree,
    // so a reader meets each link once. No height animation (§8), and the
    // open state is not persisted.
    const accordion: EmittedNode[] = variant === 'mega' && columnGroups.length > 0
      ? [{
          tag: 'div',
          attrs: { class: 'az-footer-accordion' },
          style: { display: 'none', marginBottom: px(t.space[32]) },
          below: { sm: { display: 'block' } },
          children: [
            ...columnGroups.map((g, i): EmittedNode => ({
              tag: 'details',
              attrs: { class: 'az-footer-group', ...(i === 0 ? { open: 'open' } : {}) },
              style: { borderBottom: `1px solid ${t.color.border}` },
              children: [
                {
                  tag: 'summary',
                  attrs: { class: 'az-footer-group-summary' },
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    minHeight: px(t.size.tap),
                    cursor: 'pointer',
                  },
                  children: [{
                    tag: 'h2',
                    attrs: { class: 'az-footer-column-title' },
                    style: { fontSize: t.typeSize.sm, fontFamily: t.type.body, color: t.color.text, margin: 0 },
                    children: [g.args[0]?.value ?? ''],
                  }],
                },
                linkList(g.children.filter((c) => c.word === 'link'), ctx, 'az-footer-column-items'),
              ],
            })),
            ...(looseAndSocial.length > 0 ? [linkList(looseAndSocial, ctx, 'az-footer-loose')] : []),
          ],
        }]
      : [];

    children.push(bareList
      ? linkList(looseAndSocial, ctx, 'az-footer-loose')
      : { tag: 'nav', attrs: { class: 'az-footer-nav', 'aria-label': 'Footer' }, children: [grid, ...accordion] });
  }

  // §5: `dynamic` emits the `since` literal as a FALLBACK and marks it for the
  // client. The emitted bytes never contain today's date — a build that did
  // would differ from itself tomorrow.
  const copyrightRow: (EmittedNode | string)[] = [];
  if (block.props.copyright) {
    const year = block.props.since ?? '';
    const mode = block.props.year ?? 'none';
    copyrightRow.push({
      tag: 'p',
      attrs: { class: 'az-footer-copyright' },
      style: { color: t.color.muted, fontSize: t.typeSize.xs, margin: 0 },
      children: mode === 'none' || !year
        ? [`© ${block.props.copyright}`]
        : [
            '© ',
            { tag: 'span', attrs: mode === 'dynamic' ? { 'data-year': 'dynamic' } : {}, children: [year] },
            ` ${block.props.copyright}`,
          ],
    });
  }

  // §9: legal links are NOT navigation, so they sit outside the footer nav.
  if (legal.length > 0) {
    copyrightRow.push(linkList(legal, ctx, 'az-footer-legal'));
  }

  if (copyrightRow.length > 0) {
    children.push({
      tag: 'div',
      attrs: { class: 'az-footer-bottom' },
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: px(t.space[16]),
        paddingTop: px(t.space[24]),
        borderTop: `1px solid ${t.color.border}`,
      },
      // §8: `minimal` stacks its logo, tagline and legal row centred.
      below: variant === 'minimal'
        ? { sm: { flexDirection: 'column', alignItems: 'center', textAlign: 'center' } }
        : undefined,
      children: copyrightRow,
    });
  }

  return {
    tag: 'footer',
    attrs: { class: `az-footer az-footer--${variant}` },
    style: {
      paddingBlock: px(t.space[48]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.surface,
      color: t.color.text,
    },
    // §7 `glass` is decorative: the solid surface is the fallback and carries
    // the contrast; where blur is supported the page shows through, blurred.
    translucent: block.modifiers.includes('glass') ? { style: glassSurface(t) } : undefined,
    // The mobile gutter below sm (theme-spec §1); `minimal` centres its stack.
    below: { sm: { paddingInline: px(t.size['gutter-sm']), textAlign: variant === 'minimal' ? 'center' : undefined } },
    children,
  };
}
