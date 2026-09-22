/**
 * `nav` — web emitter.
 *
 * nav-block-spec.md §7 is an accessibility FLOOR, not a wish list, and most of
 * it is structural — it can be emitted correctly here or not at all:
 *
 *   - the skip link is the FIRST focusable element, and nav owns it
 *   - `<nav>` carries an aria-label, because a page has more than one landmark
 *   - the logo links to `/` and carries the site name as text, or it is an
 *     unlabelled link
 *   - the toggle is a `<button>` with aria-expanded and aria-controls
 *   - 44×44 touch targets, including the toggle (`size.tap`)
 *   - the CTA stays in the collapsed bar, never buried in the drawer
 *
 * WHAT THIS EMITTER DOES NOT DO: the mobile menu's BEHAVIOUR — focus trap,
 * Escape to close, scroll lock, returning focus to the toggle (§6). Those are
 * runtime, they need the motion/overlay runtime, and emitting the markup hooks
 * without them would look finished while being a keyboard dead end. The panel
 * is marked `data-az-behaviour="dialog"` so the runtime can find it and a test
 * can tell that it is still outstanding.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, visuallyHidden, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** A nav child that points somewhere: `link "Work" /work`. */
function navLink(child: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const label = child.args[0]?.value ?? '';
  const href = child.args[1]?.value ?? '#';
  return {
    tag: 'li',
    style: { listStyle: 'none' },
    children: [{
      tag: 'a',
      attrs: { class: 'az-nav-link', href },
      style: {
        // §7: 44×44 minimum, and the padding is what creates it — a short
        // label in a 16px-tall anchor is a 16px target however wide it looks.
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: px(t.size.tap),
        paddingInline: px(t.space[12]),
        color: t.color.text,
        fontSize: t.typeSize.sm,
        textDecoration: 'none',
      },
      children: [label],
    }],
  };
}

/** `group "Products"` — a labelled set of links. */
function navGroup(child: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const label = child.args[0]?.value ?? '';
  return {
    tag: 'li',
    attrs: { class: 'az-nav-group', 'data-az-behaviour': child.as ?? 'group' },
    style: { listStyle: 'none', position: 'relative' },
    children: [
      {
        // A group's own label is a button, not a link: it goes nowhere, and a
        // hover-only dropdown is a keyboard dead end (§7).
        tag: 'button',
        attrs: { type: 'button', class: 'az-nav-group-label', 'aria-expanded': 'false' },
        style: {
          minHeight: px(t.size.tap),
          paddingInline: px(t.space[12]),
          background: 'transparent',
          border: '0',
          color: t.color.text,
          fontSize: t.typeSize.sm,
          fontFamily: t.type.body,
        },
        children: [label],
      },
      {
        tag: 'ul',
        attrs: { class: 'az-nav-group-items' },
        style: { margin: 0, padding: 0, listStyle: 'none' },
        children: child.children.map((c) => navLink(c, ctx)),
      },
    ],
  };
}

/**
 * How each layout arranges the bar — nav-spec §2.
 *
 * `bar` logo left and links right · `center` symmetric · `split` three
 * explicit zones so the CTA is protected · `minimal` the menu button at ALL
 * sizes, so the links leave the bar entirely · `side` a vertical column ·
 * `mega` a bar whose group panels span the full width.
 */
const LAYOUT: Record<string, { linksInBar: boolean; vertical: boolean }> = {
  bar: { linksInBar: true, vertical: false },
  center: { linksInBar: true, vertical: false },
  split: { linksInBar: true, vertical: false },
  mega: { linksInBar: true, vertical: false },
  minimal: { linksInBar: false, vertical: false },
  side: { linksInBar: true, vertical: true },
  none: { linksInBar: false, vertical: false },
};

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'bar';
  const layout = LAYOUT[variant] ?? LAYOUT.bar;

  // GRAMMAR §5.2: `none` renders nothing. Suppression is resolved earlier by
  // core's blocksFor, so a target normally never reaches this — it is here so
  // that calling the emitter directly cannot produce a nav the author
  // explicitly asked not to have.
  if (variant === 'none') {
    return { tag: 'nav', attrs: { class: 'az-nav az-nav--none', hidden: 'hidden' }, children: [] };
  }

  const links = block.children.filter((c) => c.word === 'link' || c.word === 'group');
  const ctas = block.children.filter((c) => c.word === 'cta');

  const bar: EmittedNode[] = [];

  // The logo links to `/` and carries the site name AS TEXT. An <img> with an
  // empty alt inside a link is an unlabelled link (§7), so the text is always
  // present; a visual build hides it against the image, it is never omitted.
  if (block.props.logo) {
    const logoImg = (src: string, state: string, hidden: boolean): EmittedNode => ({
      tag: 'img',
      attrs: {
        src: ctx.asset(src),
        alt: '',
        class: 'az-nav-logo-img',
        'data-az-logo': state,
        ...(hidden ? { hidden: 'hidden' } : {}),
      },
      // An inline `display` beats the `hidden` attribute's UA rule, so the
      // waiting logo must say `none` itself or both logos render.
      style: { display: hidden ? 'none' : 'block', height: px(t.space[32]) },
    });

    // §4: a `solid` nav sits transparent over the hero, then turns solid on
    // scroll — so its logo needs two versions. The light `inverse` shows at
    // the top, the regular logo once solid. Only the emitted (top) state is
    // visible; the other is `hidden` until the scroll runtime swaps them, so
    // a reader never meets two logos. Without `solid` there is no transparent
    // state, and the inverse has nothing to be shown over.
    const swaps = block.modifiers.includes('solid') && !!block.props.inverse;
    bar.push({
      tag: 'a',
      attrs: { class: 'az-nav-logo', href: '/' },
      style: { display: 'inline-flex', alignItems: 'center', minHeight: px(t.size.tap) },
      children: [
        ...(swaps
          ? [logoImg(block.props.inverse, 'top', false), logoImg(block.props.logo, 'solid', true)]
          : [logoImg(block.props.logo, 'solid', false)]),
        visuallyHidden(ctx.site.name),
      ],
    });
  }

  const linkItems = links.map((c) => (c.word === 'group' ? navGroup(c, ctx) : navLink(c, ctx)));

  if (links.length > 0 && layout.linksInBar) {
    bar.push({
      tag: 'ul',
      attrs: { class: 'az-nav-items' },
      style: {
        display: 'flex',
        // `side` stacks its links; every horizontal layout keeps them in a row.
        flexDirection: layout.vertical ? 'column' : 'row',
        alignItems: layout.vertical ? 'stretch' : 'center',
        gap: px(t.space[4]),
        margin: 0,
        padding: 0,
        listStyle: 'none',
        // `center` centres the links between logo and CTA; `bar` pushes them
        // to the right of the logo; `split` gets its zones from the grid on
        // the container instead, so it leaves the margins alone.
        marginInline: variant === 'center' ? 'auto' : undefined,
        marginLeft: variant === 'bar' ? 'auto' : undefined,
      },
      children: linkItems,
    });
  }

  // §6: the CTA stays visible in the collapsed bar. If it is worth a nav CTA,
  // it is worth reaching without a tap — so it sits here, not in the panel.
  for (const c of ctas) {
    bar.push({
      tag: 'a',
      attrs: { class: 'az-nav-cta', href: c.args[1]?.value ?? '#' },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: px(t.size.tap),
        paddingInline: px(t.space[16]),
        background: t.color.accent,
        color: t.color['accent-contrast'],
        borderRadius: px(t.radius.sm),
        fontSize: t.typeSize.sm,
        textDecoration: 'none',
      },
      children: [c.args[0]?.value ?? ''],
    });
  }

  // The toggle is a <button>, never a div with an onclick (§6).
  bar.push({
    tag: 'button',
    attrs: {
      type: 'button',
      class: 'az-nav-toggle',
      'aria-expanded': 'false',
      'aria-controls': 'az-nav-panel',
      'aria-label': 'Menu',
    },
    style: {
      minWidth: px(t.size.tap),
      minHeight: px(t.size.tap),
      background: 'transparent',
      border: '0',
      color: t.color.text,
    },
    children: [],
  });

  return {
    tag: 'nav',
    attrs: {
      class: `az-nav az-nav--${variant}`,
      // §7: a page has more than one nav landmark — this one and the footer's.
      'aria-label': 'Main',
      'data-mobile': block.props.mobile ?? 'drawer',
    },
    style: {
      // `split` needs three explicit zones — logo | links | CTA — or the CTA
      // drifts as the link list grows, which is the one thing §2 says this
      // layout exists to prevent.
      display: variant === 'split' ? 'grid' : 'flex',
      gridTemplateColumns: variant === 'split' ? 'auto 1fr auto' : undefined,
      flexDirection: layout.vertical ? 'column' : undefined,
      alignItems: layout.vertical ? 'stretch' : 'center',
      gap: px(t.space[16]),
      // A side nav is a column of full height, not a bar: it takes width
      // instead of height (§2 — "eats 240-280px of width").
      minHeight: layout.vertical ? '100svh' : px(t.size.nav),
      width: layout.vertical ? px(t.size['nav-side']) : undefined,
      paddingBlock: layout.vertical ? px(t.space[24]) : undefined,
      paddingInline: px(t.size['gutter-lg']),
      // `solid` is transparent at the top and solid after scroll (§4); the
      // scrolled state is the runtime's, so the emitted state is the top one.
      background: block.modifiers.includes('solid') ? 'transparent' : t.color.bg,
      color: t.color.text,
      position: block.modifiers.includes('sticky') ? 'sticky' : 'static',
      top: 0,
      zIndex: t.layer.sticky,
    },
    children: [
      {
        // FIRST focusable element on the page. Visually hidden until focused —
        // it must not be `display:none`, which removes it from focus order and
        // makes the whole thing decorative.
        tag: 'a',
        attrs: { class: 'az-skip-link', href: '#az-content' },
        style: {
          position: 'absolute',
          left: px(t.space[8]),
          top: px(t.space[8]),
          zIndex: t.layer.skip,
          padding: px(t.space[8]),
          background: t.color.surface,
          color: t.color.text,
          transform: 'translateY(-200%)',
        },
        children: ['Skip to content'],
      },
      ...bar,
      {
        // The panel. Present in the markup so the runtime has something to
        // open; inert until the dialog behaviour of §6 exists.
        //
        // `minimal` puts the menu button at ALL sizes (§2), so its links live
        // here rather than in the bar — that is the whole layout, not a
        // mobile fallback. `mega` marks its panel full-width.
        tag: 'div',
        attrs: {
          id: 'az-nav-panel',
          class: 'az-nav-panel',
          'data-az-behaviour': 'dialog',
          hidden: 'hidden',
        },
        style: variant === 'mega'
          ? { position: 'absolute', left: 0, right: 0, background: t.color.surface }
          : undefined,
        children: layout.linksInBar
          ? []
          : [{
              tag: 'ul',
              attrs: { class: 'az-nav-items' },
              style: { margin: 0, padding: 0, listStyle: 'none' },
              children: linkItems,
            }],
      },
    ],
  };
}
