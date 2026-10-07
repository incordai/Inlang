/**
 * `az mcp` hardening — findings from the independent CLI/MCP review.
 *
 * The central one: a tool marked read-only must not run code from the
 * project it reads. A project word's emitter here writes a marker file and a
 * stray line to stdout when it is loaded, so each test can see whether a
 * tool executed it — and whether the protocol stream survived.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const REPLY_TIMEOUT_MS = 30_000;

const GOOD = 'az 1\nsite aurora\npage /\n  hero center\n    title "Built in the dark"\n';

/** A project whose own word runs code when loaded. */
function projectWithCode() {
  const dir = mkdtempSync(join(tmpdir(), 'az-mcp-hard-'));
  writeFileSync(join(dir, 'site.az'), GOOD);
  mkdirSync(join(dir, 'words/badge'), { recursive: true });
  writeFileSync(join(dir, 'words/badge/word.json'), JSON.stringify({ name: 'badge', variants: ['plain'] }));
  writeFileSync(join(dir, 'words/badge/emit.web.ts'),
    "import { writeFileSync } from 'node:fs';\n"
    + "writeFileSync(new URL('./ran.txt', import.meta.url), 'yes');\n"
    + "console.log('stray output from a project word');\n"
    + "export const emit = () => ({ tag: 'span', children: ['x'] });\n");
  return { dir, marker: join(dir, 'words/badge/ran.txt') };
}

interface Reply { id?: number | null; result?: any; error?: { code: number; message: string } }

async function session(root: string, messages: object[], between?: () => void): Promise<Reply[]> {
  const child = spawn(process.execPath, [...process.execArgv, BIN, 'mcp', '--root', root],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { out += c; });
  child.stdin.write(JSON.stringify(messages[0]) + '\n');
  // Give the server its first request before the test changes the world.
  if (between) {
    await new Promise<void>((done) => { child.stdout.once('data', () => done()); });
    between();
  }
  for (const m of messages.slice(1)) child.stdin.write(JSON.stringify(m) + '\n');
  child.stdin.end();
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => { child.kill(); fail(new Error(`no exit; got:\n${out}`)); }, REPLY_TIMEOUT_MS);
    child.once('exit', () => { clearTimeout(t); done(); });
  });
  // Every stdout line must be protocol: a stray line fails the parse here.
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Reply);
}

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
const call = (id: number, name: string, args: object = {}) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

for (const [name, args] of [['az_check', { file: 'site.az' }], ['az_spec', { file: 'site.az' }], ['az_words', {}], ['az_doctor', { file: 'site.az' }]] as const) {
  test(`${name} (read-only) does not run the project's code`, async () => {
    const p = projectWithCode();
    const replies = await session(p.dir, [INIT, call(1, name, args)]);
    assert.equal(replies.find((r) => r.id === 1)?.result?.isError, false);
    assert.ok(!existsSync(p.marker), `${name} executed the project's emitter`);
  });
}

test('CONTROL: az_words still lists the project\'s own word, from its manifest', async () => {
  const p = projectWithCode();
  const replies = await session(p.dir, [INIT, call(1, 'az_words')]);
  const words = replies.find((r) => r.id === 1)?.result?.structuredContent?.words as { name: string }[];
  assert.ok(words.some((w) => w.name === 'badge'));
});

test('az_build runs the project\'s code, says so, and stray output does not corrupt the stream', async () => {
  const p = projectWithCode();
  const replies = await session(p.dir, [INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'az_build', { file: 'site.az' })]);
  const build = replies.find((r) => r.id === 2)?.result;
  assert.equal(build?.isError, false, JSON.stringify(build));
  assert.ok(existsSync(p.marker), 'CONTROL: a build does run the project\'s words');
  const tools = replies.find((r) => r.id === 1)?.result.tools as { name: string; description: string; annotations: { destructiveHint: boolean } }[];
  const def = tools.find((t) => t.name === 'az_build');
  assert.equal(def?.annotations.destructiveHint, true);
  assert.match(def?.description ?? '', /RUNS PROJECT CODE/);
  const migrate = tools.find((t) => t.name === 'az_migrate');
  assert.equal(migrate?.annotations.destructiveHint, true, 'migrate rewrites the author\'s own file');
});

test('a missing file is a tool error the agent can read, not "internal error"', async () => {
  const p = projectWithCode();
  const replies = await session(p.dir, [INIT, call(1, 'az_check', { file: 'typo.az' })]);
  const r = replies.find((x) => x.id === 1);
  assert.equal(r?.error, undefined, JSON.stringify(r));
  assert.equal(r?.result.isError, true);
  assert.match(r?.result.content[0].text, /'typo\.az' does not exist/);
});

test('a root deleted mid-session gets an answer, not silence', async () => {
  const p = projectWithCode();
  const replies = await session(p.dir, [INIT, call(1, 'az_check', { file: 'site.az' })],
    () => rmSync(p.dir, { recursive: true, force: true }));
  const r = replies.find((x) => x.id === 1);
  assert.ok(r, 'the request was answered');
  assert.equal(r?.result?.isError, true);
});

test('an inherited name is not a known argument', async () => {
  const p = projectWithCode();
  const replies = await session(p.dir, [INIT, call(1, 'az_words', { constructor: 'x' })]);
  const r = replies.find((x) => x.id === 1);
  assert.equal(r?.result?.isError, true);
  assert.match(r?.result.content[0].text, /unknown argument 'constructor'/);
});
