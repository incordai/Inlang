/**
 * The auth forms' behaviour — auth-block-spec §5 and §6.
 *
 * The word emits one real <form> per flow, complete and labelled, marked
 * `data-az-behaviour="auth"`, with its error summary, per-field error
 * elements and status line already in the markup (hidden). This file wires
 * submit to the adapter and nothing else: validate on submit, then call,
 * then show errors or go on. No crypto, no storage, no tokens — those are
 * the adapter's (§5, "never emits").
 *
 * Runs after the page renders and touches nothing at import. Copied into a
 * generated project that uses `auth`; imports only its sibling.
 */

import {
  ERROR_COPY, fieldOf, safeNext, toErrorCode, validate, type AuthAdapter, type AuthResult, type FieldError,
} from './contract.ts';

type Cleanup = () => void;

/** "Sending…" while a request runs — status, not an error, so polite (§6). */
const PENDING: Readonly<Record<string, string>> = {
  password: 'Signing you in…',
  signup: 'Creating your account…',
  link: 'Sending your link…',
  set: 'Saving your new password…',
};

/** Never says whether the address has an account (§6, no enumeration). */
const LINK_SENT = 'If an account exists for that address, a link is on its way. Check your inbox.';
const CONFIRM_SIGNUP = 'Check your inbox to confirm your address, then sign in.';

export interface AttachOptions {
  /** Where the page is — for `?token=` and `?next=`. */
  readonly location: Pick<Location, 'search' | 'origin'> & { assign(url: string): void };
}

export function attachAuth(doc: Document, adapter: AuthAdapter, options?: AttachOptions): Cleanup {
  const ac = new AbortController();
  const win = doc.defaultView;
  const loc = options?.location ?? win?.location;
  if (!loc) return () => ac.abort();
  const params = new URLSearchParams(loc.search);

  const forms = [...doc.querySelectorAll<HTMLFormElement>('form[data-az-behaviour="auth"]')];
  showResetState(forms, params);
  // §3.5: an email link or a provider may have brought a session back to
  // this page. A recovery session opens the set-new-password form; a
  // sign-in on a login or sign-up page continues where the visitor was going.
  if (adapter.landing) {
    void adapter.landing().then((landed) => {
      if (ac.signal.aborted || !landed) return;
      if (landed.kind === 'recovery') {
        showResetState(forms, params, true);
        return;
      }
      const start = forms.find((f) => f.dataset.flow === 'login' || f.dataset.flow === 'signup');
      if (start) loc.assign(safeNext(params.get('next'), loc.origin) ?? start.dataset.redirect ?? '/');
    });
  }
  showReturnedError(forms, params, win);
  for (const box of doc.querySelectorAll<HTMLElement>('[data-az-oauth="providers"]')) {
    void fillProviders(box, adapter, loc, params, ac.signal);
  }

  for (const form of forms) {
    // JS validates on submit with a summary (§6); without JS the browser's own
    // `required` checks still run, because this line never executes.
    form.noValidate = true;
    const failed = new Set<string>();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      void submit(form, submitter, failed);
    }, { signal: ac.signal });

    // §6: re-validate on blur only once a field has failed, so a correction
    // clears its error at once without flagging a half-typed address.
    form.addEventListener('focusout', (e) => {
      const input = e.target as HTMLInputElement | null;
      if (!input?.name || !failed.has(input.name)) return;
      const errors = check(form, method(form, null)).filter((x) => x.field === input.name);
      if (errors.length === 0) {
        failed.delete(input.name);
        setInline(form, input.name, null);
      } else {
        setInline(form, input.name, errors[0].message);
      }
    }, { signal: ac.signal });
  }

  async function submit(form: HTMLFormElement, submitter: HTMLButtonElement | null, failed: Set<string>) {
    const how = method(form, submitter);
    const errors = check(form, how);
    if (errors.length > 0) {
      for (const x of errors) failed.add(x.field);
      show(form, errors);
      return;
    }
    clear(form);
    const status = form.querySelector<HTMLElement>('.az-auth-status');
    const pendingKey = how === 'link' ? 'link' : form.dataset.flow === 'signup' ? 'signup' : form.dataset.flow === 'reset-set' ? 'set' : 'password';
    if (status) status.textContent = PENDING[pendingKey];
    // §6: busy, fixed width — the button stays enabled and focusable.
    submitter?.setAttribute('aria-busy', 'true');
    let result: AuthResult;
    try {
      result = await call(form, how);
    } finally {
      submitter?.removeAttribute('aria-busy');
    }
    if (!result.ok) {
      if (status) status.textContent = '';
      const field = result.field ?? fieldOf(result.code);
      if (field) failed.add(field);
      show(form, [{ field: field ?? '', message: ERROR_COPY[result.code] }]);
      return;
    }
    if (result.session) {
      loc!.assign(safeNext(params.get('next'), loc!.origin) ?? form.dataset.redirect ?? '/');
      return;
    }
    if (status) status.textContent = how === 'link' || form.dataset.flow === 'reset' ? LINK_SENT : CONFIRM_SIGNUP;
  }

  function call(form: HTMLFormElement, how: string): Promise<AuthResult> {
    const v = values(form);
    const email = String(v.email ?? '').trim();
    const password = String(v.password ?? '');
    switch (form.dataset.flow) {
      case 'reset': return adapter.requestReset(email);
      case 'reset-set': return adapter.setPassword(params.get('token') ?? '', password, String(v.passwordConfirm ?? ''));
      case 'signup': {
        if (how === 'link') return adapter.requestLink(email);
        const location = String(v.location ?? '').trim();
        return adapter.signUp({
          email, password, passwordConfirm: String(v.passwordConfirm ?? ''),
          ...(v.name ? { name: String(v.name).trim() } : {}),
          ...(location ? { location } : {}),
        });
      }
      default:
        return how === 'link' ? adapter.requestLink(email) : adapter.signIn({ email, password });
    }
  }

  return () => ac.abort();
}

/** `link` or `password` — which submit was pressed (the button's value). */
function method(form: HTMLFormElement, submitter: HTMLButtonElement | null): string {
  if (submitter?.value) return submitter.value;
  return form.querySelector<HTMLButtonElement>('button[type="submit"]')?.value ?? 'password';
}

/** The form's values by field name; a checkbox is its checked state. */
function values(form: HTMLFormElement): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const el of form.querySelectorAll<HTMLInputElement>('input[name]')) {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

/** What this flow and method require (§6, §7). */
function check(form: HTMLFormElement, how: string): FieldError[] {
  const v = values(form);
  const flow = form.dataset.flow;
  if (how === 'link' || flow === 'reset') return validate({ email: v.email ?? '' }, {});
  if (flow === 'reset-set') {
    return validate({ password: v.password ?? '', passwordConfirm: v.passwordConfirm }, { password: 'new', confirm: 'passwordConfirm' in v });
  }
  if (flow === 'signup') {
    return validate(v, { password: 'new', name: 'name' in v, terms: 'terms' in v, confirm: 'passwordConfirm' in v });
  }
  return validate(v, { password: 'current' });
}

/** The input a field name refers to, within one form. */
const inputFor = (form: HTMLFormElement, field: string) =>
  form.querySelector<HTMLInputElement>(`input[name="${CSS.escape(field)}"]`);

/**
 * One field's error: text in its own element, tied by aria-describedby,
 * aria-invalid on the field (§6). null clears it.
 */
function setInline(form: HTMLFormElement, field: string, message: string | null) {
  const input = inputFor(form, field);
  if (!input) return;
  const error = form.querySelector<HTMLElement>(`#${CSS.escape(`${input.id}-error`)}`);
  const described = new Set((input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
  if (message && error) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    described.add(error.id);
  } else {
    if (error) { error.textContent = ''; error.hidden = true; described.delete(error.id); }
    input.removeAttribute('aria-invalid');
  }
  if (described.size) input.setAttribute('aria-describedby', [...described].join(' '));
  else input.removeAttribute('aria-describedby');
}

/**
 * §6: a summary at the top of the form — role="alert", one entry per
 * problem, each an in-page link to its field — and focus moves TO it, so
 * the count of what is wrong is heard once. No aria-live as well: that
 * would announce it twice.
 */
function show(form: HTMLFormElement, errors: readonly FieldError[]) {
  clear(form);
  const summary = form.querySelector<HTMLElement>('.az-auth-summary');
  const list = summary?.querySelector('ul');
  const first = form.querySelector<HTMLInputElement>('input[name]');
  for (const e of errors) {
    if (e.field) setInline(form, e.field, e.message);
    if (!list) continue;
    const target = (e.field && inputFor(form, e.field)) || first;
    const item = form.ownerDocument.createElement('li');
    const a = form.ownerDocument.createElement('a');
    a.href = `#${target?.id ?? ''}`;
    a.textContent = e.message;
    item.append(a);
    list.append(item);
  }
  if (summary) {
    summary.hidden = false;
    summary.focus();
  }
}

function clear(form: HTMLFormElement) {
  const summary = form.querySelector<HTMLElement>('.az-auth-summary');
  if (summary) {
    summary.hidden = true;
    summary.querySelector('ul')?.replaceChildren();
  }
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name]')) setInline(form, input.name, null);
}

/**
 * §5: `reset` is two states in one variant, chosen by a URL token — the
 * request form without one, the set-new-password form with one (the address
 * prefilled read-only when the link carries it, so a manager can file it).
 */
function showResetState(forms: readonly HTMLFormElement[], params: URLSearchParams, recovering = false) {
  const request = forms.find((f) => f.dataset.flow === 'reset');
  const set = forms.find((f) => f.dataset.flow === 'reset-set');
  if (!request || !set) return;
  // A `?token=` link, or (§3.5) a recovery session the adapter adopted.
  const token = params.get('token');
  const setting = Boolean(token) || recovering;
  request.hidden = setting;
  set.hidden = !setting;
  const email = params.get('email');
  const field = set.querySelector<HTMLInputElement>('input[name="email"]');
  if (token && email && field) field.value = email;
}

/**
 * §3.4: after a provider round-trip fails, the backend sends the visitor
 * back with `?auth_error=<code>`. The code is shown as the closed set's copy
 * (anything else reads as `unknown`) in the first form's summary, then
 * dropped from the address so a reload does not show it again.
 */
function showReturnedError(forms: readonly HTMLFormElement[], params: URLSearchParams, win: Window | null) {
  const code = params.get('auth_error');
  const target = forms.find((f) => !f.hidden);
  if (code === null || !target) return;
  show(target, [{ field: '', message: ERROR_COPY[toErrorCode(code)] }]);
  if (!win) return;
  const url = new URL(win.location.href);
  url.searchParams.delete('auth_error');
  win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
}

/**
 * §3.4, `methods oauth`: one "Continue with …" button per provider the
 * backend lists, cloned from the emitted template. Text is set with
 * textContent — a label is the backend's input, never markup — and the
 * link goes to the backend's start route with a same-origin `next`. With
 * no providers, or an adapter that has none, the container stays hidden.
 */
async function fillProviders(
  box: HTMLElement, adapter: AuthAdapter, loc: Pick<Location, 'search' | 'origin'>,
  params: URLSearchParams, signal: AbortSignal,
) {
  const template = box.querySelector<HTMLElement>('[data-az-oauth-template]');
  if (!template || !adapter.providers || !adapter.oauthStart) return;
  const list = await adapter.providers();
  if (signal.aborted || list.length === 0) return;
  const form = box.closest('section')?.querySelector<HTMLFormElement>('form[data-az-behaviour="auth"]');
  const next = safeNext(params.get('next'), loc.origin) ?? form?.dataset.redirect ?? '/';
  const parent = template.parentElement;
  template.remove();
  for (const p of list) {
    const item = template.cloneNode(true) as HTMLElement;
    item.removeAttribute('data-az-oauth-template');
    const link = item.querySelector<HTMLAnchorElement>('a');
    if (!link) continue;
    link.href = adapter.oauthStart(p.id, next, loc.origin);
    link.textContent = `Continue with ${p.label}`;
    parent?.append(item);
  }
  box.hidden = false;
}
