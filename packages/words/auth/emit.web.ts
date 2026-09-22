/**
 * `auth` — web emitter.
 *
 * auth-block-spec.md §1 is emphatic: this block emits UI ONLY. No credential,
 * no token and no verification logic is in this file; the adapter owns all of
 * it, and the adapter is named by a ROLE word (`session`, `hosted`,
 * `azbackend`, `custom`) so no vendor appears in the language.
 *
 * The three variants are not skins — they ask for different things:
 *   `login`   email + password, and a route out to its siblings (§2: a login
 *             with no path to signup or reset is a dead end)
 *   `signup`  the only variant that may ask beyond credentials, and the one
 *             where every extra field costs sign-ups
 *   `reset`   two states in one variant (§5) — request a link, then set a new
 *             password; the state is chosen by a URL token at runtime
 *
 * `autocomplete` is load-bearing, not decoration (§8): `current-password` on a
 * login and `new-password` on signup and on the set-new step. Getting this
 * wrong makes password managers offer the wrong thing at the worst moment.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

interface Field {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly autocomplete: string;
}

const EMAIL: Field = { name: 'email', label: 'Email', type: 'email', autocomplete: 'email' };

/** What each variant actually asks for. */
const FIELDS: Record<string, Field[]> = {
  login: [
    EMAIL,
    { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
  ],
  signup: [
    { name: 'name', label: 'Name', type: 'text', autocomplete: 'name' },
    EMAIL,
    { name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password' },
  ],
  // §5's FIRST state. The set-new-password state is chosen by a URL token,
  // which is runtime, so the emitted form is the request.
  reset: [EMAIL],
};

/** The label/input pair. A placeholder is not a label — it vanishes on focus. */
function field(f: Field, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const id = `az-auth-${f.name}`;
  return {
    tag: 'div',
    attrs: { class: 'az-auth-field' },
    style: { display: 'grid', gap: px(t.space[4]) },
    children: [
      {
        tag: 'label',
        attrs: { for: id, class: 'az-auth-label' },
        style: { fontSize: t.typeSize.sm, color: t.color.muted },
        children: [f.label],
      },
      {
        tag: 'input',
        attrs: {
          id,
          name: f.name,
          type: f.type,
          autocomplete: f.autocomplete,
          required: 'required',
        },
        style: {
          minHeight: px(t.size.tap),
          paddingInline: px(t.space[12]),
          background: t.color.bg,
          color: t.color.text,
          border: `1px solid ${t.color.border}`,
          borderRadius: px(t.radius.sm),
          fontSize: t.typeSize.base,
        },
      },
    ],
  };
}

/** The submit label matches what the button DOES, never "Submit". */
const SUBMIT: Record<string, string> = {
  login: 'Sign in',
  signup: 'Create account',
  reset: 'Email me a link',
};

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'login';
  const children: EmittedNode[] = [];

  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-auth-title' },
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
      attrs: { class: 'az-auth-sub' },
      style: {
        fontSize: t.typeSize.base,
        lineHeight: t.type['leading-body'],
        color: t.color.muted,
        maxWidth: `${t.size['measure-body']}ch`,
        margin: `0 0 ${px(t.space[24])}`,
      },
      children: [block.props.sub],
    });
  }

  const formChildren: EmittedNode[] = (FIELDS[variant] ?? FIELDS.login).map((f) => field(f, ctx));

  // §2: signup is the only variant that may ask beyond credentials, and terms
  // must be an explicit choice — never a pre-ticked box or an implied consent.
  if (variant === 'signup' && block.props.terms) {
    formChildren.push({
      tag: 'div',
      attrs: { class: 'az-auth-terms' },
      style: { display: 'flex', gap: px(t.space[8]), alignItems: 'center' },
      children: [
        { tag: 'input', attrs: { id: 'az-auth-terms', name: 'terms', type: 'checkbox', required: 'required' } },
        {
          tag: 'label',
          attrs: { for: 'az-auth-terms' },
          style: { fontSize: t.typeSize.sm, color: t.color.muted },
          children: [
            'I agree to the ',
            { tag: 'a', attrs: { href: block.props.terms }, children: ['terms'] },
          ],
        },
      ],
    });
  }

  formChildren.push({
    tag: 'button',
    attrs: { type: 'submit', class: 'az-auth-submit' },
    style: {
      minHeight: px(t.size.tap),
      paddingInline: px(t.space[16]),
      background: t.color.accent,
      color: t.color['accent-contrast'],
      border: '0',
      borderRadius: px(t.radius.sm),
      fontSize: t.typeSize.base,
      fontFamily: t.type.body,
    },
    children: [SUBMIT[variant] ?? SUBMIT.login],
  });

  children.push({
    tag: 'form',
    attrs: {
      class: 'az-auth-form',
      method: 'post',
      // The adapter is a ROLE, never a vendor name (PRD §6.5).
      'data-adapter': block.props.adapter ?? 'custom',
      'data-flow': variant,
    },
    style: {
      display: 'grid',
      gap: px(t.space[16]),
      maxWidth: `${t.size['measure-display']}ch`,
      padding: px(t.space[32]),
      background: t.color.surface,
      borderRadius: px(t.radius.md),
    },
    children: formChildren,
  });

  // §2: "a login with no path to signup or reset is a dead end". The routes
  // are the author's to name; what is emitted here is the slot they fill, and
  // its absence on a login is a hole worth seeing.
  const alt = ctx.slot('alt');
  if (alt.length > 0) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-auth-alt' },
      style: { marginTop: px(t.space[16]), fontSize: t.typeSize.sm, color: t.color.muted },
      children: alt,
    });
  }

  return {
    tag: 'section',
    attrs: { class: `az-auth az-auth--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.bg,
      color: t.color.text,
    },
    children,
  };
}
