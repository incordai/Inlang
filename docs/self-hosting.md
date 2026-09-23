# Self-hosting — the built-in backend on your own server

az lets a site's owner choose where accounts and data live:

- **Self-hosted** — this page: the backend az generates (backend-spec), on a
  server you run, with the database you choose.
- **Cloud** — a managed project runs the database and sign-in for you. See
  [cloud-setup.md](cloud-setup.md).

Everything below is also described, with its reasons and tests, in
[backend-spec.md](backend-spec.md); this page is the order to do it in.

## 1. Declare it

```
site studio
  auth
    adapter azbackend
  backend
    database postgres        # sqlite | postgres | mysql
    email    smtp            # smtp | api
```

Only choices go in the `.az` file. Addresses, passwords and keys go in the
server's `.env` — the compiler refuses a connection string written here.

## 2. Try it locally first

```
az dev site.az --open
```

Site, backend (SQLite in `.az-dev/`), and a local mailbox for reset and
sign-in emails, with nothing to configure (backend-spec §2a).

## 3. Build

```
AZ_PUBLIC_BACKEND_URL=https://api.example.org az build site.az --out out
```

`out/` is the site (deploy `out/dist/` after `npm install && npm run build`
there, or let your host build it); `out/server/` is the backend.

## 4. Configure the server

```
az backend init out/server
```

writes `out/server/.env` with a fresh session secret (mode `0600`; it never
overwrites an existing one). Fill in the rest — `.env.example` beside it lists
every key the chosen setup reads:

| For | Keys |
|---|---|
| always | `AZ_BACKEND_PUBLIC_URL`, `AZ_ALLOWED_ORIGINS` (the site's exact origin), `AZ_EMAIL_FROM` |
| SQLite | `AZ_SQLITE_PATH` (default `./data/app.db`; keep it on a persistent disk and back it up) |
| PostgreSQL / MySQL | `AZ_DATABASE_URL`, `AZ_DATABASE_TLS=require` off-host, `AZ_DATABASE_CA_FILE` if the host signs with its own certificate |
| SMTP | `AZ_SMTP_HOST`, `AZ_SMTP_PORT`, `AZ_SMTP_USER`, `AZ_SMTP_PASSWORD` |
| email API | `AZ_EMAIL_API_URL`, `AZ_EMAIL_API_KEY` |
| social sign-in | `AZ_OAUTH_PROVIDERS`, then per provider `AZ_OAUTH_<ID>_LABEL`, `_TYPE` (oidc / oauth2), `_ISSUER` or the three URLs, `_CLIENT_ID`, `_CLIENT_SECRET` |

The server checks all of it at start and **refuses to start**, naming every
missing or unsafe key at once. None of these keys ever reaches the site: only
`AZ_PUBLIC_` variables are inlined into a site build, and the build fails if
a server secret is given a public name.

## 5. Choose the database

| Database | When | Notes |
|---|---|---|
| SQLite | one server, modest traffic | a file on the server's disk; nothing else to run |
| PostgreSQL | the data should live on a separate or managed database server, or you already run it | a managed PostgreSQL works too, pooled or direct (backend-spec §3.1) |
| MySQL | you already run it | 8.4 tested |

Migrations run on every start and are safe to repeat.

## 6. Run it

- **Node 22** on the server; in `out/server/`, `npm install` (only the driver
  your setup needs) then `npm start`.
- **Behind TLS**, on the **same site** as the pages (`api.example.org` beside
  `www.example.org`): the session cookie is then `SameSite=Lax`. A different
  site needs `AZ_COOKIE_SAMESITE=none`, which some browsers restrict.
- Behind a reverse proxy you control, set `AZ_TRUST_PROXY=true` so rate limits
  see real client addresses.
- Rate limits are counted per server process, so run a single process for
  now; limits are not yet shared between processes (backend-spec).

## 7. Social sign-in

Create an app in each provider's developer console, register the callback
`<AZ_BACKEND_PUBLIC_URL>/auth/oauth/<id>/callback`, and put its client id and
secret in `.env`. The site shows one "Continue with <label>" per configured
provider; labels come from your `.env`, never from az's code.

## 8. Before real users

Have the server reviewed by someone outside the project before real accounts
depend on it (backend-spec §11).
