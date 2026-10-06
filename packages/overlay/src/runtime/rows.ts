/**
 * @az runtime rows
 * Purpose: fills a `from` block (data-spec §10.3) with rows from the typed client, after the page renders.
 * Spec: docs/data-spec.md §10.3, §13
 * Exports: attachRows, RowSource, RowsResult
 * Edit guide: rows are text and attributes only, never HTML; each block once (late content via MutationObserver); attachRows() returns full cleanup.
 * Tests: packages/overlay/test/rows.test.ts, scripts/data-e2e.mjs
 */

/**
 * The runtime of a block with `from <table>`.
 *
 * The page is pre-rendered without rows — the build never calls a network —
 * so a `from` block ships a shell (core emit-contract fromShell): a skeleton,
 * an empty rows container, a hidden template item the word rendered with
 * its own item code, a polite status line and the retry and sign-in
 * controls. This finds each shell, asks the generated client for its rows AS
 * THE VISITOR (the server applies the table's rules to them), and fills a
 * copy of the template per row:
 *
 *   - a value is only ever text (`textContent`) or an attribute value
 *     (`setAttribute`), and a URL attribute only a safe http(s) URL — a row
 *     is never parsed as markup (data-spec §13, stored XSS);
 *   - each copy's ids get their own suffix, references rewritten with them;
 *   - the filled list is inserted in one step, so the behaviour runtime's
 *     observer wires it (faq disclosures) like any late content.
 *
 * Touches nothing at import time, so a server render never reaches
 * `document`. Content rendered later (a page behind <Protected>) is found by
 * a MutationObserver. Every block is loaded once per attach; the returned
 * cleanup removes every listener and puts each shell back as it shipped.
 * Imports only its siblings.
 */

import { attributeValue, markerProp, paragraphs, parseRowsConfig, problemCopy, rowImage, rowText, type RowsConfig } from './rows-logic.ts';

/** What a table's list answers: the generated client's DataResult, narrowed to what this needs. */
export type RowsResult =
  | { readonly ok: true; readonly items: readonly unknown[] }
  | { readonly ok: false; readonly code: string };

/** One table's `list`, as the generated client exposes it. */
export type RowSource = (query: Readonly<Record<string, string | number | boolean>>) => Promise<RowsResult>;

type Cleanup = () => void;

/** Attributes holding ONE id, then a list of ids (target-web ids.ts, the same lists). */
const SINGLE = ['for', 'list', 'form', 'aria-controls', 'aria-activedescendant', 'aria-details', 'aria-errormessage'];
const LIST = ['aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-flowto', 'headers'];

/** A shell's parts, found once. */
interface Shell {
  readonly host: HTMLElement;
  readonly skeleton: HTMLElement | null;
  readonly rows: HTMLElement;
  readonly template: HTMLElement;
  readonly status: HTMLElement;
  readonly actions: HTMLElement | null;
  readonly retry: HTMLButtonElement | null;
  readonly signin: HTMLElement | null;
}

function shellOf(host: HTMLElement): Shell | null {
  const part = <T extends HTMLElement>(attr: string): T | null => host.querySelector<T>(`:scope > [${attr}], :scope > * > [${attr}]`);
  const rows = part('data-az-from-rows');
  const template = part('data-az-from-template');
  const status = part('data-az-from-status');
  if (!rows || !template || !status) return null;
  return {
    host, rows, template, status,
    skeleton: part('data-az-from-skeleton'),
    actions: part('data-az-from-actions'),
    retry: part<HTMLButtonElement>('data-az-from-retry'),
    signin: part('data-az-from-signin'),
  };
}

type State = 'loading' | 'rows' | 'empty' | 'signin' | 'error';

/** Show one state: what is visible, what is said, whether the block is busy. */
function show(s: Shell, state: State, message = ''): void {
  s.host.setAttribute('data-az-from-state', state);
  s.host.setAttribute('aria-busy', String(state === 'loading'));
  if (s.skeleton) s.skeleton.hidden = state !== 'loading';
  if (state !== 'rows') s.rows.replaceChildren();
  s.status.textContent = message;
  if (s.retry) s.retry.hidden = state !== 'error';
  if (s.signin) s.signin.hidden = state !== 'signin';
  if (s.actions) s.actions.hidden = !((state === 'error' && s.retry) || (state === 'signin' && s.signin));
}

/** Every id inside `root` given `suffix`, and every reference to one of them rewritten. */
function suffixIds(root: Element, suffix: string): void {
  const all = [root, ...root.querySelectorAll('*')];
  const ids = new Map<string, string>();
  for (const el of all) if (el.id) ids.set(el.id, `${el.id}-${suffix}`);
  if (ids.size === 0) return;
  for (const el of all) {
    if (el.id) el.id = ids.get(el.id)!;
    for (const a of SINGLE) {
      const v = el.getAttribute(a);
      if (v !== null && ids.has(v)) el.setAttribute(a, ids.get(v)!);
    }
    for (const a of LIST) {
      const v = el.getAttribute(a);
      if (v !== null) el.setAttribute(a, v.split(/\s+/).map((id) => ids.get(id) ?? id).join(' '));
    }
  }
}

/**
 * One row as a copy of the template item, or null when the row has no
 * label (a fill without its first value — a question without the question —
 * is not shown). A marker whose value is empty takes its element with it
 * when the marker was all that element held (an item's text paragraph).
 */
function fillRow(doc: Document, item: Element, row: unknown, config: RowsConfig, suffix: string): Element | null {
  const image = (prop: string) => (config.types[prop] === 'image' ? rowImage(row, config.map[prop]) : null);
  // An image field fills by its URL; every other field by its text.
  const valueOf = (prop: string) => (!Object.hasOwn(config.map, prop) ? null
    : config.types[prop] === 'image' ? image(prop)?.url ?? null : rowText(row, config.map[prop]));
  if (config.label !== null && valueOf(config.label) === null) return null;
  const copy = item.cloneNode(true) as Element;

  const walker = doc.createTreeWalker(copy, 4 /* NodeFilter.SHOW_TEXT */);
  const markers: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (markerProp((n as Text).data) !== null) markers.push(n as Text);
  for (const node of markers) {
    const prop = markerProp(node.data)!;
    const value = valueOf(prop);
    const parent = node.parentElement;
    if (value === null) {
      if (parent && parent !== copy && parent.childNodes.length === 1) parent.remove();
      else node.data = '';
      continue;
    }
    const blocks = config.types[prop] === 'longtext' ? paragraphs(value) : [[value]];
    if (parent && parent.tagName === 'P' && parent.childNodes.length === 1 && blocks.length > 0) {
      // A longtext's paragraphs as copies of the paragraph the word styled;
      // its line breaks as <br>. Every piece of text is a text node.
      const made = blocks.map((lines) => {
        const p = parent.cloneNode(false) as HTMLElement;
        lines.forEach((line, i) => {
          if (i > 0) p.append(doc.createElement('br'));
          p.append(doc.createTextNode(line));
        });
        return p;
      });
      parent.replaceWith(...made);
    } else {
      node.data = blocks.map((lines) => lines.join('\n')).join('\n\n');
    }
  }

  const base = doc.baseURI;
  // An image filled from a row reserves its box: its stored width and height (data-spec §8).
  for (const img of copy.querySelectorAll('img')) {
    const prop = markerProp(img.getAttribute('src') ?? '');
    const size = prop === null ? null : image(prop);
    if (size && size.width > 0 && size.height > 0) {
      img.setAttribute('width', String(size.width));
      img.setAttribute('height', String(size.height));
    }
  }
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (!attr.value.includes('\uE000')) continue;
      const v = attributeValue(attr.name, attr.value, valueOf, base);
      if (v === null) el.removeAttribute(attr.name);
      else el.setAttribute(attr.name, v);
    }
  }
  suffixIds(copy, suffix);
  return copy;
}

/**
 * Fill every `from` block in `doc` with its rows. `sources` maps a table's
 * name to its client `list` — the generated src/data/rows.tsx passes the
 * typed client's. Returns the cleanup.
 */
export function attachRows(doc: Document, sources: Readonly<Record<string, RowSource>>): Cleanup {
  const win = doc.defaultView;
  const ac = new AbortController();
  const wired = new Map<HTMLElement, { shell: Shell; generation: number }>();
  let rowCount = 0;
  let live = true;

  const wire = (host: HTMLElement) => {
    if (wired.has(host)) return;
    const shell = shellOf(host);
    if (!shell) return;
    const entry = { shell, generation: 0 };
    wired.set(host, entry);
    const config = parseRowsConfig(host.getAttribute('data-az-from'));
    const source = config && Object.hasOwn(sources, config.table) ? sources[config.table] : undefined;
    if (!config || !source) {
      // A shell this site's client cannot serve: a build mismatch, said as
      // the fixed error line, with nothing to retry.
      show(shell, 'error', problemCopy('unknown'));
      if (shell.retry) shell.retry.hidden = true;
      if (shell.actions) shell.actions.hidden = true;
      return;
    }
    const item = shell.template.firstElementChild;

    const load = () => {
      const generation = ++entry.generation;
      show(shell, 'loading');
      source(config.query).then((r) => r, (): RowsResult => ({ ok: false, code: 'unknown' })).then((r) => {
        if (!live || generation !== entry.generation) return;
        if (!r.ok) {
          if (r.code === 'signin_required') show(shell, 'signin', config.empty);
          else show(shell, 'error', problemCopy(r.code));
        } else {
          const list = shell.template.cloneNode(false) as HTMLElement;
          list.removeAttribute('hidden');
          list.removeAttribute('data-az-from-template');
          const behaviour = list.getAttribute('data-az-from-behaviour');
          if (behaviour) {
            list.removeAttribute('data-az-from-behaviour');
            list.setAttribute('data-az-behaviour', behaviour);
          }
          if (item) {
            for (const row of r.items) {
              const copy = fillRow(doc, item, row, config, `r${++rowCount}`);
              if (copy) list.append(copy);
            }
          }
          if (list.childElementCount === 0) show(shell, 'empty', config.empty);
          else {
            show(shell, 'rows');
            // One insertion: the behaviour runtime wires the list once, whole.
            shell.rows.replaceChildren(list);
          }
        }
      });
    };
    shell.retry?.addEventListener('click', () => {
      // The button hides while the rows load; focus moves to the block it
      // belongs to rather than falling to the page.
      host.tabIndex = -1;
      host.focus();
      load();
    }, { signal: ac.signal });
    load();
  };

  const scan = (root: ParentNode) => {
    if (root instanceof HTMLElement && root.hasAttribute('data-az-from')) wire(root);
    for (const host of root.querySelectorAll<HTMLElement>('[data-az-from]')) wire(host);
  };
  scan(doc);
  // A protected page renders its content once the session check resolves.
  const observer = win ? new win.MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n as Element);
  }) : null;
  observer?.observe(doc.body, { childList: true, subtree: true });

  return () => {
    live = false;
    observer?.disconnect();
    ac.abort();
    // Back to the shell as it shipped, so attaching again loads again.
    for (const [host, { shell }] of wired) {
      show(shell, 'loading');
      host.removeAttribute('tabindex');
    }
    wired.clear();
  };
}
