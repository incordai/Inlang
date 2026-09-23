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
