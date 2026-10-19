/*
 * The window page's script for scripts/chat-lib-e2e.mjs (chat-block-spec §22.5): <AzChat> rendered by React into a box the page's
 * stylesheet sizes, asking the test server's /chat through the chat runtime's transport, driven by the test through
 * window.azWindow. Served as it is; it imports the packages as the test server serves them, React from its CommonJS build.
 */

import { createElement } from '/vendor/react.js';
import { createRoot } from '/vendor/react-dom-client.js';
import { AzChat } from '/pkg/chat-react/az-chat.ts';
import { createChatRuntime } from '/pkg/chat-runtime/runtime.ts';
import { httpTransport } from '/pkg/chat-runtime/transport.ts';

const app = document.getElementById('app');
let root = createRoot(app);

/** Two frames: React has committed and the browser has laid out. */
const settled = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/** What the window shows, as the test reads it: text, structure and boxes, never markup. */
function describe() {
  const w = document.querySelector('[data-az-chat-window]');
  const q = (s) => w?.querySelector(s) ?? null;
  const transcript = q('[data-az-chat-transcript]');
  const items = transcript ? [...transcript.children] : [];
  const last = items[items.length - 1] ?? null;
  const all = w ? [...w.querySelectorAll('*')] : [];
  const shown = (s) => { const el = q(s); return el !== null && !el.hidden; };
  // The element the app sized: the window's own (its className).
  const box = (w?.parentElement ?? app).getBoundingClientRect();
  const r = w?.getBoundingClientRect() ?? null;
  const t = transcript?.getBoundingClientRect() ?? null;
  const ids = all.map((el) => el.id).filter(Boolean);
  return {
    windows: document.querySelectorAll('[data-az-chat-window]').length,
    title: q('.az-chat-title')?.textContent.trim() ?? null,
    greeting: items[0]?.textContent.trim() ?? null,
    asks: [...(w?.querySelectorAll('[data-az-chat-ask]') ?? [])].map((b) => b.textContent.trim()),
    asksShown: shown('[data-az-chat-asks]'),
    messages: items.map((li) => (li.classList.contains('az-chat-message--visitor') ? 'visitor' : 'site')),
    lastText: last ? last.textContent.replace(/\s+/g, ' ').trim() : '',
    lastBusy: last?.getAttribute('aria-busy') ?? null,
    faq: last ? [...last.querySelectorAll('.az-faq-question')].map((s) => s.textContent.trim()) : [],
    links: last ? [...last.querySelectorAll('a')].map((a) => a.getAttribute('href')) : [],
    svg: last ? last.querySelectorAll('svg').length : 0,
    follows: last ? [...last.querySelectorAll('.az-chat-follows button')].map((b) => b.textContent.trim()) : [],
    bar: last ? last.querySelectorAll('.az-chat-bar').length : 0,
    status: q('[data-az-chat-status]')?.textContent ?? '',
    note: q('[data-az-chat-note]')?.textContent ?? '',
    error: shown('[data-az-chat-error]') ? q('[data-az-chat-error]').textContent : '',
    retry: shown('[data-az-chat-retry]'),
    stop: shown('[data-az-chat-stop]'),
    send: shown('[data-az-chat-send]'),
    focused: document.activeElement !== null && document.activeElement === q('[data-az-chat-input]'),
    styled: all.filter((el) => el.hasAttribute('style')).length,
    handlers: all.filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
    duplicateIds: ids.length - new Set(ids).size,
    box: [Math.round(box.width), Math.round(box.height)],
    root: r ? [Math.round(r.width), Math.round(r.height)] : null,
    transcriptInBox: t !== null && t.bottom <= box.bottom + 1 && t.top >= box.top - 1,
    transcriptScrolls: transcript !== null && transcript.scrollHeight > transcript.clientHeight,
  };
}

let windows = 0;

window.azWindow = {
  async render(props) {
    const runtime = createChatRuntime({ transport: { local: httpTransport({ source: 'local', base: location.origin }) } });
    root.render(createElement(AzChat, { runtime, conversation: `window-conversation-${++windows}`, ...props }));
    await settled();
    return describe();
  },
  describe,
  async unmount() {
    root.unmount();
    root = createRoot(app);
    await settled();
    return { windows: document.querySelectorAll('[data-az-chat-window]').length, children: app.children.length };
  },
};
document.documentElement.dataset.azReady = 'yes';
