/**
 * The visitor's words, scored (chat-match.ts, chat-block-spec §19.17): their
 * terms, and on a large site the pages a question is sent in full — never a
 * page the build left out of the context, the fixed part of the text the
 * same bytes for every question.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../../core/src/index.ts';
import { chatBackend } from '../src/chat-context.ts';
import { choosePages, terms } from '../src/server/chat-match.ts';
import { CONTENT_LIMITS, PAGES_HEADING, parseChatContext, systemText, type ChatContext } from '../src/server/chat.ts';
import { manifests } from './data-fixture.ts';

test('terms: lower-cased, NFC, split at anything but letters and digits, no stop words, plurals stemmed, each once', () => {
  assert.deepEqual(terms('Do you SHIP abroad?'), ['ship', 'abroad']);
  assert.deepEqual(terms('Show me this month\'s orders, please!'), ['month', 'order']);
  assert.deepEqual(terms('countries, boxes, glasses, status, analysis, lamps, lamp'), ['country', 'box', 'glass', 'status', 'analysis', 'lamp']);
  assert.deepEqual(terms('Café café'), ['café'], 'a decomposed accent is the same term');
  assert.deepEqual(terms('Versand ins Ausland?'), ['versand', 'ins', 'ausland'], 'another language keeps its words; none is an English stop word');
  assert.deepEqual(terms('?!  a  I'), [], 'nothing with a topic');
  assert.equal(terms('word '.repeat(5_000)).length, 1);
  assert.equal(terms(Array.from({ length: 200 }, (_, i) => `w${i}x`).join(' ')).length, 64, 'a question keeps its first 64 terms');
});

/** A site of `n` help pages, each its own topic, and a members' page in auth protect. */
function largeSite(n: number): string {
  const pages = Array.from({ length: n }, (_, i) => `page /help/topic${i}
  faq
    title "Topic ${i} questions"
    item "What is the topic${i} gadget?"
      text "The topic${i} gadget is a ${'long and careful explanation '.repeat(6)}."
    item "Is topic${i} safe?"
      text "Yes, topic${i} is safe."
    item "Where is topic${i} sold?"
      text "Topic${i} is sold in our shop."
`).join('\n');
  return `az 1
site studio
  auth
    adapter azbackend
    protect /members
  backend
    database sqlite
    email    smtp
    model    default
  chat float
    show  faq
    allow anyone

page /
  hero center
    title "Studio"

page /login
  auth login
    redirect /

page /members
  faq
    title "Members only"
    item "What is the members-only secret gadget?"
      text "The secret gadget code is MEMBERS-ONLY-7731."
    item "Is the secret gadget safe?"
      text "Members-only answer."
    item "Where is the secret gadget?"
      text "In the members-only vault."

${pages}`;
}

function contextOf(source: string): { prompt: string; ctx: ChatContext } {
  const r = compile(source, { manifests });
  assert.ok(r.ok && r.spec, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
  const built = chatBackend(r.spec)!;
  const ctx = parseChatContext(built.context);
  assert.ok(typeof ctx === 'object', String(ctx));
  return { prompt: built.prompts[0].text, ctx };
}

test('a large site is sent as summaries, and in full only the pages the question needs, after the fixed part', () => {
  const { prompt, ctx } = contextOf(largeSite(24));
  assert.ok(ctx.outline.pages.reduce((n, p) => n + p.full.length + 1, 0) > CONTENT_LIMITS.whole, 'CONTROL: the site is past the size');
  const asked = (q: string) => systemText(prompt, ctx, '/', '', [], false, [q]);
  const one = asked('Is topic7 safe?');
  const two = asked('Where is topic19 sold?');
  // The answer's page is sent in full; the others are their summary line.
  assert.ok(one.includes(`${PAGES_HEADING}\n<site-pages>\npage /help/topic7\n  faq "Topic 7 questions"\n    1 "What is the topic7 gadget?"`));
  assert.ok(!one.includes('1 "What is the topic19 gadget?"') && two.includes('1 "What is the topic19 gadget?"'));
  assert.match(one, /\npage \/help\/topic19\n {2}faq "Topic 19 questions" \(3 items\)\n/);
  // The fixed part — prompt, summaries, the page line — is the same bytes for both questions: it stays cacheable.
  const fixed = (s: string) => s.slice(0, s.indexOf(`\n${PAGES_HEADING}`));
  assert.equal(fixed(one), fixed(two));
  assert.ok(!fixed(one).includes('<site-pages>'));
  // The cap holds: at most CONTENT_LIMITS.pages pages in full.
  const many = asked('Is it safe? topic1 topic2 topic3 topic4 topic5 topic6');
  const sent = many.slice(many.indexOf('<site-pages>'), many.indexOf('</site-pages>'));
  assert.equal((sent.match(/^page \/help\/topic\d+$/gm) ?? []).length, CONTENT_LIMITS.pages);
  // The whole site, for comparison: a question costs far less with the choice.
  const whole = systemText(prompt, ctx, '/', '', [], false, ['Is topic7 safe?'], false);
  assert.ok(one.length * 2 < whole.length, `${one.length} against ${whole.length}`);
});

test('a protected page is never chosen, however the question names it: it is not in the context the server chooses from', () => {
  const { prompt, ctx } = contextOf(largeSite(24));
  for (const q of ['What is the members-only secret gadget?', 'members only vault secret gadget code', '/members']) {
    const s = systemText(prompt, ctx, '/members', '', [], false, [q]);
    assert.ok(!/MEMBERS-ONLY-7731|members-only vault|Members only/i.test(s), q);
  }
  assert.ok(!ctx.outline.pages.some((p) => p.route === '/members'));
});

test('a follow-up without a topic is read with the question before it; with none, the visitor\'s own page is sent', () => {
  const { prompt, ctx } = contextOf(largeSite(24));
  const follow = systemText(prompt, ctx, '/', '', [], false, ['and the second one?', 'Is topic11 safe?']);
  assert.ok(follow.includes('\npage /help/topic11\n  faq "Topic 11 questions"\n    1 '));
  const none = systemText(prompt, ctx, '/help/topic3', '', [], false, ['hello?']);
  assert.ok(none.includes(`<site-pages>\npage /help/topic3\n`));
  assert.deepEqual(choosePages(ctx.outline.pages, '/nowhere', ['hello?'], 4, 8_000), [], 'no page in view, no topic: none in full');
});

test('CONTROL: a small site is sent whole — every page in full and no pages section, whatever is asked', () => {
  const { prompt, ctx } = contextOf(largeSite(2));
  const s = systemText(prompt, ctx, '/', '', [], false, ['Is topic1 safe?']);
  assert.ok(!s.includes('<site-pages>') && !s.includes(PAGES_HEADING));
  assert.ok(s.includes('1 "What is the topic0 gadget?"') && s.includes('1 "What is the topic1 gadget?"'));
});
