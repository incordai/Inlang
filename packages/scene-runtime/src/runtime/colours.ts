/**
 * @az runtime colours
 * Purpose: theme colours for WebGL, read live and repainted on scheme change.
 * Spec: docs/theme-spec.md §3.4
 * Exports: value, hex, onSchemeChange
 * Edit guide: the only place a literal colour reaches WebGL; CSS never uses it.
 * Tests: scripts/test-3d.mjs
 */

/**
 * Theme colours for WebGL — theme-spec §3.4.
 *
 * A material cannot read a CSS custom property, so a scene asks for the
 * literal value of a token IN THE ACTIVE SCHEME. The site's theme.css already
 * declares every token per scheme (§3.2), so the active value is whatever the
 * document resolves `--az-color-<name>` to right now — the same value the
 * words' CSS sees. A literal baked in at compile time would be wrong the
 * moment the visitor's scheme changes; this reads it live and says when it
 * changed, so a scene never stays light on a dark page.
 */

/** A colour token's literal value in the active scheme, e.g. `hsl(202 92% 30%)`. */
export function value(doc: Document, token: string): string {
  const raw = doc.defaultView?.getComputedStyle(doc.documentElement)
    .getPropertyValue(`--az-color-${token}`).trim();
  if (!raw) throw new Error(`theme: no colour token '${token}' in this site`);
  return raw;
}

/**
 * The same colour as `#rrggbb`, which three parses. The themes write CSS
 * Colour 4's space-separated `hsl(202 92% 30%)`, and three's parser reads
 * that as white — so the browser's own 2D context normalises it first.
 */
export function hex(doc: Document, token: string): string {
  const ctx = doc.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('theme: no 2D context to resolve a colour');
  ctx.fillStyle = value(doc, token);
  return ctx.fillStyle;
}

/**
 * Call `onChange` whenever the active scheme may have changed: the OS
 * preference, or an explicit `data-scheme` on the root (§3.2's three states).
 * Returns the unsubscribe.
 */
export function onSchemeChange(doc: Document, onChange: () => void): () => void {
  const win = doc.defaultView;
  const query = win?.matchMedia?.('(prefers-color-scheme: dark)');
  query?.addEventListener('change', onChange);
  const observer = win ? new win.MutationObserver(onChange) : null;
  observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-scheme'] });
  return () => {
    query?.removeEventListener('change', onChange);
    observer?.disconnect();
  };
}
