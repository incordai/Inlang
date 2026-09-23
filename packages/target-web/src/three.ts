/**
 * The web target's 3D wiring — scene-spec §5, hero-spec §8.
 *
 * Words describe a 3D view as data (`data-az-3d` and friends); this seeds each
 * view, decides whether the site uses 3D at all, and writes the three things
 * a 3D site needs and a non-3D site must not carry: the dependency, the
 * canvas rule, and an entry that loads the renderer lazily — after the page
 * has painted, and only for a page view the gate lets through. The 3D
 * runtime itself is copied from packages/scene-runtime by the caller.
 */

import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';

/** Where the caller copies the 3D runtime in the generated project. */
export const THREE_DIR = 'src/az3d';

/** The attribute every 3D view carries; its value is the view's kind. */
const VIEW = 'data-az-3d';

/** FNV-1a, 32-bit — the procedural scene's seed (scene-spec §11.1). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Give every 3D view on each page its seed: the site's name, the page and the
 * view's position on it. The same site grows the same scene on every build
 * and every engine (A8b); two views on one page grow different ones.
 */
export function seedViews(
  pages: { route: string; nodes: EmittedNode[] }[], site: string,
): { pages: { route: string; nodes: EmittedNode[] }[]; used: boolean } {
  let used = false;
  const seeded = pages.map((page) => {
    let ordinal = 0;
    const walk = (node: EmittedNode): EmittedNode => {
      const children = node.children?.map((c) => (typeof c === 'string' ? c : walk(c)));
      if (node.attrs?.[VIEW] === undefined) return children ? { ...node, children } : node;
      used = true;
      const seed = String(fnv1a(`${site}|${page.route}|${ordinal++}`));
      return { ...node, attrs: { ...node.attrs, 'data-az-seed': seed }, ...(children ? { children } : {}) };
    };
    return { route: page.route, nodes: page.nodes.map(walk) };
  });
  return { pages: seeded, used };
}

/**
 * The entry of a 3D site. The page renders first and synchronously — its
 * text is the LCP element (hero-spec §8) — then the gate decides whether this
 * page view gets a renderer at all; only if it does is the 3D chunk fetched.
 * A page behind <Protected> renders its views only after the session check,
 * so the gate waits for the first view rather than deciding on an empty page.
 */
export function threeMain(header: string): string {
  return `${header}import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App.tsx";
import { decide3d, whenViews } from "./az3d/gate.ts";
import "./theme.css";
import "./az.css";

const el = document.getElementById("root");
if (!el) throw new Error("root element missing");
const app = <StrictMode><App route={window.location.pathname} /></StrictMode>;
// A built page arrives pre-rendered (az-vite/build.mjs): its markup is already
// in the DOM for the gate to read, and is hydrated. The dev server serves an
// empty root, rendered synchronously so the gate below sees the views.
el.firstElementChild
  ? hydrateRoot(el, app)
  : flushSync(() => createRoot(el).render(app));
whenViews(document, () => {
  const start = decide3d(window);
  if (!start) return;
  import("./az3d/index.ts").then(
    (m) => { m.start(document, start); },
    (error: unknown) => { console.error("3d: the renderer did not load; the posters stay", error); },
  );
});
`;
}

/** The page's one canvas (scene-spec §5, §6.1): fixed, under every block, never in the way. */
export function threeCss(theme: ThemeLike): string {
  return `
/* The page's one 3D canvas (scene-spec §5, §6.1): fixed at the bottom of the
   stack, drawn only inside each view's box, never receiving the pointer. */
.az-3d-canvas { position: fixed; inset: 0; width: 100%; height: 100%; z-index: ${theme.layer.behind}; pointer-events: none; }
`;
}
