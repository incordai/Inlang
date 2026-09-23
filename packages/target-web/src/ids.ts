/**
 * Ids unique on a page.
 *
 * A word builds its ids from its own content (faq slugs its questions, auth
 * names its fields), which is what keeps them stable across builds — and what
 * makes two blocks on one page collide: two FAQs asking the same question, or
 * two pricing sections, gave duplicate ids and one shared radio group. Only
 * the target sees a whole page, so it resolves this here.
 *
 * The rule: blocks are taken in page order; the first block to use an id
 * keeps it (so deep links to it stay stable); a later block's duplicate is
 * renamed `<id>-2`, `-3`, … and every reference to it INSIDE that block is
 * rewritten with it. References only ever point within their own block —
 * a word cannot know another block's ids — so nothing outside is touched.
 * Radio groups (`name`) get the same treatment: a group name is page-wide.
 */

import type { EmittedNode } from '../../core/src/emit-contract.ts';

/** Attributes holding ONE id. */
const SINGLE = ['for', 'list', 'form', 'aria-controls', 'aria-activedescendant', 'aria-details', 'aria-errormessage'];
/** Attributes holding a space-separated list of ids. */
const LIST = ['aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-flowto', 'headers'];

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];

/** The first free `<base>-N`, N from 2. */
function free(base: string, used: ReadonlySet<string>): string {
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

function rewrite(node: EmittedNode | string, ids: ReadonlyMap<string, string>, names: ReadonlyMap<string, string>): EmittedNode | string {
  if (typeof node === 'string') return node;
  const attrs = node.attrs ? { ...node.attrs } : undefined;
  if (attrs) {
    if (attrs.id && ids.has(attrs.id)) attrs.id = ids.get(attrs.id)!;
    for (const k of SINGLE) if (attrs[k] && ids.has(attrs[k])) attrs[k] = ids.get(attrs[k])!;
    for (const k of LIST) {
      if (attrs[k]) attrs[k] = attrs[k].split(/\s+/).map((id) => ids.get(id) ?? id).join(' ');
    }
    if (attrs.href?.startsWith('#') && ids.has(attrs.href.slice(1))) attrs.href = `#${ids.get(attrs.href.slice(1))}`;
    if (attrs.type === 'radio' && attrs.name && names.has(attrs.name)) attrs.name = names.get(attrs.name)!;
  }
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(node.children ? { children: node.children.map((c) => rewrite(c, ids, names)) } : {}),
  };
}

/** A page's top-level blocks, with every id and radio group unique across them. */
export function uniqueIds(blocks: readonly EmittedNode[]): EmittedNode[] {
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  return blocks.map((block) => {
    const nodes = walk(block);
    const own = nodes.map((n) => n.attrs?.id).filter((id): id is string => !!id);
    const groups = [...new Set(nodes.filter((n) => n.attrs?.type === 'radio' && n.attrs.name).map((n) => n.attrs!.name))];
    const ids = new Map<string, string>();
    for (const id of own) {
      if (ids.has(id)) continue;
      if (usedIds.has(id)) {
        const renamed = free(id, new Set([...usedIds, ...own]));
        ids.set(id, renamed);
        usedIds.add(renamed);
      } else {
        usedIds.add(id);
      }
    }
    const names = new Map<string, string>();
    for (const name of groups) {
      if (usedNames.has(name)) {
        const renamed = free(name, usedNames);
        names.set(name, renamed);
        usedNames.add(renamed);
      } else {
        usedNames.add(name);
      }
    }
    return ids.size === 0 && names.size === 0 ? block : rewrite(block, ids, names) as EmittedNode;
  });
}
