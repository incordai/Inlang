/**
 * @az word chat
 * Purpose: a panel where a visitor asks the site's AI a question and reads the answer as it streams.
 * Spec: docs/chat-block-spec.md · terms: az explain chat
 * Renders: section.az-chat.az-chat--{variant}[data-az-chat=<config>][data-az-chat-state] > h2.az-chat-title#az-chat-title ·
 *   div.az-chat-panel > ol.az-chat-transcript[data-az-chat-transcript] > li.az-chat-message.az-chat-message--site (the greeting) > p.az-chat-text ·
 *     ol.az-chat-templates[hidden][data-az-chat-templates] > li.az-chat-message--visitor + li.az-chat-message--site, each > p.az-chat-text ·
 *     (with show) div.az-chat-parts[hidden][data-az-chat-parts] > div.az-chat-part[data-az-chat-part=quote|faq|feature|cta-<kind>] —
 *       a quoted pricing block as its page renders it ([data-az-chat-quote=/route#n][data-az-chat-plans=n]; its behaviour
 *       marks parked as [data-az-chat-behaviour]), an faq or feature item list as those
 *       words render a `from` template (markers where the text goes), a call to action per kind of destination ·
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
 *   limit → config: visitor messages per conversation · show → config and the parts' templates (pricing quoted; faq, cta, feature composed) ·
 *   ask "question" → a suggested question button.
 * Styling: theme tokens only; visitor messages on color.surface-alt, answers on color.surface; the input's edge color.border-strong;
 *   focusVisible ring color.focus; errors color.danger; below sm the mobile gutter.
 * Behaviour: packages/overlay runtime chat.ts sends with fetch, reads the event stream and writes every answer as text
 *   (textContent) into copies of the hidden templates — a component into a copy of its part, a destination only from the
 *   config's allow-list; the status region hears finished sentences. Other words render the parts (ctx.embed). With JavaScript off
 *   the greeting and the noscript line show, and the form stays hidden.
 * Edit guide: one message → message(); the controls → form(); the hidden state lines → notes(); the config → config();
 *   the components' templates → parts() (ids and behaviour marks parked by asTemplate()).
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
import type { SpecFrom } from '../../core/src/spec-block.ts';
import { framed, fromMark, px, visuallyHidden, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

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
  /** The name a composed list's template is made under; never shown. */
  answer: 'answer',
} as const;

/** chat-block-spec §4.2: a visitor message is at most this many characters. */
export const MESSAGE_MAX = 1000;

/** The textarea's height in lines: room for a question, not an essay. */
const INPUT_ROWS = 3;

/**
 * What the runtime reads from the shell: where the questions go, who may
 * ask, and — when answers hold components — which ones, and the only
 * destinations an answer's call to action may use. Key order is fixed.
 */
function config(block: SpecBlock): string {
  const answer = block.chat?.answer;
  return JSON.stringify({
    page: block.chat?.route ?? '/',
    allow: block.props.allow === 'anyone' ? 'anyone' : 'signedin',
    limit: Number(block.props.limit ?? 20),
    signin: block.chat?.signin ?? null,
    ...(answer ? { show: answer.show, to: answer.destinations } : {}),
  });
}

/* ---- the templates an answer's components fill (chat-block-spec §5.4) ---- */

/** The most items an answer's faq or feature list holds (the server's answer parser caps it the same). */
const ANSWER_ITEMS = 6;

/** Attributes holding ONE id, then a list of ids (target-web ids.ts, the same lists). */
const ID_ONE = ['for', 'list', 'form', 'aria-controls', 'aria-activedescendant', 'aria-details', 'aria-errormessage'];
const ID_LIST = ['aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-flowto', 'headers'];

const walk = (n: EmittedNode | string): EmittedNode[] => (typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)]);

/**
 * A rendered block made into a template: every id and radio group given
 * `suffix` (a page may show the same block, and one panel several
 * templates), every reference rewritten with it; behaviour marks parked as
 * `data-az-chat-behaviour`, so the behaviour runtime wires each filled copy
 * and never the template; and nothing that would animate it in.
 */
function asTemplate(node: EmittedNode, suffix: string): EmittedNode {
  const ids = new Set(walk(node).map((n) => n.attrs?.id).filter((id): id is string => !!id));
  const ren = (id: string) => (ids.has(id) ? `${id}-${suffix}` : id);
  const rewrite = (n: EmittedNode | string): EmittedNode | string => {
    if (typeof n === 'string') return n;
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.attrs ?? {})) {
      if (k === 'data-az-behaviour' || k === 'data-az-from-behaviour') attrs['data-az-chat-behaviour'] = v;
      else if (k === 'data-az-from-template' || k === 'data-az-reveal' || k === 'data-az-reveal-item') continue;
      else if (k === 'id' || ID_ONE.includes(k)) attrs[k] = ren(v);
      else if (ID_LIST.includes(k)) attrs[k] = v.split(/\s+/).map(ren).join(' ');
      else if (k === 'href' && v.startsWith('#')) attrs[k] = `#${ren(v.slice(1))}`;
      else if (k === 'name' && n.attrs?.type === 'radio') attrs[k] = `${v}-${suffix}`;
      else attrs[k] = v;
    }
    return { ...n, ...(n.attrs ? { attrs } : {}), ...(n.children ? { children: n.children.map(rewrite) } : {}) };
  };
  return rewrite(node) as EmittedNode;
}

/** One part of an answer, as the runtime finds it: `data-az-chat-part` names what it is. */
function part(key: string, node: EmittedNode, extra: Record<string, string> = {}): EmittedNode {
  return {
    tag: 'div',
    attrs: { class: 'az-chat-part', 'data-az-chat-part': key, ...extra },
    // The part's own block brings its own surface; the part only keeps it inside the answer.
    style: { minWidth: 0, maxWidth: '100%' },
    children: [node],
  };
}

/** A `from` template for one composed list: the word's own item, with markers where the answer's text goes. */
function composed(word: 'faq' | 'feature', ctx: EmitContext): EmittedNode | null {
  const map: Record<string, string> = word === 'faq' ? { question: 'q', text: 'a' } : { text: 'text', title: 'title' };
  const from: SpecFrom = {
    table: CHAT_COPY.answer, slot: 'item', label: word === 'faq' ? 'question' : 'title', map,
    types: Object.fromEntries(Object.keys(map).map((k) => [k, 'text'])),
    sort: null, limit: ANSWER_ITEMS, filter: {}, mine: false, empty: '', signin: null,
  };
  // A title keeps the items one heading level under the panel's own h2; it is not drawn (only the template is kept).
  const rendered = ctx.embed!({
    word, variant: word === 'faq' ? 'list' : 'rows', modifiers: [], args: [], as: null, children: [], from,
    props: { title: CHAT_COPY.answer, ...(word === 'faq' ? { schema: 'off' } : {}) },
  });
  const list = walk(rendered).find((n) => n.attrs?.['data-az-from-template'] !== undefined);
  if (!list) return null;
  // Shown once filled: the template's own `hidden` is the shell's, not the list's.
  return { ...list, attrs: Object.fromEntries(Object.entries(list.attrs ?? {}).filter(([k]) => k !== 'hidden')) };
}

/** How a destination is followed — and so which action template it fills: a route, or its scheme. */
const linkKind = (to: string) => (to.startsWith('/') ? 'route' : to.slice(0, to.indexOf(':')).toLowerCase());

/**
 * The hidden templates of every component this chat's answers may hold:
 * each quotable pricing block exactly as its page renders it, and the faq,
 * feature list and call to action rendered by their own words with markers
 * for the text. Nothing here is new styling — every class is one those words
 * made. Without `show`, or without emitters to hand, there are none.
 */
function parts(block: SpecBlock, ctx: EmitContext): EmittedNode | null {
  const answer = block.chat?.answer;
  if (!answer || !ctx.embed) return null;
  const out: EmittedNode[] = [];
  if (answer.show.includes('pricing')) {
    for (const q of answer.quotes) {
      const key = `${q.route}#${q.n}`;
      // The plan count is what the status region says of it ("Pricing table, 2 plans").
      const plans = String(q.block.children.filter((c) => c.word === 'plan').length);
      out.push(part('quote', asTemplate(ctx.embed(q.block), `chat-q${out.length}`), { 'data-az-chat-quote': key, 'data-az-chat-plans': plans }));
    }
  }
  for (const word of ['faq', 'feature'] as const) {
    if (!answer.show.includes(word)) continue;
    const list = composed(word, ctx);
    if (list) out.push(part(word, asTemplate(list, `chat-${word}`)));
  }
  if (answer.show.includes('cta')) {
    // One button per way a destination is followed, made with a real one of
    // that kind; the runtime sets the label and the checked destination.
    const kinds = new Map<string, string>();
    for (const to of answer.destinations) if (!kinds.has(linkKind(to))) kinds.set(linkKind(to), to);
    for (const [kind, sample] of kinds) {
      const action = ctx.action({
        word: 'cta', variant: null, modifiers: [], props: {}, as: null, children: [],
        args: [{ kind: 'string', value: fromMark('label') }, { kind: kind === 'route' ? 'route' : 'pair', value: sample }],
      }, { hierarchy: 'primary' });
      out.push(part(`cta-${kind}`, action));
    }
  }
  return {
    tag: 'div',
    attrs: { class: 'az-chat-parts', hidden: 'hidden', 'data-az-chat-parts': '' },
    children: out,
  };
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
  const components = parts(block, ctx);
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
          ...(components ? [components] : []),
          ...(suggested ? [suggested] : []),
          form(ctx),
          ...notes(block, ctx),
        ],
      },
    ],
  };
}
