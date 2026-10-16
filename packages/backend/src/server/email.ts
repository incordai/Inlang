/**
 * @az server email
 * Purpose: sending reset and sign-in emails over SMTP or an HTTPS email API.
 * Spec: docs/backend-spec.md §7
 * Exports: createMailer, resetMessage, linkMessage
 * Edit guide: log error class only, never addresses or server replies.
 * Tests: packages/backend/test/backend.test.ts, packages/backend/test/email-tls.test.ts
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

import { Socket } from 'node:net';
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

/**
 * How long one SMTP send may take in total. The stage timeouts above fire
 * only on silence, so a server that sends a byte every few seconds would hold
 * the send, and its connection, for as long as it likes. A healthy server
 * takes well under a second for one short message; 30 s is three stage
 * bounds, room for a slow but honest DNS, connect, TLS, login and data
 * exchange. Sends run off the request path, so the wait costs one connection,
 * never a visitor's answer. (The API post is already capped in total by its
 * EMAIL_TIMEOUT_MS signal.)
 */
const EMAIL_DEADLINE_MS = 30_000;

interface Transport { sendMail(o: Record<string, unknown>): Promise<unknown>; close(): void }

/** The error a send that passed EMAIL_DEADLINE_MS fails with — the class the API path's timeout has. */
function deadlinePassed(): Error {
  const error = new Error('email send passed its deadline');
  error.name = 'TimeoutError';
  return error;
}

/**
 * A mail server's TLS as a test meets it on loopback: `secure` is TLS from
 * the connect (as port 465 is), else a required STARTTLS upgrade; `ca` is the
 * one certificate trusted for it, in place of the system's. The certificate
 * is still verified — host name included.
 */
export interface MailerTls { readonly secure: boolean; readonly ca: string }

/**
 * `timeoutMs` replaces EMAIL_TIMEOUT_MS and `deadlineMs` EMAIL_DEADLINE_MS —
 * for tests that prove the bounds without waiting them out; `tls` replaces
 * the port's TLS mode and the system's certificates, for tests that prove
 * both TLS paths end to end against a local server (a loopback host
 * otherwise sends in the clear, and port 465 needs privileges to listen on).
 */
export async function createMailer(
  config: Config,
  env: { fetch: typeof fetch; timeoutMs?: number; deadlineMs?: number; tls?: MailerTls } = { fetch: (...a) => fetch(...a) },
): Promise<Mailer> {
  const timeoutMs = env.timeoutMs ?? EMAIL_TIMEOUT_MS;
  const deadlineMs = env.deadlineMs ?? EMAIL_DEADLINE_MS;
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
  const options = {
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
    ...(env.tls ? {
      secure: env.tls.secure, requireTLS: !env.tls.secure, ignoreTLS: false,
      tls: { rejectUnauthorized: true, ca: env.tls.ca },
    } : {}),
  };
  return {
    async send(m) {
      // Each send gets its own transport over a socket made here, so the
      // deadline can end that one connection: the library connects the socket
      // (TLS and STARTTLS included), but closing a transport leaves a send in
      // progress open.
      const socket = new Socket();
      const transport = createTransport({ ...options, socket });
      let expired = false;
      // A socket destroyed while the library is still resolving the host is
      // reopened by its later connect; ending it again there frees it.
      socket.on('connect', () => { if (expired) socket.destroy(); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<Error>((done) => {
        timer = setTimeout(() => { expired = true; socket.destroy(); done(deadlinePassed()); }, deadlineMs);
      });
      // Settles as a value, so a send cut by the deadline (which then fails as
      // closed) reports the deadline once, not an unhandled rejection later.
      const sent = transport.sendMail({ from: config.emailFrom, to: m.to, subject: m.subject, text: m.text })
        .then(() => null, (error: unknown) => error);
      try {
        const failure = await Promise.race([sent, deadline]);
        if (failure !== null) throw failure;
      } finally {
        clearTimeout(timer);
        transport.close();
      }
    },
  };
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
