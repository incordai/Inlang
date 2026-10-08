/**
 * Content-Security-Policy violations, caught in a real browser —
 * word-quality-gate §2 B. A policy that blocks what the page needs breaks
 * it silently (a style not applied, a decoder that never starts), and one
 * that is never tested drifts from what the page does.
 *
 * Two channels, because each engine reports through both but neither alone
 * covers everything: the `securitypolicyviolation` event (installed before
 * any page script, and written to the console with a mark so it reaches
 * Node), and the engine's own console error for a blocked load or a
 * blocked script, style or WebAssembly compile — in the page or in one of
 * its workers.
 *
 * The one watch every browser suite uses (test:visual, test:3d, test:auth,
 * test:data, test:cloud-auth): `watchCsp` on a context, or
 * `watchedContext` to make one; `violationControl` proves it fails.
 */

import { closeWithin } from '../lib/bounded.mjs';

/** What the init script prefixes an event with. */
const MARK = 'az-csp-violation';
/** The engines' own wording: "Content Security Policy" (Chromium, WebKit), "Content-Security-Policy" (Firefox), WebKit's "Refused to …". */
const ENGINE = /Content[- ]Security[- ]Policy|^Refused to (?:load|execute|apply|connect|create|compile|evaluate)/i;

/** A console message that reports a violation. */
export const isViolation = (text) => text.startsWith(MARK) || ENGINE.test(text);

/**
 * Watch every page of `ctx` (opened after this call) for violations; each
 * one found is pushed to `sink` as one line, once. Returns the sink.
 */
export async function watchCsp(ctx, sink = []) {
  const seen = new Set(sink);
  const note = (where, text) => {
    if (!isViolation(text)) return;
    const line = `${where}: ${text.split('\n')[0].slice(0, 300)}`;
    if (!seen.has(line)) { seen.add(line); sink.push(line); }
  };
  // Serialised into each page: it can close over nothing, so the mark is spelt out.
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`az-csp-violation: ${e.effectiveDirective} refused ${e.blockedURI || 'inline'} (${e.sourceFile || 'page'}:${e.lineNumber})`);
    });
  });
  ctx.on('console', (m) => note(new URL(m.page()?.url() ?? 'about:blank').pathname, m.text()));
  ctx.on('page', (page) => page.on('worker', (w) => w.on('console', (m) => note(`worker ${w.url().slice(0, 40)}`, m.text()))));
  return sink;
}

/** The check's result from what a sink collected. */
export const cspResult = (sink) => ({ pass: sink.length === 0, detail: sink.slice(0, 3).join(' | ') });

/**
 * A new context of `browser` (`options` as for `newContext`) whose every
 * page is watched. Violations go to `sinks[engine]` — one list per engine,
 * made on first use — so a suite that drives several browsers fails each
 * engine on its own.
 */
export async function watchedContext(browser, sinks, options = {}) {
  const ctx = await browser.newContext(options);
  const engine = browser.browserType().name();
  sinks[engine] ??= [];
  await watchCsp(ctx, sinks[engine]);
  return ctx;
}

/** A page whose policy refuses its own inline script: a watch must report it. */
const VIOLATING = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'" />
<title>policy control</title></head><body><main><h1>Policy control</h1></main>
<script>document.documentElement.setAttribute('data-az-control', 'ran');</script></body></html>`;

/** Between two looks at a sink for the control's violation. */
const POLL_MS = 50;

/**
 * CONTROL for a suite's watch: in a context made exactly as the suite makes
 * its own (`watchedContext`), open a page at `url` — answered by a route,
 * never fetched — whose policy refuses its inline script. Returns what the
 * watch collected; the load, the wait for a report and the close are each
 * bounded by `ms`. A suite's control fails unless the list is non-empty.
 */
export async function violationControl(browser, url, ms) {
  const sinks = {};
  const ctx = await watchedContext(browser, sinks);
  try {
    const page = await ctx.newPage();
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: VIOLATING }));
    await page.goto(url, { waitUntil: 'load', timeout: ms });
    const sink = sinks[browser.browserType().name()];
    for (const until = Date.now() + ms; sink.length === 0 && Date.now() < until;) {
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
    return [...sink];
  } finally {
    await closeWithin(ctx, ms, 'policy control context.close');
  }
}
