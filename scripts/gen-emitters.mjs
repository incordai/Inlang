/**
 * Scaffold the remaining word emitters from their manifests.
 *
 * These are FIRST-PASS emitters: each implements the structural core of its
 * spec — the right element, the right heading level, the token-only values —
 * not the complete 12-point gate. The gate (visual snapshots, axe, keyboard,
 * both schemes) is M2 work that follows.
 *
 * Written as a script rather than by hand so the shared rules — h2 not h1,
 * measure on the text, spacing from the scale — are applied identically
 * everywhere instead of eleven times from memory.
 */

import { writeFileSync } from 'node:fs';

const header = (word) => `/**
 * \`${word}\` — web emitter.
 *
 * ${word}-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through \`ctx.theme\` — \`az lint\` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

`;

/** The heading pair every section block shares. */
const headBlock = (word) => `  // A section heading is an <h2>: the hero owns the page's only <h1>
  // (hero-spec §4), so the outline stays valid at exactly one level down.
  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-${word}-title' },
      style: {
        fontSize: t.typeSize['2xl'],
        lineHeight: t.type['leading-tight'],
        fontFamily: t.type.display,
        fontWeight: t.type['weight-display'],
        // The MEASURE goes on the text, never the container — hero-spec §3.
        maxWidth: \`\${t.size['measure-display']}ch\`,
        margin: \`0 0 \${px(t.space[16])}\`,
      },
      children: [block.props.title],
    });
  }

  if (block.props.sub) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-${word}-sub' },
      style: {
        fontSize: t.typeSize.lg,
        lineHeight: t.type['leading-body'],
        color: t.color.muted,
        maxWidth: \`\${t.size['measure-body']}ch\`,
        margin: \`0 0 \${px(t.space[48])}\`,
      },
      children: [block.props.sub],
    });
  }
`;

const WORDS = {
  cta: {
    def: 'band', tag: 'section', padY: 96, bg: 'surface',
    body: `  const actions = [...ctx.slot('cta'), ...ctx.slot('alt')];
  if (actions.length > 0) {
    children.push({
      tag: 'div',
      attrs: { class: 'az-cta-actions' },
      // The block lays actions out; it does not decide hierarchy. Max one
      // primary per section is the button primitive's rule (buttons §1.2).
      style: { display: 'flex', gap: px(t.space[16]), flexWrap: 'wrap' },
      children: actions,
    });
  }
`,
  },
  feature: {
    def: 'grid', tag: 'section', padY: 96, bg: 'bg',
    body: `  const items = ctx.slot('item');
  if (items.length > 0) {
    children.push({
      tag: 'ul',
      attrs: { class: 'az-feature-items' },
      style: {
        display: 'grid',
        // \`columns\` counts items, so a number is honest here — PRD §6.1a.
        gridTemplateColumns: variant === 'rows'
          ? '1fr'
          : \`repeat(\${block.props.columns ?? '3'}, minmax(0, 1fr))\`,
        // Row gap exceeds column gap, or a grid of items reads as columns of
        // text instead of a set.
        columnGap: px(t.space[32]),
        rowGap: px(t.space[48]),
        listStyle: 'none', padding: 0, margin: 0,
      },
      children: items,
    });
  }
`,
  },
  gallery: {
    def: 'grid', tag: 'section', padY: 96, bg: 'bg',
    body: `  const images = ctx.slot('image');
  if (images.length > 0) {
    children.push({
      tag: 'ul',
      attrs: { class: 'az-gallery-items', 'data-ratio': block.props.ratio ?? '4 / 3' },
      style: {
        display: 'grid',
        gridTemplateColumns: variant === 'masonry'
          ? 'repeat(auto-fill, minmax(240px, 1fr))'
          : \`repeat(\${block.props.columns ?? '3'}, minmax(0, 1fr))\`,
        gap: px(t.space[16]),
        listStyle: 'none', padding: 0, margin: 0,
      },
      children: images,
    });
  }
`,
  },
  pricing: {
    def: 'cards', tag: 'section', padY: 96, bg: 'bg',
    body: `  const plans = ctx.slot('plan');
  if (plans.length > 0) {
    children.push({
      tag: variant === 'table' ? 'table' : 'ul',
      attrs: { class: 'az-pricing-plans' },
      // A real <table> for the table variant: a grid of divs reads "15" with
      // no indication of which plan it belongs to (pricing-spec §8).
      style: variant === 'table'
        ? { width: '100%', borderCollapse: 'collapse' }
        : {
            display: 'grid',
            gridTemplateColumns: \`repeat(\${plans.length}, minmax(0, 1fr))\`,
            // One step larger than the card's own padding, or the cards fuse
            // into a single bar.
            gap: px(t.space[24]),
            listStyle: 'none', padding: 0, margin: 0,
          },
      children: plans,
    });
  }
`,
  },
  faq: {
    def: 'list', tag: 'section', padY: 96, bg: 'bg',
    body: `  const items = ctx.slot('item');
  if (items.length > 0) {
    children.push({
      tag: 'div',
      attrs: { class: 'az-faq-items' },
      style: {
        display: variant === 'columns' ? 'grid' : 'block',
        gridTemplateColumns: variant === 'columns' ? 'repeat(2, minmax(0, 1fr))' : 'none',
        columnGap: px(t.space[48]),
        maxWidth: \`\${t.size['measure-body']}ch\`,
      },
      children: items,
    });
  }
`,
  },
  auth: {
    def: 'login', tag: 'section', padY: 96, bg: 'surface',
    body: `  // PRD §6.5: this emits UI ONLY and never implements auth. No credential
  // reaches this file, and the adapter is a ROLE word, never a vendor name.
  children.push({
    tag: 'form',
    attrs: {
      class: 'az-auth-form',
      'data-adapter': block.props.adapter ?? 'custom',
    },
    style: {
      display: 'grid',
      gap: px(t.space[16]),
      maxWidth: \`\${t.size['measure-display']}ch\`,
      padding: px(t.space[32]),
      background: t.color.surface,
      borderRadius: px(t.radius.md),
    },
    children: ctx.slot('alt'),
  });
`,
  },
  scene: {
    def: 'inline', tag: 'section', padY: 64, bg: 'bg',
    body: `  // scene-spec §5: ONE renderer per page, shared by every scene on it. This
  // emitter declares a viewport and a poster; it never creates a context.
  children.push({
    tag: 'figure',
    attrs: {
      class: 'az-scene-viewport',
      'data-variant': variant,
      'data-poster': block.props.poster ?? '',
      role: 'img',
      'aria-label': block.props.alt ?? '',
    },
    style: {
      margin: 0,
      // Reserve the box before anything loads, or arrival shifts the page.
      aspectRatio: block.props.ratio ?? '16 / 9',
      background: t.color['surface-alt'],
      borderRadius: px(t.radius.md),
    },
    children: block.props.caption
      ? [{
          tag: 'figcaption',
          style: {
            fontSize: t.typeSize.xs,
            color: t.color.muted,
            marginTop: px(t.space[12]),
          },
          children: [block.props.caption],
        }]
      : [],
  });
`,
  },
};

for (const [word, cfg] of Object.entries(WORDS)) {
  const src = header(word) + `export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? '${cfg.def}';
  const children: EmittedNode[] = [];

${headBlock(word)}
${cfg.body}
  return {
    tag: '${cfg.tag}',
    attrs: { class: \`az-${word} az-${word}--\${variant}\` },
    style: {
      paddingBlock: px(t.space[${cfg.padY}]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.${cfg.bg},
      color: t.color.text,
    },
    children,
  };
}
`;
  writeFileSync(new URL(`../packages/words/${word}/emit.web.ts`, import.meta.url), src, 'utf8');
  console.log('wrote', word);
}
