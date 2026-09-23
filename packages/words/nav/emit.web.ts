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
 * The mobile menu is a `drawer` overlay (overlays-spec §2) on a <dialog>:
 * the behaviour runtime shows it modally, which traps focus, makes the page
 * inert and closes on Escape; it adds scroll lock, outside-click and the
 * return of focus to the toggle (§6). `group "…" as dropdown` is the
 * `dropdown` preset: a <button aria-expanded> and a plain <ul> of links,
 * never role="menu" (overlays-spec §6).
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, visuallyHidden, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';
import { closeButton, drawer, dropdown } from '../../overlay/src/index.ts';

/** The drawer's id — the toggle's aria-controls points here (§6). */
const PANEL_ID = 'az-nav-panel';

/** A state map, or nothing when it has no states — an empty map says nothing. */
const orNothing = <T extends object>(states: T): T | undefined =>
  Object.keys(states).length > 0 ? states : undefined;

/** A stroke icon, decorative: the control carries its own name. */
const glyph = (d: string): EmittedNode => ({
  tag: 'svg',
  attrs: {
    'aria-hidden': 'true', focusable: 'false', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
  },
  style: { width: '1.5em', height: '1.5em' },
  children: [{ tag: 'path', attrs: { d } }],
});

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
        // Nothing above sets a typeface; without this the link falls back to
        // the browser's default serif beside the theme's sans group button.
        fontFamily: t.type.body,
        fontSize: t.typeSize.sm,
        textDecoration: 'none',
      },
      children: [label],
    }],
  };
}

/**
 * `group "Products"` — a labelled set of links. In the bar (an `id`) it is
 * the dropdown preset; inside the drawer, which is already a list of
 * everything, its label heads a plain list.
 */
function navGroup(child: SpecBlock, ctx: EmitContext, id: string | null): EmittedNode {
  const t = ctx.theme;
  const label = child.args[0]?.value ?? '';
  const links = child.children.map((c) => navLink(c, ctx));
  if (id === null) {
    return {
      tag: 'li',
      attrs: { class: 'az-nav-group' },
      style: { listStyle: 'none' },
      children: [
        {
          tag: 'p',
          attrs: { class: 'az-nav-group-label' },
          style: {
            margin: 0, paddingInline: px(t.space[12]), paddingBlock: px(t.space[8]),
            color: t.color.muted, fontSize: t.typeSize.sm, fontFamily: t.type.body,
          },
          children: [label],
        },
        { tag: 'ul', attrs: { class: 'az-nav-group-items' }, style: { margin: 0, padding: 0, listStyle: 'none' }, children: links },
      ],
    };
  }
  const list = dropdown(t);
  return {
    tag: 'li',
    attrs: { class: 'az-nav-group', 'data-az-behaviour': 'dropdown' },
    style: { listStyle: 'none', position: 'relative' },
    children: [
      {
        // A group's own label is a button, not a link: it goes nowhere, and a
        // hover-only dropdown is a keyboard dead end (§7).
        tag: 'button',
        attrs: { type: 'button', class: 'az-nav-group-label', 'aria-expanded': 'false', 'aria-controls': id },
        style: {
          minHeight: px(t.size.tap),
          paddingInline: px(t.space[12]),
          background: 'transparent',
          border: '0',
          color: t.color.text,
          fontSize: t.typeSize.sm,
          fontFamily: t.type.body,
          cursor: 'pointer',
        },
        states: {
          focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) },
        },
        children: [label],
      },
      {
        tag: 'ul',
        attrs: { ...list.attrs, id, class: 'az-nav-group-items', hidden: 'hidden' },
        style: list.style,
        states: list.states,
        children: links,
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
  // §3 behaviour modifiers. `hide` and `shrink` only mean something for a bar
  // that stays on screen, so either pins it as `sticky` does.
  const hides = block.modifiers.includes('hide');
  const shrinks = block.modifiers.includes('shrink');
  const pinned = hides || shrinks || block.modifiers.includes('sticky');

  // The logo links to `/` and carries the site name AS TEXT. An <img> with an
  // empty alt inside a link is an unlabelled link (§7), so the text is always
  // present; a visual build hides it against the image, it is never omitted.
  if (block.props.logo) {
    // The runtime marks each logo `scrolled` with the bar, so each one knows
    // whether it is the logo on show: at the top the light inverse, once
    // solid the regular one. Exactly one displays in each state.
    const logoImg = (src: string, state: 'top' | 'solid', waiting: boolean): EmittedNode => ({
      tag: 'img',
      attrs: { src: ctx.asset(src), alt: '', class: 'az-nav-logo-img', 'data-az-logo': state },
      style: {
        display: waiting ? 'none' : 'block',
        height: px(t.space[32]),
        transition: shrinks ? `height ${t.motion.fast}ms ${t.motion.ease}` : undefined,
      },
      states: orNothing({
        ...(waiting ? { scrolled: { display: 'block' } } : state === 'top' ? { scrolled: { display: 'none' } } : {}),
        // §3 `shrink`: the logo shrinks with the bar.
        ...(shrinks ? { shrunk: { height: px(t.space[24]) } } : {}),
      }),
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

  // In the bar every group is a dropdown — nav-spec's own example writes
  // `group "Products"` and positions it as one (§11); `as dropdown`
  // (overlays-spec §4) says the same thing explicitly. Ids by position, so a
  // build is deterministic. In the drawer every group is a plain list.
  let dropdowns = 0;
  const barItems = links.map((c) => (c.word === 'group'
    ? navGroup(c, ctx, `az-nav-group-${++dropdowns}`)
    : navLink(c, ctx)));
  const drawerItems = links.map((c) => (c.word === 'group' ? navGroup(c, ctx, null) : navLink(c, ctx)));
  // §6: the links collapse into the drawer below sm — only now that the
  // drawer is a working dialog. `minimal` has no bar links at any size.
  const collapses = links.length > 0 && layout.linksInBar;

  if (collapses) {
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
      below: { sm: { display: 'none' } },
      children: barItems,
    });
  }

  // §6: the CTA stays visible in the collapsed bar. If it is worth a nav CTA,
  // it is worth reaching without a tap — so it sits here, not in the panel.
  // The button primitive (buttons-and-sections §1), sized for a dense bar;
  // the 44px tap target holds at `sm`.
  for (const c of ctas) bar.push(ctx.action(c, { size: 'sm' }));

  // The toggle is a <button>, never a div with an onclick (§6). It shows
  // wherever the links are in the drawer: below sm, or always for `minimal`.
  const toggle: EmittedNode = {
    tag: 'button',
    attrs: {
      type: 'button',
      class: 'az-nav-toggle',
      'aria-expanded': 'false',
      'aria-controls': PANEL_ID,
      'aria-label': 'Menu',
    },
    style: {
      display: collapses ? 'none' : 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: px(t.size.tap),
      minHeight: px(t.size.tap),
      background: 'transparent',
      border: '0',
      color: t.color.text,
      cursor: 'pointer',
    },
    states: {
      focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) },
    },
    below: collapses ? { sm: { display: 'inline-flex' } } : undefined,
    children: [glyph('M4 7h16M4 12h16M4 17h16')],
  };
  if (links.length > 0) bar.push(toggle);

  const panel = drawer(t, 'Menu');
  const x = closeButton(t, 'Close menu');

  const solid = block.modifiers.includes('solid');
  const nav: EmittedNode = {
    tag: 'nav',
    attrs: {
      class: `az-nav az-nav--${variant}`,
      // §7: a page has more than one nav landmark — this one and the footer's.
      'aria-label': 'Main',
      'data-mobile': block.props.mobile ?? 'drawer',
      ...(solid ? { 'data-az-behaviour': 'solid' } : {}),
      ...(hides ? { 'data-az-hide': '' } : {}),
      ...(shrinks ? { 'data-az-shrink': '' } : {}),
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
      // The column stays in view while the content beside it scrolls, and
      // scrolls itself when its links outgrow the screen (§10 Q2: `side` is a
      // page layout — the target puts the content beside this column).
      minHeight: layout.vertical ? undefined : px(t.size.nav),
      height: layout.vertical ? '100svh' : undefined,
      overflowY: layout.vertical ? 'auto' : undefined,
      width: layout.vertical ? px(t.size['nav-side']) : undefined,
      paddingBlock: layout.vertical ? px(t.space[24]) : undefined,
      paddingInline: px(t.size['gutter-lg']),
      // `solid` is transparent at the top and solid after scroll (§4); the
      // scrolled state is the runtime's, so the emitted state is the top one.
      // At the top a scrim gradient, not a flat overlay, keeps the bar
      // readable over a bright image without dimming all of it (§4.1).
      background: solid ? 'transparent' : t.color.bg,
      backgroundImage: solid
        ? `linear-gradient(to bottom, color-mix(in srgb, ${t.color.scrim} 35%, transparent), transparent)`
        : undefined,
      color: t.color.text,
      // A shrinking bar is pinned by its frame (below), which holds its
      // full height in the page; the bar itself pins otherwise.
      position: (pinned && !shrinks) || layout.vertical ? 'sticky' : 'static',
      top: 0,
      zIndex: t.layer.sticky,
      transition: hides || shrinks
        ? [hides && `transform ${t.motion.normal}ms ${t.motion.ease}`, shrinks && `min-height ${t.motion.fast}ms ${t.motion.ease}`]
          .filter(Boolean).join(', ')
        : undefined,
    },
    states: orNothing({
      // §4: once scrolled, solid — and the hysteresis lives in the runtime.
      ...(solid ? { scrolled: { background: t.color.bg, backgroundImage: 'none', boxShadow: t.shadow.sm } } : {}),
      // §3 `shrink`: the bar drops to its short height past the threshold.
      ...(shrinks ? { shrunk: { minHeight: px(t.size['nav-shrink']) } } : {}),
      // §3 `hide`: out of view while the reader scrolls down.
      ...(hides ? { retracted: { transform: 'translateY(-100%)' } } : {}),
    }),
    // §3: `hide` "must be instant under reduced-motion" — no slide at all.
    reducedMotion: hides || shrinks ? { transition: 'none' } : undefined,
    // The mobile gutter below sm (theme-spec §1).
    // Below sm a side column becomes a bar: the page stacks there, and the
    // links are in the drawer (§6).
    below: {
      sm: {
        paddingInline: px(t.size['gutter-sm']),
        ...(layout.vertical
          ? { flexDirection: 'row', alignItems: 'center', width: 'auto', height: 'auto', minHeight: px(t.size.nav), overflowY: 'visible', paddingBlock: 0 }
          : {}),
      },
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
          fontFamily: t.type.body,
          transform: 'translateY(-200%)',
        },
        // §7: visually hidden until focused — and SHOWN when focused. Without
        // this state the link was reachable but stayed off-screen for good.
        states: { focusVisible: { transform: 'none' } },
        children: ['Skip to content'],
      },
      ...bar,
      ...(links.length > 0 ? [{
        // The drawer (§6, overlays-spec §2): a <dialog> the runtime shows
        // modally. It holds every link, in order, so the collapsed bar loses
        // nothing — and for `minimal` it is the whole menu at every size.
        tag: 'dialog',
        attrs: { ...panel.attrs, id: PANEL_ID, class: 'az-nav-panel az-overlay' },
        style: panel.style,
        states: panel.states,
        children: [
          {
            tag: 'div',
            style: { display: 'flex', justifyContent: 'flex-end', marginBottom: px(t.space[16]) },
            children: [{ tag: 'button', attrs: x.attrs, style: x.style, states: x.states, children: [glyph(x.icon.d)] }],
          },
          {
            tag: 'ul',
            attrs: { class: 'az-nav-drawer-items' },
            style: { display: 'flex', flexDirection: 'column', gap: px(t.space[4]), margin: 0, padding: 0, listStyle: 'none' },
            children: drawerItems,
          },
        ],
      } satisfies EmittedNode] : []),
    ],
  };
  if (!shrinks) return nav;
  // §3 `shrink`: "reserve final height up front or you cause CLS". The frame
  // is pinned and holds the full bar height in the page for good, so the bar
  // shrinking inside it moves nothing below. The frame lets clicks through
  // wherever the bar is not.
  return {
    tag: 'div',
    attrs: { class: 'az-nav-frame' },
    style: { position: 'sticky', top: 0, zIndex: t.layer.sticky, minHeight: px(t.size.nav), pointerEvents: 'none' },
    children: [{ ...nav, style: { ...nav.style, pointerEvents: 'auto' } }],
  };
}
