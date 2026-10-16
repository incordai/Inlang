/**
 * @az module doctor-checks
 * Purpose: every az doctor check — machine, project, backend, and the chat's (doctor-chat.ts) — each a line and its fix; and doctor(), which runs them.
 * Spec: docs/word-quality-gate.md §5 · docs/auth-block-spec.md §4.1 · docs/stack-evaluation.md §9
 * Exports: CHECKS, doctor, glbGeometry, browserPlatform, BrowserMachine, DoctorOptions
 * Edit guide: detect and instruct only — no check installs, writes or prints an environment value; files are read through fs/promises, bounded.
 * Tests: packages/cli/test/doctor.test.ts
 */

/**
 * The checks, in the order they print: the machine first (Node, npm, known
 * bad combinations, the image library, the proxy and the disk space —
 * doctor-system.ts), then the project (it compiles, its data lock, its
 * tables' rules, its models, its asset budgets and names), then the
 * backend's `.env` and the variables a build would refuse to inline.
 *
 * word-quality-gate §5.1 sets the policy: Node, npm and system libraries are
 * Tier 3 — named with the command, never installed; browsers for tests are
 * Tier 2 — offered as a command, never fetched from here. Nothing in this
 * file installs or writes anything.
 */

import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { scanEnv, type Diagnostic, type Manifest, type PropSpec, type SpecBlock } from '../../core/src/index.ts';
import { isFromMark } from '../../core/src/emit-contract.ts';
import { BACKEND_PINS, NODE_ENGINE, SERVER_DIR } from '../../backend/src/emit.ts';
import { loadConfig, type Setup } from '../../backend/src/server/env.ts';
import { DOTENV_FILES, parseDotenv } from './az.ts';
import { CHAT_DOCTOR_CHECKS } from './doctor-chat.ts';
import { DISK_CHECK, PROXY_CHECK } from './doctor-system.ts';
import { lockPath } from './data-schema.ts';
import type { CompileJob } from './doctor-compile.ts';
import { ENCODER, type ProbeJob } from './images.ts';
import {
  CHILD_MS, report, runChecks, runWorker, shellQuote,
  type Check, type CheckResult, type Compiled, type DoctorContext, type DoctorReport, type Probe, type RunResult,
} from './doctor.ts';

/**
 * A file's text, or null when it is missing or not a regular file: a named
 * pipe would block the read with no end, so it is never opened.
 */
async function readRegular(path: string): Promise<string | null> {
  const s = await stat(path).catch(() => null);
  return s?.isFile() ? readFile(path, 'utf8') : null;
}

const KB = 1024;
const MB = 1024 * KB;
const sizeText = (bytes: number) => (bytes >= MB ? `${(bytes / MB).toFixed(1)}MB` : `${Math.round(bytes / KB)}KB`);

/** Where Node comes from, for every line that says to install it (Tier 3: instruct, never install). */
const NODE_DOWNLOAD = 'https://nodejs.org/en/download';

/** The repository az runs from — where its own packages are reinstalled. */
const AZ_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** az's own packages, reinstalled on this machine (CONVENTIONS §1, §7). */
const AZ_REINSTALL = `cd ${shellQuote(AZ_ROOT.replace(/[\\/]$/, ''))} && pnpm install --frozen-lockfile --ignore-scripts`;

/**
 * The glTF optimiser stack-evaluation §9 names, pinned to the version it
 * verified; run by the author, never by az (it is not a dependency).
 */
const GLB_OPTIMISER = '@gltf-transform/cli@4.4.2';

/** The geometry compression the 3D runtime decodes (scene-runtime views.ts). */
const GEOMETRY_COMPRESSION = 'KHR_draco_mesh_compression';

/** A GLB's JSON chunk is read whole; past this it is not a model a page should ship. */
const GLB_JSON_MAX = 8 * MB;

/** The browser-test package's names in a project's package.json, and the browser the check looks for. */
const BROWSER_TEST_PACKAGES = ['playwright', '@playwright/test'];
const BROWSER_TEST_CORE = 'playwright-core';
const BROWSER_CACHE = 'ms-playwright';
const TEST_BROWSER = 'chromium';

/** The data-lock codes (data-spec §12: AZ1700–AZ1749) and the no-rules warning, reported by their own checks. */
const isLockCode = (code: string) => /^AZ17[0-4]\d$/.test(code);
const NO_RULES = 'AZ1246';

const shown = (ctx: DoctorContext, abs: string) => {
  const rel = relative(ctx.cwd, abs);
  // A path starting `-` would be read as an option by the command it is pasted into.
  return rel === '' ? '.' : rel.startsWith('..') ? abs : rel.startsWith('-') ? `./${rel}` : rel;
};
const q = (ctx: DoctorContext, abs: string) => shellQuote(shown(ctx, abs));
/** `cd <dir> && ` before a command, or nothing when it runs here. */
const cdTo = (ctx: DoctorContext, dir: string) => (shown(ctx, dir) === '.' ? '' : `cd ${q(ctx, dir)} && `);
const fileName = (ctx: DoctorContext) => (ctx.source ? q(ctx, ctx.source) : 'site.az');

const noFile: CheckResult = { status: 'skip', line: 'project: no .az file — run: az doctor site.az' };

/* ---- the machine -------------------------------------------------------- */

/** `22.18` from `>=22.18`. */
const NEED = NODE_ENGINE.replace(/^>=\s*/, '');

/** a.b.c ≥ x.y.z, missing parts as 0. */
function atLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const node: Check = {
  id: 'node',
  title: 'Node',
  run: async ({ probe }) => (atLeast(probe.node, NEED)
    ? { status: 'pass', line: `Node ${probe.node} — az needs ${NEED}+` }
    : {
      status: 'fail',
      line: `Node ${probe.node} — az needs ${NEED}+ (the generated server's engines say ${NODE_ENGINE})`,
      fix: [`install Node ${NEED} or later: ${NODE_DOWNLOAD}`, 'az never installs Node itself — that would change every project on this machine'],
    }),
};

/** What a child that did not exit cleanly says, in one line. */
function childProblem(r: RunResult): string {
  if (r.kind === 'timeout') return `no answer after ${r.ms / 1000}s`;
  if (r.kind === 'missing') return 'not found';
  if (r.kind === 'error') return r.message;
  const said = `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).find(Boolean);
  return said ? `exit ${r.code}: ${said.slice(0, 160)}` : `exit ${r.code}`;
}

const npm: Check = {
  id: 'npm',
  title: 'npm',
  run: async ({ probe }) => {
    const cli = probe.npmCli();
    if (cli === null) {
      return {
        status: 'fail',
        line: `npm: not found beside Node (${dirname(probe.execPath)}) — az dev installs the site's packages with it`,
        fix: [`npm ships with Node — reinstall Node ${NEED}+: ${NODE_DOWNLOAD}`],
      };
    }
    const r = await probe.run(probe.execPath, [cli, '--version'], { timeoutMs: CHILD_MS });
    const version = r.kind === 'exit' && r.code === 0 ? r.stdout.trim() : '';
    if (/^\d+\.\d+\.\d+/.test(version)) return { status: 'pass', line: `npm ${version} — beside Node, used by az dev` };
    return {
      status: 'fail',
      line: `npm: ${childProblem(r)}`,
      fix: ['run: npm --version — it shows what npm is waiting on or missing', `if npm itself is damaged, reinstall Node ${NEED}+: ${NODE_DOWNLOAD}`],
    };
  },
};

const platform: Check = {
  id: 'platform',
  title: 'platform',
  run: async ({ probe }) => {
    const where = `${probe.platform}-${probe.arch}, Node ${probe.node}`;
    // An x64 Node on an arm64 darwin machine runs translated: every native
    // module it installs is the x64 build, and an arm64 Node later will not
    // load it.
    if (probe.platform === 'darwin' && probe.arch === 'x64') {
      const r = await probe.run('sysctl', ['-n', 'sysctl.proc_translated'], { timeoutMs: CHILD_MS });
      if (r.kind === 'exit' && r.code === 0 && r.stdout.trim() === '1') {
        return {
          status: 'fail',
          line: 'platform: this Node is the x64 build, running translated on an arm64 machine — native modules break',
          fix: [`install the arm64 build of Node ${NEED}+: ${NODE_DOWNLOAD}`, `then reinstall az's packages: ${AZ_REINSTALL}`],
        };
      }
      if (r.kind === 'timeout') {
        return { status: 'fail', line: `platform: sysctl gave no answer after ${r.ms / 1000}s`, fix: ['run: sysctl -n sysctl.proc_translated — 1 means this Node runs translated'] };
      }
    }
    const words = probe.env.AZ_WORDS;
    if (words !== undefined && words !== '') {
      const ok = await stat(words).then((s) => s.isDirectory(), () => false);
      if (!ok) {
        return {
          status: 'fail',
          line: 'platform: AZ_WORDS is set, but not to a folder — every build fails',
          fix: ['unset AZ_WORDS to use the bundled words, or point it at a folder of word packs'],
        };
      }
    }
    return { status: 'pass', line: `no known-bad combination (${where})` };
  },
};

/** What the image-library child said: its version, or why it could not load. */
function probeResult(r: RunResult): { ok: true; version: string } | { ok: false; why: string } {
  if (r.kind === 'exit' && r.code === 0) {
    const m = /^az-image-ok: (\S+)/m.exec(r.stdout);
    if (m) return { ok: true, version: m[1] };
  }
  if (r.kind === 'exit') {
    const line = r.stderr.split('\n').find((l) => l.startsWith('az-image:'));
    if (line) return { ok: false, why: line.slice('az-image:'.length).trim() };
  }
  return { ok: false, why: childProblem(r) };
}

const probeArgs = ['--experimental-strip-types', ENCODER];

const imageLibrary: Check = {
  id: 'image-library',
  title: 'image library',
  run: async ({ probe }) => {
    const job: ProbeJob = { probe: true };
    const r = probeResult(await probe.run(probe.execPath, probeArgs, { input: JSON.stringify(job), timeoutMs: CHILD_MS }));
    if (r.ok) return { status: 'pass', line: `image library ${r.version} loads on ${probe.platform}-${probe.arch} (az build resizes images)` };
    // A build still stands without it: images ship at their own size (gallery-spec §7).
    return {
      status: 'warn',
      line: `image library: ${r.why} — builds ship images unresized`,
      fix: [`reinstall az's packages on this machine (the library is built per platform): ${AZ_REINSTALL}`],
    };
  },
};

/* ---- the built server ---------------------------------------------------- */

type ServerSetup = Setup & { readonly siteName?: string };

/** The built server's choices (az.config.json), or null when there is none az wrote. */
async function serverSetup(serverDir: string): Promise<ServerSetup | null> {
  let o: { database?: unknown; email?: unknown; data?: unknown; images?: unknown };
  try {
    const text = await readRegular(join(serverDir, 'az.config.json'));
    if (text === null) return null;
    o = JSON.parse(text) as typeof o;
  } catch {
    return null;
  }
  const { database, email } = o ?? {};
  if (database !== 'sqlite' && database !== 'postgres' && database !== 'mysql') return null;
  // No email: a server without accounts (chat-block-spec §19.15); any other value is not a config az wrote.
  if (email !== undefined && email !== 'smtp' && email !== 'api') return null;
  return { database, ...(email !== undefined ? { email } : {}), ...(o.data === true ? { data: true } : {}), ...(o.images === true ? { images: true } : {}) };
}

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);

const backendImageLibrary: Check = {
  id: 'backend-image-library',
  title: 'backend image library',
  run: async (ctx) => {
    const server = join(ctx.outDir, SERVER_DIR);
    const setup = await serverSetup(server);
    if (setup?.images !== true) return { status: 'skip', line: 'backend image library: no built server with image fields' };
    if (!ctx.projectModules) {
      return { status: 'skip', line: 'backend image library: not loaded from an agent call — run az doctor in a terminal' };
    }
    const install = `cd ${q(ctx, server)} && npm install`;
    if (!(await isDir(join(server, 'node_modules')))) {
      return { status: 'warn', line: `backend image library: ${shown(ctx, server)} has no node_modules yet`, fix: [`run on the machine that runs the server: ${install}`] };
    }
    const job: ProbeJob = { probe: true, from: server };
    const r = probeResult(await ctx.probe.run(ctx.probe.execPath, probeArgs, { input: JSON.stringify(job), timeoutMs: CHILD_MS }));
    if (!r.ok) {
      return {
        status: 'fail',
        line: `backend image library: ${r.why} — the server's uploads fail`,
        fix: [`delete ${q(ctx, join(server, 'node_modules'))} (it was installed for another machine), then: ${install}`],
      };
    }
    if (r.version !== BACKEND_PINS.sharp) {
      return { status: 'fail', line: `backend image library is ${r.version}; the server pins ${BACKEND_PINS.sharp}`, fix: [`run: ${install}`] };
    }
    return { status: 'pass', line: `backend image library ${r.version} loads in ${shown(ctx, server)}` };
  },
};

/* ---- browsers for the project's tests ------------------------------------ */

/** The browser cache the test package uses: its env override, else the per-platform default. */
function browserCache(probe: Probe, projectDir: string): string {
  const set = probe.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set === '0') return join(projectDir, 'node_modules', BROWSER_TEST_CORE, '.local-browsers');
  if (set) return set;
  if (probe.platform === 'darwin') return join(probe.home, 'Library', 'Caches', BROWSER_CACHE);
  if (probe.platform === 'win32') return join(probe.env.LOCALAPPDATA ?? join(probe.home, 'AppData', 'Local'), BROWSER_CACHE);
  return join(probe.env.XDG_CACHE_HOME || join(probe.home, '.cache'), BROWSER_CACHE);
}

/** What browserPlatform reads from the machine. `distro` is /etc/os-release's ID and VERSION_ID (linux only). */
export interface BrowserMachine {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly osRelease: string;
  readonly cpuModels: readonly string[];
  readonly distro?: { readonly id: string; readonly version: string };
  /** The package's own override of the platform name, when set. */
  readonly override?: string;
}

/** The newest macOS major the browser-test package knows; a later darwin is named as this one. */
const LAST_KNOWN_MAC = 26;
/** The text in a CPU model the package reads as an arm64 darwin machine. */
const ARM_MAC_CPU = 'Apple';

/**
 * The platform name the browser-test package keys `revisionOverrides` by —
 * its own rules, as the version this repository pins (1.63.0) computes them
 * in its hostPlatform module: `mac14-arm64`, `ubuntu22.04-x64`, `win64`.
 */
export function browserPlatform(m: BrowserMachine): string {
  if (m.override) return m.override;
  if (m.platform === 'darwin') {
    const major = Number.parseInt(m.osRelease.split('.')[0], 10);
    const mac = major < 18 ? '10.13' : major === 18 ? '10.14' : major === 19 ? '10.15' : String(major < 25 ? 11 + (major - 20) : Math.min(major + 1, LAST_KNOWN_MAC));
    return Number(mac) >= 11 && m.cpuModels.some((c) => c.includes(ARM_MAC_CPU)) ? `mac${mac}-arm64` : `mac${mac}`;
  }
  if (m.platform === 'linux') {
    if (m.arch !== 'x64' && m.arch !== 'arm64') return '<unknown>';
    const arch = `-${m.arch}`;
    const { id, version } = m.distro ?? { id: undefined, version: '' };
    const major = Number.parseInt(version, 10);
    if (id === 'ubuntu' || id === 'pop' || id === 'neon' || id === 'tuxedo') {
      if (major < 20) return `ubuntu18.04${arch}`;
      if (major < 22) return `ubuntu20.04${arch}`;
      if (major < 24) return `ubuntu22.04${arch}`;
      if (major < 26) return `ubuntu24.04${arch}`;
      if (major < 28) return `ubuntu26.04${arch}`;
      return `ubuntu${version}${arch}`;
    }
    if (id === 'linuxmint') return `${major <= 20 ? 'ubuntu20.04' : major === 21 ? 'ubuntu22.04' : 'ubuntu24.04'}${arch}`;
    if (id === 'debian' || id === 'raspbian') {
      if (version === '11' || version === '12' || version === '13') return `debian${version}${arch}`;
      if (version === '') return `debian13${arch}`;
    }
    return `ubuntu24.04${arch}`;
  }
  return m.platform === 'win32' ? 'win64' : '<unknown>';
}

/** /etc/os-release's ID and VERSION_ID, read as the package reads them; undefined when it can't be read. */
async function linuxDistro(): Promise<{ id: string; version: string } | undefined> {
  const text = await readRegular('/etc/os-release').catch(() => null);
  if (text === null) return undefined;
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [name, ...rest] = line.split('=');
    let value = rest.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.substring(1, value.length - 1);
    if (name) fields.set(name.toLowerCase(), value);
  }
  return { id: fields.get('id') ?? '', version: fields.get('version_id') ?? '' };
}

/** One browser's entry in the package's browsers.json. */
interface BrowserEntry { readonly name?: string; readonly revision?: string; readonly revisionOverrides?: Readonly<Record<string, string>> }

/**
 * The revision the package installs on this platform, and the folder it
 * installs it in: an override for the platform wins, in a folder of its own
 * (`<name>_<platform>_special-<revision>`, dashes made underscores).
 */
function browserInstall(entry: BrowserEntry, host: string): { revision: string | undefined; folder: string } {
  const override = entry.revisionOverrides?.[host];
  const revision = override || entry.revision;
  const prefix = override ? `${TEST_BROWSER}_${host}_special` : TEST_BROWSER;
  return { revision, folder: `${prefix.replace(/-/g, '_')}-${revision}` };
}

const browsers: Check = {
  id: 'browsers',
  title: 'test browsers',
  run: async (ctx) => {
    if (!ctx.source) return { status: 'skip', line: 'test browsers: no .az file given' };
    const dir = dirname(ctx.source);
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse((await readRegular(join(dir, 'package.json'))) ?? 'null') as typeof pkg;
    } catch {
      return { status: 'skip', line: 'test browsers: the project runs no browser tests' };
    }
    if (pkg === null) return { status: 'skip', line: 'test browsers: the project runs no browser tests' };
    const uses = BROWSER_TEST_PACKAGES.some((n) => Object.hasOwn(pkg?.dependencies ?? {}, n) || Object.hasOwn(pkg?.devDependencies ?? {}, n));
    if (!uses) return { status: 'skip', line: 'test browsers: the project runs no browser tests' };
    let entry: BrowserEntry | undefined;
    try {
      const text = await readRegular(join(dir, 'node_modules', BROWSER_TEST_CORE, 'browsers.json'));
      if (text === null) throw new Error('absent');
      const list = JSON.parse(text) as { browsers?: BrowserEntry[] };
      entry = list.browsers?.find((b) => b.name === TEST_BROWSER);
    } catch {
      return { status: 'warn', line: 'test browsers: the browser-test package is not installed', fix: [`run: ${cdTo(ctx, dir)}npm install`] };
    }
    const { probe } = ctx;
    const host = browserPlatform({
      platform: probe.platform, arch: probe.arch, osRelease: probe.osRelease, cpuModels: probe.cpuModels,
      distro: probe.platform === 'linux' ? await linuxDistro() : undefined,
      override: probe.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE,
    });
    const { revision, folder } = browserInstall(entry ?? {}, host);
    if (!revision || !/^\d+$/.test(revision)) {
      return { status: 'warn', line: 'test browsers: the browser-test package lists no browser revision — reinstall it', fix: [`run: ${cdTo(ctx, dir)}npm install`] };
    }
    const cache = browserCache(ctx.probe, dir);
    if (await isDir(join(cache, folder))) {
      return { status: 'pass', line: `test browsers: ${TEST_BROWSER} ${revision} is installed` };
    }
    // Tier 2 (word-quality-gate §5.1): offered as a command, never fetched from here.
    return {
      status: 'warn',
      line: `test browsers: ${TEST_BROWSER} ${revision} is not installed — the project's browser tests can't start`,
      fix: [`run: ${cdTo(ctx, dir)}npx playwright install ${TEST_BROWSER}`],
    };
  },
};

/* ---- the project ---------------------------------------------------------- */

const diagLine = (ctx: DoctorContext, d: Diagnostic) => `${shown(ctx, ctx.source ?? 'site.az')}:${d.pos.line}:${d.pos.col} ${d.code} ${d.message}`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const compiles: Check = {
  id: 'compile',
  title: 'compile',
  run: async (ctx) => {
    if (!ctx.source) return noFile;
    const c = await ctx.compiled();
    const name = shown(ctx, ctx.source);
    if ('error' in c) return { status: 'fail', line: `${name}: can't be compiled (${c.error})`, fix: [`run: az check ${fileName(ctx)}`] };
    // The lock and the tables' rules have their own lines below.
    const own = c.result.diagnostics.filter((d) => !isLockCode(d.code) && d.code !== NO_RULES);
    const errors = own.filter((d) => d.severity === 'error');
    const warnings = own.length - errors.length;
    if (errors.length > 0) {
      return {
        status: 'fail',
        line: `${name}: ${count(errors.length, 'error')}, ${count(warnings, 'warning')} — the build stops`,
        fix: [diagLine(ctx, errors[0]), `run: az check ${fileName(ctx)} for every one`],
      };
    }
    if (warnings > 0) return { status: 'warn', line: `${name} compiles with ${count(warnings, 'warning')}`, fix: [`run: az check ${fileName(ctx)}`] };
    return { status: 'pass', line: `${name} compiles — no errors, no warnings` };
  },
};

const dataLock: Check = {
  id: 'data-lock',
  title: 'data lock',
  run: async (ctx) => {
    if (!ctx.source) return noFile;
    const c = await ctx.compiled();
    if ('error' in c) return { status: 'skip', line: 'data lock: the file could not be compiled' };
    const lock = shown(ctx, lockPath(ctx.source));
    const stale = c.result.diagnostics.filter((d) => isLockCode(d.code));
    if (stale.length > 0) {
      return {
        status: 'fail',
        line: `data lock: ${lock} is not current — ${stale[0].code} ${stale[0].message}`,
        fix: [`run: az backend plan ${fileName(ctx)} to see the step, then az backend schema ${fileName(ctx)} to record it`],
      };
    }
    if (!c.result.spec?.site.data?.length) return { status: 'skip', line: 'data lock: no data tables' };
    // compile() compares the lock only with a file that has no errors.
    if (!c.result.ok) return { status: 'skip', line: `data lock: compared once ${shown(ctx, ctx.source)} has no errors` };
    return { status: 'pass', line: `data lock: ${lock} matches the file's tables` };
  },
};

const tableRules: Check = {
  id: 'table-rules',
  title: 'table rules',
  run: async (ctx) => {
    if (!ctx.source) return noFile;
    const c = await ctx.compiled();
    if ('error' in c) return { status: 'skip', line: 'table rules: the file could not be compiled' };
    const site = c.result.spec?.site;
    const adapter = site?.scoped.auth?.adapter;
    const tables = site?.data ?? [];
    // auth-block-spec §4.1: a hosted provider's tables are protected by its
    // row rules alone, and az cannot read them from here — say so every time.
    if (adapter === 'hosted') {
      return {
        status: 'warn',
        line: 'table rules: auth adapter hosted — its tables\' row rules can\'t be read from here',
        fix: ['in the provider\'s console, turn on row-level security for every table and give each a policy — the public key reads whatever they allow'],
      };
    }
    if (tables.length === 0) return { status: 'skip', line: 'table rules: no data tables' };
    const bare = c.result.diagnostics.filter((d) => d.code === NO_RULES).map((d) => /^data (\S+):/.exec(d.message)?.[1] ?? '?');
    if (bare.length > 0) {
      return {
        status: 'warn',
        line: `table rules: ${count(bare.length, 'table')} with no allow lines (${bare.join(', ')}) — only admins can reach ${bare.length === 1 ? 'it' : 'them'}`,
        fix: ['give each its rules, e.g.: allow anyone read — data-spec §4'],
      };
    }
    return { status: 'pass', line: `table rules: every table has allow lines (${count(tables.length, 'table')})` };
  },
};

/** A project path's real file, or why it can't be used — symlinks followed, never outside the project. */
async function inProject(projectDir: string, path: string): Promise<{ file: string; size: number } | { problem: string }> {
  const root = await realpath(projectDir);
  let real: string;
  try {
    real = await realpath(resolve(root, path));
  } catch {
    return { problem: 'does not exist' };
  }
  if (real !== root && !real.startsWith(root + sep)) return { problem: 'resolves outside the project' };
  const s = await stat(real);
  if (!s.isFile()) return { problem: 'is not a file' };
  return { file: real, size: s.size };
}

/** One file a block names, with the budget its manifest gives it (or none). */
interface Named { readonly path: string; readonly maxBytes?: number; readonly what: string }

const isPathValue = (v: string | undefined): v is string => v !== undefined && v.startsWith('./') && !isFromMark(v);
const cleanPath = (v: string) => v.replace(/^\.\//, '');

/** Path-typed props of a manifest or slot definition. */
const pathProps = (props: Record<string, PropSpec> | undefined) =>
  Object.entries(props ?? {}).filter(([, p]) => p.type === 'path');

type SlotDef = { props?: Record<string, PropSpec>; slots?: Record<string, unknown> };

/**
 * Every project file the blocks name, with its manifest budget. A slot
 * child's positional path (`image ./a.webp`) fills the slot's one path prop
 * it did not set by name; with several candidates it is listed unbudgeted.
 */
function namedFiles(blocks: readonly SpecBlock[], manifests: ReadonlyMap<string, Manifest>): Named[] {
  const out: Named[] = [];
  const walk = (block: SpecBlock, def: SlotDef | undefined, what: string) => {
    const props = pathProps(def?.props);
    for (const [key, p] of props) {
      const v = block.props[key];
      if (isPathValue(v)) out.push({ path: cleanPath(v), maxBytes: p.maxBytes, what: `${what} ${key}` });
    }
    const open = props.filter(([key]) => !isPathValue(block.props[key]));
    for (const a of block.args) {
      if (a.kind !== 'path' || !isPathValue(a.value)) continue;
      const only = open.length === 1 ? open[0] : undefined;
      out.push({ path: cleanPath(a.value), maxBytes: only?.[1].maxBytes, what: only ? `${what} ${only[0]}` : what });
    }
    for (const child of block.children) {
      const slot = def?.slots?.[child.word] as SlotDef | undefined;
      walk(child, slot, `${what} ${child.word}`);
    }
  };
  for (const b of blocks) walk(b, manifests.get(b.word) as SlotDef | undefined, b.word);
  return out;
}

/** The compile result and every file its blocks name, or a skip line. */
async function projectFiles(ctx: DoctorContext): Promise<Named[] | CheckResult> {
  if (!ctx.source) return noFile;
  const c = await ctx.compiled();
  if ('error' in c) return { status: 'skip', line: 'assets: the file could not be compiled' };
  const spec = c.result.spec;
  if (!spec) return { status: 'skip', line: 'assets: the file has no site to read' };
  const files = namedFiles([...spec.site.inherited, ...spec.pages.flatMap((p) => p.blocks)], c.manifests);
  // One entry per file, with the tightest budget any block gives it.
  const byPath = new Map<string, Named>();
  for (const f of files) {
    const had = byPath.get(f.path);
    if (!had || (f.maxBytes !== undefined && (had.maxBytes === undefined || f.maxBytes < had.maxBytes))) byPath.set(f.path, f);
  }
  return [...byPath.values()];
}

const assets: Check = {
  id: 'assets',
  title: 'assets',
  run: async (ctx) => {
    const found = await projectFiles(ctx);
    if (!Array.isArray(found)) return found;
    const dir = dirname(ctx.source!);
    const missing: string[] = [];
    const over: { path: string; size: number; max: number; what: string }[] = [];
    for (const f of found) {
      const at = await inProject(dir, f.path);
      if ('problem' in at) missing.push(`'./${f.path}' ${at.problem}`);
      else if (f.maxBytes !== undefined && at.size > f.maxBytes) over.push({ path: f.path, size: at.size, max: f.maxBytes, what: f.what });
    }
    if (missing.length > 0) {
      return { status: 'fail', line: `assets: ${missing[0]}${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ''} — the build stops`, fix: ['add the file inside the project, or fix the path in the .az file'] };
    }
    if (over.length > 0) {
      return {
        status: 'warn',
        line: `assets: ${count(over.length, 'file')} over budget — the page loads slowly on a phone`,
        fix: over.map((o) => `'./${o.path}' is ${sizeText(o.size)} (${o.what}, budget ${sizeText(o.max)}) — ${o.path.toLowerCase().endsWith('.glb') ? 'Draco-compress it (see the models line)' : `export it under ${sizeText(o.max)}`}`),
      };
    }
    if (found.length === 0) return { status: 'skip', line: 'assets: the file names no project files' };
    return { status: 'pass', line: `assets: ${count(found.length, 'file')}, each within its budget` };
  },
};

/**
 * word-quality-gate §5.3, Windows paths: two files the site names whose
 * paths differ only in case (`./img/Hero.webp`, `./img/hero.webp`) are two
 * files on this disk and one on a case-insensitive one — Windows' and
 * macOS's by default — where the second overwrites the first when the
 * project is copied there, or the build reads the wrong one. The check is
 * the same on every OS: it reads only the names the .az file gives.
 */
const assetCase: Check = {
  id: 'asset-case',
  title: 'asset names',
  run: async (ctx) => {
    const found = await projectFiles(ctx);
    if (!Array.isArray(found)) return { ...found, line: found.line.replace(/^assets:/, 'asset names:') };
    const byFolded = new Map<string, Set<string>>();
    for (const f of found) {
      const folded = f.path.toLowerCase();
      byFolded.set(folded, (byFolded.get(folded) ?? new Set()).add(f.path));
    }
    const clashes = [...byFolded.values()].filter((names) => names.size > 1).map((names) => [...names].sort());
    if (clashes.length > 0) {
      return {
        status: 'warn',
        line: `asset names: ${clashes.map((c) => c.map((n) => `'./${n}'`).join(' and ')).join('; ')} differ only in case — on a case-insensitive disk (Windows, macOS) they are one file`,
        fix: ['rename one of each pair, and the path to it in the .az file'],
      };
    }
    if (found.length === 0) return { status: 'skip', line: 'asset names: the file names no project files' };
    return { status: 'pass', line: `asset names: ${count(found.length, 'file')}, no two differing only in case` };
  },
};

/** What a GLB's JSON says about its geometry, or why it can't be read. Reads the header and JSON chunk only. */
export async function glbGeometry(file: string): Promise<{ meshes: number; compressed: boolean } | { problem: string }> {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(20);
    const { bytesRead } = await fh.read(head, 0, 20, 0);
    // glTF 2.0 binary: magic, version, length; then the first chunk's length and type, which must be JSON.
    if (bytesRead < 20 || head.toString('latin1', 0, 4) !== 'glTF' || head.readUInt32LE(4) !== 2) return { problem: 'is not a glTF 2.0 binary' };
    const length = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== 0x4e4f534a) return { problem: 'has no JSON chunk first' };
    if (length > GLB_JSON_MAX) return { problem: `has a ${sizeText(length)} JSON chunk — not read` };
    const body = Buffer.alloc(length);
    const got = await fh.read(body, 0, length, 20);
    if (got.bytesRead < length) return { problem: 'is cut short' };
    const json = JSON.parse(body.toString('utf8')) as { meshes?: unknown[]; extensionsUsed?: unknown[] };
    return {
      meshes: Array.isArray(json.meshes) ? json.meshes.length : 0,
      compressed: Array.isArray(json.extensionsUsed) && json.extensionsUsed.includes(GEOMETRY_COMPRESSION),
    };
  } catch (e) {
    return { problem: e instanceof SyntaxError ? 'has a JSON chunk that does not parse' : `can't be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  } finally {
    await fh.close();
  }
}

const models: Check = {
  id: 'models',
  title: 'models',
  run: async (ctx) => {
    const found = await projectFiles(ctx);
    if (!Array.isArray(found)) return { ...found, line: found.line.replace(/^assets:/, 'models:') };
    const dir = dirname(ctx.source!);
    const glbs = found.filter((f) => extname(f.path).toLowerCase() === '.glb');
    if (glbs.length === 0) return { status: 'skip', line: 'models: no 3D model in the file' };
    const raw: string[] = [];
    const unread: string[] = [];
    let read = 0;
    for (const g of glbs) {
      const at = await inProject(dir, g.path);
      if ('problem' in at) continue; // the assets line reports it
      read++;
      const geo = await glbGeometry(at.file);
      if ('problem' in geo) unread.push(`'./${g.path}' ${geo.problem}`);
      else if (geo.meshes > 0 && !geo.compressed) raw.push(g.path);
    }
    if (raw.length > 0) {
      // stack-evaluation §9: Draco for a static product model, the case A8 measures.
      return {
        status: 'warn',
        line: `models: ${raw.map((p) => `'${basename(p)}'`).join(', ')} not Draco-compressed — raw geometry stalls a phone`,
        fix: [
          ...raw.map((p) => `${cdTo(ctx, dir)}npx ${GLB_OPTIMISER} draco ${shellQuote(`./${p}`)} ${shellQuote(`./${p.replace(/\.glb$/i, '-draco.glb')}`)} --method edgebreaker`),
          'then point model at the -draco.glb file; az never runs the optimiser itself',
        ],
      };
    }
    if (unread.length > 0) return { status: 'warn', line: `models: ${unread[0]}`, fix: ['export the model again as a .glb'] };
    if (read === 0) return { status: 'skip', line: 'models: no model file to read — see the assets line' };
    return { status: 'pass', line: `models: ${count(read, 'model')}, none with raw geometry` };
  },
};

/* ---- the backend's .env and the build's environment ---------------------- */

/**
 * The keys this server would refuse to start with — its own validation
 * (env.ts loadConfig, with the setup main.ts passes), reduced to key names.
 * Some of its messages quote a value, so only the leading key name of each
 * is kept; a value never leaves this function.
 */
function refusedKeys(setup: Setup, env: Record<string, string>): string[] {
  const loaded = loadConfig(env, { database: setup.database, email: setup.email, ...(setup.images === true ? { images: true } : {}) }, 'site');
  if (loaded.ok) return [];
  return [...new Set(loaded.problems.map((p) => /^AZ_[A-Z0-9_]+/.exec(p)?.[0] ?? 'a setting'))];
}

const backendEnv: Check = {
  id: 'backend-env',
  title: 'backend .env',
  run: async (ctx) => {
    const server = join(ctx.outDir, SERVER_DIR);
    const setup = await serverSetup(server);
    const c = ctx.source ? await ctx.compiled() : null;
    const declared = c !== null && 'result' in c && c.result.spec?.site.backend !== undefined;
    if (!setup) {
      return declared
        ? { status: 'warn', line: `backend .env: ${shown(ctx, server)} is not built yet`, fix: [`run: az build ${fileName(ctx)}${ctx.outDir === resolve(ctx.cwd, '.az-build') ? '' : ` --out ${q(ctx, ctx.outDir)}`}`] }
        : { status: 'skip', line: 'backend .env: the site has no backend' };
    }
    const file = join(server, '.env');
    const s = await stat(file).catch(() => null);
    if (!s) {
      return { status: 'warn', line: `backend .env: ${shown(ctx, file)} is missing — the server won't start (az dev needs none)`, fix: [`run: az backend init ${q(ctx, server)}`] };
    }
    if (!s.isFile()) return { status: 'fail', line: `backend .env: ${shown(ctx, file)} is not a regular file`, fix: [`replace it with a file: az backend init ${q(ctx, server)}`] };
    // backend-spec §4: owner read/write only. Windows has no such mode bits.
    if (ctx.probe.platform !== 'win32' && (s.mode & 0o077) !== 0) {
      return {
        status: 'fail',
        line: `backend .env: ${shown(ctx, file)} is readable by others (mode ${(s.mode & 0o777).toString(8)}) — it holds the server's secrets`,
        fix: [`run: chmod 600 ${q(ctx, file)}`],
      };
    }
    const refused = refusedKeys(setup, parseEnv(await readFile(file, 'utf8')) as Record<string, string>);
    if (refused.length > 0) {
      return {
        status: 'fail',
        line: `backend .env: the server would refuse ${count(refused.length, 'key')} — ${refused.join(', ')}`,
        fix: [`set ${refused.length === 1 ? 'it' : 'them'} in ${shown(ctx, file)} — ${shown(ctx, join(server, '.env.example'))} says what each takes`],
      };
    }
    return { status: 'pass', line: 'backend .env: present, owner-only, every key the server checks is valid' };
  },
};

const buildSecrets: Check = {
  id: 'build-secrets',
  title: 'build secrets',
  run: async (ctx) => {
    // The same environment az build checks (az.ts): the output folder's
    // .env files, then the process — names only, never a value.
    const files: Record<string, string> = {};
    for (const name of DOTENV_FILES) {
      const text = await readRegular(join(ctx.outDir, name));
      if (text !== null) parseDotenv(text, files);
    }
    const names = [...new Set(scanEnv({ ...files, ...ctx.probe.env }).map((f) => f.where))];
    if (names.length > 0) {
      return {
        status: 'fail',
        line: `build secrets: ${names.join(', ')} ${names.length === 1 ? 'looks' : 'look'} like a service key — the build refuses to inline ${names.length === 1 ? 'it' : 'them'}`,
        fix: [`remove ${names.length === 1 ? 'it' : 'them'} from the environment and ${shown(ctx, ctx.outDir)}/.env*; use the public key there and keep service keys in the server's .env`],
      };
    }
    return { status: 'pass', line: 'build secrets: no service key in the variables a build inlines' };
  },
};

/** Every check, in the order the report prints them. */
export const CHECKS: readonly Check[] = [
  node, npm, platform, imageLibrary, backendImageLibrary, browsers, PROXY_CHECK, DISK_CHECK,
  compiles, dataLock, tableRules, models, assets, assetCase,
  backendEnv, ...CHAT_DOCTOR_CHECKS, buildSecrets,
];

export interface DoctorOptions {
  readonly source: string | null;
  readonly outDir: string;
  readonly cwd: string;
  readonly wordsDir: string;
  readonly probe: Probe;
  readonly projectModules: boolean;
  readonly checks?: readonly Check[];
  readonly deadlineMs?: number;
  /** The worker module that compiles the file (doctor-compile.ts); a test passes one that never answers. */
  readonly compiler?: URL;
  /** The compile worker's timeout: under the deadline, so the compile line says what stopped. */
  readonly compileMs?: number;
}

/** The compile worker az doctor runs. */
const COMPILER = new URL('./doctor-compile.ts', import.meta.url);

/** Run every check against this machine and project. Reads only; writes and installs nothing. */
export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  let compiled: Promise<Compiled> | undefined;
  // Ends a compile still running once the report is in, so nothing outlives it.
  const done = new AbortController();
  const ctx: DoctorContext = {
    source: options.source,
    outDir: options.outDir,
    cwd: options.cwd,
    wordsDir: options.wordsDir,
    probe: options.probe,
    projectModules: options.projectModules,
    // Manifests only: doctor never runs the project's own word code.
    compiled: () => {
      const source = options.source;
      if (!source) return Promise.reject(new Error('no .az file'));
      const job: CompileJob = { source, wordsDir: options.wordsDir };
      compiled ??= runWorker<Compiled>(options.compiler ?? COMPILER, job, options.compileMs ?? CHILD_MS, done.signal).then((r) => {
        if (r.kind === 'done') return r.value;
        return { error: r.kind === 'timeout' ? `no answer after ${r.ms / 1000}s` : r.message.split('\n')[0] };
      });
      return compiled;
    },
  };
  try {
    return report(await runChecks(options.checks ?? CHECKS, ctx, options.deadlineMs));
  } finally {
    done.abort();
  }
}
