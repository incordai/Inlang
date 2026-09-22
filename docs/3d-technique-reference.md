# 3D technique reference — what actually makes a scene look expensive

**Status** research notes · **Date** 2026-08-21 · Companion to
`hero-block-spec.md` §8, `scene-block-spec.md`, `motion-tiers-spec.md`

Findings from a teardown of one current, well-regarded WebGL marketing scene.
**Technique and parameters only — no third-party source is reproduced here, and
the site is not named** (CONVENTIONS §2).

VERIFIED = read out of a shipped bundle. JUDGEMENT = this document's opinion
about what AZ should do with it.

---

## 1. The headline: the "expensive" look is one material

**VERIFIED.** With every optional toggle at its default, every object in the
reference scene resolves to a single material:

```
MeshPhysicalMaterial
  roughness           0.18
  metalness           0
  clearcoat           1
  clearcoatRoughness  0.08
  envMapIntensity     1.4
```

Plus **one** studio HDRI and **one** shadow map. No glass, no transmission and
no post-processing are on screen by default.

**JUDGEMENT — the most important finding here.** The product-render sheen that
reads as "an agency built this" is a four-number material config, not an
effects pipeline. Four numbers are exactly what a theme token set ships for
free, which is the whole AZ thesis: the ceremony becomes free so the time goes
to the taste (PRD §2).

Related numbers worth keeping:

| Surface | Config |
|---|---|
| Matte organic | `roughness 0.9`, `metalness 0` |
| Foliage (waxy) | `roughness 0.48`, `clearcoat 0.35`, `clearcoatRoughness 0.4`, `DoubleSide` |
| Matte stone | `roughness 0.55`, `envMapIntensity 1` |
| Dark gloss | `roughness 0.16`, `clearcoat 1`, `clearcoatRoughness 0.07`, `envMapIntensity 1.5` |

The pattern: **one clearcoat surface against several matte ones.** Contrast in
*roughness* is what reads as material variety — not colour.

## 2. There is no model, and there are no texture files

**VERIFIED.** No `GLTFLoader`, `DRACOLoader`, `KTX2` or `meshopt` anywhere in
the bundle. The only binary asset is one `.hdr`. Every texture is drawn at
runtime into a canvas: a 512² fluted normal map, a 256² bark map, a 256² leaf
map with a drawn midrib and veins, a 1024² terrazzo of 420 random polygons —
all at `anisotropy 4`.

**JUDGEMENT — this affects `ASSUMPTIONS.md` A8 directly.** A8 assumes the hero
pipeline is "Draco-compress a real product model under 5MB". The highest-end
reference uses no model at all, and procedural geometry has three properties AZ
values more than most projects do:

- **deterministic** — same seed, same mesh, forever: the headline claim (PRD §3)
- **no asset pipeline** — no Draco step, no CDN, no 5MB budget to police
- **no network at build time** — it cannot violate principle 1 by accident

A model is still needed for "your product, on your site". But `scene`, and
`hero 3d` with no `model` prop, should default to procedural.
**Recommend: procedural becomes the default path, the model path becomes
opt-in.** That inverts A8 from load-bearing to optional.

## 3. Growth and reveal as a shader threshold — the core trick

**VERIFIED.** Geometry and instance counts are allocated once and never
resized. Animation is driven by one per-instance float uploaded each frame with
a dynamic usage hint, compared in the fragment shader against layered noise;
where the difference goes negative the fragment is discarded.

The shape of it, in words:

```
coverage = growth·(1 + spread) − noise(domain-warped position)·spread − edgeBias
if (coverage <= threshold) discard
```

Volume comes from a **shell technique**: the same mesh instanced N times
(default **13**), each shell pushed along its normal by `shellIndex/N × height`,
modulated by noise so the surface is lumpy rather than evenly inflated.

**JUDGEMENT.** The single most reusable idea here, and it generalises well past
moss. Any reveal, grow, dissolve, wipe or erode effect is these same three
lines. It costs one float per instance per frame and no geometry work at all,
which is why it survives weak hardware. Strong candidate for how `reveal` is
implemented in 3D contexts.

## 4. Free atmosphere that is not WebGL at all

**VERIFIED**, from the stylesheet and the pre-JS markup:

| Effect | Implementation | Cost |
|---|---|---|
| Background wash | three CSS `radial-gradient`s over a flat colour, behind the canvas | zero |
| Film grain | inline SVG `feTurbulence`, `baseFrequency 0.9`, `numOctaves 2`, `opacity 0.05`, 160² tile, as a `data:` URI | **zero bytes, zero requests** |
| Vignette | `radial-gradient(120% 90% at 50% 40%, transparent 60%, <dark> ~10%)` on a pseudo-element | zero |
| Preloader | inline `<style>` in `<head>`, painted before any JS parses | zero |

**JUDGEMENT.** A meaningful share of the expensive impression is CSS sitting in
front of and behind the canvas, not the render. Grain especially is what stops
a clean render looking like a CG test. All four belong in the theme, not in a
word — and the vignette is exactly the gradient scrim `hero-block-spec.md` §9
already mandates over flat opacity.

## 5. Layering and the DOM/canvas contract

**VERIFIED.** Full-viewport fixed canvas; real DOM text above it; grain
between. The UI layer is `pointer-events: none` so the canvas receives the
pointer, with interactive children re-enabling it.

This is the `hero 3d` model AZ already assumes, confirmed in the wild: **the
headline is DOM, not rendered type** — `hero-block-spec.md` §8's rule that text
must be the LCP element rather than the canvas.

## 6. Performance guards — and the gap AZ should fill

**VERIFIED — present:** DPR clamped to **1.75**; per-frame `delta` clamped to
`0.1` so a stall cannot produce a jump; dynamic usage hints on every
per-frame-written buffer; thorough disposal of every geometry, material and
canvas texture; a stable program-cache key per patched material so the shader
cache does not thrash; the cheapest filtered shadow type; dense instanced
meshes excluded from the shadow pass; zero allocation in the hot loop.

**VERIFIED — absent:** no power-preference hint; **nothing measures frame
rate**; no visibility or tab-hidden pausing; no distance LOD; the 4096² shadow
map is never scaled down.

Quality is one fixed level plus **manual URL escape hatches** — a `?lite`
switch dropping DPR to 0.5, shells 13 → 8, and plant count to 100.

**JUDGEMENT — the most strategically useful finding after §1.** A current,
professionally built, well-regarded scene ships **no adaptive quality at all**.
It hardcodes one level and offers the visitor a query parameter.

That is exactly the gap `motion-tiers-spec.md` fills, and it means AZ's runtime
tier probe is a genuine differentiator rather than a workaround for not owning
a test phone (`ASSUMPTIONS.md` A1, A1b). It also validates the tier vocabulary:
their hand-rolled `?lite` drops precisely what AZ's `lite` tier drops, arrived
at independently.

**One concrete lesson from their gap.** That `?lite` reduces DPR, shells and
instance count — and leaves a 4096² shadow map untouched, which is the single
most expensive fixed cost in the frame. **A tier must bound every expensive
term, not the convenient ones.** AZ's tier ladder should be audited against
that: any cost not on the ladder is a cost the tier cannot control.

## 7. What to take, in priority order

1. **The material numbers in §1** — into `theme-spec.md` as 3D surface tokens.
   Highest value, lowest effort, and it is the look itself.
2. **The CSS atmosphere in §4** — grain, wash, vignette into the theme. Free.
3. **The threshold-discard reveal in §3** — as the 3D implementation of `reveal`.
4. **Procedural-first geometry (§2)** — revisit A8 before M2 commits to a Draco
   pipeline as the default.
5. **The guard list in §6** — delta clamping, dynamic usage hints, program cache
   keys and disposal hygiene are cheap and invisible until absent. Add the ones
   missing from `hero-block-spec.md` §8.

## 8. Open questions

1. Does the shell technique survive the `lite` tier at a useful shell count, or
   does volume need a different approach below `full`? Their `?lite` keeps 8 of
   13, which suggests graceful degradation — unverified for AZ's geometry.
2. A studio HDRI is a binary asset. Can a procedural environment reach the same
   material response, or is the HDRI the one file a 3D theme must ship?
3. Antialiasing on **and** a 1.75 DPR clamp is belt-and-braces; one is likely
   redundant. Worth measuring which to drop first on the tier ladder.
