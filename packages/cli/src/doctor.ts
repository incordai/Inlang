/**
 * @az module doctor
 * Purpose: the frame az doctor and az audit share: the check contract, the machine probe, deadlines, and the text and JSON reports.
 * Spec: docs/word-quality-gate.md §5 (§5.1 detect everything, install almost nothing; §5.2 exit codes)
 * Exports: Check, CheckResult, Command, Compiled, Finding, Status, Probe, RunResult, WorkerResult, DoctorContext, DoctorReport, runChecks, runWorker, systemProbe, report, formatReport, shellQuote, DEADLINE_MS, CHILD_MS
 * Edit guide: a check reaches the machine only through Probe, so a test can fake it; nothing here installs or writes; never print an environment value.
 * Tests: packages/cli/test/doctor.test.ts, packages/cli/test/audit.test.ts
 */

/**
 * `az doctor` turns "it's broken on my machine" into a line and the command
 * that fixes it (word-quality-gate §5). This file is the frame every check
 * runs in; the checks themselves are doctor-checks.ts.
 *
 * Every check is bounded twice. A child process it starts is killed at
 * CHILD_MS; the check as a whole has DEADLINE_MS, after which it reports
 * "no answer" and the run goes on without it. Checks run concurrently, so a
 * run takes as long as its slowest check, not the sum.
 *
 * The deadline is a timer, so it can only fire while the event loop turns:
 * it bounds anything a check awaits — a child, a file read — and not a
 * synchronous loop. Checks therefore read files through fs/promises and
 * read bounded byte counts; work that is synchronous and unbounded —
 * compiling the .az file, reading every built page — runs in a worker
 * thread (runWorker), which is terminated at its timeout however it is
 * stuck.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, homedir, release } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { CompileResult, Manifest } from '../../core/src/index.ts';

export type Status = 'pass' | 'warn' | 'fail' | 'skip';

/** What a check found: one fixed line, and the exact command or instruction that fixes it. */
export interface CheckResult {
  readonly status: Status;
  readonly line: string;
  readonly fix?: readonly string[];
}

export interface Finding extends CheckResult {
  readonly id: string;
}

/** One check of `az doctor` (DoctorContext) or `az audit` (its own context): the frame runs either. */
export interface Check<C = DoctorContext> {
  readonly id: string;
  /** Used when the check itself cannot answer: "<title>: no answer after 20s". */
  readonly title: string;
  readonly run: (ctx: C) => Promise<CheckResult>;
}

/** How a child process ended. Output is cut at CHILD_OUTPUT_BYTES. */
export type RunResult =
  | { readonly kind: 'exit'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'error'; readonly message: string };

export interface RunOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs: number;
}

/** The machine, as the checks see it — faked in tests. */
export interface Probe {
  /** `process.versions.node`, e.g. 22.18.0. */
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly execPath: string;
  readonly home: string;
  /** `os.release()`: the kernel's version — on darwin it names the macOS release. */
  readonly osRelease: string;
  /** `os.cpus()` models: on darwin they tell an arm64 machine whatever build of Node runs. */
  readonly cpuModels: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** npm's entry script beside this Node, or null — the one az dev runs (serve.ts). */
  readonly npmCli: () => string | null;
  readonly run: (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;
  /** The free space of the filesystem holding `path` (`fs.statfs`): blocks free to this user, and their size in bytes. */
  readonly statfs: (path: string) => Promise<{ readonly bavail: number; readonly bsize: number }>;
  /** The flags this Node accepts (`process.allowedNodeEnvironmentFlags`): whether it can take its proxy from the environment. */
  readonly nodeFlags: ReadonlySet<string>;
}

export interface DoctorContext {
  /** The absolute .az file, or null: the project checks are then skipped. */
  readonly source: string | null;
  /** The absolute output folder a build writes (`--out`, default .az-build). */
  readonly outDir: string;
  /** The folder the run was started in, for the paths it prints. */
  readonly cwd: string;
  readonly wordsDir: string;
  readonly probe: Probe;
  /**
   * May a check load a module installed in the project's own folders (the
   * built server's image library)? False from `az mcp`: a read-only tool
   * never runs code from the project.
   */
  readonly projectModules: boolean;
  /**
   * The file compiled once, from manifests only — no project code runs; or
   * why it could not be. It compiles in a worker, ended at its timeout.
   */
  readonly compiled: () => Promise<Compiled>;
}

/** What compiling the .az file gave: the result and the manifests it used, or why there is none. */
export type Compiled =
  | { readonly result: CompileResult; readonly manifests: ReadonlyMap<string, Manifest> }
  | { readonly error: string };

/** Each check's deadline: past any child's own timeout, so the child is always gone first. */
export const DEADLINE_MS = 20_000;
/** A child process's timeout, and a worker thread's. */
export const CHILD_MS = 15_000;
/** A child's report is a few lines; more is cut off. */
const CHILD_OUTPUT_BYTES = 64 * 1024;

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/** The command a report and its "run it again" lines name. */
export type Command = 'az doctor' | 'az audit';

/** One check under its deadline: whatever happens, a Finding comes back. */
function bounded<C>(check: Check<C>, ctx: C, deadlineMs: number, command: Command): Promise<Finding> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<CheckResult>((done) => {
    timer = setTimeout(() => done({
      status: 'fail',
      line: `${check.title}: no answer after ${seconds(deadlineMs)}`,
      fix: [`something on this machine did not answer — run ${command} again; if this line repeats, run the step it names by hand`],
    }), deadlineMs);
  });
  const ran = Promise.resolve()
    .then(() => check.run(ctx))
    .catch((e: unknown): CheckResult => ({
      status: 'fail',
      line: `${check.title}: the check stopped (${String((e as Error)?.message ?? e).split('\n')[0]})`,
      fix: [`run ${command} again; if this line repeats, report it with the line above`],
    }));
  return Promise.race([ran, late]).then((r) => {
    clearTimeout(timer);
    return { id: check.id, ...r };
  });
}

/** Every check at once, each under its deadline, reported in the order given. */
export function runChecks<C>(checks: readonly Check<C>[], ctx: C, deadlineMs = DEADLINE_MS, command: Command = 'az doctor'): Promise<Finding[]> {
  return Promise.all(checks.map((c) => bounded(c, ctx, deadlineMs, command)));
}

/** Run a child: never a shell, killed at its timeout, output capped. */
function runChild(file: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      done({ kind: 'error', message: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // A grandchild may still hold the pipes open; let go of them, or this
      // process would wait on them after the report.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ kind: 'timeout', ms: options.timeoutMs });
    }, options.timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { if (stdout.length < CHILD_OUTPUT_BYTES) stdout += c; });
    child.stderr?.on('data', (c: string) => { if (stderr.length < CHILD_OUTPUT_BYTES) stderr += c; });
    child.once('error', (e: NodeJS.ErrnoException) => {
      finish(e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', message: e.message });
    });
    child.once('close', (code, signal) => {
      finish(signal !== null && code === null
        ? { kind: 'error', message: `ended by ${signal}` }
        : { kind: 'exit', code: code ?? 1, stdout: stdout.slice(0, CHILD_OUTPUT_BYTES), stderr: stderr.slice(0, CHILD_OUTPUT_BYTES) });
    });
    if (options.input !== undefined) {
      // A child that exits before reading its input is reported by its exit, not by EPIPE.
      child.stdin?.once('error', () => {});
      child.stdin?.end(options.input);
    }
  });
}

/** How a worker ended: the one message it posted, or why there is none. */
export type WorkerResult<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Run `entry` in a worker thread with `data` and take the first message it
 * posts. Terminated at `timeoutMs`, or when `signal` aborts: termination
 * stops the thread's JavaScript wherever it is, a synchronous loop
 * included, which a check's deadline cannot.
 */
export function runWorker<T>(entry: URL, data: unknown, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResult<T>> {
  return new Promise((done) => {
    let worker: Worker;
    try {
      worker = new Worker(entry, { workerData: data });
    } catch (e) {
      done({ kind: 'error', message: (e as Error).message });
      return;
    }
    let settled = false;
    const finish = (r: WorkerResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      // Its message is in hand, or it is past its time: either way it is done.
      void worker.terminate();
      done(r);
    };
    const stop = () => finish({ kind: 'error', message: 'stopped' });
    const timer = setTimeout(() => finish({ kind: 'timeout', ms: timeoutMs }), timeoutMs);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    worker.once('message', (value: T) => finish({ kind: 'done', value }));
    worker.once('error', (e: Error) => finish({ kind: 'error', message: e.message }));
    worker.once('exit', (code) => finish({ kind: 'error', message: `ended (code ${code}) without an answer` }));
  });
}

/** This machine. `npmCli` is serve.ts's finder, passed in so this file imports no command module. */
export function systemProbe(npmCli: () => string | null): Probe {
  return {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    home: homedir(),
    osRelease: release(),
    cpuModels: cpus().map((c) => c.model),
    env: process.env,
    npmCli,
    run: runChild,
    statfs: async (path) => {
      const s = await statfs(path);
      return { bavail: s.bavail, bsize: s.bsize };
    },
    nodeFlags: process.allowedNodeEnvironmentFlags,
  };
}

export interface DoctorReport {
  readonly ok: boolean;
  /** word-quality-gate §5.2: 0 nothing failed (warnings never fail), 1 a requirement is missing. */
  readonly exit: 0 | 1;
  readonly counts: Readonly<Record<Status, number>>;
  readonly checks: readonly Finding[];
}

export function report(checks: readonly Finding[]): DoctorReport {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status]++;
  return { ok: counts.fail === 0, exit: counts.fail === 0 ? 0 : 1, counts, checks };
}

const MARK: Record<Status, string> = { pass: '✓', warn: '!', fail: '✗', skip: '-' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The terminal form: one line per check, its fix indented beneath, then the count. */
export function formatReport(r: DoctorReport, command: Command = 'az doctor'): string {
  const lines: string[] = [command];
  for (const c of r.checks) {
    lines.push(`  ${MARK[c.status]} ${c.line}`);
    for (const f of c.fix ?? []) lines.push(`      ${f}`);
  }
  const { pass, warn, fail, skip } = r.counts;
  lines.push(`${command}: ${plural(fail, 'failure', 'failures')}, ${plural(warn, 'warning', 'warnings')}, ${pass} passed, ${skip} skipped`);
  return `${lines.join('\n')}\n`;
}

/**
 * A path as one POSIX shell word. Fix lines are copied into a terminal, and
 * a file named `$(rm -rf ~).glb` must arrive as a name, never as a command.
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
