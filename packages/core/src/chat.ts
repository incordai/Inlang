/**
 * @az module chat
 * Purpose: the file-wide rules of a `chat` block: a backend that talks to a model, what an answer may show and quote and link to, who may ask.
 * Spec: docs/chat-block-spec.md §3.4, §5.3, §6.2, §14 (C1, C2)
 * Exports: CHAT_WORD, CHAT_ANSWER_WORDS, CHAT_REFUSED, chatOf, chatAnswers, withAnswer, chatDiagnostics, ChatAnswers
 * Edit guide: rules that need the whole file live here; a rule about one chat block alone is a word.json check (AZ2220–AZ2239).
 * Tests: packages/core/test/chat-decl.test.ts, packages/core/test/chat-answer-decl.test.ts
 */

/**
 * A `chat` block needs more than its own lines to be right: the site's
 * `backend` must say it talks to a model (`model default`), and a model
 * the site never uses is a cost nobody meant. Those rules see the whole
 * file, so they run once the pages are built (spec.ts), like `backend`'s
 * own AZ1507.
 *
 * What an answer may SHOW is a closed list (chat-block-spec §3.2): each word
 * in it is safe to fill with model-chosen text, and every other word is
 * refused with its reason. A chat that lists `show` is given, in its Spec
 * block, what its answers may use (chatAnswers): the pricing blocks a
 * signed-out visitor can see — the only prices an answer can show, quoted
 * — and the destinations the file declares, the only places an answer's
 * call to action may point (§6.2).
 */

import type { Diagnostic, Pos } from './lex.ts';
import type { Arg } from './parse.ts';
import type { SpecBlock, SpecChatAnswer } from './spec-block.ts';
import { LIST_SEPARATOR } from './link.ts';

/** The block's name, so the rules below never repeat it as a bare string. */
export const CHAT_WORD = 'chat';

/** The words an answer may contain (chat-block-spec §3.2), in this order everywhere. */
export const CHAT_ANSWER_WORDS: readonly string[] = ['pricing', 'faq', 'cta', 'feature'];

/** The one word an answer quotes rather than composes (§5.3, L8): its prices are always the author's. */
const QUOTED_WORD = 'pricing';

/** Why every other word can never be in an answer (chat-block-spec §3.2). */
export const CHAT_REFUSED: Readonly<Record<string, string>> = {
  auth: 'a sign-in form placed by a model is a phishing form',
  gallery: 'its images would be addresses the model chose',
  hero: 'its media would be addresses the model chose',
  scene: 'its 3D model would be an address the model chose',
  nav: 'site navigation is not an answer',
  footer: 'site chrome is not an answer',
  text: 'prose is already the default, and markdown never enters an answer',
  chat: 'an answer cannot hold another chat',
};

/**
 * A scheme destination an answer may use when the file declares it exactly
 * (§6.2): `https://…`, `mailto:…`, `tel:…`, the scheme in lower case as the
 * page's runtime checks it (overlay chat-logic.ts linkKind), and nothing a
 * browser would read past. Every other scheme is refused.
 */
const LINKABLE = /^(?:https:\/\/|mailto:|tel:)[^\s\\]+$/;

/** A chat block as the rules see it: its written props and where it was written. */
export interface ChatDecl {
  readonly props: Readonly<Record<string, Arg>>;
  readonly pos: Pos;
  /** Declared directly under `site`, not under a page. */
  readonly atSite: boolean;
}

/**
 * What a chat block's emitter needs beyond its props: the route the page's
 * questions are asked from, and where a signed-out visitor signs in when
 * only signed-in visitors may ask (null otherwise, or when no page has an
 * `auth login`).
 */
export function chatOf(route: string, allow: string | undefined, login: string | null): { route: string; signin: string | null } {
  return { route, signin: allow === 'anyone' ? null : login };
}

/** What the whole site offers every chat's answers: its quotable blocks and its declared destinations. */
export interface ChatAnswers {
  readonly quotes: SpecChatAnswer['quotes'];
  readonly destinations: readonly string[];
}

/** A block and every fill under it, depth first. */
const everyBlock = (b: SpecBlock): SpecBlock[] => [b, ...b.children.flatMap(everyBlock)];

/**
 * The quotable blocks and the destination allow-list (chat-block-spec §5.4,
 * §6.2), from the built pages:
 *
 *   - quotes: each `pricing` block on a page a signed-out visitor can open
 *     (not in `auth protect`), in page order, numbered per page from 0 — a
 *     protected page's prices would otherwise ship in a public page's markup;
 *   - destinations: every declared page route (a protected one too: it asks
 *     for sign-in as usual), every `route#anchor` written as a destination
 *     whose route is declared, and every `https:`, `mailto:` and `tel:`
 *     destination written in the file — exactly as written. A destination
 *     only a protected page holds is left out, for the same reason.
 */
export function chatAnswers(
  pages: readonly { readonly route: string; readonly blocks: readonly SpecBlock[] }[],
  inherited: readonly SpecBlock[], protect: ReadonlySet<string>,
): ChatAnswers {
  const routes = new Set(pages.map((p) => p.route));
  const quotes: { route: string; n: number; block: SpecBlock }[] = [];
  const destinations = new Set(routes);
  const visible = pages.filter((p) => !protect.has(p.route));
  for (const page of visible) {
    let n = 0;
    for (const b of page.blocks) if (b.word === QUOTED_WORD) quotes.push({ route: page.route, n: n++, block: b });
  }
  for (const b of [...inherited, ...visible.flatMap((p) => p.blocks)].flatMap(everyBlock)) {
    for (const a of b.args) {
      if (a.kind === 'route') {
        const hash = a.value.indexOf('#');
        if (hash > 0 && routes.has(a.value.slice(0, hash))) destinations.add(a.value);
      } else if (a.kind === 'pair' && LINKABLE.test(a.value)) {
        destinations.add(a.value);
      }
    }
  }
  return { quotes, destinations: [...destinations].sort() };
}

/** The `show` words a chat block lists, in the closed list's order — only the words an answer may hold. */
const showOf = (props: Readonly<Record<string, string>>): string[] => {
  const written = (props.show ?? '').split(LIST_SEPARATOR).filter(Boolean);
  return CHAT_ANSWER_WORDS.filter((w) => written.includes(w));
};

/**
 * A chat block with what its answers may use; any other block unchanged.
 * Quotes only with `pricing`, destinations only with `cta`, so the shell
 * carries no more than its answers can show.
 */
export function withAnswer(block: SpecBlock, answers: ChatAnswers): SpecBlock {
  if (block.word !== CHAT_WORD || !block.chat) return block;
  const show = showOf(block.props);
  if (show.length === 0) return block;
  return {
    ...block,
    chat: {
      ...block.chat,
      answer: {
        show,
        quotes: show.includes(QUOTED_WORD) ? answers.quotes : [],
        destinations: show.includes('cta') ? answers.destinations : [],
      },
    },
  };
}

/**
 * The file-wide chat rules: AZ1250 (chat without a model), AZ1251 (a model
 * nothing uses), AZ1254 (a word an answer can never show), AZ1255 (`show
 * pricing` with no pricing block to quote), AZ1214 (site-level `chat` is
 * not available in this release), AZ1256 (`allow anyone` spends the
 * operator's budget on strangers). `quotable` is how many pricing blocks a
 * signed-out visitor can see (chatAnswers).
 */
export function chatDiagnostics(
  chats: readonly ChatDecl[], model: Arg | undefined, quotable = 0,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, pos: Pos) => out.push({ code, message, pos, severity: 'error' });
  const warn = (code: string, message: string, pos: Pos) => out.push({ code, message, pos, severity: 'warning' });

  for (const c of chats) {
    if (c.atSite) {
      err('AZ1214', `${CHAT_WORD}: at site level is not available yet — put chat panel under the page it belongs to`, c.pos);
    }
    if (model === undefined) {
      err('AZ1250', `${CHAT_WORD}: needs a backend with a model — add under backend: model default`, c.pos);
    }
    const show = c.props.show;
    if (show) {
      for (const word of show.value.split(LIST_SEPARATOR).filter(Boolean)) {
        if (CHAT_ANSWER_WORDS.includes(word)) {
          if (word === QUOTED_WORD && quotable === 0) {
            err('AZ1255', `${CHAT_WORD}: show pricing, but no page has a pricing block to quote — add one, or remove pricing from show`, show.pos);
          }
        } else {
          const why = Object.hasOwn(CHAT_REFUSED, word) ? ` (${CHAT_REFUSED[word]})` : '';
          err('AZ1254', `${CHAT_WORD}: '${word}' can't be in an answer${why} — show takes ${CHAT_ANSWER_WORDS.slice(0, -1).join(', ')} or ${CHAT_ANSWER_WORDS.at(-1)}`, show.pos);
        }
      }
    }
    const allow = c.props.allow;
    if (allow?.value === 'anyone') {
      warn('AZ1256', `${CHAT_WORD}: allow anyone — every stranger spends your model budget; the limits are in server/.env (AZ_CHAT_…)`, allow.pos);
    }
  }
  if (model && chats.length === 0) {
    warn('AZ1251', `backend: model default but no page shows chat — remove it, or add to a page: chat panel`, model.pos);
  }
  return out;
}
