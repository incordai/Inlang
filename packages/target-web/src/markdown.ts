/**
 * @az module markdown
 * Purpose: a `text` body file (.md) → EmittedNode tree at build time — text-spec §5, §8, §10.
 * Spec: docs/text-block-spec.md §5 · §8 · §10
 * Exports: markdownToNodes, markdownText, MarkdownError, WEAK_LINK_TEXT
 * Edit guide: the accepted subset is the NODE switch below (unknown node kinds render nothing); styles are theme
 *   tokens only. Keep: no raw HTML ever reaches the tree; never an <h1>; headings clamp at h4; scrolling regions
 *   (pre, table wrapper) are keyboard-reachable; link schemes on the AZ1404 allow-list.
 * Tests: packages/target-web/test/markdown.test.ts, scripts/verify-build.mjs
 */

/**
 * Markdown for `text` bodies — CommonMark plus GitHub-style tables and
 * strikethrough, and nothing else (text-spec §5). Parsed to a syntax tree
 * and mapped node by node onto the emit contract, so the page is data React
 * renders and escapes: there is no HTML string anywhere, and raw HTML in the
 * file is dropped with a warning, never passed through.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { px, type EmittedNode, type ThemeLike } from '../../core/src/emit-contract.ts';

/** A file problem that must stop the build (text-spec §10's error rows). */
export class MarkdownError extends Error {}

/** §8: link text that says nothing out of context. */
export const WEAK_LINK_TEXT = ['click here', 'here', 'read more', 'more', 'link', 'this', 'learn more'];

/** §10: past this many columns a table scrolls on a phone. */
const TABLE_COLUMNS_MAX = 6;
/** §8: headings clamp here; a file needing more is a docs page. */
const HEADING_MAX = 4;
/** Link schemes a body may use — the AZ1404 allow-list's link subset. */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

export interface MarkdownOptions {
  /** The author's path, for messages. */
  readonly file: string;
  /** The block has a `title` (its h2): file headings start at h3, else h2. */
  readonly titled: boolean;
  readonly theme: ThemeLike;
  /** Resolves a relative image or file link through the asset sandbox. */
  readonly asset: (path: string) => string;
}

export interface MarkdownResult {
  readonly nodes: EmittedNode[];
  /** §10's warning rows, as author-facing messages. */
  readonly warnings: string[];
}

// The syntax tree's node, as far as this file reads it.
interface Md {
  readonly type: string;
  readonly children?: Md[];
  readonly value?: string;
  readonly depth?: number;
  readonly ordered?: boolean;
  readonly start?: number | null;
  readonly spread?: boolean;
  readonly url?: string;
  readonly alt?: string | null;
  readonly title?: string | null;
  readonly lang?: string | null;
  readonly align?: (string | null)[];
  readonly identifier?: string;
}

const textOf = (n: Md): string => n.value ?? (n.children ?? []).map(textOf).join('');
const base = (file: string) => file.split('/').pop() ?? file;

/** The markdown kinds whose text is the reader's words; every other kind adds none. */
const BLOCK_TEXT: ReadonlySet<string> = new Set(['paragraph', 'heading', 'code', 'tableRow']);

/**
 * A body file's words as plain text (chat-block-spec §8.1): what a visitor
 * reads on the page, each paragraph, heading, list item and table row its
 * own line, a blank line between blocks. A link keeps its words and loses
 * its address; an image, raw HTML and a reference's definition add nothing —
 * so nothing here is a URL the build did not declare.
 */
export function markdownText(source: string): string {
  const tree = fromMarkdown(source, {
    extensions: [gfmTable(), gfmStrikethrough()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()],
  }) as unknown as Md;
  const inline = (n: Md): string => {
    switch (n.type) {
      case 'text': case 'inlineCode': case 'code': return n.value ?? '';
      case 'break': return ' ';
      case 'image': case 'imageReference': case 'html': case 'definition': return '';
      // A table row reads cell by cell.
      case 'tableRow': return (n.children ?? []).map(inline).join(' · ');
      default: return (n.children ?? []).map(inline).join('');
    }
  };
  const blocks: string[] = [];
  const walk = (n: Md) => {
    if (BLOCK_TEXT.has(n.type)) {
      const t = inline(n).replace(/[ \t]+/g, ' ').trim();
      if (t) blocks.push(t);
      return;
    }
    if (n.type === 'html' || n.type === 'definition') return;
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return blocks.join('\n\n');
}

export function markdownToNodes(source: string, options: MarkdownOptions): MarkdownResult {
  const { theme: t, file } = options;
  const tree = fromMarkdown(source, {
    extensions: [gfmTable(), gfmStrikethrough()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()],
  }) as unknown as Md;
  const warnings: string[] = [];
  const name = base(file);

  // Reference-style links and images resolve through the file's definitions.
  const definitions = new Map<string, Md>();
  const collect = (n: Md) => {
    if (n.type === 'definition' && n.identifier) definitions.set(n.identifier.toLowerCase(), n);
    n.children?.forEach(collect);
  };
  collect(tree);

  // §8: the file's highest heading becomes h3 under a title, h2 without.
  const depths: number[] = [];
  const findHeadings = (n: Md) => {
    if (n.type === 'heading' && n.depth) depths.push(n.depth);
    n.children?.forEach(findHeadings);
  };
  findHeadings(tree);
  const top = depths.length ? Math.min(...depths) : 1;
  const first = options.titled ? 3 : 2;
  const levelOf = (depth: number) => Math.min(HEADING_MAX, first + (depth - top));
  const levels = depths.length ? Math.max(...depths) - top + 1 : 0;
  if (depths.length && first + levels - 1 > HEADING_MAX) {
    warnings.push(`text: ${levels} heading levels is a docs page — flatten it, or use 'content'`);
  }
  let lastLevel = 0;

  const safeUrl = (url: string, what: 'link' | 'image'): string => {
    const trimmed = url.trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
    if (scheme && !SAFE_SCHEME.test(trimmed)) {
      throw new MarkdownError(`text: '${scheme}:' ${what} in '${name}' is not allowed — use a path or an https url`);
    }
    if (scheme) return trimmed;
    // A link may name a route or an anchor on the page.
    if (what === 'link' && (trimmed.startsWith('#') || trimmed.startsWith('/'))) return trimmed;
    // A relative file — every image — ships with the site through the asset
    // sandbox, which refuses anything outside the project.
    return options.asset(trimmed);
  };

  const inline = (n: Md): (EmittedNode | string)[] => (n.children ?? []).flatMap(render);

  const render = (n: Md): (EmittedNode | string)[] => {
    switch (n.type) {
      case 'text': return [n.value ?? ''];
      case 'paragraph':
        return [{ tag: 'p', style: { margin: `0 0 ${px(t.space[16])}` }, children: inline(n) }];
      case 'heading': {
        const level = levelOf(n.depth ?? 1);
        if (n.depth === 1) warnings.push(`text: '# ${textOf(n)}' becomes an h${level} — the page h1 belongs to the hero`);
        if (lastLevel && level > lastLevel + 1) {
          warnings.push(`text: '${textOf(n)}' jumps from h${lastLevel} to h${level} — use the next level down`);
        }
        lastLevel = level;
        return [{
          tag: `h${level}`,
          style: {
            fontFamily: t.type.display, lineHeight: t.type['leading-tight'],
            fontSize: level <= 2 ? t.typeSize.xl : t.typeSize.lg, margin: `${px(t.space[24])} 0 ${px(t.space[8])}`,
            breakAfter: 'avoid',
          },
          children: inline(n),
        }];
      }
      case 'emphasis': return [{ tag: 'em', children: inline(n) }];
      case 'strong': return [{ tag: 'strong', children: inline(n) }];
      case 'delete': return [{ tag: 'del', children: inline(n) }];
      case 'inlineCode':
        return [{ tag: 'code', style: { fontFamily: t.type.mono, fontSize: t.typeSize.sm }, children: [n.value ?? ''] }];
      case 'code':
        // §8: a region that scrolls must be reachable by keyboard.
        return [{
          tag: 'pre',
          attrs: { tabindex: '0' },
          style: {
            overflowX: 'auto', padding: px(t.space[16]), margin: `0 0 ${px(t.space[16])}`,
            background: t.color['surface-alt'], borderRadius: px(t.radius.sm), breakInside: 'avoid',
          },
          states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
          children: [{ tag: 'code', style: { fontFamily: t.type.mono, fontSize: t.typeSize.sm }, children: [n.value ?? ''] }],
        }];
      case 'blockquote':
        return [{
          tag: 'blockquote',
          style: { margin: `0 0 ${px(t.space[16])}`, paddingInlineStart: px(t.space[16]), borderInlineStart: `${px(t.size['edge-emphasis'])} solid ${t.color.border}`, color: t.color.muted, breakInside: 'avoid' },
          children: (n.children ?? []).flatMap(render),
        }];
      case 'list':
        return [{
          tag: n.ordered ? 'ol' : 'ul',
          attrs: n.ordered && n.start && n.start !== 1 ? { start: String(n.start) } : undefined,
          style: { margin: `0 0 ${px(t.space[16])}`, paddingInlineStart: px(t.space[24]), breakInside: 'avoid' },
          children: (n.children ?? []).flatMap((item) => {
            // A tight list's paragraphs are its items' text, not blocks.
            const kids = (item.children ?? []).flatMap((c) => (!n.spread && !item.spread && c.type === 'paragraph' ? inline(c) : render(c)));
            return [{ tag: 'li', children: kids }];
          }),
        }];
      case 'thematicBreak':
        return [{ tag: 'hr', style: { border: 0, borderBlockStart: `1px solid ${t.color.border}`, margin: `${px(t.space[24])} 0` } }];
      case 'break': return [{ tag: 'br' }];
      case 'link':
      case 'linkReference': {
        const def = n.type === 'linkReference' ? definitions.get((n.identifier ?? '').toLowerCase()) : n;
        if (!def?.url) return inline(n);
        const href = safeUrl(def.url, 'link');
        const label = textOf(n).trim();
        if (WEAK_LINK_TEXT.includes(label.toLowerCase())) {
          warnings.push(`text: '${label}' says nothing out of context — name the destination`);
        }
        const external = /^https?:\/\//i.test(href);
        return [{
          tag: 'a',
          attrs: { href, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) },
          style: { color: t.color.accent, textDecoration: 'underline' },
          states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
          children: [...inline(n), ...(external ? [{
            tag: 'span',
            style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
            children: [' (opens in new tab)'],
          } satisfies EmittedNode] : [])],
        }];
      }
      case 'image':
      case 'imageReference': {
        const def = n.type === 'imageReference' ? definitions.get((n.identifier ?? '').toLowerCase()) : n;
        if (!def?.url) return [];
        // §8: `![](…)` — the alt written empty — is a decorative image.
        return [{
          tag: 'img',
          attrs: { src: safeUrl(def.url, 'image'), alt: n.alt ?? '', loading: 'lazy', decoding: 'async' },
          style: { display: 'block', maxWidth: '100%', height: 'auto', margin: `0 0 ${px(t.space[16])}` },
        }];
      }
      case 'table': {
        const rows = n.children ?? [];
        const columns = Math.max(0, ...rows.map((r) => (r.children ?? []).length));
        if (columns > TABLE_COLUMNS_MAX) {
          const article = /^(8|11|18)\b/.test(String(columns)) ? 'an' : 'a';
          warnings.push(`text: ${article} ${columns}-column table will scroll on a phone — cut columns, or wait for 'compare'`);
        }
        const cell = (c: Md, i: number, head: boolean): EmittedNode => ({
          tag: head ? 'th' : 'td',
          attrs: head ? { scope: 'col' } : undefined,
          style: { textAlign: n.align?.[i] ?? undefined, padding: `${px(t.space[8])} ${px(t.space[12])}`, borderBlockEnd: `1px solid ${t.color.border}` },
          children: inline(c),
        });
        const [head, ...body] = rows;
        // §5/§8: the table scrolls inside its own focusable container, never the page.
        return [{
          tag: 'div',
          attrs: { tabindex: '0', role: 'region', 'aria-label': 'Table' },
          style: { overflowX: 'auto', margin: `0 0 ${px(t.space[16])}` },
          states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
          children: [{
            tag: 'table',
            style: { borderCollapse: 'collapse', width: '100%' },
            children: [
              ...(head ? [{ tag: 'thead', children: [{ tag: 'tr', children: (head.children ?? []).map((c, i) => cell(c, i, true)) }] } satisfies EmittedNode] : []),
              { tag: 'tbody', children: body.map((r) => ({ tag: 'tr', children: (r.children ?? []).map((c, i) => cell(c, i, false)) })) },
            ],
          }],
        }];
      }
      case 'html':
        // §5: raw HTML is stripped, unconditionally — never passed through.
        warnings.push(`text: html in '${name}' is stripped — use the 'raw' word if you need markup`);
        return [];
      // Definitions are read above; anything outside the subset renders nothing.
      default:
        return [];
    }
  };

  const nodes = (tree.children ?? []).flatMap(render).filter((n): n is EmittedNode => typeof n !== 'string');
  return { nodes, warnings: [...new Set(warnings)] };
}
