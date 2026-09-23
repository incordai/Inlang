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
/**
 * The page heading when the author writes no `title`. §11: the form title
 * IS the page's <h1>, so an untitled form would leave the page without one.
 */
const HEADING: Record<string, string> = {
  login: 'Sign in',
  signup: 'Create account',
  reset: 'Reset password',
};

const SUBMIT: Record<string, string> = {
  login: 'Sign in',
  signup: 'Create account',
  reset: 'Email me a link',
};

/** A passwordless submit says what happens next: an email, not a sign-in. */
const LINK_SUBMIT = 'Email me a link';
const LINK_ALTERNATIVE = 'Email me a link instead';

/**
 * The sign-in methods this form offers, in manifest order.
 *
 * `methods` arrives comma-joined (core's list serialisation) and defaulted to
 * `password`. Only the two methods Phase 1 ships are read: `oauth` is refused
 * by the compiler (AZ1214, auth-spec §12.3), so an emitter that met it would
 * be looking at a file that did not compile.
 */
function methodsOf(block: SpecBlock): { password: boolean; link: boolean } {
  const items = (block.props.methods ?? 'password').split(',');
  const link = items.includes('link');
  // A list naming only unknown methods still gets a form that works.
  return { password: items.includes('password') || !link, link };
}

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'login';
  const children: EmittedNode[] = [];

  // §11: the form title is the page's <h1> — auth pages have no hero, and
  // the form is the page's subject (open question 1's recommendation).
  children.push({
    tag: 'h1',
    attrs: { class: 'az-auth-title' },
    style: {
      fontSize: t.typeSize['2xl'],
      lineHeight: t.type['leading-tight'],
      fontFamily: t.type.display,
      fontWeight: t.type['weight-display'],
      maxWidth: `${t.size['measure-display']}ch`,
      margin: `0 0 ${px(t.space[16])}`,
    },
    children: [block.props.title ?? HEADING[variant] ?? HEADING.login],
  });

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

  // `reset` requests a link whatever the site's methods are (§5), so methods
  // shape only the two credential forms. A passwordless form asks for no
  // password at all — a field that is never used is one a manager fills and
  // a user wonders about.
  const methods = variant === 'reset' ? { password: false, link: true } : methodsOf(block);
  const fields = (FIELDS[variant] ?? FIELDS.login)
    .filter((f) => methods.password || f.type !== 'password');
  const formChildren: EmittedNode[] = fields.map((f) => field(f, ctx));

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

  const button = (method: string, label: string, primary: boolean): EmittedNode => ({
    tag: 'button',
    attrs: {
      type: 'submit',
      class: primary ? 'az-auth-submit' : 'az-auth-submit az-auth-submit--alt',
      // Which method this press chose, for the adapter call (§3).
      name: 'method',
      value: method,
      // §6/§7: one real form, so Enter submits the FIRST button and a manager
      // sees one credential form. The link button must not demand the
      // password it is the alternative to, so it skips validation.
      ...(primary ? {} : { formnovalidate: 'formnovalidate' }),
    },
    style: {
      minHeight: px(t.size.tap),
      paddingInline: px(t.space[16]),
      background: primary ? t.color.accent : 'transparent',
      color: primary ? t.color['accent-contrast'] : t.color.text,
      border: primary ? '0' : `1px solid ${t.color.border}`,
      borderRadius: px(t.radius.sm),
      fontSize: t.typeSize.base,
      fontFamily: t.type.body,
    },
    children: [label],
  });

  if (variant === 'reset') {
    formChildren.push(button('link', SUBMIT.reset, true));
  } else if (methods.password) {
    formChildren.push(button('password', SUBMIT[variant] ?? SUBMIT.login, true));
    if (methods.link) formChildren.push(button('link', LINK_ALTERNATIVE, false));
  } else {
    formChildren.push(button('link', LINK_SUBMIT, true));
  }

  children.push({
    tag: 'form',
    attrs: {
      class: 'az-auth-form',
      method: 'post',
      // The adapter is a ROLE, never a vendor name (PRD §6.5).
      'data-adapter': block.props.adapter ?? 'custom',
      'data-flow': variant,
      'data-methods': [methods.password && 'password', methods.link && 'link']
        .filter(Boolean).join(' '),
      // Where the M4 runtime sends a successful sign-in. The compiler has
      // already checked it is a page of this site (AZ1215).
      ...(block.props.redirect ? { 'data-redirect': block.props.redirect } : {}),
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
    // Slot fills are <li>; a <p> cannot hold one, so this is a list.
    children.push({
      tag: 'ul',
      attrs: { class: 'az-auth-alt' },
      style: {
        marginTop: px(t.space[16]), marginBottom: 0, padding: 0, listStyle: 'none',
        fontSize: t.typeSize.sm, color: t.color.muted,
      },
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
