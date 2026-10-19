/**
 * <AzChat>'s session side with no browser (chat-block-spec §22.5): what the
 * window's core is told as a session streams — the answer it began gets
 * each event once, then is whole, failed or stopped; a kept conversation is
 * drawn as it was; the questions left are its note. The window itself, in
 * Chromium, Firefox and WebKit, is scripts/chat-lib-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionWindow, type WindowPanel } from '../src/az-chat.ts';
import { createChatSession, type SessionAsker } from '#chat-runtime/session.ts';
import type { RuntimeEvent } from '#chat-runtime/runtime.ts';
import type { PanelAnswer, PanelMode } from '#chat-render/chat-panel.ts';

/** A panel that writes down what it is told, in order. */
function recorder() {
  const said: string[] = [];
  let stopping = false;
  const item = {} as HTMLElement;
  const answer: PanelAnswer = {
    item,
    get stopping() { return stopping; },
    text: (s) => { said.push(`text ${s}`); },
    hold: (w) => { said.push(`hold ${w}`); },
    block: (b) => { said.push(`block ${Object.keys(b)[0]}`); return true; },
    finish: () => { said.push('finish'); return 1; },
    instead: () => { said.push('instead'); },
    bar: () => { said.push('bar'); },
    arrived: (n) => { said.push(`arrived ${n}`); },
    stopped: () => { said.push('stopped'); },
  };
  const panel: WindowPanel = {
    answer: () => { said.push('answer'); return answer; },
    fail: (code, it) => { said.push(`fail ${code}${it === item ? ' (its item)' : ''}`); },
    keptQuestion: (t) => { said.push(`kept question ${t}`); },
    keptAnswer: (events) => { said.push(`kept answer ${events.map((e) => e.type).join(',')}`); return item; },
    hideAsks: () => { said.push('hide asks'); },
    note: (t) => { said.push(`note ${t}`); },
    setMode: (m: PanelMode) => { said.push(`mode ${m}`); },
    setState: (s) => { said.push(`state ${s}`); },
  };
  return { said, panel, stop: () => { stopping = true; } };
}

const done = (left: number): RuntimeEvent => ({ type: 'done', text: 'Kept.', left, source: 'direct', by: null });

/** An asker that answers every question with `events`, one at a time; with `hang`, it then waits until it is stopped. */
function asker(events: readonly RuntimeEvent[], hang = false, kept: Awaited<ReturnType<SessionAsker['load']>> = null): SessionAsker {
  return {
    async *ask(_c, _q, o = {}) {
      for (const e of events) { await Promise.resolve(); yield e; }
      if (!hang) return;
      await new Promise<void>((resolve) => o.signal?.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'error', code: 'stopped' };
    },
    load: async () => kept,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an asked question: the answer the window began gets each event once, then finishes, its bar, arrived, and the questions left', async () => {
  const session = createChatSession(asker([{ type: 'text', s: 'We ship.\n' }, { type: 'hold', word: 'chart' }, { type: 'block', block: { cta: { label: 'Order', to: '/order' } } }, { type: 'hold', word: 'nonsense' }, done(2)]), 'conversation-0001');
  const r = recorder();
  const w = sessionWindow(session, { base: '', limit: 20 });
  const off = w.start(r.panel);
  w.driver.answer('How fast?', null);
  await settle();
  off();
  assert.deepEqual(r.said, ['answer', 'text We ship.\n', 'hold chart', 'block cta', 'finish', 'bar', 'arrived 1', 'state idle', 'note 2 questions left in this chat.']);
  assert.equal(w.driver.answered(), true);
  assert.equal(w.driver.kept(), false, 'the session keeps the conversation: the window offers no Clear history of its own');
});

test('a failed answer is the window\'s failure, with its code; a stopped one is stopped (CONTROL: not a failure)', async () => {
  const failed = recorder();
  const a = sessionWindow(createChatSession(asker([{ type: 'text', s: 'Half' }, { type: 'error', code: 'busy' }]), 'conversation-0002'), { base: '', limit: 20 });
  a.start(failed.panel);
  a.driver.answer('Q?', null);
  await settle();
  assert.deepEqual(failed.said, ['answer', 'text Half', 'fail busy (its item)']);
  assert.equal(a.driver.answered(), false);

  const stopped = recorder();
  const b = sessionWindow(createChatSession(asker([{ type: 'text', s: 'Half' }], true), 'conversation-0003'), { base: '', limit: 20 });
  b.start(stopped.panel);
  b.driver.answer('Q?', null);
  await settle();
  stopped.stop();
  b.driver.stop();
  await settle();
  assert.deepEqual(stopped.said, ['answer', 'text Half', 'stopped']);
});

test('the last question a conversation holds leaves the window full', async () => {
  const r = recorder();
  const w = sessionWindow(createChatSession(asker([{ type: 'text', s: 'Last.' }, done(0)]), 'conversation-0004'), { base: '', limit: 20 });
  w.start(r.panel);
  w.driver.answer('Q?', null);
  await settle();
  assert.deepEqual(r.said.slice(-2), ['arrived 1', 'mode full']);
});

test('a kept conversation is drawn as it was, the suggested questions hidden; one that holds the limit is full', async () => {
  const kept = { id: 'conversation-0005', server: {}, at: 0, turns: [
    { role: 'visitor' as const, text: 'Hi?' },
    { role: 'site' as const, text: 'Hello.', tag: '', source: 'direct' as const, events: [{ type: 'text', s: 'Hello.' }] },
  ] };
  const session = createChatSession(asker([], false, kept), 'conversation-0005');
  const r = recorder();
  sessionWindow(session, { base: '', limit: 1 }).start(r.panel);
  await session.load();
  assert.deepEqual(r.said, ['kept question Hi?', 'kept answer text,done', 'hide asks', 'mode full']);
  // CONTROL: drawn once — another snapshot with the same turns draws nothing more.
  await session.load();
  assert.equal(r.said.length, 4);
});
