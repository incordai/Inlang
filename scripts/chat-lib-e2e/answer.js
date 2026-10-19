/*
 * The answer page's script for scripts/chat-lib-e2e.mjs (chat-block-spec §22.3): <AzAnswer> rendered by React into the page,
 * and the renderer core mounted without a framework, each driven by the test through window.azAnswer. Served as it is; it
 * imports the packages as the test server serves them (types stripped, aliases resolved), React from its CommonJS build.
 */

import { createElement } from '/vendor/react.js';
import { createRoot } from '/vendor/react-dom-client.js';
import { AzAnswer } from '/pkg/chat-react/az-answer.ts';
import { mountAnswer } from '/pkg/chat-render/chat-answer-mount.ts';
import * as midnight from '/pkg/chat-render/themes/midnight.ts';

const app = document.getElementById('app');
let root = createRoot(app);
const announced = [];
const asked = [];
const copied = [];
let core = null;

/** Two frames: React has committed and the browser has laid out. */
const settled = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/** What the drawn answer holds, as the test reads it: text and structure, never markup. */
function describe() {
  const roots = [...document.querySelectorAll('[data-az-chat-root]')];
  const r = roots[0] ?? null;
  const answer = r?.querySelector(':scope > ol > li') ?? null;
  const all = answer ? [...answer.querySelectorAll('*')] : [];
  const figure = answer?.querySelector('.az-chat-figure') ?? null;
  return {
    roots: roots.length,
    theme: r?.getAttribute('data-az-theme') ?? null,
    busy: answer?.getAttribute('aria-busy') ?? null,
    text: answer ? answer.textContent.replace(/\s+/g, ' ').trim() : '',
    strong: answer ? answer.querySelectorAll('strong').length : 0,
    faq: answer ? [...answer.querySelectorAll('.az-faq-question')].map((s) => s.textContent.trim()) : [],
    links: answer ? [...answer.querySelectorAll('a')].map((a) => a.getAttribute('href')) : [],
    svgMarks: answer ? answer.querySelectorAll('svg [data-az-chat-mark], svg rect, svg path').length : 0,
    // A table's own rows, not a chart's table equivalent behind its disclosure.
    tableRows: answer ? [...answer.querySelectorAll('table tbody tr')].filter((tr) => !tr.closest('details')).length : 0,
    stats: answer ? [...answer.querySelectorAll('.az-chat-stat dd')].map((d) => d.textContent.trim()).filter(Boolean) : [],
    skeletons: answer ? answer.querySelectorAll('[data-az-chat-held]').length : 0,
    thinking: answer ? answer.querySelectorAll('.az-chat-thinking').length : 0,
    bar: answer ? answer.querySelectorAll('.az-chat-bar').length : 0,
    follows: answer ? [...answer.querySelectorAll('.az-chat-follows button')].map((b) => b.textContent.trim()) : [],
    mapList: answer ? answer.querySelectorAll('.az-chat-map-list').length : 0,
    // Anything the model could have smuggled in as an element.
    foreign: all.filter((el) => ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'FORM'].includes(el.tagName) || (el.tagName === 'IMG' && !el.closest('.az-chat-card'))).length,
    styled: all.filter((el) => el.hasAttribute('style')).length,
    handlers: all.filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
    // The theme reached the page: the root declares the surface colour, a figure is drawn with it.
    surface: r ? getComputedStyle(r).getPropertyValue('--az-color-surface').trim() : '',
    figureBorder: figure ? getComputedStyle(figure).borderTopColor : null,
    hiddenShell: r ? r.querySelector('[data-az-chat]')?.hidden ?? null : null,
  };
}

window.azAnswer = {
  async render(props) {
    root.render(createElement(AzAnswer, {
      ...props,
      onAnnounce: (t) => announced.push(t),
      onAsk: (q) => asked.push(q),
      onCopy: (t) => copied.push(t),
    }));
    await settled();
    return describe();
  },
  async unmount() {
    root.unmount();
    root = createRoot(app);
    await settled();
    return { roots: document.querySelectorAll('[data-az-chat-root]').length, children: app.children.length };
  },
  /** The renderer core with no framework: a theme module, events pushed, the answer described, then destroyed. */
  async core(options, events) {
    const holder = document.createElement('div');
    document.body.append(holder);
    core = mountAnswer(holder, { ...options, theme: midnight, onAnnounce: (t) => announced.push(t) });
    for (const e of events) core.push(e);
    await settled();
    const seen = describe();
    core.destroy();
    holder.remove();
    return { ...seen, after: document.querySelectorAll('[data-az-chat-root]').length };
  },
  describe,
  said: () => [...announced],
  asked: () => [...asked],
  click(selector) {
    const el = document.querySelector(selector);
    if (el) el.click();
    return el !== null;
  },
};
document.documentElement.dataset.azReady = 'yes';
