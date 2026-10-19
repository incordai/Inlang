/**
 * @az runtime chat-templates
 * Purpose: the chat's page shell built at runtime from a theme's generated templates — what an app draws answers into without a build.
 * Spec: docs/chat-block-spec.md §22.3
 * Exports: TemplateNode, ChatTheme, HostImage, buildTemplate, chatShell, hostImages, TEMPLATE_ATTRIBUTE_REFUSED
 * Edit guide: elements and attributes only from a theme module (themes/<name>.ts, generated from the chat word); never an event's
 *   text; an event handler or a style attribute is refused even there; the host's images are the one address written here.
 * Tests: packages/chat-render/test/chat-templates.test.ts, scripts/chat-lib-e2e.mjs
 */

/**
 * An az site's page carries the chat word's shell, pre-rendered, and the
 * page runtime fills copies of its hidden templates (chat-block-spec §5.4).
 * An app has no build: each theme module in themes/ holds the same shell,
 * generated from the chat word by the same compiler a site's build runs
 * (scripts/gen-chat-themes.mjs), and this builds it — element by element,
 * attribute by attribute, text by text node; nothing is ever parsed as
 * markup. The answer view (chat-answer-view.ts) and the panel (chat-panel.ts)
 * then find the templates by the same data attributes a site's runtime does.
 *
 * The one thing an app adds that a site's build makes: its images. A site's
 * build writes each gallery image a card may name as a part; an app hands
 * its own `{ key: { src, alt } }` map, written here onto copies of the row
 * image template — the app's configuration, never an answer's.
 */

/** A template element: its tag, attributes and children; a string is a text node. */
export type TemplateNode = string | { readonly t: string; readonly a?: Readonly<Record<string, string>>; readonly c?: readonly TemplateNode[] };

/** A theme module's content (themes/<name>.ts): its name, and the chat word's shell for it. */
export interface ChatTheme { readonly THEME: string; readonly SHELL: TemplateNode }

/** An image the app lets a card show, by its key (chat-block-spec §20.6): its address and description, and its size when known. */
export interface HostImage { readonly src: string; readonly alt: string; readonly width?: number; readonly height?: number }

/** What a template may never carry, whatever made it: an event handler, or a style (every style is a class). */
export const TEMPLATE_ATTRIBUTE_REFUSED = /^(?:on|style$)/i;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One template node as DOM: its element (in SVG's namespace under an <svg>), its attributes, its children. */
export function buildTemplate(doc: Document, node: TemplateNode, svg = false): Node {
  if (typeof node === 'string') return doc.createTextNode(node);
  const inSvg = svg || node.t === 'svg';
  const el = inSvg ? doc.createElementNS(SVG_NS, node.t) : doc.createElement(node.t);
  for (const [k, v] of Object.entries(node.a ?? {})) {
    if (TEMPLATE_ATTRIBUTE_REFUSED.test(k)) continue;
    el.setAttribute(k, v);
  }
  for (const c of node.c ?? []) el.append(buildTemplate(doc, c, inSvg));
  return el;
}

/**
 * The theme's chat shell inside the renderer's root (`data-az-chat-root`,
 * `data-az-theme`), which its stylesheet (themes/<name>.css) is scoped to.
 * `scheme` pins light or dark; by default the theme's own, or the visitor's
 * preference.
 */
export function chatShell(doc: Document, theme: ChatTheme, scheme: 'light' | 'dark' | null = null): { readonly root: HTMLElement; readonly shell: HTMLElement } {
  const root = doc.createElement('div');
  root.setAttribute('data-az-chat-root', '');
  root.setAttribute('data-az-theme', theme.THEME);
  if (scheme) root.setAttribute('data-scheme', scheme);
  const shell = buildTemplate(doc, theme.SHELL) as HTMLElement;
  root.append(shell);
  return { root, shell };
}

/** A key a card may name: the build's own shape (core chat.ts), lowercase letters, digits and hyphens. */
const IMAGE_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The schemes an app's own image may be served by: its own files, or https — never a script or data a page would run. */
const IMAGE_URL = /^(?:https:\/\/|\/(?!\/)|\.\/)/;

/**
 * The app's images, each a part as a site's build makes them (`asset`, its
 * key): a copy of the shell's row-image template with the app's address and
 * description. A key or an address of another shape is left out. Returns
 * how many were added.
 */
export function hostImages(shell: Element, images: Readonly<Record<string, HostImage>>): number {
  const parts = shell.querySelector('[data-az-chat-parts]');
  const template = [...(parts?.children ?? [])].find((el) => el.getAttribute('data-az-chat-part') === 'row-image');
  const img = template?.firstElementChild;
  if (!parts || !template || !img) return 0;
  let added = 0;
  for (const [key, image] of Object.entries(images)) {
    if (!IMAGE_KEY.test(key) || typeof image.src !== 'string' || !IMAGE_URL.test(image.src) || typeof image.alt !== 'string') continue;
    const part = template.cloneNode(false) as Element;
    part.setAttribute('data-az-chat-part', 'asset');
    part.setAttribute('data-az-chat-asset', key);
    const copy = img.cloneNode(false) as Element;
    copy.setAttribute('src', image.src);
    copy.setAttribute('alt', image.alt);
    if (image.width && image.height) {
      copy.setAttribute('width', String(image.width));
      copy.setAttribute('height', String(image.height));
    }
    part.append(copy);
    parts.append(part);
    added++;
  }
  return added;
}
