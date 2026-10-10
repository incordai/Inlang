/**
 * Self-test for the behaviour checks: each must FAIL a page without the
 * runtime (or, for motion, without the reduced-motion net) and PASS the same
 * page with the real runtime. The runtime is served from its own source,
 * types stripped by Node itself — no bundler, no second copy.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  billing, carousel, copy, detach, drawer, dropdown, faq, faqDeepLink, hideShrink, lateContent, lightbox, navMotion,
  overlayMotion, play, reveal, revealReduced, sheetDrag, solid, year,
} from './behaviours.mjs';

const RUNTIME = fileURLToPath(new URL('../../packages/overlay/src/runtime/', import.meta.url));

const LOGO = (fill) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="${fill}"/></svg>`)}`;

const NET = '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-property: opacity !important; } }';
const SCRIPT = '<script type="module">import { attach } from "./az/behaviours.js"; window.__azDetach = attach(document);</script>';

/**
 * Content that renders after the page — as a page behind <Protected> does
 * once its session check resolves.
 */
const LATE = `<ul data-az-behaviour="faq" data-single="false" id="late-faq">
  <li><h3 id="late-a"><button type="button" aria-expanded="true" aria-controls="late-a-panel" data-az-disclosure>Late question?</button></h3>
    <div id="late-a-panel"><p>A late answer.</p></div></li>
  <li><h3 id="late-b"><button type="button" aria-expanded="true" aria-controls="late-b-panel" data-az-disclosure>Another late one?</button></h3>
    <div id="late-b-panel"><p>Another late answer.</p></div></li>
</ul>`;
const LATER = `<script>setTimeout(() => document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(LATE)}), 300);</script>`;

/** The carousel track's layout: inline, or in a stylesheet that lands after the runtime. */
const TRACK_CSS = `.track { display: flex; overflow-x: auto; width: 400px; margin: 0; padding: 0; list-style: none; }
.track li { flex: 0 0 300px; }
.track img { display: block; width: 300px; height: 100px; }`;
/**
 * The parts of the page's layout a late stylesheet can carry — each one
 * inline unless the form names it, and then the page is different until the
 * stylesheet applies:
 *   track   the carousel track is a plain list, with nothing to scroll;
 *   nav     the bar is as tall as a 1500px image in it, not 72px;
 *   reveal  a 1200px image pushes the first reveal block below the first
 *           viewport; styled, it is gone, and the block is on screen (with
 *           a long transition, so a block that rises there shows mid-rise).
 */
const LATE_CSS = {
  track: TRACK_CSS,
  nav: 'nav { height: 72px; } .navpad { display: none; }',
  reveal: '.pushdown { display: none; } #reveal-top { transition: opacity 600ms, transform 600ms; }',
};
/** How long a late file is held back: well past the runtime's attach, well inside a check's wait. */
const LATE_DELAY_MS = 300;
/**
 * The late stylesheet linked once the runtime has attached — as one engine
 * runs a site's module script ahead of the stylesheet linked after it. Held
 * back on its way to the page (LATE_DELAY_MS), it still delays `load`, so a
 * check meets the styled page; the runtime first met it unstyled.
 */
const LATE_LINK = '<script type="module">const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "./late.css"; document.head.append(l);</script>';
/**
 * Slides added to the carousel once the runtime has attached and frames have
 * rendered: a module script held back on its way (LATE_DELAY_MS), which
 * `load` waits for. The page starts with one slide, which fits.
 */
const MORE_SLIDES = '<script type="module" src="./more.js"></script>';
const slide = (c, i) => `<li><button type="button" data-az-index="${i}" aria-haspopup="dialog" aria-label="Photo ${i + 1}"><img alt="Photo ${i + 1}" src="${LOGO(c)}"></button></li>`;
const SLIDE_COLOURS = ['#a33', '#3a3', '#33a', '#aa3'];
const MORE_JS = `document.querySelector('[data-az-track]').insertAdjacentHTML('beforeend', ${JSON.stringify(SLIDE_COLOURS.slice(1).map((c, i) => slide(c, i + 1)).join(''))});`;

const page = ({ runtime, net, late = [], more = false }) => `<!doctype html><html lang="en"><head><title>behaviours</title><style>
[hidden]:not([hidden="until-found"]) { display: none !important; }
dialog[data-az-overlay="drawer"] { margin: 0; height: 100%; max-height: 100%; transform: translateX(-100%); transition: transform 120ms; }
dialog[data-az-overlay="drawer"][data-state="open"] { transform: none; transition: transform 240ms; }
.frame { position: sticky; top: 0; min-height: 72px; pointer-events: none; }
nav { position: static;${late.includes('nav') ? '' : ' height: 72px;'} display: flex; align-items: center; gap: 8px; pointer-events: auto; background: transparent; transition: transform 160ms, height 120ms; }
nav > ul { margin: 0; padding: 0; list-style: none; }
nav[data-shrunk="true"] { height: 56px; }
nav[data-retracted="true"] { transform: translateY(-100%); }
nav[data-scrolled="true"] { background: rgb(250, 250, 250); }
[data-az-logo="solid"] { display: none; }
[data-az-logo="solid"][data-scrolled="true"] { display: inline; }
[data-az-logo="top"][data-scrolled="true"] { display: none; }
.group { position: relative; display: inline-block; }
.dd { position: absolute; top: 100%; background: white; opacity: 0; transition: opacity 120ms; }
.dd[data-state="open"] { opacity: 1; transition: opacity 160ms; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
.target { margin-top: 1200px; }
button { min-width: 44px; min-height: 44px; }
${late.includes('track') ? '' : TRACK_CSS}
${net ? NET : ''}
</style></head><body>
<div class="frame"><nav data-az-behaviour="solid" data-az-hide data-az-shrink aria-label="Main">
  <a href="/">Home</a>${late.includes('nav') ? `<img class="navpad" alt="" width="10" height="1500" src="${LOGO('#ccc')}">` : ''}<img data-az-logo="top" alt="" src="${LOGO('#eee')}"><img data-az-logo="solid" alt="" src="${LOGO('#111')}">
  <ul><li class="group" data-az-behaviour="dropdown"><button type="button" aria-expanded="false" aria-controls="g1">Products</button>
    <ul id="g1" class="dd" hidden><li><a href="#a">Shoes</a></li><li><a href="#b">Bags</a></li></ul></li></ul>
  <button type="button" class="az-nav-toggle" aria-controls="az-nav-panel" aria-expanded="false" aria-label="Menu">Menu</button>
  <dialog id="az-nav-panel" data-az-behaviour="dialog" data-az-overlay="drawer" aria-label="Menu">
    <button type="button" data-az-close aria-label="Close menu">Close</button><a href="#one">One</a> <a href="#two">Two</a>
    <p style="height: 200px">A menu with room below its links.</p>
  </dialog>
</nav></div>
<main>
  ${late.includes('reveal') ? `<div class="pushdown"><img alt="" width="10" height="1200" src="${LOGO('#ccc')}"></div>` : ''}<section data-az-reveal="8" id="reveal-top"><p>On screen from the start.</p></section>
  <button type="button" aria-controls="sheet-1" aria-expanded="false">Open the sheet</button>
  <dialog id="sheet-1" data-az-behaviour="dialog" data-az-overlay="sheet" aria-label="Sheet" style="position: fixed; inset: auto 0 0 0; margin: 0; width: 100%; max-width: 100%; height: 300px; border: 0">
    <div data-az-drag aria-hidden="true" style="height: 44px; touch-action: none">grip</div><button type="button" data-az-close>Close</button>
  </dialog>
  <ul data-az-behaviour="faq" data-single="false">
    <li><h3 id="faq-first"><button type="button" id="faq-first-btn" aria-expanded="true" aria-controls="faq-first-panel" data-az-disclosure>First question?<span data-az-chevron></span></button></h3>
      <div id="faq-first-panel"><p>The first answer lives here.</p></div></li>
    <li><h3 id="faq-second"><button type="button" id="faq-second-btn" aria-expanded="true" aria-controls="faq-second-panel" data-az-disclosure>Second question?<span data-az-chevron></span></button></h3>
      <div id="faq-second-panel"><p>Returns take thirty days.</p></div></li>
  </ul>
  <section data-az-behaviour="lightbox" aria-label="Gallery">
    <div data-az-behaviour="carousel">
      <ul class="track" data-az-track>
        ${(more ? SLIDE_COLOURS.slice(0, 1) : SLIDE_COLOURS).map(slide).join('')}
      </ul>
      <div class="az-gallery-controls"><button type="button" data-az-step="-1" aria-disabled="true">Previous image</button><button type="button" data-az-step="1" aria-disabled="false">Next image</button></div>
    </div>
    <dialog data-az-behaviour="dialog" data-az-overlay="popup" aria-label="Gallery, enlarged">
      <p data-az-lightbox-counter aria-live="polite">1 of 4</p><button type="button" data-az-close aria-label="Close">Close</button>
      <figure><img data-az-lightbox-image alt="Photo 1" src="${LOGO('#a33')}"><figcaption data-az-lightbox-caption></figcaption></figure>
      <button type="button" data-az-step="-1" aria-disabled="true">Previous image</button><button type="button" data-az-step="1" aria-disabled="false">Next image</button>
    </dialog>
  </section>
  <button type="button" data-az-behaviour="copy" data-az-target="copy:hello@example.org">Copy the address</button>
  <button type="button" data-az-behaviour="play" aria-haspopup="dialog" aria-expanded="false" data-az-target="video:film">Watch</button><dialog data-az-behaviour="dialog" data-az-overlay="popup" aria-label="Film">
    <button type="button" data-az-close aria-label="Close video">Close</button><video controls preload="none"></video></dialog>
  <section aria-label="Pricing">
    <fieldset data-az-behaviour="billing" data-billing="monthly"><legend>Billing period</legend>
      <label><input type="radio" name="az-billing" value="monthly" checked> Monthly</label>
      <label><input type="radio" name="az-billing" value="annual"> Annual</label></fieldset>
    <p data-monthly="$29" data-annual="$290">$29</p><p data-monthly="$79" data-annual="$790">$79</p>
  </section>
  <h2 class="target" id="one">One</h2>
  <h2 class="target" id="two">Two</h2>
  <section data-az-reveal="8" id="reveal-low"><ul><li data-az-reveal-item style="transition: opacity 240ms, transform 240ms">One</li><li data-az-reveal-item style="transition: opacity 240ms, transform 240ms">Two</li></ul></section>
</main>
<footer><p>© <span data-year="dynamic">2019</span> Aurora</p></footer>
${LATER}
${runtime ? SCRIPT : ''}
${late.length > 0 ? LATE_LINK : ''}
${more ? MORE_SLIDES : ''}
</body></html>`;

/** The runtime's modules as browser JavaScript, imports pointed at .js. */
function writeRuntime(dir, {
  withoutBeforematch = false, withoutReducedGuard = false, withoutDrag = false, withoutSizeWatch = false,
  withoutSlideWatch = false, withoutRestRead = false, withoutPlaceWatch = false,
} = {}) {
  mkdirSync(join(dir, 'az'), { recursive: true });
  for (const f of readdirSync(RUNTIME).filter((n) => n.endsWith('.ts'))) {
    const js = stripTypeScriptTypes(readFileSync(join(RUNTIME, f), 'utf8'))
      .replace(/from '\.\/([a-z-]+)\.ts'/g, "from './$1.js'")
      // The regression faqDeepLink guards against: the reveal handler gone.
      .replace(withoutBeforematch ? /^.*'beforematch'.*$/m : /(?!)/, '')
      // The regression revealReduced guards against: reveal ignoring reduced motion.
      .replace(withoutReducedGuard ? /^.*prefers-reduced-motion: reduce\)'\)\.matches\) return;.*$/m : /(?!)/, '')
      // The regression sheetDrag guards against: the sheet's drag unwired.
      .replace(withoutDrag ? /^.*wireSheetDrag\(ctx, dialog, close\);.*$/m : /(?!)/, '')
      // The regression the late-track carousel guards against: the ends read only on scroll and resize.
      .replace(withoutSizeWatch ? /^.*sizes\?\.observe\(el\);.*$/m : /(?!)/, '')
      // The regression the late-slides carousel guards against: only the slides there at attach watched.
      .replace(withoutSlideWatch ? /^.*slides\.observe\(track, \{ childList: true \}\);.*$/m : /(?!)/, '')
      // The regression the late-nav hide guards against: the bar's height read once, at attach.
      .replace(withoutRestRead ? /^.*if \(!shrunk\) barHeight = .*$/m : /(?!)/, '')
      // The regression the late-reveal guards against: a block's place read once, at attach.
      .replace(withoutPlaceWatch ? /^.*layout\?\.observe\(ctx\.doc\.documentElement\);.*$/m : /(?!)/, '');
    writeFileSync(join(dir, 'az', f.replace(/\.ts$/, '.js')), js);
  }
}

export async function behaviourSelfTest(browser, server, dir, expect) {
  const forms = {
    good: { runtime: true, net: true }, none: { runtime: false, net: true }, nonet: { runtime: true, net: false },
    nomatch: { runtime: true, net: true, withoutBeforematch: true },
    noguard: { runtime: true, net: true, withoutReducedGuard: true },
    nodrag: { runtime: true, net: true, withoutDrag: true },
    latetrack: { runtime: true, net: true, late: ['track'] },
    latenowatch: { runtime: true, net: true, late: ['track'], withoutSizeWatch: true },
    moreslides: { runtime: true, net: true, more: true },
    morenowatch: { runtime: true, net: true, more: true, withoutSlideWatch: true },
    latenav: { runtime: true, net: true, late: ['nav'] },
    latenavonce: { runtime: true, net: true, late: ['nav'], withoutRestRead: true },
    latereveal: { runtime: true, net: true, late: ['reveal'] },
    laterevealonce: { runtime: true, net: true, late: ['reveal'], withoutPlaceWatch: true },
  };
  for (const [name, form] of Object.entries(forms)) {
    mkdirSync(join(dir, `b-${name}`), { recursive: true });
    writeFileSync(join(dir, `b-${name}`, 'index.html'), page(form));
    writeRuntime(join(dir, `b-${name}`), form);
    if (form.late) writeFileSync(join(dir, `b-${name}`, 'late.css'), form.late.map((part) => LATE_CSS[part]).join('\n'));
    if (form.more) writeFileSync(join(dir, `b-${name}`, 'more.js'), MORE_JS);
  }
  const run = async (name, width, check, reducedMotion = 'no-preference') => {
    server.serve(join(dir, `b-${name}`));
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
    const p = await ctx.newPage();
    const held = (route) => new Promise((done) => setTimeout(done, LATE_DELAY_MS)).then(() => route.continue());
    if (forms[name].late) await p.route('**/late.css', held);
    if (forms[name].more) await p.route('**/more.js', held);
    await p.goto(server.url, { waitUntil: 'load' });
    const r = await check(p);
    await ctx.close();
    return r ?? { pass: false, detail: 'the check found nothing to test' };
  };
  for (const [label, check, width] of [
    ['behaviour: drawer', drawer, 390], ['behaviour: dropdown', dropdown, 1440], ['behaviour: solid', solid, 1440],
    ['behaviour: faq', faq, 1440], ['behaviour: copy', copy, 1440], ['behaviour: play', play, 1440],
    ['behaviour: hide and shrink', hideShrink, 1440],
    ['behaviour: carousel', carousel, 1440], ['behaviour: lightbox', lightbox, 1440],
    ['behaviour: billing', billing, 1440], ['behaviour: year', year, 1440],
    ['behaviour: late content', lateContent, 1440], ['behaviour: cleanup with a modal open', detach, 390],
    ['behaviour: reveal', reveal, 1440], ['behaviour: sheet drag', sheetDrag, 390],
  ]) {
    expect(`${label} without the runtime`, await run('none', width, check), false);
    expect(`${label} with the runtime`, await run('good', width, check), true);
  }
  expect('behaviour: overlay motion without the reduced-motion net', await run('nonet', 390, overlayMotion, 'reduce'), false);
  expect('behaviour: overlay motion with it', await run('good', 390, overlayMotion, 'reduce'), true);
  expect('behaviour: faq deep link without the runtime', await run('none', 1440, faqDeepLink), false);
  expect('behaviour: faq deep link without the beforematch reveal', await run('nomatch', 1440, faqDeepLink), false);
  expect('behaviour: faq deep link with the runtime', await run('good', 1440, faqDeepLink), true);
  expect('behaviour: nav motion without the reduced-motion net', await run('nonet', 1440, navMotion, 'reduce'), false);
  expect('behaviour: nav motion with it', await run('good', 1440, navMotion, 'reduce'), true);
  expect('behaviour: sheet drag with the drag unwired', await run('nodrag', 390, sheetDrag), false);
  expect('behaviour: carousel styled after attach, ends read only on scroll and resize', await run('latenowatch', 1440, carousel), false);
  expect('behaviour: carousel styled after attach', await run('latetrack', 1440, carousel), true);
  expect('behaviour: carousel filled after attach, only the first slides watched', await run('morenowatch', 1440, carousel), false);
  expect('behaviour: carousel filled after attach', await run('moreslides', 1440, carousel), true);
  expect('behaviour: hide with the bar styled after attach, its height read once', await run('latenavonce', 1440, hideShrink), false);
  expect('behaviour: hide with the bar styled after attach', await run('latenav', 1440, hideShrink), true);
  expect('behaviour: reveal styled after attach, each place read once', await run('laterevealonce', 1440, reveal), false);
  expect('behaviour: reveal styled after attach', await run('latereveal', 1440, reveal), true);
  expect('behaviour: reveal ignoring reduced motion', await run('noguard', 1440, revealReduced, 'reduce'), false);
  expect('behaviour: reveal under reduced motion', await run('good', 1440, revealReduced, 'reduce'), true);
}
