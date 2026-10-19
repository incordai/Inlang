/**
 * @az runtime chat-shared
 * Purpose: share links in the page — the Share control under a finished answer, and reading a shared-answer link.
 * Spec: docs/chat-block-spec.md §20.7
 * Exports: shareControl, ShareInput
 * Edit guide: send back only what the server sent and tagged (events as received, merged by mergeText); the question only
 *   when the visitor ticks it; the links are text in read-only fields, never markup; the delete token never leaves the fragment but to DELETE.
 * Tests: scripts/chat-e2e.mjs, packages/overlay/test/chat-shared.test.ts
 */

/**
 * When the server makes share links, a finished answer's `done` carries its
 * share tags (chat-logic.ts ShareTags). This draws, under that answer, the
 * Share control from the chat word's template: Share opens a small panel
 * with "Include my question" (off) and Create link; Create posts the
 * answer's events exactly as they arrived, with the tag that covers them, to
 * `<backend>/chat/share`, and shows the two links it gets back — the one to
 * share, and the one to delete it — as text the visitor can copy.
 *
 * A link is `<site>/chat/shared#<id>`; the delete link adds `&<token>`. The
 * id is in the fragment, so it reaches neither the static host nor a
 * Referer.
 */

import { SHARED_PATH, SHARE_TEXT, mergeText, shareProblem, type ShareTags } from '#chat-render/chat-logic.ts';

export interface ShareInput {
  /** The backend's base URL. */
  readonly base: string;
  readonly page: string;
  readonly conversation: string;
  /** The answer's position in the conversation's messages, as the server tagged it. */
  readonly index: number;
  readonly tags: ShareTags;
  /** Every event of the answer as it arrived, in order. */
  readonly events: readonly Record<string, unknown>[];
  /** The question it answered — sent only when the visitor ticks Include. */
  readonly question: string;
  readonly fetch: typeof fetch;
  /** The fixed copy goes to the status region too. */
  readonly announce: (text: string) => void;
  /** Unique per answer, for the panel's id. */
  readonly suffix: string;
}

const slot = (root: Element, name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-az-chat-slot="${name}"]`);

/**
 * The Share control for one finished answer, from the template part, or
 * null when the shell has none. `signal` ends its request with the panel.
 */
export function shareControl(doc: Document, template: HTMLElement, input: ShareInput, signal: AbortSignal): HTMLElement | null {
  const root = template.cloneNode(true) as HTMLElement;
  const open = slot(root, 'open');
  const panel = slot(root, 'panel');
  const include = slot(root, 'include') as HTMLInputElement | null;
  const create = slot(root, 'create');
  const urlField = slot(root, 'url-field');
  const url = slot(root, 'url') as HTMLInputElement | null;
  const delField = slot(root, 'delete-field');
  const del = slot(root, 'delete') as HTMLInputElement | null;
  const note = slot(root, 'note');
  if (!open || !panel || !include || !create || !urlField || !url || !delField || !del || !note) return null;
  const panelId = `az-chat-share-${input.suffix}`;
  panel.id = panelId;
  open.setAttribute('aria-controls', panelId);
  const say = (text: string) => { note.textContent = text; input.announce(text); };

  open.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    open.setAttribute('aria-expanded', String(opening));
    if (opening) include.focus({ preventScroll: true });
  }, { signal });

  let busy = false;
  create.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    say(SHARE_TEXT.working);
    const withQuestion = include.checked;
    try {
      const res = await input.fetch(`${input.base.replace(/\/+$/, '')}/chat/share`, {
        method: 'POST', credentials: 'include', signal,
        headers: { 'content-type': 'application/json', 'x-az-request': '1' },
        body: JSON.stringify({
          page: input.page, conversation: input.conversation, index: input.index, at: input.tags.at,
          events: mergeText(input.events),
          ...(withQuestion ? { question: input.question, tag: input.tags.tagq } : { tag: input.tags.tag }),
        }),
      });
      let body: Record<string, unknown> = {};
      try { body = await res.json() as Record<string, unknown>; } catch { body = {}; }
      const id = body.id;
      const token = body.deleteToken;
      const expires = body.expires;
      if (res.status !== 201 || typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)
        || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || typeof expires !== 'number') {
        say(shareProblem(typeof body.error === 'string' ? body.error : 'unknown'));
        return;
      }
      const origin = doc.location.origin;
      url.value = `${origin}${SHARED_PATH}#${id}`;
      del.value = `${origin}${SHARED_PATH}#${id}&${token}`;
      urlField.hidden = false;
      delField.hidden = false;
      create.hidden = true;
      include.disabled = true;
      say(SHARE_TEXT.made(new Intl.DateTimeFormat(doc.documentElement.lang || 'en', { dateStyle: 'medium' }).format(new Date(expires))));
      url.focus({ preventScroll: true });
      url.select();
    } catch {
      if (!signal.aborted) say(shareProblem('unknown'));
    } finally {
      busy = false;
    }
  }, { signal });
  for (const field of [url, del]) field.addEventListener('focus', () => field.select(), { signal });
  return root;
}
