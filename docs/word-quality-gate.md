# Word quality gate & security model

**Status** draft · Companion to AZ Web PRD v0.2

Two failure modes, opposite directions:

- **Gate too weak** → contributed words rot the output, and the "tested, no
  boilerplate bugs" claim dies with the first bad word.
- **Gate too heavy** → every word needs a day of manual QA, so words stop
  shipping and the project stalls.

**The gate must be automated. A checklist a human runs is a checklist that gets
skipped at 11pm.** Everything below should run in CI on every pull request.

---

## 1. Definition of done — one word

A word is not done when it renders. It's done when all of this passes:

| # | Check | Automated by |
|---|---|---|
| 1 | Compiles to valid TS, no type errors | `tsc --noEmit` |
| 2 | **Theme lint** — no hex, no off-scale px, no font-family | custom `az lint` |
| 3 | Renders at 390 / 768 / 1440px without overflow | Playwright screenshots |
| 4 | Axe: zero violations | `@axe-core/playwright` |
| 5 | Keyboard: reachable, visible focus, no traps (except modals) | Playwright keyboard run |
| 6 | `prefers-reduced-motion` honoured | Playwright emulation |
| 7 | Both themes, light and dark | visual snapshots |
| 8 | Works combined with `nav` + `footer` | integration fixture |
| 9 | Bundle delta under budget | `size-limit` |
| 10 | Deps pinned exactly, no `^`, no `latest` | manifest lint |
| 11 | Docs page with a live example | file presence check |
| 12 | Declares tested browsers/versions | manifest field |

Item 12 matters more than it looks. **Publish what's tested rather than
claiming it's bug-free** — "Tested: Chrome/Safari/Firefox latest, iOS 17+,
combined with nav and footer" is credible and useful. A blanket guarantee dies
on first contact with a real bug.

---

## 2. The actual security surface

Most web-security advice does not apply here. The web target has no server, no
database, no sessions. **Skip** SQL injection, CSRF, rate limiting, and
penetration testing of the generated marketing site — there's nothing to
penetrate.

The real surface is two places:

### A. Compile time — code running on the developer's machine

| Threat | Severity | Mitigation |
|---|---|---|
| **Word pack = arbitrary code** | **critical** | see §3 |
| Malicious transitive dependency | high | pin exact, commit lockfile, `npm ci`, **`--ignore-scripts`** |
| Path traversal — `model ../../../.ssh/id_rsa` | high | resolve all paths, reject anything outside project root |
| Template injection — a `title` string breaking out of generated JSX | high | escape at emit; never string-concatenate user content into code |
| Typosquatted pack name | medium | curated registry; exact-name resolution |

**`npm install --ignore-scripts` is the single highest-value line here.**
Lifecycle scripts (`postinstall`) are the most common npm attack vector and
almost nothing in this stack legitimately needs them.

### B. Output — the site that ships

| Threat | Severity | Mitigation |
|---|---|---|
| **Secret leaked into the client bundle** | **critical** | see §4 |
| XSS via markdown content pipeline | high | sanitize; strip raw HTML by default, opt-in per file |
| Reverse tabnabbing | medium | `rel="noopener noreferrer"` — already in the button spec |
| No CSP | medium | emit a sane default CSP header/meta |
| Known-vulnerable shipped dep | medium | `npm audit` in CI; block on high/critical |

---

## 3. Word packs are arbitrary code

This is the one that deserves real thought before the registry opens.

A word pack is an npm package whose templates **execute on the user's machine
at compile time**. Installing a community word is equivalent to running a
stranger's script with your permissions. That is not unusual — every ESLint
plugin and Vite plugin is the same — but it must be stated plainly, not
discovered.

**Trust tiers, decided now rather than after an incident:**

| Tier | Source | Review | Marked |
|---|---|---|---|
| `official` | you | full | default, no warning |
| `verified` | contributor, reviewed by you | code review + gate | badge |
| `community` | anyone | automated gate only | **install prints a warning** |

`az add` must show the tier before installing. And `az lint` should run over
pack source, not just output — a pack that reads `process.env`, opens a socket,
or writes outside its own directory should fail the gate automatically.

---

## 4. Secret leakage — the trap most likely to bite

Static site bundlers inline environment variables into the shipped JavaScript.
In Vite, anything prefixed `VITE_` **ends up publicly readable in the browser.**
It is not a secret. Nobody discovers this until it's live.

Get the distinction right in the auth adapters:

| Key | Safe to ship? | Why |
|---|---|---|
| Hosted provider **anon/public** key | **yes** | designed to be public; protected by row-level security |
| Hosted provider **service** key | **never** | bypasses all row-level security. Full database access |
| An auth library's server-side session-signing secret | **never** | server-side only; whoever holds it can mint sessions |
| `AZ_SECRET` (backend adapter) | **never** | signs tokens |

**Three things the compiler should do:**

1. Refuse to build if a variable matching a service-key pattern would be
   inlined. Hard error, not a warning.
2. Grep the produced bundle for high-entropy strings and known key prefixes
   (`sk_`, `service_role`, `-----BEGIN`) and fail on a hit.
3. Document per adapter which key goes where — because "use the anon key, never
   the service key" is the one sentence that prevents the worst outcome.

Row-level security is the actual protection for a static site with a hosted
provider. If
someone ships with RLS disabled, the anon key exposes everything. **The adapter
docs must say this, and `az doctor` should check it if it can.**

---

## 5. Two commands worth building

```bash
az doctor    # environment: Node version, package manager, known-bad combos,
             # missing lockfile, RLS/adapter config sanity
az audit     # output: bundle secret scan, npm audit, CSP presence,
             # axe pass over the built site
```

`az doctor` converts a whole category of "it's broken on my machine" support
burden into a self-service answer. Cheap to build, disproportionate payoff once
other people use this.

### 5.1 Install policy — three tiers

`az doctor` should **detect everything and install almost nothing.** The line
is whether the change is local and reversible:

| Tier | Examples | Policy |
|---|---|---|
| **1 — auto, no prompt** | project npm deps into `node_modules` | install. Sandboxed to the project, deletable, no permissions needed |
| **2 — prompt first** | word packs, Playwright browsers, dev TLS cert | ask, then install locally. Never in a non-interactive session |
| **3 — never install** | Node itself, pnpm/npm, Rust toolchain, Xcode, Android SDK, system libraries | **detect and instruct only** |

**Tier 3 is the hard rule.** A tool that installs Node globally, edits `PATH`,
or asks for `sudo` is a tool people uninstall. It breaks their other projects,
it can't be cleanly undone, and a *design tool* requesting root is a trust
failure regardless of intent.

Instead, fail with the exact command:

```
az doctor
  ✗ Node 18.12 — AZ needs 20+
    fnm:  fnm install 22 && fnm use 22
    brew: brew install node@22
  ✓ pnpm 9.1
  ✗ No lockfile — run: az add
```

Detection plus a copy-pasteable command solves the same problem with none of
the risk, and the user stays in control of their own machine.

### 5.2 Never prompt in a non-interactive session

A prompt with no TTY is a **hung CI build** — the worst failure mode there is,
because it looks like a crash and burns runner minutes.

- Detect `CI=true` or absence of a TTY → never prompt
- `--yes` to accept Tier 2 automatically, `--no-install` to refuse everything
- Non-interactive with something missing → exit non-zero, print the command
- Exit codes must be meaningful: `0` ok, `1` missing requirement, `2` config error

### 5.3 What `doctor` still cannot fix

Worth stating so the offline claim stays honest:

- **First run needs network.** "Works offline" is true *after* install, not
  before. For the air-gapped users named in the PRD, ship an offline bundle
  (vendored `node_modules` tarball) — otherwise that market is theoretical.
- **Corporate proxy / blocked registry.** Detect and explain; can't route around.
- **Windows path length, line endings, symlink permissions.** Real for a JS
  build tool; `doctor` can warn, `core.autocrlf` guidance helps.
- **Disk space, ARM vs x86 native binaries.**

---

## 6. Sequencing — don't front-load this

| When | Do |
|---|---|
| Now (M1) | path sandboxing, escape-on-emit, exact pins, `--ignore-scripts` |
| M2 | the 12-point gate in CI |
| M4 (auth) | secret-leak detection, adapter key docs |
| M5 | `az doctor`, `az audit` |
| **Before the registry opens** | trust tiers, pack source lint |

The last row is the hard gate. **Everything else can be added incrementally;
trust tiers cannot be retrofitted after a bad pack ships**, because by then
users have already learned that installing packs is safe.

---

## 7. What this does to word velocity

Honest arithmetic: the gate adds roughly **half a day per word** to build the
fixtures and snapshots — on top of the 2–3 days the word itself takes.

That is worth paying, but only because it's automated and reusable. **If any
step needs a human to run it manually, drop that step or automate it.** A gate
that depends on discipline will be skipped exactly when you're tired, which is
exactly when the bad word gets written.
