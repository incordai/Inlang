# Cloud setup — a managed database and sign-in (Supabase)

az lets a site's owner choose where accounts and data live:

- **Self-hosted** — the built-in backend on your own server, with your own
  SQLite, PostgreSQL or MySQL. See [self-hosting.md](self-hosting.md).
- **Cloud** — a managed project that runs the database and the sign-in
  service for you. This page is that path, written for **Supabase**, whose
  sign-in service is the open-source identity server az's `hosted` adapter
  speaks through its `token-endpoint` profile (auth-block-spec §3.5).

The compiler's code names no provider; the provider is chosen here, in
configuration.

## 1. Create the project

1. Create a project in the Supabase dashboard.
2. In **Project Settings → API**, copy:
   - the **Project URL** (`https://<ref>.supabase.co`);
   - the **anon / public key**.
3. **Never copy the `service_role` key into the site.** It bypasses every
   row-level security policy. The site's build refuses it — by name, and by
   the role inside the token — and fails (auth-block-spec §4); it belongs only
   on a server you control, if anywhere.

## 2. Point the site at it

In the `.az` file:

```
site studio
  auth
    adapter hosted
    profile token-endpoint
    methods password link oauth
    protect /account

page /login
  auth login
    redirect /account
page /signup
  auth signup
    terms /terms
page /reset
  auth reset
```

In the environment the site builds with (a `.env` beside it, or your host's
build settings) — **public values only**:

```
AZ_PUBLIC_AUTH_URL=https://<ref>.supabase.co/auth/v1
AZ_PUBLIC_AUTH_KEY=<the anon key>
```

The URL includes the sign-in service's API path, `/auth/v1`.

## 3. Configure the sign-in service

In **Authentication → URL Configuration**:

- **Site URL**: your site's origin, e.g. `https://www.example.org`.
- **Redirect URLs**: `https://www.example.org/**` — email links and provider
  sign-in return to the page they started from (the login, sign-up and reset
  pages), so the whole origin is allowed. Add `http://localhost:5173/**` for
  local work.

In **Authentication → Providers**:

- **Email** is on by default. Turn **Confirm email** on for production; the
  sign-up form then says "check your inbox", and signing in before confirming
  shows "Confirm your email address first…".
- **Social providers** (for `methods oauth`): enable each one here with the
  client id and secret from that provider's developer console, and give that
  console the callback URL Supabase shows. The site's buttons appear by
  themselves — one "Continue with <name>" per enabled provider — read from the
  service's public settings. No provider name is written anywhere in the site.

**Email**: the default mail sender is for testing only and heavily
rate-limited. For real users, set your own SMTP in **Authentication → SMTP
Settings**. Reset and sign-in-link emails link to the service, which returns
the visitor to your reset or login page.

## 4. Protect the data — row-level security

The anon key is public: anyone can read it from the page. What protects your
tables is **row-level security** on every table the site's key can reach
(auth-block-spec §4.1). `<Protected>` pages only spare a signed-out visitor an
empty screen; they are not security.

## 5. Optional — the cloud database with the built-in backend

If you also run the built-in backend (backend-spec) but want the cloud's
PostgreSQL instead of your own, declare `backend` with `database postgres`
and, in the server's `.env`:

```
AZ_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/postgres
AZ_DATABASE_TLS=require
AZ_DATABASE_CA_FILE=./certs/database-ca.pem   # the root certificate from Database → SSL, if your system does not trust it
```

Use the **connection pooler** string (transaction mode) or the direct one —
both work: the server sends only single, unnamed-statement queries with no
session state (backend-spec §3.1). The database password is a server secret:
it never goes in an `AZ_PUBLIC_` variable, and the site's build refuses one
that does.

This is a separate choice from sign-in: a site uses **one** `auth` adapter —
`hosted` (this page's §2, the cloud's sign-in) or `azbackend` (the built-in
backend's).

## How this was tested

- **Unit** (`packages/auth-runtime/test/token-endpoint.test.ts`): every call's
  request shape and headers, the error mapping, no enumeration, the landing
  from an email link or a provider (fragment and PKCE), refresh, sign-out.
- **Against the real server software, no account needed**:
  `pnpm test:cloud-auth` starts the same open-source identity server the cloud
  runs, pinned in `docs/reference/token-endpoint-server.json`, with its own
  PostgreSQL and a captured mailbox, builds a site with this profile and drives
  it in a browser — sign-up, sign-in, a protected page, sign-out, the
  wrong-password message, reset through the emailed link, a sign-in link, and
  the same answer for an unknown address. It needs Docker, and passes
  (16/16). Running that server yourself instead of the cloud? Allow the
  `apikey` and `authorization` headers across origins in its CORS settings,
  or the browser refuses every call (auth-block-spec §3.5).
- **Not tested here**: a live Supabase project (it needs an account), and the
  social-provider round-trip against a real provider.
