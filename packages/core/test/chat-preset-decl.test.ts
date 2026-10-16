/**
 * Answer presets (chat-block-spec §19.16): `answer <name>` under a chat
 * keeps its indented lines as written — one component in the answer forms,
 * never linked as words — in its Spec fill, and the file-wide rules judge
 * them: AZ1273 a name, AZ1274 a name twice, AZ1275 one component, AZ1276 a
 * component the chat shows, AZ1277 a body the chat server's parser (given
 * by the caller as `checkAnswer`) would drop. Each rule has a CONTROL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type AnswerCheck, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const site = (chat: string) => `az 1
site studio
  auth
    adapter azbackend
  backend
    database sqlite
    email smtp
    model default

page /
  hero center
    title "Studio"
  chat panel
    show dashboard chart stats cta
    allow anyone
${chat}
`;

const MONTHLY = `    answer monthly
      dashboard "This month"
        stat "Orders" 4
        chart bar "By status" from orders count by status`;

const codes = (r: ReturnType<typeof compile>) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

test('§19.16: an answer preset keeps its body as written, two spaces a level, strings quoted — and nothing under it is linked as a word', () => {
  const r = compile(site(`${MONTHLY}\n    answer talk\n      cta "Talk \\"now\\"" /`), { manifests });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diagnostics));
  const chat = r.spec!.pages[0].blocks.find((b) => b.word === 'chat')!;
  const presets = chat.children.filter((c) => c.word === 'answer');
  assert.deepEqual(presets.map((p) => [p.args, p.props, p.children]), [
    [[{ kind: 'word', value: 'monthly' }], { body: 'dashboard "This month"\n  stat "Orders" 4\n  chart bar "By status" from orders count by status\n' }, []],
    [[{ kind: 'word', value: 'talk' }], { body: 'cta "Talk \\"now\\"" /\n' }, []],
  ]);
  // CONTROL: the same lines anywhere else are words, and `dashboard` is none.
  assert.ok(codes(compile(site('').replace('page /\n', 'page /\n  dashboard "This month"\n'), { manifests })).includes('AZ1201'));
});

test('§19.16: AZ1273 a preset without a lowercase name; AZ1274 a name twice', () => {
  assert.deepEqual(codes(compile(site('    answer\n      cta "Go" /'), { manifests })), ['AZ1273']);
  assert.deepEqual(codes(compile(site('    answer "monthly"\n      cta "Go" /'), { manifests })), ['AZ1273'], 'a name, not copy');
  assert.deepEqual(codes(compile(site(`    answer m${'x'.repeat(32)}\n      cta "Go" /`), { manifests })), ['AZ1273'], 'at most 32');
  assert.deepEqual(codes(compile(site('    answer talk\n      cta "Go" /\n    answer talk\n      cta "Again" /'), { manifests })), ['AZ1274']);
  // A name past the line is AZ1406, as for any fill.
  assert.deepEqual(codes(compile(site('    answer talk extra\n      cta "Go" /'), { manifests })), ['AZ1406']);
  // CONTROL: two names, each once.
  assert.deepEqual(codes(compile(site('    answer talk\n      cta "Go" /\n    answer more\n      cta "Again" /'), { manifests })), []);
});

test('§19.16: AZ1275 a preset is exactly one component; AZ1276 one the chat shows', () => {
  assert.deepEqual(codes(compile(site('    answer empty'), { manifests })), ['AZ1275']);
  assert.deepEqual(codes(compile(site('    answer two\n      cta "One" /\n      cta "Two" /'), { manifests })), ['AZ1275']);
  assert.deepEqual(codes(compile(site('    answer faq\n      faq\n        item "Q?" "A."'), { manifests })), ['AZ1276'], 'faq is not in show');
  for (const head of ['ask "Why?"', 'text "Prose."', 'use other', 'hero center', 'show pricing /pricing']) {
    assert.deepEqual(codes(compile(site(`    answer odd\n      ${head}`), { manifests })), ['AZ1276'], head);
  }
  // At most eight presets on one chat (the slot's max).
  const nine = Array.from({ length: 9 }, (_, i) => `    answer p${i}\n      cta "Go" /`).join('\n');
  assert.deepEqual(codes(compile(site(nine), { manifests })), ['AZ1209']);
  // CONTROL: a cta the chat shows.
  assert.deepEqual(codes(compile(site('    answer talk\n      cta "Go" /'), { manifests })), []);
});

test('§19.16: AZ1277 a body the chat server\'s parser would drop, judged with the chat\'s own rules — only when the caller gives the parser', () => {
  const seen: { rules: Parameters<AnswerCheck>[0]; text: string }[] = [];
  const check: AnswerCheck = (rules, text) => { seen.push({ rules, text }); return text.includes('nowhere') ? 'destination' : null; };
  const bad = site('    answer lost\n      cta "Go" /nowhere');
  const r = compile(bad, { manifests, checkAnswer: check });
  assert.deepEqual(codes(r), ['AZ1277']);
  assert.match(r.diagnostics.find((d) => d.code === 'AZ1277')!.message, /^answer lost: the chat would drop its cta \(destination\)/);
  assert.deepEqual(seen[0].rules.show, ['cta', 'chart', 'stats', 'dashboard']);
  assert.ok(seen[0].rules.destinations.includes('/'));
  assert.equal(seen[0].text, 'cta "Go" /nowhere\n');
  // CONTROL: without the parser, only the structure is judged; with it, a sound body passes.
  assert.deepEqual(codes(compile(bad, { manifests })), []);
  assert.deepEqual(codes(compile(site('    answer talk\n      cta "Go" /'), { manifests, checkAnswer: check })), []);
});
