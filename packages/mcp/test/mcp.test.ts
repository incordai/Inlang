/**
 * `az mcp` over real stdio — the protocol, every tool, and the root sandbox.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const REPLY_TIMEOUT_MS = 20_000;

const GOOD = 'az 1\nsite aurora\npage /\n  hero center\n    title "Built in the dark"\n';
const BROKEN = 'az 1\nsite aurora\npage /\n  nonsense\n';

interface Reply { id?: number | null; result?: any; error?: { code: number; message: string } }

/** A project root with a good and a broken .az file. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'az-mcp-'));
  writeFileSync(join(dir, 'site.az'), GOOD, 'utf8');
  writeFileSync(join(dir, 'broken.az'), BROKEN, 'utf8');
  return dir;
}

/** Send lines to `az mcp --root dir`, close stdin, and collect every reply. */
async function session(root: string, messages: (object | string)[]): Promise<Reply[]> {
  const child = spawn(process.execPath, [...process.execArgv, BIN, 'mcp', '--root', root],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { out += c; });
  for (const m of messages) child.stdin.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n');
  child.stdin.end();
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => { child.kill(); fail(new Error(`no exit; got:\n${out}`)); }, REPLY_TIMEOUT_MS);
    child.once('exit', () => { clearTimeout(t); done(); });
  });
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Reply);
}

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
const call = (id: number, name: string, args: object = {}) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function tool(root: string, name: string, args: object = {}) {
  const replies = await session(root, [INIT, call(1, name, args)]);
  const r = replies.find((x) => x.id === 1);
  assert.ok(r?.result, JSON.stringify(r));
  return r.result as { isError: boolean; content: { text: string }[]; structuredContent?: any };
}

/* ---- the protocol ------------------------------------------------------- */

test('initialize echoes a supported protocol version and names the server', async () => {
  const [r] = await session(project(), [INIT]);
  assert.equal(r.result.protocolVersion, '2025-11-25');
  assert.equal(r.result.serverInfo.name, 'az');
  assert.ok(r.result.capabilities.tools && r.result.capabilities.resources);
});

test('initialize instructions give the authoring order: colour (theme, accent, pattern), then the frame, then sections', async () => {
  const [r] = await session(project(), [INIT]);
  const text = r.result.instructions as string;
  assert.equal(typeof text, 'string');
  const at = (s: string) => {
    const i = text.indexOf(s);
    assert.ok(i >= 0, `instructions name '${s}':\n${text}`);
    return i;
  };
  const colour = at('Colour first');
  for (const s of ['theme', 'accent', 'pattern', 'az_palette', 'az_explain', '2-3 options', 'exact .az lines', 'confirm']) {
    assert.ok(at(s) > colour, `'${s}' is part of the colour step`);
  }
  const frame = at('Then the frame');
  const sections = at('Then sections');
  assert.ok(colour < frame && frame < sections, 'colour, then frame, then sections');
  assert.ok(at('width') > frame && at('font') > frame, 'the frame is width and font');
  assert.ok(at('az_check') > sections, 'sections are checked last');
  assert.ok(text.length < 1200, `short: ${text.length} characters`);
});

test('CONTROL: an unknown protocol version is answered with the newest supported one', async () => {
  const [r] = await session(project(), [{ ...INIT, params: { ...INIT.params, protocolVersion: '1999-01-01' } }]);
  assert.equal(r.result.protocolVersion, '2025-11-25');
});

test('tools/list offers every tool with a schema, and marks the ones that write', async () => {
  const [, r] = await session(project(), [INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const tools = r.result.tools as { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[];
  assert.deepEqual(tools.map((t) => t.name).sort(), ['az_audit', 'az_backend_init', 'az_build', 'az_check', 'az_doctor', 'az_eject',
    'az_explain', 'az_grammar', 'az_lint', 'az_migrate', 'az_palette', 'az_prompt', 'az_spec', 'az_word_docs', 'az_words']);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
  const writers = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(writers, ['az_backend_init', 'az_build', 'az_eject', 'az_migrate']);
});

test('protocol errors: unknown tool, unknown method, bad JSON, batches; notifications get no reply', async () => {
  const replies = await session(project(), [
    INIT,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    call(1, 'az_nope'),
    { jsonrpc: '2.0', id: 2, method: 'no/such' },
    '{ not json',
    [{ jsonrpc: '2.0', id: 3, method: 'ping' }],
    { jsonrpc: '2.0', id: 4, method: 'ping' },
  ]);
  const by = (id: number) => replies.find((r) => r.id === id);
  assert.equal(by(1)?.error?.code, -32602);
  assert.equal(by(2)?.error?.code, -32601);
  assert.ok(replies.some((r) => r.id === null && r.error?.code === -32700), 'parse error');
  assert.ok(replies.some((r) => r.id === null && r.error?.code === -32600), 'batch refused');
  assert.deepEqual(by(4)?.result, {}, 'CONTROL: ping still answers');
  assert.equal(replies.length, 6, 'the notification got no reply');
});

test('arguments are checked against the schema', async () => {
  const root = project();
  assert.match((await tool(root, 'az_check', {})).content[0].text, /missing required argument 'file'/);
  assert.match((await tool(root, 'az_check', { file: 'site.az', extra: 'x' })).content[0].text, /unknown argument 'extra'/);
});

/* ---- the tools ---------------------------------------------------------- */

test('az_check reports diagnostics with position; a good file has no errors', async () => {
  const root = project();
  const bad = await tool(root, 'az_check', { file: 'broken.az' });
  const d = bad.structuredContent.diagnostics[0];
  assert.equal(d.severity, 'error');
  assert.equal(d.line, 4);
  assert.match(d.code, /^AZ\d{4}$/);
  const good = await tool(root, 'az_check', { file: 'site.az' });
  assert.equal(good.structuredContent.diagnostics.filter((x: { severity: string }) => x.severity === 'error').length, 0);
});

test('az_spec returns the resolved Spec, and null for a file that does not compile', async () => {
  const root = project();
  const ok = await tool(root, 'az_spec', { file: 'site.az' });
  assert.equal(ok.structuredContent.spec.pages[0].blocks[0].word, 'hero');
  assert.equal((await tool(root, 'az_spec', { file: 'broken.az' })).structuredContent.spec, null);
});

test('az_build writes the project inside the root and lists it', async () => {
  const root = project();
  const r = await tool(root, 'az_build', { file: 'site.az', out: 'out' });
  assert.equal(r.structuredContent.ok, true, r.structuredContent.diagnostics);
  assert.ok(r.structuredContent.files.includes('src/App.tsx'));
  assert.ok(existsSync(join(root, 'out/src/App.tsx')));
});

test('az_words is the catalogue; az_word_docs reads a README; az_grammar the reference', async () => {
  const root = project();
  const words = (await tool(root, 'az_words')).structuredContent.words as { name: string; variants: string[] }[];
  assert.equal(words.length, 11);
  assert.ok(words.find((w) => w.name === 'hero')?.variants.includes('split'));
  assert.match((await tool(root, 'az_word_docs', { word: 'hero' })).structuredContent.readme, /# `hero`/);
  assert.equal((await tool(root, 'az_word_docs', { word: 'nope' })).isError, true);
  assert.match((await tool(root, 'az_grammar')).structuredContent.grammar, /az 1/);
});

test('the grammar is also a resource', async () => {
  const replies = await session(project(), [INIT,
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'az://grammar' } }]);
  assert.equal(replies.find((r) => r.id === 1)?.result.resources[0].uri, 'az://grammar');
  assert.match(replies.find((r) => r.id === 2)?.result.contents[0].text, /az 1/);
});

test('az_lint passes the bundled words; az_migrate leaves a current file alone', async () => {
  const root = project();
  assert.deepEqual((await tool(root, 'az_lint')).structuredContent.findings, []);
  const m = await tool(root, 'az_migrate', { file: 'site.az' });
  assert.equal(m.structuredContent.changed, false);
  assert.equal(readFileSync(join(root, 'site.az'), 'utf8'), GOOD);
});

test('az_eject copies a word into the project once, and refuses a second time', async () => {
  const root = project();
  const r = await tool(root, 'az_eject', { word: 'hero' });
  assert.equal(r.structuredContent.oneWay, true);
  assert.ok(existsSync(join(root, 'words/hero/emit.web.ts')));
  assert.equal((await tool(root, 'az_eject', { word: 'hero' })).isError, true);
});

test('az_backend_init writes an owner-only .env and never returns the secret', async () => {
  const root = project();
  mkdirSync(join(root, 'server'));
  writeFileSync(join(root, 'server/az.config.json'), JSON.stringify({ database: 'sqlite', email: 'smtp' }));
  const r = await tool(root, 'az_backend_init', { serverDir: 'server' });
  assert.equal(r.structuredContent.path, 'server/.env');
  const env = readFileSync(join(root, 'server/.env'), 'utf8');
  const secret = /AZ_SESSION_SECRET=(\S+)/.exec(env)?.[1];
  assert.ok(secret && secret.length >= 32, 'CONTROL: a secret was written');
  assert.ok(!JSON.stringify(r).includes(secret), 'the secret must not appear in the tool result');
  assert.equal(statSync(join(root, 'server/.env')).mode & 0o777, 0o600);
  assert.equal((await tool(root, 'az_backend_init', { serverDir: 'server' })).isError, true, 'never overwritten');
});

test('az_doctor reports every check with its fix, writes nothing, and never returns an .env value', async () => {
  const root = project();
  mkdirSync(join(root, '.az-build/server'), { recursive: true });
  writeFileSync(join(root, '.az-build/server/az.config.json'), JSON.stringify({ database: 'sqlite', email: 'smtp', images: true }));
  writeFileSync(join(root, '.az-build/server/.env'), 'AZ_SESSION_SECRET=planted-mcp-secret-0123456789abcdef0123\n', { mode: 0o600 });
  const r = await tool(root, 'az_doctor', { file: 'broken.az' });
  assert.equal(r.isError, false, r.content[0].text);
  const checks = r.structuredContent.checks as { id: string; status: string; line: string; fix?: string[] }[];
  const by = (id: string) => checks.find((c) => c.id === id)!;
  assert.equal(r.structuredContent.ok, false);
  assert.equal(by('compile').status, 'fail');
  assert.equal(by('compile').fix?.[1], 'run: az check broken.az for every one');
  assert.equal(by('node').status, 'pass');
  assert.equal(by('backend-image-library').status, 'skip', 'an agent call never loads the project\'s modules');
  assert.equal(by('backend-env').status, 'fail');
  assert.match(by('backend-env').line, /^backend .env: the server would refuse 6 keys — AZ_BACKEND_PUBLIC_URL, /);
  assert.ok(!JSON.stringify(r).includes('planted-mcp-secret'), 'no .env value in the result');
  // CONTROL: without a file only the machine is checked.
  const bare = await tool(root, 'az_doctor');
  assert.equal(bare.structuredContent.checks.find((c: { id: string }) => c.id === 'compile').status, 'skip');
});

test('az_audit reports each check of a build\'s output, never a secret\'s value, and asks nothing online unless told', async () => {
  const root = project();
  const built = spawnSync(process.execPath, [...process.execArgv, BIN, 'build', 'site.az'], { cwd: root, encoding: 'utf8', timeout: REPLY_TIMEOUT_MS });
  assert.equal(built.status, 0, built.stderr);
  const key = `sk_live_${'M3w'.repeat(12)}`;
  mkdirSync(join(root, '.az-build/dist/assets'), { recursive: true });
  writeFileSync(join(root, '.az-build/dist/index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  writeFileSync(join(root, '.az-build/dist/assets/index.js'), `const k="${key}";`);
  const r = await tool(root, 'az_audit');
  assert.equal(r.isError, false, r.content[0].text);
  const checks = r.structuredContent.checks as { id: string; status: string; line: string; fix?: string[] }[];
  const by = (id: string) => checks.find((c) => c.id === id)!;
  assert.equal(r.structuredContent.ok, false);
  assert.equal(by('bundle-secrets').status, 'fail');
  assert.equal(by('bundle-secrets').fix?.[0], 'dist/assets/index.js:9 (secret-prefix)');
  assert.equal(by('page-csp').status, 'warn');
  assert.equal(by('dependencies').status, 'skip', 'no network unless online is "true"');
  assert.ok(!JSON.stringify(r).includes(key) && !JSON.stringify(r).includes('M3wM3w'), 'no secret value in the result');
  assert.equal((await tool(root, 'az_audit', { online: 'yes' })).isError, true);
  // CONTROL: a folder that is not a build is one failing line, not an empty pass.
  const none = await tool(root, 'az_audit', { out: 'elsewhere' });
  assert.deepEqual(none.structuredContent.checks.map((c: { id: string }) => c.id), ['output']);
});

/* ---- the sandbox -------------------------------------------------------- */

test('SECURITY: paths outside the root are refused — relative, absolute, and through a symlink', async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), 'az-mcp-outside-'));
  writeFileSync(join(outside, 'secret.az'), GOOD, 'utf8');
  symlinkSync(outside, join(root, 'link'));
  for (const file of ['../x.az', join(outside, 'secret.az'), 'link/secret.az']) {
    const r = await tool(root, 'az_check', { file });
    assert.equal(r.isError, true, file);
    assert.match(r.content[0].text, /outside the project root/);
  }
  const w = await tool(root, 'az_build', { file: 'site.az', out: 'link/out' });
  assert.equal(w.isError, true, 'a write through a symlinked folder is refused');
  assert.ok(!existsSync(join(outside, 'out')), 'nothing was written outside the root');
});
