/**
 * @az module chat
 * Purpose: the file-wide rules of a `chat` block: a backend that talks to a model, what an answer may show and quote and link to, who may ask.
 * Spec: docs/chat-block-spec.md §3.4, §5.3, §6.2, §8.2, §14 (C1, C2, C2b, C3), §19.16, §19.17, §20, §21.3, §21.4
 * Exports: CHAT_WORD, CHAT_ANSWER_WORDS, CHAT_RICH_WORDS, TOOLS_WORD, CHAT_REFUSED, SHARED_ROUTE, KNOWS_MAX, SHOW_GROUPS, AUTO_WORD, PRESET_WORD, PRESET_NAME, PRESETS_MAX,
 *   KEYWORDS_WORD, KEYWORDS_MAX, chatOf, chatAnswers, withAnswer, knowsTables, chatDiagnostics, presetDiagnostics, askDiagnostics, sharedRouteDiagnostics, expandShow,
 *   withShowGroups, presetParts, autoPresets, chatPresets, askAnswer, ChatAnswers, ChatDecl, PresetDecl, AskDecl, AnswerCheck, AnswerCheckRules
 * Edit guide: rules that need the whole file live here; a rule about one chat block alone is a word.json check (AZ2220–AZ2239).
 * Tests: packages/core/test/chat-decl.test.ts, packages/core/test/chat-answer-decl.test.ts, packages/core/test/chat-float-decl.test.ts,
 *   packages/core/test/chat-show-groups.test.ts, packages/core/test/chat-preset-decl.test.ts, packages/core/test/chat-auto-presets.test.ts
 */

/**
 * A `chat` block needs more than its own lines to be right: the site's
 * `backend` must say it talks to a model (`model default`), and a model
 * the site never uses is a cost nobody meant. Those rules see the whole
 * file, so they run once the pages are built (spec.ts), like `backend`'s
 * own AZ1507.
 *
 * What an answer may SHOW is a closed list (chat-block-spec §3.2): each word
 * in it is safe to fill with model-chosen text, and every other word is
 * refused with its reason. A chat that lists `show` is given, in its Spec
 * block, what its answers may use (chatAnswers): the pricing blocks a
 * signed-out visitor can see — the only prices an answer can show, quoted
 * — and the destinations the file declares, the only places an answer's
 * call to action may point (§6.2).
 *
 * What an answer may KNOW besides the pages (`knows`, §8.2) is up to three
 * tables a signed-out visitor can read and that only the site's own people
 * fill: a row a stranger wrote is text that would steer the model (indirect
 * prompt injection), so a table anyone may add to or change is refused.
 */

import type { Diagnostic, Pos } from './lex.ts';
import type { Arg } from './parse.ts';
import type { LinkedWord } from './link.ts';
import type { SpecBlock, SpecChatAnswer, SpecChatPreset, SpecChatTable } from './spec-block.ts';
import type { SpecTable } from './data.ts';
import { CURRENCY_DIGITS } from './currencies.ts';
import { LIST_SEPARATOR } from './link.ts';
import { isFromMark } from './emit-contract.ts';

/** The block's name, so the rules below never repeat it as a bare string. */
export const CHAT_WORD = 'chat';

/** The rich components (chat-block-spec §20, explore §21.3, map §21.4): answer-only, never page words. */
export const CHAT_RICH_WORDS: readonly string[] = ['chart', 'table', 'stats', 'cards', 'dashboard', 'explore', 'map'];
/** What a dashboard's tiles may be (§20.2): never another dashboard, an explore or a map. */
const DASHBOARD_TILES: readonly string[] = ['chart', 'table', 'stats', 'cards'];
/** The word that, after `from`, names the operator's data tools in an answer (chat-block-spec §21.2.3) — never a table (AZ1272). */
export const TOOLS_WORD = 'tool';

/** The words an answer may contain (chat-block-spec §3.2, §20.1), in this order everywhere. */
export const CHAT_ANSWER_WORDS: readonly string[] = ['pricing', 'faq', 'cta', 'feature', ...CHAT_RICH_WORDS];

/**
 * The one table of `show`'s group names (chat-block-spec §19.15): each
 * stands for its members, in CHAT_ANSWER_WORDS' order, and is expanded once
 * the whole file is read (withShowGroups) — no later stage ever sees a
 * group. A group never brings a component the site cannot use: `pricing`
 * only when a page a signed-out visitor can open has a pricing block to
 * quote (written by name, it is still AZ1255 without one). A name here is
 * never a component, a refused word or a page word; what each means to an
 * author is the chat manifest's `show` valueDescriptions (a test ties them).
 */
export const SHOW_GROUPS: Readonly<Record<string, readonly string[]>> = {
  all: CHAT_ANSWER_WORDS,
  figures: ['chart', 'table', 'stats', 'cards', 'dashboard'],
  sections: ['pricing', 'faq', 'cta', 'feature'],
};

/**
 * `show`'s written words with each group replaced by its members, each
 * component once, in the order first written; `quotable` is whether a
 * page a signed-out visitor can open has a pricing block (§19.15). Words
 * that are neither stay as written, for AZ1254 to give their reason.
 */
export function expandShow(written: readonly string[], quotable: boolean): string[] {
  const out: string[] = [];
  for (const w of written) {
    const group = Object.hasOwn(SHOW_GROUPS, w) ? SHOW_GROUPS[w] : undefined;
    // `all` also has the build make answer presets from the site (§19.17): every component, and `auto`.
    const words = group ? [...group.filter((m) => m !== QUOTED_WORD || quotable), ...(w === 'all' ? [AUTO_WORD] : [])] : [w];
    for (const m of words) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * The `show` word that has the build make answer presets from what the site
 * already has (chat-block-spec §19.17) — never a component: `show all` brings
 * it, `show auto` asks for it alone.
 */
export const AUTO_WORD = 'auto';

/**
 * The linked file with every chat's `show` groups expanded (§19.15) — run
 * first by the spec stage, which alone sees whether any public page has a
 * pricing block to quote. A page listed in the site's `auth protect` is
 * not public (chatAnswers' rule). Everything else is returned as it was.
 */
export function withShowGroups(root: readonly LinkedWord[]): LinkedWord[] {
  const site = root.find((w) => w.word === 'site');
  const protect = new Set((site?.children.find((w) => w.word === 'auth')?.props.protect?.value ?? '')
    .split(LIST_SEPARATOR).map((r) => r.trim()).filter(Boolean));
  const quotable = root.some((p) => p.word === 'page' && !protect.has(p.args[0]?.value ?? '/') && p.children.some((c) => c.word === QUOTED_WORD));
  const grouped = (w: LinkedWord) => w.word === CHAT_WORD && (w.props.show?.value.split(LIST_SEPARATOR) ?? []).some((x) => Object.hasOwn(SHOW_GROUPS, x));
  const expand = (w: LinkedWord): LinkedWord => {
    if (!grouped(w)) return w;
    const show = w.props.show!;
    return { ...w, props: { ...w.props, show: { ...show, value: expandShow(show.value.split(LIST_SEPARATOR), quotable).join(LIST_SEPARATOR) } } };
  };
  return root.map((top) => (top.word === 'site' || top.word === 'page') && top.children.some(grouped)
    ? { ...top, children: top.children.map(expand) }
    : top);
}

/** The page the build makes for a shared answer (§20.7); an author's page there is AZ1259. */
export const SHARED_ROUTE = '/chat/shared';

/** The most tables one chat may know (chat-block-spec §3.2). */
export const KNOWS_MAX = 3;

/** The one word an answer quotes rather than composes (§5.3, L8): its prices are always the author's. */
const QUOTED_WORD = 'pricing';

/** Why every other word can never be in an answer (chat-block-spec §3.2). */
export const CHAT_REFUSED: Readonly<Record<string, string>> = {
  auth: 'a sign-in form placed by a model is a phishing form',
  gallery: 'its images would be addresses the model chose',
  hero: 'its media would be addresses the model chose',
  scene: 'its 3D model would be an address the model chose',
  nav: 'site navigation is not an answer',
  footer: 'site chrome is not an answer',
  text: 'prose is already the default, and markdown never enters an answer',
  chat: 'an answer cannot hold another chat',
};

/**
 * A scheme destination an answer may use when the file declares it exactly
 * (§6.2): `https://…`, `mailto:…`, `tel:…`, the scheme in lower case as the
 * page's runtime checks it (overlay chat-logic.ts linkKind), and nothing a
 * browser would read past. Every other scheme is refused.
 */
const LINKABLE = /^(?:https:\/\/|mailto:|tel:)[^\s\\]+$/;

/** A chat block as the rules see it: its written props, its answer presets, its suggested questions, and where it was written. */
export interface ChatDecl {
  readonly props: Readonly<Record<string, Arg>>;
  readonly pos: Pos;
  readonly presets?: readonly PresetDecl[];
  readonly asks?: readonly AskDecl[];
}

/** The fill an author writes an answer preset with (chat-block-spec §19.16): `answer <name>`, one component indented under it. */
export const PRESET_WORD = 'answer';
/** A preset's name: what the model writes after `use` — lowercase letters and digits, words joined by one hyphen, at most 32. */
export const PRESET_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PRESET_NAME_MAX = 32;
const presetName = (name: string): boolean => name.length <= PRESET_NAME_MAX && PRESET_NAME.test(name);
/** The most presets one chat holds, written and made together (the `answer` slot's max). */
export const PRESETS_MAX = 8;
/** The line under `answer` that names the words a question is matched by (§19.17), and its bounds. */
export const KEYWORDS_WORD = 'keywords';
export const KEYWORDS_MAX = 12;
const KEYWORD_LENGTH = 40;

/** One `answer <name>` under a chat: its name as written, its body as text (link.ts verbatimText), where it was written. */
export interface PresetDecl {
  readonly name: Arg | undefined;
  readonly body: string;
  readonly pos: Pos;
}

/** What a preset's body is judged against: the chat's `show`, the site's pricing quotes, its destinations, image keys and the tables a `from` may name. */
export interface AnswerCheckRules {
  readonly show: readonly string[];
  /** The pricing blocks, and the faq and feature lists with their items (§19.16), an answer may quote. */
  readonly quotes: readonly { readonly word: string; readonly route: string; readonly n: number; readonly items?: readonly { readonly title: string; readonly text: string }[] }[];
  readonly destinations: readonly string[];
  readonly images: readonly string[];
  readonly tables: readonly string[];
}

/**
 * The chat server's own answer parser, run on a preset's body at build
 * (the CLI gives it; core imports nothing of the server): the reason code
 * the parser would drop it for, or null when it reads as exactly one
 * component and nothing else.
 */
export type AnswerCheck = (rules: AnswerCheckRules, text: string) => string | null;

/** The words a preset's component may start with: an answer word, or `show` quoting one. */
const presetHead = (body: string): { word: string; quoted: boolean } => {
  const [first = '', second = ''] = (body.split('\n')[0] ?? '').split(' ');
  return first === 'show' ? { word: second, quoted: true } : { word: first, quoted: false };
};

/**
 * A preset's body split (chat-block-spec §19.17): its component's lines, and
 * the words of its `keywords` line, which the matcher reads and the parser
 * never sees — or what is wrong with that line (AZ1278). The line is as
 * link.ts verbatimText wrote it: its strings quoted with §1.5's escapes.
 */
export function presetParts(body: string): { text: string; keywords: string[]; problem: string | null } {
  const lines = body.split('\n');
  const kept: string[] = [];
  let keywords: string[] | null = null;
  let problem: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== KEYWORDS_WORD && !line.startsWith(`${KEYWORDS_WORD} `)) { kept.push(line); continue; }
    // Lines indented under it are its own: a keywords line holds none.
    let next = i + 1;
    while (next < lines.length && lines[next].startsWith(' ')) next++;
    if (next > i + 1) problem ??= 'takes no indented lines — write its words on one line';
    i = next - 1;
    if (keywords !== null) { problem ??= 'is written twice — keep one'; continue; }
    const found = quotedWords(line.slice(KEYWORDS_WORD.length));
    if (found === null) problem ??= `takes quoted words — write: ${KEYWORDS_WORD} "orders" "revenue"`;
    else if (found.length === 0) problem ??= `has no words — write: ${KEYWORDS_WORD} "orders" "revenue", or remove the line`;
    else if (found.length > KEYWORDS_MAX) problem ??= `has ${found.length} words, maximum is ${KEYWORDS_MAX} — keep the ones a visitor would ask with`;
    else if (found.some((w) => w.trim() === '' || w.length > KEYWORD_LENGTH || w.includes('\n'))) problem ??= `takes words of 1 to ${KEYWORD_LENGTH} characters on one line — shorten them`;
    keywords = found ?? [];
  }
  return { text: kept.join('\n'), keywords: keywords ?? [], problem };
}

/** A line's values when every one is a quoted string (§1.5's three escapes), else null. One pass. */
function quotedWords(rest: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === ' ') { i++; continue; }
    if (rest[i] !== '"') return null;
    let v = '';
    i++;
    for (;;) {
      if (i >= rest.length) return null;
      const c = rest[i];
      if (c === '"') { i++; break; }
      if (c === '\\') {
        const e = rest[i + 1];
        v += e === 'n' ? '\n' : e;
        i += 2;
        continue;
      }
      v += c;
      i++;
    }
    out.push(v);
  }
  return out;
}

/** The words of names, routes and titles: what an automatic preset is asked by. */
const wordsOf = (...parts: readonly string[]): string[] =>
  [...new Set(parts.flatMap((p) => p.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 1))];

/** A table or field name as a title: `orders` → `Orders`. */
const titled = (name: string): string => `${name[0].toUpperCase()}${name.slice(1)}`;

/** A route as a name's first part: `/help/shipping` → `help-shipping`, `/` → `home`. */
function routeName(route: string): string {
  const name = route.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');
  return /^[a-z]/.test(name) ? name : `home${name === '' ? '' : `-${name}`}`;
}

/** `base` and its ending within the name's cap, the base cut at a hyphen when it must be cut. */
function nameOf(base: string, ending: string): string {
  const room = PRESET_NAME_MAX - ending.length;
  if (base.length <= room) return `${base}${ending}`;
  const cut = base.slice(0, room);
  const at = cut.lastIndexOf('-');
  return `${at > 0 ? cut.slice(0, at) : cut}${ending}`;
}

/** A quote preset's name: `help-faq`, `help-faq-2` for the page's second; the word alone on a page named for it (`/pricing`). */
function quoteName(route: string, word: string, n: number): string {
  const ending = `${word}${n > 0 ? `-${n + 1}` : ''}`;
  const base = routeName(route);
  return base === word ? ending : nameOf(base, `-${ending}`);
}

const LAT = /^lat(itude)?$/;
const LON = /^(lon|lng|long|longitude)$/;

/** The words each quotable component is asked by, besides its title and route. */
const QUOTE_KEYWORDS: Readonly<Record<string, string>> = { pricing: 'price prices plans cost', faq: 'questions faq', feature: 'features' };

/**
 * The answer presets the build makes from what the site already has
 * (chat-block-spec §19.17), when the chat's `show` has `auto` — only for
 * components `show` lists, so each passes the chat's own rules:
 *
 *   - a public table with a money and a choice field, and dashboard, stats
 *     and chart shown: `<table>-overview`, a dashboard of its count, the
 *     money field's sum and a chart of its count by the choice field;
 *   - a public table with a datetime or date field, and chart shown:
 *     `<table>-by-month`, a line chart of its count by month;
 *   - a public table with number fields named like latitude and longitude
 *     and a text field, and map shown: `<table>-map`;
 *   - each pricing block, faq and feature list a signed-out visitor can
 *     see, with its word shown: `<route>-<word>`, a quote of it.
 *
 * Each has keywords from the table's and its fields' names, or the block's
 * title and route, for the matcher. Deterministic: tables in the file's
 * order, then the blocks in page order.
 */
export function autoPresets(show: readonly string[], answers: ChatAnswers): SpecChatPreset[] {
  if (!show.includes(AUTO_WORD)) return [];
  const out: SpecChatPreset[] = [];
  const has = (...ws: string[]) => ws.every((w) => show.includes(w));
  for (const t of answers.tables) {
    const T = titled(t.name);
    const money = t.fields.find((f) => f.type === 'money');
    const choice = t.fields.find((f) => f.type === 'choice');
    if (money && choice && has('dashboard', 'stats', 'chart')) {
      out.push({
        name: nameOf(t.name, '-overview'),
        text: `dashboard ${JSON.stringify(T)}\n  stat ${JSON.stringify(T)} from ${t.name} count\n  stat ${JSON.stringify(titled(money.name))} from ${t.name} sum ${money.name}\n  chart bar ${JSON.stringify(`${T} by ${choice.name}`)} from ${t.name} count by ${choice.name}\n`,
        keywords: wordsOf(t.name, money.name, choice.name, 'overview total summary'),
        auto: `how many ${t.name}, their ${money.name}, and ${t.name} by ${choice.name}`,
      });
    }
    const when = t.fields.find((f) => f.type === 'datetime') ?? t.fields.find((f) => f.type === 'date');
    if (when && has('chart')) {
      out.push({
        name: nameOf(t.name, '-by-month'),
        text: `chart line ${JSON.stringify(`${T} by month`)} from ${t.name} count by ${when.name} month\n`,
        keywords: wordsOf(t.name, when.name, 'month monthly trend'),
        auto: `${t.name} counted by month of ${when.name}`,
      });
    }
    const lat = t.fields.find((f) => f.type === 'number' && LAT.test(f.name));
    const lon = t.fields.find((f) => f.type === 'number' && LON.test(f.name));
    const label = t.fields.find((f) => f.type === 'text');
    if (lat && lon && label && has('map')) {
      out.push({
        name: nameOf(t.name, '-map'),
        text: `map ${JSON.stringify(T)} from ${t.name} label ${label.name} lat ${lat.name} lon ${lon.name}\n`,
        keywords: wordsOf(t.name, 'map where location'),
        auto: `${t.name} on a map`,
      });
    }
  }
  const quotes = [
    ...(has(QUOTED_WORD) ? answers.quotes.map((q) => ({ word: QUOTED_WORD, route: q.route, n: q.n, title: q.block.props.title ?? '' })) : []),
    ...answers.lists.filter((l) => has(l.word)).map((l) => ({ word: l.word, route: l.route, n: l.n, title: l.title })),
  ];
  for (const q of quotes) {
    const at = `${q.route}${q.n > 0 ? `#${q.n + 1}` : ''}`;
    out.push({
      name: quoteName(q.route, q.word, q.n),
      text: `show ${q.word} ${at}\n`,
      keywords: wordsOf(q.route, q.title, QUOTE_KEYWORDS[q.word] ?? q.word),
      auto: `the ${q.word === QUOTED_WORD ? 'pricing block' : `${q.word} list`}${q.title ? ` "${q.title}"` : ''} on ${q.route}`,
    });
  }
  return out;
}

/**
 * A chat's presets as the server reads them: the author's, each body split
 * from its keywords, then the build's (autoPresets) under a name no author's
 * preset has, each name once — at most PRESETS_MAX. A written preset whose
 * name or keywords are refused (AZ1273, AZ1274, AZ1278) is left out; the
 * build stops on its diagnostic anyway.
 */
export function chatPresets(written: readonly { readonly name: string; readonly body: string }[], show: readonly string[], answers: ChatAnswers): SpecChatPreset[] {
  const out: SpecChatPreset[] = [];
  for (const w of written) {
    const parts = presetParts(w.body);
    if (!presetName(w.name) || out.some((o) => o.name === w.name) || parts.problem !== null) continue;
    out.push({ name: w.name, text: parts.text, keywords: parts.keywords });
  }
  for (const a of autoPresets(show, answers)) {
    if (out.length >= PRESETS_MAX) break;
    if (!out.some((o) => o.name === a.name)) out.push(a);
  }
  return out;
}

/** One `ask` under a chat: its question, the answer written after it (§19.17), where it was written. */
export interface AskDecl {
  readonly text: string;
  readonly answer: readonly Arg[];
  readonly pos: Pos;
}

/**
 * A suggested question's answer as the one line the chat server reads
 * (§19.17): `use <name>`, or `show <word> <route>[#n] [#item]` — or null for
 * any other shape (AZ1279). No answer written is none: the model answers.
 */
export function askAnswer(answer: readonly { readonly kind: string; readonly value: string }[]): string | null {
  const [first, ...rest] = answer;
  if (first?.kind !== 'word') return null;
  if (first.value === 'use' && rest.length === 1 && rest[0].kind === 'word') return `use ${rest[0].value}`;
  if (first.value === 'show' && (rest.length === 2 || rest.length === 3) && rest[0].kind === 'word' && rest[1].kind === 'route'
    && (rest.length === 2 || (rest[2].kind === 'anchor' && /^#[1-9][0-9]?$/.test(rest[2].value)))) {
    return ['show', ...rest.map((a) => a.value)].join(' ');
  }
  return null;
}

/**
 * A chat's answer presets (chat-block-spec §19.16): AZ1273 a preset with no
 * name, or one that is not lowercase letters and digits joined by hyphens;
 * AZ1274 a name written twice; AZ1275 a body that is not exactly one
 * component (none indented, or two at its margin); AZ1276 a component the
 * chat does not show (or that is not one — `ask`, `text`, `use`); AZ1277 a
 * body the chat server's answer parser drops, judged by `check` with the
 * chat's own rules, so a preset that passes `az check` is never dropped at
 * run time; AZ1278 a `keywords` line that is not one line of quoted words,
 * or is written twice (§19.17). With `check`, each preset the build makes
 * (`show auto`) is judged too: AZ1277, which an author's preset of the same
 * name replaces.
 */
export function presetDiagnostics(presets: readonly PresetDecl[], show: readonly string[], rules?: { check: AnswerCheck; answers: ChatAnswers }, at?: Pos): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, pos: Pos) => out.push({ code, message, pos, severity: 'error' });
  const seen = new Set<string>();
  const judge = (body: string) => (rules ? rules.check(checkRules(show, rules.answers), body) : null);
  for (const p of presets) {
    const name = p.name?.value ?? '';
    if (p.name === undefined || p.name.kind !== 'word' || !presetName(name)) {
      err('AZ1273', `${PRESET_WORD}: needs a name of lowercase letters and digits, words joined by '-', at most ${PRESET_NAME_MAX} — write: ${PRESET_WORD} monthly`, p.name?.pos ?? p.pos);
      continue;
    }
    if (seen.has(name)) {
      err('AZ1274', `${PRESET_WORD}: '${name}' is written twice in this chat — keep one, or rename it`, p.name.pos);
      continue;
    }
    seen.add(name);
    const parts = presetParts(p.body);
    if (parts.problem !== null) err('AZ1278', `${PRESET_WORD} ${name}: its ${KEYWORDS_WORD} line ${parts.problem}`, p.pos);
    const tops = parts.text.split('\n').filter((l) => l !== '' && !l.startsWith(' ')).length;
    if (tops !== 1) {
      err('AZ1275', tops === 0
        ? `${PRESET_WORD} ${name}: holds no component — indent one under it, as an answer writes it`
        : `${PRESET_WORD} ${name}: holds ${tops} components — a preset is one; write each as its own ${PRESET_WORD}`, p.pos);
      continue;
    }
    const head = presetHead(parts.text);
    if (!CHAT_ANSWER_WORDS.includes(head.word) || !show.includes(head.word)) {
      err('AZ1276', CHAT_ANSWER_WORDS.includes(head.word)
        ? `${PRESET_WORD} ${name}: its ${head.word} is not in this chat's show — add ${head.word} to show, or change the ${PRESET_WORD}`
        : `${PRESET_WORD} ${name}: '${head.word}' is not a component an answer holds — write one of this chat's show: ${show.filter((w) => CHAT_ANSWER_WORDS.includes(w)).join(', ') || 'none'}`, p.pos);
      continue;
    }
    const why = judge(parts.text);
    if (why !== null) err('AZ1277', `${PRESET_WORD} ${name}: the chat would drop its ${head.word} (${why}) — ${dropFix(why)}`, p.pos);
  }
  // The build's own presets are held to the same parser; one that fails is the build's to fix, or the author's to replace.
  if (rules && at) {
    for (const a of autoPresets(show, rules.answers).filter((x) => !seen.has(x.name))) {
      const why = judge(a.text);
      if (why !== null) err('AZ1277', `${PRESET_WORD} ${a.name} (made by show ${AUTO_WORD}): the chat would drop it (${why}) — write an ${PRESET_WORD} ${a.name} of your own to replace it`, at);
    }
  }
  return out;
}

/** What a reason code asks of the author's preset or answer line. */
const dropFix = (why: string): string => why === 'figures' ? 'its from names no table a signed-out visitor can read'
  : why === 'tool' ? 'from tool asks the operator\'s tools, which a preset cannot'
  : 'write it in the forms the chat\'s prompt teaches (az prompt)';

/** The rules a preset or a suggested question's answer is judged by: the chat's show, every quotable block, the destinations, images and tables. */
function checkRules(show: readonly string[], answers: ChatAnswers): AnswerCheckRules {
  return {
    show: show.filter((w) => CHAT_ANSWER_WORDS.includes(w)),
    quotes: [
      ...answers.quotes.map((q) => ({ word: QUOTED_WORD, route: q.route, n: q.n })),
      ...answers.lists.map((l) => ({ word: l.word, route: l.route, n: l.n, items: l.items })),
    ],
    destinations: answers.destinations,
    images: answers.images.map((i) => i.key),
    tables: answers.tables.map((t) => t.name),
  };
}

/**
 * A chat's suggested questions that answer without the model (§19.17):
 * AZ1279 an answer that is neither `use <name>` nor `show <word> <route>`;
 * AZ1280 `use` of a name this chat has no preset of (its own, or one the
 * build makes); AZ1276 and AZ1277 for a quote, as for a preset — its word in
 * the chat's show, and the chat server's parser keeping it.
 */
export function askDiagnostics(asks: readonly AskDecl[], show: readonly string[], presets: readonly SpecChatPreset[], rules?: { check: AnswerCheck; answers: ChatAnswers }): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, pos: Pos) => out.push({ code, message, pos, severity: 'error' });
  for (const a of asks) {
    if (a.answer.length === 0) continue;
    const q = JSON.stringify(a.text);
    const line = askAnswer(a.answer);
    if (line === null) {
      err('AZ1279', `ask ${q}: answers with a preset or a quote — write: ask ${q} use <preset>, or ask ${q} show faq /help #2`, a.answer[0].pos);
      continue;
    }
    const [verb, word] = line.split(' ');
    if (verb === 'use') {
      if (!presets.some((p) => p.name === word)) {
        err('AZ1280', `ask ${q}: use '${word}', but this chat has no such preset — ${presets.length > 0 ? `use one of: ${presets.map((p) => p.name).join(', ')}` : `add one: ${PRESET_WORD} ${word}`}`, a.answer[1].pos);
      }
      continue;
    }
    if (!(word === QUOTED_WORD || word === 'faq' || word === 'feature') || !show.includes(word)) {
      err('AZ1276', `ask ${q}: shows ${word}, which this chat's show does not list — add it to show, or answer with another`, a.answer[1].pos);
      continue;
    }
    const why = rules ? rules.check(checkRules(show, rules.answers), `${line}\n`) : null;
    if (why !== null) err('AZ1277', `ask ${q}: the chat would drop ${line} (${why}) — ${why === 'no_quote' ? 'name a block this site has, by its route and place' : dropFix(why)}`, a.answer[0].pos);
  }
  return out;
}

/**
 * What a chat block's emitter needs beyond its props: the route the page's
 * questions are asked from, and where a signed-out visitor signs in when
 * only signed-in visitors may ask (null otherwise, or when no page has an
 * `auth login`).
 */
export function chatOf(
  route: string, allow: string | undefined, login: string | null, knows: readonly SpecChatTable[] = [],
): { route: string; signin: string | null; knows?: readonly SpecChatTable[] } {
  return { route, signin: allow === 'anyone' ? null : login, ...(knows.length > 0 ? { knows } : {}) };
}

/** Who may add rows to `t` or change them, as the rule that grants it — null when only the site's admins can (§8.2). */
function strangersWrite(t: SpecTable): { who: string; action: 'create' | 'edit' } | null {
  for (const action of ['create', 'edit'] as const) {
    const who = t.rules[action][0];
    if (who !== undefined) return { who, action };
  }
  return null;
}

/**
 * A table as a chat knows it: read by anyone, written only by the site's
 * admins, with only the fields a signed-out visitor reads — never a private
 * field, never an image — each `search` field marked. Null for a table the
 * rules refuse (AZ1252, AZ1253), so a refused table is never in the Spec.
 */
function knownTable(t: SpecTable): SpecChatTable | null {
  if (!t.rules.read.includes('anyone') || strangersWrite(t) !== null) return null;
  const fields = t.fields.filter((f) => !f.private && f.type !== 'image').map((f) => ({
    name: f.name, type: f.type,
    ...(f.choices ? { choices: f.choices } : {}),
    ...(f.currency ? { currency: f.currency, digits: CURRENCY_DIGITS[f.currency] ?? 2 } : {}),
    ...(f.search ? { search: true as const } : {}),
  }));
  return fields.length > 0 ? { name: t.name, fields } : null;
}

/** The tables a chat's `knows` names that it may know, in the order written, each once (§8.2). */
export function knowsTables(knows: string | undefined, tables: readonly SpecTable[]): SpecChatTable[] {
  const names = [...new Set((knows ?? '').split(LIST_SEPARATOR).filter(Boolean))].slice(0, KNOWS_MAX);
  return names.flatMap((n) => {
    const t = tables.find((x) => x.name === n);
    const known = t ? knownTable(t) : null;
    return known ? [known] : [];
  });
}

/** What the whole site offers every chat's answers: its quotable blocks and its declared destinations. */
export interface ChatAnswers {
  readonly quotes: SpecChatAnswer['quotes'];
  readonly destinations: readonly string[];
  /** Gallery images on public pages with their author's alt, keyed `i1`, `i2`… in page order (§20.6). */
  readonly images: NonNullable<SpecChatAnswer['images']>;
  /** Tables anyone may read, their public fields (§20.5). */
  readonly tables: readonly SpecChatTable[];
  /**
   * The faq and feature lists with an item on a page a signed-out visitor can
   * open (§19.16), numbered per page and word from 0 as chat-context.ts
   * numbers them: what `show faq /help #2` quotes, and the build's presets of them.
   */
  readonly lists: readonly { readonly word: 'faq' | 'feature'; readonly route: string; readonly n: number; readonly title: string; readonly items: readonly { readonly title: string; readonly text: string }[] }[];
}

/** The field types a figure may be asked of: measured, grouped or filtered (server chat-query.ts). */
const FIGURE_TYPES: ReadonlySet<string> = new Set(['text', 'longtext', 'number', 'money', 'flag', 'date', 'datetime', 'choice', 'image']);

/** A table chat may ask figures of — read by anyone, owner rows never — with only its public fields. */
function chatTable(t: SpecTable): SpecChatTable | null {
  if (!t.rules.read.includes('anyone')) return null;
  const fields = t.fields.filter((f) => !f.private && FIGURE_TYPES.has(f.type)).map((f) => ({
    name: f.name, type: f.type,
    ...(f.choices ? { choices: f.choices } : {}),
    ...(f.currency ? { currency: f.currency, digits: CURRENCY_DIGITS[f.currency] ?? 2 } : {}),
  }));
  return fields.length > 0 ? { name: t.name, fields } : null;
}

/** A block and every fill under it, depth first. */
const everyBlock = (b: SpecBlock): SpecBlock[] => [b, ...b.children.flatMap(everyBlock)];

/**
 * The quotable blocks and the destination allow-list (chat-block-spec §5.4,
 * §6.2), from the built pages:
 *
 *   - quotes: each `pricing` block on a page a signed-out visitor can open
 *     (not in `auth protect`), in page order, numbered per page from 0 — a
 *     protected page's prices would otherwise ship in a public page's markup;
 *   - destinations: every declared page route (a protected one too: it asks
 *     for sign-in as usual), every `route#anchor` written as a destination
 *     whose route is declared, and every `https:`, `mailto:` and `tel:`
 *     destination written in the file — exactly as written. A destination
 *     only a protected page holds is left out, for the same reason.
 */
export function chatAnswers(
  pages: readonly { readonly route: string; readonly blocks: readonly SpecBlock[] }[],
  inherited: readonly SpecBlock[], protect: ReadonlySet<string>, tables: readonly SpecTable[] = [],
): ChatAnswers {
  const routes = new Set(pages.map((p) => p.route));
  const quotes: { route: string; n: number; block: SpecBlock }[] = [];
  const destinations = new Set(routes);
  const visible = pages.filter((p) => !protect.has(p.route));
  for (const page of visible) {
    let n = 0;
    for (const b of page.blocks) if (b.word === QUOTED_WORD) quotes.push({ route: page.route, n: n++, block: b });
  }
  const lists: ChatAnswers['lists'][number][] = [];
  for (const page of visible) {
    for (const word of ['faq', 'feature'] as const) {
      page.blocks.filter((b) => b.word === word).forEach((b, n) => {
        const items = b.children.filter((c) => c.word === 'item')
          .map((i) => ({ title: word === 'faq' ? i.args[0]?.value ?? '' : i.args[0]?.value || (i.props.title ?? ''), text: i.props.text ?? '' }));
        if (items.length > 0) lists.push({ word, route: page.route, n, title: b.props.title ?? '', items });
      });
    }
  }
  for (const b of [...inherited, ...visible.flatMap((p) => p.blocks)].flatMap(everyBlock)) {
    for (const a of b.args) {
      if (a.kind === 'route') {
        const hash = a.value.indexOf('#');
        if (hash > 0 && routes.has(a.value.slice(0, hash))) destinations.add(a.value);
      } else if (a.kind === 'pair' && LINKABLE.test(a.value)) {
        destinations.add(a.value);
      }
    }
  }
  // A gallery's images, written as files with the author's alt: the only images an answer's card may show (§20.6).
  const images: { key: string; src: string; alt: string }[] = [];
  for (const b of visible.flatMap((p) => p.blocks).flatMap(everyBlock)) {
    // A file the build copies — not a row marker (a `from` gallery), not an address.
    const file = b.args[0]?.value ?? '';
    if (b.word !== 'image' || (b.args[0]?.kind !== 'path' && b.args[0]?.kind !== 'string') || file === '' || isFromMark(file) || file.includes(':')) continue;
    const alt = (b.props.alt ?? '').trim();
    if (alt === '' || images.some((i) => i.src === file)) continue;
    images.push({ key: `i${images.length + 1}`, src: file, alt });
  }
  return {
    quotes, destinations: [...destinations].sort(), images,
    tables: tables.map(chatTable).filter((t): t is SpecChatTable => t !== null),
    lists,
  };
}

/** The `show` words a chat block lists, in the closed list's order — only the words an answer may hold. */
const showOf = (props: Readonly<Record<string, string>>): string[] => {
  const written = (props.show ?? '').split(LIST_SEPARATOR).filter(Boolean);
  return CHAT_ANSWER_WORDS.filter((w) => written.includes(w));
};

/** The same, with `auto` last when the block lists it (§19.17): what autoPresets reads. */
const showAndAuto = (props: Readonly<Record<string, string>>): string[] =>
  [...showOf(props), ...((props.show ?? '').split(LIST_SEPARATOR).includes(AUTO_WORD) ? [AUTO_WORD] : [])];

/** A chat block's suggested questions, each its text and the answer written after it. */
const asksOf = (block: SpecBlock): { text: string; answer: string | null }[] =>
  block.children.filter((c) => c.word === 'ask' && c.args.length > 1)
    .map((c) => ({ text: c.args[0]?.value ?? '', answer: askAnswer(c.args.slice(1)) }));

/**
 * A chat block with what its answers may use; any other block unchanged.
 * Quotes only with `pricing`, destinations only with `cta`, so the shell
 * carries no more than its answers can show.
 */
export function withAnswer(block: SpecBlock, answers: ChatAnswers): SpecBlock {
  if (block.word !== CHAT_WORD || !block.chat) return block;
  const show = showOf(block.props);
  if (show.length === 0) return block;
  const rich = show.some((w) => CHAT_RICH_WORDS.includes(w));
  // Its presets, the author's and the build's (§19.17), and the suggested questions that answer with one.
  const written = block.children.filter((c) => c.word === PRESET_WORD && c.args[0] && c.props.body).map((c) => ({ name: c.args[0].value, body: c.props.body }));
  const presets = chatPresets(written, showAndAuto(block.props), answers);
  const asks = asksOf(block).filter((a): a is { text: string; answer: string } => a.answer !== null);
  return {
    ...block,
    chat: {
      ...block.chat,
      answer: {
        show,
        quotes: show.includes(QUOTED_WORD) ? answers.quotes : [],
        destinations: show.includes('cta') || show.includes('cards') ? answers.destinations : [],
        ...(show.includes('cards') ? { images: answers.images } : {}),
        ...(rich ? { tables: answers.tables } : {}),
      },
      ...(presets.length > 0 ? { presets } : {}),
      ...(asks.length > 0 ? { asks } : {}),
    },
  };
}

/**
 * The file-wide chat rules: AZ1250 (chat without a model), AZ1251 (a model
 * nothing uses), AZ1254 (a word an answer can never show), AZ1255 (`show
 * pricing` with no pricing block to quote), AZ1256 (`allow anyone` spends
 * the operator's budget on strangers), and `knows` (§8.2): AZ1271 (not a
 * table), AZ1252 (signed-out visitors can't read it, or none of its fields),
 * AZ1253 (strangers write to it), AZ1258 (named twice, or more than three).
 * AZ1272: a table named `tool` an answer could take figures from, where a
 * chat shows a component with `from` — that word is the data tools' (§21.2.3).
 * `quotable` is how many pricing blocks a signed-out visitor can see
 * (chatAnswers).
 */
export function chatDiagnostics(
  chats: readonly ChatDecl[], model: Arg | undefined, quotable = 0, tables: readonly SpecTable[] = [],
  presets?: { check?: AnswerCheck; answers: ChatAnswers },
): Diagnostic[] {
  const judged = presets?.check ? { check: presets.check, answers: presets.answers } : undefined;
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, pos: Pos) => out.push({ code, message, pos, severity: 'error' });
  const warn = (code: string, message: string, pos: Pos) => out.push({ code, message, pos, severity: 'warning' });

  for (const c of chats) {
    if (model === undefined) {
      err('AZ1250', `${CHAT_WORD}: needs a backend with a model — add under backend: model default`, c.pos);
    }
    const show = c.props.show;
    if (show) {
      const words = show.value.split(LIST_SEPARATOR).filter(Boolean);
      if (words.includes('dashboard') && !words.some((w) => DASHBOARD_TILES.includes(w))) {
        err('AZ1270', `${CHAT_WORD}: show dashboard, but nothing it can hold — add chart, table, stats or cards to show`, show.pos);
      }
      for (const word of show.value.split(LIST_SEPARATOR).filter(Boolean)) {
        if (word === AUTO_WORD) {
          // `auto` makes presets of the components show lists (§19.17): alone, there are none to make.
          if (!words.some((w) => CHAT_ANSWER_WORDS.includes(w))) {
            warn('AZ1281', `${CHAT_WORD}: show auto, but no component to make presets of — add the components (dashboard, chart, map, faq, feature, pricing), or write: show all`, show.pos);
          }
        } else if (CHAT_ANSWER_WORDS.includes(word)) {
          if (word === QUOTED_WORD && quotable === 0) {
            err('AZ1255', `${CHAT_WORD}: show pricing, but no page has a pricing block to quote — add one, or remove pricing from show`, show.pos);
          }
        } else {
          const why = Object.hasOwn(CHAT_REFUSED, word) ? ` (${CHAT_REFUSED[word]})` : '';
          err('AZ1254', `${CHAT_WORD}: '${word}' can't be in an answer${why} — show takes ${CHAT_ANSWER_WORDS.slice(0, -1).join(', ')} or ${CHAT_ANSWER_WORDS.at(-1)}, or a group: ${Object.keys(SHOW_GROUPS).join(', ')}`, show.pos);
        }
      }
    }
    const allow = c.props.allow;
    if (allow?.value === 'anyone') {
      warn('AZ1256', `${CHAT_WORD}: allow anyone — every stranger spends your model budget; the limits are in server/.env (AZ_CHAT_…)`, allow.pos);
    }
    const knows = c.props.knows;
    if (knows) out.push(...knowsDiagnostics(knows, tables));
    const props = Object.fromEntries(Object.entries(c.props).map(([k, a]) => [k, a.value]));
    const written = c.presets ?? [];
    out.push(...presetDiagnostics(written, showAndAuto(props), judged, c.props.show?.pos));
    if (c.asks && c.asks.length > 0 && presets) {
      const made = chatPresets(written.filter((p) => p.name !== undefined).map((p) => ({ name: p.name!.value, body: p.body })), showAndAuto(props), presets.answers);
      out.push(...askDiagnostics(c.asks, showOf(props), made, judged));
    }
  }
  // `from tool …` is always a request to the operator's data tools (§21.2.3): a table named `tool` that an answer
  // could take figures from would be read the other way, so it is refused where a chat shows a component with `from`.
  const toolTable = tables.find((t) => t.name === TOOLS_WORD);
  const rich = chats.find((c) => (c.props.show?.value.split(LIST_SEPARATOR) ?? []).some((w) => CHAT_RICH_WORDS.includes(w)));
  if (toolTable && chatTable(toolTable) !== null && rich?.props.show) {
    err('AZ1272', `${CHAT_WORD}: answers read "from ${TOOLS_WORD}" as the server's data tools, so the table '${TOOLS_WORD}' could never give figures — rename it, then run: az backend schema <file.az> --rename ${TOOLS_WORD}=<new name>`, rich.props.show.pos);
  }
  if (model && chats.length === 0) {
    warn('AZ1251', `backend: model default but no page shows chat — remove it, or add under site: chat float`, model.pos);
  }
  return out;
}

/** `knows`'s rules (§8.2), each table named once, in the order written. */
function knowsDiagnostics(knows: Arg, tables: readonly SpecTable[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string) => out.push({ code, message, pos: knows.pos, severity: 'error' });
  const names = knows.value.split(LIST_SEPARATOR).filter(Boolean);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      err('AZ1258', `${CHAT_WORD}: knows '${name}' twice — keep one`);
      continue;
    }
    seen.add(name);
    const t = tables.find((x) => x.name === name);
    if (!t) {
      err('AZ1271', `${CHAT_WORD}: knows '${name}', which is not a table — declare it under site with: data ${name}, or remove it`);
      continue;
    }
    if (!t.rules.read.includes('anyone')) {
      err('AZ1252', `${CHAT_WORD}: knows '${name}', which signed-out visitors can't read — chat only knows tables with: allow anyone read`);
      continue;
    }
    const writer = strangersWrite(t);
    if (writer) {
      const what = writer.action === 'create' ? 'takes rows from strangers' : 'lets strangers change its rows';
      err('AZ1253', `${CHAT_WORD}: knows '${name}', which ${what} (allow ${writer.who} ${writer.action}) — their text would steer the model; pick a table only you fill`);
      continue;
    }
    if (knownTable(t) === null) {
      err('AZ1252', `${CHAT_WORD}: knows '${name}', which has no field signed-out visitors can read — make one public, or remove it`);
    }
  }
  if (seen.size > KNOWS_MAX) err('AZ1258', `${CHAT_WORD}: knows ${seen.size} tables, max is ${KNOWS_MAX} — remove ${seen.size - KNOWS_MAX}`);
  return out;
}

/**
 * AZ1259: a site with a chat owns its shared-answer page (§20.7), as a site
 * with data owns /admin (AZ1268) — in any case, since `/Chat/Shared` is the
 * same folder on a case-insensitive disk.
 */
export function sharedRouteDiagnostics(hasChat: boolean, pages: readonly { readonly route: string | undefined; readonly pos: Pos }[]): Diagnostic[] {
  if (!hasChat) return [];
  return pages.filter((p) => p.route?.toLowerCase() === SHARED_ROUTE).map((p) => ({
    code: 'AZ1259', message: `page: '${p.route}' is the shared-answer page chat generates — use another route`, pos: p.pos, severity: 'error' as const,
  }));
}
