# `auth`

Sign-in, sign-up and password-reset forms, built from theme tokens. The word emits the form, labels and wiring hooks; it never implements authentication itself. An adapter, named by role and declared once at site level, owns tokens, sessions and verification.

Full specification: [`docs/auth-block-spec.md`](../../../docs/auth-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora
  auth
    adapter session

page /login
  auth login
    title    "Welcome back"
    sub      "Sign in to see your orders."
    redirect /account
    alt      "Create an account" /signup

page /account

page /signup
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `login` | returning users; where a protected route sends people |
| `signup` | first contact; the only variant that may ask for more than credentials |
| `reset` | request a link, then set the new password |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `glass` | frosted panel over a busy background, with a solid fallback |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `adapter` | enum | `hosted` / `session` / `azbackend` / `custom` |  | required, site-level | which adapter role handles the credentials; site-level, once per site |
| `profile` | enum | `standard` / `token-endpoint` | `standard` | site-level | which protocol a `hosted` provider speaks — the standard one (spec §3.2) or a token endpoint (§3.5, e.g. a managed cloud's sign-in service) |
| `title` | string |  |  | ≤ 8 words | the form heading (the page's only `<h1>`) |
| `sub` | string |  |  | ≤ 20 words | one supporting line under the title |
| `methods` | list | `password` / `link` / `oauth` | `password` | max 3 | sign-in methods offered: `password`, `link`, `oauth` (provider buttons from the backend; needs `azbackend` or `session`, spec §3.4) |
| `redirect` | route |  |  |  | page to go to after success; must be a page of this site |
| `terms` | route |  |  |  | terms page a signup must link to |
| `impl` | path |  |  | .ts, .tsx, site-level | the file implementing the adapter when `adapter custom`; site-level |
| `protect` | list of routes |  |  | site-level; each must be a page | pages that require a signed-in visitor (`<Protected>`) |

Rules: `signup` requires `terms`; `adapter custom` requires `impl`.

## Children

- `alt`: up to 2 alternate links, e.g. "Create an account"

## Accessibility

- A visible `<label for>` on every field; never a placeholder as the label
- Exact `autocomplete` tokens per field (§6 table)
- Errors tied by `aria-describedby`, an error summary that takes focus; the submit button is never disabled
- One `<h1>` per auth page, 44×44px targets, a visible focus ring

The full floor is in the spec.

## Adapters — which key goes where

| `adapter` | Configure | Reaches the browser |
|---|---|---|
| `hosted` | `AZ_PUBLIC_AUTH_URL` (the provider's base URL) and `AZ_PUBLIC_AUTH_KEY` (its **public / anon** key) in `.env` or the environment — the build fails without them. `profile token-endpoint` for a token-endpoint server ([cloud setup](../../../docs/cloud-setup.md)) | the public key only |
| `session` | your own server answering `/api/auth/*` (spec §3.3) and setting an httpOnly cookie | nothing secret |
| `custom` | `impl ./auth/adapter.ts` — a module whose default export implements the adapter interface (spec §3.1) | your choice; the build rules below still apply |
| `azbackend` | the site owner's own backend on its own origin — one public base URL, `AZ_PUBLIC_BACKEND_URL`; protocol in [spec §3.4](../../../docs/auth-block-spec.md) | — |

**Use the public (anon) key here. Never the service key.** A service key
bypasses row-level security and gives full database access; anything the
build inlines is readable by anyone who opens dev tools. So the build refuses
— and there is no flag to turn this off — when:

- an `AZ_PUBLIC_` variable is named like a secret (`…SERVICE…`, `…SECRET…`,
  `…PRIVATE…`) or holds a token whose role is `service_role`/`service`/`admin`;
- the built bundle contains a private-key block, an `sk_`/`rk_` key, the text
  `service_role`, or a long high-entropy string that is not the site's public
  key;
- the `.az` file itself contains a key (AZ1411).

**Row-level security in your backend is what protects your data** — not this
form and not `protect`. A static site cannot protect a page on the server:
`protect` only spares a signed-out visitor an empty page. Every row your
backend's policies let an anonymous or signed-in role read is readable by
anyone, whatever this site shows (spec §4.1).

```
site aurora
  auth
    adapter hosted
    protect /account

page /login
  auth login
    redirect /account
    alt "Create an account" /signup
```

## Status

Every variant renders distinctly, and every form is wired (M4): submit calls
the adapter, errors show in a focused summary and beside their fields, `reset`
switches to its set-new-password form when the link carries a token, and
protected pages show a signed-in bar with sign-out. `pnpm coverage` reports
every property implemented: the site-level `adapter`, `profile`, `impl` and
`protect` are read by the target's auth wiring (`target-web/src/auth.ts`),
not the form's markup, and are counted there.

Known gaps:

- No login has been run against a real hosted provider (needs an account);
  the flows pass against a local mock of the §3.2 protocol. The
  `token-endpoint` profile has its own suite, `pnpm test:cloud-auth`, which
  runs the open-source server software such a provider uses in a local
  container (needs Docker)
- `azbackend` and `methods oauth` are available (protocol: spec §3.4); `signup` asks for name, email, password, its retype and an optional location
- The spec's responsive table is implemented through the style contract (`below`), and each layout change is checked at 390px against 1440px by `pnpm test:visual`

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Also exercising this word (its emitter header's `Tests`): `auth-props.test.ts`, `packages/target-web/test/auth.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML — and proves the build guard fails for a service key in the env (by name and by token role) and for a key pattern in the bundle
- `pnpm test:auth` (in CI) builds a site with login, signup, reset and a protected page, and walks every flow in Chromium against a local mock provider: validation and the focused summary, wrong password, sign-in and `?next`, the session across pages, sign-out, an off-site `next` refused, `email_taken`, and both reset states
- `packages/auth-runtime/test` covers the adapters' requests, error mapping and sessions

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each, and the behaviour checks (menus, dropdowns, disclosures, copy, play, scroll behaviours) run in all three engines. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
