/**
 * @az module audit
 * Purpose: az audit — the built output's checks: secrets in the shipped files, dependency advisories, page and backend CSP, new-tab links.
 * Spec: docs/word-quality-gate.md §2 B, §4 rule 2, §5 (and §5.5, what is built)
 * Exports: AUDIT_CHECKS, audit, cspProblems, backendHeaderProblems, readAdvisory, AuditContext, AuditOptions
 * Edit guide: read-only — nothing here writes, fixes or installs; a secret is reported by file, offset and shape, never by value; files are read through fs/promises, bounded.
 * Tests: packages/cli/test/audit.test.ts
 */

/**
 * `az audit` looks at what a build produced, where `az doctor` looks at the
 * machine and the source (word-quality-gate §5). It runs in the frame
 * doctor.ts gives both commands: each check is one line and its fix, under
 * the same deadlines, with the same exit codes.
 *
 * The secret scan is the one the generated build's guard runs over what
 * Vite wrote (shipped.ts, with core secrets.ts's scanText) — here again,
 * after the pre-render has written its pages, with the same public values
 * allowed — and, in a file, the digests of what it carries inline (a page's
 * policy pins them). The advisory check is the only one that uses the network,
 * so it runs only when asked (`--online`).
 */

import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ENV_PREFIX, quotable, scanText } from '../../core/src/secrets.ts';
import { SERVER_DIR } from '../../backend/src/emit.ts';
import { SECURITY_HEADERS } from '../../backend/src/server/http.ts';
import { ownDigests } from '../../target-web/src/csp.ts';
import { DOTENV_FILES, parseDotenv } from './az.ts';
import { FILE_MAX_BYTES, MAX_FILES, readRegular, shippedSecrets, walkShipped, type Shipped } from './shipped.ts';
import {
  CHILD_MS, report, runChecks, shellQuote,
  type Check, type CheckResult, type DoctorReport, type Probe, type RunResult,
} from './doctor.ts';

/** The package manager the generated project is installed and built with (az dev, verify-build). */
const PACKAGE_MANAGER = 'npm';
/** Its read-only advisory query: reads the lockfile, asks the configured registry, changes nothing. */
const AUDIT_ARGS = ['audit', '--json'] as const;
/** The lockfiles it reads; without one it has nothing to ask about. */
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'] as const;

/** The folder the generated project's build writes the site into (az-vite/build.mjs). */
const DIST = 'dist';
/** Written by every az build (output.ts); its absence means the folder is not one. */
const BUILD_MANIFEST = '.az-manifest.json';

/** How many locations a line lists before "and N more". */
const SHOW = 5;

/** az's own copies of the server files that set response headers — a build copies them verbatim. */
const SERVER_SOURCE = fileURLToPath(new URL('../../backend/src/server/', import.meta.url));
const HEADER_FILES = ['http.ts', 'app.ts', 'main.ts'] as const;

/** The built site, walked once for every check; `unread` names what was too large or past the cap. */
type Site =
  | { readonly kind: 'missing'; readonly dir: string }
  | { readonly kind: 'site'; readonly dir: string; readonly files: readonly Shipped[]; readonly unread: readonly string[] };

export interface AuditContext {
  /** The absolute output folder of a build (`--out`, default .az-build). */
  readonly outDir: string;
  /** The folder the run was started in, for the paths it prints. */
  readonly cwd: string;
  readonly probe: Probe;
  /** May a check use the network? Only the advisory check does, and only when this is true. */
  readonly online: boolean;
  /** The built site under dist/, read once and shared. */
  readonly site: () => Promise<Site>;
}

const shown = (cwd: string, abs: string) => {
  const rel = relative(cwd, abs);
  // A path starting `-` would be read as an option by the command it is pasted into.
  return rel === '' ? '.' : rel.startsWith('..') ? abs : rel.startsWith('-') ? `./${rel}` : rel;
};
const q = (ctx: AuditContext, abs: string) => shellQuote(shown(ctx.cwd, abs));
const cdTo = (ctx: AuditContext, dir: string) => (shown(ctx.cwd, dir) === '.' ? '' : `cd ${q(ctx, dir)} && `);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const more = (list: readonly string[]) => (list.length > SHOW ? [...list.slice(0, SHOW), `and ${list.length - SHOW} more`] : [...list]);

/**
 * A file name or route as it may be printed. Hashed asset names are random by
 * design, so the entropy rule is not applied; a name holding a key's shape
 * (`sk_live_…`) is printed by its length only, as a value would be.
 */
const named = (path: string) => (scanText(path).some((f) => f.rule !== 'entropy') ? `<a secret-looking name, ${path.length} characters>` : path);

/**
 * Every text file under dist/, paths from the output folder (`dist/…`);
 * links are not followed (shipped.ts).
 */
async function walkSite(outDir: string): Promise<Site> {
  const dir = join(outDir, DIST);
  const tree = await walkShipped(dir, outDir);
  return tree === null ? { kind: 'missing', dir } : { kind: 'site', dir, files: tree.files, unread: tree.unread.map(named) };
}

const notBuilt = (ctx: AuditContext, site: { dir: string }): CheckResult => ({
  status: 'fail',
  line: `bundle secrets: ${shown(ctx.cwd, site.dir)} is not a folder the build wrote — the site is not built, so nothing it ships can be checked`,
  fix: [`run: ${cdTo(ctx, ctx.outDir)}${PACKAGE_MANAGER} install && ${PACKAGE_MANAGER} run build`],
});

/* ---- secrets in what ships ----------------------------------------------- */

/**
 * The values the guard lets through: the public variables the build
 * inlined (vite loadEnv with the public prefix — the output folder's .env
 * files, then the process), which are high-entropy by design.
 */
async function publicValues(ctx: AuditContext): Promise<Set<string>> {
  const env: Record<string, string> = {};
  for (const name of DOTENV_FILES) {
    const text = await readRegular(join(ctx.outDir, name));
    if (text !== null) parseDotenv(text, env);
  }
  const merged: Record<string, string | undefined> = { ...env, ...ctx.probe.env };
  return new Set(Object.entries(merged).filter(([k, v]) => k.startsWith(PUBLIC_ENV_PREFIX) && v).map(([, v]) => v as string));
}

const bundleSecrets: Check<AuditContext> = {
  id: 'bundle-secrets',
  title: 'bundle secrets',
  run: async (ctx) => {
    const site = await ctx.site();
    if (site.kind === 'missing') return notBuilt(ctx, site);
    const allow = await publicValues(ctx);
    // A file a package published is judged by key shape only (shipped.ts).
    const scan = (text: string) => {
      const own = ownDigests(text);
      return scanText(text, own.length > 0 ? new Set([...allow, ...own]) : allow);
    };
    const { hits: found, published } = await shippedSecrets(site.files, join(ctx.outDir, 'node_modules'), scan);
    // file:offset and the rule (the key's shape) — never a character of the value.
    const hits = found.map(({ path, finding: s }) => `${named(path)}:${s.where.replace(/^@/, '')} (${s.rule})`);
    if (hits.length > 0) {
      return {
        status: 'fail',
        line: `bundle secrets: ${count(hits.length, 'key-shaped string')} in the built site — anyone who loads it can read ${hits.length === 1 ? 'it' : 'them'}`,
        fix: [
          ...more(hits),
          `remove the key from the source and from every ${PUBLIC_ENV_PREFIX} variable, rebuild, and rotate it if this build was ever deployed`,
          `a public key the site must ship is allowed when it is set as a ${PUBLIC_ENV_PREFIX} variable for az audit, as for the build`,
        ],
      };
    }
    if (site.unread.length > 0) {
      return {
        status: 'warn',
        line: `bundle secrets: ${count(site.unread.length, 'file')} not scanned (over ${FILE_MAX_BYTES / 1024 / 1024}MB, or past ${MAX_FILES} files)`,
        fix: more(site.unread),
      };
    }
    const copies = published.size > 0 ? `; ${count(published.size, 'file')} a package published judged by key shape only` : '';
    return { status: 'pass', line: `bundle secrets: none in ${count(site.files.length, 'shipped text file')} — the build guard's patterns, after pre-render${copies}` };
  },
};

/* ---- dependency advisories (the network, only with --online) ------------- */

/** One folder's answer from the advisory query. */
type Advisory =
  | { readonly kind: 'counts'; readonly counts: Readonly<Record<string, number>>; readonly serious: readonly string[] }
  | { readonly kind: 'unreachable'; readonly why: string }
  | { readonly kind: 'no-lock' }
  | { readonly kind: 'error'; readonly why: string };

/** Errors that mean the advisory service was not reached — the machine is offline, or the registry blocked. */
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|audit endpoint returned an error|request to \S+ failed/i;

const SERIOUS = new Set(['high', 'critical']);
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'] as const;

/** The fields of the advisory query's JSON report this reads; anything else in it is ignored. */
interface AdvisoryJson {
  readonly metadata?: { readonly vulnerabilities?: Readonly<Record<string, unknown>> };
  readonly vulnerabilities?: Readonly<Record<string, { readonly severity?: unknown } | null>>;
  readonly message?: unknown;
  readonly error?: { readonly code?: unknown; readonly summary?: unknown };
}

function advisoryJson(text: string): AdvisoryJson | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' ? v as AdvisoryJson : null;
  } catch {
    return null;
  }
}

/** What the advisory query's JSON says, whatever its exit code (it exits 1 when it finds anything). */
export function readAdvisory(r: RunResult): Advisory {
  if (r.kind === 'timeout') return { kind: 'unreachable', why: `no answer after ${r.ms / 1000}s` };
  if (r.kind === 'missing') return { kind: 'error', why: `${PACKAGE_MANAGER} not found` };
  if (r.kind === 'error') return { kind: 'error', why: r.message };
  const json = advisoryJson(r.stdout);
  const v = json?.metadata?.vulnerabilities;
  if (v && typeof v === 'object') {
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, typeof v[s] === 'number' ? v[s] as number : 0]));
    const serious = Object.entries(json?.vulnerabilities ?? {})
      .flatMap(([name, x]) => (typeof x?.severity === 'string' && SERIOUS.has(x.severity) ? [`${name} (${x.severity})`] : []))
      .sort();
    return { kind: 'counts', counts, serious };
  }
  if (json?.error?.code === 'ENOLOCK') return { kind: 'no-lock' };
  const said = [json?.message, json?.error?.code, json?.error?.summary, r.stderr].filter((x) => typeof x === 'string' && x !== '').join(' ');
  if (UNREACHABLE.test(said)) return { kind: 'unreachable', why: 'could not reach the advisory service' };
  const first = said.split('\n').map((l) => l.trim()).find(Boolean);
  return { kind: 'error', why: first ? `exit ${r.code}: ${first.slice(0, 160)}` : `exit ${r.code}` };
}

/** The folders a build installs: the site, and the built server when there is one. */
async function installed(ctx: AuditContext): Promise<string[]> {
  const dirs = [ctx.outDir, join(ctx.outDir, SERVER_DIR)];
  const has = await Promise.all(dirs.map((d) => stat(join(d, 'package.json')).then((s) => s.isFile(), () => false)));
  return dirs.filter((_, i) => has[i]);
}

const hasLock = async (dir: string) =>
  (await Promise.all(LOCKFILES.map((f) => stat(join(dir, f)).then((s) => s.isFile(), () => false)))).some(Boolean);

const dependencies: Check<AuditContext> = {
  id: 'dependencies',
  title: 'dependencies',
  run: async (ctx) => {
    const dirs = await installed(ctx);
    if (dirs.length === 0) return { status: 'skip', line: 'dependencies: the build has no package.json' };
    if (!ctx.online) {
      return { status: 'skip', line: 'dependencies: not checked — the advisory service is a network call; run: az audit --online' };
    }
    const cli = ctx.probe.npmCli();
    if (cli === null) {
      return { status: 'fail', line: `dependencies: ${PACKAGE_MANAGER} is not found beside Node — it asks the advisory service`, fix: [`run: az doctor — its ${PACKAGE_MANAGER} line says what to install`] };
    }
    // At once: each folder's child has its own timeout, all under the check's deadline.
    const answers = await Promise.all(dirs.map(async (dir) => {
      if (!(await hasLock(dir))) return { dir, a: { kind: 'no-lock' } as Advisory };
      return { dir, a: readAdvisory(await ctx.probe.run(ctx.probe.execPath, [cli, ...AUDIT_ARGS], { cwd: dir, timeoutMs: CHILD_MS })) };
    }));
    const where = (dir: string) => shown(ctx.cwd, dir);
    const serious = answers.flatMap(({ dir, a }) => (a.kind === 'counts' ? a.serious.map((s) => `${where(dir)}: ${s}`) : []));
    const failed = answers.filter(({ a }) => a.kind === 'error');
    const lines = answers.map(({ dir, a }) => {
      if (a.kind === 'counts') return `${where(dir)}: ${SEVERITIES.map((s) => `${a.counts[s]} ${s}`).join(', ')}`;
      if (a.kind === 'no-lock') return `${where(dir)}: no lockfile — run: ${cdTo(ctx, dir)}${PACKAGE_MANAGER} install, then az audit --online`;
      return `${where(dir)}: ${a.why}`;
    });
    const detail = dirs.map((dir) => `run: ${cdTo(ctx, dir)}${PACKAGE_MANAGER} ${AUDIT_ARGS[0]} — it names each advisory and the version that fixes it`);
    if (serious.length > 0) {
      // word-quality-gate §2 B: block on high and critical.
      return { status: 'fail', line: `dependencies: ${count(serious.length, 'package')} with a high or critical advisory`, fix: [...more(serious), ...lines, ...detail] };
    }
    if (failed.length > 0) {
      return { status: 'fail', line: `dependencies: the advisory query failed — ${failed.map(({ dir, a }) => `${where(dir)}: ${(a as { why: string }).why}`).join('; ')}`, fix: [...detail] };
    }
    const unreachable = answers.filter(({ a }) => a.kind === 'unreachable');
    if (unreachable.length > 0) {
      return {
        status: 'warn',
        line: `dependencies: could not reach the advisory service — not checked (${unreachable.map(({ dir, a }) => `${where(dir)}: ${(a as { why: string }).why}`).join('; ')})`,
        fix: [`run az audit --online again with the network up; behind a proxy, the registry ${PACKAGE_MANAGER} is configured with must answer audit requests`],
      };
    }
    if (answers.some(({ a }) => a.kind === 'no-lock')) {
      return { status: 'warn', line: 'dependencies: a folder has no lockfile, so its packages were not checked', fix: lines };
    }
    const minor = answers.some(({ a }) => a.kind === 'counts' && (a.counts.moderate + a.counts.low) > 0);
    if (minor) return { status: 'warn', line: 'dependencies: moderate or low advisories only', fix: [...lines, ...detail] };
    return { status: 'pass', line: `dependencies: no known advisory (${lines.join('; ')})` };
  },
};

/* ---- Content-Security-Policy --------------------------------------------- */

/** A policy's directives, by lowercased name, each with its lowercased sources. The first of a name wins (CSP3 §2.2). */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources.map((s) => s.toLowerCase()));
  }
  return out;
}

/** Sources that let a script come from anywhere, or any page inject one. */
const OPEN_SOURCES = new Set(['*', 'http:', 'https:', 'data:', 'blob:']);

/** A hash or a nonce: with one, a browser that knows them ignores 'unsafe-inline' in that directive. */
const PINNED = /^'(?:nonce-|sha256-|sha384-|sha512-)/;

/**
 * The weaker tier: scripts pinned, but any inline style applies. Injected
 * markup can restyle the page — overlay it, or read attribute values out
 * through selectors — though it cannot run code. Named apart so a page with
 * only this is reported as what it is.
 */
const STYLE_INLINE = "'unsafe-inline' in style-src — injected markup can restyle the page";

/**
 * The fetch directives graded for open sources besides script-src (graded
 * on its own above) and object-src (which must be 'none'), each with what an
 * open source in it lets in. Only a directive the policy sets is graded: one
 * it leaves out falls back to default-src, graded here in its own right.
 */
const FETCH_DIRECTIVES: Readonly<Record<string, string>> = {
  'default-src': 'whatever no other directive names loads from anywhere',
  'script-src-elem': 'scripts from anywhere',
  'script-src-attr': 'scripts from anywhere',
  'style-src': 'stylesheets from anywhere',
  'style-src-elem': 'stylesheets from anywhere',
  'style-src-attr': 'stylesheets from anywhere',
  'connect-src': 'the page can send what it reads anywhere',
  'img-src': 'images from anywhere, and the page can send what it reads in their URLs',
  'font-src': 'fonts from anywhere',
  'media-src': 'media from anywhere',
  'frame-src': 'frames from anywhere',
  'child-src': 'frames and workers from anywhere',
  'worker-src': 'workers from anywhere',
  'manifest-src': 'a manifest from anywhere',
};

/**
 * The scheme sources a directive may carry and still grade strict — each one
 * only where az's own page policy (target-web csp.ts) uses it, for a reason
 * that holds in any policy:
 *
 * - img-src data: — a page with no icon file declares `href="data:,"`, and a
 *   data: image is pixels: it runs nothing and requests nothing.
 * - img-src blob:, connect-src blob: — a 3D model's embedded textures are
 *   decoded to blob: URLs, then loaded and read back. A blob: URL is minted
 *   only by a script already running in the page, so an injected tag cannot
 *   name one of its own.
 * - worker-src blob: — the model decoder runs in a worker made from a blob:
 *   URL, for the same reason: only the page's own pinned script can make it.
 */
const ALLOWED_SCHEMES: Readonly<Record<string, ReadonlySet<string>>> = {
  'img-src': new Set(['data:', 'blob:']),
  'connect-src': new Set(['blob:']),
  'worker-src': new Set(['blob:']),
};

/** A bare scheme source (`https:`, `data:`): any URL of that scheme, on any host. */
const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/;
/** A wildcard host (`*`, `*.cdn.test`, `https://*`): any host, or any under a name. */
const WILDCARD_HOST = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\*/;

/** The sources in one fetch directive that let its content come from anywhere. */
function openSources(name: string, sources: readonly string[]): string[] {
  const allowed = ALLOWED_SCHEMES[name];
  return sources.filter((s) => WILDCARD_HOST.test(s) || (SCHEME_SOURCE.test(s) && !allowed?.has(s)));
}

/**
 * What a page's policy leaves open, one phrase each; empty when it is
 * strict. A hash, a nonce or 'strict-dynamic' disables 'unsafe-inline' in
 * any browser that knows them, so then it is not counted.
 */
export function cspProblems(policy: string): string[] {
  const d = directives(policy);
  const out: string[] = [];
  const script = d.get('script-src') ?? d.get('default-src');
  if (!script) {
    out.push('no script-src or default-src — any script may load');
  } else {
    if (script.includes("'unsafe-eval'")) out.push("'unsafe-eval' in script-src — strings run as code");
    const pinned = script.some((s) => PINNED.test(s) || s === "'strict-dynamic'");
    if (script.includes("'unsafe-inline'") && !pinned) out.push("'unsafe-inline' in script-src — an injected script runs");
    const open = script.filter((s) => OPEN_SOURCES.has(s) || s.startsWith('http://'));
    if (open.length > 0) out.push(`script-src allows ${open.map(quotable).join(' ')} — scripts from anywhere`);
  }
  const object = d.get('object-src') ?? d.get('default-src');
  if (!(object && object.length === 1 && object[0] === "'none'")) out.push("object-src is not 'none' — plugin content may load");
  // The bundle is referenced relatively (base "./"): an injected <base> would move it.
  if (!d.has('base-uri')) out.push('no base-uri — an injected <base> moves every relative script');
  const style = d.get('style-src') ?? d.get('default-src');
  if (style?.includes("'unsafe-inline'") && !style.some((s) => PINNED.test(s))) out.push(STYLE_INLINE);
  for (const [name, what] of Object.entries(FETCH_DIRECTIVES)) {
    const open = openSources(name, d.get(name) ?? []);
    if (open.length > 0) out.push(`${name} allows ${open.map(quotable).join(' ')} — ${what}`);
  }
  return out;
}

/** The few entities a server renderer writes in an attribute. */
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Each start tag of one element in an HTML text, as its attributes (lowercased names). Comments are skipped. */
function tags(html: string, element: string): Map<string, string>[] {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const out: Map<string, string>[] = [];
  for (const m of text.matchAll(new RegExp(`<${element}\\b([^>]*)>`, 'gi'))) {
    const attrs = new Map<string, string>();
    for (const a of m[1].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = a[1].toLowerCase();
      if (!attrs.has(name)) attrs.set(name, decode(a[2] ?? a[3] ?? a[4] ?? ''));
    }
    out.push(attrs);
  }
  return out;
}

const pagesOf = (site: { files: readonly Shipped[] }) => site.files.filter((f) => /\.html?$/i.test(f.path));

/** A page's route as a visitor types it: dist/work/index.html → /work. */
const route = (path: string) => named(`/${path.replace(new RegExp(`^${DIST}/`), '').replace(/(?:^|\/)index\.html?$/i, '')}`);

const pageCsp: Check<AuditContext> = {
  id: 'page-csp',
  title: 'page CSP',
  run: async (ctx) => {
    const site = await ctx.site();
    if (site.kind === 'missing') return { status: 'skip', line: 'page CSP: no built site — see the bundle secrets line' };
    const pages = pagesOf(site);
    if (pages.length === 0) return { status: 'skip', line: 'page CSP: the built site has no pages' };
    const bare: string[] = [];
    const weak: string[] = [];
    const styled: string[] = [];
    for (const p of pages) {
      const policies = tags(p.text, 'meta')
        .filter((a) => a.get('http-equiv')?.toLowerCase() === 'content-security-policy')
        .map((a) => a.get('content') ?? '');
      if (policies.length === 0) {
        bare.push(route(p.path));
        continue;
      }
      // Several policies are all enforced: a page is open only where every one of them is.
      const each = policies.map(cspProblems);
      const open = each[0].filter((x) => each.every((list) => list.includes(x)));
      if (open.length > 0) (open.every((x) => x === STYLE_INLINE) ? styled : weak).push(`${route(p.path)}: ${open.join('; ')}`);
    }
    const host = 'a policy your host sends as a header is not visible here — check it in the browser\'s network panel';
    if (bare.length === pages.length) {
      // word-quality-gate §2 B: no CSP is a medium risk — a warning, never a failure.
      return {
        status: 'warn',
        line: `page CSP: none of ${count(pages.length, 'page')} sets a Content-Security-Policy — an injected script would run`,
        fix: ['az build gives every page one (word-quality-gate §2 B): rebuild with this az, then npm run build in the output — or have the host send a Content-Security-Policy header', host],
      };
    }
    if (bare.length > 0 || weak.length > 0 || styled.length > 0) {
      const parts = [
        bare.length > 0 ? `${count(bare.length, 'page')} without a policy` : '',
        weak.length > 0 ? `${count(weak.length, 'page')} with a weak one` : '',
        styled.length > 0 ? `${count(styled.length, 'page')} allowing any inline style (scripts pinned)` : '',
      ];
      return {
        status: 'warn',
        line: `page CSP: ${parts.filter(Boolean).join(', ')}`,
        fix: [...more([...bare.map((r) => `${r}: no policy`), ...weak, ...styled]), host],
      };
    }
    return { status: 'pass', line: `page CSP: ${count(pages.length, 'page')}, each with a strict policy` };
  },
};

/** The response headers a backend must send on every API response, one phrase per gap; empty when all are there. */
export function backendHeaderProblems(headers: Readonly<Record<string, string>>): string[] {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: string[] = [];
  const csp = h.get('content-security-policy');
  if (!csp) {
    out.push('no Content-Security-Policy');
  } else {
    const d = directives(csp);
    const def = d.get('default-src');
    // An API answers with data, never a page: nothing in a response may load.
    if (!(def && def.length === 1 && def[0] === "'none'")) out.push("CSP default-src is not 'none'");
    if (!d.has('frame-ancestors')) out.push('CSP has no frame-ancestors — a response may be framed');
  }
  if (h.get('x-content-type-options')?.toLowerCase() !== 'nosniff') out.push('no X-Content-Type-Options: nosniff');
  if (!h.get('referrer-policy')) out.push('no Referrer-Policy');
  return out;
}

const sameText = async (a: string, b: string) => {
  const [x, y] = await Promise.all([readRegular(a), readRegular(b)]);
  return x !== null && y !== null && x.replace(/\r\n/g, '\n') === y.replace(/\r\n/g, '\n');
};

const backendCsp: Check<AuditContext> = {
  id: 'backend-csp',
  title: 'backend CSP',
  run: async (ctx) => {
    const server = join(ctx.outDir, SERVER_DIR);
    if (!(await stat(join(server, 'az.config.json')).then((s) => s.isFile(), () => false))) {
      return { status: 'skip', line: 'backend CSP: the build has no server' };
    }
    // The headers are judged in az's own copy of the server's code, which a
    // build copies verbatim; a built copy that differs is not vouched for.
    // Nothing from the project is loaded or run.
    const differs: string[] = [];
    for (const f of HEADER_FILES) {
      if (!(await sameText(join(server, 'src', f), join(SERVER_SOURCE, f)))) differs.push(shown(ctx.cwd, join(server, 'src', f)));
    }
    if (differs.length > 0) {
      return {
        status: 'warn',
        line: `backend CSP: ${differs.join(', ')} ${differs.length === 1 ? 'is' : 'are'} not what this az writes — its response headers can't be vouched for`,
        fix: ['rebuild with az build — the server\'s files are generated, never edited'],
      };
    }
    const gaps = backendHeaderProblems(SECURITY_HEADERS);
    if (gaps.length > 0) {
      return { status: 'fail', line: `backend CSP: every API response is sent with ${gaps.join('; ')}`, fix: ['report it: the server\'s headers are az\'s (backend-spec §5)'] };
    }
    return { status: 'pass', line: `backend CSP: every API response sends ${SECURITY_HEADERS['content-security-policy']}, nosniff, a referrer policy` };
  },
};

/* ---- links that open a new tab ------------------------------------------- */

const newTabLinks: Check<AuditContext> = {
  id: 'new-tab-links',
  title: 'new-tab links',
  run: async (ctx) => {
    const site = await ctx.site();
    if (site.kind === 'missing') return { status: 'skip', line: 'new-tab links: no built site — see the bundle secrets line' };
    let total = 0;
    const open: string[] = [];
    for (const p of pagesOf(site)) {
      for (const a of tags(p.text, 'a')) {
        if (a.get('target')?.toLowerCase() !== '_blank') continue;
        total++;
        const rel = (a.get('rel') ?? '').toLowerCase().split(/\s+/);
        // noreferrer implies noopener.
        // A link may carry a token in its query: printed only when it is not shaped like one.
        if (!rel.includes('noopener') && !rel.includes('noreferrer')) open.push(`${route(p.path)}: ${quotable(a.get('href') ?? '(no href)')}`);
      }
    }
    if (open.length > 0) {
      // word-quality-gate §2 B: reverse tabnabbing, a medium risk.
      return {
        status: 'warn',
        line: `new-tab links: ${count(open.length, 'link')} with target="_blank" and no rel="noopener" — the opened page can redirect this one`,
        fix: [...more(open), 'add rel="noopener noreferrer" to each; az\'s own words already do (a raw or custom component did not)'],
      };
    }
    return total === 0
      ? { status: 'skip', line: 'new-tab links: no link opens a new tab' }
      : { status: 'pass', line: `new-tab links: ${count(total, 'link')}, each with rel="noopener"` };
  },
};

/** Every check, in the order the report prints them. */
export const AUDIT_CHECKS: readonly Check<AuditContext>[] = [bundleSecrets, dependencies, pageCsp, backendCsp, newTabLinks];

export interface AuditOptions {
  readonly outDir: string;
  readonly cwd: string;
  readonly probe: Probe;
  readonly online: boolean;
  readonly checks?: readonly Check<AuditContext>[];
  readonly deadlineMs?: number;
}

/**
 * Audit one build's output. Reads only — nothing is written, fixed or
 * installed; the advisory query (only with `online`) reads the lockfile.
 */
export async function audit(options: AuditOptions): Promise<DoctorReport> {
  const manifest = await stat(join(options.outDir, BUILD_MANIFEST)).then((s) => s.isFile(), () => false);
  if (!manifest) {
    return report([{
      id: 'output',
      status: 'fail',
      line: `output: ${shown(options.cwd, options.outDir)} is not an az build — there is nothing to audit`,
      fix: ['run: az build site.az (and az audit --out <dir> for another folder)'],
    }]);
  }
  let site: Promise<Site> | undefined;
  const ctx: AuditContext = {
    outDir: options.outDir,
    cwd: options.cwd,
    probe: options.probe,
    online: options.online,
    site: () => (site ??= walkSite(options.outDir)),
  };
  return report(await runChecks(options.checks ?? AUDIT_CHECKS, ctx, options.deadlineMs, 'az audit'));
}
