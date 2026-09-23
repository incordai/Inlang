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

/*
 * Every scroll here is `behavior: 'instant'`: sites smooth-scroll for readers
 * who have not asked for reduced motion, and these checks test what the bar
 * does at a position, not how long the page takes to glide there.
 */
/** Tab presses inside an open modal: more than it has controls, so a leak shows. */
const TRAP_TABS = 12;

const until = (page, fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: WAIT_MS }).then(() => true, () => false);

/**
 * Close a modal with `close()` and record, every frame for a while after it
 * shut, the lowest scroll offset seen. A restore that jumps to the top and
 * glides back (or is cut short) shows as a low minimum.
 */
async function scrollWhileClosing(page, dialogSel, close) {
  await page.evaluate((d) => {
    const dialog = document.querySelector(d);
    window.__azScroll = { min: Infinity, done: false, until: performance.now() + 1200 };
    const tick = () => {
      const w = window.__azScroll;
      if (!dialog.open) w.min = Math.min(w.min, window.scrollY);
      if (performance.now() < w.until) requestAnimationFrame(tick);
      else w.done = true;
    };
    requestAnimationFrame(tick);
  }, dialogSel);
  await close();
  await page.waitForFunction(() => window.__azScroll.done, undefined, { timeout: WAIT_MS * 2 });
  return page.evaluate(() => ({ min: window.__azScroll.min, y: window.scrollY }));
}

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
  problems.push(...await drawerDetails(page));
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/** Open the menu without the scroll a Playwright click would make first. */
async function openDrawer(page) {
  await until(page, () => document.querySelector('#az-nav-panel')?.open === false);
  await page.$eval('.az-nav-toggle', (b) => b.click());
  return until(page, () => document.querySelector('#az-nav-panel')?.open === true);
}

/**
 * overlays §2/§6 in detail: a click in the menu's own padding is not the
 * backdrop; Shift+Tab from the dialog itself goes to the LAST control;
 * closing restores the page where it was without a jump to the top; and a
 * link to a part of this page gets there once the menu has closed.
 */
async function drawerDetails(page) {
  const problems = [];
  await page.evaluate(() => { document.body.style.minHeight = '3000px'; });

  if (await openDrawer(page)) {
    // After the entrance: mid-slide the box is still off-screen.
    await page.waitForTimeout(500);
    // Low in the part of the box that is on screen: a drawer's box can run
    // past the viewport's bottom edge.
    const box = await page.$eval('#az-nav-panel', (d) => {
      const r = d.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: Math.min(r.bottom, innerHeight) - 6 };
    });
    // Only a point with nothing of the menu's own under it is its padding.
    const empty = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#az-nav-panel'), box);
    if (empty) {
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(400);
      if (!(await page.$eval('#az-nav-panel', (d) => d.open))) problems.push('a click inside the menu (its padding) closed it');
    }
  }
  if (await page.$eval('#az-nav-panel', (d) => d.open)) {
    // Focus on the dialog itself — not one of its stops — as after a click
    // on its empty area.
    await page.evaluate(() => {
      const d = document.querySelector('#az-nav-panel');
      d.setAttribute('tabindex', '-1');
      d.focus();
    });
    await page.keyboard.press('Shift+Tab');
    const onLast = await page.evaluate(() => {
      const d = document.querySelector('#az-nav-panel');
      d.removeAttribute('tabindex');
      const stops = [...d.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.getClientRects().length > 0);
      return document.activeElement === stops[stops.length - 1];
    });
    if (!onLast) problems.push('Shift+Tab from the menu itself did not go to its last control');
    await page.keyboard.press('Escape');
  }

  // Close from part-way down the page: the page must stay where it was.
  await until(page, () => document.querySelector('#az-nav-panel')?.open === false);
  // A short page stops short of 300: the baseline is where it actually is.
  // Focus returns to the toggle; a toggle that scrolled away with a static
  // bar is brought back into view (as a native dialog's focus return does),
  // so the page ends where it was only when the toggle was still on screen.
  await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
  await page.waitForTimeout(100);
  const from = await page.evaluate(() => window.scrollY);
  const toggleShown = await page.$eval('.az-nav-toggle', (b) => {
    const r = b.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  });
  if (from > 0 && await openDrawer(page)) {
    const r = await scrollWhileClosing(page, '#az-nav-panel', () => page.keyboard.press('Escape'));
    const toggleAfter = await page.$eval('.az-nav-toggle', (b) => {
      const box = b.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight;
    });
    // Never a jump to the top on the way: the lowest point is where it ended.
    if (r.min < r.y - 2) {
      problems.push(`closing the menu jumped the page (lowest ${Math.round(r.min)}, ended ${Math.round(r.y)}, was ${Math.round(from)})`);
    } else if (toggleShown && Math.abs(r.y - from) > 2) {
      problems.push(`closing the menu moved the page (ended ${Math.round(r.y)}, was ${Math.round(from)})`);
    } else if (!toggleShown && !toggleAfter) {
      problems.push(`closing the menu left focus on a toggle off screen (ended ${Math.round(r.y)})`);
    }
  }

  // A link to a part of THIS page, if the menu has one whose target exists.
  const anchor = await page.evaluate(() => {
    const a = [...document.querySelectorAll('#az-nav-panel a[href^="#"]')]
      .find((l) => l.hash.length > 1 && document.getElementById(decodeURIComponent(l.hash.slice(1))));
    return a ? a.getAttribute('href') : null;
  });
  if (anchor) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    if (await openDrawer(page)) {
      await page.click(`#az-nav-panel a[href="${anchor}"]`);
      const arrived = await until(page, (h) => {
        const t = document.getElementById(decodeURIComponent(h.slice(1)));
        const r = t.getBoundingClientRect();
        return !document.querySelector('#az-nav-panel').open && r.top >= 0 && r.top < innerHeight && window.scrollY > 0;
      }, anchor);
      if (!arrived) problems.push(`the menu link ${anchor} did not take the page to its target`);
    }
  }
  return problems;
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
  // The list stays in the layout for its exit transition: `hidden` comes
  // after it, not with aria-expanded (overlays-spec §3).
  await page.evaluate((b) => {
    const btn = document.querySelector(b);
    const list = document.getElementById(btn.getAttribute('aria-controls'));
    window.__azExit = { collapsed: null, hidden: null };
    new MutationObserver(() => {
      if (window.__azExit.collapsed === null && btn.getAttribute('aria-expanded') === 'false') window.__azExit.collapsed = performance.now();
      if (window.__azExit.hidden === null && list.hidden) window.__azExit.hidden = performance.now();
    }).observe(btn.parentElement, { attributes: true, subtree: true, attributeFilter: ['aria-expanded', 'hidden'] });
  }, button);
  await page.keyboard.press('Escape');
  const escaped = await until(page, (b) => {
    const btn = document.querySelector(b);
    return document.getElementById(btn.getAttribute('aria-controls')).hidden && document.activeElement === btn;
  }, button);
  if (!escaped) problems.push('Escape did not close the list and return focus to its button');
  else {
    const exit = await page.evaluate((b) => {
      const list = document.getElementById(document.querySelector(b).getAttribute('aria-controls'));
      // The closed state's transition — what the exit runs.
      list.hidden = false;
      const cs = getComputedStyle(list);
      const ms = (v) => (v.trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000) || 0;
      const longest = Math.max(...cs.transitionDuration.split(',').map(ms));
      list.hidden = true;
      return { longest, gap: window.__azExit.hidden - window.__azExit.collapsed };
    }, button);
    if (exit.longest >= 100 && !(exit.gap >= exit.longest * 0.5)) {
      problems.push(`the list was hidden ${Math.round(exit.gap)}ms after closing, before its ${exit.longest}ms exit could run`);
    }
  }
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
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
    await page.waitForTimeout(50);
    return state();
  };
  const problems = [];
  const top = await at(0);
  // §4: over a full or 3D hero the bar is transparent ON the hero — the hero
  // starts at the top of the page, under the bar, and the bar stays on top.
  const over = await page.evaluate(() => {
    const hero = document.querySelector('main > :first-child:is(.az-hero--full, [data-az-3d-host])');
    if (!hero) return null;
    const nav = document.querySelector('[data-az-behaviour="solid"]');
    const r = nav.getBoundingClientRect();
    const onTop = nav.contains(document.elementFromPoint(r.left + 4, r.top + r.height / 2));
    return { heroTop: hero.getBoundingClientRect().top, onTop };
  });
  if (over && over.heroTop > 0.5) problems.push(`the hero starts ${Math.round(over.heroTop)}px down, below the bar — not under it`);
  if (over && !over.onTop) problems.push('the hero paints over the bar');
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
  // Arrow keys are for keyboard users, who reach a question with Tab. A
  // mouse click does not focus a button in WebKit (as in Safari).
  await page.focus('[data-az-disclosure]');
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
  // A malformed fragment (`#%E0%A4`) must not stop the runtime: the answers
  // still collapse, as they do on any other arrival.
  const url = new URL(page.url());
  url.hash = '';
  // A fresh load: the same URL with only a new fragment would be a jump
  // within the page, and nothing would run again.
  await page.goto('about:blank');
  await page.goto(`${url.href}#%E0%A4`, { waitUntil: 'load' });
  if (await page.$('#root')) await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(300);
  const malformed = await page.evaluate(() => [...document.querySelectorAll('[data-az-disclosure]')]
    .every((b) => b.getAttribute('aria-expanded') === 'false'));
  if (!malformed) problems.push('with a malformed #fragment in the address the answers were never collapsed (the runtime stopped)');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/** buttons §1.3: copy puts the text on the clipboard and says so, politely. */
export async function copy(page) {
  const button = '[data-az-behaviour="copy"]';
  if (!(await visible(page, button))) return null;
  const expected = await page.$eval(button, (b) => b.getAttribute('data-az-target').replace(/^copy:/i, ''));
  // Chromium lets a test read the clipboard back. Firefox and WebKit have no
  // clipboard permission a test can grant, so there the check records what
  // the runtime hands the real writeText — still calling it through.
  const readable = await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).then(() => true, () => false);
  if (!readable) {
    await page.evaluate(() => {
      const real = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => { window.__azCopied = text; return real(text); };
    });
  }
  await page.click(button);
  const said = await until(page, () => document.querySelector('[role="status"][aria-live="polite"]')?.textContent === 'Copied');
  const clipboard = await page.evaluate((r) => (r ? navigator.clipboard.readText().catch(() => null) : window.__azCopied ?? null), readable);
  const problems = [];
  if (!said) problems.push('no polite "Copied" announcement');
  if (clipboard !== expected) problems.push(`clipboard holds ${JSON.stringify(clipboard)}, not ${JSON.stringify(expected)}`);
  // A second copy must be heard too: the region has to change, so it is
  // emptied for a moment first — setting the same text again is no change.
  if (said) {
    await page.evaluate(() => {
      const region = document.querySelector('[role="status"][aria-live="polite"]');
      window.__azSaid = [];
      const until = performance.now() + 600;
      const tick = () => { window.__azSaid.push(region.textContent); if (performance.now() < until) setTimeout(tick, 5); };
      tick();
    });
    await page.click(button);
    await page.waitForTimeout(700);
    const seq = await page.evaluate(() => window.__azSaid);
    const emptied = seq.indexOf('');
    if (emptied < 0 || !seq.slice(emptied).includes('Copied')) problems.push('a second copy was not announced again (the region never changed)');
  }
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
  await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
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
    problems.push(...await modalIsNotAScroll(page, sel));
  }
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * A modal locks the page (scrollY reads 0) and unlocks it (scrollY jumps
 * back). Neither is the reader scrolling: a shown bar stays shown after a
 * lightbox or video closes, and a solid bar stays solid while one is open.
 */
async function modalIsNotAScroll(page, sel) {
  const trigger = await page.evaluate(() => {
    const t = document.querySelector('[data-az-behaviour="play"][aria-haspopup="dialog"], [data-az-behaviour="lightbox"] button[data-az-index]');
    return t ? (t.matches('[data-az-behaviour="play"]') ? '[data-az-behaviour="play"][aria-haspopup="dialog"]' : '[data-az-behaviour="lightbox"] button[data-az-index]') : null;
  });
  if (!trigger) return [];
  const problems = [];
  await settleAt(page, 0, 100);
  for (const y of [150, 300, 450, 600]) await settleAt(page, y, 60);
  await settleAt(page, 560);
  const bar = () => page.evaluate((s) => {
    const nav = document.querySelector(s);
    return { retracted: nav.getAttribute('data-retracted'), scrolled: nav.getAttribute('data-scrolled') };
  }, sel);
  const before = await bar();
  if (before.retracted !== 'false') return ['could not bring the bar back before opening a modal'];
  const dialogOf = (t) => (t.startsWith('[data-az-behaviour="play"]')
    ? `${t} + dialog` : '[data-az-behaviour="lightbox"] dialog');
  await page.$eval(trigger, (b) => b.click());
  if (!(await until(page, (d) => document.querySelector(d)?.open === true, dialogOf(trigger)))) return ['the modal did not open'];
  await page.waitForTimeout(200);
  const during = await bar();
  if (before.scrolled === 'true' && during.scrolled !== 'true') problems.push('the solid bar turned transparent while a modal was open');
  await page.keyboard.press('Escape');
  await until(page, (d) => document.querySelector(d)?.open === false, dialogOf(trigger));
  await page.waitForTimeout(400);
  const after = await bar();
  if (after.retracted !== 'false') problems.push('the bar hid itself after a modal closed, though the reader had not scrolled');
  return problems;
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
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
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
    // Where the page's content lives: <main>. The nav sits before it — and on
    // a `side` page <main> is the content column beside the nav's column
    // (nav-spec §10 Q2) — so the probe never lands in the nav.
    document.querySelector('main').append(target);
    location.hash = 'az-probe-target';
  });
  await page.waitForTimeout(300);
  // Obscured means the nav's box and the target's box overlap. A top bar
  // spans the width, so that is "the target starts above the bar's bottom";
  // a side column beside the content never covers it.
  const r = await page.evaluate(() => {
    const t = document.getElementById('az-probe-target').getBoundingClientRect();
    const n = document.querySelector('nav[aria-label="Main"]').getBoundingClientRect();
    const overlaps = t.left < n.right && n.left < t.right && t.top < n.bottom && n.top < t.bottom;
    return { target: t.top, bar: n.bottom, overlaps };
  });
  const pass = !r.overlaps;
  return { pass, detail: pass ? '' : `the anchor target landed at ${Math.round(r.target)}px, under the bar ending at ${Math.round(r.bar)}px` };
}

/**
 * faq §7.3/§7.4 on arrival: a text-fragment link (`#:~:text=`) into an answer
 * the runtime collapsed on load must still land on it — the browser reveals
 * hidden="until-found" and fires `beforematch`, and the question follows.
 * A fresh load, as when the link is followed from elsewhere.
 */
export async function faqDeepLink(page) {
  if (!(await page.$('[data-az-behaviour="faq"]'))) return null;
  const words = await page.evaluate(() => {
    const b = document.querySelectorAll('[data-az-disclosure]')[1];
    const panel = b && document.getElementById(b.getAttribute('aria-controls'));
    return panel ? (panel.textContent ?? '').trim().split(/\s+/).slice(0, 3).join(' ') : null;
  });
  if (!words) return { pass: false, detail: 'fewer than two questions to test with' };
  const url = new URL(page.url());
  url.hash = '';
  await page.goto(`${url.href}#:~:text=${encodeURIComponent(words)}`, { waitUntil: 'load' });
  // A site renders after `load`; the self-test pages are static (no #root).
  if (await page.$('#root')) await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => [...document.querySelectorAll('[data-az-disclosure]')].map((b) => ({
    expanded: b.getAttribute('aria-expanded'),
    hidden: document.getElementById(b.getAttribute('aria-controls')).hasAttribute('hidden'),
  })));
  const problems = [];
  if (r[1].hidden || r[1].expanded !== 'true') problems.push('the linked answer stayed collapsed');
  if (r.filter((q, i) => i !== 1).some((q) => !q.hidden)) problems.push('answers not linked to were left open');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * gallery §6/§10: a carousel's previous/next buttons — at the start
 * "previous" says it cannot go (aria-disabled), "next" scrolls the track by
 * a slide, and at the end "next" says so and does nothing. Reached by
 * keyboard, an arrow is on screen even where the row is clipped (phones).
 */
export async function carousel(page) {
  const wrap = '[data-az-behaviour="carousel"]';
  const shown = await page.evaluate((w) => {
    const c = document.querySelector(`${w} .az-gallery-controls`) ?? document.querySelector(`${w} button[data-az-step]`)?.parentElement;
    return !!c && getComputedStyle(c).display !== 'none';
  }, wrap);
  if (!shown) return null;
  const read = () => page.evaluate((w) => {
    const track = document.querySelector(`${w} [data-az-track]`) ?? document.querySelector(`${w} ul`);
    const b = (s) => document.querySelector(`${w} button[data-az-step="${s}"]`);
    const r = b('1').getBoundingClientRect();
    return {
      left: track.scrollLeft, room: track.scrollWidth - track.clientWidth,
      prev: b('-1').getAttribute('aria-disabled'), next: b('1').getAttribute('aria-disabled'),
      nextBox: { w: r.width, h: r.height, onScreen: r.right > 0 && r.left < innerWidth },
    };
  }, wrap);
  const problems = [];
  const start = await read();
  // Everything fits: nothing to step through, so neither control may offer to.
  if (start.room <= 0) {
    const both = start.prev === 'true' && start.next === 'true';
    return { pass: both, detail: both ? '' : 'the whole set fits, yet a control is not marked unavailable' };
  }
  if (start.prev !== 'true') problems.push('at the start "previous" is not marked unavailable');
  if (start.next !== 'false') problems.push('at the start "next" is marked unavailable');
  await page.focus(`${wrap} button[data-az-step="1"]`);
  const focused = await read();
  if (focused.nextBox.w < 44 || focused.nextBox.h < 44 || !focused.nextBox.onScreen) {
    problems.push(`the focused "next" is not a visible 44px control (${Math.round(focused.nextBox.w)}x${Math.round(focused.nextBox.h)})`);
  }
  await page.keyboard.press('Enter');
  const moved = await until(page, (w) => (document.querySelector(`${w} [data-az-track]`) ?? document.querySelector(`${w} ul`)).scrollLeft > 0, wrap);
  if (!moved) problems.push('"next" did not scroll the track');
  // Step to the end, bounded by the number of slides.
  const slides = await page.$$eval(`${wrap} li`, (l) => l.length);
  for (let i = 0; i < slides + 1; i++) {
    const now = await read();
    if (now.next === 'true') break;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
  const end = await read();
  if (end.next !== 'true') problems.push('at the end "next" is not marked unavailable');
  if (end.left < end.room - 1) problems.push(`"next" stopped short of the end (${Math.round(end.left)} of ${end.room})`);
  if (end.prev !== 'false') problems.push('past the start "previous" stayed unavailable');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  if ((await read()).left !== end.left) problems.push('an unavailable "next" still moved the track');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * gallery §8: an image opens the lightbox; the counter says "1 of N"; the
 * arrow keys step without wrapping and without scrolling the page behind;
 * at the end "next" is unavailable; Escape closes and focus lands on the
 * thumbnail of the image on show, not the one that opened it.
 */
export async function lightbox(page) {
  const thumbs = '[data-az-behaviour="lightbox"] button[data-az-index]';
  const count = (await page.$$(thumbs)).length;
  if (count === 0) return null;
  if (count < 2) return { pass: false, detail: 'fewer than two images to step through' };
  const read = () => page.evaluate((t) => {
    const box = document.querySelector(t).closest('[data-az-behaviour="lightbox"]');
    const dialog = box.querySelector('dialog');
    const img = dialog.querySelector('[data-az-lightbox-image]');
    // By alt, not src: a set may show one file twice; each image's alt says
    // what it shows, and the lightbox carries the chosen one's.
    const thumbAlts = [...box.querySelectorAll(`button[data-az-index] img`)].map((i) => i.alt);
    return {
      open: dialog.open, focusIn: dialog.contains(document.activeElement),
      counter: dialog.querySelector('[data-az-lightbox-counter]')?.textContent,
      live: dialog.querySelector('[data-az-lightbox-counter]')?.getAttribute('aria-live'),
      shownIndex: thumbAlts.indexOf(img.alt),
      next: dialog.querySelector('button[data-az-step="1"]')?.getAttribute('aria-disabled'),
      // Where the page behind SITS on screen, not window.scrollY: the scroll
      // lock fixes <body> at its offset, and WebKit may apply a pending
      // focus scroll to the window after that — scrollY moves while nothing
      // on screen does. The first thumbnail's viewport position is what a
      // reader would see move.
      y: Math.round(box.querySelector('button[data-az-index]').getBoundingClientRect().top),
      focusedThumb: [...box.querySelectorAll('button[data-az-index]')].indexOf(document.activeElement),
    };
  }, thumbs);
  const problems = [];
  await page.focus(thumbs);
  await page.keyboard.press('Enter');
  if (!(await until(page, (t) => document.querySelector(t).closest('[data-az-behaviour="lightbox"]').querySelector('dialog').open, thumbs))) {
    return { pass: false, detail: 'the image did not open the lightbox' };
  }
  const opened = await read();
  if (!opened.focusIn) problems.push('focus did not move into the lightbox');
  if (opened.counter !== `1 of ${count}` || opened.live !== 'polite') problems.push(`counter "${opened.counter}" (aria-live ${opened.live}), not a polite "1 of ${count}"`);
  if (opened.shownIndex !== 0) problems.push('the lightbox does not show the image chosen');
  await page.keyboard.press('ArrowRight');
  const stepped = await read();
  if (stepped.counter !== `2 of ${count}` || stepped.shownIndex !== 1) problems.push('→ did not step to the next image');
  if (stepped.y !== opened.y) problems.push('the arrow keys scrolled the page behind');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  const last = await read();
  if (last.counter !== `${count} of ${count}` || last.shownIndex !== count - 1) problems.push('→ past the last image wrapped or moved');
  if (last.next !== 'true') problems.push('at the last image "next" is not marked unavailable');
  await page.keyboard.press('Escape');
  const closed = await until(page, (t) => !document.querySelector(t).closest('[data-az-behaviour="lightbox"]').querySelector('dialog').open, thumbs);
  if (!closed) problems.push('Escape did not close the lightbox');
  else {
    await page.waitForTimeout(100);
    const after = await read();
    if (after.focusedThumb !== count - 1) problems.push(`focus returned to thumbnail ${after.focusedThumb + 1}, not ${count} — the one on show`);
  }
  // From part-way down the page, open and close: the page stays put, with
  // no jump to the top and glide back (the site smooth-scrolls).
  const y = await page.evaluate((t) => {
    document.body.style.minHeight = '4000px';
    const thumb = document.querySelector(t);
    const at = Math.max(0, Math.round(thumb.getBoundingClientRect().top + window.scrollY - 200));
    window.scrollTo({ top: at, behavior: 'instant' });
    return Math.round(window.scrollY);
  }, thumbs);
  if (y > 0) {
    await page.$eval(thumbs, (b) => b.click());
    const dialog = '[data-az-behaviour="lightbox"] dialog';
    if (await until(page, (d) => document.querySelector(d).open, dialog)) {
      const r = await scrollWhileClosing(page, dialog, () => page.keyboard.press('Escape'));
      if (Math.abs(r.y - y) > 2 || r.min < y - 10) {
        problems.push(`closing the lightbox moved the page (lowest ${Math.round(r.min)}, ended ${Math.round(r.y)}, was ${y})`);
      }
    }
  }
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * pricing §7.1: choosing Annual shows every annual price in the section, is
 * kept in the query string without a new history entry, is announced as a
 * mode, and a load with ?billing=annual starts there.
 */
export async function billing(page) {
  const group = '[data-az-behaviour="billing"]';
  if (!(await page.$(group))) return null;
  const read = () => page.evaluate((g) => {
    const f = document.querySelector(g);
    const s = f.closest('section') ?? f.parentElement;
    const prices = [...s.querySelectorAll('[data-monthly]')];
    return {
      annual: prices.filter((p) => p.hasAttribute('data-annual')).every((p) => p.textContent.trim() === p.getAttribute('data-annual')),
      monthly: prices.every((p) => p.textContent.trim() === p.getAttribute('data-monthly')),
      some: prices.some((p) => p.hasAttribute('data-annual')),
      checked: f.querySelector('input:checked')?.value,
      search: location.search, history: history.length,
    };
  }, group);
  const problems = [];
  const start = await read();
  if (!start.some) return { pass: false, detail: 'no annual prices to switch to' };
  await page.click(`${group} input[value="annual"]`);
  const switched = await until(page, (g) => {
    const s = document.querySelector(g).closest('section') ?? document.querySelector(g).parentElement;
    return [...s.querySelectorAll('[data-annual]')].every((p) => p.textContent.trim() === p.getAttribute('data-annual'));
  }, group);
  if (!switched) return { pass: false, detail: 'choosing Annual did not show the annual prices' };
  const after = await read();
  if (!/[?&]billing=annual\b/.test(after.search)) problems.push('the chosen period is not in the query string');
  if (after.history !== start.history) problems.push('the choice added a history entry (Back must leave the page)');
  const said = await until(page, () => /annual pricing/.test(document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? ''));
  if (!said) problems.push('the change of period was not announced');
  await page.reload({ waitUntil: 'load' });
  if (await page.$('#root')) await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(200);
  const loaded = await read();
  if (!loaded.annual || loaded.checked !== 'annual') problems.push('a load with ?billing=annual did not start on annual prices');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/** footer §4 `year dynamic`: the client writes the current year (a range from `since`). */
export async function year(page) {
  const sel = '[data-year="dynamic"]';
  if (!(await page.$(sel))) return null;
  const text = await page.$eval(sel, (s) => s.textContent.trim());
  const now = new Date().getFullYear();
  const pass = text === String(now) || new RegExp(`^\\d{4}–${now}$`).test(text);
  return { pass, detail: pass ? '' : `the dynamic year reads "${text}", not ${now}` };
}

/**
 * Markup rendered AFTER the first render — a page behind <Protected> — is
 * wired like the rest: the self-test page adds a FAQ and a copy button late.
 */
export async function lateContent(page) {
  const arrived = await until(page, () => !!document.getElementById('late-faq'));
  if (!arrived) return { pass: false, detail: 'the late content never arrived' };
  await page.waitForTimeout(100);
  const collapsed = await page.evaluate(() => [...document.querySelectorAll('#late-faq [data-az-disclosure]')]
    .every((b) => b.getAttribute('aria-expanded') === 'false'));
  await page.click('#late-faq [data-az-disclosure]');
  const opened = await page.$eval('#late-faq [data-az-disclosure]', (b) => b.getAttribute('aria-expanded') === 'true');
  const problems = [];
  if (!collapsed) problems.push('late FAQ answers were not collapsed');
  if (!opened) problems.push('a late FAQ question does not open its answer');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

/**
 * The runtime's cleanup with a modal open gives the page back: the dialog
 * closed, its trigger collapsed, the body unfixed.
 */
export async function detach(page) {
  if (!(await page.evaluate(() => typeof window.__azDetach === 'function'))) {
    return { pass: false, detail: 'no runtime attached' };
  }
  await page.$eval('.az-nav-toggle', (b) => b.click());
  if (!(await until(page, () => document.querySelector('#az-nav-panel')?.open === true))) {
    return { pass: false, detail: 'the menu did not open' };
  }
  const r = await page.evaluate(() => {
    window.__azDetach();
    return {
      open: document.querySelector('#az-nav-panel').open,
      fixed: getComputedStyle(document.body).position === 'fixed',
      expanded: document.querySelector('.az-nav-toggle').getAttribute('aria-expanded'),
    };
  });
  const problems = [];
  if (r.open) problems.push('the menu stayed open');
  if (r.fixed) problems.push('the page stayed scroll-locked');
  if (r.expanded !== 'false') problems.push('the toggle still says expanded');
  return { pass: problems.length === 0, detail: problems.join('; ') };
}
