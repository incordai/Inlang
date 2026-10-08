/**
 * @az module auth-web
 * Purpose: auth wiring for sites that use auth: adapter config, <Protected>, useSession, build guard.
 * Spec: docs/auth-block-spec.md §3–§5
 * Exports: authPlan, authConfig, authReact, secretGuard
 * Edit guide: only public (AZ_PUBLIC_) values may reach the browser; auth code ships only when a site uses auth.
 * Tests: packages/target-web/test/auth.test.ts
 */

/**
 * Auth wiring for the web target — auth-block-spec §3–§5, ROADMAP M4.
 *
 * The auth word emits forms; this file emits what connects them to the
 * site's adapter, and only for a site that uses auth, so a site without it
 * ships none of this. It never implements authentication (PRD §6.5): the
 * adapter modules are copied from packages/auth-runtime by the caller, and
 * what is generated here only chooses one and hands it the page.
 *
 * Also here: the build guard every generated project runs, which refuses to
 * ship a service key (§4) — for every site, since a key can be pasted into
 * any project, not only one with a login form.
 */

import type { Spec } from '../../core/src/index.ts';
import { PUBLIC_ENV_PREFIX } from '../../core/src/index.ts';
import type { ThemeLike } from '../../core/src/emit-contract.ts';
import { generated } from './generated.ts';

/** Where the auth runtime lives in a generated project (the caller copies it). */
export const AUTH_DIR = 'src/az-auth';
/** Where the build guard lives — beside the Vite config, never in the bundle. */
export const GUARD_DIR = 'az-vite';

const px = (n: number) => `${n}px`;

/** The public variables the `hosted` adapter reads (§3.2). */
export const HOSTED_ENV = [`${PUBLIC_ENV_PREFIX}AUTH_URL`, `${PUBLIC_ENV_PREFIX}AUTH_KEY`] as const;

/** Where a session adapter's server routes live (§3.3). */
export const SESSION_BASE = '/api/auth';

/**
 * The one public variable the `azbackend` adapter reads (§3.4): the owner's
 * backend. Its own name, not the hosted adapter's, so a hosted provider's
 * settings can never be sent to the backend by accident.
 */
export const BACKEND_ENV = [`${PUBLIC_ENV_PREFIX}BACKEND_URL`] as const;

/** The public variables a site's adapter cannot build without. */
export function requiredEnv(plan: AuthPlan | null): readonly string[] {
  if (plan?.adapter === 'hosted') return HOSTED_ENV;
  if (plan?.adapter === 'azbackend') return BACKEND_ENV;
  return [];
}

export interface AuthPlan {
  readonly adapter: 'hosted' | 'session' | 'azbackend' | 'custom';
  /** `hosted` only: which protocol the provider speaks (§3.2 standard, §3.5 token-endpoint). */
  readonly profile: 'standard' | 'token-endpoint';
  /** The first page with `auth reset` — where a reset email lands, if any. */
  readonly reset: string | null;
  /** The custom adapter module, project-relative — copied into the user dir. */
  readonly impl: string | null;
  /** The first page with `auth login` — where signed-out visitors are sent. */
  readonly login: string | null;
  /** Routes wrapped in <Protected> (never the login page itself — that would loop). */
  readonly protect: string[];
}

/** The site's auth, or null when it has none. */
export function authPlan(spec: Spec): AuthPlan | null {
  const settings = spec.site.scoped.auth;
  const login = spec.pages.find((p) => p.blocks.some((b) => b.word === 'auth' && b.variant === 'login'))?.route ?? null;
  const used = settings !== undefined || spec.pages.some((p) => p.blocks.some((b) => b.word === 'auth'));
  if (!used) return null;
  const id = settings?.adapter;
  if (id !== 'hosted' && id !== 'session' && id !== 'azbackend' && id !== 'custom') return null;
  const protect = (settings?.protect ?? '').split(',').map((r) => r.trim()).filter((r) => r && r !== login);
  const reset = spec.pages.find((p) => p.blocks.some((b) => b.word === 'auth' && b.variant === 'reset'))?.route ?? null;
  const profile = settings?.profile === 'token-endpoint' ? 'token-endpoint' : 'standard';
  return { adapter: id, profile, reset, impl: settings?.impl ?? null, login, protect: [...new Set(protect)].sort() };
}

/** What the signed-in bar says when the server did not confirm the sign-out (§3.4 rule 14). */
export const SIGN_OUT_FAILED = 'You are still signed in: signing out did not complete. Try again.';

/**
 * §4.1, which every generated auth file carries: what actually protects the
 * data, and what this code is not.
 */
const NOT_SECURITY = `/*
 * auth-block-spec §4.1 — what actually protects the data.
 *
 * Row-level security in your own backend is the protection. Not this form,
 * not <Protected>, not the session hook — none of them run anywhere an
 * attacker cannot modify. The public key is public: every row your backend's
 * policies let an anonymous or authenticated role read is readable by anyone
 * who opens dev tools, whatever this site shows. A static host cannot protect
 * a page server-side; <Protected> only spares a signed-out visitor a broken,
 * empty page.
 */
`;

/** src/az-auth/config.ts — the one adapter this site uses. */
export function authConfig(plan: AuthPlan, userDir: string): string {
  const adapter = plan.adapter === 'hosted' && plan.profile === 'token-endpoint'
    ? `import { createTokenEndpointAdapter } from "./hosted-token.ts";

/**
 * §3.5, the token-endpoint profile: the server's base URL (API path
 * included) and PUBLIC key, from the environment the build inlines. Never a
 * service key — the build refuses one (§4). Reset emails land on the
 * site's 'auth reset' page.
 */
export const adapter: AuthAdapter = createTokenEndpointAdapter({
  url: import.meta.env.${HOSTED_ENV[0]} ?? "",
  publicKey: import.meta.env.${HOSTED_ENV[1]} ?? "",
  resetPath: ${JSON.stringify(plan.reset)},
});`
    : plan.adapter === 'hosted'
    ? `import { createHostedAdapter } from "./hosted.ts";

/**
 * §3.2: the provider's base URL and PUBLIC key, from the environment the
 * build inlines. Never a service key — the build refuses one (§4).
 */
export const adapter: AuthAdapter = createHostedAdapter({
  url: import.meta.env.${HOSTED_ENV[0]} ?? "",
  publicKey: import.meta.env.${HOSTED_ENV[1]} ?? "",
});`
    : plan.adapter === 'azbackend'
      ? `import { createBackendAdapter } from "./azbackend.ts";

/**
 * §3.4: the owner's backend, reached by its PUBLIC base URL. No key: the
 * backend authenticates by its httpOnly cookie. The build refuses a missing
 * or non-https URL before this file ships.
 */
export const adapter: AuthAdapter = createBackendAdapter({ url: import.meta.env.${BACKEND_ENV[0]} ?? "" });`
    : plan.adapter === 'session'
      ? `import { createSessionAdapter } from "./session.ts";

/** §3.3: the site's own server answers these routes and owns the cookie. */
export const adapter: AuthAdapter = createSessionAdapter({ base: ${JSON.stringify(SESSION_BASE)} });`
      : `// The author's own adapter module (\`impl\`), copied beside the site.
import impl from ${JSON.stringify(`../${userDir}/${plan.impl}`)};

export const adapter: AuthAdapter = impl;`;
  return `${generated('auth settings: the adapter, its public config and protected routes')}/// <reference types="vite/client" />
${NOT_SECURITY}
import type { AuthAdapter } from "./contract.ts";
${adapter}

/** The page signed-out visitors are sent to, if the site has one. */
export const LOGIN: string | null = ${JSON.stringify(plan.login)};
`;
}

/** src/az-auth/react.tsx — the session hook, <Protected>, and the form wiring. */
export function authReact(): string {
  return `${generated('auth for React: useSession() and <Protected>')}${NOT_SECURITY}
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AuthSession } from "./contract.ts";
import { attachAuth } from "./form.ts";
import { adapter, LOGIN } from "./config.ts";

/** §5: the session, kept current; unsubscribes on unmount. */
export function useSession(): { session: AuthSession | null; ready: boolean } {
  const [state, setState] = useState<{ session: AuthSession | null; ready: boolean }>({ session: null, ready: false });
  useEffect(() => {
    let alive = true;
    const off = adapter.onChange((session) => { if (alive) setState({ session, ready: true }); });
    Promise.resolve(adapter.ready?.()).then(() => {
      if (alive) setState({ session: adapter.session(), ready: true });
    });
    return () => { alive = false; off(); };
  }, []);
  return state;
}

/** Wires every auth form on the page to the adapter (runs after render). */
export function AuthRuntime() {
  useLayoutEffect(() => attachAuth(document, adapter), []);
  return null;
}

/**
 * §5's protected-route wrapper: a loading state, then the page or a
 * redirect to the login page. UX, not security — see the header.
 * \`lead\` (the page's nav) shows while the session is checked.
 */
export function Protected({ lead, children }: { lead: ReactNode; children: ReactNode }) {
  const { session, ready } = useSession();
  // A deliberate sign-out goes to login without \`?next\`: returning the
  // visitor to the page they just left would be wrong.
  const leaving = useRef(false);
  // §3.4 rule 14: signOut() rejects unless the server confirmed the session
  // ended. Then the visitor IS still signed in, and must be told so — never
  // shown the login page as if it had worked.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ready || session || leaving.current) return;
    const here = window.location.pathname + window.location.search;
    window.location.replace(LOGIN ? LOGIN + "?next=" + encodeURIComponent(here) : "/");
  }, [ready, session]);
  if (!ready || !session) {
    return <>{lead}<p className="az-auth-checking" role="status">Checking that you are signed in…</p></>;
  }
  return (
    <>
      {lead}
      <div className="az-session" role="region" aria-label="Your account">
        <span>Signed in as {session.user.email}</span>
        <button type="button" onClick={() => {
          leaving.current = true;
          setFailed(false);
          adapter.signOut().then(
            () => window.location.assign(LOGIN ?? "/"),
            () => { leaving.current = false; setFailed(true); },
          );
        }}>Sign out</button>
        {/* Present before any message, so the message is announced when it arrives. */}
        <p className="az-session-error" role="status">{failed ? ${JSON.stringify(SIGN_OUT_FAILED)} : ""}</p>
      </div>
      {children}
    </>
  );
}
`;
}

/**
 * The signed-in bar and the checking line, from theme tokens. Static CSS in
 * theme.css because the runtime component is not an emitted node; values
 * are the same tokens a word reads (A7).
 */
export function authCss(t: ThemeLike): string {
  return `
/* Auth (M4): the signed-in bar <Protected> renders, and its loading line. */
.az-session { display: flex; flex-wrap: wrap; gap: ${px(t.space[16])}; align-items: center; justify-content: flex-end;
  padding: ${px(t.space[8])} ${px(t.size['gutter-lg'])}; font-size: ${t.typeSize.sm}; color: var(--az-color-muted);
  background: var(--az-color-surface); border-bottom: 1px solid var(--az-color-border); }
.az-session button { min-height: ${px(t.size.tap)}; padding-inline: ${px(t.space[16])}; font: inherit; cursor: pointer;
  color: var(--az-color-text); background: var(--az-color-bg); border: 1px solid var(--az-color-border-strong);
  border-radius: ${px(t.radius.sm)}; }
.az-session button:focus-visible { outline: ${px(t.size.ring)} solid var(--az-color-focus); outline-offset: ${px(t.size['ring-offset'])}; }
.az-auth-checking { margin: 0; padding: ${px(t.space[32])} ${px(t.size['gutter-lg'])}; color: var(--az-color-muted); }
.az-session-error { margin: 0; flex-basis: 100%; text-align: end; color: var(--az-color-text); }
.az-session-error:empty { display: none; }
`;
}

/**
 * az-vite/guard.ts — the build guard (auth-spec §4, word-quality-gate §4).
 *
 * Runs inside the generated project's own build, so it judges the
 * environment that build really inlines and every file it really writes:
 * the chunks, the assets Vite reads as bytes, and the files it copies from
 * `public/` — read back from the output folder (az-vite/shipped.ts, the
 * scan `az audit` runs too). Both failures are unsuppressible: no option or
 * flag turns them off. A bundle refusal removes the output folder it read,
 * so a failed build leaves nothing to deploy. The pages the pre-render fills
 * after this runs are scanned the same way by az-vite/build.mjs.
 */
export function guardTs(required: readonly string[], adapter: string | null = null): string {
  // azbackend: the base URL must be usable, not merely present (§3.4) — the
  // adapter's own check, imported so the build and the site agree.
  const backend = adapter === 'azbackend';
  return `${generated('build guard: refuses a build that would ship a secret')}import { loadEnv, type Plugin } from "vite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PUBLIC_ENV_PREFIX, bundleMessage, envMessage, scanEnv, scanText, type ShippedPlace } from "./secrets.ts";
import { FILE_MAX_BYTES, MAX_FILES, removeOutput, shippedSecrets, walkShipped } from "./shipped.ts";
${backend ? `import { backendUrlProblem } from "../${AUTH_DIR}/azbackend.ts";\n` : ''}
/** Variables this site cannot build without (its auth adapter's, §3.2/§3.4). */
const REQUIRED: readonly string[] = ${JSON.stringify(required)};

export function secretGuard(): Plugin {
  let publicValues = new Set<string>();
  let root = "";
  let outDir = "";
  let publicDir = "";
  return {
    name: "az-secret-guard",
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || config.root, PUBLIC_ENV_PREFIX);
      const found = scanEnv(env);
      if (found.length > 0) throw new Error(found.map(envMessage).join("\\n"));
      const missing = REQUIRED.filter((name) => !env[name]);
      if (missing.length > 0) {
        throw new Error(${JSON.stringify(`auth: adapter ${adapter ?? 'hosted'} needs `)} + missing.join(" and ") + ${JSON.stringify(adapter === 'azbackend' ? " — set your backend's public base URL in .env or the environment" : " — set the provider's URL and PUBLIC key in .env or the environment")});
      }${backend ? `
      const problem = backendUrlProblem(env[${JSON.stringify(BACKEND_ENV[0])}] ?? "");
      if (problem) throw new Error("auth: adapter azbackend — " + problem);` : ''}
      // The public key is meant to ship; it is the one high-entropy string allowed.
      publicValues = new Set(Object.values(env).filter(Boolean));
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      // Vite's resolved public/ folder, or "" when copying it is turned off.
      publicDir = config.publicDir;
    },
    // Once everything is written: Vite copies public/ before it writes the
    // bundle, so the folder now holds every file the site ships.
    async writeBundle(options, bundle) {
      const dir = options.dir ?? outDir;
      const tree = await walkShipped(dir);
      if (tree === null) throw new Error("auth: the build guard found no output folder at " + dir + " — nothing the site ships could be checked");
      // A file an installed package published is judged by key shape only.
      const { hits } = await shippedSecrets(tree.files, join(root, "node_modules"), (text) => scanText(text, publicValues));
      // The message names where the key is: a file Vite wrote from the
      // bundle, one it copied from public/, or anything else in the folder.
      const place = (path: string): ShippedPlace => path in bundle ? "bundle"
        : publicDir !== "" && existsSync(join(publicDir, path)) ? "public" : "output";
      const problems = hits.map((h) => bundleMessage(h.path, h.finding, place(h.path)));
      for (const file of tree.unread) {
        problems.push("auth: " + file + " was not scanned for keys (over " + FILE_MAX_BYTES / 1024 / 1024 + "MB, or past " + MAX_FILES + " files) — the build ships only what the guard has read");
      }
      if (problems.length > 0) {
        // The folder is already written: a refused build removes it, so no
        // deploy step can ship what the guard refused. Only Vite's outDir,
        // and only inside the project.
        const left = await removeOutput(root, outDir);
        if (left !== null) problems.push("auth: " + left + " — delete it before any deploy");
        this.error(problems.join("\\n"));
      }
    },
  };
}
`;
}
