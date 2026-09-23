/**
 * The 3D chunk's entry. A site imports this lazily, only after gate.ts has
 * decided the page view gets a renderer — so a page at `static`, or a page
 * with no 3D, never fetches three at all (scene-spec §8).
 */

import { Stage } from './stage.ts';
import type { Start } from './tiers.ts';

/** Create a stage and hand it every 3D view; a failure leaves the posters and says why. */
function create(doc: Document, from: Start): Stage | null {
  try {
    const stage = new Stage(doc, from);
    stage.mount();
    return stage;
  } catch (error) {
    // The stage has released whatever it took; the posters never left.
    console.error('3d: the renderer could not start; the posters stay', error);
    return null;
  }
}

/**
 * Create the page's one renderer and hand it every 3D view. A page leaving
 * for the back/forward cache releases its renderer (`pagehide`); coming back
 * from it (`pageshow`, persisted) starts a new one at the rung it had — the
 * ratchet's evidence is not thrown away, and the promotion is not owed again.
 */
export function start(doc: Document, from: Start): Stage | null {
  let stage = create(doc, from);
  doc.defaultView?.addEventListener('pageshow', (e) => {
    if (!(e as PageTransitionEvent).persisted || !stage || stage.stoppedFor !== 'pagehide') return;
    stage = create(doc, { ...from, rung: stage.lastRung, promotable: false });
  });
  return stage;
}
