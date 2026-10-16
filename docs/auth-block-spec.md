# `auth` — block specification

**Status** draft for M4 · Companion to word-quality-gate §4, distribution-and-hosting §5.1, PRD §6.5

**This word generates a user interface. It does not implement authentication,
and it never will.** PRD §6.5 settled that: a static site cannot do auth alone,
and rolling our own crypto inside a *design tool* is how projects get people
breached. `auth` compiles against an adapter; the security lives there. That
makes it the most dangerous word in Phase 1, twice over — a mistake here leaks a
key that opens someone's database, and a well-designed login form on a free
subdomain is a phishing kit. Both are hard build rules below, not advice.

---

## 1. Syntax

```
az 1

site aurora
  auth                         # site-level: one adapter per site
    adapter session

page /login
  auth login
    title    "Welcome back"
    methods  password link
    redirect /account
    alt      "Create an account" /signup

page /account                  # a redirect must name a page of this site (§11)

page /signup                   # so must a link
```

**Variants are mutually exclusive:** `login` `signup` `reset`. Two is a compile
error. **There is no default** — `auth` with no variant is an error, because
guessing which form a page wants is not a thing a compiler should do.
**Modifiers stack freely:** `glass`.

**Grammar note.** PRD §6.5 writes the adapter positionally (`auth hosted`) and
PRD:126 writes `auth login` with `login` undeclared. Both resolve here: `login`
is a **variant**, the adapter is a **site-level property**, and the positional
form is dropped — the taxonomy admits no bare positional arguments. One adapter
per site is not a limitation; two identity systems is two sites.

## 2. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `login` | returning users; where a protected route redirects | it is the phishing target — §9 |
| `signup` | first contact; the only variant that may ask beyond credentials | every extra field costs sign-ups; name and password is usually the whole form |
| `reset` | request a link **and** set the new password | two states in one variant — §5 |

**Each variant is a page, not a modal.** A login overlay cannot be linked to,
returned to after an email round-trip, or bookmarked by a password manager; the
overlay engine exists and this is not one of its jobs. **Every `auth` page needs
the route to its siblings** — a `login` with no path to `signup` or `reset` is a
dead end for exactly the users already stuck.

## 3. The adapter contract

A **stable interface the block compiles against**. `auth` knows these calls and
nothing else about any identity system:

```ts
export interface AuthAdapter {
  readonly id: "hosted" | "session" | "azbackend" | "custom";
  signIn(input: Credentials): Promise<AuthResult>;
  signUp(input: Credentials): Promise<AuthResult>;
  requestReset(email: string): Promise<AuthResult>;
  setPassword(token: string, password: string): Promise<AuthResult>;
  session(): AuthSession | null;                              // synchronous read
  onChange(fn: (s: AuthSession | null) => void): () => void;  // returns unsubscribe
}
```

`AuthResult` is `{ ok: true, session }` or `{ ok: false, code, field? }`, where
`AuthErrorCode` is a **closed set owned by AZ**: `invalid_credentials` ·
`email_taken` · `weak_password` · `password_mismatch` · `rate_limited` ·
`expired_token` · `oauth_failed` · `email_unverified` · `email_unconfirmed` ·
`network` · `unknown` (the three §3.4 codes added 2026-09-23; `email_unconfirmed`
with §3.5 — an account that has not yet confirmed its address). Each adapter maps its own errors into it and the block maps it to
copy, so no generated component contains a provider-specific string — switching
adapters is one line in the `.az` file and nothing in the output moves.

The four ids are the pre-existing vocabulary from PRD §6.5:

| `adapter` | Runs | Key that reaches the browser |
|---|---|---|
| `hosted` | a managed provider | the **public/anon** key only — §4 |
| `session` | a session library, needs a server route | a public client id only |
| `azbackend` | the self-hoster's own backend | a public base URL only |
| `custom` | a user-written file implementing `AuthAdapter` | their choice; §4 still applies |

**`custom` is a real tier, not a placeholder** — the escape hatch principle 4
requires, and it keeps the compiler out of blessing identity providers.

**Adapter packages are not `auth`'s dependencies.** `auth`'s `deps` is empty
(§10); the concrete package and its exact pin live in the adapter's own manifest,
resolved through the same union-and-install-once path as everything else (PRD
§6.7). Provider names stay out of the core word, and an adapter can be versioned
without republishing `auth`.

### 3.1 As built (M4) — additions, and which key goes where

The implementation (`packages/auth-runtime`, copied into a site that uses
`auth`) adds three calls to the interface above, each for something the block
already emits:

```ts
  requestLink(email: string): Promise<AuthResult>;   // `methods link`
  signOut(): Promise<void>;                           // the signed-in bar's button
  ready?(): Promise<void>;                            // adapters whose first read is a request
```

`AuthSession` is `{ user: { id, email }, expiresAt? }` — the block never sees a
token. A `custom` adapter's `impl` module **default-exports** an object
implementing the whole interface; it is copied into the site through the same
sandbox as `raw` components.

**Which key goes where — the sentence that prevents the worst outcome:**

| Key | Where it lives | Reaches the browser? |
|---|---|---|
| provider **public / anon** key | `AZ_PUBLIC_AUTH_KEY` | **yes** — by design; row-level security is what protects the data (§4.1) |
| provider **service** key | your server's own secret store | **never** — the build refuses any `AZ_PUBLIC_` variable named `*SERVICE*`, `*SECRET*`, `*PRIVATE*`, or holding a token whose role is `service_role`/`service`/`admin` |
| session-signing secret | your server only | **never** |

Only variables prefixed `AZ_PUBLIC_` are inlined into a generated site — the
emitted Vite config sets `envPrefix` to exactly that, so a `VITE_…` variable is
not exposed at all.

`azbackend` is available: PRD §11 question 2 was decided — the backend
project continues — and §3.4 is the protocol it implements.

### 3.2 The `hosted` protocol

Provider-neutral request/response shapes. Configuration is two public
variables: `AZ_PUBLIC_AUTH_URL` (base URL) and `AZ_PUBLIC_AUTH_KEY` (the public
key); the site's build fails if either is missing. Every call is
`POST <base><path>`, JSON, with the header `x-public-key: <public key>`:

| Path | Body | Success |
|---|---|---|
| `/sign-in` | `{ email, password }` | `200 { session }` |
| `/sign-up` | `{ email, password, name? }` | `200 { session }`, or `200 {}` when the address must be confirmed first |
| `/link` | `{ email }` | `200 {}` — **always**, whether or not the address has an account |
| `/reset` | `{ email }` | `200 {}` — **always**, same reason |
| `/password` | `{ token, password }` | `200 { session }` |
| `/sign-out` | `{}` + `authorization: Bearer <token>` | `204` |

`session` is `{ user: { id, email }, token, expiresAt? }` (`expiresAt` in epoch
milliseconds). A failure is any non-2xx with `{ error: <AuthErrorCode>, field? }`;
`429` is `rate_limited` whatever its body, an unreachable provider is
`network`, and any code outside the closed set becomes `unknown`. The adapter
keeps the session in `sessionStorage` (one tab, cleared when it closes) —
readable by any script on the page, which is why §4.1 is the protection.

### 3.3 The `session` routes

The site's own server, same origin, cookie-based: `POST /api/auth/sign-in`,
`/sign-up`, `/link`, `/reset`, `/password`, `/sign-out`, with the same bodies
and error shape as §3.2, and `GET /api/auth/session` → `200 { session: { user } }`
or `200 { session: null }`. The server sets an httpOnly session cookie; the
browser never holds a token.

### 3.4 The `azbackend` protocol — what the owner's backend implements

`azbackend` is the self-hoster's own backend (PRD §6.5), on its own origin.
It speaks §3.3's cookie routes, credentialed across origins. This section is
the contract from the site's side; any backend language can meet it.

**Configuration — one public value, no key.** `AZ_PUBLIC_BACKEND_URL`, the
backend's base URL. Its own name rather than `AZ_PUBLIC_AUTH_URL`, so a hosted
provider's settings are never sent to the backend by accident. The site's
build fails if it is missing, not `https` (plain `http` only for `localhost`,
`127.0.0.1` or `[::1]`), carries credentials, or has a `?`/`#`. Nothing secret
reaches the browser: the backend identifies the visitor by its own httpOnly
cookie.

**Routes** — all under `<base>/auth`, JSON in and out:

| Request | Body | Success |
|---|---|---|
| `POST /auth/sign-in` | `{ email, password }` | `200 { session }` + sets the cookie |
| `POST /auth/sign-up` | `{ name, email, password, passwordConfirm, location? }` | `200 { session }` + cookie, or `200 {}` when the address must be confirmed first |
| `POST /auth/link` | `{ email }` | `200 {}` — **always**, whether or not the address has an account |
| `POST /auth/reset` | `{ email }` | `200 {}` — **always**, same reason |
| `POST /auth/password` | `{ token, password, passwordConfirm }` | `200 { session }` + cookie |
| `POST /auth/sign-out` | `{}` | `204`, clearing the cookie |
| `GET /auth/session` | — | `200 { session }` or `200 { session: null }` |
| `GET /auth/providers` | — | `200 { providers: [{ id, label }] }` — `[]` when none are enabled |
| `GET /auth/oauth/{id}/start?next=&site=` | — (a top-level navigation) | `302` to the provider |
| `GET /auth/oauth/{id}/callback` | — (the provider's redirect) | `302` back to `site` + `next`, cookie set |

`session` is `{ user: { id, email, name, location? }, expiresAt? }` — every
field a string except `expiresAt` (epoch milliseconds); `location` is omitted
when none was given. **No token in any body**: the cookie is the credential.

**Sign-up.** `name`, `email`, `password` and `passwordConfirm` are required;
`location` is optional free text. The form checks the retype before sending;
**the server must check `passwordConfirm === password` again** and answer
`400 { error: "password_mismatch", field: "passwordConfirm" }` — the form's
check is a convenience, the server's is the rule. `password` meets the stated
minimum (`weak_password` otherwise).

**Forgot / reset.** `POST /auth/reset { email }` always answers `200 {}` and,
when the address has an account, emails a **single-use, expiring** link to the
site's reset page with `?token=…&email=…`. `POST /auth/password` takes the
token with the new password twice; a used or expired token is
`expired_token`, a retype that differs is `password_mismatch`. A used token
must be rejected even if it has not expired.

**Sign-in with a provider (`methods oauth`).** Providers are the backend's
configuration — each an OpenID Connect issuer (discovered from its
`/.well-known/openid-configuration`) or a plain OAuth 2 provider
(authorize, token and userinfo URLs), with a display label, client id,
client secret and scopes, all in the **backend's own environment**. Only
`{ id, label }` ever reaches the page: `id` is lower-case letters, digits and
`-` (it becomes a path segment), `label` at most 40 characters of plain text.
The page renders one "Continue with {label}" link per provider, pointing at
`start`.

- **`start`** checks `site` against the same origin allow-list as CORS and
  `next` is a path on it (starts with one `/`), else `400`. It creates a
  `state`, a PKCE verifier (sent as an S256 `code_challenge`) and, for OIDC, a
  `nonce`; binds `state` to the browser (a short-lived httpOnly cookie); and
  redirects to the provider's authorize endpoint.
- **`callback`** requires the `state` to match the bound one (single use),
  exchanges the code with the verifier and the client secret, and for OIDC
  verifies the id_token's signature, `iss`, `aud`, `exp` and `nonce`.
- **Accounts link by verified email only.** An address the provider does not
  mark verified never signs in to an existing account:
  `email_unverified`. A provider may create a new account only if the backend
  chooses to allow it.
- **Success** sets the session cookie and redirects to `site` + `next`.
  **Failure** redirects to `site` + `/login?auth_error=<code>` with a code
  from the closed set (`oauth_failed`, `email_unverified`, `rate_limited`…);
  the form shows its copy and drops the parameter from the address.

`start` and `callback` are top-level navigations, not fetches, so they carry
no `Origin` or CSRF header; `state`, PKCE, `nonce` and the `site` allow-list
protect them instead.

**Errors.** Any non-2xx with `{ error, field? }`, where `error` is one of
§3's closed set — `invalid_credentials`, `email_taken`, `weak_password`,
`rate_limited`, `expired_token`, `unknown` — and `field` is `email`,
`password` or `name`. `429` reads as `rate_limited` whatever its body; a code
outside the set reads as `unknown`; an unreachable backend is `network`.
`invalid_credentials` must not say which of the two was wrong.

**The session cookie.** `HttpOnly`, `Secure`, `Path=/`. `SameSite=Lax` when
the backend and the site are one site (`api.example.org` beside
`www.example.org`) — the recommended deployment. When they are different
sites, `SameSite=None; Secure` is required, and some browsers block
third-party cookies outright; a same-site deployment avoids that entirely.

**CORS**, on every route and its `OPTIONS` preflight:

- `Access-Control-Allow-Origin`: the site's exact origin — never `*`, which
  browsers refuse with credentials anyway
- `Access-Control-Allow-Credentials: true`
- `Access-Control-Allow-Headers: content-type, x-az-request`
- `Access-Control-Allow-Methods: GET, POST`
- `Vary: Origin`

**CSRF.** Every request from the site carries `x-az-request: 1`. The backend
**must refuse** (`403`) any `POST` without it, and any request whose `Origin`
is not an allowed site origin. A custom header cannot be sent cross-origin
without a preflight the backend approves, so a forged form on another site
never reaches a route.

**The backend's checklist:**

1. Serve the routes above under `/auth`, with these exact shapes.
2. Set the session as an httpOnly, Secure cookie; never return a token.
3. CORS: the site's exact origin, credentials allowed, the two headers, `Vary: Origin`.
4. Refuse a `POST` without `x-az-request: 1`, and any foreign `Origin`.
5. `/link` and `/reset` answer `200 {}` for every address.
6. Rate-limit sign-in, link and reset; answer `429`.
7. Map every failure onto the closed set; never send a message meant for the page.
8. Store passwords with a slow, salted hash; row-level rules protect the data (§4.1).
9. Re-check `passwordConfirm` on sign-up and on `/password`.
10. Reset links: single use, expiring, sent only to an address with an account.
11. Providers: configuration in the backend's environment only; `state` +
    PKCE (+ `nonce` for OIDC) on every round-trip; link by verified email
    only; redirect only to an allow-listed `site`.
12. Claiming: when an UNVERIFIED account's address is proven another way (a
    sign-in link, a provider vouching for it), drop its password and end
    every session before signing the prover in. Anyone could have created
    it, and linking alone would leave the creator inside the owner's account.
13. Sign-in links are bound to the browser that requested them (a cookie set
    by `/link`, whatever the address), and fail `expired_token` elsewhere —
    otherwise anyone can mail themselves a link and make a victim open it
    (login CSRF).
14. `next` is checked after resolution: `/.//host` and `/%2e//host` resolve to
    `//host`. The runtime's `safeNext` and the built-in server both refuse
    them. `signOut()` rejects — and the page stays signed in — unless the
    server confirms the session ended.

**The built-in backend.** A site that declares `backend` (backend-spec.md)
gets a generated server that implements this section exactly. It adds one
route the site never calls: `GET /auth/link/verify?token=…`, the address in a
sign-in-link email — a top-level navigation that spends the single-use token,
sets the session cookie and redirects to an allowed site origin, protected
like the provider callback. `pnpm test:auth` also runs that real server
(SQLite, SMTP capture, a mock OpenID provider) in Chromium.

`pnpm test:auth` runs the site's side against a local mock that meets this
checklist from another origin — including a mock OpenID Connect provider on a
third — in Chromium, Firefox and WebKit.

### 3.5 The `hosted` adapter's `token-endpoint` profile

`hosted` speaks one of two protocols, chosen at site level by `profile`:

```
site studio
  auth
    adapter hosted
    profile token-endpoint      # default: standard (§3.2)
```

**Why a grammar property, not an env variable.** The protocol is a structural
choice — which module the site imports, which `methods` are possible — and it
does not change between a developer's machine and production, so it belongs in
the `.az` file where the compiler checks it (AZ2006). The env holds only what
varies per deployment: the URL and the public key.

`standard` is §3.2. `token-endpoint` is the protocol of widely used
open-source identity servers — the one a managed cloud project runs
(docs/cloud-setup.md): a token endpoint with grant types, a user resource,
and email links that return to the site with the session in the URL.
Configuration is the same two public variables: `AZ_PUBLIC_AUTH_URL` (the
server's base URL, **API path included**) and `AZ_PUBLIC_AUTH_KEY` (the public,
anonymous key — never a service key; the build refuses one, §4). Every request
carries `apikey: <public key>` and `authorization: Bearer <access token, or the
public key>`:

| Call | Request | Success |
|---|---|---|
| sign in | `POST /token?grant_type=password {email, password}` | a token response |
| sign up | `POST /signup?redirect_to=<page> {email, password, data: {name, location?}}` | a token response, or a user alone when the address must be confirmed (`200 {}` semantics) |
| sign-in link | `POST /otp?redirect_to=<page> {email, create_user: false}` | `200` |
| reset | `POST /recover?redirect_to=<reset page> {email}` | `200` |
| set password | `PUT /user {password}` with the recovery session | the user |
| session read | `GET /user` | the user |
| refresh | `POST /token?grant_type=refresh_token {refresh_token}` | a token response |
| sign out | `POST /logout` | `204` |
| providers | `GET /settings` → enabled ids in `external` | — |
| provider start | `GET /authorize?provider=<id>&redirect_to=<page>&code_challenge=…&code_challenge_method=s256` | redirect |
| code exchange | `POST /token?grant_type=pkce {auth_code, code_verifier}` | a token response |

A token response is `{access_token, refresh_token, expires_in | expires_at,
user: {id, email, user_metadata: {name?, location?}}}`, checked for shape.

**Returning from an email or a provider.** A reset link, a sign-in link or a
sign-up confirmation comes back to the page it was requested from with the
session in the URL fragment (`#access_token=…&refresh_token=…&type=…`); a
provider round-trip comes back with a PKCE `?code=`. The adapter's `landing()`
(§3.1) reads it, adopts the session, and **removes it from the address** at
once (`history.replaceState`), so tokens are not left in history, a bookmark
or a copied link. `type=recovery` opens the reset page's set-new-password
form; any other landing on a login or sign-up page continues to `?next`
(same-origin only, §5) or the form's `redirect`. Email links use the fragment
rather than PKCE deliberately: they are often opened in a new tab, where a
per-tab verifier would be missing. Provider sign-in stays in one tab and uses
PKCE S256.

**Session storage and its trade-off.** As §3.2: `sessionStorage` — one tab,
cleared when it closes. That includes the refresh token (rotated by the
server on every refresh; renewed a minute before the access token expires,
and at page load if it already has). Storage any script on the page can read
means an injected script could keep a session alive — which is why §4.1
(row-level security) and a page with no third-party script are the
protection, not this storage. A refused refresh ends the session locally.

**Errors** map onto the closed set from the server's `error_code` (newer) or
`error` (older): `invalid_credentials`/`invalid_grant` → `invalid_credentials`;
`user_already_exists`/`email_exists` → `email_taken`; `weak_password`;
`over_request_rate_limit`/`over_email_send_rate_limit`/HTTP 429 →
`rate_limited`; `otp_expired`/`flow_state_expired`/`flow_state_not_found`/
`bad_code_verifier` → `expired_token`; `email_not_confirmed` →
`email_unconfirmed`; anything else → `unknown`. Only `otp_disabled`,
`signup_disabled` and `user_not_found` are answered like success on the link
and reset calls (no enumeration); any other error — a refused redirect, a rate
limit — is reported, so a misconfiguration is never mistaken for a sent email.

**Provider labels** are the server's enabled ids with a capital first letter —
text only (§9); this code names no provider.

`pnpm test:cloud-auth` runs this profile against the real server software in
Docker (its image, database setup and settings are data in
`docs/reference/token-endpoint-server.json`), with a captured SMTP mailbox —
16 checks, all passing.

**Cross-origin headers.** The adapter sends `apikey` and `authorization`.
The bare server allows only `content-type` across origins, so a browser's
preflight is refused until its allowed-headers setting adds those two (the
reference config does; the real-server test found this). A managed cloud's
gateway already allows them; a self-run server of this kind needs the setting.

## 4. Secret leakage — a hard build error

word-quality-gate §4 governs, and it bites here because **a static bundler
inlines environment variables into the shipped JavaScript**. A `VITE_`-prefixed
variable is not a secret, it is public text with an extra step, and nobody
discovers this until the site is live.

| Key class | Reaches the browser? |
|---|---|
| public / anon / publishable key | **yes** — designed for it, protected by row-level security |
| service key (full database access, bypasses row-level security) | **never** |
| session-signing secret | **never** — server-side only |
| `AZ_SECRET` (backend adapter token signing) | **never** |

Three compiler behaviours, mandatory at M4: **(1)** refuse to build when a
service-key-pattern variable would be inlined — hard error, not suppressible;
**(2)** scan the produced bundle for known prefixes and high-entropy strings
(`sk_`, `service_role`, `-----BEGIN`) and fail on a hit, because rule 1 catches
the variable and rule 2 catches the string pasted straight into a file;
**(3)** refuse a literal key in the `.az` file — credentials are environment
configuration, never site description. Exact text in §11.

**No example anywhere — this document, generated files, READMEs, fixtures —
contains a real key;** fixtures use `<PLACEHOLDER>`, because a copyable key in
documentation gets pasted into a real project by somebody in a hurry.

### 4.1 What actually protects the data

**Row-level security in the user's own backend is the protection.** Not the
form, not the route guard, not the session hook — none of which run anywhere an
attacker cannot modify. The public key is public. Every row the backend's
policies let an anonymous or authenticated role read **is readable by anyone who
opens dev tools**, whatever the generated UI does. The adapter docs must say
this in those words, `az doctor` must check for policy-less tables where the
adapter exposes that, and this spec must not soften it. A design tool that lets
someone believe their login form is their security has done real harm.

---

## 5. What the word emits, and what it does not

| Artefact | Detail |
|---|---|
| Form markup | one real `<form>` per variant, themed, labelled, autocompleted (§6) |
| Client wiring | a submit handler calling the §3 interface — nothing else |
| Session hook | `useSession()` over `session()` + `onChange()`, unsubscribe on unmount |
| Protected-route wrapper | `<Protected>` — loading state, then children or a redirect to `login` |
| Error states | the closed `AuthErrorCode` set mapped to copy, inline errors, error summary |
| Loading / success | fixed-width submit spinner, `aria-busy`, redirect to `redirect` |
| `reset` two states | request form and set-new-password form, chosen by a URL token |

**Never emits, at any tier:** password hashing, token minting or verification,
any cryptography · session storage format, refresh logic, cookie flags — the
adapter owns the session, the block only reads it · rate limiting, lockout, bot
defence, captcha · email sending, templates, delivery · OAuth redirect handling
beyond calling the adapter · server middleware or route protection (**a static
site has no server**) · row-level security policies, roles, backend config ·
account deletion, data export, consent records.

**Which pages are protected** is site configuration, beside the adapter:
`protect /account /orders` under the site-level `auth` (a list of routes, each
checked to be a page — AZ1215). A protected page shows its nav and "Checking
that you are signed in…" while the adapter answers, then the page with a
signed-in bar and a sign-out button — or sends the visitor to the `auth login`
page with `?next=<the page>`. After signing in, `next` is followed **only** if
it is a path on the same origin; anything else falls back to the form's
`redirect`. With no `auth login` page the compiler warns (AZ2004).

**The protected-route wrapper is UX, not security.** It stops a signed-out user
seeing a broken empty dashboard; it does not stop anyone reading the data behind
it, because the code enforcing it runs on their machine and the request goes out
either way. §4.1 is the sentence that matters and this wrapper is the one people
mistake for it — so the generated file carries §4.1 in its header comment.

## 6. Form accessibility, done properly

**Labels.** A real `<label for>` per field, always visible. Not a placeholder —
it disappears on focus, fails contrast, and is not an accessible name. Not
`aria-label` either: a sighted user with a cognitive disability needs the label
on screen as much as a screen-reader user needs it in the tree.

**`autocomplete` tokens, exactly** — wrong is worse than none, since
`current-password` on a signup form makes a manager offer the wrong entry:

| Field | Token | `type` |
|---|---|---|
| email (`login`, `signup`) | `username` | `email` |
| password, `login` | `current-password` | `password` |
| password, `signup` / `reset` set-new | `new-password` | `password` |
| name, `signup` | `name` | `text` |
| retype password, `signup` / `reset` set-new | `new-password` | `password` |
| location, `signup` (optional) | `address-level2` | `text` |
| one-time code | `one-time-code` | `text`, `inputmode="numeric"` |

**Inline errors, tied by id.** Each error sits in an element whose id is named
in the field's `aria-describedby`, and the field carries `aria-invalid="true"`.
An error rendered beside a field but not associated with it is invisible to the
tool that most needs it.

**Error summary and focus management.** On a failed submit, render a summary at
the top of the form — `<div role="alert" tabindex="-1">`, one entry per failing
field, each an in-page link to it — and **move focus to the summary**, not to
the first failing field, or the user loses the count of what is wrong. Do not
also wrap it in `aria-live`: focus entering a `role="alert"` announces once, and
both together announce twice — a stutter, and a real bug in shipped forms.
`aria-live="polite"` is for **asynchronous status** ("Sending your link…"), a
different thing that does not take focus.

**Validate on submit, not on keystroke** — flagging an email on the fourth
character is hostile. Re-validate on blur *after* a field has failed once, so a
correction clears the error immediately.

**Never disable the submit button.** buttons-and-sections §1.5 says this and
auth proves it: a disabled submit gives no reason, is not focusable in most
implementations, is skipped in screen-reader form-control lists, and leaves the
user staring at a greyed button with no way to discover which field is at fault.
It stays enabled, submit runs validation, the errors explain. The `loading`
state after a real submit is different and allowed — `aria-busy="true"`, fixed
width so the layout does not jump.

**Also:** exactly one `<h1>` per auth page — the form title, since these pages
have no hero. 44×44px touch targets. Visible `focus-visible` ring on every
control, never `outline: none`. Contrast ≥4.5:1 including error text, most often
shipped as thin red on white and failing.

## 7. Password-manager compatibility

Managers are heuristic, and the heuristics reward doing the ordinary thing:

- **A real `<form>`** with a real submit button — managers do not reliably detect
  a `<div>` with a click handler, and Enter will not submit it.
- **A username field on every password form**, including the set-new-password
  step of `reset`, or the manager cannot file the new password. When the address
  is known, render it `readonly`, never `display: none`.
- **Never block paste**, and never split a one-time code across six inputs
  without `autocomplete="one-time-code"` on a single field — paste-blocking is
  theatre that pushes people toward weaker passwords.
- **No `autocomplete="off"` on credential fields** — largely ignored on
  passwords, and where honoured it makes things worse.
- **The visibility toggle is `<button type="button">`** (a bare `<button>` in a
  form submits it), with `aria-pressed` and an `aria-label`.
- **State strength requirements up front**, tied to the field with
  `aria-describedby` — discovering the rule by failing it is avoidable friction.

## 8. Layout, spacing and responsive

Tokens only, no literals (CONVENTIONS §4): form measure ~40ch — wider reads as
an app settings panel; `space.8` label to input, `space.16` between fields,
`space.4` from error text to its field so it reads as attached, and `space.32`
before the submit, which is the largest internal gap; `space.24` from submit to
the sibling link.

| Variant | <768px |
|---|---|
| `login` | full-width card inside the page gutter; submit full-width |
| `signup` | identical; any two-across field pair (first/last name) stacks |
| `reset` | identical; both states are single-column already |

Centre the form vertically with a **minimum top offset**, not
`justify-content: center` alone — a centred form on a short landscape viewport
pushes the submit off-screen. Keep one column at every width: "form beside a
marketing image" is where the phishing resemblance is strongest and the mobile
result worst. `glass` is a taste risk here — blur behind a credential form
reduces contrast on exactly the fields that must not lose it.

## 9. The phishing constraint

distribution-and-hosting §5.1 is blunt: **a free host plus a subdomain plus a
generated `auth` page is, functionally, a phishing kit with good design.** Free
static hosts are abused this way constantly. For the word that means:

- **`auth` compiles in the CLI, always** — local builds, self-hosting and paid
  verified accounts are unaffected; nothing about the language changes.
- **A build containing `auth` is rejected at publish on the free tier** — at
  publish, not at compile, so the failure names the real constraint (§11).
- Platform mitigations, recorded so the word's design does not undermine them:
  no custom domains on free, no anonymous publishing, safe-browsing checks on
  publish, a report button, a human on the takedown path.

The design consequence: **`auth` never renders another entity's mark, and
compiles no other entity's name.** (Owner decision, 2026-09-23: `methods
oauth` shows "Continue with {label}" — text the site owner's backend supplies
at runtime from its own configuration, never a logo or a name compiled into
the site.)
No borrowed wordmarks, no provider logos in the theme — the author supplies
their own, exactly as `footer` §6 requires. A generated form that cannot dress
itself up as somebody else is harder to weaponise, and it keeps the word inside
CONVENTIONS §5.

## 10. Manifest sketch — `words/auth/word.json`

```jsonc
{
  "name": "auth",
  "version": "1.0.0",
  "kind": "block",
  "variants": ["login", "signup", "reset"],
  "modifiers": ["glass"],
  "props": {
    "adapter":  { "type": "enum", "values": ["hosted", "session", "azbackend", "custom"],
                  "required": true, "scope": "site" },
    "profile":  { "type": "enum", "values": ["standard", "token-endpoint"],
                  "default": "standard", "scope": "site" },
    "title":    { "type": "string", "maxWords": 8 },
    "sub":      { "type": "string", "maxWords": 20 },
    "methods":  { "type": "list", "of": "enum", "values": ["password", "link", "oauth"],
                  "max": 3, "default": ["password"] },
    "redirect": { "type": "route" },
    "terms":    { "type": "route" },
    "impl":     { "type": "path", "ext": [".ts", ".tsx"], "scope": "site" },
    "protect":  { "type": "list", "of": "route", "scope": "site" }
  },
  "slots": { "alt": { "max": 2 } },
  "requires": { "signup": ["terms"] },
  "requiresWhen": { "adapter": { "custom": ["impl"] } },
  // Exactly the tokens this word's own code reads; az lint (pnpm lint) fails on a missing or extra entry.
  "themeReads": [
    "color.bg", "color.border", "color.danger", "color.muted", "color.surface",
    "color.text", "radius.md", "radius.sm", "size.gutter-sm", "size.measure-body",
    "size.measure-display", "size.tap", "space.4", "space.8", "space.12",
    "space.16", "space.24", "space.32", "space.96", "type.display",
    "type.leading-body", "type.leading-tight", "type.size.2xl", "type.size.base",
    "type.size.sm", "type.weight-bold", "type.weight-display"
  ],
  "deps": {},
  "targets": ["web"],
  "tested": {
    "browsers": ["chrome-latest", "safari-latest", "firefox-latest", "ios-17"],
    "with": ["nav", "footer"]
  }
}
```

`deps` is empty on purpose (§3) — the adapter package carries its own exact pin.
`"scope": "site"` is a new manifest field; see §12.2.

---

## 11. Compiler validations

| Check | Severity | Message |
|---|---|---|
| service key would be inlined | **error, unsuppressible** | `auth: 'VITE_SERVICE_KEY' is a service key and would be readable in the shipped bundle — use the public key here and keep the service key on your server` |
| key pattern in the built site | **error, unsuppressible** | `auth: a service-key pattern was found in <where> — remove it from source and rebuild`, `<where>` naming the place: `the built bundle`, `a file copied from public/`, `a file in the output folder`, or `a pre-rendered page` |
| key literal in the `.az` file (AZ1411, any word) | error | `auth: a key literal in 'key' would be committed to source control — move it to an environment variable` |
| no variant | error | `auth: no form named — pick one of 'login', 'signup', 'reset'` |
| two variants | error | `auth: 'login' and 'signup' are both forms — pick one` |
| no adapter declared | error | `auth: no adapter — add to 'site': auth adapter hosted` |
| two adapters in one site | error | `auth: 'hosted' and 'session' are both adapters — one site, one adapter` |
| `custom` without `impl` | error | `auth: 'custom' needs an implementation — add: impl ./auth/adapter.ts` |
| `signup` without `terms` | error | `auth: 'signup' has no terms link — add: terms /terms` |
| `redirect` to an undeclared page | error | `auth: '/account' is not a page in this site — add it or fix the redirect` |
| two `auth` blocks on a page | error | `auth: only one form per page (it owns the <h1>)` |
| free-tier publish | error | `auth: login forms are not published on free sites — publish from the CLI to your own host, or verify your account` |
| `login` with no sibling route | warning | `auth: 'login' offers no way to sign up or recover — add: alt "Create an account" /signup` |
| `signup` with >4 fields | warning | `auth: 'signup' asks for 6 fields — every extra field costs sign-ups, ask for them later` |
| `glass` on an auth page | warning | `auth: 'glass' reduces contrast on credential fields — use the plain surface` |
| submit label in the denylist | warning | `auth: 'Submit' is not what the button does — name the action, e.g. "Sign in"` |
| `<Protected>` with no `login` page (AZ2004) | warning | `auth: a protected route has nowhere to send signed-out users — add a page with 'auth login'` |
| `methods oauth` without a server that runs it (AZ2005) | error | `auth: 'methods oauth' needs adapter azbackend, session or hosted — their server runs the provider sign-in` |
| `methods oauth` on `hosted` with the standard profile (AZ2006) | error | `auth: 'methods oauth' with adapter hosted needs profile token-endpoint — the standard hosted protocol has no provider sign-in` |

**Where the two unsuppressible errors run.** Rule 1 runs twice: `az build`
scans the environment and the project's `.env` files before it writes
anything, and the generated project's own build scans the environment it
actually loads (`az-vite/guard.ts`). Rule 2 runs in that build, over every
chunk and asset it emits. The patterns are shapes, never a provider's name:
private-key blocks, `sk_`/`rk_` prefixes (`sk_live_`/`rk_test_` and 10+
characters anywhere, a bare `sk_` and 16+ at the start of a name or after
`_`), `service_role`, tokens whose role claim is `service_role`/`service`/`admin`,
high-entropy strings (32+ characters, base64 padding counted, ≥4.0 bits per
character, letters and digits), and a shorter value (16+ characters, ≥3.0
bits, letters and digits) set to a name that says credential — `key`, `token`,
`secret`, `sig`, `password`, `auth` — in a query string, a config line or a
cookie. Inlined `data:` assets, a path every segment of which is all digits or
lowercase words, the site's own public values, the names of the files the
bundler emitted and the digests a page's own policy pins are allowed; the build
guard, the page scan after the pre-render and `az audit` share that one scan
(`siteScanner`). A finding names the variable
or the file offset and the value's length — never any character of the value.

The two unsuppressible errors are the only ones in the product. Everything else
in AZ is a judgement call with an escape hatch; shipping a database key is not.

## 12. Open questions

1. **Does `auth` own the `<h1>` on its page, or a `text` block above it?**
   *(Recommend: `auth` — no hero here, and the form title is the page's subject.
   The two-blocks error above assumes this.)*
2. **`"scope": "site"` is a new manifest field.** Nav and footer inherit at the
   *block* level; this is the first inherited **property**. *(Recommend: add
   `scope: "site" | "page"` to ARCHITECTURE §4.1 rather than special-casing
   `auth` in core, which principle 5 forbids.)*
3. **Does `methods oauth` earn Phase 1?** It needs a redirect round-trip a static
   site cannot fully own, and provider buttons are the branded surface §9 forbids
   shipping. *(Recommend: defer to M5 — `password` and `link` cover the dogfood
   site, and deferring keeps the phishing surface smallest for the release where
   abuse risk is highest.)*
   **Decided by the owner, 2026-09-23: yes — overriding the deferral.** It
   ships provider-neutral: generic OpenID Connect and OAuth 2 providers
   configured in the backend's environment, the round-trip run by the
   backend (§3.4), text-only labels (§9). It needs a server that runs the
   round-trip: `adapter azbackend`, `session`, or `hosted` with
   `profile token-endpoint` (§3.5) — AZ2005/AZ2006 otherwise.
4. **Should `<Protected>` exist at all in Phase 1**, given §5's admission that it
   protects nothing? *(Recommend: yes, with the header comment stating what it is
   not. Without it every user writes a worse one, without the warning.)*
5. **Mobile-app target:** an app has a keychain, a secure store and biometric
   unlock, so §4.1 changes shape entirely. *(Needs its own Phase 3 decision.)*
