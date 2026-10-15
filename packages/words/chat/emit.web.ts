/**
 * @az word chat
 * Purpose: a panel where a visitor asks the site's AI a question and reads the answer as it streams.
 * Spec: docs/chat-block-spec.md · terms: az explain chat
 * Renders: section.az-chat.az-chat--{variant}[data-az-chat=<config>][data-az-chat-state] > h2.az-chat-title#az-chat-title ·
 *   div.az-chat-panel > ol.az-chat-transcript[data-az-chat-transcript] > li.az-chat-message.az-chat-message--site (the greeting) > p.az-chat-text ·
 *     ol.az-chat-templates[hidden][data-az-chat-templates] > li.az-chat-message--visitor + li.az-chat-message--site, each > p.az-chat-text ·
 *     ul.az-chat-asks[hidden][data-az-chat-asks] > li.az-chat-ask-item > button.az-action[data-az-chat-ask] ·
 *     form.az-chat-form[hidden][data-az-chat-form] > label.az-chat-label + textarea.az-chat-input#az-chat-input ·
 *       div.az-chat-controls > Send [data-az-chat-send] (submit, primary) + Stop [data-az-chat-stop] (button, secondary, hidden) ·
 *     p.az-chat-note[data-az-chat-note] · p.az-chat-error[hidden][data-az-chat-error] ·
 *     div.az-chat-actions[hidden] > Try again [data-az-chat-retry] · New chat [data-az-chat-reset] ·
 *       Sign in to ask [data-az-chat-signin] (a link, only for allow signedin with a sign-in page) ·
 *     p.az-chat-status.az-visually-hidden[role=status][data-az-chat-status] · noscript > p.az-chat-noscript
 * Variants: panel — a section on one page (float, the launcher, comes in a later phase).
 * Modifiers: none in this release.
 * Props: title → h2.az-chat-title (default "Ask a question") · greeting → the first site message, never sent to the model ·
 *   allow → config: signedin (default) shows Sign in to ask to a signed-out visitor, anyone lets everyone ask ·
 *   limit → config: visitor messages per conversation · show → refused until components ship (core chat.ts, AZ1214) ·
 *   ask "question" → a suggested question button.
 * Styling: theme tokens only; visitor messages on color.surface-alt, answers on color.surface; the input's edge color.border-strong;
 *   focusVisible ring color.focus; errors color.danger; below sm the mobile gutter.
 * Behaviour: packages/overlay runtime chat.ts sends with fetch, reads the event stream and writes every answer as text
 *   (textContent) into copies of the hidden templates; the status region hears finished sentences. With JavaScript off
 *   the greeting and the noscript line show, and the form stays hidden.
 * Edit guide: one message → message(); the controls → form(); the hidden state lines → notes(); the config → config().
 *   Keep: no inline handler, no markup from the network, every control a real button or link, the label visible.
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/chat-shell.test.ts
 */

/**
 * `chat` — web emitter.
 *
 * chat-block-spec.md is the specification. The build has no conversation
 * and never calls a network, so the page ships a SHELL: the heading, the
 * greeting, a hidden form and hidden templates. The page runtime
 * (overlay chat.ts) shows the form once it is attached, sends each question
 * to the site's own backend and fills copies of the templates with the
 * answer's text — never markup — so every class an answer needs is one
 * this emitter made and the generated stylesheet already holds.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { framed, px, visuallyHidden, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** The shell's fixed copy; the runtime's copy lives in overlay chat-logic.ts. */
export const CHAT_COPY = {
  label: 'Your question',
  send: 'Send',
  stop: 'Stop',
  retry: 'Try again',
  reset: 'New chat',
  signin: 'Sign in to ask',
  transcript: 'Conversation',
  asks: 'Suggested questions',
  noscript: 'Turn on JavaScript to ask a question.',
} as const;

/** chat-block-spec §4.2: a visitor message is at most this many characters. */
export const MESSAGE_MAX = 1000;

/** The textarea's height in lines: room for a question, not an essay. */
const INPUT_ROWS = 3;

/** What the runtime reads from the shell: where the questions go and who may ask. Key order is fixed. */
function config(block: SpecBlock): string {
  return JSON.stringify({
    page: block.chat?.route ?? '/',
    allow: block.props.allow === 'anyone' ? 'anyone' : 'signedin',
    limit: Number(block.props.limit ?? 20),
    signin: block.chat?.signin ?? null,
  });
}

/** One message of the transcript: an item holding one paragraph of text. */
function message(who: 'visitor' | 'site', text: string, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  return {
    tag: 'li',
    attrs: { class: `az-chat-message az-chat-message--${who}` },
    style: {
      display: 'grid',
      gap: px(t.space[8]),
      maxWidth: `${t.size['measure-body']}ch`,
      padding: `${px(t.space[12])} ${px(t.space[16])}`,
      borderRadius: px(t.radius.md),
      background: who === 'visitor' ? t.color['surface-alt'] : t.color.surface,
      color: t.color.text,
      justifySelf: who === 'visitor' ? 'end' : 'start',
      listStyle: 'none',
    },
    children: [{
      tag: 'p',
      attrs: { class: 'az-chat-text' },
      style: { margin: 0, fontSize: t.typeSize.base, lineHeight: t.type['leading-body'], whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      children: text ? [text] : [],
    }],
  };
}

/** A control the runtime wires: a styled button that is never a form submit. */
function control(label: string, attr: string, ctx: EmitContext, hidden = true): EmittedNode {
  const b = ctx.submit(label, { hierarchy: 'secondary' });
  return { ...b, attrs: { ...b.attrs, type: 'button', [attr]: '', ...(hidden ? { hidden: 'hidden' } : {}) } };
}

/** The suggested questions: buttons that ask on the visitor's behalf. */
function asks(block: SpecBlock, ctx: EmitContext): EmittedNode | null {
  const t = ctx.theme;
  const questions = block.children.filter((c) => c.word === 'ask' && (c.args[0]?.value ?? '').trim() !== '');
  if (questions.length === 0) return null;
  return {
    tag: 'ul',
    attrs: { class: 'az-chat-asks', 'aria-label': CHAT_COPY.asks, hidden: 'hidden', 'data-az-chat-asks': '' },
    style: { display: 'flex', flexWrap: 'wrap', gap: px(t.space[8]), margin: 0, padding: 0 },
    children: questions.map((q): EmittedNode => ({
      tag: 'li',
      attrs: { class: 'az-chat-ask-item' },
      style: { listStyle: 'none' },
      children: [control(q.args[0].value, 'data-az-chat-ask', ctx, false)],
    })),
  };
}

/** The input and its buttons: a visible label, Enter sends, Shift+Enter is a new line (runtime). */
function form(ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const send = ctx.submit(CHAT_COPY.send, { hierarchy: 'primary' });
  return {
    tag: 'form',
    attrs: { class: 'az-chat-form', hidden: 'hidden', 'data-az-chat-form': '' },
    style: { display: 'grid', gap: px(t.space[8]) },
    children: [
      {
        tag: 'label',
        attrs: { for: 'az-chat-input', class: 'az-chat-label' },
        style: { fontSize: t.typeSize.sm, color: t.color.muted },
        children: [CHAT_COPY.label],
      },
      {
        tag: 'textarea',
        attrs: {
          id: 'az-chat-input', class: 'az-chat-input', name: 'message',
          rows: String(INPUT_ROWS), maxlength: String(MESSAGE_MAX), autocomplete: 'off', 'data-az-chat-input': '',
        },
        style: {
          width: '100%',
          minHeight: px(t.size.tap),
          padding: px(t.space[12]),
          background: t.color.bg,
          color: t.color.text,
          border: `1px solid ${t.color['border-strong']}`,
          borderRadius: px(t.radius.sm),
          fontSize: t.typeSize.base,
          lineHeight: t.type['leading-body'],
          resize: 'vertical',
        },
        states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
      },
      {
        tag: 'div',
        attrs: { class: 'az-chat-controls' },
        style: { display: 'flex', flexWrap: 'wrap', gap: px(t.space[8]) },
        children: [
          { ...send, attrs: { ...send.attrs, 'data-az-chat-send': '' } },
          control(CHAT_COPY.stop, 'data-az-chat-stop', ctx),
        ],
      },
    ],
  };
}

/** The lines the runtime fills or shows: a note, an error, the follow-up actions, the announcer. */
function notes(block: SpecBlock, ctx: EmitContext): EmittedNode[] {
  const t = ctx.theme;
  const line = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  const signin = block.chat?.signin
    ? ctx.action({
        word: 'link', variant: null, modifiers: [], props: {}, as: null, children: [],
        args: [{ kind: 'string', value: CHAT_COPY.signin }, { kind: 'route', value: block.chat.signin }],
      }, { hierarchy: 'primary' })
    : null;
  const announcer = visuallyHidden('');
  return [
    { tag: 'p', attrs: { class: 'az-chat-note', 'data-az-chat-note': '' }, style: { ...line, color: t.color.muted } },
    { tag: 'p', attrs: { class: 'az-chat-error', hidden: 'hidden', 'data-az-chat-error': '' }, style: { ...line, color: t.color.danger } },
    {
      tag: 'div',
      attrs: { class: 'az-chat-actions', hidden: 'hidden', 'data-az-chat-actions': '' },
      style: { display: 'flex', flexWrap: 'wrap', gap: px(t.space[8]) },
      children: [
        control(CHAT_COPY.retry, 'data-az-chat-retry', ctx),
        control(CHAT_COPY.reset, 'data-az-chat-reset', ctx),
        ...(signin ? [{ ...signin, attrs: { ...signin.attrs, hidden: 'hidden', 'data-az-chat-signin': '' } }] : []),
      ],
    },
    // §9: one polite region hears finished sentences; the transcript itself is not live.
    {
      ...announcer,
      tag: 'p',
      attrs: { class: 'az-visually-hidden az-chat-status', role: 'status', 'data-az-chat-status': '' },
      children: [],
    },
    { tag: 'noscript', children: [{ tag: 'p', attrs: { class: 'az-chat-noscript' }, style: { ...line, color: t.color.muted }, children: [CHAT_COPY.noscript] }] },
  ];
}

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'panel';
  const greeting = block.props.greeting?.trim() ?? '';
  const suggested = asks(block, ctx);
  return {
    tag: 'section',
    attrs: {
      class: `az-chat az-chat--${variant}`, 'aria-labelledby': 'az-chat-title',
      'data-az-chat': config(block), 'data-az-chat-state': 'idle',
    },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: framed(t),
      background: t.color.bg,
      color: t.color.text,
    },
    // The container drops to the mobile gutter (theme-spec §1).
    below: { sm: { paddingInline: px(t.size['gutter-sm']), paddingBlock: px(t.space[48]) } },
    children: [
      {
        tag: 'h2',
        attrs: { id: 'az-chat-title', class: 'az-chat-title' },
        style: {
          fontSize: t.typeSize['2xl'],
          lineHeight: t.type['leading-tight'],
          fontFamily: t.type.display,
          fontWeight: t.type['weight-display'],
          maxWidth: `${t.size['measure-display']}ch`,
          margin: `0 0 ${px(t.space[24])}`,
        },
        children: [block.props.title ?? 'Ask a question'],
      },
      {
        tag: 'div',
        attrs: { class: 'az-chat-panel' },
        style: { display: 'grid', gap: px(t.space[16]), maxWidth: `${t.size['measure-body']}ch` },
        children: [
          {
            tag: 'ol',
            attrs: { class: 'az-chat-transcript', 'aria-label': CHAT_COPY.transcript, 'data-az-chat-transcript': '' },
            style: { display: 'grid', gap: px(t.space[12]), margin: 0, padding: 0 },
            children: greeting ? [message('site', greeting, ctx)] : [],
          },
          {
            tag: 'ol',
            attrs: { class: 'az-chat-templates', hidden: 'hidden', 'data-az-chat-templates': '' },
            children: [message('visitor', '', ctx), message('site', '', ctx)],
          },
          ...(suggested ? [suggested] : []),
          form(ctx),
          ...notes(block, ctx),
        ],
      },
    ],
  };
}
