/**
 * @az runtime scene-gate
 * Purpose: page-load decision: does this page get a renderer at all (signals, forced tier, reduced motion).
 * Spec: docs/motion-tiers-spec.md §2
 * Exports: decide3d, readGateSignals, whenViews
 * Edit guide: three-free, so the decision costs no 3D download.
 * Tests: scripts/test-3d.mjs
 */

/**
 * The page-load decision: does this page view get a renderer at all?
 *
 * The one 3D module a site's entry imports statically, so it is kept small
 * and imports nothing from three. scene-spec §8: at `static` — reduced
 * motion, no WebGL2, Save-Data, or `?az-tier=static` — no renderer is
 * created, no context exists, and the 3D chunk is never fetched.
 */

import { capabilityGate, readForced, startFrom, STATIC_RUNG, type GateSignals, type Start } from './tiers.ts';

/** Read the §2 signals from the browser. A missing signal stays undefined (§2.1). */
export function readGateSignals(win: Window): GateSignals {
  const nav = win.navigator as Navigator & {
    deviceMemory?: number; connection?: { saveData?: boolean };
  };
  const cores = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0
    ? nav.hardwareConcurrency : undefined;
  return {
    reducedMotion: !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    webgl2: contextOk(win, {}),
    accelerated: contextOk(win, { failIfMajorPerformanceCaveat: true }),
    cores,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    saveData: typeof nav.connection?.saveData === 'boolean' ? nav.connection.saveData : undefined,
  };
}

function contextOk(win: Window, attrs: WebGLContextAttributes): boolean {
  try {
    const gl = win.document.createElement('canvas').getContext('webgl2', attrs);
    if (!gl) return false;
    // Released at once: a probe must not hold a live context, since browsers
    // cap simultaneous contexts per page (scene-spec §5).
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** The page's starting rung, or null when it stays at the poster. */
export function decide3d(win: Window): Start | null {
  if (!win.document.querySelector('[data-az-3d]')) return null;
  const start = startFrom(capabilityGate(readGateSignals(win)), readForced(win.location.search));
  return start.rung === STATIC_RUNG ? null : start;
}

/**
 * Run `then` once the page has a 3D view — at once if it has one now, or as
 * soon as one is rendered. A page behind <Protected> renders its content
 * only after the session check, after the entry has already run.
 */
export function whenViews(doc: Document, then: () => void): void {
  if (doc.querySelector('[data-az-3d]')) { then(); return; }
  const win = doc.defaultView;
  if (!win) return;
  const observer = new win.MutationObserver(() => {
    if (!doc.querySelector('[data-az-3d]')) return;
    observer.disconnect();
    then();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
}
