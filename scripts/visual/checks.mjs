/**
 * The browser checks of the word gate — word-quality-gate §1 items 3–7.
 *
 * Each check takes a Playwright page already at the URL under test and
 * returns { pass, detail }. They are shared by the real run and by the
 * self-test, which proves every one of them can fail as well as pass.
 */

import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import { answerPreviewBackend } from './pipeline.mjs';

/** word-gate §1 item 3: the three test widths. */
export const WIDTHS = [390, 768, 1440];

/** hero-spec §10: the phone the scrim is measured on — the narrowest common one. */
export const PHONE_WIDTH = 375;

/** hero-spec §9: body text contrast floor (WCAG 2.1 SC 1.4.3). */
const TEXT_CONTRAST = 4.5;

/** How far a centred element may sit from the title's axis: one CSS pixel, for subpixel layout. */
const CENTRE_TOLERANCE_PX = 1;

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

/**
 * GRAMMAR §5.2: an inherited block on one page. A page that writes
 * `<word> none` has none of the elements `selector` names; any other page
 * has exactly one, and it is shown.
 */
export async function leftOut(page, selector, present) {
  const shown = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => {
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
  }), selector);
  if (!present) {
    return { pass: shown.length === 0, detail: shown.length ? `the page says none, and it has ${shown.length} ${selector}` : '' };
  }
  const pass = shown.length === 1 && shown[0];
  return { pass, detail: pass ? '' : `the site's ${selector} is not on this page: ${shown.length} found, ${shown.filter(Boolean).length} shown` };
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

/**
 * Text that a layout centres must centre on ONE axis: each element's content
 * — the union of its lines, or of its children's boxes — has its horizontal
 * centre within 1px of the title's. Centring the text inside boxes that sit
 * at the start edge passes a glance at a short title and fails this (hero
 * `full` did: the sub and the actions sat left of the title). `sel` holds
 * `{ title, under }` selectors.
 */
export async function centredUnder(page, sel) {
  const centres = await page.evaluate(({ title, under }) => [title, ...under].map((q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    return (Math.min(...rects.map((r) => r.left)) + Math.max(...rects.map((r) => r.right))) / 2;
  }), sel);
  const names = [sel.title, ...sel.under];
  const missing = names.filter((_, i) => centres[i] === null);
  if (missing.length) return { pass: false, detail: `nothing on screen for: ${missing.join(', ')}` };
  const [axis, ...rest] = centres;
  const off = rest.map((c, i) => ({ q: sel.under[i], by: Math.abs(c - axis) })).filter((o) => o.by > CENTRE_TOLERANCE_PX);
  return {
    pass: off.length === 0,
    detail: off.length
      ? `${sel.title} centred at ${axis.toFixed(1)}px; ${off.map((o) => `${o.q} ${o.by.toFixed(1)}px off`).join(', ')}`
      : '',
  };
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
  await answerPreviewBackend(ctx);
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

/** WCAG 2.1 relative luminance of sRGB bytes. */
function luminance(r, g, b) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contrast ratio, truncated to two places as the theme's own maths does (theme/src/color.ts). */
const ratio = (la, lb) => Math.floor(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;

/**
 * hero-spec §9: the worst contrast of each line of `text` (selectors) against
 * what is painted under it, from pixels. The text is made transparent, the
 * page is captured, and every pixel under every line is compared with the
 * text's own colour; the worst pixel decides. Returns `{ problems, worst }`:
 * one problem per line under 4.5:1 or missing, and the worst ratio read.
 */
export async function textContrast(page, text) {
  const problems = [];
  let worst = Infinity;
  const lines = await page.evaluate((text) => {
    const out = [];
    for (const q of text) {
      const els = [...document.querySelectorAll(q)];
      if (!els.length) out.push({ q, missing: true });
      for (const el of els) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }));
        out.push({ q, color: getComputedStyle(el).color, rects });
      }
    }
    // A constructed sheet, not a <style> element: the page's policy
    // (word-quality-gate §2 B) refuses an inline style it did not hash.
    const hide = new CSSStyleSheet();
    hide.replaceSync(`${text.flatMap((q) => [q, `${q} *`]).join(', ')} { color: transparent !important; text-shadow: none !important; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, hide];
    return out;
  }, text);
  const png = await page.screenshot({ fullPage: true, animations: 'disabled' });
  // The page adopts no sheet of its own, so the probe is the last one.
  await page.evaluate(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.slice(0, -1); });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / await page.evaluate(() => document.documentElement.clientWidth);
  for (const line of lines) {
    if (line.missing) { problems.push(`no ${line.q}`); continue; }
    const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(line.color);
    if (!rgb) { problems.push(`${line.q} colour '${line.color}' is not rgb()`); continue; }
    const ink = luminance(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
    let low = Infinity;
    for (const r of line.rects) {
      const x0 = Math.max(0, Math.floor(r.x * scale)), x1 = Math.min(info.width, Math.ceil((r.x + r.w) * scale));
      const y0 = Math.max(0, Math.floor(r.y * scale)), y1 = Math.min(info.height, Math.ceil((r.y + r.h) * scale));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * info.width + x) * 3;
          low = Math.min(low, ratio(ink, luminance(data[i], data[i + 1], data[i + 2])));
        }
      }
    }
    if (low === Infinity) { problems.push(`${line.q} has no text on screen`); continue; }
    worst = Math.min(worst, low);
    if (low < TEXT_CONTRAST) problems.push(`${line.q} ${low}:1`);
  }
  return { problems, worst };
}

/**
 * hero-spec §9/§10: text over media keeps 4.5:1 at every width, whatever
 * the poster shows. axe cannot judge text over an image (it reports it as
 * "incomplete"), so this measures the pixels: the poster is swapped for each
 * fixture in turn and each is measured by textContrast. `sel` holds
 * `{ poster, text }` selectors; `fixtures` holds `{ name, bytes, type }` —
 * the darkest and lightest poster.
 */
export async function textOverPoster(page, sel, fixtures) {
  const src = await page.evaluate((q) => document.querySelector(q)?.currentSrc ?? null, sel.poster);
  if (!src) return { pass: false, detail: `no ${sel.poster} on the page` };
  const problems = [];
  let worst = Infinity;
  for (const f of fixtures) {
    const url = `${src.split('?')[0]}?az-fixture=${encodeURIComponent(f.name)}`;
    const match = (u) => u.href === url;
    const serve = (route) => route.fulfill({ body: f.bytes, contentType: f.type });
    await page.route(match, serve);
    const shown = await page.evaluate(async ({ q, url }) => {
      const img = document.querySelector(q);
      img.src = url;
      try { await img.decode(); } catch { return 'did not decode'; }
      return getComputedStyle(img).visibility === 'hidden' || img.getClientRects().length === 0 ? 'is not on screen' : '';
    }, { q: sel.poster, url }).finally(() => page.unroute(match, serve));
    if (shown) { problems.push(`${f.name}: the poster ${shown}`); continue; }
    const measured = await textContrast(page, sel.text);
    problems.push(...measured.problems.map((p) => `${f.name}: ${p}`));
    worst = Math.min(worst, measured.worst);
  }
  return {
    pass: problems.length === 0,
    detail: problems.length ? `under ${TEXT_CONTRAST}:1 — ${problems.join('; ')}` : `worst ${worst}:1`,
  };
}

/**
 * theme-spec §13: an accent pair fills `sel` (the primary action) with its
 * gradient, and the label keeps 4.5:1 over every pixel of it. axe cannot
 * judge text over a background image (it reports "incomplete"), so the
 * pixels are measured, as textOverPoster does.
 */
export async function gradientLabel(page, sel) {
  const image = await page.evaluate((q) => {
    const el = document.querySelector(q);
    return el ? getComputedStyle(el).backgroundImage : null;
  }, sel);
  if (image === null) return { pass: false, detail: `no ${sel} on the page` };
  if (!/gradient/.test(image)) return { pass: false, detail: `${sel} paints no gradient (${image})` };
  const measured = await textContrast(page, [sel]);
  return {
    pass: measured.problems.length === 0,
    detail: measured.problems.length ? `under ${TEXT_CONTRAST}:1 — ${measured.problems.join('; ')}` : `worst ${measured.worst}:1`,
  };
}

/** The alpha of a computed colour: `rgba(…, a)` / `rgb(… / a)`, 1 when none is written. */
const alphaOf = (colour) => {
  if (colour === 'transparent') return 0;
  const n = (colour.match(/[\d.]+/g) ?? []).map(Number);
  return n.length === 4 ? n[3] : 1;
};

/**
 * theme-spec §13: under forced colours the gradient is dropped, and `sel`
 * must still show an edge — a border at least 1px wide, opaque, and a
 * different colour from its own background. The page must already be
 * emulating `forced-colors: active`.
 */
export async function forcedEdge(page, sel) {
  const r = await page.evaluate((q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      forced: matchMedia('(forced-colors: active)').matches,
      width: parseFloat(cs.borderTopWidth), border: cs.borderTopColor, fill: cs.backgroundColor, image: cs.backgroundImage,
    };
  }, sel);
  if (r === null) return { pass: false, detail: `no ${sel} on the page` };
  const problems = [];
  if (!r.forced) problems.push('the page is not in forced colours');
  if (r.width < 1) problems.push(`border ${r.width}px`);
  if (alphaOf(r.border) === 0) problems.push(`border colour ${r.border} is transparent`);
  if (r.border === r.fill) problems.push(`border and fill are both ${r.fill}`);
  return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : `edge ${r.border} on ${r.fill}, image ${r.image}` };
}

/** An image request: held back by imageShift until the page has settled. */
const IMAGE_URL = /\.(?:webp|png|jpe?g|avif|gif|svg)(?:[?#]|$)/i;
/** How long the released images get to arrive; they come from a local server. */
const IMAGES_ARRIVE_MS = 15_000;

/**
 * gallery-spec §7 rule 1 — CLS 0: an image arriving late moves nothing.
 *
 * Every image response is HELD until the page has rendered and hydrated with
 * none of them, as on a slow network; lazy images are made eager so the ones
 * below the fold are tested too. Then all are released at once, and two
 * things are read across their arrival:
 *   - each <img>'s box, before and after: an image without width/height is
 *     a 0×0 (or alt-text) box until its bytes land, then its file's size —
 *     measured for every image, on screen or not
 *   - the browser's own layout-shift entries (CLS) from release to the end
 * Either one moving fails. A page with no image passes as not applicable.
 * Opens its own context: the hold is a route on it.
 */
export async function imageShift(browser, url, readySelector) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await answerPreviewBackend(ctx);
  let release = () => {};
  const released = new Promise((done) => { release = done; });
  try {
    await ctx.route(IMAGE_URL, async (route) => {
      await released;
      await route.continue().catch(() => {});   // the context may already be closing
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(readySelector, { state: 'attached' });
    await page.waitForTimeout(SCROLL_SETTLE_MS);
    const before = await page.evaluate(() => {
      window.__azShift = { score: 0, moved: [] };
      // Not buffered: only shifts from the release on count.
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__azShift.score += e.value;
          for (const s of e.sources ?? []) {
            const n = s.node;
            window.__azShift.moved.push(n && n.nodeType === 1 ? `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(/\s+/)[0]}` : '#text');
          }
        }
      }).observe({ type: 'layout-shift' });
      return [...document.images].map((img) => {
        img.loading = 'eager';
        const r = img.getBoundingClientRect();
        return { src: img.getAttribute('src') ?? '', w: r.width, h: r.height };
      });
    });
    if (before.length === 0) return { pass: true, detail: 'no images' };
    release();
    const arrived = await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: IMAGES_ARRIVE_MS })
      .then(() => true, () => false);
    // Two frames and a settle, so the observer has delivered every entry.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.waitForTimeout(SCROLL_SETTLE_MS);
    const after = await page.evaluate(() => ({
      boxes: [...document.images].map((img) => { const r = img.getBoundingClientRect(); return { w: r.width, h: r.height }; }),
      shift: window.__azShift,
    }));
    const resized = before
      .map((b, i) => ({ ...b, a: after.boxes[i] }))
      .filter((x) => x.a && (Math.abs(x.a.w - x.w) > 0.5 || Math.abs(x.a.h - x.h) > 0.5))
      .map((x) => `${x.src} ${Math.round(x.w)}×${Math.round(x.h)} → ${Math.round(x.a.w)}×${Math.round(x.a.h)}`);
    const problems = [
      ...(arrived ? [] : [`images still loading after ${IMAGES_ARRIVE_MS / 1000}s`]),
      ...resized.map((r) => `resized on arrival: ${r}`),
      ...(after.shift.score > 0 ? [`layout shift ${after.shift.score.toFixed(4)} (moved: ${[...new Set(after.shift.moved)].join(', ') || '?'})`] : []),
    ];
    return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : `${before.length} images, CLS 0` };
  } finally {
    release();
    await ctx.close();
  }
}
