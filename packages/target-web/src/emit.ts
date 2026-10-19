/**
 * @az module target-web
 * Purpose: Spec → project files: App, runtime, per-route HTML, pre-render, stylesheet, theme.
 * Spec: docs/ARCHITECTURE.md §4.2
 * Exports: emitProject, emit, PINS, safeAssetPath, escapeHtml, routeOf
 * Edit guide: generated files open with generated() (generated.ts); keep output deterministic (sorted, no timestamps); pins must match stack-evaluation.md.
 * Tests: packages/target-web/test/emit.test.ts, packages/target-web/test/prerender.test.ts, packages/target-web/test/pins.test.ts
 */

/**
 * Web target — Spec to files.
 *
 * ARCHITECTURE.md §4.2. This is the ONLY stage that knows what React, CSS or a
 * canvas is. Everything upstream is target-agnostic, which is what makes a
 * second target possible without touching the compiler.
 *
 * Three rules from CONVENTIONS §6 that this file exists to obey:
 *   - a GENERATED header on every file
 *   - NEVER string-concatenate user content into code — escape at emit
 *   - deterministic: no timestamps, no random ids, stable order
 */

import type { Spec } from '../../core/src/index.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';
import {
  ACCENT_RAMPS, FONT_STACKS, PATTERN_ORIGINS, PATTERN_REFERENCES, PATTERN_SHAPES, patternCss, patternLayers,
  resolve, schemeCss, schemeReferences, THEMES, withAccentPair, withSeries, withChat, gradientCss, GRADIENT_REFERENCES,
  type AccentName, type PatternOrigin, type PatternShape, type Theme,
} from '../../theme/src/index.ts';
import { generated, generatedJson } from './generated.ts';
import { azMd } from './azmd.ts';
import { emitPages, type EmitterMap } from './tree.ts';
import { sanitizeSvg, SvgError } from './svg.ts';
import { markdownToNodes, MarkdownError } from './markdown.ts';
import { compileStyles } from './stylesheet.ts';
import { iconType, pageDescription, type TouchIcon } from './head.ts';
import { uniqueIds } from './ids.ts';
import { COMPONENT_EXT, ICON_FORMATS, blocksFor } from '../../core/src/index.ts';
import { COMPONENT_TAG } from '../../core/src/emit-contract.ts';
import { PUBLIC_ENV_PREFIX } from '../../core/src/index.ts';
import {
  AUTH_DIR, BACKEND_ENV, GUARD_DIR, HOSTED_ENV, authConfig, authCss, authPlan, authReact, guardTs, requiredEnv, type AuthPlan,
} from './auth.ts';
import type { PageNeeds } from './csp.ts';
import { DATA_DIR, dataClient } from './data-client.ts';
import { ADMIN_FILE, ADMIN_VALUES_FILE, adminCss, adminRoutes, adminTsx, adminValuesTs } from './data-admin.ts';
import { ROWS_FILE, fromTables, rowsTsx } from './data-rows.ts';
import { CHAT_FILE, MAP_TILES_ENV, SHARED_ROUTE, chatTsx, mapCss, showsCards, showsMap, usesChat, usesMap, usesSeries, withSharedPage } from './chat.ts';
import { seedViews, THREE_DIR, threeCss, threeMain } from './three.ts';
import { imageSizes, sizeImages } from './image-dims.ts';
import { bytesSource, type ByteSource } from './image-size.ts';
import { srcsetImages, type Resize } from './image-srcset.ts';

/**
 * Where the author's `raw` / `slot` modules go in the generated project.
 * A directory of their own, so an author file can never collide with a
 * generated one (App.tsx, runtime.tsx). The CLI copies them here.
 */
export const USER_DIR = 'src/user';

/**
 * Where the behaviour runtime lives in a generated project. Its source is
 * packages/overlay/src/runtime; the caller copies it here, as it copies the
 * author's components into USER_DIR, because this stage has no filesystem.
 */
export const RUNTIME_DIR = 'src/az';

export interface EmittedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Exact dependency pins for the emitted project.
 *
 * Each is a VERIFIED row of stack-evaluation.md's table (§"Runtime", §"Build").
 * `pins.test.ts` reads that table and fails if these drift from it, so the
 * document and the compiler cannot quietly disagree about what ships.
 */
export const PINS = {
  react: '19.2.8',
  vite: '8.2.2',
  typescript: '7.0.2',
  /** Only a site that uses 3D depends on it (scene-spec §5). */
  three: '0.186.1',
  /**
   * The type declarations a site author's `tsc` needs to check the generated
   * project: React's (the 19.2 line, matching `react`) for every site, and
   * three's (matching `three`) only beside it. Development only; never shipped.
   */
  typesReact: '19.2.18',
  typesReactDom: '19.2.7',
  typesThree: '0.186.0',
  /**
   * Only a site whose chat shows maps depends on these (chat-block-spec
   * §21.4, Q19a): the vector-map renderer (its own types), the tile-archive
   * reader and the basemap style set. Loaded only on its chat pages, by a
   * dynamic import when the first map arrives.
   */
  maplibre: '6.13.0',
  pmtiles: '4.5.0',
  basemaps: '5.7.2',
} as const;

/**
 * A JSX attribute VALUE as an expression: `{"Maria's \u0026 Co"}`.
 *
 * A JSX attribute STRING (`name="…"`) does not process escapes, so any escape
 * written into one reaches the page as text. An expression is JS, where the
 * escapes decode; `<`, `>` and `&` are still spelt as escapes so the source
 * can never close a tag it sits in.
 */
const jsxValue = (value: string) => `{${JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}}`;

/** Text for an HTML document — the <title> is HTML, not JS. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A valid npm package name from the site name: lowercase, URL-safe,
 * hyphen-separated. The emitted package is private and never published, but
 * npm still refuses to install a package whose own name is invalid.
 */
export function packageName(site: string): string {
  const slug = site.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'site' : slug;
}

export class PathEscapeError extends Error {}

/**
 * Resolve an asset path, refusing anything outside the project.
 *
 * VERIFICATION §5's other M1 security test: `model ../../../etc/passwd` must
 * not resolve. Done with pure string logic because `core` and the targets
 * cannot import `node:path` in a browser (ARCHITECTURE §1a).
 */
export function safeAssetPath(raw: string): string {
  const cleaned = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith('/')) {
    throw new PathEscapeError(
      `asset: '${raw}' is an absolute path — assets must live inside the project`,
    );
  }
  const parts: string[] = [];
  for (const seg of cleaned.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        throw new PathEscapeError(
          `asset: '${raw}' points outside the project — assets must live inside it`,
        );
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * The emitted tree, as data.
 *
 * The tree is written into the app as JSON and rendered by the runtime, rather
 * than being turned into JSX source here. Three reasons, in order of weight:
 *
 *   1. React escapes text nodes and attribute values itself. Generating JSX
 *      source means hand-escaping user content into code, which is the
 *      vulnerability CONVENTIONS §6 is about. Data has no escape to get wrong.
 *   2. `style` objects are already React's own shape.
 *   3. App.tsx stays the same size whatever the site does.
 *
 * Keys are SORTED so two builds of one source produce identical bytes.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = o[k];
    return out;
  }, 2)
    // JSON.stringify does NOT escape these, and `</script>` inside the data
    // would terminate a surrounding <script> the moment this app is rendered
    // into an HTML page. U+2028/U+2029 are line terminators in JS and break a
    // string literal outright. All five stay valid JSON and parse back to
    // exactly the same characters — the value is unchanged, only its spelling.
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A node carries one of the given word classes. */
const isWord = (node: EmittedNode | undefined, cls: RegExp) => cls.test(node?.attrs?.class ?? '');

// `az-nav-frame` is the pinned frame a shrinking nav sits in.
const NAV = /(^| )(az-nav|az-nav-frame)( |$)/;
const BACKDROP = /(^| )az-scene--backdrop( |$)/;

/**
 * A page's nodes with its leading nav moved BEFORE <main>. The skip link
 * targets <main>, so the nav must precede it — inside, the skip link skipped
 * nothing (nav-spec §7). A `scene backdrop` the author placed among the
 * leading nodes is named content (scene-spec §9: role="img", its `alt`), so
 * it opens <main> instead of sitting outside every landmark; it is fixed
 * behind the page, so where it sits in the DOM does not move it on screen.
 */
function leadOf(nodes: readonly EmittedNode[]): { lead: number; nodes: EmittedNode[] } {
  let run = 0;
  while (run < nodes.length && (isWord(nodes[run], NAV) || isWord(nodes[run], BACKDROP))) run++;
  const navs = nodes.slice(0, run).filter((n) => isWord(n, NAV));
  const backdrops = nodes.slice(0, run).filter((n) => !isWord(n, NAV));
  return { lead: navs.length, nodes: [...navs, ...backdrops, ...nodes.slice(run)] };
}

/** The run of trailing nodes that sit AFTER </main>: the footer, a landmark only outside <main>. */
function tailOf(nodes: readonly EmittedNode[], lead: number): number {
  let n = 0;
  while (nodes.length - n > lead && isWord(nodes[nodes.length - 1 - n], /(^| )az-footer( |$)/)) n++;
  return n;
}

/** A page as the App carries it: its nodes, and where <main> starts and ends. */
interface LaidOut { route: string; lead: number; tail: number; layout?: 'side'; nodes: EmittedNode[] }

function layOut(page: { route: string; nodes: EmittedNode[] }): LaidOut {
  const { lead, nodes } = leadOf(page.nodes);
  const side = nodes.slice(0, lead).some((n) => isWord(n, /(^| )az-nav--side( |$)/));
  return { route: page.route, lead, tail: tailOf(nodes, lead), ...(side ? { layout: 'side' as const } : {}), nodes };
}

function appTsx(
  spec: Spec, pages: { route: string; nodes: EmittedNode[] }[], modules: string[], theme: ThemeLike,
  plan: AuthPlan | null, admin: readonly string[] = [], rows = false, chat = false,
): string {
  // Identifiers are derived from position, never from the author's path, and
  // the path reaches the source only through JSON.stringify (CONVENTIONS §6).
  // The auth adapter module (`impl`) is imported by the auth config instead.
  const components = modules.filter((m) => m !== plan?.impl);
  const imports = components.map((m, i) => `import U${i} from ${JSON.stringify(`./user/${m}`)};\n`).join('');
  const table = components.map((m, i) => `  ${JSON.stringify(m)}: U${i},\n`).join('');
  // Auth pages only (M4): a site without auth imports none of it. The nav
  // sits before <main>, outside <Protected>, so it shows while the check runs.
  const auth = plan ? `import { AuthRuntime, Protected } from "./az-auth/react.tsx";

/** Pages whose content is wrapped in <Protected>. */
const PROTECT = new Set<string>(${stableJson(plan.protect)});
` : '';
  // The admin pages (data-spec §11): generated routes, not pages of the
  // file, always inside <Protected>. The server checks every request; this
  // only spares a signed-out visitor an empty page.
  const adminImport = plan && admin.length > 0 ? `import { Admin } from "./data/admin.tsx";

/** The generated admin routes (data-spec §11). */
const ADMIN = new Set<string>(${stableJson(admin)});
` : '';
  // `from` blocks (data-spec §10.3): only a site with one imports the runtime that fills them.
  const rowsImport = rows ? `import { RowsRuntime } from "./data/rows.tsx";
` : '';
  // `chat` panels (chat-block-spec §7): only a site with one imports the runtime that runs them.
  const chatImport = chat ? `import { ChatRuntime } from "./chat/runtime.tsx";
` : '';
  const content = plan
    ? `PROTECT.has(page.route)
              ? <Protected lead={null}>{nodes(page, page.lead, page.nodes.length - page.tail)}</Protected>
              : nodes(page, page.lead, page.nodes.length - page.tail)`
    : `nodes(page, page.lead, page.nodes.length - page.tail)`;
  const laidOut = pages.map(layOut);
  return `${generated('every page of the site as data (routes, blocks, styles); rendered by runtime.tsx')}import { Components, Node, NotFound, Page, Site } from "./runtime.tsx";
import type { Custom, EmittedNode } from "./runtime.tsx";
${auth}${adminImport}${rowsImport}${chatImport}${imports}
/**
 * Every page: its nodes, how many lead (nav, before <main>) and how many
 * tail (footer, after </main>), and its layout (nav-spec §10 Q2: \`side\`).
 */
const PAGES: { route: string; lead: number; tail: number; layout?: string; nodes: EmittedNode[] }[] = ${stableJson(laidOut)};

/** A run of a page's nodes, keyed by position so React keeps them apart. */
const nodes = (page: { nodes: EmittedNode[] }, from: number, to: number) =>
  page.nodes.slice(from, to).map((node, i) => <Node key={from + i} node={node} />);

/**
 * The author's own components (raw / slot, PRD §6.6), by source path, and
 * the theme they receive — the same tokens a word reads, colours as
 * var(--az-…) references (theme-spec §3.3).
 */
const CUSTOM: Custom = {
  components: {
${table}  },
  theme: ${stableJson(theme)},
};

/** "/work/" and "/work/index.html" are "/work"; the root stays "/". */
export function routeOf(pathname: string): string {
  // String operations, not a regex: this source sits inside a template
  // literal in the emitter, where regex escapes are easy to lose.
  let path = pathname.endsWith("/index.html") ? pathname.slice(0, -"index.html".length) : pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path === "" ? "/" : path;
}

/** One page of the site: the one whose route matches, or not-found. */
export default function App({ route }: { route: string }) {
  const page = PAGES.find((p) => p.route === routeOf(route));
  return (
    <Components.Provider value={CUSTOM}>
      <Site
        name=${jsxValue(spec.site.name)}
        width=${jsxValue(spec.site.width)}
        theme=${jsxValue(spec.site.theme)}
      >
        {${adminImport ? `ADMIN.has(routeOf(route))
          ? <Page route={routeOf(route)}><Protected lead={null}><Admin route={routeOf(route)} /></Protected></Page>
          : ` : ''}page
          ? <Page route={page.route} layout={page.layout}
              lead={nodes(page, 0, page.lead)} tail={nodes(page, page.nodes.length - page.tail, page.nodes.length)}>
              {${content}}
            </Page>
          : <NotFound />}${plan ? `
        <AuthRuntime />` : ''}${rows ? `
        <RowsRuntime />` : ''}${chat ? `
        <ChatRuntime />` : ''}
      </Site>
    </Components.Provider>
  );
}
`;
}

/**
 * The runtime.
 *
 * A2 measured that shipping generators and shaders in a tested runtime package
 * — and having the emitter pass values — keeps emitted code short while
 * preserving the distinctive look. This is that decision applied: the emitter
 * writes a description, the runtime knows how to render it.
 */
function runtimeTsx(): string {
  return `${generated('renders emitted nodes with React; wires the behaviour runtime')}import { createContext, createElement, useContext, useLayoutEffect, type ComponentType, type ReactNode } from "react";
import { attach } from "./az/behaviours.ts";

export interface EmittedNode {
  tag: string;
  /** Styling arrives as a generated class (az.css); nodes carry no inline style. */
  attrs?: Record<string, string>;
  children?: (EmittedNode | string)[];
}

/** The theme a custom component receives — the token groups a word reads. */
export interface AzTheme {
  color: Record<string, string>;
  shadow: Record<string, string>;
  size: Record<string, number>;
  type: Record<string, string | number>;
  radius: Record<string, number>;
  space: Record<string, number>;
  motion: Record<string, string | number>;
  layer: Record<string, number>;
  breakpoint: Record<string, number>;
  typeSize: Record<string, string>;
}

/** The author's components (raw / slot) and the theme they are given. */
export interface Custom {
  components: Record<string, ComponentType<{ theme: AzTheme }>>;
  theme: AzTheme;
}

export const Components = createContext<Custom | null>(null);

/** One author component, found by the source path its node carries. */
function CustomNode({ src }: { src: string }): ReactNode {
  const custom = useContext(Components);
  const C = custom?.components[src];
  if (!custom || !C) throw new Error("az: component " + JSON.stringify(src) + " was not imported");
  return createElement(C, { theme: custom.theme });
}

/** Elements that must not be given children — doing so throws in React. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "source", "track", "wbr"]);

/**
 * HTML attribute names React spells differently.
 *
 * Emitted nodes carry real HTML names, so a word writes \`for\` and
 * \`autocomplete\` as the spec does. React only honours its own spelling for
 * these; given the HTML one it warns and, for \`for\`, the label is not tied
 * to its input. \`data-*\` and \`aria-*\` pass through unchanged.
 */
const REACT_NAME: Record<string, string> = {
  "accept-charset": "acceptCharset", accesskey: "accessKey", autocapitalize: "autoCapitalize",
  autocomplete: "autoComplete", autofocus: "autoFocus", autoplay: "autoPlay",
  charset: "charSet", class: "className", colspan: "colSpan",
  contenteditable: "contentEditable", crossorigin: "crossOrigin", datetime: "dateTime",
  enctype: "encType", enterkeyhint: "enterKeyHint", fetchpriority: "fetchPriority",
  for: "htmlFor", formaction: "formAction", formenctype: "formEncType",
  formmethod: "formMethod", formnovalidate: "formNoValidate", formtarget: "formTarget",
  "http-equiv": "httpEquiv", inputmode: "inputMode", itemprop: "itemProp",
  maxlength: "maxLength", minlength: "minLength", novalidate: "noValidate",
  playsinline: "playsInline", readonly: "readOnly", referrerpolicy: "referrerPolicy",
  rowspan: "rowSpan", spellcheck: "spellCheck", srcdoc: "srcDoc", srclang: "srcLang",
  srcset: "srcSet", tabindex: "tabIndex", usemap: "useMap",
  // SVG presentation attributes (the action icons): React camel-cases them.
  "clip-rule": "clipRule", "fill-rule": "fillRule", "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin", "stroke-width": "strokeWidth", viewbox: "viewBox",
  // And the rest an inlined icon may carry (feature-spec §7, target-web svg.ts).
  "stroke-miterlimit": "strokeMiterlimit", "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset", "stroke-opacity": "strokeOpacity", "fill-opacity": "fillOpacity",
  "stop-color": "stopColor", "stop-opacity": "stopOpacity", "clip-path": "clipPath", "vector-effect": "vectorEffect",
};

/**
 * HTML state attributes that React treats as CONTROLLED when spelt as HTML.
 *
 * The page is static HTML plus behaviour, so \`checked\` means "checked at
 * first", which is React's \`defaultChecked\`; as \`checked\` React renders a
 * read-only field and warns.
 */
const INITIAL: Record<string, string> = {
  checked: "defaultChecked",
};

/**
 * Render one emitted node.
 *
 * Text arrives as a plain string and React escapes it. Nothing here builds
 * markup by concatenation, so a title containing </script> is inert.
 */
export function Node({ node }: { node: EmittedNode | string }): ReactNode {
  if (typeof node === "string") return node;
  if (node.tag === ${JSON.stringify(COMPONENT_TAG)}) return createElement(CustomNode, { src: node.attrs?.src ?? "" });

  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    props[INITIAL[k] ?? REACT_NAME[k] ?? k] = v;
  }

  if (VOID.has(node.tag)) return createElement(node.tag, props);
  // Text stays text. Wrapping it in a component made a <script>'s JSON-LD a
  // child element rather than the single string React requires there.
  return createElement(node.tag, props,
    ...(node.children ?? []).map((c, i) => typeof c === "string" ? c : createElement(Node, { key: i, node: c })));
}

export function Page(
  { route, layout, lead, tail, children }:
  { route: string; layout?: string; lead?: ReactNode; tail?: ReactNode; children?: ReactNode },
) {
  // The nav (lead) comes before <main> and the footer (tail) after it: the
  // skip link targets <main> (nav-spec §7) and must skip the nav, and a
  // <footer> is the contentinfo landmark only outside <main>. tabIndex -1
  // lets focus land on <main> without adding it to the tab order.
  // \`layout\` is the page layout a \`side\` nav asks for (nav-spec §10 Q2).
  return (
    <div className="az-page" data-route={route} data-layout={layout}>
      {lead}
      <main id="az-content" tabIndex={-1} className="az-main">{children}</main>
      {tail}
    </div>
  );
}

/** A path that is not a page of this site. */
export function NotFound() {
  return (
    <div className="az-page az-not-found" data-route="">
      <main id="az-content" tabIndex={-1} className="az-main">
        <h1>Page not found</h1>
        <p><a href="/">Go to the home page</a></p>
      </main>
    </div>
  );
}

export function Site(
  { name, width, theme, children }:
  { name: string; width: string; theme: string; children?: ReactNode },
) {
  // The behaviour runtime wires what the words marked (data-az-behaviour).
  // A layout effect, so a deep-linked FAQ answer opens before first paint
  // (faq §7.4); it never runs in a server render, so nothing there reaches
  // window. attach returns its own cleanup, so StrictMode's double run is safe.
  // \`data-az-ready\` marks the page hydrated and wired: a pre-rendered page
  // shows its markup before either, and a script or a test that acts on it
  // earlier meets a page whose behaviours are not attached yet.
  useLayoutEffect(() => {
    const detach = attach(document);
    document.documentElement.setAttribute("data-az-ready", "");
    return () => { document.documentElement.removeAttribute("data-az-ready"); detach(); };
  }, []);
  return (
    <div className="az-site" data-site={name} data-width={width}
         data-theme={theme}>
      {children}
    </div>
  );
}
`;
}

/**
 * Emit a runnable project.
 *
 * Files are returned SORTED so two builds write them in the same order —
 * determinism starts with the file list, not just the file contents.
 */
export interface EmitOptions {
  /**
   * The word emitters, injected.
   *
   * Not imported: `deps.test.ts` forbids a target from importing a word
   * (ARCHITECTURE §2). A word missing from the map renders through the
   * fallback, so an unfinished word degrades instead of crashing the build.
   */
  readonly emitters?: EmitterMap;
  /** Overrides the theme named in the source. Used by tests and previews. */
  readonly theme?: Theme;
  /**
   * Reads a project file as text — the CLI's, sandboxed to the project like
   * the assets it copies. Given it, an SVG a word asks to inline is read and
   * sanitised (feature-spec §7); without it (tests, a playground) the word
   * shows the file as an <img>. Null means the file does not exist.
   */
  readonly readText?: (projectPath: string) => string | null;
  /**
   * Reads the start of a project file as bytes, through the same sandbox —
   * enough for an image's header. Given it, every <img> the build ships gets
   * its file's width and height (gallery-spec §7 rule 1); without it the
   * attributes are left off. Null means the file does not exist.
   */
  readonly readBytes?: (projectPath: string) => Uint8Array | null;
  /**
   * Opens a project file for reading anywhere in it, through the same
   * sandbox — for an image's size, which a JPEG may carry megabytes into
   * the file, behind its EXIF and XMP (gallery-spec §7 rule 1). Given it,
   * sizes are read through it; else from readBytes' start of the file.
   * Null means the file does not exist.
   */
  readonly openImage?: (projectPath: string) => ByteSource | null;
  /**
   * Resizes a project image to fixed widths — the CLI's, with its vetted
   * image library. Given it (and openImage or readBytes), an <img> whose
   * word gave a `sizes` gets a srcset (gallery-spec §7 rule 3); without it
   * that `sizes` is removed and the output is exactly as before.
   */
  readonly resize?: Resize;
  /**
   * The home-screen icon for a PNG `site icon` (GRAMMAR §4.4) — the CLI's,
   * through the same resizer. Without it no page declares one.
   */
  readonly touchIcon?: TouchIcon;
}

/**
 * nav-block-spec §5 — "the universal bug": a nav that stays on screen hides
 * every anchor target under itself unless the page scrolls short of it.
 * Written only when some page pins its nav (`sticky`, `hide`, `shrink`).
 * The nav height is ONE variable because hero height, scroll padding and the
 * drawer offset all derive from it (§5); it comes from the theme token.
 */
function pinnedNavCss(spec: Spec, theme: ThemeLike): string {
  const pins = (b: { word: string; modifiers: string[] }) =>
    b.word === 'nav' && b.modifiers.some((m) => m === 'sticky' || m === 'hide' || m === 'shrink');
  const pinned = spec.site.inherited.some(pins) || spec.pages.some((p) => p.blocks.some(pins));
  if (!pinned) return '';
  return `
/* nav-block-spec §5: anchors land below a pinned nav, not under it. */
:root { --az-size-nav: ${theme.size.nav}px; }
html { scroll-padding-top: calc(var(--az-size-nav) + ${theme.space[16]}px); }
`;
}

/**
 * nav-block-spec §4: a `solid` nav sits transparent OVER a full-bleed hero at
 * the top, then turns solid on scroll. In normal flow the hero started below
 * the nav, so the "transparent" bar showed the page background and its light
 * `inverse` logo sat on it. A `full` or 3D hero opening <main> on such a page
 * is pulled up under the nav by the nav's height and reserves that height
 * inside itself — a transparent border, so its own padding and its
 * background (painted under the border) are untouched. The nav's own z-index
 * keeps it above. Other heroes are left alone: §4 says `solid` does nothing
 * without a full or 3D hero.
 */
function solidNavCss(spec: Spec, theme: ThemeLike): string {
  const solid = (b: { word: string; modifiers: string[] }) => b.word === 'nav' && b.modifiers.includes('solid');
  if (!spec.site.inherited.some(solid) && !spec.pages.some((p) => p.blocks.some(solid))) return '';
  return `
/* nav-block-spec §4: a solid nav is transparent over a full or 3D hero. */
:root { --az-size-nav: ${theme.size.nav}px; }
.az-page:has([data-az-behaviour="solid"]) > .az-main > :is(:first-child, .az-scene--backdrop:first-child + *):is(.az-hero--full, [data-az-3d-host]):not(.az-scene--backdrop) {
  margin-top: calc(-1 * var(--az-size-nav));
  border-top: var(--az-size-nav) solid transparent;
}
`;
}

/**
 * PRD §6.1a `site width`: the frame every section aligns to, as the
 * `--az-frame` each section's inset reads (emit-contract `framed`). Every
 * value is a theme token, so a frame follows the theme. `full` has no frame.
 */
function frameCss(theme: ThemeLike): string {
  return `
/* PRD §6.1a: the site frame (site width). Sections inset to it; none states a width. */
.az-site { --az-frame: ${theme.size.container}px; }
.az-site[data-width="full"] { --az-frame: 100%; }
.az-site[data-width="wide"] { --az-frame: ${theme.size.container + 2 * theme.size['gutter-lg']}px; }
.az-site[data-width="narrow"] { --az-frame: ${theme.breakpoint.md}px; }
.az-site[data-width="reading"] { --az-frame: ${theme.size['measure-body']}ch; }
`;
}

/**
 * nav-block-spec §10 Q2, resolved as its recommendation: `side` is a page
 * layout. At and above `breakpoint.sm` the nav is a column of
 * `size.nav-side` and the page's content fills the column beside it;
 * below, the page stacks and the nav is a bar with its drawer (§6).
 * Written only when some page uses \`side\`.
 */
function sideLayoutCss(spec: Spec, theme: ThemeLike): string {
  const isSide = (b: { word: string; variant: string | null }) => b.word === 'nav' && b.variant === 'side';
  if (!spec.site.inherited.some(isSide) && !spec.pages.some((p) => p.blocks.some(isSide))) return '';
  return `
/* nav-block-spec §10 Q2: a side nav is a page layout — content sits beside it. */
.az-page[data-layout="side"] {
  display: grid;
  grid-template-columns: ${theme.size['nav-side']}px minmax(0, 1fr);
  align-items: start;
}
/* The nav column spans the page; <main> and the footer fill the content column. */
.az-page[data-layout="side"] > :first-child { grid-row: 1 / span 2; }
.az-page[data-layout="side"] > :not(:first-child) { grid-column: 2; min-width: 0; }
@media (width < ${theme.breakpoint.sm}px) {
  .az-page[data-layout="side"] { display: block; }
}
`;
}

/** A hue the theme package has a ramp for, or null. */
const hueOf = (hue: string | null | undefined): AccentName | null =>
  hue !== null && hue !== undefined && Object.hasOwn(ACCENT_RAMPS, hue) ? hue as AccentName : null;

/**
 * The theme the site asked for, falling back to the default, with its accent
 * regenerated when `theme accent` names a hue (PRD §6.1a), and the pair
 * tokens added when it names two (theme-spec §13). The compiler has already
 * refused an unknown hue (AZ1418) and a refused pair (AZ1423); the theme
 * package throws rather than ship a step or a gradient under its floor.
 */
function namedTheme(spec: Spec, override?: Theme): Theme {
  const base = override ?? (THEMES as Record<string, Theme>)[spec.site.theme] ?? THEMES.midnight;
  const named = withAccentPair(base, hueOf(spec.site.accent), hueOf(spec.site.accent2));
  // A chat gets the visitor's tint (chat-block-spec §9, theme-spec §16), and one that draws charts the
  // theme's series colours (§20.4); every other site is unchanged.
  const chatted = usesChat(spec) ? withChat(named) : named;
  return usesSeries(spec) ? withSeries(chatted) : chatted;
}

/** Whether the site's theme carries an accent pair — then words get the gradients. */
const isPaired = (named: Theme): boolean => named.color.light.accent2 !== undefined;

/** The site's pattern as CSS, or null for `none` — ink is the accent token (and the second hue's, for a pair). */
function sitePattern(spec: Spec, named: Theme) {
  const shape = (PATTERN_SHAPES as readonly string[]).includes(spec.site.pattern) ? spec.site.pattern as PatternShape : 'none';
  const origin = (PATTERN_ORIGINS as readonly string[]).includes(spec.site.patternOrigin)
    ? spec.site.patternOrigin as PatternOrigin : 'top';
  const color = schemeReferences(named).color;
  return patternLayers(shape, origin, color.accent, isPaired(named) ? color.accent2 ?? null : null);
}

/**
 * `font` roles as type-token overrides — theme-spec §8.1: `display serif`
 * replaces `type.display` with the serif stack. The compiler has already
 * refused unknown roles (AZ1405) and families (AZ1416); anything else here is
 * skipped, never passed through as a raw family name.
 */
function fontOverrides(fonts: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of ['display', 'body', 'mono'] as const) {
    const family = fonts[role];
    if (family && Object.hasOwn(FONT_STACKS, family)) out[role] = FONT_STACKS[family as keyof typeof FONT_STACKS];
  }
  return out;
}

/**
 * What words read. Colour and shadow are `var(--az-…)` references, resolved
 * by the browser per scheme (theme-spec §3.3); every other group is the same
 * in both schemes, so either resolution gives it.
 */
function themeFor(named: Theme, fonts: Readonly<Record<string, string>> = {}, patterned = false): ThemeLike {
  const t = resolve(named, named.defaultScheme ?? 'light');
  const schemed = schemeReferences(named);
  return {
    color: schemed.color as unknown as Record<string, string>,
    size: t.size as unknown as Record<string, number>,
    type: { ...t.type, ...fontOverrides(fonts) } as unknown as Record<string, string | number>,
    radius: t.radius as unknown as Record<string, number>,
    shadow: schemed.shadow as unknown as Record<string, string>,
    space: t.space as unknown as Record<string, number>,
    motion: t.motion as unknown as Record<string, string | number>,
    layer: t.layer as unknown as Record<string, number>,
    breakpoint: t.breakpoint,
    typeSize: t.typeSize as unknown as Record<string, string>,
    // Only a site with a pattern hands words one, so a site without is unchanged.
    ...(patterned ? { pattern: PATTERN_REFERENCES } : {}),
    // Likewise the gradients: only a site whose accent is a pair (theme-spec §13).
    ...(isPaired(named) ? { gradient: GRADIENT_REFERENCES } : {}),
  };
}

/**
 * Where each page's HTML file goes: `/` is index.html, `/work` is
 * work/index.html. Routes come from the author, so each segment is checked
 * the way asset paths are — nothing may climb out of the project.
 */
function htmlFiles(spec: Spec): string[] {
  return [...spec.pages.map((page) => page.route), ...adminOf(spec)].map(htmlFileFor).sort();
}

/**
 * The generated admin routes (data-spec §11): a site with tables has them.
 * Tables need the built-in backend, which needs the azbackend adapter
 * (AZ1507), so <Protected> is always there to wrap them.
 */
function adminOf(spec: Spec): string[] {
  return spec.site.data && authPlan(spec) ? adminRoutes(spec.site.data) : [];
}

/** One route's HTML file — the rule htmlFiles applies, for AZ.md's page map too. */
function htmlFileFor(route: string): string {
  const segments = route.split('/').filter(Boolean);
  if (segments.some((seg) => seg === '..' || seg === '.' || seg.includes('\\'))) {
    throw new PathEscapeError(`route: '${route}' is not a plain path`);
  }
  return segments.length === 0 ? 'index.html' : `${segments.join('/')}/index.html`;
}

/** Vite's multi-page input: entry name to HTML file, in a stable order. */
function htmlEntries(spec: Spec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of htmlFiles(spec)) {
    out[file === 'index.html' ? 'index' : file.replace(/\/index\.html$/, '')] = file;
  }
  return out;
}

/** A page's icon declaration: `site icon`'s URL and media type, and its home-screen icon's URL; null for none. */
interface IconRef { readonly href: string; readonly type: string | null; readonly touch: string | null }

function iconTag(icon: IconRef | null): string {
  if (icon === null) return '<link rel="icon" href="data:," />';
  const touch = icon.touch === null ? '' : `\n    <link rel="apple-touch-icon" href="${escapeHtml(icon.touch)}" />`;
  return `<link rel="icon"${icon.type ? ` type="${escapeHtml(icon.type)}"` : ''} href="${escapeHtml(icon.href)}" />${touch}`;
}

// `lang` is "en": the grammar has no site locale to take it from — `site`
// declares none, and pricing's `locale` formats money, not the page. When
// the site gains one, this is where it lands.
// An admin page (data-spec §11) is kept out of search results and says so in its title.
// `description` is the page's own, else the site's, else its lead copy
// (GRAMMAR §4.4, head.ts); a page with none of them has no tag.
// The icon: `site icon`, its type read from the file (head.ts). Without one
// the page says it has none (an empty data: URL) rather than leave the
// browser to request /favicon.ico — a 404 and a console error on every view.
function indexHtml(spec: Spec, admin = false, description: string | null = null, icon: IconRef | null = null, noindex = admin): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
${noindex ? '    <meta name="robots" content="noindex, nofollow" />\n' : ''}${description ? `    <meta name="description" content="${escapeHtml(description)}" />\n` : ''}    ${iconTag(icon)}
    <title>${admin ? 'Admin · ' : ''}${escapeHtml(spec.site.name)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

/**
 * src/entry-server.tsx — one route's markup, for the build to write into its
 * page (ASSUMPTIONS A6). The same tree main.tsx hydrates, so the browser
 * adopts the markup instead of replacing it.
 */
function entryServer(): string {
  return `${generated('renders one route to HTML at build time, for pre-rendering')}import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import App from "./App.tsx";

export function render(route: string): string {
  return renderToString(<StrictMode><App route={route} /></StrictMode>);
}
`;
}

/**
 * az-vite/build.mjs — the project's build: the client bundle, then a server
 * build of entry-server.tsx, then every page's HTML filled with its route's
 * markup. A page then reads with JavaScript off, and a crawler that does not
 * run it sees the content (ASSUMPTIONS A6). Plain JS, so Node runs it as is.
 *
 * Any React warning while rendering fails the build: a warning here is a
 * page that renders differently from what the browser will hydrate.
 *
 * Each page then gets its Content-Security-Policy (csp.ts, copied beside
 * this file): `needs` is what each page's nodes ask for, keyed by its HTML
 * file; the hashes come from the page as filled. Only the built page gets
 * one — the dev server serves the template, which has none (Vite's dev
 * client injects styles and its own scripts as it goes).
 *
 * Last, every page as written goes through the build guard's own scan
 * (secrets.ts, shipped.ts): the guard ran when the client bundle was
 * written, before the pages held their markup. A key fails the build and
 * removes dist/, as the guard does.
 */
function buildScript(needs: Readonly<Record<string, PageNeeds>>): string {
  return `${generated('the build: client bundle, then every route pre-rendered into dist/ with its policy')}import { build, loadEnv } from "vite";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownDigests, pagePolicy, withPolicy } from "./csp.ts";
import { bundleMessage, siteScanner } from "./secrets.ts";
import { removeOutput, shippedSecrets } from "./shipped.ts";

/** What each page loads beyond its own files (csp.ts PageNeeds), by its file in dist/. */
const NEEDS = ${stableJson(needs)};

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const server = join(root, ".az-ssr");
const logLevel = process.env.AZ_BUILD_LOG ?? "info";

// 1. The client: what the browser loads (vite.config.ts, the build guard).
//    The names of the files it emitted are the build's own (step 4).
const client = [await build({ root, logLevel })].flat();
if (!client.every((o) => Array.isArray(o?.output))) throw new Error("build: the client build returned no bundle to read its file names from");
const emitted = client.flatMap((o) => o.output.map((f) => f.fileName));

// 2. The server entry, bundled for Node. Its own minimal config: it is never
//    shipped, so it needs neither the page inputs nor the bundle guard — but
//    it reads the same public environment the page does.
await build({
  root, logLevel, configFile: false, envPrefix: ${JSON.stringify(PUBLIC_ENV_PREFIX)},
  build: { ssr: "src/entry-server.tsx", outDir: server, emptyOutDir: true },
});

// 3. Every page's HTML, filled with its route's markup, then given its
//    policy: hashes of what it carries inline, origins from the public env.
const { render } = await import(pathToFileURL(join(server, "entry-server.js")).href);
const env = loadEnv("production", root, ${JSON.stringify(PUBLIC_ENV_PREFIX)});
const pages = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "assets" ? [] : pages(join(dir, e.name)))
    : e.name === "index.html" ? [join(dir, e.name)] : []);
const warnings = [];
const written = [];
const report = console.error;
console.error = (...args) => { warnings.push(args.map(String).join(" ")); };
try {
  for (const file of pages(dist)) {
    const path = relative(dist, file).split(sep).join("/");
    const at = path.split("/").slice(0, -1).join("/");
    const route = at === "" ? "/" : "/" + at;
    const html = readFileSync(file, "utf8");
    if (!html.includes('<div id="root"></div>')) throw new Error("prerender: " + route + " has no empty root to fill");
    const page = NEEDS[path];
    if (!page) throw new Error("csp: " + path + " is not a page this site emitted");
    const filled = html.replace('<div id="root"></div>', '<div id="root">' + render(route) + "</div>");
    const text = withPolicy(filled, pagePolicy(page, filled, env));
    writeFileSync(file, text);
    written.push({ path, text });
  }
} finally {
  console.error = report;
  rmSync(server, { recursive: true, force: true });
}

// 4. The build guard's scan over every page as written: the guard ran when
//    the client bundle was written, before any page held its markup, and a
//    server-only render path can put text in a page that no chunk carries.
//    The guard's and az audit's scan (secrets.ts siteScanner): the public
//    values allowed, the names of the files the client build emitted, and in
//    a page the digests its own policy pins for what it carries inline; a
//    hit removes dist/ and fails the build.
const scan = siteScanner(Object.values(env).filter(Boolean), emitted, ownDigests);
const { hits } = await shippedSecrets(written, join(root, "node_modules"), scan);
if (hits.length > 0) {
  const problems = hits.map((h) => bundleMessage(h.path, h.finding, "page"));
  const left = await removeOutput(root, dist);
  if (left !== null) problems.push("auth: " + left + " — delete it before any deploy");
  throw new Error(problems.join("\\n"));
}
if (warnings.length > 0) {
  throw new Error("prerender: React reported while rendering — the page would not match what the browser hydrates:\\n" + warnings.join("\\n"));
}
`;
}

/**
 * What each page loads beyond its own files, by its HTML file — the input
 * to its Content-Security-Policy (csp.ts). From the page's nodes, not its
 * built markup: a page behind <Protected> draws its content only in the
 * browser, so its markup says nothing about it.
 *
 * - every page of a site with auth calls the adapter's origin (the session
 *   check runs on each); `session` is same-origin, and a `custom` adapter
 *   is the author's code, which the build cannot see into: same-origin only;
 * - uploaded images (data-spec §8) come from the backend, on the admin
 *   pages, the pages whose `from` blocks show rows, and the pages with an
 *   author component (`raw`/`slot`), which may show rows through the client;
 * - a 3D model may be compressed, and its decoder is WebAssembly in a worker;
 * - a page whose chat shows maps starts the map library's worker from a
 *   blob: URL (chat-block-spec §21.4.3), and reads a third-party tile
 *   archive's origin only when the build names one.
 */
function pageNeeds(
  spec: Spec, pages: readonly { route: string; nodes: EmittedNode[] }[], admin: readonly string[], dataIcon: boolean, publicChat = false,
): Record<string, PageNeeds> {
  const plan = authPlan(spec);
  // A chat on a backend without accounts reaches it from every page, as an azbackend site's pages do (§19.15).
  const connect = plan?.adapter === 'hosted' ? [HOSTED_ENV[0]] : plan?.adapter === 'azbackend' || publicChat ? [BACKEND_ENV[0]] : [];
  const images = (spec.site.data ?? []).some((t) => t.fields.some((f) => f.type === 'image')) ? [BACKEND_ENV[0]] : [];
  // A `from` block reads rows; a chat showing image cards may show a row's image (chat-block-spec §20.6).
  const reads = new Set(spec.pages.filter((p) => p.blocks.some((b) => b.from) || showsCards(blocksFor(spec, p))).map((p) => p.route));
  const has = (test: (n: EmittedNode) => boolean) => {
    const walk = (n: EmittedNode | string): boolean => typeof n !== 'string' && (test(n) || (n.children ?? []).some(walk));
    return (nodes: readonly EmittedNode[]) => nodes.some(walk);
  };
  const model = has((n) => n.attrs?.['data-az-model'] !== undefined);
  const component = has((n) => n.tag === COMPONENT_TAG);
  const out: Record<string, PageNeeds> = {};
  const maps = new Set(spec.pages.filter((p) => showsMap(blocksFor(spec, p))).map((p) => p.route));
  for (const p of pages) {
    const shows = reads.has(p.route) || component(p.nodes);
    const map = maps.has(p.route);
    out[htmlFileFor(p.route)] = { dataIcon, connect: map ? [...connect, MAP_TILES_ENV] : connect, images: shows ? images : [], decoder: model(p.nodes), map };
  }
  for (const route of admin) out[htmlFileFor(route)] = { dataIcon, connect, images, decoder: false, map: false };
  return out;
}

/**
 * The generated project plus the assets its pages reference.
 *
 * `assets` are project-relative paths (`assets/shoe.webp`), sorted and
 * de-duplicated, for the caller to copy into the project's `public/` — this
 * stage has no filesystem (ARCHITECTURE §1a). The page refers to each one as
 * `/assets/shoe.webp`: root-relative, because a relative URL resolves against
 * the current route and breaks on any page below `/`.
 */
export interface EmittedProject {
  readonly files: EmittedFile[];
  readonly assets: string[];
  /** The author's component modules, project-relative, for the caller to copy into USER_DIR. */
  readonly modules: string[];
  /** The site uses auth: the caller copies the auth runtime into AUTH_DIR (M4). */
  readonly auth: boolean;
  /**
   * A chat on a backend without accounts (chat-block-spec §19.15): no auth
   * runtime, but the build guard checks the backend's address with the
   * `azbackend` adapter's own check — the caller copies BACKEND_URL_FILES of
   * the auth runtime into AUTH_DIR, which the guard imports and no page does.
   */
  readonly backendUrlCheck: boolean;
  /** The site uses 3D: the caller copies the 3D runtime into THREE_DIR (scene-spec §5). */
  readonly three: boolean;
  /**
   * A page has a `from` block (data-spec §10.3): the caller copies the rows
   * runtime (ROWS_RUNTIME_FILES) with the behaviour runtime. Without one it
   * is left out, so such a site's output is exactly what it was before.
   */
  readonly rows: boolean;
  /**
   * A page has a chat panel (chat-block-spec §7): the caller copies the chat
   * runtime (CHAT_RUNTIME_FILES) with the behaviour runtime. Without one it
   * is left out, so such a site's output is exactly what it was before.
   */
  readonly chat: boolean;
  /** A chat shows maps (§21.4): the caller copies the map runtime (MAP_RUNTIME_FILES) too; no other site gets it. */
  readonly map: boolean;
  /** Build-time warnings the emitter found in files it read (text-spec §10), for the caller's report. */
  readonly warnings: string[];
}

export function emit(spec: Spec, options: EmitOptions = {}): EmittedFile[] {
  return emitProject(spec, options).files;
}

export function emitProject(source: Spec, options: EmitOptions = {}): EmittedProject {
  // A chat site's shared-answer page is one more page from here on (chat-block-spec §20.7).
  const spec = withSharedPage(source);
  const named = namedTheme(spec, options.theme);
  const pattern = sitePattern(spec, named);
  const theme = themeFor(named, spec.site.fonts, pattern !== null);
  const used = new Set<string>();
  // Each URL the sandbox handed out → its project path, for sizing images.
  const srcs = new Map<string, string>();
  const asset = (raw: string): string => {
    const path = safeAssetPath(raw);
    used.add(path);
    srcs.set(`/${path}`, path);
    return `/${path}`;
  };
  const modules = new Set<string>();
  const component = (raw: string): string => {
    const path = safeAssetPath(raw);
    // The link stage checks the type too (AZ1410); this is the second gate, so
    // no caller can hand the target a stylesheet or a binary to import.
    if (!COMPONENT_EXT.some((ext) => path.toLowerCase().endsWith(ext))) {
      throw new PathEscapeError(`component: '${raw}' is not a component module — use ${COMPONENT_EXT.join(', ')}`);
    }
    modules.add(path);
    return path;
  };
  const readText = options.readText;
  // Each inlined copy gets its own id namespace, numbered in the fixed walk
  // order, so two icons (or one icon twice) never share an id on a page.
  let icons = 0;
  const inline = readText
    ? (raw: string): EmittedNode => {
        const path = safeAssetPath(raw);
        const source = readText(path);
        if (source === null) throw new SvgError(`icon: '${raw}' does not exist — add the file or fix the path`);
        return sanitizeSvg(source, raw, `az-i${icons++}-`);
      }
    : undefined;
  // text-spec §5: a body file is parsed at build, through the same sandboxed
  // reader, into nodes — never an HTML string. Its §10 warnings travel back
  // to the caller; its errors (a javascript: link) stop the build.
  const warnings: string[] = [];
  const markdown = readText
    ? (raw: string, opts: { readonly titled: boolean }): EmittedNode[] => {
        const path = safeAssetPath(raw);
        const source = readText(path);
        if (source === null) throw new MarkdownError(`text: '${raw}' does not exist — add the file or fix the path`);
        // A file's images and downloads are written relative to the file, as
        // in any markdown; a root path still reaches the sandbox, which refuses it.
        const dir = path.split('/').slice(0, -1).join('/');
        const near = (p: string) => asset(dir && !p.startsWith('/') ? `${dir}/${p}` : p);
        const r = markdownToNodes(source, { file: raw, titled: opts.titled, theme, asset: near });
        warnings.push(...r.warnings);
        return r.nodes;
      }
    : undefined;
  // Each 3D view gets its seed, and the site learns whether it uses 3D at all.
  const seeded = seedViews(emitPages(spec, theme, options.emitters ?? {}, asset, component, inline, markdown), spec.site.name);
  // Every page's styles into one generated sheet (az.css): classes replace
  // inline styles, which is what lets `below` and `states` exist at all.
  // Ids and radio groups unique per page: words name them from their own
  // content, so two blocks of a kind on one page collided (ids.ts).
  // gallery-spec §7 rule 1: each image's size from its header, so the page
  // reserves the box before the file arrives. One read per file.
  // Rule 3: a srcset where a word asked for one and the build resized the file.
  const readBytes = options.readBytes;
  const sizeOf = imageSizes(
    options.openImage ?? (readBytes && ((path: string) => {
      const bytes = readBytes(path);
      return bytes === null ? null : bytesSource(bytes);
    })),
    srcs, warnings);
  const unique = seeded.pages.map((p) => ({
    ...p,
    nodes: uniqueIds(p.nodes.map((n) => srcsetImages(sizeOf ? sizeImages(n, sizeOf) : n, srcs, sizeOf, options.resize))),
  }));
  const styled = compileStyles(
    unique,
    (ps, rewrite) => ps.map((p) => ({ ...p, nodes: p.nodes.map(rewrite) })),
    theme.breakpoint,
  );
  const pages = styled.value;
  const planned = authPlan(spec);
  // A custom adapter is the author's module, so it takes the components'
  // path: sandboxed, type-checked, normalised, copied into USER_DIR.
  const plan = planned && { ...planned, impl: planned.impl ? component(planned.impl) : null };
  const moduleList = [...modules].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  // The admin pages (data-spec §11), only with tables: none of this otherwise.
  const admin = adminOf(spec);
  const adminFiles = new Set(admin.map(htmlFileFor));
  // Each page's description: written for the page, else for the site, else
  // derived from its content — between the nav and the footer.
  const authored = new Map(spec.pages.map((p) => [p.route, p.description ?? spec.site.description ?? null] as const));
  const descriptions = new Map(pages.map((p) => {
    const { lead, tail, nodes } = layOut(p);
    return [htmlFileFor(p.route), authored.get(p.route) ?? pageDescription(nodes.slice(lead, nodes.length - tail))] as const;
  }));
  // The site icon through the asset sandbox — copied like any asset — its
  // type from its bytes, read through the same sandbox. A PNG one may also
  // give the home-screen icon, which only the build's resizer makes.
  const iconPath = spec.site.icon;
  let icon: IconRef | null = null;
  if (iconPath !== undefined) {
    const href = asset(iconPath);
    const type = iconType(iconPath, options.readBytes?.(href.slice(1)));
    const touch = type === ICON_FORMATS.png.type ? options.touchIcon?.(href.slice(1)) ?? null : null;
    icon = { href, type, touch };
  }
  // The tables `from` blocks read (data-spec §10.3); none, and no rows runtime is wired.
  const rowTables = spec.site.data ? fromTables(spec) : [];
  // A chat panel (chat-block-spec §7) talks to the backend core requires for it (AZ1250); on a backend with accounts
  // it reads the auth adapter's session, on one without (every chat allow anyone, §19.15) nobody is signed in.
  const chat = usesChat(spec) && spec.site.backend !== undefined;
  const publicChat = chat && plan === null;
  // A chat that shows maps (§21.4): the map runtime, its three libraries and its popup rules, on this site only.
  const map = chat && usesMap(spec);
  const files: EmittedFile[] = [
    { path: 'src/App.tsx', content: appTsx(spec, pages, moduleList, theme, plan, admin, rowTables.length > 0, chat) },
    // The build guard, for every site (auth-spec §4): nothing may ship a key.
    { path: `${GUARD_DIR}/guard.ts`, content: guardTs(requiredEnv(plan, publicChat), plan?.adapter ?? null, publicChat) },
    ...(plan ? [
      { path: `${AUTH_DIR}/config.ts`, content: authConfig(plan, USER_DIR.replace(/^src\//, '')) },
      { path: `${AUTH_DIR}/react.tsx`, content: authReact() },
    ] : []),
    // The typed data client only with tables (data-spec §7).
    ...(spec.site.data ? [{ path: `${DATA_DIR}/client.ts`, content: dataClient(spec.site.data, chat) }] : []),
    ...(rowTables.length > 0 ? [{ path: ROWS_FILE, content: rowsTsx(rowTables, RUNTIME_DIR) }] : []),
    ...(chat ? [{ path: CHAT_FILE, content: chatTsx(RUNTIME_DIR, map, plan !== null) }] : []),
    ...(spec.site.data && admin.length > 0 ? [
      { path: ADMIN_FILE, content: adminTsx(chat) },
      { path: ADMIN_VALUES_FILE, content: adminValuesTs(spec.site.data) },
    ] : []),
    { path: 'src/runtime.tsx', content: runtimeTsx() },
    { path: 'src/entry-server.tsx', content: entryServer() },
    { path: 'az-vite/build.mjs', content: buildScript(pageNeeds(spec, pages, admin, icon === null, publicChat)) },
    {
      path: 'src/main.tsx',
      content: seeded.used ? threeMain(generated('browser entry: hydrates the page, then loads 3D if a view needs it')) : `${generated('browser entry: hydrates the pre-rendered page')}import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App.tsx";
import "./theme.css";
import "./az.css";

const el = document.getElementById("root");
if (!el) throw new Error("root element missing");
const app = <StrictMode><App route={window.location.pathname} /></StrictMode>;
// A built page arrives pre-rendered (az-vite/build.mjs) and is hydrated; the
// dev server serves an empty root, which is rendered from scratch.
el.firstElementChild
  ? hydrateRoot(el, app)
  : createRoot(el).render(app);
`,
    },
    {
      path: 'src/az.css',
      content: `${generated('every block style as one generated class per element (see AZ.md for the map)')}/* Every word's styles, one class per styled element. Generated from the
   emitted tree: base rules, then breakpoints (widest first), then states,
   then reduced motion — so the more specific condition wins a conflict. */
${styled.css}`,
    },
    {
      path: 'src/theme.css',
      content: `${generated('the reset, the theme colour schemes and page-level rules')}/* A reset, and the theme's colour schemes.
   Every design value — colour, space, type — is emitted by the WORD from a
   theme token (A7). Colours reach words as var(--az-color-…) references;
   the declarations below are what they resolve to, per scheme. Type scales
   lived here once, which meant the stylesheet silently overrode what the
   words computed. */
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; }
/* type.body for every text a word does not style itself (theme-spec §8.1,
   overridable by \`font body …\`). Without it running text fell back to the
   browser's default face. Form controls do not inherit a font on their own. */
body { font-family: ${theme.type.body}; }
button, input, select, textarea { font: inherit; }
.az-page { min-height: 100svh; }
ul, ol { margin: 0; padding: 0; }
img, video, canvas { max-width: 100%; height: auto; display: block; }
a { color: inherit; }

/* \`hidden\` must hide even when a generated class sets display — except
   until-found, which must stay findable (faq §7.3). */
[hidden]:not([hidden="until-found"]) { display: none !important; }
/* A modal overlay's backdrop (overlays-spec §2). */
dialog[data-az-overlay]::backdrop { background: var(--az-color-overlay); }
/* The runtime's polite announcer (copy confirmation): read, never seen. */
.az-live { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Reduced motion — theme-spec §9.3: opacity-only or instant, never "slower".
   The net catches anything a word did not handle itself. !important because
   a generated class outranks a universal selector, and a net that any
   styled element can slip through is not one. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition-property: opacity !important;
    transition-duration: ${theme.motion.reduced}ms !important;
    scroll-behavior: auto !important;
  }
}
@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
}

${frameCss(theme)}${schemeCss(named)}${gradientCss(isPaired(named))}${patternCss(pattern)}${pinnedNavCss(spec, theme)}${solidNavCss(spec, theme)}${sideLayoutCss(spec, theme)}${plan ? authCss(theme) : ''}${admin.length > 0 ? adminCss(theme) : ''}${seeded.used ? threeCss(theme) : ''}${map ? mapCss(theme) : ''}`,
    },
    {
      /**
       * The project's dependencies.
       *
       * Versions are EXACT, never ranges: `^19.2.8` would let two builds of
       * one source resolve differently, which breaks the determinism claim
       * before a single line of AZ is involved. Every pin is a row of
       * stack-evaluation.md's verified table, and a test compares the two.
       *
       * No React plugin. Vite compiles .tsx through esbuild with
       * `jsx: "react-jsx"` (tsconfig below), so the scaffold needs nothing
       * that the verified table does not already cover.
       */
      path: 'package.json',
      content: JSON.stringify({
        _generated: generatedJson("the project's dependencies and scripts"),
        name: packageName(spec.site.name),
        private: true,
        type: 'module',
        // `build` pre-renders every page (az-vite/build.mjs); `dev` serves from Vite.
        scripts: { dev: 'vite', build: 'node az-vite/build.mjs', preview: 'vite preview' },
        dependencies: {
          react: PINS.react,
          // react-dom ships in lockstep with react and must match it exactly.
          'react-dom': PINS.react,
          ...(seeded.used ? { three: PINS.three } : {}),
          ...(map ? { 'maplibre-gl': PINS.maplibre, pmtiles: PINS.pmtiles, '@protomaps/basemaps': PINS.basemaps } : {}),
        },
        // The declarations `tsc --noEmit` reads; the build itself needs none of them.
        devDependencies: {
          '@types/react': PINS.typesReact,
          '@types/react-dom': PINS.typesReactDom,
          ...(seeded.used ? { '@types/three': PINS.typesThree } : {}),
          vite: PINS.vite,
          typescript: PINS.typescript,
        },
      }, null, 2) + '\n',
    },
    {
      path: 'vite.config.ts',
      content: `${generated('Vite config: one HTML entry per page, public env prefix, secret guard, stylesheets first')}import { defineConfig } from "vite";
import { secretGuard } from "./${GUARD_DIR}/guard.ts";
import { stylesFirst } from "./${GUARD_DIR}/head-order.ts";

export default defineConfig({
  // A site is served from a domain root: its routes (/work), asset URLs
  // (/assets/…) and auth redirects are root-relative, so a subdirectory
  // deploy does not work. The bundle's own references stay relative.
  base: "./",
  // Only this prefix reaches the browser (auth-spec §4), and the guard
  // refuses the build if a service key would be among it.
  envPrefix: ${JSON.stringify(PUBLIC_ENV_PREFIX)},
  // Each page links its stylesheet before its module script (head-order.ts).
  // "post": after Vite has written its own tags, which put the script first.
  plugins: [secretGuard(), { name: "az-styles-first", transformIndexHtml: { order: "post", handler: stylesFirst } }],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One HTML entry per page, so every route is a real file a static host
    // serves directly — no rewrite rules, and a deep link loads its own page.
    rolldownOptions: { input: ${stableJson(htmlEntries(spec))} },
  },
});
`,
    },
    {
      path: 'tsconfig.json',
      content: generated('TypeScript settings for src/') + JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          // The generated modules import each other by their real file names (`./client.ts`), as Vite resolves them.
          allowImportingTsExtensions: true,
          // `import.meta.env` (the public backend URL) is typed by the bundler's own declarations.
          types: ['vite/client'],
          skipLibCheck: true,
        },
        include: ['src'],
      }, null, 2) + '\n',
    },
    // A shared answer (chat-block-spec §20.7) is kept out of search results, as admin pages are.
    ...htmlFiles(spec).map((path) => ({ path, content: indexHtml(spec, adminFiles.has(path), descriptions.get(path) ?? null, icon, adminFiles.has(path) || path === htmlFileFor(SHARED_ROUTE)) })),
    {
      path: 'AZ.md',
      content: azMd({
        site: spec.site.name,
        theme: named.name,
        accent: spec.site.accent,
        ...(spec.site.accent2 ? { accent2: spec.site.accent2 } : {}),
        pattern: pattern ? `${spec.site.pattern} ${spec.site.patternOrigin}` : null,
        fonts: spec.site.fonts,
        pages: pages.map((p) => ({ route: p.route, file: htmlFileFor(p.route), nodes: p.nodes })),
        dirs: { runtime: RUNTIME_DIR, user: USER_DIR, auth: AUTH_DIR, guard: GUARD_DIR, three: THREE_DIR },
        auth: plan && { adapter: plan.adapter, profile: plan.profile, protect: plan.protect },
        publicEnv: requiredEnv(plan, publicChat),
        three: seeded.used,
        modules: moduleList,
        assets: [...used].sort(),
        backend: spec.site.backend ?? null,
        data: spec.site.data ?? null,
        from: spec.pages.flatMap((p) => p.blocks.flatMap((b) => (b.from ? [{ route: p.route, word: b.word, from: b.from }] : []))),
        chats: chat ? spec.pages.flatMap((p) => blocksFor(spec, p).flatMap((b) => (b.word === 'chat' && b.chat ? [{
          route: p.route, allow: b.props.allow ?? 'signedin', limit: b.props.limit ?? '20',
          show: b.chat.answer?.show ?? [], quotes: (b.chat.answer?.quotes ?? []).map((q) => `${q.route}#${q.n}`),
        }] : []))) : [],
      }),
    },
  ];
  const byPath = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return {
    files: files.sort((x, y) => byPath(x.path, y.path)),
    assets: [...used].sort(byPath),
    modules: moduleList,
    auth: plan !== null,
    backendUrlCheck: publicChat,
    three: seeded.used,
    rows: rowTables.length > 0,
    chat,
    map,
    warnings: [...new Set(warnings)],
  };
}
