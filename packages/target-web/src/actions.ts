/**
 * The action primitive for the web — buttons-and-sections-spec §1.
 *
 * Words never build a button (§1.1: a button is a primitive, not a word).
 * They hand a slot fill to `ctx.action`, and this file decides the element
 * from what the action does (§1.4: navigates → <a>, acts → <button>, never a
 * <div>), the look from its hierarchy (§1.2), and all six states (§1.5)
 * through the style contract, so the stylesheet writes them.
 */

import { defaultHierarchy, intentOf, ACTION_WORDS, type Intent } from '../../core/src/actions.ts';
import {
  px, visuallyHidden,
  type ActionOptions, type EmittedNode, type Hierarchy, type StyleMap, type SubmitOptions, type ThemeLike,
} from '../../core/src/emit-contract.ts';
import type { SpecBlock } from '../../core/src/spec-block.ts';

/**
 * §1.6: an icon LEADS when it says what kind of action this is (call, mail,
 * download) and TRAILS when it shows direction (external). Never both.
 * currentColor, so an icon is always the label's colour and passes A7.
 */
const ICONS: Readonly<Partial<Record<Intent, { at: 'lead' | 'trail'; d: string }>>> = {
  call: { at: 'lead', d: 'M6 3h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 4 5a2 2 0 0 1 2-2z' },
  mail: { at: 'lead', d: 'M3 6h18v12H3zM3 6l9 7 9-7' },
  download: { at: 'lead', d: 'M12 3v12M7 10l5 5 5-5M4 20h16' },
  external: { at: 'trail', d: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6' },
};

const icon = (d: string): EmittedNode => ({
  tag: 'svg',
  attrs: {
    'aria-hidden': 'true', focusable: 'false', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    class: 'az-action-icon',
  },
  style: { width: '1em', height: '1em', flexShrink: 0 },
  children: [{ tag: 'path', attrs: { d } }],
});

/** Surface and ink per hierarchy and tone — every value a theme token. */
function look(t: ThemeLike, hierarchy: Hierarchy, inverted: boolean): { base: StyleMap; hover: StyleMap } {
  const ink = inverted ? t.color['accent-contrast'] : t.color.text;
  switch (hierarchy) {
    case 'primary':
      return inverted
        ? { base: { background: t.color['accent-contrast'], color: t.color.accent, border: `1px solid ${t.color['accent-contrast']}` },
            hover: { textDecoration: 'underline' } }
        : { base: { background: t.color.accent, color: t.color['accent-contrast'], border: `1px solid ${t.color.accent}` },
            hover: { background: t.color['accent-hover'], borderColor: t.color['accent-hover'] } };
    case 'secondary':
      return { base: { background: 'transparent', color: ink, border: `1px solid ${inverted ? ink : t.color['border-strong']}` },
               hover: inverted ? { textDecoration: 'underline' } : { background: t.color['surface-alt'] } };
    case 'ghost':
      return { base: { background: 'transparent', color: ink, border: '1px solid transparent' },
               hover: inverted ? { textDecoration: 'underline' } : { background: t.color['surface-alt'] } };
    case 'link':
      return { base: { background: 'transparent', color: inverted ? ink : t.color.accent, border: '1px solid transparent', paddingInline: 0 },
               hover: { textDecoration: 'underline' } };
  }
}

/** The shared style of every action, with its six states (§1.5). */
function actionStyle(t: ThemeLike, hierarchy: Hierarchy, options: ActionOptions): Pick<EmittedNode, 'style' | 'states' | 'below'> {
  const inverted = options.tone === 'inverted';
  const { base, hover } = look(t, hierarchy, inverted);
  const compact = options.compactBelow;
  const full = options.fullWidthBelow;
  return {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: px(t.space[8]),
      // §1.5: 44×44 including padding, at every size.
      minHeight: px(t.size.tap),
      minWidth: px(t.size.tap),
      paddingInline: px(options.size === 'sm' ? t.space[12] : t.space[24]),
      borderRadius: px(t.radius.sm),
      fontFamily: t.type.body,
      fontSize: options.size === 'sm' ? t.typeSize.sm : t.typeSize.base,
      fontWeight: t.type['weight-bold'],
      lineHeight: t.type['leading-tight'],
      textDecoration: 'none',
      cursor: 'pointer',
      width: options.fill ? '100%' : undefined,
      ...base,
    },
    states: {
      hover,
      // No transform anywhere, so reduced motion has nothing to undo.
      active: hover,
      // theme-spec §6.1: ring + offset, never `outline: none`. On an accent
      // band the ring is drawn in accent-contrast — `focus` is an accent
      // shade and would vanish against the band.
      focusVisible: {
        outline: `${px(t.size.ring)} solid ${inverted ? t.color['accent-contrast'] : t.color.focus}`,
        outlineOffset: px(t.size['ring-offset']),
      },
      disabled: { background: t.color['surface-alt'], color: t.color.muted, borderColor: t.color.border, cursor: 'not-allowed' },
      // §1.5: loading keeps its width — the label goes invisible, it is not removed.
      loading: { color: 'transparent', cursor: 'progress' },
    },
    below: compact
      ? { [compact]: hierarchy === 'primary'
          ? { width: '100%' }
          : { background: 'transparent', border: '1px solid transparent', color: inverted ? t.color['accent-contrast'] : t.color.accent, paddingInline: 0 } }
      : full && hierarchy === 'primary'
        ? { [full]: { width: '100%' } }
        : undefined,
  };
}

/** One slot fill as an action, at the given weight. */
function renderAction(t: ThemeLike, fill: SpecBlock, hierarchy: Hierarchy, options: ActionOptions): EmittedNode {
  const label = fill.args[0]?.value ?? '';
  const destination = fill.args[1];
  const intent = intentOf(destination) ?? 'go';
  const glyph = ICONS[intent];
  const kids: (EmittedNode | string)[] = [label];
  if (glyph?.at === 'lead') kids.unshift(icon(glyph.d));
  if (glyph?.at === 'trail') kids.push(icon(glyph.d));
  if (intent === 'external') kids.push(visuallyHidden(' (opens in new tab)'));

  const cls = `az-action az-action--${hierarchy} az-action--${intent}`;
  // §1.4: navigating is a link; acting (play, copy) is a button. The
  // behaviour runtime for those two is not built — the compiler warns
  // (AZ1222) and the button carries what the runtime will need.
  if (intent === 'play' || intent === 'copy') {
    return {
      tag: 'button',
      attrs: { type: 'button', class: cls, 'data-az-behaviour': intent, 'data-az-target': destination?.value ?? '' },
      ...actionStyle(t, hierarchy, options),
      children: kids,
    };
  }
  return {
    tag: 'a',
    attrs: {
      class: cls,
      href: destination?.value ?? '#',
      ...(intent === 'external' ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      ...(intent === 'download' ? { download: '' } : {}),
    },
    ...actionStyle(t, hierarchy, options),
    children: kids,
  };
}

/**
 * The three action functions of an EmitContext, bound to one theme.
 * `component` renders a `slot <name> <path>` naming one of the action
 * slots, so a user component joins the actions in source order (PRD §6.6).
 */
export function actionsFor(t: ThemeLike, component?: (c: SpecBlock) => EmittedNode): {
  action: (fill: SpecBlock, options?: ActionOptions) => EmittedNode;
  actions: (block: SpecBlock, slots: readonly string[], options?: ActionOptions) => EmittedNode[];
  submit: (label: string, options?: SubmitOptions) => EmittedNode;
} {
  return {
    action: (fill, options = {}) =>
      renderAction(t, fill, options.hierarchy ?? defaultHierarchy(fill, fill.word === 'cta' ? 0 : -1), options),

    actions: (block, slots, options = {}) => {
      let ctaIndex = 0;
      const item = (kind: string, child: EmittedNode): EmittedNode => ({
        tag: 'li', attrs: { class: `az-action-item az-action-item--${kind}` }, style: { listStyle: 'none' }, children: [child],
      });
      return slots.flatMap((slot) => block.children.flatMap((c): EmittedNode[] => {
        if (c.word === slot && ACTION_WORDS.has(c.word)) {
          const hierarchy = options.hierarchy ?? defaultHierarchy(c, c.word === 'cta' ? ctaIndex++ : -1);
          return [item(c.word, renderAction(t, c, hierarchy, options))];
        }
        if (component && c.word === 'slot' && c.args[0]?.value === slot) return [item('custom', component(c))];
        return [];
      }));
    },

    submit: (label, options = {}) => ({
      tag: 'button',
      attrs: {
        type: 'submit',
        class: `az-action az-action--${options.hierarchy ?? 'primary'}`,
        ...(options.name ? { name: options.name } : {}),
        ...(options.value ? { value: options.value } : {}),
        ...(options.noValidate ? { formnovalidate: 'formnovalidate' } : {}),
      },
      ...actionStyle(t, options.hierarchy ?? 'primary', options),
      children: [label],
    }),
  };
}
