/**
 * @az word chat
 * Purpose: a panel — inline, or opened from a corner launcher — where a visitor asks the site's AI a question and reads the answer as it streams.
 * Spec: docs/chat-block-spec.md · terms: az explain chat
 * Renders: section.az-chat.az-chat--panel[data-az-chat=<config>][data-az-chat-state] > h2.az-chat-title#az-chat-title ·
 *   (float: div.az-chat.az-chat--float[data-az-chat] > button.az-chat-launcher[data-az-chat-launcher][hidden] (the title) +
 *     dialog.az-chat-dialog#az-chat-dialog[data-az-overlay=sheet] > div.az-chat-sheet > div.az-chat-sheet-handle[data-az-drag] (below sm) + div.az-chat-head (the h2 + Close
 *     [data-az-chat-close]) + the same panel) ·
 *   div.az-chat-panel > ol.az-chat-transcript[data-az-chat-transcript][tabindex=0] (scrolls) > li.az-chat-message.az-chat-message--site (the greeting) > p.az-chat-text ·
 *     button[data-az-chat-latest][hidden] (Jump to latest) ·
 *     ol.az-chat-templates[hidden][data-az-chat-templates] > li.az-chat-message--visitor + li.az-chat-message--site, each > p.az-chat-text ·
 *     (with show) div.az-chat-parts[hidden][data-az-chat-parts] > div.az-chat-part[data-az-chat-part=quote|faq|feature|cta-<kind>] —
 *       a quoted pricing block as its page renders it ([data-az-chat-quote=/route#n][data-az-chat-plans=n]; its behaviour
 *       marks parked as [data-az-chat-behaviour]), an faq or feature item list as those
 *       words render a `from` template (markers where the text goes), a call to action per kind of destination ·
 *       and (C2b, figures.ts) the paint, figure, table, stats, cards, dashboard, unavailable, asset and share parts ·
 *     div.az-chat-prose[hidden][data-az-chat-prose] (C5) > the prose elements, each marked [data-az-chat-slot] — strong, em, code,
 *       ul > li, ol, div.az-chat-code > div.az-chat-code-bar (the language + Copy code [data-az-chat-copy]) + pre[tabindex=0] > code,
 *       ul.az-chat-follows > li.az-chat-follow-item > button ·
 *     div.az-chat-history[hidden][data-az-chat-history] > p.az-chat-privacy + Clear history [data-az-chat-clear] ·
 *     (the shared-answer page, chat.shared: the title an h1) p.az-chat-note + h2.az-chat-shared-heading + the transcript, templates and parts + p.az-chat-error +
 *       button.az-chat-delete[data-az-chat-delete] (hidden; shown for the delete link) — no form, no suggestions ·
 *     ul.az-chat-asks[hidden][data-az-chat-asks] > li.az-chat-ask-item > button.az-action[data-az-chat-ask] ·
 *     form.az-chat-form[hidden][data-az-chat-form] > label.az-chat-label + textarea.az-chat-input#az-chat-input ·
 *       div.az-chat-controls > Send [data-az-chat-send] (submit, primary) + Stop [data-az-chat-stop] (button, secondary, hidden) ·
 *     p.az-chat-note[data-az-chat-note] · p.az-chat-error[hidden][data-az-chat-error] ·
 *     div.az-chat-actions[hidden] > Try again [data-az-chat-retry] · New chat [data-az-chat-reset] ·
 *       Sign in to ask [data-az-chat-signin] (a link, only for allow signedin with a sign-in page) ·
 *     p.az-chat-status.az-visually-hidden[role=status][data-az-chat-status] · noscript > p.az-chat-noscript
 * Variants: panel — a section on one page · float — a launcher fixed to the inline-end bottom corner that opens the panel:
 *   a bottom sheet (modal, focus trapped) below sm, a side panel (not modal) above; declared under `site` it is on every
 *   page, and `chat none` leaves it out of one · none — no chat on this page (blocksFor drops it; never emitted).
 * Modifiers: none in this release.
 * Props: title → h2.az-chat-title and the launcher's name (default "Ask a question") · greeting → the first site message, never sent to the model ·
 *   allow → config: signedin (default) shows Sign in to ask to a signed-out visitor, anyone lets everyone ask ·
 *   limit → config: visitor messages per conversation · show → config and the parts' templates (pricing quoted; faq, cta, feature composed) ·
 *   knows → nothing here (the server reads those rows) · ask "question" → a suggested question button.
 * Styling: theme tokens only; visitor messages on color.surface-alt, answers on color.surface; the input's edge color.border-strong;
 *   focusVisible ring color.focus; errors color.danger; below sm the mobile gutter.
 * Behaviour: packages/overlay runtime chat.ts sends with fetch, reads the event stream and writes every answer as text
 *   (textContent) into copies of the hidden templates — a component into a copy of its part, a destination only from the
 *   config's allow-list; the status region hears finished sentences. Other words render the parts (ctx.embed). With JavaScript off
 *   the greeting and the noscript line show, and the form stays hidden.
 * Edit guide: one message → message(); the controls → form(); the hidden state lines → notes(); the config → config();
 *   the components' templates → parts() (ids and behaviour marks parked by asTemplate()); the launcher and its dialog → floatShell().
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
import { closeButton } from '../../overlay/src/index.ts';
import { assetParts, richParts, sharePart } from './figures.ts';

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
  /** The shared-answer page (chat-block-spec §20.7). */
  shared: 'A shared answer',
  sharedIntro: 'An answer from this site’s AI assistant, shared by a visitor.',
  sharedDelete: 'Delete this shared answer',
  sharedAnswer: 'The answer',
  /** §9: shown when the visitor has scrolled up from the newest words. */
  latest: 'Jump to latest',
  close: 'Close',
  /** C5 (chat-block-spec §21.1): the code block's Copy, the follow-ups' list, the history kept in this browser. */
  copy: 'Copy code',
  follows: 'Follow-up questions',
  clear: 'Clear history',
  /**
   * chat-block-spec §19.11: what is kept is bound to who reads it — a signed-in chat to the account (signing out
   * clears it, another account never sees it), a chat open to anyone to the browser until someone signs in.
   */
  privacy: 'This chat is kept in this browser for 7 days, for your account only; signing out clears it.',
  privacyAnyone: 'This chat is kept in this browser for 7 days; signing in clears it. On a shared computer, clear it when you are done.',
} as const;

/** The float's dialog: the launcher's aria-controls points here. */
const DIALOG_ID = 'az-chat-dialog';

/** chat-block-spec §4.2: a visitor message is at most this many characters. */
export const MESSAGE_MAX = 1000;

/** The textarea's height in lines: room for a question, not an essay. */
const INPUT_ROWS = 3;

/**
 * What the runtime reads from the shell: where the questions go, who may
 * ask, and — when answers hold components — which ones, and the only
 * destinations an answer's call to action may use. Key order is fixed.
 */
function config(block: SpecBlock, ctx: EmitContext): string {
  const answer = block.chat?.answer;
  return JSON.stringify({
    page: block.chat?.route ?? '/',
    allow: block.props.allow === 'anyone' ? 'anyone' : 'signedin',
    limit: Number(block.props.limit ?? 20),
    signin: block.chat?.signin ?? null,
    ...(answer ? { show: answer.show, to: answer.destinations } : {}),
    ...(block.chat?.shared ? { shared: true } : {}),
    // A float opens as a modal sheet below this width, a side panel above it (chat-block-spec §3.2).
    ...(block.variant === 'float' ? { narrow: ctx.theme.breakpoint.sm } : {}),
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
function composed(word: 'faq' | 'feature', embed: NonNullable<EmitContext['embed']>): EmittedNode | null {
  const map: Record<string, string> = word === 'faq' ? { question: 'q', text: 'a' } : { text: 'text', title: 'title' };
  const from: SpecFrom = {
    table: CHAT_COPY.answer, slot: 'item', label: word === 'faq' ? 'question' : 'title', map,
    types: Object.fromEntries(Object.keys(map).map((k) => [k, 'text'])),
    sort: null, limit: ANSWER_ITEMS, filter: {}, mine: false, empty: '', signin: null,
  };
  // A title keeps the items one heading level under the panel's own h2; it is not drawn (only the template is kept).
  const rendered = embed({
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
    const list = composed(word, ctx.embed);
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
  // C2b (§20): charts, tables, stats, image cards and dashboards, the gallery images a card may name, and Share.
  out.push(...richParts(answer, ctx), ...assetParts(answer, ctx), sharePart(ctx));
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

/**
 * The elements an answer's prose may be drawn in (chat-block-spec §21.1.3):
 * one hidden template per element the markdown subset's tree holds, and the
 * follow-up questions' list. The runtime (overlay chat-prose.ts) clones these
 * — never creating an element — and writes text only, so every class here is
 * in the generated sheet. A paragraph is the answer template's own.
 */
function proseParts(ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const slot = (name: string, tag: string, style: EmittedNode['style'], children: (EmittedNode | string)[] = [], attrs: Record<string, string> = {}): EmittedNode =>
    ({ tag, attrs: { 'data-az-chat-slot': name, ...attrs }, style, children });
  const list = { margin: 0, paddingInlineStart: px(t.space[24]), display: 'grid', gap: px(t.space[4]), fontSize: t.typeSize.base, lineHeight: t.type['leading-body'] };
  const mono = { fontFamily: t.type.mono, fontSize: t.typeSize.sm };
  const copy = control(CHAT_COPY.copy, 'data-az-chat-copy', ctx, false);
  const follow = control('', 'data-az-chat-follow', ctx, false);
  return {
    tag: 'div',
    attrs: { class: 'az-chat-prose', hidden: 'hidden', 'data-az-chat-prose': '' },
    children: [
      slot('strong', 'strong', { fontWeight: t.type['weight-bold'] }),
      slot('em', 'em', { fontStyle: 'italic' }),
      slot('code', 'code', { ...mono, padding: `0 ${px(t.space[4])}`, borderRadius: px(t.radius.sm), background: t.color['surface-alt'], color: t.color.text, overflowWrap: 'anywhere' }),
      slot('ul', 'ul', list, [slot('li', 'li', { overflowWrap: 'anywhere' })]),
      slot('ol', 'ol', list),
      slot('code-block', 'div', { display: 'grid', gap: px(t.space[4]), minWidth: 0 }, [
        {
          tag: 'div', attrs: { class: 'az-chat-code-bar' },
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: px(t.space[8]) },
          children: [
            slot('lang', 'span', { fontSize: t.typeSize.sm, color: t.color.muted }),
            { ...copy, attrs: { ...copy.attrs, 'data-az-chat-slot': 'copy' } },
          ],
        },
        {
          // A scroll region the keyboard reaches (§21.1.6), ringed like the transcript when focused.
          ...slot('pre', 'pre', {
            margin: 0, padding: px(t.space[12]), maxWidth: '100%', overflowX: 'auto',
            background: t.color.bg, color: t.color.text, border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.sm),
          }, [slot('code-text', 'code', { ...mono, whiteSpace: 'pre' })], { tabindex: '0' }),
          states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
        },
      ], { class: 'az-chat-code' }),
      slot('follows', 'ul', { display: 'flex', flexWrap: 'wrap', gap: px(t.space[8]), margin: 0, padding: 0 }, [{
        tag: 'li', attrs: { class: 'az-chat-follow-item' }, style: { listStyle: 'none' },
        children: [{ ...follow, attrs: { ...follow.attrs, 'data-az-chat-slot': 'follow' } }],
      }], { class: 'az-chat-follows', 'aria-label': CHAT_COPY.follows }),
    ],
  };
}

/**
 * The line that says the chat is kept in this browser, and Clear history
 * (§21.1.4) — hidden until the runtime finds it can keep anything.
 */
function historyLine(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const note = block.props.allow === 'anyone' ? CHAT_COPY.privacyAnyone : CHAT_COPY.privacy;
  return {
    tag: 'div',
    attrs: { class: 'az-chat-history', hidden: 'hidden', 'data-az-chat-history': '' },
    style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: px(t.space[8]) },
    children: [
      { tag: 'p', attrs: { class: 'az-chat-privacy' }, style: { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'], color: t.color.muted }, children: [note] },
      control(CHAT_COPY.clear, 'data-az-chat-clear', ctx, false),
    ],
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

/**
 * The shared-answer page's shell (chat-block-spec §20.7): read-only — no
 * input, no suggestions, no Share. The runtime reads the link's fragment,
 * fetches that one answer and draws it with the same templates; with the
 * delete link's token it offers Delete.
 */
function sharedShell(ctx: EmitContext, components: EmittedNode | null): EmittedNode[] {
  const t = ctx.theme;
  const line = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  const del = control(CHAT_COPY.sharedDelete, 'data-az-chat-delete', ctx);
  return [
    { tag: 'p', attrs: { class: 'az-chat-note', 'data-az-chat-note': '' }, style: { ...line, color: t.color.muted }, children: [CHAT_COPY.sharedIntro] },
    // The page's h1 is the shell's title; the answer's own headings (h3) sit under this one.
    {
      tag: 'h2', attrs: { class: 'az-chat-shared-heading' },
      style: { margin: 0, fontSize: t.typeSize.base, lineHeight: t.type['leading-tight'], color: t.color.text },
      children: [CHAT_COPY.sharedAnswer],
    },
    {
      tag: 'ol',
      attrs: { class: 'az-chat-transcript', 'aria-label': CHAT_COPY.transcript, 'data-az-chat-transcript': '', 'aria-busy': 'true' },
      style: { display: 'grid', gap: px(t.space[12]), margin: 0, padding: 0 },
      children: [],
    },
    {
      tag: 'ol',
      attrs: { class: 'az-chat-templates', hidden: 'hidden', 'data-az-chat-templates': '' },
      children: [message('visitor', '', ctx), message('site', '', ctx)],
    },
    ...(components ? [components] : []),
    proseParts(ctx),
    { tag: 'p', attrs: { class: 'az-chat-error', hidden: 'hidden', 'data-az-chat-error': '' }, style: { ...line, color: t.color.danger } },
    del,
    { ...visuallyHidden(''), tag: 'p', attrs: { class: 'az-visually-hidden az-chat-status', role: 'status', 'data-az-chat-status': '' }, children: [] },
    { tag: 'noscript', children: [{ tag: 'p', attrs: { class: 'az-chat-noscript' }, style: { ...line, color: t.color.muted }, children: [CHAT_COPY.noscript] }] },
  ];
}

/**
 * The transcript: a list, not a live region (§9), that scrolls on its own so
 * the runtime can follow the newest words — focusable, so a keyboard scrolls
 * it too. In a float it fills the panel's height; inline it is capped.
 */
function transcript(ctx: EmitContext, items: EmittedNode[], float: boolean): EmittedNode {
  const t = ctx.theme;
  return {
    tag: 'ol',
    attrs: { class: 'az-chat-transcript', 'aria-label': CHAT_COPY.transcript, 'data-az-chat-transcript': '', tabindex: '0' },
    style: {
      display: 'grid', alignContent: 'start', gap: px(t.space[12]), margin: 0, padding: px(t.space[4]),
      overflowY: 'auto', overscrollBehavior: 'contain',
      ...(float ? { flex: '1 1 auto', minBlockSize: 0 } : { maxBlockSize: '60svh' }),
    },
    states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
    children: items,
  };
}

/** The panel's working parts, the same inline and in a float. */
function panelBody(block: SpecBlock, ctx: EmitContext, float: boolean): EmittedNode[] {
  const greeting = block.props.greeting?.trim() ?? '';
  const suggested = asks(block, ctx);
  const components = parts(block, ctx);
  return [
    transcript(ctx, greeting ? [message('site', greeting, ctx)] : [], float),
    // §9: shown by the runtime once the visitor scrolls up from the end; it jumps back and follows again.
    control(CHAT_COPY.latest, 'data-az-chat-latest', ctx),
    {
      tag: 'ol',
      attrs: { class: 'az-chat-templates', hidden: 'hidden', 'data-az-chat-templates': '' },
      children: [message('visitor', '', ctx), message('site', '', ctx)],
    },
    ...(components ? [components] : []),
    proseParts(ctx),
    ...(suggested ? [suggested] : []),
    form(ctx),
    historyLine(block, ctx),
    ...notes(block, ctx),
  ];
}

/** The panel's heading: the launcher's name too, and the dialog's label. */
function heading(block: SpecBlock, ctx: EmitContext, float: boolean): EmittedNode {
  const t = ctx.theme;
  return {
    // The shared-answer page has nothing above it: its heading is the page's own (§20.7).
    tag: block.chat?.shared ? 'h1' : 'h2',
    attrs: { id: 'az-chat-title', class: 'az-chat-title' },
    style: {
      fontSize: float ? t.typeSize.base : t.typeSize['2xl'],
      lineHeight: t.type['leading-tight'],
      fontFamily: t.type.display,
      fontWeight: float ? t.type['weight-bold'] : t.type['weight-display'],
      maxWidth: `${t.size['measure-display']}ch`,
      margin: float ? 0 : `0 0 ${px(t.space[24])}`,
    },
    children: [block.chat?.shared ? CHAT_COPY.shared : block.props.title ?? 'Ask a question'],
  };
}

/** A transition of `props` over a motion token's duration and curve: the open state's is the enter, the base style's the exit (overlays-spec §3). */
const moving = (duration: string | number, easing: string | number, props: readonly string[]) =>
  props.map((p) => `${p} ${duration}ms ${easing}`).join(', ');

/**
 * `chat float` (chat-block-spec §3.2, §9): a launcher fixed to the
 * inline-end bottom corner, named by the title, and the panel in a dialog
 * it controls. The runtime shows the dialog as a bottom sheet with focus
 * trapped below `sm` (the overlay engine's sheet policy) and as a side
 * panel that does not trap above it; Escape stops an answer, then closes;
 * focus returns to the launcher. The launcher ships hidden: with JavaScript
 * off there is nothing it could open. No inline style, only classes.
 */
function floatShell(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const x = closeButton(t, CHAT_COPY.close);
  const launcher = ctx.submit(block.props.title ?? 'Ask a question', { hierarchy: 'primary' });
  return {
    tag: 'div',
    attrs: { class: 'az-chat az-chat--float', 'data-az-chat': config(block, ctx), 'data-az-chat-state': 'idle' },
    // It holds only things fixed to the viewport, so it takes no place in the page's flow (nor its frame).
    style: { display: 'contents' },
    children: [
      {
        ...launcher,
        attrs: {
          ...launcher.attrs, type: 'button', class: `${launcher.attrs?.class ?? ''} az-chat-launcher`.trim(), 'data-az-chat-launcher': '',
          'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': DIALOG_ID, hidden: 'hidden',
        },
        style: {
          ...launcher.style,
          position: 'fixed', insetInlineEnd: px(t.space[24]), insetBlockEnd: px(t.space[24]), zIndex: t.layer.dropdown,
          boxShadow: t.shadow.lg,
        },
        below: { ...launcher.below, sm: { ...launcher.below?.sm, insetInlineEnd: px(t.space[16]), insetBlockEnd: px(t.space[16]), width: 'auto' } },
      },
      {
        tag: 'dialog',
        attrs: { id: DIALOG_ID, class: 'az-chat-dialog', 'aria-labelledby': 'az-chat-title', 'data-az-overlay': 'sheet' },
        style: {
          position: 'fixed',
          insetInlineStart: 'auto', insetInlineEnd: px(t.space[24]), insetBlockStart: 'auto', insetBlockEnd: px(t.space[24]),
          margin: 0, padding: 0,
          width: `min(calc(100vw - ${px(t.space[48])}), ${t.size['measure-body']}ch)`, maxWidth: 'none',
          maxHeight: `calc(100svh - ${px(t.space[48])})`,
          border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.lg),
          background: t.color.bg, color: t.color.text, boxShadow: t.shadow.lg, zIndex: t.layer.modal,
          opacity: 0, transform: `translateY(${px(t.space[16])})`,
          transition: moving(t.motion.fast, t.motion.easeIn, ['opacity', 'transform']),
        },
        states: { open: { opacity: 1, transform: 'none', transition: moving(t.motion.slow, t.motion.easeOut, ['opacity', 'transform']) } },
        // Below sm: the sheet preset's place — the bottom edge, the full width, its top corners rounded.
        below: {
          sm: {
            insetInlineStart: 0, insetInlineEnd: 0, insetBlockEnd: 0, width: '100%', maxHeight: '85svh',
            border: 0, borderRadius: `${px(t.radius.lg)} ${px(t.radius.lg)} 0 0`, transform: 'translateY(100%)',
          },
        },
        children: [{
          tag: 'div',
          attrs: { class: 'az-chat-sheet' },
          // The dialog's own `display` is the browser's (closed = none); this inner box lays out the panel.
          style: {
            display: 'flex', flexDirection: 'column', gap: px(t.space[12]),
            maxHeight: `calc(100svh - ${px(t.space[48])})`, padding: px(t.space[16]),
          },
          // A sheet keeps one height while an answer streams in, rather than growing under the reader: 60–85 svh.
          below: { sm: { minHeight: '60svh', maxHeight: '85svh' } },
          children: [
            // The sheet's drag handle (overlays-spec §2), below sm only: a grip for the pointer; Close and Escape for everyone else.
            {
              tag: 'div',
              attrs: { 'data-az-drag': '', 'aria-hidden': 'true', class: 'az-chat-sheet-handle' },
              style: { display: 'none', justifyContent: 'center', paddingBlock: px(t.space[4]), cursor: 'grab', touchAction: 'none' },
              below: { sm: { display: 'flex' } },
              children: [{
                tag: 'span',
                style: { display: 'block', width: px(t.space[32]), height: px(t.space[4]), borderRadius: px(t.radius.full), background: t.color['border-strong'] },
              }],
            },
            {
              tag: 'div',
              attrs: { class: 'az-chat-head' },
              style: { display: 'flex', alignItems: 'center', gap: px(t.space[8]) },
              children: [
                heading(block, ctx, true),
                {
                  tag: 'button', attrs: { ...x.attrs, 'data-az-chat-close': '' }, style: x.style, states: x.states,
                  children: [{
                    tag: 'svg',
                    attrs: { 'aria-hidden': 'true', focusable: 'false', viewBox: x.icon.viewBox, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' },
                    style: { width: '1.5em', height: '1.5em' },
                    children: [{ tag: 'path', attrs: { d: x.icon.d } }],
                  }],
                },
              ],
            },
            {
              tag: 'div',
              attrs: { class: 'az-chat-panel' },
              style: { display: 'flex', flexDirection: 'column', gap: px(t.space[12]), minBlockSize: 0, flex: '1 1 auto' },
              children: panelBody(block, ctx, true),
            },
          ],
        }],
      },
    ],
  };
}

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  if (block.variant === 'float' && !block.chat?.shared) return floatShell(block, ctx);
  const components = block.chat?.shared ? parts(block, ctx) : null;
  return {
    tag: 'section',
    attrs: {
      class: 'az-chat az-chat--panel', 'aria-labelledby': 'az-chat-title',
      'data-az-chat': config(block, ctx), 'data-az-chat-state': 'idle',
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
      heading(block, ctx, false),
      {
        tag: 'div',
        attrs: { class: 'az-chat-panel' },
        style: { display: 'grid', gap: px(t.space[16]), maxWidth: `${t.size['measure-body']}ch` },
        children: block.chat?.shared ? sharedShell(ctx, components) : panelBody(block, ctx, false),
      },
    ],
  };
}
