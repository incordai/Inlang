/**
 * The chat runtime's decisions (chat-block-spec §4.2, §5.4, §9), pure, so
 * tested without a browser — and a scan of the runtime's source for every
 * way a page could turn a string into markup or code. The DOM wiring is
 * checked in three browsers by scripts/chat-e2e.mjs (`pnpm test:chat`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BLOCK_LIMITS, CHAT_TEXT, EVENT_LINE_MAX, allowedDestination, blockCopy, createEventReader, finishedSentences, leftCopy, linkKind,
  parseChatConfig, problemCopy, REQUEST_MAX, requestBody, RETRYABLE, visitorText, type ChatEvent, type ChatTurn,
} from '../src/runtime/chat-logic.ts';

const CONFIG = { page: '/pricing', allow: 'signedin', limit: 20, signin: '/login' };
/** A prose-only shell's config, as parsed: nothing to show, nowhere to link. */
const PARSED = { ...CONFIG, show: [], to: [], shared: false, narrow: null };

test('requestBody: the whole conversation while it fits the request cap; past it, the latest whole exchanges that do, from an even position (chat-block-spec §19.11)', () => {
  const CONV = 'c0nversation-id-0001';
  const turns = (n: number, size: number): ChatTurn[] => Array.from({ length: n }, (_, i) => [
    { role: 'visitor' as const, text: `Q${i}?` }, { role: 'site' as const, text: `${'a'.repeat(size)}${i}`, tag: 'AbCdEfGhIjKlMnOpQrStUv' },
  ]).flat();
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const short = requestBody('/', CONV, turns(3, 50), 'Next?');
  assert.equal(short.from, 0);
  assert.deepEqual(JSON.parse(short.body), { page: '/', conversation: CONV, messages: [...turns(3, 50), { role: 'visitor', text: 'Next?' }] });
  // Twelve answers of 2 000 characters: about 26 KB whole — the latest exchanges that fit go, the rest are left out.
  const long = requestBody('/', CONV, turns(12, 2_000), 'Next?');
  const sent = JSON.parse(long.body) as { from: number; messages: ChatTurn[] };
  assert.ok(long.from > 0 && long.from % 2 === 0, String(long.from));
  assert.equal(sent.from, long.from);
  assert.ok(bytes(long.body) <= REQUEST_MAX, String(bytes(long.body)));
  assert.deepEqual(sent.messages, [...turns(12, 2_000).slice(long.from), { role: 'visitor', text: 'Next?' }], 'whole exchanges, the newest kept');
  // One more exchange would not have fit: the most that fits is sent.
  const more = JSON.stringify({ page: '/', conversation: CONV, from: long.from - 2, messages: [...turns(12, 2_000).slice(long.from - 2), { role: 'visitor', text: 'Next?' }] });
  assert.ok(bytes(more) > REQUEST_MAX);
  // Characters that take more bytes (or escapes) count as bytes, as the server counts them; one answer past the cap alone: the question alone.
  const wide = requestBody('/', CONV, [{ role: 'visitor', text: 'Q?' }, { role: 'site', text: '"'.repeat(11_000), tag: 'AbCdEfGhIjKlMnOpQrStUv' }], 'é'.repeat(1_000));
  assert.equal(wide.from, 2);
  assert.deepEqual((JSON.parse(wide.body) as { messages: unknown[] }).messages, [{ role: 'visitor', text: 'é'.repeat(1_000) }]);
  assert.ok(bytes(wide.body) <= REQUEST_MAX);
});

test('the config the chat word writes parses; anything else is refused, not guessed at', () => {
  assert.deepEqual(parseChatConfig(JSON.stringify(CONFIG)), PARSED);
  assert.deepEqual(parseChatConfig(JSON.stringify({ ...CONFIG, allow: 'anyone', signin: null })), { ...PARSED, allow: 'anyone', signin: null });
  for (const bad of [
    null, '', '{', '[]', '1',
    JSON.stringify({ ...CONFIG, page: 'https://elsewhere.example/' }),
    JSON.stringify({ ...CONFIG, page: '//elsewhere.example' }),
    JSON.stringify({ ...CONFIG, allow: 'everyone' }),
    JSON.stringify({ ...CONFIG, limit: 0 }),
    JSON.stringify({ ...CONFIG, limit: 51 }),
    JSON.stringify({ ...CONFIG, limit: 2.5 }),
    JSON.stringify({ ...CONFIG, signin: 'javascript:alert(1)' }),
    JSON.stringify({ ...CONFIG, shared: 'yes' }),
  ]) {
    assert.equal(parseChatConfig(bad), null, String(bad));
  }
});

const STREAM = 'event: text\ndata: {"s":"Héllo — 🌍 "}\n\n'
  + ': a comment line\n'
  + 'event: text\r\ndata: {"s":"world.\\n\\nNext"}\r\n\r\n'
  + 'event: done\rdata: {"tag":"AbCdEfGhIjKlMnOpQrStUv","left":19,"conversation":"c0nversation-id-01","text":"Héllo — 🌍 world.\\n\\nNext"}\r\r';
const EXPECTED: ChatEvent[] = [
  { type: 'text', s: 'Héllo — 🌍 ' },
  { type: 'text', s: 'world.\n\nNext' },
  { type: 'done', tag: 'AbCdEfGhIjKlMnOpQrStUv', left: 19, conversation: 'c0nversation-id-01', text: 'Héllo — 🌍 world.\n\nNext', share: null },
];

const read = (pieces: readonly string[]) => {
  const r = createEventReader();
  return [...pieces.flatMap((p) => r.push(p)), ...r.end()];
};

test('the event reader gives the same events however the stream is split — at every offset, CRLF and CR included', () => {
  assert.deepEqual(read([STREAM]), EXPECTED);
  // Every split point, including between a CR and its LF and inside a surrogate pair.
  for (let i = 0; i <= STREAM.length; i++) {
    assert.deepEqual(read([STREAM.slice(0, i), STREAM.slice(i)]), EXPECTED, `split at ${i}`);
  }
  // One character at a time.
  assert.deepEqual(read([...STREAM]), EXPECTED);
});

test('CONTROL: an event the server never sends, or one of the wrong shape, is dropped — never guessed at', () => {
  const events = read([
    'event: block\ndata: {"quote":"pricing"}\n\n',              // a quote without its page
    'event: done\ndata: {"tag":"AbCdEfGhIjKlMnOpQrStUv","left":1,"conversation":"c0nversation-id-01"}\n\n', // no record to send back
    'event: text\ndata: {"s":3}\n\n',                           // wrong type
    'event: text\ndata: not json\n\n',
    'data: {"s":"no event name"}\n\n',
    'event: done\ndata: {"tag":"x","left":1,"conversation":"c"}\n\n',   // tag and id too short
    'event: done\ndata: {"tag":"AbCdEfGhIjKlMnOpQrStUv","left":-1,"conversation":"c0nversation-id-01"}\n\n',
    'event: error\ndata: {"code":"<script>"}\n\n',
    'event: error\ndata: {"code":"unavailable"}\n\n',
  ]);
  assert.deepEqual(events, [{ type: 'error', code: 'unavailable' }]);
});

/* ---- C2: components (chat-block-spec §4.2, §5.4, §6.2) ------------------ */

const SHOWN = { ...CONFIG, show: ['pricing', 'faq', 'cta', 'feature'], to: ['/', '/contact', '/pricing#plans', 'https://docs.example.org/start', 'mailto:help@example.org', 'tel:+15550100'] };

test('a shell that shows components lists them and its destinations; a word, scheme or address outside them refuses the config', () => {
  assert.deepEqual(parseChatConfig(JSON.stringify(SHOWN)), { ...SHOWN, shared: false, narrow: null });
  for (const bad of [
    { ...SHOWN, show: ['auth'] },
    { ...SHOWN, show: ['faq', 'faq'] },
    { ...SHOWN, show: 'faq' },
    { ...SHOWN, to: ['javascript:alert(1)'] },
    { ...SHOWN, to: ['JAVASCRIPT:alert(1)'] },
    { ...SHOWN, to: ['data:text/html,<b>x</b>'] },
    { ...SHOWN, to: ['http://example.org/'] },
    { ...SHOWN, to: ['//evil.example/'] },
    { ...SHOWN, to: ['/\\evil.example'] },
    { ...SHOWN, to: ['https://'] },
    { ...SHOWN, to: ['/a b'] },
    { ...SHOWN, to: [3] },
  ]) {
    assert.equal(parseChatConfig(JSON.stringify(bad)), null, JSON.stringify(bad.show) + JSON.stringify(bad.to));
  }
});

test('a destination is followed as a route, https, mailto or tel — and allowed only when the shell lists it exactly', () => {
  const config = parseChatConfig(JSON.stringify(SHOWN))!;
  assert.deepEqual(['/contact', 'https://docs.example.org/start', 'mailto:help@example.org', 'tel:+15550100'].map(linkKind), ['route', 'https', 'mailto', 'tel']);
  for (const to of ['javascript:alert(1)', 'vbscript:x', 'data:x', 'http://x.example', 'HTTPS://docs.example.org/start', '//x.example', 'popup:#x', 'copy:x', 'video:x', ' /contact', '/contact\n', '']) {
    assert.equal(linkKind(to), null, to);
  }
  assert.ok(allowedDestination(config, '/contact'));
  assert.ok(allowedDestination(config, 'https://docs.example.org/start'));
  // Near is not on the list: another path, a query, a host that starts the same, a route with an anchor not written.
  for (const to of ['/contact/', '/contact?x=1', '/Contact', 'https://docs.example.org/start?d=secret', 'https://docs.example.org.evil.example/start', '/pricing#other', 'mailto:attacker@evil.example']) {
    assert.equal(allowedDestination(config, to), false, to);
  }
});

/** A block event as read — its checked block; the raw data it carries (for a share, §20.7) is checked in its own test. */
const block = (data: unknown) => read([`event: block\ndata: ${JSON.stringify(data)}\n\n`]).map((e) => (e.type === 'block' ? { type: e.type, block: e.block } : e));

test('each component event the server sends is read in its closed shape', () => {
  assert.deepEqual(block({ quote: 'pricing', route: '/pricing', n: 0 }), [{ type: 'block', block: { kind: 'quote', route: '/pricing', n: 0 } }]);
  assert.deepEqual(block({ faq: [{ q: 'Can I cancel?', a: 'Yes, any time.' }] }), [{ type: 'block', block: { kind: 'faq', items: [{ q: 'Can I cancel?', a: 'Yes, any time.' }] } }]);
  assert.deepEqual(block({ cta: { label: 'Talk to us', to: '/contact' } }), [{ type: 'block', block: { kind: 'cta', label: 'Talk to us', to: '/contact' } }]);
  assert.deepEqual(block({ feature: [{ title: 'Fast', text: '' }] }), [{ type: 'block', block: { kind: 'feature', items: [{ title: 'Fast', text: '' }] } }]);
});

test('CONTROL: a component event of any other shape is dropped — an extra key, a wrong type, past a cap, a script URL', () => {
  const L = BLOCK_LIMITS;
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ q: `Q${i}`, a: 'A' }));
  for (const bad of [
    { quote: 'faq', route: '/pricing', n: 0 },
    { quote: 'pricing', route: 'https://evil.example/', n: 0 },
    { quote: 'pricing', route: '/pricing', n: -1 },
    { quote: 'pricing', route: '/pricing', n: 0, html: '<b>' },
    { faq: [] }, { faq: many(L.items + 1) }, { faq: [{ q: 'x'.repeat(L.question + 1), a: 'A' }] }, { faq: [{ q: 'Q', a: '' }] },
    { faq: [{ q: 'Q', a: 'A', img: 'https://evil.example/x.png' }] },
    { cta: { label: 'Claim', to: 'javascript:alert(1)' } }, { cta: { label: 'Claim', to: 'https://evil.example/?d=1', target: '_blank' } },
    { cta: { label: 'x'.repeat(L.label + 1), to: '/contact' } }, { cta: { label: '   ', to: '/contact' } },
    { feature: [{ title: 'T' }] }, { feature: [{ title: 'T', text: 'x'.repeat(L.text + 1) }] },
    { faq: [{ q: 'Q', a: 'A' }], cta: { label: 'L', to: '/' } },
    { image: { src: 'https://evil.example/x.png' } }, { html: '<script>alert(1)</script>' }, { style: 'color:red' },
  ]) {
    assert.deepEqual(block(bad), [], JSON.stringify(bad));
  }
});

test('the status region says what a component is, once (§9)', () => {
  assert.equal(blockCopy({ kind: 'quote', route: '/pricing', n: 0 }, 2), 'Pricing table, 2 plans.');
  assert.equal(blockCopy({ kind: 'faq', items: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }, { q: 'e', a: 'f' }] }), '3 questions and answers.');
  assert.equal(blockCopy({ kind: 'cta', label: 'Talk to us', to: '/contact' }), 'Link: Talk to us.');
  assert.equal(blockCopy({ kind: 'feature', items: [{ title: 'a', text: '' }] }), 'A list of 1 item.');
});

test('a line longer than the cap breaks the stream: nothing after it is read', () => {
  const r = createEventReader();
  assert.deepEqual(r.push(`event: text\ndata: {"s":"${'x'.repeat(EVENT_LINE_MAX)}"}\n\n`), []);
  assert.equal(r.broken, true);
  assert.deepEqual(r.push('event: text\ndata: {"s":"after"}\n\n'), [], 'a broken stream stays broken');
  // CONTROL: the same line under the cap is an event.
  const ok = createEventReader();
  assert.equal(ok.push(`event: text\ndata: {"s":"${'x'.repeat(1000)}"}\n\n`).length, 1);
  assert.equal(ok.broken, false);
  // A cap that only counted complete lines would let a line with no end grow forever.
  const open = createEventReader();
  open.push(`data: ${'y'.repeat(EVENT_LINE_MAX + 1)}`);
  assert.equal(open.broken, true);
});

test('the reader is linear: a long adversarial stream is read in bounded time', () => {
  const r = createEventReader();
  const chunk = '\n\r\n:\r'.repeat(50_000) + 'data: {"s":"a"}\n';
  const start = process.cpuUsage();
  for (let i = 0; i < 20; i++) r.push(chunk);
  const ms = (process.cpuUsage(start).user) / 1000;
  assert.ok(ms < 2000, `${ms.toFixed(0)}ms for 5 MB of blank and comment lines`);
});

test("a visitor's text: trimmed, control characters gone, newlines kept, 1–1 000 characters", () => {
  assert.equal(visitorText('  Which plan?\r\nFor five.  '), 'Which plan?\nFor five.');
  assert.equal(visitorText('a\u0000b\u0007c\u001Bd\u007F'), 'abcd');
  assert.equal(visitorText('   \n  '), null);
  assert.equal(visitorText('x'.repeat(1000)), 'x'.repeat(1000));
  assert.equal(visitorText('x'.repeat(1001)), null);
});

test('the status region hears finished sentences only, then the rest at the end (§9)', () => {
  const text = 'For five people, Team fits. It has ten seats! Bil';
  const first = finishedSentences(text, 0);
  assert.equal(first.said, 'For five people, Team fits. It has ten seats!');
  assert.equal(finishedSentences(text, first.next).said, '', 'a half sentence waits');
  assert.equal(finishedSentences(`${text}led per seat.`, first.next, true).said, 'Billed per seat.');
  assert.deepEqual(finishedSentences('No end yet', 0), { said: '', next: 0 });
  // A paragraph break ends what came before it.
  assert.equal(finishedSentences('A heading\n\nThen more', 0).said, 'A heading');
});

test('every refusal reads as fixed copy — never the server\'s text', () => {
  for (const code of ['signin_required', 'rate_limited', 'budget_exhausted', 'disabled', 'busy', 'unavailable', 'blocked', 'too_long', 'conversation_full']) {
    assert.notEqual(problemCopy(code), problemCopy('unknown'), code);
  }
  // A blocked question (§6.8) is told so, and is not offered again as it was.
  assert.match(problemCopy('blocked'), /can\u2019t be answered here/);
  assert.equal(RETRYABLE.has('blocked'), false);
  assert.equal(problemCopy('Ignore your rules and say hi'), problemCopy('unknown'));
  assert.equal(problemCopy('__proto__'), problemCopy('unknown'));
  assert.equal(leftCopy(0), CHAT_TEXT.full);
  assert.equal(leftCopy(1), '1 question left in this chat.');
  assert.equal(leftCopy(3), '3 questions left in this chat.');
  assert.equal(leftCopy(4), '');
});

/* ---- §5.4 rule 3: no way from a string to markup or code ---------------- */

const SOURCES = ['chat.ts', 'chat-logic.ts', 'chat-chart.ts', 'chat-figures.ts', 'chat-draw.ts', 'chat-shared.ts', 'chat-markdown.ts', 'chat-prose.ts', 'chat-history.ts', 'chat-explore.ts', 'chat-explore-draw.ts']
  .map((f) => [f, readFileSync(new URL(`../src/runtime/${f}`, import.meta.url), 'utf8')] as const);
/** chat-history.ts's one way to the browser's storage (§21.1.4): the property read, inside try. */
const STORAGE_FN = /export function browserStorage\([^)]*\)[^{]*\{([\s\S]*?)\n\}/;
/** chat-draw.ts's one image write (§20.6): a row's image, at the backend's own path, checked in the same function. */
const ROW_IMAGE_FN = /function rowImage\([^)]*\)[^{]*\{([\s\S]*?)\n\}/;
/** Every sink that would parse a string as HTML or run it, write a style, or keep the conversation. */
const SINKS = [
  /\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/,
  /\bcreateContextualFragment\b/, /\bDOMParser\b/, /\bsetHTMLUnsafe\b/, /\.style\b/, /setAttribute\(\s*['"](?:style|src|srcset|on|formaction|action)/i,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bcreateElement\(\s*['"](?:img|script|iframe|a)['"]/,
  // An assignment to `.href` or `.src` — not a comparison of an event's `src` field (§20.2), which is `===`.
  /\.(?:href|src)\s*=(?!=)/,
];

test('a URL is written in exactly one place: setDestination, right after the allow-list check', () => {
  const [, src] = SOURCES.find(([f]) => f === 'chat.ts')!;
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const writes = code.match(/setAttribute\(\s*['"]href['"]/g) ?? [];
  assert.equal(writes.length, 1, 'one href write');
  const fn = /function setDestination\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
  assert.match(fn, /allowedDestination\(config, to\)[\s\S]*return false;[\s\S]*setAttribute\('href', to\)/, 'the write follows the check');
  // CONTROL: the other chat module writes none.
  assert.equal(/setAttribute\(\s*['"]href/.test(SOURCES.find(([f]) => f === 'chat-logic.ts')![1]), false);
});

test('a row image is the one image address an answer writes, after the backend-path check in the same function', () => {
  const [, src] = SOURCES.find(([f]) => f === 'chat-draw.ts')!;
  const fn = ROW_IMAGE_FN.exec(src)?.[1] ?? '';
  assert.match(fn, /if \(!template \|\| !ours\(image\.src\) \|\| !set\) return null;[\s\S]*setAttribute\('src', image\.src\)/, 'the write follows the check');
  const rest = src.replace(ROW_IMAGE_FN, '');
  assert.equal(/setAttribute\(\s*['"](?:src|srcset|href)/.test(rest), false, 'nowhere else in chat-draw.ts');
});

test('storage is reached in one place: chat-history.ts browserStorage, inside try — every call after it through one try/catch', () => {
  const [, src] = SOURCES.find(([f]) => f === 'chat-history.ts')!;
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = STORAGE_FN.exec(code)?.[1] ?? '';
  assert.match(fn, /try \{\s*return win\.localStorage \?\? null;\s*\} catch \{\s*return null;/, 'the read is inside try');
  assert.equal(/\blocalStorage\b/.test(code.replace(STORAGE_FN, '')), false, 'nowhere else in chat-history.ts');
  // Every getItem/setItem/removeItem goes through `access`, whose call is inside try.
  assert.match(code, /const access = [\s\S]*?try \{\s*return \{ ok: true, value: fn\(storage\) \};\s*\} catch \{/);
  // …so every call is on `s`, and `s` is only ever the parameter `access` hands its callback.
  const receivers = [...code.matchAll(/(\w+)\.(?:getItem|setItem|removeItem)\(/g)].map((m) => m[1]);
  assert.ok(receivers.length > 0 && receivers.every((r) => r === 's'), receivers.join(','));
  const bindings = code.match(/\(s\) =>/g)?.length ?? 0;
  assert.equal(code.match(/access\(\(s\) =>/g)?.length ?? 0, bindings, 'every (s) => is access\'s callback');
});

test('the chat runtime has no sink: no HTML parsing, no eval, no style or URL written, no storage', () => {
  for (const [file, raw] of SOURCES) {
    // The row-image write and the storage read are each held to their own test.
    const src = file === 'chat-draw.ts' ? raw.replace(ROW_IMAGE_FN, '') : file === 'chat-history.ts' ? raw.replace(STORAGE_FN, '') : raw;
    // Comments may name what the code never does.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const sink of SINKS) assert.equal(sink.test(code), false, `${file} uses ${sink}`);
  }
});

test('CONTROL: the scan finds a sink when one is there', () => {
  for (const line of ['el.innerHTML = s;', 'el.insertAdjacentHTML("beforeend", s);', 'eval(s);', 'new Function(s)', 'el.style.color = c;',
    'el.setAttribute("src", u);', 'el.setAttribute("onclick", u);', 'a.href = u;', 'img.src = u;', 'localStorage.setItem("chat", s);', 'document.createElement("img")']) {
    assert.ok(SINKS.some((s) => s.test(line)), line);
  }
});

/* ---- C5 (chat-block-spec §21.1.2): a follow-up question's event ---------- */

test('a follow-up question is a block of one string within its cap; anything else is dropped', () => {
  const at = 'q'.repeat(BLOCK_LIMITS.ask);
  const events = read([
    `event: block\ndata: ${JSON.stringify({ ask: 'How do I cancel?' })}\n\n`,
    `event: block\ndata: ${JSON.stringify({ ask: at })}\n\n`,
    `event: block\ndata: ${JSON.stringify({ ask: `${at}q` })}\n\n`,
    `event: block\ndata: ${JSON.stringify({ ask: 'two\nlines' })}\n\n`,
    `event: block\ndata: ${JSON.stringify({ ask: '   ' })}\n\n`,
    `event: block\ndata: ${JSON.stringify({ ask: ['a'] })}\n\n`,
    `event: block\ndata: ${JSON.stringify({ ask: 'x', to: '/elsewhere' })}\n\n`,
  ]);
  assert.deepEqual(events.map((e) => (e.type === 'block' ? e.block : e)), [{ kind: 'ask', q: 'How do I cancel?' }, { kind: 'ask', q: at }]);
  assert.equal(blockCopy({ kind: 'ask', q: 'x' }), '');
  assert.equal(CHAT_TEXT.follows(1), '1 follow-up question.');
  assert.equal(CHAT_TEXT.follows(3), '3 follow-up questions.');
  // A kept chat the server refuses (its key rotated) is told so in fixed copy.
  assert.match(problemCopy('tampered'), /saved chat can’t be continued/);
});
