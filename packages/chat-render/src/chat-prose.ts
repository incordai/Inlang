/**
 * @az runtime chat-prose
 * Purpose: draws an answer's prose — the markdown subset's tree — and its follow-up questions into copies of the chat word's templates.
 * Spec: docs/chat-block-spec.md §21.1.3, §21.1.6
 * Exports: proseTemplatesOf, proseWriter, followUps, ProseTemplates, ProseWriter, PROSE_COPY
 * Edit guide: every element is a clone of a template the chat word made (never createElement); every leaf is textContent;
 *   the only attribute written is a code block's aria-label, from fixed copy and a checked language word.
 * Tests: scripts/chat-e2e.mjs, packages/overlay/test/chat.test.ts
 */

/**
 * chat-markdown.ts reads prose into a closed tree; this draws it. The chat
 * word ships the elements the tree may hold as hidden templates
 * (`[data-az-chat-prose]`, one slot each), so every class is the word's and
 * in the generated sheet, and nothing here names a tag: a paragraph is a
 * copy of the answer template's own paragraph, a list a copy of the list
 * template, emphasis a copy of `strong` or `em`.
 *
 * A writer redraws the open piece of an answer's prose as it streams: blocks
 * that did not change are kept, an open code block's text grows in place,
 * the rest are replaced — so a Copy button already focused stays put.
 */

import { proseBlocks, plainText, type ProseBlock, type ProseInline } from './chat-markdown.ts';

/** Fixed copy (the templates hold the rest). */
export const PROSE_COPY = {
  code: 'Code',
  codeIn: (lang: string) => `Code, ${lang}`,
} as const;

export interface ProseTemplates {
  readonly strong: Element;
  readonly em: Element;
  readonly code: Element;
  readonly ul: Element;
  readonly ol: Element;
  readonly li: Element;
  readonly codeBlock: Element;
  readonly follows: Element;
  readonly follow: Element;
}

/** The chat word's prose templates in `host`, or null when the shell has none (it was built before C5). */
export function proseTemplatesOf(host: Element): ProseTemplates | null {
  const box = host.querySelector('[data-az-chat-prose]');
  if (!box) return null;
  // Slot names are this module's constants, never network text.
  const slot = (name: string) => box.querySelector(`[data-az-chat-slot="${name}"]`);
  const strong = slot('strong');
  const em = slot('em');
  const code = slot('code');
  const ul = slot('ul');
  const ol = slot('ol');
  const li = slot('li');
  const codeBlock = slot('code-block');
  const follows = slot('follows');
  const follow = slot('follow');
  if (!strong || !em || !code || !ul || !ol || !li || !codeBlock || !follows || !follow) return null;
  return { strong, em, code, ul, ol, li, codeBlock, follows, follow };
}

/** A shallow copy of a template, without its slot mark. */
const copyOf = <T extends Element>(template: T, deep = false): T => {
  const el = template.cloneNode(deep) as T;
  el.removeAttribute('data-az-chat-slot');
  return el;
};

function fillInlines(doc: Document, t: ProseTemplates, into: Element, nodes: readonly ProseInline[]): void {
  for (const n of nodes) {
    if (n.t === 'text') into.append(doc.createTextNode(n.s));
    else if (n.t === 'code') {
      const el = copyOf(t.code);
      el.textContent = n.s;
      into.append(el);
    } else {
      const el = copyOf(n.t === 'strong' ? t.strong : t.em);
      fillInlines(doc, t, el, n.c);
      into.append(el);
    }
  }
}

/** One drawn block: the element, the block it was drawn from (and that as a key), and a code block's code element. */
interface Drawn { readonly el: Element; block: ProseBlock; key: string; readonly code: Element | null }

export interface ProseWriter {
  /** The piece of prose so far — all of it, each time; what changed is redrawn. */
  update(piece: string): void;
}

/**
 * A writer of one piece of prose at the end of `item`. `paragraph` is the
 * answer template's empty paragraph; `copy` is what a code block's Copy
 * button does with its code. Without templates (a shell from before C5) each
 * block is a paragraph of its plain text.
 */
export function proseWriter(
  doc: Document, item: Element, paragraph: Element | undefined, t: ProseTemplates | null,
  copy: (code: Element) => void, signal: AbortSignal,
): ProseWriter {
  let drawn: Drawn[] = [];

  const plainOf = (b: ProseBlock): string => (b.t === 'p' ? plainText(b.c) : b.t === 'code' ? b.s : b.items.map(plainText).join('\n'));

  const make = (b: ProseBlock): Drawn | null => {
    if (!t) {
      if (!paragraph) return null;
      const el = paragraph.cloneNode(false) as Element;
      el.textContent = plainOf(b);
      return { el, block: b, key: '', code: null };
    }
    if (b.t === 'p') {
      if (!paragraph) return null;
      const el = paragraph.cloneNode(false) as Element;
      fillInlines(doc, t, el, b.c);
      return { el, block: b, key: '', code: null };
    }
    if (b.t === 'ul' || b.t === 'ol') {
      const el = copyOf(b.t === 'ul' ? t.ul : t.ol);
      if (b.t === 'ol') (el as HTMLOListElement).start = b.start;
      for (const entry of b.items) {
        const li = copyOf(t.li);
        fillInlines(doc, t, li, entry);
        el.append(li);
      }
      return { el, block: b, key: '', code: null };
    }
    const el = copyOf(t.codeBlock, true);
    const part = (name: string) => el.querySelector(`[data-az-chat-slot="${name}"]`);
    const lang = part('lang');
    const pre = part('pre');
    const code = part('code-text');
    const button = part('copy');
    if (!pre || !code || !button) return null;
    if (b.lang) { if (lang) lang.textContent = b.lang; } else lang?.remove();
    pre.setAttribute('aria-label', b.lang ? PROSE_COPY.codeIn(b.lang) : PROSE_COPY.code);
    code.textContent = b.s;
    button.addEventListener('click', () => copy(code), { signal });
    for (const s of el.querySelectorAll('[data-az-chat-slot]')) s.removeAttribute('data-az-chat-slot');
    return { el, block: b, key: '', code };
  };

  return {
    update(piece) {
      const blocks = proseBlocks(piece);
      const next: Drawn[] = [];
      blocks.forEach((b, i) => {
        const key = JSON.stringify(b);
        const old = drawn[i];
        if (old && old.key === key) { next.push(old); return; }
        // An open code block that grew: the same block, more text — in place, so its Copy keeps focus.
        if (old?.code && old.block.t === 'code' && b.t === 'code' && old.block.lang === b.lang) {
          old.code.textContent = b.s;
          old.block = b;
          old.key = key;
          next.push(old);
          return;
        }
        const made = make(b);
        if (!made) return;
        made.key = key;
        if (old) old.el.replaceWith(made.el);
        else item.append(made.el);
        next.push(made);
      });
      for (const extra of drawn.slice(next.length)) if (!next.includes(extra)) extra.el.remove();
      drawn = next;
    },
  };
}

/**
 * An answer's follow-up questions as the list template's copy: one button
 * each, whose text is the question and whose click asks it. Null when the
 * shell has no template or there are none.
 */
export function followUps(t: ProseTemplates | null, questions: readonly string[], ask: (q: string) => void, signal: AbortSignal): Element | null {
  const itemTemplate = t?.follows.firstElementChild;
  if (!t || !itemTemplate || questions.length === 0) return null;
  const list = copyOf(t.follows);
  for (const q of questions) {
    const li = copyOf(itemTemplate);
    const button = copyOf(t.follow, true);
    button.textContent = q;
    button.addEventListener('click', () => ask(q), { signal });
    li.replaceChildren(button);
    list.append(li);
  }
  return list;
}
