# Overlays — dropdown, popup, sheet, toast

**Status** draft · Companion to the `nav`, `hero` and buttons/sections specs

Six things that look separate and are one system. Same portal, same dismiss
logic, same focus rules, same animation primitives — different position and
different focus policy.

**Build the engine once. The presets are configuration.**

---

## 1. Shared machinery

Every overlay needs all of this. Get it right once:

| Concern | Why it's shared |
|---|---|
| **Portal to root** | an overlay inside `overflow: hidden` gets clipped. Always render at document root |
| **Layer manager** | one modal at a time; Escape closes the *top* layer only |
| **Dismiss** | Escape, click-outside, route change |
| **Focus policy** | trap, return, or none (see matrix) |
| **Scroll policy** | lock, reposition, or ignore |
| **Positioning** | flip when there's no room, shift to stay on screen |
| **Animation** | `transform` + `opacity` only |
| **Reduced motion** | opacity-only or instant, never "slower" |

**Use Floating UI (`@floating-ui/react`) for positioning.** Collision
detection, flipping, shifting and arrow placement are genuinely hard and fully
solved. Hand-rolling `getBoundingClientRect` math is a week you don't get back.

---

## 2. The preset matrix

| Preset | Position | Focus | Scroll | Dismiss | ARIA |
|---|---|---|---|---|---|
| `dropdown` | anchored below trigger | move in, return on close | close on scroll | Esc, outside | `aria-expanded` + `<ul>` |
| `popover` | anchored, richer content | move in, return | reposition | Esc, outside | `role="dialog"` |
| `popup` | centered | **trap** | **lock body** | Esc, outside, X | `role="dialog" aria-modal` |
| `drawer` | edge slide-in | **trap** | **lock body** | Esc, outside, X | `role="dialog" aria-modal` |
| `sheet` | bottom, draggable | **trap** | **lock body** | Esc, drag down, outside | `role="dialog" aria-modal` |
| `tooltip` | anchored, small | **none** | reposition | blur, Esc | `role="tooltip"` |
| `toast` | corner, stacked | **none — never steal** | ignore | timeout, X | `role="status" aria-live="polite"` |

The focus column is the one people get wrong. **A dropdown must not trap
focus** — Tab should leave it and continue down the page. **A modal must trap** —
Tab escaping into the page behind it is the single most common a11y failure in
overlays.

---

## 3. Motion — the "modern slide down"

### Dropdown / popover

```
enter   opacity 0 → 1,  translateY(-6px) → 0
        160ms  cubic-bezier(0.16, 1, 0.3, 1)
exit    opacity 1 → 0,  translateY(-4px)
        120ms  ease-in
```

Three rules that separate good from cheap:

**Never animate `height` or `max-height`.** It forces layout on every frame and
janks on mid-range devices. Animate `opacity` + `translateY`. If you truly need
a reveal, `clip-path: inset()` is GPU-friendly; `height` is not.

**Exit is faster than enter.** ~120ms out vs ~160ms in. Slow dismissals feel
unresponsive — the user has already decided.

**Transform origin follows the flip.** When the dropdown flips above the
trigger, the slide direction must invert (`translateY(+6px)` and
`transform-origin: bottom`). A menu that opens upward while sliding down is the
tell that the animation was bolted on.

### Other presets

| Preset | Enter |
|---|---|
| `popup` | `opacity 0→1`, `scale .96→1`, 200ms. Backdrop fades 150ms, slightly ahead |
| `drawer` | `translateX(-100%)→0`, 240ms ease-out |
| `sheet` | `translateY(100%)→0`, 280ms spring — the one place a spring earns its keep |
| `tooltip` | `opacity` only, 100ms, **with a ~400ms open delay** and ~100ms close delay so it doesn't flicker on pass-through |
| `toast` | slide in from edge, 200ms; auto-dismiss ≥5s, pause on hover |

**Reduced motion:** opacity-only at 100ms, or instant. Not a slower slide.

---

## 4. Syntax

Overlays are **triggered**, not placed. This reuses the button-intent
auto-detection from the buttons spec — no new grammar:

```
hero center
  cta "Watch the film"  video:./film.mp4      → popup, player
  alt "Size guide"      popup:#sizes          → popup by id
  alt "Docs"            https://docs.x.com    → external link, no overlay
```

Nav groups become dropdowns:

```
nav bar
  group "Products" as dropdown
    link "Shoes" /shoes
    link "Bags"  /bags
```

Declared overlay content:

```
popup sizes
  title "Size guide"
  text  ./content/sizes.md
```

---

## 5. Interrupts — the honest section

The timed/exit-intent popup ("subscribe!", "10% off") is a real marketing
request, so it gets a word — with guardrails:

```
interrupt newsletter
  trigger exit          # or: 30s | 50%scroll
  once    30d           # frequency cap, required
```

**What the compiler enforces, because the word is dangerous:**

- `once` is **required**. An uncapped interrupt is hostile and the single
  fastest way to make a beautiful site feel cheap.
- Never fires on first pageview — minimum one prior interaction.
- Never on mobile at `trigger exit` (there is no exit intent on touch; it fires
  on scroll-up and enrages people).
- Never within 5s of page load, ever.
- Suppressed entirely for `prefers-reduced-motion` users? No — but no motion.
- Close button is ≥44px and visible **without scrolling the overlay**.
- Same focus trap and Escape rules as `popup`. An interrupt you can't dismiss
  with a keyboard is an accessibility violation, not a growth tactic.

**Advisory the compiler should print:** interrupts measurably increase bounce
rate. They can be worth it for email capture; they are rarely worth it on a
brand or portfolio site. Google also treats intrusive interstitials as a
ranking negative on mobile.

**Cookie/consent banners are not this.** They have legal requirements (GDPR
requires reject to be as easy as accept) and belong in their own word, or
better, a third-party service. Don't fake compliance in a design tool.

---

## 6. Details that bite

- **iOS body scroll lock** needs `position: fixed` + saved scroll offset,
  restored on close. `overflow: hidden` alone leaks.
- **Return focus to the trigger** on close. Dropping focus to `<body>` sends
  keyboard users back to the top of the page.
- **Close on route change.** Otherwise a modal survives navigation and floats
  over the wrong page.
- **`inert` on background content** while a modal is open — better than
  managing `tabindex` by hand.
- **Nested overlays:** allow at most one level (a `popup` may open a
  `dropdown`). A modal opening a modal is a design smell — error on it.
- **Dropdowns close on scroll; popovers reposition.** Anchored elements
  detaching from their trigger during scroll is the classic broken look.
- **Nav dropdowns are not `role="menu"`.** That role is for application command
  menus and changes keyboard expectations. A nav dropdown is a `<button aria-expanded>`
  plus a plain `<ul>` of links. Getting this backwards actively harms screen
  reader users — a common mistake in popular component libraries.
- **Toasts never steal focus.** `aria-live="polite"`, and the auto-dismiss timer
  must pause on hover and on focus.

---

## 7. Scope impact

Presets ride on the engine, so the marginal cost is small — but the engine is
not:

| Item | Est. |
|---|---|
| Overlay engine (portal, layers, focus, dismiss, scroll, Floating UI) | 5–7 days |
| `dropdown` + `popover` presets | 2 days |
| `popup` + `drawer` + `sheet` | 3 days |
| `tooltip` + `toast` | 2 days |
| `interrupt` + guardrails | 2 days |
| **Total** | **~3 weeks** |

**Only `dropdown` belongs in Phase 1**, because `nav group` already implies it.
Build the engine now (you need it regardless), ship the dropdown preset, and
hold the rest for Phase 1.5 alongside Tier A blocks.

`interrupt` is the one to defer longest — it's the least aligned with "beautiful
high-value website," and it's the easiest to add later.

---

## 8. Open questions

1. Is `sheet` a mobile-only preset, or does `drawer` just become `sheet` under
   768px automatically? *(Leaning: automatic — one less decision for the user.)*
2. Does `tooltip` earn a place at all on marketing sites? It's mostly an app
   pattern, and hover-only content is invisible on touch.
3. Should `video:` open a `popup`, or navigate to a dedicated page? Modal video
   is conventional but hurts deep-linking and sharing.
