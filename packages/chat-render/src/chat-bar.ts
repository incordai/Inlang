/**
 * @az runtime chat-bar
 * Purpose: the bar of small actions under a finished answer — Copy (its words and its components' text forms) and Share — faint until the answer is pointed at or focused, plain on a touch screen, each button's tooltip on hover or keyboard focus.
 * Spec: docs/chat-block-spec.md §19.18 (issue #30), §20.7
 * Exports: answerBar, answerText, wireTips, BAR_OPEN
 * Edit guide: the bar is a copy of the chat word's template, appended last in its answer (after the follow-ups), so it is never
 *   before the answer in the Tab order; what Copy writes is text read from the drawn answer, never markup; the bar's state is
 *   one attribute (data-state), never a style.
 * Tests: scripts/chat-public-e2e.mjs, scripts/chat-e2e.mjs, packages/overlay/test/chat.test.ts
 */

/**
 * A finished answer ends with one compact row of icon buttons instead of a
 * full-size "Share this answer" button: Copy, and Share when the server
 * offers share links (chat-shared.ts fills its part into the row). The row is
 * drawn in the theme's faint edge colour and turns to the text colour while
 * the answer is pointed at or holds focus (the chat word styles the `open`
 * state); where the pointer cannot hover — a touch screen — it is always the
 * text colour. Each button's name is shown beside it on hover or keyboard
 * focus; Escape hides it.
 */

/** The bar's state while its answer is pointed at or focused: the chat word styles `[data-state="open"]`. */
export const BAR_OPEN = 'open';

/** Elements that are the page's own around an answer's content, not the answer: left out of what Copy takes. */
const NOT_ANSWER = '.az-chat-bar, .az-chat-thinking, .az-chat-caret, .az-chat-skeleton, .az-chat-follows';
/** Elements a text form leaves out: controls, pictures and anything hidden from everyone. */
const NOT_TEXT = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'svg', 'SVG', 'IMG', 'CANVAS', 'SCRIPT', 'STYLE', 'TEMPLATE', 'SUMMARY']);
/** Elements that start a line of their own in a text form. */
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'FORM', 'FIELDSET', 'LEGEND', 'CAPTION']);

/** Spaces and line breaks run together, as a reader sees them. */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A table as lines of tab-separated cells: what a spreadsheet takes on paste. */
function tableText(table: Element): string[] {
  return [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => squash(c.textContent ?? '')).join('\t')).filter((l) => l.trim() !== '');
}

/** An element's text form: its lines, block by block; a table as rows of cells; controls and pictures left out. */
function textLines(el: Element): string[] {
  if (NOT_TEXT.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') return [];
  // A hidden element is hidden from everyone — but a closed <details> keeps its table equivalent, which is the figures.
  if (el.hasAttribute('hidden')) return [];
  if (el.tagName === 'TABLE') return tableText(el);
  if (el.tagName === 'PRE') return [el.textContent ?? ''];
  const kids = [...el.children];
  if (!kids.some((k) => BLOCKS.has(k.tagName) || k.tagName === 'TABLE')) {
    // A run of inline content: its text, less anything left out.
    const parts: string[] = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) parts.push(n.textContent ?? '');
      else if (n.nodeType === 1) parts.push(textLines(n as Element).join(' '));
    }
    const line = squash(parts.join(''));
    return line ? [line] : [];
  }
  const out: string[] = [];
  let inline: string[] = [];
  const flush = () => {
    const line = squash(inline.join(''));
    if (line) out.push(line);
    inline = [];
  };
  for (const n of el.childNodes) {
    if (n.nodeType === 3) { inline.push(n.textContent ?? ''); continue; }
    if (n.nodeType !== 1) continue;
    const k = n as Element;
    if (BLOCKS.has(k.tagName) || k.tagName === 'TABLE') {
      flush();
      out.push(...textLines(k));
    } else {
      inline.push(textLines(k).join(' '));
    }
  }
  flush();
  return out;
}

/**
 * The answer as text (issue #30): its prose as written — a list's items
 * marked, a code block fenced — and each component's text form: a chart's
 * title, its summary and its figures as a table; a table's rows; a stat's
 * label, value and change; a card's title, text and link; a map's places.
 * Its follow-up questions and the page's own controls are not the answer.
 */
export function answerText(item: Element): string {
  const blocks: string[] = [];
  for (const child of item.children) {
    if (child.matches(NOT_ANSWER)) continue;
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      const start = child.tagName === 'OL' ? Number(child.getAttribute('start') ?? 1) : 1;
      blocks.push([...child.children].map((li, i) => `${child.tagName === 'OL' ? `${start + i}.` : '-'} ${squash(li.textContent ?? '')}`).join('\n'));
      continue;
    }
    const code = child.querySelector('pre code');
    if (child.matches('.az-chat-code') && code) {
      const lang = squash(child.querySelector('.az-chat-code-bar span')?.textContent ?? '');
      blocks.push(`\`\`\`${lang}\n${code.textContent ?? ''}\n\`\`\``);
      continue;
    }
    const lines = textLines(child);
    if (lines.length > 0) blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Each bar button's tooltip (the span beside it): shown while the pointer
 * is over the button or it has keyboard focus, hidden when they leave and on
 * Escape — the button keeps its focus. `signal` ends every listener.
 */
export function wireTips(root: Element, signal: AbortSignal): void {
  for (const item of root.querySelectorAll('.az-chat-bar-item')) {
    const button = item.querySelector('button');
    const tip = item.querySelector<HTMLElement>('[data-az-chat-tip]');
    if (!button || !tip) continue;
    const show = () => { tip.hidden = false; };
    const hide = () => { tip.hidden = true; };
    /** A pointer is pressing the button: the focus that brings is not the keyboard's, so it shows no tooltip. */
    let pressing = false;
    button.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(); }, { signal });
    button.addEventListener('pointerleave', hide, { signal });
    button.addEventListener('pointerdown', () => { pressing = true; }, { signal });
    button.addEventListener('focus', () => { if (!pressing) show(); }, { signal });
    button.addEventListener('blur', () => { pressing = false; hide(); }, { signal });
    // A press hides it: the action's own outcome (the status region, an opened panel) is what follows.
    button.addEventListener('click', () => { pressing = false; hide(); }, { signal });
    button.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || tip.hidden) return;
      hide();
      // Dismissed here: the panel's own Escape (stop, then close) waits for the next press.
      e.stopPropagation();
    }, { signal });
  }
}

/**
 * The bar for one finished answer, appended last in it: Copy wired to put
 * the answer's text on the clipboard (`copy` does it and says how it went),
 * the open state following the pointer and focus (always open where the
 * pointer cannot hover), every tooltip wired. Null without a template.
 */
export function answerBar(template: HTMLElement | null, item: HTMLElement, copy: (text: string) => void, signal: AbortSignal): HTMLElement | null {
  if (!template) return null;
  const bar = template.cloneNode(true) as HTMLElement;
  bar.removeAttribute('data-az-chat-slot');
  const copyButton = bar.querySelector('[data-az-chat-slot="copy-answer"]');
  copyButton?.removeAttribute('data-az-chat-slot');
  copyButton?.addEventListener('click', () => copy(answerText(item)), { signal });
  const win = item.ownerDocument.defaultView;
  const noHover = win?.matchMedia('(hover: none)').matches ?? false;
  const open = (yes: boolean) => {
    if (yes || noHover) bar.setAttribute('data-state', BAR_OPEN);
    else bar.removeAttribute('data-state');
  };
  open(false);
  item.addEventListener('pointerenter', () => open(true), { signal });
  item.addEventListener('pointerleave', () => open(item.contains(item.ownerDocument.activeElement)), { signal });
  item.addEventListener('focusin', () => open(true), { signal });
  item.addEventListener('focusout', (e) => open(e.relatedTarget instanceof Node && item.contains(e.relatedTarget)), { signal });
  item.append(bar);
  wireTips(bar, signal);
  return bar;
}
