/**
 * @az module accounts
 * Purpose: what on a site needs accounts from its built-in backend, and the two backend rules that follow from it — AZ1225 (no email) and AZ1507 (the site's auth).
 * Spec: docs/backend-spec.md §2 · docs/chat-block-spec.md §19.15
 * Exports: accountNeeds, accountDiagnostics, AccountNeed, AccountInput
 * Edit guide: a feature that reads a signed-in account adds a need here, worded as the reason a diagnostic gives; a server without accounts must stay possible for a site that has none.
 * Tests: packages/core/test/accounts-decl.test.ts
 */

/**
 * The built-in backend keeps accounts — sign-up, sign-in, sessions, reset
 * and sign-in links by email — only when something on the site needs them.
 * Until chat-block-spec §19.15 every backend did, so a site whose only
 * server feature was a public chat still had to declare email, an auth
 * adapter and sign-in pages it never used.
 *
 * What needs an account:
 *
 *   - the site's `auth` signing people in with this server (adapter azbackend);
 *   - a chat only signed-in visitors may use — `allow signedin`, the default
 *     (Q3 of chat-block-spec §17: an anonymous chat stays explicit);
 *   - data tables: their rows are kept on /admin by signed-in admins, and
 *     their rules may name owners and signed-in visitors (data-spec §11).
 *
 * A server with none of them has no sign-in routes and sends no mail, so it
 * needs neither `email` nor an auth adapter. A server with one needs both,
 * and each diagnostic names the thing that needs them.
 */

import type { Diagnostic, Pos } from './lex.ts';

/** One reason the site needs accounts: the words a diagnostic says it in, where it was written, another way out when there is one. */
export interface AccountNeed {
  readonly why: string;
  readonly pos: Pos;
  /** A change that removes this need instead (a chat that may be public), or null. */
  readonly instead: string | null;
}

/** What the rules read from the file: the site's auth, each chat (its `allow` and route), the tables. */
export interface AccountInput {
  /** The site-level auth's adapter, when the site declares `auth`; undefined when it does not. */
  readonly auth: { readonly adapter: string | undefined; readonly pos: Pos } | undefined;
  /** Every chat block but `chat none`: its written `allow`, and its page's route (null for the site's float). */
  readonly chats: readonly { readonly allow: string | undefined; readonly route: string | null; readonly pos: Pos }[];
  /** The declared tables, by name and position. */
  readonly tables: readonly { readonly name: string; readonly pos: Pos }[];
}

/** The chat value that makes a chat public: the only way a chat needs no account (chat-block-spec §6.6). */
const ANYONE = 'anyone';

/** Everything on the site that needs accounts, in file order of kind: the auth, the chats, the tables. */
export function accountNeeds(input: AccountInput): AccountNeed[] {
  const needs: AccountNeed[] = [];
  if (input.auth?.adapter === 'azbackend') {
    needs.push({ why: "the site's auth signs people in with this server (adapter azbackend)", pos: input.auth.pos, instead: null });
  }
  for (const c of input.chats) {
    if (c.allow === ANYONE) continue;
    const which = c.route === null ? "the site's chat float" : `the chat on ${c.route}`;
    const written = c.allow === undefined ? 'allow signedin is the default' : 'allow signedin';
    needs.push({ why: `${which} is for signed-in visitors only (${written})`, pos: c.pos, instead: 'under that chat write: allow anyone' });
  }
  const [first] = input.tables;
  if (first) {
    const why = input.tables.length === 1
      ? `the table '${first.name}' is kept on /admin by signed-in admins`
      : `the tables ('${first.name}' and ${input.tables.length - 1} more) are kept on /admin by signed-in admins`;
    needs.push({ why, pos: first.pos, instead: null });
  }
  return needs;
}

/**
 * AZ1225 and AZ1507 for a declared backend, from what needs accounts:
 *
 *   - the site declares `auth` with another adapter: AZ1507 — the backend
 *     would be a second, unused sign-in;
 *   - something needs accounts and the site declares no `auth`: AZ1507,
 *     saying what needs them;
 *   - `email` is written and nothing needs accounts or signs in: AZ1507 —
 *     the mail would be for accounts nobody can use; removing the line
 *     makes a server without accounts;
 *   - something needs accounts and `email` is not written: AZ1225, saying
 *     what needs them and why accounts need mail.
 */
export function accountDiagnostics(
  backend: { readonly pos: Pos; readonly email: string | undefined; readonly emailWritten: boolean },
  input: AccountInput,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string) => out.push({ code, message, pos: backend.pos, severity: 'error' });
  const needs = accountNeeds(input);
  const [need] = needs;
  if (input.auth !== undefined && input.auth.adapter !== 'azbackend') {
    err('AZ1507', "backend: the site's auth must use it — add at site level: auth / adapter azbackend");
  } else if (input.auth === undefined && need) {
    err('AZ1507', `backend: ${need.why}, so the site's auth must sign in with this server — add at site level: auth / adapter azbackend${need.instead ? `, or ${need.instead}` : ''}`);
  } else if (input.auth === undefined && backend.email !== undefined) {
    err('AZ1507', `backend: email ${backend.email} is for accounts, but nothing on the site signs in — remove the email line for a server without accounts, or add at site level: auth / adapter azbackend`);
  }
  // A written email line without a value is AZ1205 at link; it is not missing.
  if (need && backend.email === undefined && !backend.emailWritten) {
    err('AZ1225', `backend: no email — ${need.why}, and accounts need email for sign-in links and password resets — add: email smtp|api${need.instead ? `, or ${need.instead}` : ''}`);
  }
  return out;
}
