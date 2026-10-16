/**
 * @az module doctor-system
 * Purpose: the az doctor checks of the machine's surroundings: its proxy settings and their effect, and the free disk space where a build writes.
 * Spec: docs/word-quality-gate.md §5.3, §5.4
 * Exports: PROXY_CHECK, DISK_CHECK, DISK_WARN_BYTES, proxyShown
 * Edit guide: report only — nothing is set or written; a proxy is shown as scheme, host and port, its user and password never.
 * Tests: packages/cli/test/doctor.test.ts
 */

/**
 * word-quality-gate §5.3 names what doctor cannot fix but must explain: a
 * corporate proxy, and disk space. Both read the machine through Probe, so
 * a test fakes them.
 *
 * Who uses a proxy from the environment is not one rule. npm does, for the
 * package registry, unless the registry's host is in NO_PROXY. Node's own
 * fetch — every HTTP call the generated server makes: a sign-in provider,
 * the email API, the chat model — does not, unless the server is started
 * with NODE_USE_ENV_PROXY=1 on a Node that supports it; then it does, except
 * for NO_PROXY's hosts. SMTP never goes through an HTTP proxy. The check
 * says which applies here; it changes nothing.
 */

import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Check, CheckResult, DoctorContext, Probe } from './doctor.ts';

/* ---- proxy --------------------------------------------------------------- */

/** The proxy variables, each with its lower-case spelling (tools differ in which they read first). */
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY'] as const;
const NO_PROXY = 'NO_PROXY';
/** The variable that makes Node's fetch use the proxy variables, and the flag that says this Node has it. */
const NODE_PROXY_VAR = 'NODE_USE_ENV_PROXY';
const NODE_PROXY_FLAG = '--use-env-proxy';
/** npm's own registry setting, when the environment sets it. */
const NPM_REGISTRY_VAR = 'npm_config_registry';

/** A variable's value, either spelling; `both` when the two are set and differ. */
function either(env: Probe['env'], name: string): { value: string | undefined; both: boolean } {
  const upper = env[name] || undefined;
  const lower = env[name.toLowerCase()] || undefined;
  return { value: upper ?? lower, both: upper !== undefined && lower !== undefined && upper !== lower };
}

/**
 * A proxy URL as it may be printed: scheme, host and port. A user and a
 * password in it are `***`, and a path or query is dropped — any of them can
 * carry a credential. Null when it is not a URL.
 */
export function proxyShown(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (!u.host) return null;
  const secret = u.username !== '' || u.password !== '';
  return `${u.protocol}//${secret ? '***@' : ''}${u.host}`;
}

/** Does a NO_PROXY list cover `host`? Its entries are host names, `.suffix` or `*` (port and scheme ignored). */
function bypasses(noProxy: string | undefined, host: string): boolean {
  const h = host.toLowerCase();
  return (noProxy ?? '').split(/[\s,]+/).filter(Boolean).some((raw) => {
    const entry = raw.toLowerCase().replace(/:\d+$/, '');
    if (entry === '*') return true;
    const bare = entry.replace(/^\*?\./, '');
    return h === bare || h.endsWith(`.${bare}`);
  });
}

/** The registry's host, when the environment names the registry; else null (npm's own default). */
function registryHost(env: Probe['env']): string | null {
  const v = env[NPM_REGISTRY_VAR];
  if (!v) return null;
  try {
    return new URL(v).hostname || null;
  } catch {
    return null;
  }
}

export const PROXY_CHECK: Check = {
  id: 'proxy',
  title: 'proxy',
  run: async (ctx: DoctorContext): Promise<CheckResult> => {
    const env = ctx.probe.env;
    const set = PROXY_VARS.map((name) => ({ name, ...either(env, name) })).filter((v) => v.value !== undefined);
    if (set.length === 0) {
      return { status: 'pass', line: 'proxy: none set — the package registry and the server\'s outbound calls go direct' };
    }
    const problems: string[] = [];
    const effects: string[] = [];
    for (const v of set) {
      const shown = proxyShown(v.value!);
      if (shown === null) problems.push(`${v.name} is set but is not a URL — npm and Node can't use it; write it as http://host:port`);
      else effects.push(`${v.name}: ${shown}`);
      if (v.both) problems.push(`${v.name} and ${v.name.toLowerCase()} are both set, to different values — tools differ in which they read; keep one`);
    }
    const noProxy = either(env, NO_PROXY);
    if (noProxy.both) problems.push(`${NO_PROXY} and ${NO_PROXY.toLowerCase()} are both set, to different values — keep one`);
    const registry = registryHost(env);
    effects.push(registry !== null && bypasses(noProxy.value, registry)
      ? `the package registry (${registry}) is in ${NO_PROXY}: npm reaches it direct`
      : `npm reaches the package registry through the proxy${noProxy.value ? ` (${NO_PROXY} does not name ${registry ?? 'it'})` : ''}`);
    const nodeUses = env[NODE_PROXY_VAR] === '1';
    const nodeCan = ctx.probe.nodeFlags.has(NODE_PROXY_FLAG);
    // Whether the server's calls going direct matters: only a project with the built-in backend makes them.
    const compiled = ctx.source ? await ctx.compiled().catch(() => null) : null;
    const server = compiled !== null && 'result' in compiled && compiled.result.spec?.site.backend !== undefined;
    const direct = `the server's outbound calls (sign-in providers, the email API, the chat model) go direct: Node's fetch ignores ${PROXY_VARS.join('/')}`;
    if (nodeUses && nodeCan) {
      effects.push(`the server's outbound calls (sign-in providers, the email API, the chat model) go through the proxy${noProxy.value ? `, except ${NO_PROXY}'s hosts` : ''}; SMTP never does`);
    } else if (nodeUses) {
      problems.push(`${NODE_PROXY_VAR}=1 is set, but this Node (${ctx.probe.node}) has no environment proxy support — the server's outbound calls go direct; use a newer Node 22`);
    } else if (server) {
      problems.push(`${direct} — if they must pass the proxy, start the server with ${NODE_PROXY_VAR}=1`
        + `${nodeCan ? '' : ` on a Node that supports it (this ${ctx.probe.node} does not)`}; SMTP never uses an HTTP proxy`);
    } else {
      effects.push(`${direct} unless started with ${NODE_PROXY_VAR}=1 — this project has no backend to make them`);
    }
    return problems.length > 0
      ? { status: 'warn', line: `proxy: ${problems[0]}`, fix: [...problems.slice(1), ...effects] }
      : { status: 'pass', line: `proxy: ${effects[0]}`, fix: effects.slice(1) };
  },
};

/* ---- disk space ---------------------------------------------------------- */

const MB = 1024 * 1024;
const GB = 1024 * MB;
/**
 * Below this much free space where a build writes, doctor warns: one build
 * is its output, the resized copies of its images and the project's own
 * install (its node_modules is a few hundred megabytes), with room left
 * for the system's own temporary files.
 */
export const DISK_WARN_BYTES = GB;

const sizeText = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(1)}GB` : `${Math.round(bytes / MB)}MB`);

/** `path`, or its nearest folder that exists (the output folder may not be made yet), and its device. */
async function existing(path: string): Promise<{ path: string; dev: number } | null> {
  for (let p = path; ; p = dirname(p)) {
    const s = await stat(p).catch(() => null);
    if (s) return { path: p, dev: s.dev };
    if (dirname(p) === p) return null;
  }
}

export const DISK_CHECK: Check = {
  id: 'disk',
  title: 'disk space',
  run: async (ctx: DoctorContext): Promise<CheckResult> => {
    // Where the build reads (the project) and where it writes (the output folder); one line per filesystem.
    const places = [...new Set([...(ctx.source ? [dirname(ctx.source)] : []), ctx.outDir])];
    const seen = new Set<number>();
    const low: string[] = [];
    const free: string[] = [];
    for (const place of places) {
      const at = await existing(place);
      if (!at || seen.has(at.dev)) continue;
      seen.add(at.dev);
      let s;
      try {
        s = await ctx.probe.statfs(at.path);
      } catch (e) {
        return { status: 'skip', line: `disk space: can't be read for ${place} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
      }
      const bytes = s.bavail * s.bsize;
      (bytes < DISK_WARN_BYTES ? low : free).push(`${sizeText(bytes)} free for ${place}`);
    }
    if (low.length > 0) {
      return {
        status: 'warn',
        line: `disk space: ${low[0]} — under ${sizeText(DISK_WARN_BYTES)}, a build and its install may run out`,
        fix: [...low.slice(1), 'free some space, or build to a folder on a larger disk: az build site.az --out <dir>'],
      };
    }
    if (free.length === 0) return { status: 'skip', line: 'disk space: no folder to measure' };
    return { status: 'pass', line: `disk space: ${free.join('; ')}` };
  },
};
