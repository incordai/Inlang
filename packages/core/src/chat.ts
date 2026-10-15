/**
 * @az module chat
 * Purpose: the file-wide rules of a `chat` block: a backend that talks to a model, what an answer may show, who may ask.
 * Spec: docs/chat-block-spec.md §3.4, §14 (C1)
 * Exports: CHAT_WORD, CHAT_ANSWER_WORDS, CHAT_REFUSED, chatOf, chatDiagnostics
 * Edit guide: rules that need the whole file live here; a rule about one chat block alone is a word.json check (AZ2220–AZ2239).
 * Tests: packages/core/test/chat-decl.test.ts
 */

/**
 * A `chat` block needs more than its own lines to be right: the site's
 * `backend` must say it talks to a model (`model default`), and a model
 * the site never uses is a cost nobody meant. Those rules see the whole
 * file, so they run once the pages are built (spec.ts), like `backend`'s
 * own AZ1507.
 *
 * What an answer may SHOW is a closed list (chat-block-spec §3.2): each word
 * in it must be safe to fill with model-chosen text, and every other word is
 * refused with its reason. In this release (C1) answers are prose only, so
 * even the listed words are named and refused as not available yet (AZ1214)
 * rather than compiled into a panel that silently shows text.
 */

import type { Diagnostic, Pos } from './lex.ts';
import type { Arg } from './parse.ts';
import { LIST_SEPARATOR } from './link.ts';

/** The block's name, so the rules below never repeat it as a bare string. */
export const CHAT_WORD = 'chat';

/** The words an answer may contain (chat-block-spec §3.2) — from C2 on. */
export const CHAT_ANSWER_WORDS: readonly string[] = ['pricing', 'faq', 'cta', 'feature'];

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

/**
 * The file-wide chat rules: AZ1250 (chat without a model), AZ1251 (a model
 * nothing uses), AZ1254 (a word an answer can never show), AZ1214 (`show`
 * and site-level `chat` are not available in this release), AZ1256
 * (`allow anyone` spends the operator's budget on strangers).
 */
export function chatDiagnostics(
  chats: readonly ChatDecl[], model: Arg | undefined,
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
          err('AZ1214', `${CHAT_WORD}: show '${word}' is not available yet — answers are text for now; remove the show line`, show.pos);
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
