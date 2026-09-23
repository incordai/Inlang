/**
 * The browser checks of the word gate — word-quality-gate §1 items 3–7.
 *
 * Each check takes a Playwright page already at the URL under test and
 * returns { pass, detail }. They are shared by the real run and by the
 * self-test, which proves every one of them can fail as well as pass.
 */

import AxeBuilder from '@axe-core/playwright';

/** word-gate §1 item 3: the three test widths. */
export const WIDTHS = [390, 768, 1440];

/** Bound on Tab presses for one keyboard walk; more means a trap or a runaway page. */
const MAX_TABS = 200;

/** Settle time after a scroll before animations are counted again. */
const SCROLL_SETTLE_MS = 300;

/** Item 3: nothing wider than the viewport; names the widest offender. */
export async function overflow(page) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const sw = document.documentElement.scrollWidth;
    let worst = null;
    for (const el of document.querySelectorAll('body *')) {
      const right = el.getBoundingClientRect().right + window.scrollX;
      if (right > vw + 0.5 && (!worst || right > worst.right)) {
        const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : '';
        worst = { right: Math.round(right), el: `${el.tagName.toLowerCase()}${cls}` };
      }
    }
    return { vw, sw, worst };
  });
  const pass = r.sw <= r.vw;
  return { pass, detail: pass ? '' : `scrollWidth ${r.sw} > ${r.vw}; widest: ${r.worst ? `${r.worst.el} to ${r.worst.right}px` : 'unknown'}` };
}

/** Item 4: axe, zero violations. */
export async function axe(page) {
  const result = await new AxeBuilder({ page }).analyze();
  const v = result.violations.map((x) => `${x.id}×${x.nodes.length}`);
  return { pass: v.length === 0, detail: v.join(', '), ids: result.violations.map((x) => x.id) };
}

/**
 * Item 5: every interactive element is reachable by Tab, each shows a
 * focus indicator, and focus eventually leaves the page (no trap).
 */
export async function keyboard(page) {
  const total = await page.evaluate(() => {
    const sel = 'a[href], button, input, select, textarea, [tabindex]';
    let n = 0;
    // A radio group is ONE tab stop — Tab enters it, arrow keys move within
    // it (HTML and the ARIA radio-group pattern). Every radio of a named
    // group shares the group's id, so reaching any one of them reaches it.
    const groups = new Map();
    for (const el of document.querySelectorAll(sel)) {
      const ti = el.getAttribute('tabindex');
      if (ti !== null && Number(ti) < 0) continue;
      if (el.disabled || el.closest('[inert]')) continue;
      if (el.getClientRects().length === 0) continue;       // not rendered
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const group = el.type === 'radio' && el.name ? `${el.form?.id ?? ''}|${el.name}` : null;
      if (group && groups.has(group)) { el.setAttribute('data-az-kb', groups.get(group)); continue; }
      const id = String(n++);
      if (group) groups.set(group, id);
      el.setAttribute('data-az-kb', id);
    }
    document.activeElement?.blur?.();
    return n;
  });

  const seen = new Set();
  const noIndicator = [];
  let trapped = true;
  let first = null;
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { body: true };
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px';
      return {
        id: el.getAttribute('data-az-kb'),
        tag: el.tagName.toLowerCase(),
        indicator: outline || (cs.boxShadow && cs.boxShadow !== 'none'),
      };
    });
    if (f.body) { trapped = false; break; }
    const key = f.id ?? `untracked-${f.tag}`;
    if (key === first) { trapped = false; break; }  // cycled round without leaving
    first ??= key;
    if (!seen.has(key) && !f.indicator) noIndicator.push(f.tag);
    seen.add(key);
  }
  const reached = [...seen].filter((k) => !k.startsWith('untracked-')).length;
  const problems = [];
  if (reached < total) problems.push(`${total - reached}/${total} unreachable`);
  if (noIndicator.length) problems.push(`no focus indicator on ${noIndicator.length} (${[...new Set(noIndicator)].join(', ')})`);
  if (trapped) problems.push(`focus trapped: never left after ${MAX_TABS} tabs`);
  return { pass: problems.length === 0, detail: problems.join('; ') || `${reached} stops` };
}

/** Item 6: under reduced motion nothing animates, at load or after scrolling. */
export async function reducedMotion(page) {
  const atLoad = await page.evaluate(() => document.getAnimations().length);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const afterScroll = await page.evaluate(() => document.getAnimations().length);
  const pass = atLoad === 0 && afterScroll === 0;
  return { pass, detail: pass ? '' : `${atLoad} animations at load, ${afterScroll} after scroll` };
}

/** The body's painted background — item 7 compares it across schemes. */
export const bodyBackground = (page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** How many column tracks a grid has at the current width (0 when not a grid). */
export const columnsOf = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return -1;
  const cs = getComputedStyle(el);
  if (cs.display !== 'grid' && cs.display !== 'inline-grid') return 0;
  return cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
}, selector);

/**
 * A responsive-table row: a multi-column layout restacks to one column
 * below breakpoint.sm. Measured at 390 (a phone) against 1440 (the control:
 * the layout really is multi-column on a desktop, or "one column" proves
 * nothing).
 */
export function restacks(narrow, wide) {
  const pass = narrow === 1 && wide > 1;
  return { pass, detail: pass ? '' : `${wide} columns at 1440, ${narrow} at 390 — expected >1 then 1` };
}

/**
 * Elements that must read as ONE column: they share a left edge. A layout
 * that drops them straight into a multi-column grid pairs them up across
 * the columns instead (hero `split` did: title left, sub right). Measured
 * on a desktop width, where the columns exist.
 */
export async function sharedColumn(page, selectors) {
  const lefts = await page.evaluate((sels) => sels.map((sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().left) : null;
  }), selectors);
  const missing = selectors.filter((_, i) => lefts[i] === null);
  if (missing.length) return { pass: false, detail: `missing: ${missing.join(', ')}` };
  const pass = Math.max(...lefts) - Math.min(...lefts) <= 1;
  return { pass, detail: pass ? '' : selectors.map((sel, i) => `${sel}@${lefts[i]}`).join(' ') };
}

/**
 * nav-spec §7: the skip link is the first thing Tab reaches, and it is
 * VISIBLE when focused — a link hidden off-screen forever is focusable but
 * useless to a sighted keyboard user.
 */
export async function skipLink(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Tab');
  const r = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el.tagName !== 'A' || !(el.getAttribute('href') ?? '').startsWith('#')) {
      return { first: el?.tagName.toLowerCase() ?? 'nothing' };
    }
    const box = el.getBoundingClientRect();
    return { first: 'skip', visible: box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight };
  });
  if (r.first !== 'skip') return { pass: false, detail: `first Tab reached ${r.first}, not a skip link` };
  return { pass: r.visible, detail: r.visible ? '' : 'the focused skip link is off-screen' };
}
