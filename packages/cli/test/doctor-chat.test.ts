/**
 * `az doctor`'s chat checks (doctor-chat.ts, chat-block-spec §11.2): each
 * against a real build of a chat site with a planted bad configuration — the
 * chat keys by name, the fake model, a model URL with the completions path on
 * it, a budget that cannot pay for one answer, the default budget and the kill
 * switch, a known table whose built rules or source changed, a page the
 * context's cap leaves out — each with its CONTROL, and no planted value ever
 * in the report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, doctor } from '../src/doctor-checks.ts';
import { answerCost } from '../src/doctor-chat.ts';
import { formatReport, systemProbe, type Probe } from '../src/doctor.ts';
import { findNpmCli } from '../src/serve.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');

const CHAT_SITE = (guides = '    title  text required search\n    secret text private\n', pages = '') => `az 1

site shop
  auth
    adapter azbackend
  backend
    database sqlite
    email    smtp
    model    default
  data guides
${guides}    allow anyone read

page /
  hero center
    title "Shop"
  chat panel
    title    "Ask"
    greeting "Ask me."
    show     faq cta
    allow    anyone
    knows    guides
${pages}
page /login
  auth login
    redirect /
`;

/** A model key and a moderation key planted in .env: neither may reach a report. */
const MODEL_KEY = `planted-model-key-${'k9'.repeat(10)}`;
const JUDGE_KEY = `planted-judge-key-${'j7'.repeat(10)}`;

const az = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, timeout: 60_000 });

/** A real build of a chat site (and `files` beside it), its schema recorded, its server's .env written from `az backend init` and filled. */
function built(source = CHAT_SITE(), files: Readonly<Record<string, string>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-doctor-chat-'));
  writeFileSync(join(dir, 'site.az'), source);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  assert.equal(az(dir, 'backend', 'schema', 'site.az').status, 0);
  const b = az(dir, 'build', 'site.az');
  assert.equal(b.status, 0, b.stderr);
  const server = join(dir, '.az-build/server');
  assert.equal(az(dir, 'backend', 'init', server).status, 0);
  const env = join(server, '.env');
  const base = readFileSync(env, 'utf8')
    .replace(/^AZ_SMTP_HOST=$/m, 'AZ_SMTP_HOST=smtp.invalid')
    .replace(/^AZ_CHAT_URL=$/m, 'AZ_CHAT_URL=https://models.example.test/v1')
    .replace(/^AZ_CHAT_MODEL=$/m, 'AZ_CHAT_MODEL=model-a')
    .replace(/^AZ_CHAT_KEY=$/m, `AZ_CHAT_KEY=${MODEL_KEY}`)
    .replace(/^AZ_CHAT_DAILY_TOKENS=.*$/m, 'AZ_CHAT_DAILY_TOKENS=300000');
  writeFileSync(env, base, { mode: 0o600 });
  /** The .env with each key given set to its value (an empty string clears it). */
  const setEnv = (keys: Record<string, string>) => {
    let text = base;
    for (const [k, v] of Object.entries(keys)) {
      text = new RegExp(`^${k}=`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${text}${k}=${v}\n`;
    }
    writeFileSync(env, text, { mode: 0o600 });
  };
  return { dir, file: join(dir, 'site.az'), out: join(dir, '.az-build'), server, setEnv };
}

const fakeProbe = (): Probe => ({ ...systemProbe(findNpmCli), env: {} });

async function check(id: string, p: { dir: string; file: string; out: string }) {
  const c = CHECKS.find((x) => x.id === id);
  assert.ok(c, `no check ${id}`);
  const r = await doctor({ source: p.file, outDir: p.out, cwd: p.dir, wordsDir: WORDS, probe: fakeProbe(), projectModules: true, checks: [c] });
  const text = formatReport(r) + JSON.stringify(r);
  for (const secret of [MODEL_KEY, JUDGE_KEY, 'k9k9', 'j7j7']) assert.ok(!text.includes(secret), `${id}: a planted value reached the report`);
  return r.checks[0];
}

test('chat checks run between backend .env and build secrets, and skip a site without chat', async () => {
  const ids = CHECKS.map((c) => c.id);
  assert.deepEqual(ids.slice(ids.indexOf('backend-env'), ids.indexOf('build-secrets') + 1), ['backend-env', 'chat-env', 'chat-tools', 'chat-map', 'chat-budget', 'chat-context', 'build-secrets']);
  const plain = mkdtempSync(join(tmpdir(), 'az-doctor-chat-'));
  writeFileSync(join(plain, 'site.az'), 'az 1\nsite aurora\npage /\n  hero center\n    title "Hi"\n');
  const p = { dir: plain, file: join(plain, 'site.az'), out: join(plain, '.az-build') };
  for (const id of ['chat-env', 'chat-tools', 'chat-map', 'chat-budget', 'chat-context']) assert.equal((await check(id, p)).status, 'skip', id);
});

test('chat .env: the keys by name only — the fake model, a URL with the completions path, a refused key, moderation without its URL; CONTROL passes', async () => {
  const p = built();
  const good = await check('chat-env', p);
  assert.equal(good.status, 'pass', good.line);
  assert.equal(good.line, 'chat .env: the model keys are valid; no moderation hook (optional); shares on — names checked, no value printed');

  p.setEnv({ AZ_CHAT_URL: 'https://models.example.test/v1/chat/completions' });
  const path = await check('chat-env', p);
  assert.equal(path.status, 'fail');
  assert.equal(path.line, 'chat .env: 1 problem — AZ_CHAT_URL ends in /chat/completions — the server adds that path, so it would ask /chat/completions/chat/completions');
  assert.ok(!JSON.stringify(path).includes('models.example.test'), 'the URL itself is not printed');

  // The fake model on a loopback server starts — and is still no deployment.
  p.setEnv({ AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: './fake.json', AZ_CHAT_URL: '', AZ_CHAT_MODEL: '' });
  const fake = await check('chat-env', p);
  assert.equal(fake.status, 'fail');
  assert.match(fake.line, /AZ_CHAT_API=fake answers from a script, for development only$/);
  // Off loopback the server refuses it too: both said.
  p.setEnv({ AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: './fake.json', AZ_BACKEND_PUBLIC_URL: 'https://api.shop.example' });
  const off = await check('chat-env', p);
  assert.equal(off.line, 'chat .env: 2 problems — AZ_CHAT_API is refused by the server');
  assert.ok(off.fix!.includes('AZ_CHAT_API=fake answers from a script, for development only'));

  p.setEnv({ AZ_CHAT_CONCURRENCY: '0', AZ_CHAT_MODERATION_KEY: JUDGE_KEY, AZ_CHAT_SHARE_DAYS: '999' });
  const refused = await check('chat-env', p);
  assert.equal(refused.status, 'fail');
  const named = [refused.line.replace(/^chat \.env: 3 problems — /, ''), ...refused.fix!.slice(0, 2)].sort();
  assert.deepEqual(named, ['AZ_CHAT_CONCURRENCY', 'AZ_CHAT_MODERATION_KEY', 'AZ_CHAT_SHARE_DAYS'].map((k) => `${k} is refused by the server`));

  p.setEnv({ AZ_CHAT_MODERATION_URL: 'http://judge.example.test/check', AZ_CHAT_MODERATION_KEY: JUDGE_KEY });
  assert.equal((await check('chat-env', p)).line, 'chat .env: 1 problem — AZ_CHAT_MODERATION_URL is refused by the server');
  p.setEnv({ AZ_CHAT_MODERATION_URL: 'https://judge.example.test/check', AZ_CHAT_MODERATION_KEY: JUDGE_KEY, AZ_CHAT_SHARES: 'off' });
  assert.equal((await check('chat-env', p)).line, 'chat .env: the model keys are valid; moderation hook on (it fails closed); new shares off — names checked, no value printed');
});

/** A planted tool key: never in a report either. */
const TOOL_KEY = `planted-tool-key-${'t3'.repeat(10)}`;
/** The data tool "standings", declared whole (chat-block-spec §21.2.2). */
const TOOL = {
  AZ_CHAT_TOOLS: 'standings',
  AZ_CHAT_TOOL_STANDINGS_URL: 'https://tools.example.test/standings',
  AZ_CHAT_TOOL_STANDINGS_KEY: TOOL_KEY,
  AZ_CHAT_TOOL_STANDINGS_PARAMS: JSON.stringify({ season: { type: 'int', min: 2000, max: 2030, required: true } }),
  AZ_CHAT_TOOL_STANDINGS_FIELDS: JSON.stringify({ driver: 'text', points: 'number' }),
  AZ_CHAT_TOOL_STANDINGS_LABEL: 'Race results service',
  AZ_CHAT_TOOL_STANDINGS_SAMPLE: JSON.stringify({ season: 2026 }),
};

test('chat tools: each declaration and its sample by key name; refused keys fail, a missing sample or a chat that cannot use them warns; CONTROL passes', async () => {
  const p = built(CHAT_SITE().replace('show     faq cta', 'show     faq cta chart table stats'));
  const quiet = async () => {
    const r = await check('chat-tools', p);
    for (const leak of [TOOL_KEY, 't3t3', 'tools.example.test', '2026']) assert.ok(!JSON.stringify(r).includes(leak), `${leak} reached the report`);
    return r;
  };
  assert.deepEqual([(await quiet()).status, (await quiet()).line], ['skip', 'chat tools: none declared (AZ_CHAT_TOOLS is optional)']);
  p.setEnv(TOOL);
  const good = await quiet();
  assert.deepEqual([good.status, good.line], ['pass', 'chat tools: 1 tool declared (standings), each URL, parameter shape, field shape, label and sample valid — names checked, no value printed']);
  // The other chat lines stay the model's and the budget's: a tool's keys are this line's alone.
  assert.equal((await check('chat-env', p)).status, 'pass');
  assert.equal((await check('chat-budget', p)).status, 'pass');

  p.setEnv({ ...TOOL, AZ_CHAT_TOOL_STANDINGS_URL: 'http://tools.example.test/standings', AZ_CHAT_TOOL_STANDINGS_SAMPLE: JSON.stringify({ season: 1999 }) });
  const refused = await quiet();
  assert.equal(refused.status, 'fail');
  assert.equal(refused.line, 'chat tools: AZ_CHAT_TOOL_STANDINGS_URL, AZ_CHAT_TOOL_STANDINGS_SAMPLE are refused by the server — it won\'t start');
  assert.equal((await check('chat-env', p)).status, 'pass', 'not said twice');
  assert.equal((await check('chat-budget', p)).line, 'chat budget: judged once the server\'s keys are valid — see the chat tools line');

  p.setEnv({ ...TOOL, AZ_CHAT_TOOL_RESULT_URL: 'https://tools.example.test/x' });
  assert.equal((await quiet()).line, 'chat tools: AZ_CHAT_TOOL_RESULT_URL is refused by the server — it won\'t start');

  p.setEnv({ ...TOOL, AZ_CHAT_TOOL_STANDINGS_SAMPLE: '' });
  const unsampled = await quiet();
  assert.deepEqual([unsampled.status, unsampled.line], ['warn', 'chat tools: AZ_CHAT_TOOL_STANDINGS_SAMPLE is not set — az backend probe can\'t call that tool (it requires parameters)']);

  // A site whose chat shows none of chart, table, stats: no answer can use a tool.
  const q = built();
  q.setEnv(TOOL);
  const unusable = await check('chat-tools', q);
  assert.deepEqual([unusable.status, unusable.line], ['warn', 'chat tools: no chat shows a chart, a table, stats, cards or an explore, so no answer can use a tool']);
});

test('chat budget: a budget that cannot pay for one answer fails; the default and the kill switch warn; CONTROL passes with the answers it pays for', async () => {
  const p = built();
  const prompt = readFileSync(join(p.server, 'chat/prompt.txt'), 'utf8').length;
  const context = readFileSync(join(p.server, 'chat/context.json'), 'utf8').length;
  // The server's own estimate: 3 characters a token, 12 000 of history, 12 000 per known table, the output cap.
  const cost = answerCost({ prompt, context, knows: 1, maxOutput: 600, charsPerToken: 3, historyChars: 12_000, tableChars: 12_000 });
  assert.equal(cost.least, Math.ceil((prompt + context) / 3) + 600);
  assert.equal(cost.most, Math.ceil((prompt + context + 24_000) / 3) + 600);

  const good = await check('chat-budget', p);
  assert.equal(good.status, 'pass', good.line);
  assert.equal(good.line, `chat budget: 300000 tokens a day pays for about ${Math.floor(300_000 / cost.most)} answers at the largest (${cost.most} tokens each by the server's estimate; 600 out)`);

  p.setEnv({ AZ_CHAT_DAILY_TOKENS: String(cost.least - 1) });
  const poor = await check('chat-budget', p);
  assert.equal(poor.status, 'fail');
  assert.equal(poor.line, `chat budget: AZ_CHAT_DAILY_TOKENS ${cost.least - 1} can't pay for one answer (at least ${cost.least} tokens by the server's estimate) — every question would answer budget_exhausted`);
  // The boundary: exactly one answer's least passes.
  p.setEnv({ AZ_CHAT_DAILY_TOKENS: String(cost.least) });
  assert.notEqual((await check('chat-budget', p)).status, 'fail');

  p.setEnv({ AZ_CHAT_DAILY_TOKENS: '', AZ_CHAT_ENABLED: 'off' });
  const warned = await check('chat-budget', p);
  assert.equal(warned.status, 'warn');
  assert.equal(warned.line, 'chat budget: AZ_CHAT_DAILY_TOKENS is not set — the default 300000 applies; AZ_CHAT_ENABLED=off — chat answers disabled to everyone');

  // A key the server refuses is the chat .env line's, not a budget to judge.
  p.setEnv({ AZ_CHAT_MAX_OUTPUT_TOKENS: 'lots' });
  assert.deepEqual([(await check('chat-budget', p)).status, (await check('chat-budget', p)).line], ['skip', 'chat budget: judged once the server\'s keys are valid — see the chat .env line']);
});

test('chat context: a known table opened to writers, a field made private, or changed in the source since the build fails; CONTROL passes', async () => {
  const p = built();
  const good = await check('chat-context', p);
  assert.equal(good.status, 'pass', good.line);
  assert.equal(good.line, 'chat context: matches the tables — 1 known table, readable signed out, written by admins only');

  const dataFile = join(p.server, 'data.json');
  const original = readFileSync(dataFile, 'utf8');
  const tamper = (edit: (t: { rules: Record<string, string[]>; fields: { name: string; private?: boolean }[] }) => void) => {
    const data = JSON.parse(original) as { tables: { name: string; rules: Record<string, string[]>; fields: { name: string; private?: boolean }[] }[] };
    edit(data.tables.find((t) => t.name === 'guides')!);
    writeFileSync(dataFile, JSON.stringify(data));
  };
  tamper((t) => { t.rules.create = ['anyone']; });
  const writable = await check('chat-context', p);
  assert.equal(writable.status, 'fail');
  assert.match(writable.line, /^chat context: chat knows 'guides', which others than the site's admins can write to$/);

  tamper((t) => { t.fields.find((f) => f.name === 'title')!.private = true; });
  assert.equal((await check('chat-context', p)).line, "chat context: chat knows 'guides.title', which is not a public field here");

  tamper((t) => { t.rules.read = ['owner']; });
  assert.match((await check('chat-context', p)).line, /which signed-out visitors can't read$/);

  // The source moved on since the build: the server checks the rules it was built with.
  writeFileSync(dataFile, original);
  writeFileSync(p.file, CHAT_SITE('    title  text required search\n    secret text private\n    body   text\n'));
  const changed = await check('chat-context', p);
  assert.equal(changed.status, 'fail');
  assert.equal(changed.line, "chat context: the rules or fields of 'guides', which a chat knows, changed since the build");
});

test('chat context: AZ1257 — a page the context\'s cap leaves out is a warning naming it', async () => {
  // Four pages of 8 000 characters each pass the 24 000-character cap with the rest of the site: the pages that do not fit are left out whole.
  const long = (route: string) => `\npage ${route}\n  text\n    title "Notes"\n    body "${'Plain words. '.repeat(615)}"\n`;
  const p = built(CHAT_SITE(undefined, ['/a', '/b', '/c', '/d'].map(long).join('')));
  const r = await check('chat-context', p);
  assert.equal(r.status, 'warn', r.line);
  assert.equal(r.line, 'chat context: AZ1257 — 2 pages left out of what the model is told (/c, /d): the context is past its cap');
  // CONTROL: the build says the same pages.
  const warned = az(p.dir, 'build', 'site.az');
  assert.match(warned.stderr, /AZ1257 chat: the site context is over 24000 characters — \/c is left out/);
  assert.match(warned.stderr, /AZ1257 chat: the site context is over 24000 characters — \/d is left out/);
});

test('chat context: AZ1257 counts text bodies kept in files, as az build does — the same pages named; a body outside the project fails', async () => {
  // The bodies are files: only a reader of them knows the pages are long (doctor once read none, and said nothing).
  const long = (route: string) => `\npage ${route}\n  text\n    title "Notes"\n    body .${route}.md\n`;
  const notes = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`${n}.md`, `## Notes\n\n${'Plain words. '.repeat(615)}\n`]));
  const p = built(CHAT_SITE(undefined, ['/a', '/b', '/c', '/d'].map(long).join('')), notes);
  const warned = az(p.dir, 'build', 'site.az');
  assert.equal(warned.status, 0, warned.stderr);
  const left = [...warned.stderr.matchAll(/AZ1257 chat: the site context is over 24000 characters — (\/\w) is left out/g)].map((m) => m[1]);
  assert.deepEqual(left, ['/c', '/d'], warned.stderr);
  const r = await check('chat-context', p);
  assert.equal(r.status, 'warn', r.line);
  assert.equal(r.line, `chat context: AZ1257 — 2 pages left out of what the model is told (${left.join(', ')}): the context is past its cap`);
  // A body whose path climbs out of the project (refused by its path alone): the build refuses it, and doctor does not pass it.
  writeFileSync(join(p.dir, 'site.az'), readFileSync(join(p.dir, 'site.az'), 'utf8').replace('body ./a.md', 'body ./notes/../../outside.md'));
  const escaped = await check('chat-context', p);
  assert.equal(escaped.status, 'fail', escaped.line);
  assert.equal(escaped.line, 'chat context: a text body kept in a file cannot be read into the context — az build refuses it too');
  const refused = az(p.dir, 'build', 'site.az');
  assert.notEqual(refused.status, 0, 'the build refuses the same body');
  assert.match(refused.stderr, /points outside the project/);
});

/** A 127-byte PMTiles v3 header (zoom 0–6) and a little data: an archive as the server opens it. */
function pmtiles(): Buffer {
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1');
  header.writeUInt8(3, 7);
  header.writeUInt8(0, 100);
  header.writeUInt8(6, 101);
  return Buffer.concat([header, Buffer.alloc(64)]);
}

test('chat map (§21.4.3): the archive, folders and attribution as the server opens them; no archive warns; a refused key or a foreign file fails; a third-party archive is named; CONTROL passes', async () => {
  const p = built(CHAT_SITE().replace('    show     faq cta\n', '    show     faq cta map\n'));
  const r0 = await check('chat-map', p);
  assert.equal(r0.status, 'warn', r0.line);
  assert.equal(r0.line, 'chat map: AZ_MAP_WORLD is not set — every map shows its list of places only');
  // Paths are the server folder's, where it runs.
  mkdirSync(join(p.server, 'map', 'glyphs'), { recursive: true });
  mkdirSync(join(p.server, 'map', 'sprites'));
  writeFileSync(join(p.server, 'map', 'world.pmtiles'), pmtiles());
  writeFileSync(join(p.server, 'map', 'notes.txt'), 'not an archive at /secret/place. '.repeat(8));
  p.setEnv({ AZ_MAP_WORLD: './map/world.pmtiles', AZ_MAP_GLYPHS: './map/glyphs', AZ_MAP_SPRITES: './map/sprites', AZ_MAP_ATTRIBUTION: 'Map data: the fixture' });
  const ok = await check('chat-map', p);
  assert.equal(ok.status, 'pass', ok.line);
  assert.equal(ok.line, 'chat map: the world archive to zoom 6; labels; icons; attribution set; no geocoder (optional); tiles, glyphs and sprites from this server only');
  p.setEnv({ AZ_MAP_WORLD: './map/world.pmtiles', AZ_MAP_ATTRIBUTION: '' });
  const noLine = await check('chat-map', p);
  assert.equal(noLine.status, 'fail');
  assert.equal(noLine.line, 'chat map: AZ_MAP_ATTRIBUTION is refused by the server — it won\'t start');
  p.setEnv({ AZ_MAP_WORLD: './map/notes.txt', AZ_MAP_ATTRIBUTION: 'Map data: the fixture' });
  const foreign = await check('chat-map', p);
  assert.equal(foreign.status, 'fail');
  assert.equal(foreign.line, 'chat map: AZ_MAP_WORLD is not a PMTiles archive — the server won\'t start');
  assert.ok(!JSON.stringify(foreign).includes('/secret/place'), 'never a value or a path');
  // The site's build given a third-party archive: its origin named, as a warning, the backend's own still checked.
  p.setEnv({ AZ_MAP_WORLD: './map/world.pmtiles', AZ_MAP_ATTRIBUTION: 'Map data: the fixture' });
  writeFileSync(join(p.out, '.env'), 'AZ_PUBLIC_MAP_TILES_URL=https://tiles.example.net/world.pmtiles\n');
  const third = await check('chat-map', p);
  assert.equal(third.status, 'warn', third.line);
  assert.equal(third.line, 'chat map: tiles come from https://tiles.example.net (AZ_PUBLIC_MAP_TILES_URL) — that third party learns where every visitor\'s maps look');
  // CONTROL: a chat that shows no maps is skipped.
  const plain = await check('chat-map', built());
  assert.equal(plain.status, 'skip');
  assert.equal(plain.line, 'chat map: no chat shows a map');
});
