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
  carousel, copy, drawer, dropdown, faq, faqDeepLink, hideShrink, lightbox, navMotion, overlayMotion, play, solid,
} from './behaviours.mjs';

const RUNTIME = fileURLToPath(new URL('../../packages/overlay/src/runtime/', import.meta.url));

const LOGO = (fill) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="16"><rect width="48" height="16" fill="${fill}"/></svg>`)}`;

const NET = '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-property: opacity !important; } }';
const SCRIPT = '<script type="module">import { attach } from "./az/behaviours.js"; attach(document);</script>';

const page = ({ runtime, net }) => `<!doctype html><html lang="en"><head><title>behaviours</title><style>
[hidden]:not([hidden="until-found"]) { display: none !important; }
dialog[data-az-overlay="drawer"] { margin: 0; height: 100%; max-height: 100%; transform: translateX(-100%); transition: transform 120ms; }
dialog[data-az-overlay="drawer"][data-state="open"] { transform: none; transition: transform 240ms; }
.frame { position: sticky; top: 0; min-height: 72px; pointer-events: none; }
nav { position: static; height: 72px; display: flex; align-items: center; gap: 8px; pointer-events: auto; background: transparent; transition: transform 160ms, height 120ms; }
nav > ul { margin: 0; padding: 0; list-style: none; }
nav[data-shrunk="true"] { height: 56px; }
nav[data-retracted="true"] { transform: translateY(-100%); }
nav[data-scrolled="true"] { background: rgb(250, 250, 250); }
[data-az-logo="solid"] { display: none; }
[data-az-logo="solid"][data-scrolled="true"] { display: inline; }
[data-az-logo="top"][data-scrolled="true"] { display: none; }
.group { position: relative; display: inline-block; }
.dd { position: absolute; top: 100%; background: white; }
button { min-width: 44px; min-height: 44px; }
.track { display: flex; overflow-x: auto; width: 400px; margin: 0; padding: 0; list-style: none; }
.track li { flex: 0 0 300px; }
.track img { display: block; width: 300px; height: 100px; }
${net ? NET : ''}
</style></head><body>
<div class="frame"><nav data-az-behaviour="solid" data-az-hide data-az-shrink aria-label="Main">
  <a href="/">Home</a><img data-az-logo="top" alt="" src="${LOGO('#eee')}"><img data-az-logo="solid" alt="" src="${LOGO('#111')}">
  <ul><li class="group" data-az-behaviour="dropdown"><button type="button" aria-expanded="false" aria-controls="g1">Products</button>
    <ul id="g1" class="dd" hidden><li><a href="#a">Shoes</a></li><li><a href="#b">Bags</a></li></ul></li></ul>
  <button type="button" class="az-nav-toggle" aria-controls="az-nav-panel" aria-expanded="false" aria-label="Menu">Menu</button>
  <dialog id="az-nav-panel" data-az-behaviour="dialog" data-az-overlay="drawer" aria-label="Menu">
    <button type="button" data-az-close aria-label="Close menu">Close</button><a href="#one">One</a> <a href="#two">Two</a>
  </dialog>
</nav></div>
<main>
  <ul data-az-behaviour="faq" data-single="false">
    <li><h3 id="faq-first"><button type="button" id="faq-first-btn" aria-expanded="true" aria-controls="faq-first-panel" data-az-disclosure>First question?<span data-az-chevron></span></button></h3>
      <div id="faq-first-panel"><p>The first answer lives here.</p></div></li>
    <li><h3 id="faq-second"><button type="button" id="faq-second-btn" aria-expanded="true" aria-controls="faq-second-panel" data-az-disclosure>Second question?<span data-az-chevron></span></button></h3>
      <div id="faq-second-panel"><p>Returns take thirty days.</p></div></li>
  </ul>
  <section data-az-behaviour="lightbox" aria-label="Gallery">
    <div data-az-behaviour="carousel">
      <ul class="track" data-az-track>
        ${['#a33', '#3a3', '#33a', '#aa3'].map((c, i) => `<li><button type="button" data-az-index="${i}" aria-haspopup="dialog" aria-label="Photo ${i + 1}"><img alt="Photo ${i + 1}" src="${LOGO(c)}"></button></li>`).join('')}
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
</main>
${runtime ? SCRIPT : ''}
</body></html>`;

/** The runtime's modules as browser JavaScript, imports pointed at .js. */
function writeRuntime(dir, { withoutBeforematch = false } = {}) {
  mkdirSync(join(dir, 'az'), { recursive: true });
  for (const f of readdirSync(RUNTIME).filter((n) => n.endsWith('.ts'))) {
    const js = stripTypeScriptTypes(readFileSync(join(RUNTIME, f), 'utf8'))
      .replace(/from '\.\/([a-z-]+)\.ts'/g, "from './$1.js'")
      // The regression faqDeepLink guards against: the reveal handler gone.
      .replace(withoutBeforematch ? /^.*'beforematch'.*$/m : /(?!)/, '');
    writeFileSync(join(dir, 'az', f.replace(/\.ts$/, '.js')), js);
  }
}

export async function behaviourSelfTest(browser, server, dir, expect) {
  const forms = {
    good: { runtime: true, net: true }, none: { runtime: false, net: true }, nonet: { runtime: true, net: false },
    nomatch: { runtime: true, net: true, withoutBeforematch: true },
  };
  for (const [name, form] of Object.entries(forms)) {
    mkdirSync(join(dir, `b-${name}`), { recursive: true });
    writeFileSync(join(dir, `b-${name}`, 'index.html'), page(form));
    writeRuntime(join(dir, `b-${name}`), form);
  }
  const run = async (name, width, check, reducedMotion = 'no-preference') => {
    server.serve(join(dir, `b-${name}`));
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
    const p = await ctx.newPage();
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
}
