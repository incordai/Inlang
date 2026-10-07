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
 */

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
