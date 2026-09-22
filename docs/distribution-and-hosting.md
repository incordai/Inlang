# Distribution, hosting & the viral plan

**Status** draft · Companion to AZ Web PRD v0.2

---

## 1. Three products, usually confused

| | What it is | Who it's for | Marginal cost to you |
|---|---|---|---|
| **CLI** | `npx az` — the real product | devs, studios (PRD §4) | **zero** |
| **Playground** | browser, no install, share by link | everyone; **the marketing engine** | **~zero** |
| **Hosting** | you serve their finished sites | non-technical users | **not zero — see §5** |

The Playground and Hosting get lumped together as "the free web version." They
have completely different cost and risk profiles. **Keep them separate.**

---

## 2. Why AZ can be free where AI generators can't

| | AZ | AI generator |
|---|---|---|
| Cost per generation | €0 | real inference cost, per request |
| Where compute runs | **user's browser** | vendor's GPUs |
| What you must store | a text file, ~2KB | generated project files |
| Repeat generations | free | charged again |
| Marginal cost of virality | ~0 | scales linearly with users |

**This is the whole argument, and it's real.** They meter because generation
costs them money every time. Your compiler is TypeScript — it runs in the
user's browser. A thousand users compiling a thousand times costs you nothing.

Competitors' credit models exist because of inference economics, not greed.
Removing inference removes the reason to meter.

---

## 3. Playground — build this, it's the viral engine

**Architecture: no backend at all.**

- Compiler runs in a **Web Worker** (it's TypeScript already)
- Preview renders in a sandboxed `iframe`
- Output downloadable as a zip, client-side
- Hosted as **static files** — Cloudflare Pages / Netlify free tier

**No accounts. State lives in the URL.**

Compress the `.az` source, base64 it into the URL fragment. That gives you:

- shareable links with zero database — `az.dev/#N4IgLg…`
- no signup friction (the single biggest conversion killer)
- no user data, so no GDPR surface, no breach surface
- **share-by-link is inherently viral** — every shared link is a demo

This is how the TypeScript Playground and Compiler Explorer work. It's proven.

**Critical rule: no file uploads in the Playground.** Ship a fixed set of demo
`.glb` models and images as static assets. Users pick from them; they cannot
upload. This single constraint removes the entire malware/phishing vector — you
cannot be a file host if you accept no files.

**Cost at scale:** static assets on a free tier. A viral spike costs bandwidth
on models you control and could move to R2. Realistically double digits of
euros in a bad month, not thousands.

---

## 4. `az deploy` — the answer to hosting for real projects

```bash
az deploy            # pushes to the user's own Netlify/Vercel/Cloudflare
```

They connect **their** account. They get free hosting, a real domain, their own
analytics. You get zero storage, zero bandwidth, zero abuse liability, and no
server to secure.

"Download old work" is already solved: **the `.az` file is the work.** It's 2KB
of text that belongs in git. Nothing to lose.

For most of the target user base in PRD §4, this is strictly better than you
hosting — they already have accounts and want their own domain.

---

## 5. Hosted tier — if you do it, do it survivably

Real costs, in order of severity. Server bills are the *least* of them.

### 5.1 The phishing problem is specific and serious

**AZ generates login forms.** A free host + a subdomain + a generated `auth`
page is, functionally, a phishing kit with good design. This isn't theoretical;
free static hosts get abused this way constantly.

Non-negotiable mitigations:

- **`auth` blocks disabled on free hosted sites.** Available in CLI and on paid,
  verified accounts only. This one rule removes most of the risk.
- **No custom domains on free.** Custom domains are what make phishing
  convincing; a `something.az.dev` subdomain is much less so.
- **GitHub/Google login required** — no anonymous publishing. Raises the effort
  bar enormously for the low-effort abuse that makes up most of the volume.
- Automated Safe Browsing checks on publish, plus a report button and an actual
  takedown path with a human behind it.

**That human is the real cost.** Budget hours per week, not euros per month.

### 5.2 Bandwidth: 3D is the worst case

A hero with a 3MB `.glb` plus textures is ~4–5MB per uncached visit. One site
hitting the front page of Reddit can move more data in a day than a thousand
idle sites do in a month. Static-host free tiers are generous, but design for
this: hard asset-size caps, mandatory Draco compression, aggressive cache
headers, and a soft bandwidth cap that throttles rather than bills.

### 5.3 What hosting costs you strategically

Standing up a server means auth, user data, backups, uptime, incident response,
and GDPR — **all the security work §2 of the quality-gate doc said you could
skip now applies in full.** You also weaken the air-gapped/offline positioning,
which is the one segment AI tools structurally cannot serve.

### 5.4 If you ship it anyway — minimum viable shape

| Tier | Price | Limits |
|---|---|---|
| Free | €0 | 1 site, `*.az.dev` subdomain, 50MB assets, soft bandwidth cap, **no `auth`**, GitHub login required |
| Paid | one price, ~€8/mo | custom domain, `auth` enabled, higher caps |

**One paid tier, not five.** Pricing complexity is a distraction at this stage.

---

## 6. The viral plan

### What actually spreads

1. **The Playground link.** Someone types words, a 3D site appears in under a
   second, they share the URL. The artifact *is* the ad.
2. **The determinism demo.** Compile twice on camera, byte-identical output. No
   AI demo can do this. It's the most defensible 30 seconds you own.
3. **The price framing.** "Free, unlimited, no credits" lands hard against
   credit-metered tools — but state it as *"no inference cost, so nothing to
   meter,"* not as an attack. The mechanism is more persuasive than the jab.

### The timing rule

**Virality is one-shot.** You get one front page, one launch thread, one wave of
attention. Spend it on a half-finished product and it's gone — the second launch
never performs like the first.

**Do not launch before M5.** Before a real site has shipped, you don't know
whether your 11 blocks are the right 11. Going viral on the wrong ones means
thousands of people forming a first impression of a tool that doesn't quite
work, and you cannot re-launch to those people.

### Sequenced

| When | Do |
|---|---|
| M5 | one real site shipped, grammar frozen |
| M5+ | Playground built (2 weeks — no backend) |
| M5+ | `az deploy` (1 week) |
| **then** | launch: Playground + demo video + the shipped site as proof |
| later | hosted tier **only if** Playground usage shows real demand from non-devs |

---

## 7. The strategic flag

A no-install hosted product targets **non-technical users** — a group PRD §4
explicitly excluded from Phase 1. That exclusion is load-bearing: it's why the
CLI comes first, why word packs are npm packages, why there's no GUI.

Changing it is allowed. **Drifting into it is not.** If AZ becomes a hosted
site builder for non-developers, you're competing with funded companies on
their own ground, and your advantages (determinism, offline, git-diffable) are
things that audience doesn't value.

The version where you win is: **free tools that spread on their own merits, and
a paid path for people who already know why determinism matters.**

---

## 8. Recommendation

1. **Build the Playground.** Cheap, no backend, best marketing asset available.
2. **Ship `az deploy`.** Solves hosting without becoming a host.
3. **Defer the hosted tier** until Playground data shows non-devs want it.
4. **Don't launch before M5.**

If the Playground goes viral, that costs you almost nothing and proves demand.
If hosting goes viral, it costs bandwidth and moderation at exactly the moment
you're least able to handle it. **Make sure the thing designed to spread is the
thing that's free to serve.**
