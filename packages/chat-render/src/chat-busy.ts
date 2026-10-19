/**
 * @az runtime chat-busy
 * Purpose: shows that an answer is on its way — dots where it will be, a caret at the end of its words, a placeholder of a held component's shape — and moves new messages in, with the theme's motion tokens.
 * Spec: docs/chat-block-spec.md §9, §19.18 (issue #28)
 * Exports: busyKitOf, BusyKit
 * Edit guide: every element is a copy of the chat word's extras templates, aria-hidden; motion only through element.animate
 *   (never a style written); `still` — the caller's reduced-motion check — means nothing moves at all. The pure decisions
 *   (the motion tokens checked, a held kind's placeholder, where the caret goes) are chat-logic.ts's.
 * Tests: packages/chat-render/test/chat-busy.test.ts, scripts/chat-public-e2e.mjs
 */

/**
 * Between Send and the first words the answer's place holds three dots, so
 * the visitor sees that the question is being answered (the status region
 * says so once, in chat.ts). The first words take the dots' place: they are
 * one line of the answer's text tall, so nothing jumps. While words arrive a
 * caret sits at their end; it goes when the answer is whole. A rich component
 * the server is still reading (its `hold` event) stands as a placeholder of
 * its shape until it arrives. New messages fade and rise in; a component
 * fades in. Everything here is aria-hidden: the status region speaks.
 *
 * Under reduced motion nothing moves: the dots and the placeholder stay
 * still, messages appear at once, and there is no caret (chat-block-spec §9:
 * "no typing caret").
 */

import { caretHost, motionOf, SKELETON_OF } from './chat-logic.ts';

export interface BusyKit {
  /** Fresh dots for an answer's place; they pulse unless `still`. */
  thinking(still: boolean): HTMLElement | null;
  /** The caret moved to the end of `item`'s words — or taken away, when there is nowhere it belongs. */
  caret(item: Element): void;
  /** The caret gone (the answer is whole, or stopped). */
  dropCaret(): void;
  /** A placeholder of a held kind's shape, pulsing unless `still`; null for a kind with none. */
  skeleton(word: string, still: boolean): HTMLElement | null;
  /** `el` brought in: faded (and risen, for a message) unless `still`. */
  enter(el: Element, still: boolean, rise: boolean): void;
  /** `el` ended: its animations stopped, then removed. */
  remove(el: Element | null): void;
  /** The answer bar's template (chat-bar.ts copies it); null in a shell without one. */
  readonly bar: HTMLElement | null;
}

/** The kit in a chat shell, from its extras templates; null in a shell without them (one built before issue #28). */
export function busyKitOf(host: Element): BusyKit | null {
  const box = host.querySelector('[data-az-chat-extras]');
  if (!box) return null;
  // Slot names are this module's constants, never network text.
  const slot = (name: string) => box.querySelector<HTMLElement>(`[data-az-chat-slot="${name}"]`);
  const motion = motionOf(box.getAttribute('data-az-chat-motion'));
  const copy = (template: HTMLElement | null): HTMLElement | null => {
    if (!template) return null;
    const el = template.cloneNode(true) as HTMLElement;
    el.removeAttribute('data-az-chat-slot');
    return el;
  };
  /** One pulse, forever: opacity only, out of phase by `delay`. Its target leaving the page ends it (remove() cancels it first). */
  const pulse = (el: Element, delay: number, low: number) => {
    if (!motion || typeof el.animate !== 'function') return;
    el.animate([{ opacity: 1 }, { opacity: low }, { opacity: 1 }], { duration: motion.pulse * 4, delay, iterations: Infinity, easing: 'ease-in-out' });
  };
  const caretTemplate = slot('caret');
  let caretEl: HTMLElement | null = null;
  return {
    thinking(still) {
      const el = copy(slot('thinking'));
      if (el && !still && motion) [...el.children].forEach((dot, i) => pulse(dot, i * motion.pulse, 0.25));
      return el;
    },
    caret(item) {
      const at = caretHost(item, (el) => el === caretEl);
      if (!at) { caretEl?.remove(); return; }
      caretEl ??= copy(caretTemplate);
      // At the very end of the words: the writer may have replaced the paragraph it was in, or added text after it.
      if (caretEl && at.lastChild !== caretEl) at.append(caretEl);
    },
    dropCaret() {
      caretEl?.remove();
    },
    skeleton(word, still) {
      const name = Object.hasOwn(SKELETON_OF, word) ? SKELETON_OF[word] : null;
      const el = name ? copy(slot(name)) : null;
      if (!el) return null;
      // Which kind it stands for: a word from the closed list the hold was checked against (chat-logic.ts), never network text.
      el.setAttribute('data-az-chat-held', word);
      if (!still) pulse(el, 0, 0.6);
      return el;
    },
    enter(el, still, rise) {
      if (still || !motion || typeof el.animate !== 'function') return;
      const from = rise ? { opacity: 0, transform: `translateY(${motion.slide}px)` } : { opacity: 0 };
      const to = rise ? { opacity: 1, transform: 'none' } : { opacity: 1 };
      el.animate([from, to], { duration: motion.enter, easing: motion.ease });
    },
    remove(el) {
      if (!el) return;
      for (const a of el.getAnimations({ subtree: true })) a.cancel();
      el.remove();
    },
    bar: slot('bar'),
  };
}
