/**
 * The 3D chunk's entry. A site imports this lazily, only after gate.ts has
 * decided the page view gets a renderer — so a page at `static`, or a page
 * with no 3D, never fetches three at all (scene-spec §8).
 */

import { Stage } from './stage.ts';
import type { Start } from './tiers.ts';

/** Create the page's one renderer and hand it every 3D view. */
export function start(doc: Document, from: Start): Stage {
  const stage = new Stage(doc, from);
  stage.mount();
  return stage;
}
