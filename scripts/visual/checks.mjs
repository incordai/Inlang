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
  if (cs.display === 'grid' || cs.display === 'inline-grid') {
    return cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  }
  // A wrapping flex row (footer `columns`): its columns are the distinct
  // left edges of its children.
  if (cs.display === 'flex' || cs.display === 'inline-flex') {
    return new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().left))).size;
  }
  // CSS multi-column (text `columns` flows one body into columns).
  const count = Number(cs.columnCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}, selector);

/**
 * A responsive-table row: a multi-column layout restacks to one column
 * below breakpoint.sm. Measured at 390 (a phone) against 1440 (the control:
 * the layout really is multi-column on a desktop, or "one column" proves
 * nothing).
 */
export function restacks(narrow, wide, expected = 1) {
  const pass = narrow === expected && wide > expected;
  return { pass, detail: pass ? '' : `${wide} columns at 1440, ${narrow} at 390 — expected >${expected} then ${expected}` };
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

/** A viewport wider than every frame, where the frame must bind. */
export const FRAME_WIDTH = 1920;

/**
 * PRD §6.1a `site width`: on a screen wider than the frame, every block's
 * content box sits inside the frame, centred — backgrounds may run edge to
 * edge, content may not. Read from the page: the frame is the site's
 * `--az-frame`, resolved to px by a probe element. A side-nav column is not
 * a section and is skipped.
 */
/**
 * theme-spec §8.1: the families the page actually renders — the computed
 * font-family of the <h1> (type.display) and of <body> (type.body) — equal
 * the stacks the site asked for. `expected` holds `{ display, body }`.
 */
export async function fonts(page, expected) {
  const got = await page.evaluate(() => ({
    display: getComputedStyle(document.querySelector('h1') ?? document.body).fontFamily,
    body: getComputedStyle(document.body).fontFamily,
  }));
  const norm = (s) => s.replace(/["']/g, '').split(',').map((p) => p.trim()).join(', ');
  const wrong = Object.keys(expected).filter((k) => norm(got[k]) !== norm(expected[k]));
  return {
    pass: wrong.length === 0,
    detail: wrong.map((k) => `${k} is "${got[k]}", expected "${expected[k]}"`).join('; '),
  };
}

/**
 * PRD §6.1a `theme accent` / `theme pattern`, as the page renders them: the
 * computed colour of the accent token, and the computed background image of
 * the element that carries the page's <h1> (the hero paints the pattern).
 */
export async function themeReading(page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--az-color-accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const h1 = document.querySelector('h1');
    const host = h1?.closest('header, section') ?? document.body;
    return { accent, pattern: getComputedStyle(host).backgroundImage };
  });
}

/**
 * Sites that differ only in their theme settings must render differently:
 * every accent its own computed colour, every pattern its own background, and
 * a site without a pattern none at all. `readings` holds
 * `{ label, accent, pattern, patterned }` per site.
 */
export function settingsDiffer(readings) {
  const problems = [];
  const clash = (key) => {
    const seen = new Map();
    for (const r of readings) {
      if (seen.has(r[key])) problems.push(`${r.label} and ${seen.get(r[key])} render the same ${key} (${r[key]})`);
      else seen.set(r[key], r.label);
    }
  };
  clash('accent');
  clash('pattern');
  for (const r of readings) {
    if (r.patterned && r.pattern === 'none') problems.push(`${r.label} asked for a pattern and paints none`);
    if (!r.patterned && r.pattern !== 'none') problems.push(`${r.label} asked for no pattern and paints ${r.pattern}`);
  }
  if (readings.length < 2) problems.push(`${readings.length} site(s) read — nothing to compare`);
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

export async function frame(page) {
  return page.evaluate(() => {
    const site = document.querySelector('.az-site');
    if (!site) return { pass: false, detail: 'no .az-site' };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--az-frame, 100%)';
    site.appendChild(probe);
    const frameWidth = probe.getBoundingClientRect().width;
    probe.remove();
    // The frame centres in the column the block sits in: the page, or the
    // content column beside a side nav — the same box its 100% resolves to.
    const bounds = (block) => {
      const p = block.parentElement.getBoundingClientRect();
      const margin = Math.max(0, (p.width - frameWidth) / 2);
      return [p.left + margin, p.right - margin];
    };
    const blocks = [...document.querySelectorAll('.az-page > :not(main), main > *')]
      // Blocks are block boxes; an inline run has no inset of its own.
      .filter((el) => el.getClientRects().length > 0 && !getComputedStyle(el).display.startsWith('inline')
        && !el.matches('[data-layout="side"] > :first-child'));
    if (!blocks.length) return { pass: false, detail: 'no blocks' };
    // A wrapper with no inset of its own (nav's shrink frame) is measured
    // through its one child, where the block's content actually starts.
    const inner = (el) => {
      const cs = getComputedStyle(el);
      const bare = parseFloat(cs.paddingLeft) === 0 && parseFloat(cs.paddingRight) === 0;
      return bare && el.children.length === 1 ? inner(el.firstElementChild) : el;
    };
    const bad = blocks.flatMap((block) => {
      const [left, right] = bounds(block);
      const el = inner(block);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const start = r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
      const end = r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
      // 2px of slack: sub-pixel layout, and a block mid-way through a small transform.
      return start >= left - 2 && end <= right + 2 ? []
        : [`${el.className.split(' ')[0] || el.tagName}: ${Math.round(start)}–${Math.round(end)} (frame ${Math.round(left)}–${Math.round(right)})`];
    });
    return { pass: bad.length === 0, detail: bad.join(', ') };
  });
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
  if (!r.visible) return { pass: false, detail: 'the focused skip link is off-screen' };
  // And it must SKIP: after following it, the next Tab lands inside its
  // target and past the link. A skip link inside its own target moves focus
  // to the target, and the next Tab comes straight back to the link.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  const landed = await page.evaluate(() => {
    const el = document.activeElement;
    const skip = document.querySelector('a[href^="#"]');
    const target = skip && document.getElementById((skip.getAttribute('href') ?? '').slice(1));
    const focusable = target ? [...target.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((f) => f !== skip && f.getClientRects().length > 0) : [];
    return { onTarget: !!(el && target && (el === target || target.contains(el))), content: focusable.length > 0 };
  });
  if (!landed.onTarget) return { pass: false, detail: 'following the skip link did not move focus to its target' };
  if (!landed.content) return { pass: true, detail: '' };
  // The target has something to reach: the next Tab must land on it.
  await page.keyboard.press('Tab');
  const after = await page.evaluate(() => {
    const el = document.activeElement;
    const skip = document.querySelector('a[href^="#"]');
    const target = skip && document.getElementById((skip.getAttribute('href') ?? '').slice(1));
    return {
      inside: !!(el && target && target !== el && target.contains(el)),
      onSkip: el === skip,
      what: el ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}` : 'nothing',
    };
  });
  if (!after.inside || after.onSkip) {
    return { pass: false, detail: `after the skip link, Tab reached ${after.what}, not the content it skips to` };
  }
  return { pass: true, detail: '' };
}

/**
 * ASSUMPTIONS A6: the page as shipped reads with JavaScript OFF — the
 * pre-rendered HTML carries the content, and every "works without JS"
 * claim holds: FAQ answers open and readable (faq-spec §8), an auth form
 * that can be filled in (auth-spec §5), and a dynamic footer year showing
 * its fallback (footer-spec §5). Opens its own context: JS is a context
 * setting, not a page one.
 */
export async function noJs(browser, url) {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const problems = await page.evaluate(() => {
      const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
      const text = (el) => (el.textContent ?? '').trim();
      const out = [];
      const main = document.querySelector('main');
      if (!main || !text(main)) out.push('<main> is empty — the page is not pre-rendered');
      for (const a of document.querySelectorAll('.az-faq-answer')) {
        if (!shown(a) || !text(a)) out.push(`FAQ answer #${a.id || '?'} is not readable`);
      }
      for (const f of document.querySelectorAll('form.az-auth-form')) {
        // reset's set-password state ships hidden: the runtime shows it (§5).
        if (f.closest('[hidden]')) continue;
        const input = [...f.querySelectorAll('input')].find(shown);
        const submit = [...f.querySelectorAll('button[type="submit"], button:not([type])')].find(shown);
        if (!input || !submit) out.push(`auth form "${f.dataset.flow ?? '?'}" has no ${input ? 'submit button' : 'field'} to use`);
      }
      for (const y of document.querySelectorAll('[data-year]')) {
        if (!/^\d{4}$/.test(text(y))) out.push(`footer year shows "${text(y)}", not a year`);
      }
      return out;
    });
    return { pass: problems.length === 0, detail: problems.join('; ') };
  } finally {
    await ctx.close();
  }
}

/**
 * A pre-rendered page must hydrate cleanly: React reports a mismatch as a
 * console error (an uncaught error in production builds) and throws the
 * server markup away. Any console or page error from the first load until
 * the page is marked ready (`readySelector`) fails it.
 */
export async function hydration(browser, url, readySelector) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector(readySelector, { state: 'attached' });
    await page.waitForTimeout(SCROLL_SETTLE_MS);
    return { pass: errors.length === 0, detail: errors.map((e) => e.split('\n')[0]).join('; ') };
  } finally {
    await ctx.close();
  }
}
