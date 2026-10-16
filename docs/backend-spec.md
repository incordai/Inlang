# The built-in backend

**Status** built 2026-09-23 · Optional · Implements auth-block-spec §3.4
(`azbackend`) · Decision recorded in PRD §6.5

A site can sign people in through a hosted provider, its own session server,
its own code — or, from this spec on, a server `az` generates for it. This is
that server: accounts, sessions, sign-up, password reset and sign-in links by
email, and provider sign-in, over SQLite, PostgreSQL or MySQL.

It is **opt-in**. A site without a `backend` declaration builds exactly as it
did before; nothing below applies to it.

---

## 1. Why it exists

PRD §6.5 said "we never implement auth", for a good reason: hand-rolled
crypto in a design tool is how people get breached. The owner reversed that
for SaaS sites that need accounts without a separate project. The reason
survives as a rule instead of a ban: **no hand-rolled primitives.** Hashing,
randomness, HMAC and signature verification are Node's own `crypto`; mail
goes through a mature SMTP library; every security property in §5 has a test
that fails without it.

## 2. Declaring it

```
site studio
  auth
    adapter azbackend
  backend
    database sqlite          # sqlite | postgres | mysql
    email    smtp            # smtp | api
    model    default         # optional: this server talks to a chat model (chat-block-spec.md)
```

`model default` is the third setting, optional, and `default` is its only
value: *the operator picks* — the wire shape, URL, key and model id live in
`.env` (§4, `AZ_CHAT_…`), never in the `.az` file. A site whose pages show a
`chat` needs it; the build then writes the chat files (§8) and the server
gains `POST /chat`.

`backend` is a site-level **structure keyword**, not a block — it renders
nothing and does not count against the eleven-block cap. Its two settings are
**closed choices**; a value outside them is AZ1412. An address or key written
here — `database postgres://user:pass@…` — is refused with a message saying
it belongs in the backend's `.env` (§4): the mistake this prevents is a
password committed in a `.az` file.

| Code | When |
|---|---|
| AZ1223 | `backend` anywhere but directly under `site` |
| AZ1224 | a setting other than `database` or `email` |
| AZ1225 | a setting missing |
| AZ1412 | a value outside its choices |
| AZ1506 | declared twice |
| AZ1507 | the site's `auth` does not use `adapter azbackend` (the server would be unused) |

**Location with search.** The sign-up form's optional location field offers
type-ahead suggestions from a built-in list of 257 country and territory
names (CLDR, committed as data), as a native `<datalist>`: the browser's own
combobox — keyboard and screen-reader support included, no script, no
outside service — and free text still accepted, as §3.4 requires.

## 2a. Local development — `az dev site.az`

On your own machine there is nothing to set up:

```sh
az dev site.az            # add --open to open the browser, --port N to choose the site port
```

`az dev` compiles the site, installs its dependencies once, and serves it on
`http://127.0.0.1:5173/` (or the next free port), reloading the open page on
every save. For a site that declares `backend` it also runs the backend with a
**development profile**:

| | Development (`az dev`) | Production (`az build` + `az backend init`) |
|---|---|---|
| Database | SQLite in `.az-dev/dev.db`, whatever the site declares | the declared database, from `.env` |
| Secret | generated once into `.az-dev/secret` (owner-only) | `.env`, from `az backend init` |
| Addresses | everything on `127.0.0.1`, wired automatically | your https URLs in `.env` |
| Email | **not sent**: printed in the terminal and listed at the mailbox URL `az dev` prints | SMTP or the email API |
| Session cookie | HttpOnly, SameSite=Lax, not `Secure` — WebKit drops a Secure cookie on http://127.0.0.1 | HttpOnly, **Secure**, SameSite per `.env` |

Use the address `az dev` prints (`127.0.0.1`), not `localhost`: the two are
different sites to a browser, and the session cookie belongs to one of them.

`.az-dev/` ignores itself (it holds a `.gitignore` of `*`), so none of it is
committed. None of the development profile ships: it lives in the CLI, and
a production build carries no mailbox, no dev secret and no loopback cookie
mode (tested). Provider sign-in works locally once you put a provider's keys
(the `AZ_OAUTH_…` names in §4) in `.az-dev/backend.env` and register
`http://127.0.0.1:<backend port>/auth/oauth/<id>/callback` with the provider;
the wired addresses, database and mailbox in that file are always overridden.

`az dev --no-serve` only compiles on every save, as before.

A file still being written previews its finished blocks with a "still
writing" banner instead of failing (docs/partial-preview.md); `az build` and
`az check` stay strict.

## 3. Storage

One small interface over three engines (`server/src/db.ts`). Every query is
written once with `?` placeholders and parameters; values are never spliced
into SQL. PostgreSQL's `$1` numbering is generated mechanically.

| Table | Holds |
|---|---|
| `az_users` | id (UUID), email (unique, lower-cased), name, password hash (null for provider-only accounts), location, email verified, created/updated |
| `az_sessions` | token **digest**, user, created, expires (`AZ_SESSION_MAX_HOURS`, default 14 days), last used (idle expiry, `AZ_SESSION_IDLE_MINUTES`) — migration 2 |
| `az_tokens` | reset / sign-in-link token **digest**, user, the site it was requested from, created, expires (30 / 15 min), used, and for a sign-in link the **digest** of the requesting browser's binding cookie — migration 2 |
| `az_oauth_accounts` | provider + subject → user |
| `az_oauth_states` | provider round-trip state **digest**, PKCE verifier, nonce, next, site, expires (10 min) |
| `az_schema_migrations` | versions applied |

Migrations are versioned steps per engine, run on every start, never edited
once shipped. Times are epoch milliseconds in 64-bit integers so the three
engines hold identical values.

**SQLite is Node's built-in `node:sqlite`.** It needs no package, no native
build and no install script (the project installs with `--ignore-scripts`).
On Node 22 it prints an *ExperimentalWarning* at start; the API it uses
(`DatabaseSync`) is small and wrapped in one file, so a change is one edit.
The alternative, a native SQLite package, needs a compile or install step.

### 3.1 Managed databases and connection poolers

A managed PostgreSQL (a cloud project's database — docs/cloud-setup.md) is an
ordinary `database postgres`: its connection string in `AZ_DATABASE_URL`,
`AZ_DATABASE_TLS=require`, and — when the host signs with its own root
certificate rather than one your system trusts — that certificate's PEM file
in `AZ_DATABASE_CA_FILE`. The certificate is always verified; there is no
setting that turns verification off.

**Transaction-mode poolers** (the pooled port a managed database offers)
break *named* prepared statements, session settings and transactions that
span several calls, because consecutive queries may run on different server
connections. This server uses none of them: every query is one statement sent
as an *unnamed* prepared statement (`pool.query(text, params)`), with no
`SET`, advisory lock, `LISTEN` or multi-call transaction. The one-time-use
token spend is a single conditional `UPDATE`. So the pooled port works; the
direct port works too. *(Verified by reading the code; a run against a real
pooler is pending — see docs/cloud-setup.md.)*

## 4. Configuration — the env file

Every setting lives in the server's environment; `server/src/env.ts` is the
one schema for all three readers:

- **the server** validates it at start and **refuses to start**, naming every
  missing or unsafe key at once;
- **`az build`** writes `server/.env.example` from it — every key the chosen
  setup reads, described, secret values blank; committed;
- **`az backend init <server-dir>`** writes `server/.env`: the example, with a
  fresh 32-byte `AZ_SESSION_SECRET`, file mode `0600`, never overwriting an
  existing one (a new secret would sign everyone out). `.env` is in the
  generated `.gitignore` and is never written by a build.

| Key | Needed | Meaning |
|---|---|---|
| `AZ_SESSION_SECRET` | always | ≥ 32 random bytes; keys every stored token digest |
| `AZ_BACKEND_PUBLIC_URL` | always | this server's public URL (https; http only on loopback) |
| `AZ_ALLOWED_ORIGINS` | always | the exact site origin(s); also the only redirect targets |
| `AZ_HOST`, `AZ_PORT` | optional | listen address (127.0.0.1:8787) |
| `AZ_TRUST_PROXY` | optional | `false` (default), `true` (one proxy) or the number of proxies you control; rate limits use the X-Forwarded-For entry that many places from the right |
| `AZ_SESSION_IDLE_MINUTES` | optional | a session unused this long ends (default 1440; ASVS L2: 30) |
| `AZ_SESSION_MAX_HOURS` | optional | a session ends this long after sign-in (default 336; ASVS L2: 12) |
| `AZ_COOKIE_SAMESITE` | optional | `lax` (same site, default) or `none` |
| `AZ_SQLITE_PATH` | sqlite | database file (`./data/app.db`) |
| `AZ_DATABASE_URL`, `AZ_DATABASE_TLS` | postgres, mysql | connection string; `require` for TLS |
| `AZ_DATABASE_CA_FILE` | optional | PEM root certificate for a host that signs with its own (§3.1); needs `AZ_DATABASE_TLS=require` |
| `AZ_EMAIL_FROM` | always | the From address |
| `AZ_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD` | smtp | the relay |
| `AZ_EMAIL_API_URL`, `AZ_EMAIL_API_KEY` | api | the email endpoint (§7) |
| `AZ_RESET_PATH`, `AZ_LINK_LANDING` | optional | site paths for the two emailed links |
| `AZ_OAUTH_PROVIDERS`, `AZ_OAUTH_SIGNUP` | optional | provider ids; `allow` lets a provider create accounts |
| `AZ_ADMIN_EMAILS` | sites with `data` | verified addresses that may use `/admin` (data-spec §11); empty = nobody |
| `AZ_FILES_DIR` | sites with an `image` field | where uploaded images are stored (`./data/files`), outside anything served statically (data-spec §8) |
| `AZ_UPLOAD_MAX_MB` | sites with an `image` field | the largest upload, 1–20 MB (default 5) |
| `AZ_CHAT_API` | sites with `chat` | the model's wire shape: `completions` (the common chat-completions streaming shape), or `fake` (scripted answers from `AZ_CHAT_FAKE_FILE`; refused unless `AZ_BACKEND_PUBLIC_URL` is on localhost — the generated server's "development profile") |
| `AZ_CHAT_URL`, `AZ_CHAT_MODEL` | `completions` | the API base (https; http only on localhost) — answers come from `<url>/chat/completions` — and the model id, passed as written |
| `AZ_CHAT_KEY` | optional | bearer key (secret; empty for a local model server) |
| `AZ_CHAT_DAILY_TOKENS`, `AZ_CHAT_MAX_OUTPUT_TOKENS` | optional | the day's budget for all chats (300 000; 1 000–100 000 000) and one answer's cap (600; 100–2 000) |
| `AZ_CHAT_PER_ADDRESS`, `AZ_CHAT_PER_ACCOUNT` | optional | `<n>/hour`, `<n>/day` or both (`20/hour,60/day`; `100/day`) |
| `AZ_CHAT_CONCURRENCY`, `AZ_CHAT_TIMEOUT_SECONDS` | optional | answers at once (4; 1–64; four times as many wait ≤ 10 s) and one answer's longest time (60; 10–300 — the first token within 15 s, each next within 20 s) |
| `AZ_CHAT_ENABLED` | optional | `off` is the kill switch |
| `AZ_OAUTH_<ID>_…` | per provider | `LABEL`, `TYPE` (oidc/oauth2), `ISSUER` or the three URLs, `CLIENT_ID`, `CLIENT_SECRET`, `SCOPES`, `EMAIL_FIELD`, `VERIFIED_FIELD` |

**Nothing here reaches a browser.** No key carries the `AZ_PUBLIC_` prefix a
site build inlines, and the site's secret guard now also fails a build that
gives a server setting a public name (`AZ_PUBLIC_…PASSWORD`,
`…DATABASE_URL`, `…SMTP…`, `…EMAIL_API_KEY`, `…SECRET`).

## 5. Security — each property and its test

| Property | How | Test |
|---|---|---|
| No SQL injection | parameters only | hostile email/name/location stored literally; the table survives — SQLite, PostgreSQL, MySQL |
| Passwords | scrypt N=2^15 r=8 p=3 (OWASP-listed, 32 MiB), 16-byte salt, parameters stored with the hash and upgraded on next sign-in; 12–1024 characters | hash format, salt, verify, rehash |
| No enumeration | one `invalid_credentials` for unknown account and wrong password, the unknown case verifying a decoy hash for equal work; `/link` and `/reset` always `200 {}`, mail sent without awaiting. **Sign-up answers `409 email_taken`** by design (auth-spec §3's closed set): a person creating an account must be told the address is in use; it is rate-limited per address bucket like every sign-up | same body; comparable time; no mail for unknown addresses |
| Rate limits | per address and per account: sign-in 20/10 per 15 min, mail 10/3, sign-up 10/h, password 20, navigations 30/10 min. The address is the socket peer, or behind `AZ_TRUST_PROXY` proxies the X-Forwarded-For entry they appended (the client-sent first entry is never believed); an IPv6 address counts as its /64. Each limiter holds at most 50 000 keys, dropping the least recently seen, and is swept every minute. **Lockout by design:** 10 wrong passwords per 15 min lock that account for everyone, and 3 mail requests per 15 min stop further reset/link mail to it — a nuisance an attacker can cause, bounded to the window | 429 after the limit; another account unaffected; a spoofed first entry shares the real address's bucket; one /64 is one bucket; the key budget holds under a flood |
| CSRF | a fetch route needs an allowed `Origin`; a POST needs `x-az-request: 1` | foreign origin 403, missing header 403 |
| CORS | exact origin, credentials, `Vary: Origin`, never `*` | preflight headers |
| Cookies | session `__Host-az_session`: `HttpOnly; Secure; Path=/; SameSite=Lax` (or `None`), no `Domain` — a sibling subdomain can neither set nor shadow it; path-scoped `__Secure-az_oauth_state` and `__Secure-az_link`. `az dev` drops `Secure` on loopback and so uses the bare names | names and flags asserted at the server and in the browser |
| Tokens | 32 random bytes, stored as HMAC-SHA-256 under the secret; single use by one conditional UPDATE; expiry | reuse fails; expiry fails; three concurrent spends → exactly one (PostgreSQL, MySQL) |
| Sessions | rotated at every sign-in; sign-out deletes server-side; a password change ends every session; idle expiry and an absolute cap (ASVS 3.3.2) | stale and copied cookies are dead; idle and over-cap sessions end, activity keeps one alive |
| Unverified accounts | anyone may create an account for any address. When the address is then proven another way — a sign-in link, or a provider vouching for it — the account is **claimed**: its password and every session are dropped (one conditional UPDATE, only while unverified). Otherwise a planter's password and session would share the owner's account | planted account → owner signs in → the planter's password and session are dead; a verified account keeps its password |
| Sign-in links | bound to the browser that requested them: `/link` sets a random `__Secure-az_link` cookie whether or not the address has an account, the token stores its digest, and `/link/verify` spends only with it. Opened in another browser the link fails `expired_token` without being spent — so nobody can mail themselves a link and make a victim open it (login CSRF). Open the link in the browser that asked for it | another browser → not signed in, link unspent; the asking browser → signed in |
| Addresses | a dot-atom local part and a domain of two or more DNS labels; no quotes, commas, angle brackets or display names (a mail library would read `x<victim@corp.example>` as another recipient) | header and list syntax refused |
| Robustness | a request line the URL parser rejects (`GET //`) is answered 400; the request handler never rejects; provider values longer than their columns are `oauth_failed`, not 500 | `//`, `//?`, `//%`, `//[` → 400, server still up; a 300-character subject |
| Retype | re-checked on sign-up and password set, before the token is spent | `password_mismatch`; a mistype does not burn the link |
| Provider sign-in | `site` allow-listed, `next` a site path; state bound to the browser by cookie and single use; PKCE S256; OIDC nonce; id_token signature (RS256, PS256, ES256, EdDSA via JWKS; HS256 only with the client secret), `iss`, `aud`/`azp`, `exp`, `iat`; JWKS cached, refetched on an unknown `kid`; accounts link by **verified** email only; no new account unless `AZ_OAUTH_SIGNUP=allow` | `none`, algorithm confusion, wrong audience, wrong issuer, expired, wrong nonce, missing/replayed state, unverified email, key rotation |
| Headers | `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, `CSP default-src 'none'`, HSTS, CORP — on every response the server writes, the last-line 500 (`requestListener`) included, and the 400/408/413/431 to a request Node cannot parse (`createBackendServer`'s `clientError` listener: a raw status line and the set, no body, nothing echoed, then the socket destroyed; no write on a reset, an unwritable socket or a response already begun) | asserted; a handler that throws past its own catch still answers 500 with the full set; a raw client's malformed request line gets 400 and an oversized header 431, each with the full set and the socket closed — on `createBackendServer` in process, and on the real entry (`main.ts` started from a copied server folder, `packages/backend/test/main.test.ts`), which failed before `main.ts` used it (`cache-control` absent) |
| Bodies | JSON objects only, 16 KB cap | refused otherwise |
| Chat edge | `POST /chat` is a fetch route with the /data edge: an allowed `Origin`, exact CORS (`POST`), `OPTIONS` 204, `x-az-request: 1`, other methods 405; absent unless a page shows a chat | `chat-route.test.ts`: foreign origin 403, missing header 403, GET 405, preflight headers; a server without chat answers 404 |
| Chat figures | a chart, table, stat or card `from` a table is read as an anonymous `GET /data` would: only tables a signed-out visitor may list, only their public fields, through the list's own query code, cancelled by the database past 2 s (chat-block-spec §20.5) | `chat-query.test.ts` (figures equal an anonymous visitor's paging; no private value; the deadline); `test:backend-db` on PostgreSQL and MySQL |
| Chat rows (`knows`) | the tables a chat knows are read per question as an anonymous `GET /data` would — parseQuery, selectList and outRow with no user — public non-image fields only, the visitor's words searched in the `search` fields (else the newest rows), 20 rows, 2 000 characters a row, 12 000 a table, cached 60 s, cancelled past 2 s; sent after the site content in `<site-rows>` sections whose `<`, `>`, `&` are escapes; the server refuses to start when context.json names a table it would not let a stranger list, one anyone may write to, or a field that is private (chat-block-spec §8.2) | `chat-knows.test.ts` (the exact bytes the model is given for a signed-in visitor: no private value, owner-only row, email, address or account id); `test:backend-db` on PostgreSQL and MySQL; `test:chat` |
| Chat shares | `POST /chat/share` stores one answer only with the HMAC share tag over its exact events, turn and time (a day old at most); `GET /chat/share/<id>` reads it signed out with `X-Robots-Tag: noindex`; `DELETE` with the delete token (stored as its SHA-256); 128-bit ids; 48 KB per share; limits per address and account and a live-share ceiling; unknown, expired and wrong-token alike are 404 (chat-block-spec §20.7) | `chat-share.test.ts`, `chat-share-route.test.ts`, `test:backend-db`, `test:chat` |
| Chat moderation | optional (`AZ_CHAT_MODERATION_URL`, its key a bearer token): every visitor turn the model would be given is POSTed as `{ text }` before the rows, the budget and the queue; only an exact `{ "allow": true }` passes; `{ "allow": false }` is `400 blocked`; an error, a non-2xx, a redirect, no answer within 3 s (body included), a reply past 4 KB or of any other shape is `503 unavailable` — it fails closed and the model is never asked; logs carry the kind, never the text or the key (chat-block-spec §6.8, §19.8) | `chat-moderation.test.ts` against a local endpoint (allow, block, each failure, the visitor leaving); `test:chat` in three engines |
| Chat tools | optional (`AZ_CHAT_TOOLS`, each tool's `AZ_CHAT_TOOL_<NAME>_*`, validated at start — a bad key refuses to start, named, no value quoted): a chart, table or stat `from tool <name> …` names a **declared** tool and typed parameter values the answer parser checks against the declaration (an unknown tool, parameter or value drops the component); the server POSTs the values as JSON to the operator's fixed URL (https, or http on loopback; `redirect: 'error'`), the bearer key when set, under the tool's timeout (≤ 5 s, request and body); only a `200` `application/json` reply of ≤ 256 KB and ≤ 200 rows of exactly the declared fields and types is taken — one row wrong refuses all; 3 calls an answer, `AZ_CHAT_TOOL_CALLS_PER_ADDRESS`, a 60 s cache of 200 entries; the rows go to the page only (`src: tool` with the operator's label), **never to the model**; logs `chat: tool <name> <outcome> <ms> <rows>` only (chat-block-spec §21.2, §19.10) | `chat-tools.test.ts` (every bad declaration; every parameter type at its bounds ± 1; a local endpoint: body and key, redirect not followed, timeout, non-2xx, wrong type, 257 KB, 201 rows, missing/extra field, NaN, markup as text; the cache; the per-address limit); `chat-tools-route.test.ts` (the model's every request captured: no row in this answer's or the next's, the system text byte-equal to the one with no tool answered; the per-answer cap; an invented tool never called); `test:chat` in three engines (https with a self-signed certificate) |
| Chat usage | `GET /admin/chat` (a site with chat and data): today against the budget, the last 30 days' counts, the shares kept — under the admin check of every /admin route, read only, no parameters, 404 without chat; never a message or a share's text. `az backend usage <server-dir>` prints the same, read only (chat-block-spec §11.4) | `data-admin.test.ts` (signed out 401, unverified or unlisted 403, the admin 200 with no message text); `chat-usage.test.ts`; `test:backend-db`; `test:chat` (axe) |
| Chat history | the page resends the conversation; every answer the server finished carries an HMAC-SHA-256 tag (conversation, turn, exact text) under a key derived from `AZ_SESSION_SECRET`; a `site` turn without its tag is `400 tampered` | forged, altered, moved and untagged answers refused (`chat-text.test.ts`, `chat-route.test.ts`) |
| Chat output | prose only (C1): every piece of model text has controls, bidi overrides and zero-width characters removed, is NFC-normalised, never decoded, and reaches the page as a `text` event the page writes with `textContent`; 4 000 characters per answer | the cap ±1, a markup string arrives as literal text |
| Chat cost | per-address and per-account windows (the limiter above, /64 rule, key bound), a per-conversation length, the per-answer token cap, the day's budget in `az_chat_usage` (refused **before** sending when the largest cost would cross it), the kill switch, 4 at once with 16 waiting ≤ 10 s, first-token/between/whole timeouts, and the upstream aborted the moment the visitor leaves | each limit with a fake clock or a scripted model; a disconnect aborts the upstream; `test:backend-db` counts concurrent answers on PostgreSQL and MySQL |
| Chat logs | one line per answer: outcome, duration, token counts — never text, address, account, key or a provider's body | a planted marker in a message and in the answer is absent from the log |
| Logs | route and error class/code only — never a password, token, secret, address, or a provider's or mail server's reply text | the browser run checks the server's log; a mail failure quoting the recipient logs only its class |

**Stated limits.** Rate limits are counted per process; behind several
instances, limit at the proxy as well. Timing is equalised for sign-in; the
mail routes write a token row only for a real account, a difference of a
database write. The server does not send a verification email on sign-up;
an address becomes verified by a reset, a sign-in link, or a provider that
vouches for it.

## 6. Provider sign-in

Generic by construction — no provider is named anywhere in the code. An
**OpenID Connect** provider is configured by its issuer; discovery supplies
the endpoints and keys, and the discovery document's `issuer` must equal the
configured one. A **plain OAuth 2** provider is configured by three URLs; its
profile's email counts as verified only if `VERIFIED_FIELD` is present and
`true`, so a provider that does not say never links to an existing account.
The token endpoint is called with `client_secret_post`.

Every call to a provider (discovery, keys, token, profile) is bounded twice:
it must finish within 10 s (`FETCH_TIMEOUT_MS`), and its answer may hold at
most 256 KB (`BODY_LIMIT_BYTES`). Those documents are a few kilobytes, so a
larger one is hostile: the read stops at the cap, the connection is dropped,
and the sign-in fails like any other provider failure, without buffering the
rest. An answer with an error status fails at its status: its body is
cancelled unread, so the connection closes at once instead of staying open,
and filling, until the response is collected (`security.test.ts`, a 404, 500
and 503 each with a 10 MB body).

## 7. Email

`email smtp` uses the SMTP library (TLS required on the wire — port 465, or
STARTTLS — except to a loopback relay for development). `email api` posts
`{ from, to, subject, text }` as JSON with `Authorization: Bearer <key>` to
`AZ_EMAIL_API_URL`; any service that accepts that shape, or a small relay in
front of one, works. Messages are plain text containing only the link the
server made.

A send never waits on the mail service without bound. The API post must
finish within 10 s (`EMAIL_TIMEOUT_MS`). Over SMTP, each stage (DNS, connect,
greeting, a silent socket) gets the same 10 s, and the whole send at most
30 s (`EMAIL_DEADLINE_MS`): the stage bounds fire only on silence, so a server
that answers a byte at a time would otherwise hold the send for hours. At the
deadline that send's connection is destroyed. Sends run after the request is
answered, so a slow service never delays a visitor; a failed send is logged
by its error class only (`TimeoutError` for the API or whole-send deadline,
`Error ETIMEDOUT` for an SMTP stage), never the address or the server's
reply.

Both TLS paths are tested end to end over that socket
(`packages/backend/test/email-tls.test.ts`): a local SMTP server with a
certificate made at test time speaks implicit TLS and STARTTLS; the message
and the sign-in go only over TLS, a server that drips a byte at a time after
the handshake fails the send at the deadline with its connection closed, and
an untrusted certificate or a server offering no STARTTLS fails the send with
nothing sent in the clear. The certificate is always verified; the test
names the one it trusts (`createMailer`'s `tls`, a test seam like its
timeouts).

## 8. What `az build` writes

For a site with `backend`, beside the site:

```
server/
  package.json        exact pins, only the drivers the setup uses (and the image library only with an image field); "start": "node src/main.ts"
  az.config.json      site name and the two choices — no secrets
  .env.example        §4
  .gitignore          .env, data/, node_modules/
  README.md           the runbook: local run, keys, deploy (same site, https, proxy)
  src/*.ts            the server, copied verbatim from packages/backend/src/server
                      (data-*.ts only with tables, chat*.ts only with a chat)
  chat/prompt.txt     with a chat: the fixed instructions the model is given
  chat/context.json   with a chat: the site's public pages as text (protected
                      pages left out, 24 000 characters at most), the chat
                      pages and their `allow`/`limit`, the routes
```

A chat adds one table, `az_chat_usage` (UTC day, input/output tokens,
messages, dropped components — counts only, kept 400 days), created by its
own migration history (`az_chat_migrations`) through the same claim as the
others; a site without a chat never gets it.

Node ≥ 22.18 runs the TypeScript directly. `/health` answers `{"ok":true}`.

## 9. Dependencies

| Package | Version | Licence | Why | Alternative considered |
|---|---|---|---|---|
| `node:sqlite` | Node built-in | — | SQLite with no package or native build | a native SQLite package (needs install scripts) |
| `pg` | 8.23.0 | MIT | the de facto PostgreSQL driver, pure JS | none mature enough |
| `mysql2` | 3.24.4 | MIT | the de facto MySQL driver, pure JS | the older `mysql` (unmaintained) |
| `nodemailer` | 10.0.10 | MIT-0 | mature SMTP client, zero dependencies, handles TLS/STARTTLS/auth | a hand-rolled SMTP client (rejected: security-sensitive) |
| `sharp` | 0.35.5 | Apache-2.0; bundles libvips 8.18.7, **LGPL-3.0-or-later** (dynamically linked, unmodified) | image uploads (data-spec §8): decodes JPEG/PNG/WebP/AVIF under a loader allow-list and re-encodes to WebP without metadata, so a photo's GPS never reaches the disk; prebuilt per platform, ~20 MB installed (19–29 MB measured across macOS, Linux glibc/musl, Windows); installs with `--ignore-scripts` | the same libvips as WebAssembly (measured ~2× slower and ~3× the memory on a 24 MP photo; full-size output failed); a metadata-only stripper (rejected: keeps the uploaded bytes, so polyglots and malformed files pass) — `docs/stack-evaluation.md` §14 |

A generated server installs only what its setup uses — SQLite + API installs
nothing; only a site with an `image` field installs `sharp`. LGPL obligations
for libvips are met by shipping it unmodified as the separate shared library
the package installs, which the operator can replace. `packages/backend/test/emit.test.ts` ties these pins to the versions
the repository tests against.

## 10. Tests

- `pnpm test` — the backend's unit and route tests on SQLite in memory (§5),
  the `backend` keyword's codes, the emitted files, `az backend init`, and
  that a site without `backend` gets no `server/`.
- `pnpm test:backend-db` — the store and routes against real PostgreSQL
  18.6 and MySQL 8.4.11 in containers (needs Docker), image fields included.
- `pnpm test:auth` — the real generated server as its own process, with the
  site's forms in Chromium: sign-up with retype and location, sign-in,
  sign-out, reset from a captured SMTP email, provider sign-in through a
  mock OpenID provider.

## 11. Before going live

1. Build the site with `AZ_PUBLIC_BACKEND_URL` set to the server's https URL.
2. `az backend init <out>/server`, then fill `.env` — or set the same keys in
   your host's secret store.
3. Run it behind TLS on the same site as the pages.
4. For PostgreSQL/MySQL, create the database and user; set
   `AZ_DATABASE_TLS=require` for any off-host database.
5. Register each provider's callback URL:
   `<AZ_BACKEND_PUBLIC_URL>/auth/oauth/<id>/callback`.
6. Have the server reviewed by someone outside the project before real
   accounts depend on it.
