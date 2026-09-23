/**
 * Browser checks for the behaviour runtime — overlays-spec §2 and §6,
 * nav-block-spec §4, §6 and §7, faq-block-spec §7 and §8, buttons §1.3.
 *
 * Each takes a Playwright page already at the site under test, returns
 * { pass, detail }, and returns null when the page has nothing it applies
 * to. The self-test proves every one can fail as well as pass. Every wait is
 * bounded by WAIT_MS: a behaviour that never happens is a failure, not a hang.
 */

/** The longest a behaviour may take to show — an exit transition plus slack. */
const WAIT_MS = 2000;
/** Tab presses inside an open modal: more than it has controls, so a leak shows. */
const TRAP_TABS = 12;

const until = (page, fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: WAIT_MS }).then(() => true, () => false);

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
}, sel);

/**
 * nav §6: the menu is a dialog — Enter opens it, focus moves in and cannot
 * leave, the page behind cannot scroll, Escape closes it and focus returns
 * to the toggle; a click outside closes it too.
 */
export async function drawer(page) {
  if (!(await visible(page, '.az-nav-toggle'))) return null;
  const problems = [];
  await page.focus('.az-nav-toggle');
  await page.keyboard.press('Enter');
  if (!(await until(page, () => document.querySelector('#az-nav-panel')?.open === true))) {
    return { pass: false, detail: 'Enter on the toggle did not open the menu' };
  }
  const opened = await page.evaluate(() => ({
    expanded: document.querySelector('.az-nav-toggle').getAttribute('aria-expanded'),
    focusInside: document.querySelector('#az-nav-panel').contains(document.activeElement),
    locked: getComputedStyle(document.body).position === 'fixed',
  }));
  if (opened.expanded !== 'true') problems.push('aria-expanded stayed false');
  if (!opened.focusInside) problems.push('focus did not move into the menu');
  if (!opened.locked) problems.push('the page behind was not scroll-locked');
  for (let i = 0; i < TRAP_TABS; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.querySelector('#az-nav-panel').contains(document.activeElement));
    if (!inside) { problems.push(`focus escaped the menu after ${i + 1} Tab(s)`); break; }
  }
  await page.keyboard.press('Escape');
  if (!(await until(page, () => document.querySelector('#az-nav-panel')?.open === false))) {
    problems.push('Escape did not close the menu');
  } else {
    const closed = await page.evaluate(() => ({
      focusBack: document.activeElement === document.querySelector('.az-nav-toggle'),
      expanded: document.querySelector('.az-nav-toggle').getAttribute('aria-expanded'),
      unlocked: getComputedStyle(document.body).position !== 'fixed',
    }));
    if (!closed.focusBack) problems.push('focus did not return to the toggle');
    if (closed.expanded !== 'false') problems.push('aria-expanded stayed true');
    if (!closed.unlocked) problems.push('the scroll lock was left on');
  }
  // Outside click: the backdrop, at the far edge of the viewport.
  await page.click('.az-nav-toggle');
  if (await until(page, () => document.querySelector('#az-nav-panel')?.open === true)) {
    const size = page.viewportSize();
    await page.mouse.click(size.width - 4, size.height / 2);
    if (!(await until(page, () => document.querySelector('#az-nav-panel')?.open === false))) {
      problems.push('a click outside did not close the menu');
    }
  }
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * overlays §6 + nav §7: a nav dropdown opens from its button, arrow keys
 * move through its links (one in the tab order at a time), Escape closes it
 * and returns focus, and Tab leaves it — it does not trap.
 */
export async function dropdown(page) {
  const button = '[data-az-behaviour="dropdown"] > button';
  if (!(await visible(page, button))) return null;
  const problems = [];
  await page.focus(button);
  await page.keyboard.press('ArrowDown');
  const open = await until(page, (b) => {
    const list = document.getElementById(document.querySelector(b).getAttribute('aria-controls'));
    return !list.hidden && list.querySelector('a') === document.activeElement;
  }, button);
  if (!open) return { pass: false, detail: 'ArrowDown did not open the list and focus its first link' };
  await page.keyboard.press('ArrowDown');
  const second = await page.evaluate((b) => {
    const list = document.getElementById(document.querySelector(b).getAttribute('aria-controls'));
    const links = [...list.querySelectorAll('a')];
    return {
      index: links.indexOf(document.activeElement),
      roving: links.filter((a) => a.getAttribute('tabindex') === '0').length,
      expanded: document.querySelector(b).getAttribute('aria-expanded'),
    };
  }, button);
  if (second.index !== 1) problems.push(`ArrowDown moved to link ${second.index}, not the second`);
  if (second.roving !== 1) problems.push(`${second.roving} links in the tab order, not one (roving tabindex)`);
  if (second.expanded !== 'true') problems.push('aria-expanded stayed false while open');
  await page.keyboard.press('Escape');
  const escaped = await until(page, (b) => {
    const btn = document.querySelector(b);
    return document.getElementById(btn.getAttribute('aria-controls')).hidden && document.activeElement === btn;
  }, button);
  if (!escaped) problems.push('Escape did not close the list and return focus to its button');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  const left = await until(page, (b) => {
    const btn = document.querySelector(b);
    const list = document.getElementById(btn.getAttribute('aria-controls'));
    return list.hidden && !btn.parentElement.contains(document.activeElement);
  }, button);
  if (!left) problems.push('Tab did not leave and close the list (a dropdown must not trap)');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * nav §4: transparent at the top, solid past 80px, and back only above 40px
 * — with the light logo shown at the top and the regular one once solid.
 */
export async function solid(page) {
  if (!(await page.$('[data-az-behaviour="solid"]'))) return null;
  // Room to scroll whatever the preview's height; the check is the bar's.
  await page.evaluate(() => { document.body.style.minHeight = '3000px'; });
  const state = () => page.evaluate(() => {
    const nav = document.querySelector('[data-az-behaviour="solid"]');
    const shown = [...nav.querySelectorAll('[data-az-logo]')].filter((i) => getComputedStyle(i).display !== 'none');
    return { scrolled: nav.getAttribute('data-scrolled'), bg: getComputedStyle(nav).backgroundColor, logos: shown.map((i) => i.getAttribute('data-az-logo')) };
  });
  const at = async (y) => {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(50);
    return state();
  };
  const problems = [];
  const top = await at(0);
  const down = await at(200);
  const between = await at(60);
  const back = await at(20);
  if (top.scrolled !== 'false') problems.push(`at the top the bar is '${top.scrolled}', not transparent`);
  if (down.scrolled !== 'true') problems.push('past 80px the bar did not turn solid');
  if (down.bg === top.bg) problems.push('solid and transparent paint the same background');
  if (between.scrolled !== 'true') problems.push('at 60px on the way up it flipped back — no hysteresis');
  if (back.scrolled !== 'false') problems.push('above 40px it did not turn transparent again');
  if (top.logos.length === 2 || down.logos.length === 2) problems.push('two logos shown at once');
  if (top.logos[0] === 'top' && down.logos[0] !== 'solid') problems.push('the regular logo did not replace the light one');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * faq §7.3/§8: every answer collapses to hidden="until-found" on load, a
 * question's button toggles its answer and aria-expanded together, arrow
 * keys move between questions, and find-in-page opens a hidden answer.
 */
export async function faq(page) {
  if (!(await page.$('[data-az-behaviour="faq"]'))) return null;
  const problems = [];
  const loaded = await page.evaluate(() => [...document.querySelectorAll('[data-az-disclosure]')].map((b) => ({
    expanded: b.getAttribute('aria-expanded'),
    hidden: document.getElementById(b.getAttribute('aria-controls'))?.getAttribute('hidden'),
  })));
  if (loaded.length < 2) return { pass: false, detail: 'fewer than two questions to test with' };
  if (loaded.some((q) => q.expanded !== 'false' || q.hidden !== 'until-found')) {
    problems.push('answers were not collapsed to hidden="until-found" on load');
  }
  await page.click('[data-az-disclosure]');
  const clicked = await page.evaluate(() => {
    const b = document.querySelector('[data-az-disclosure]');
    const panel = document.getElementById(b.getAttribute('aria-controls'));
    return { expanded: b.getAttribute('aria-expanded'), shown: !panel.hasAttribute('hidden') && panel.getBoundingClientRect().height > 0,
      chevron: b.querySelector('[data-az-chevron]')?.getAttribute('data-state') };
  });
  if (clicked.expanded !== 'true' || !clicked.shown) problems.push('clicking a question did not open its answer');
  if (clicked.chevron !== 'open') problems.push('the chevron did not follow aria-expanded');
  await page.keyboard.press('ArrowDown');
  const moved = await page.evaluate(() => document.activeElement === document.querySelectorAll('[data-az-disclosure]')[1]);
  if (!moved) problems.push('ArrowDown did not move to the next question');
  // Find-in-page: the browser reveals hidden="until-found" and fires
  // beforematch. Playwright cannot press the browser's own Ctrl+F, and
  // window.find() does not reveal; a text-fragment navigation is the same
  // browser path (probed: it reveals and fires beforematch), so it is used.
  const second = await page.evaluate(() => {
    const b = document.querySelectorAll('[data-az-disclosure]')[1];
    const panel = document.getElementById(b.getAttribute('aria-controls'));
    return (panel.textContent ?? '').trim().split(/\s+/).slice(0, 3).join(' ');
  });
  await page.evaluate((words) => { location.href = `#:~:text=${encodeURIComponent(words)}`; }, second);
  await page.waitForTimeout(300);
  const found = await page.evaluate(() => {
    const b = document.querySelectorAll('[data-az-disclosure]')[1];
    const panel = document.getElementById(b.getAttribute('aria-controls'));
    return { expanded: b.getAttribute('aria-expanded'), hidden: panel.hasAttribute('hidden') };
  });
  if (found.hidden || found.expanded !== 'true') problems.push('find-in-page did not open the answer it found');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/** buttons §1.3: copy puts the text on the clipboard and says so, politely. */
export async function copy(page) {
  const button = '[data-az-behaviour="copy"]';
  if (!(await visible(page, button))) return null;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const expected = await page.$eval(button, (b) => b.getAttribute('data-az-target').replace(/^copy:/i, ''));
  await page.click(button);
  const said = await until(page, () => document.querySelector('[role="status"][aria-live="polite"]')?.textContent === 'Copied');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  const problems = [];
  if (!said) problems.push('no polite "Copied" announcement');
  if (clipboard !== expected) problems.push(`clipboard holds ${JSON.stringify(clipboard)}, not ${JSON.stringify(expected)}`);
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/** overlays §2/§4: play opens the video popup modally; Escape closes it, focus returns, the film stops. */
export async function play(page) {
  const button = '[data-az-behaviour="play"][aria-haspopup="dialog"]';
  if (!(await visible(page, button))) return null;
  const problems = [];
  await page.focus(button);
  await page.keyboard.press('Enter');
  const opened = await until(page, (b) => document.querySelector(b).nextElementSibling?.open === true, button);
  if (!opened) return { pass: false, detail: 'the play button did not open its popup' };
  const inside = await page.evaluate((b) => {
    const d = document.querySelector(b).nextElementSibling;
    return { focus: d.contains(document.activeElement), video: !!d.querySelector('video[controls]') };
  }, button);
  if (!inside.focus) problems.push('focus did not move into the popup');
  if (!inside.video) problems.push('the popup has no player with controls');
  await page.keyboard.press('Escape');
  const closed = await until(page, (b) => {
    const btn = document.querySelector(b);
    return btn.nextElementSibling.open === false && document.activeElement === btn;
  }, button);
  if (!closed) problems.push('Escape did not close the popup and return focus to the button');
  const paused = await page.$eval(button, (b) => b.nextElementSibling.querySelector('video').paused);
  if (!paused) problems.push('the film kept playing after the popup closed');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * theme §9.3 for overlays: under reduced motion an overlay may fade but
 * never slide — no transform transition runs while one opens.
 */
export async function overlayMotion(page) {
  const trigger = (await visible(page, '.az-nav-toggle')) ? '.az-nav-toggle'
    : (await visible(page, '[data-az-behaviour="play"][aria-haspopup="dialog"]')) ? '[data-az-behaviour="play"][aria-haspopup="dialog"]' : null;
  if (!trigger) return null;
  await page.click(trigger);
  await page.waitForTimeout(30);
  const sliding = await page.evaluate(() => document.getAnimations()
    .filter((a) => a.transitionProperty === 'transform' || a.transitionProperty === 'translate' || a.transitionProperty === 'scale').length);
  await page.keyboard.press('Escape');
  return { pass: sliding === 0, detail: sliding === 0 ? '' : `${sliding} transform transition(s) ran under reduced motion` };
}

/** Scroll to `y` and let scroll handlers and a transition settle. */
const settleAt = async (page, y, ms = 400) => {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(ms);
};

/**
 * nav §3 `shrink`: past the threshold the bar is shorter, with the same
 * hysteresis as `solid`, and NOTHING below it moves — the final height is
 * reserved up front. `hide`: scrolling down moves the bar out of view,
 * scrolling up brings it back, and focus inside it brings it back too.
 */
export async function hideShrink(page) {
  const sel = '[data-az-hide], [data-az-shrink]';
  if (!(await page.$(sel))) return null;
  await page.evaluate(() => { document.body.style.minHeight = '4000px'; });
  const state = () => page.evaluate((s) => {
    const nav = document.querySelector(s);
    const r = nav.getBoundingClientRect();
    const main = document.querySelector('main');
    return {
      height: r.height, top: r.top, bottom: r.bottom,
      // Where the content below starts, in document terms: must never move.
      mainAt: main.getBoundingClientRect().top + window.scrollY,
      hides: nav.hasAttribute('data-az-hide'), shrinks: nav.hasAttribute('data-az-shrink'),
    };
  }, sel);
  const problems = [];
  await settleAt(page, 0);
  const top = await state();
  if (top.shrinks) {
    await settleAt(page, 200);
    const down = await state();
    await settleAt(page, 60);
    const between = await state();
    await settleAt(page, 20);
    const back = await state();
    if (!(down.height < top.height)) problems.push(`past 80px the bar did not shrink (${top.height} -> ${down.height})`);
    if (between.height !== down.height) problems.push('at 60px on the way up it grew back — no hysteresis');
    if (back.height !== top.height) problems.push('near the top it did not return to full height');
    if ([down, between, back].some((s) => s.mainAt !== top.mainAt)) {
      problems.push(`the content below moved as the bar changed (${[top, down, between, back].map((s) => s.mainAt).join(', ')})`);
    }
  }
  if (top.hides) {
    await settleAt(page, 0, 100);
    // A run of travel down, in steps, as a reader scrolls.
    for (const y of [150, 300, 450, 600]) await settleAt(page, y, 60);
    await page.waitForTimeout(400);
    const hidden = await state();
    if (hidden.bottom > 0) problems.push(`scrolling down did not move the bar out of view (bottom at ${hidden.bottom})`);
    await settleAt(page, 560);
    const shown = await state();
    if (shown.top < 0 || shown.bottom <= 0) problems.push('scrolling up did not bring the bar back');
    for (const y of [700, 850, 1000]) await settleAt(page, y, 60);
    await page.waitForTimeout(400);
    // A real link of the bar — not the skip link, which is off-screen until
    // keyboard focus shows it. `:is()`, or the comma splits the selector.
    await page.focus(`:is(${sel}) a[href]:not(.az-skip-link)`);
    await page.waitForTimeout(400);
    const focused = await state();
    if (focused.top < 0 || focused.bottom <= 0) problems.push('focus inside the hidden bar did not bring it back');
  }
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * nav §3: `hide` "must be instant under reduced-motion" — and the shrink
 * does not animate either. Run in a reduced-motion context.
 */
export async function navMotion(page) {
  const sel = '[data-az-hide], [data-az-shrink]';
  if (!(await page.$(sel))) return null;
  await page.evaluate(() => { document.body.style.minHeight = '4000px'; });
  let moving = 0;
  for (const y of [150, 300, 450, 600]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(30);
    moving += await page.evaluate((s) => document.getAnimations()
      .filter((a) => document.querySelector(s).contains(a.effect?.target ?? null)).length, sel);
  }
  return { pass: moving === 0, detail: moving === 0 ? '' : `${moving} transition(s) ran on the bar under reduced motion` };
}

/**
 * nav §5, "the universal bug": with a pinned nav, an anchor jump lands its
 * target below the bar, not under it.
 */
export async function scrollPadding(page) {
  const pinned = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    if (!nav) return false;
    const pin = (el) => el && ['sticky', 'fixed'].includes(getComputedStyle(el).position);
    return pin(nav) || pin(nav.parentElement);
  });
  if (!pinned) return null;
  await page.evaluate(() => {
    document.body.style.minHeight = '4000px';
    const target = document.createElement('h2');
    target.id = 'az-probe-target';
    target.textContent = 'Anchor target';
    target.style.marginTop = '2000px';
    document.querySelector('main').append(target);
    location.hash = 'az-probe-target';
  });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    target: document.getElementById('az-probe-target').getBoundingClientRect().top,
    bar: document.querySelector('nav[aria-label="Main"]').getBoundingClientRect().bottom,
  }));
  const pass = r.target >= r.bar;
  return { pass, detail: pass ? '' : `the anchor target landed at ${Math.round(r.target)}px, under the bar ending at ${Math.round(r.bar)}px` };
}
