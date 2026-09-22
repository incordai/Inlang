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
| `title` | string |  |  | ≤ 8 words | the form heading (the page's only `<h1>`) |
| `sub` | string |  |  | ≤ 20 words | one supporting line under the title |
| `methods` | list | `password` / `link` / `oauth` | `password` | max 3, deferred: `oauth` | sign-in methods offered: `password`, `link` (`oauth` is deferred) |
| `redirect` | route |  |  |  | page to go to after success; must be a page of this site |
| `terms` | route |  |  |  | terms page a signup must link to |
| `impl` | path |  |  | .ts, .tsx, site-level | the file implementing the adapter when `adapter custom`; site-level |

Rules: `signup` requires `terms`; `adapter custom` requires `impl`.

## Children

- `alt`: up to 2 alternate links, e.g. "Create an account"

## Accessibility

- A visible `<label for>` on every field; never a placeholder as the label
- Exact `autocomplete` tokens per field (§6 table)
- Errors tied by `aria-describedby`, an error summary that takes focus; the submit button is never disabled
- One `<h1>` per auth page, 44×44px targets, a visible focus ring

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- `impl`

Known gaps:

- `impl` is validated but not yet imported into the build (ROADMAP M4)
- No submit handler, session hook, protected route or adapter packages yet (M4); the form carries `data-adapter`, `data-methods` and `data-redirect` for that runtime
- The email field uses `autocomplete="email"`; spec §6 says `username`
- Phone and tablet layouts from the spec's responsive table are not implemented for any word yet: the web target emits inline styles only, with no media queries.

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `auth-props.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Not yet tested:** no browser, visual, keyboard or axe run has been made for this word (quality-gate items 3–7). The manifest's `tested` field lists browsers, but those runs have not happened; treat it as a target, not a result.
