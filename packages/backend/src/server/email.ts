/**
 * @az server email
 * Purpose: sending reset and sign-in emails over SMTP or an HTTPS email API.
 * Spec: docs/backend-spec.md §7
 * Exports: createMailer, resetMessage, linkMessage
 * Edit guide: log error class only, never addresses or server replies.
 * Tests: packages/backend/test/backend.test.ts
 */

/**
 * Sending email — SMTP, or any HTTPS email API (backend-spec §7).
 *
 * Provider-neutral by construction. SMTP is the standard every mail service
 * speaks; the API path posts one documented JSON shape to a URL you choose,
 * so any service with a compatible endpoint — or a small relay you run —
 * works without this server naming it.
 *
 * Messages are plain text. Nothing a visitor typed is put into a message
 * except the link this server made, so there is no markup to inject.
 *
 * Copied into a generated server; imports only its siblings.
 */

import { loadDriver } from './drivers.ts';
import type { Config } from './env.ts';

export interface Message { readonly to: string; readonly subject: string; readonly text: string }
export interface Mailer { send(m: Message): Promise<void> }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * How long one send may wait on the mail service: the whole API request, and
 * each SMTP stage (DNS, connect, greeting, a silent socket). A hung service
 * then fails the send instead of holding it, and its connection, forever.
 */
const EMAIL_TIMEOUT_MS = 10_000;

interface Transport { sendMail(o: Record<string, unknown>): Promise<unknown> }

/** `timeoutMs` replaces EMAIL_TIMEOUT_MS — for tests that prove the bound without waiting it out. */
export async function createMailer(
  config: Config,
  env: { fetch: typeof fetch; timeoutMs?: number } = { fetch: (...a) => fetch(...a) },
): Promise<Mailer> {
  const timeoutMs = env.timeoutMs ?? EMAIL_TIMEOUT_MS;
  if (config.setup.email === 'api') {
    return {
      async send(m) {
        const response = await env.fetch(config.emailApi.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.emailApi.key}` },
          body: JSON.stringify({ from: config.emailFrom, to: m.to, subject: m.subject, text: m.text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Only the status is used: the body is discarded unread, which also frees the connection.
        await response.body?.cancel();
        if (!response.ok) throw new Error(`email API answered ${response.status}`);
      },
    };
  }
  const nodemailer = await loadDriver('nodemailer') as { default?: { createTransport: (o: object) => Transport }; createTransport?: (o: object) => Transport };
  const createTransport = (nodemailer.createTransport ?? nodemailer.default?.createTransport)!;
  const { host, port, user, password } = config.smtp;
  // TLS is required on the wire except to a loopback relay (local development):
  // port 465 is TLS from the start, anything else must upgrade with STARTTLS.
  const local = LOOPBACK.has(host);
  const transport = createTransport({
    host, port,
    secure: port === 465,
    requireTLS: port !== 465 && !local,
    ignoreTLS: local,
    ...(user ? { auth: { user, pass: password } } : {}),
    tls: { rejectUnauthorized: true },
    dnsTimeout: timeoutMs,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  return { async send(m) { await transport.sendMail({ from: config.emailFrom, to: m.to, subject: m.subject, text: m.text }); } };
}

export function resetMessage(site: string, to: string, link: string): Message {
  return {
    to,
    subject: `Reset your password for ${site}`,
    text: `Someone asked to reset the password for this address on ${site}.\n\n`
      + `To choose a new password, open this link within 30 minutes:\n${link}\n\n`
      + 'If it was not you, ignore this email — your password has not changed.\n',
  };
}

export function linkMessage(site: string, to: string, link: string): Message {
  return {
    to,
    subject: `Your sign-in link for ${site}`,
    text: `Open this link within 15 minutes to sign in to ${site}:\n${link}\n\n`
      + 'It works once. If you did not ask for it, ignore this email.\n',
  };
}
