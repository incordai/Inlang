/**
 * SMTP over TLS end to end (backend-spec §7): implicit TLS (port 465's
 * mode) and a required STARTTLS upgrade, both over the socket email.ts makes
 * so its total deadline can end the send. A local SMTP fake speaks each mode
 * with a certificate made at test time (scripts/lib/self-signed.mjs); the
 * mailer trusts that one certificate and still verifies it.
 *
 * Proven: the message arrives, and only over TLS — also to a server that
 * offers PIPELINING; a server that drips a byte at a time after the
 * handshake fails the send at the deadline as TimeoutError, and its
 * connection is closed; a slow greeting and a STARTTLS handshake the server
 * never finishes share one setup bound, which fails the send before the
 * deadline; a certificate the mailer does not trust, or a server that offers
 * no STARTTLS, fails the send with nothing sent in the clear.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { selfSignedCert } from '../../../scripts/lib/self-signed.mjs';
import { createMailer, type MailerTls } from '../src/server/email.ts';
import { loadConfig } from '../src/server/env.ts';

/** How long a test waits on a send before calling it hung — well past every deadline here. */
const HUNG_MS = 5_000;
/** The fake's drip: one byte this often, never a line end, so no silence timeout fires. */
const DRIP_MS = 100;
/** The total deadline the drip tests set: several drips, well under HUNG_MS. */
const DEADLINE_MS = 1_000;
/** How far past the deadline a send may end — timers and a TLS teardown, not another deadline. */
const DEADLINE_SLACK_MS = 500;
/** The setup bound the slow-setup test sets (connect, greeting and STARTTLS share it): over a second, so its waits are not timer noise. */
const SETUP_MS = 1_000;
/** How long a closed send's connection may take to reach the fake as closed. */
const CLOSE_MS = 1_000;

type Mode = 'implicit' | 'starttls';

interface Received { readonly data: string; readonly overTls: boolean }

interface Fake {
  readonly port: number;
  /** Each message the fake took, and whether its socket was TLS by then. */
  readonly messages: Received[];
  /** Every command line, as the fake read it. */
  readonly commands: string[];
  /** The TCP connections it still holds. */
  open(): number;
  close(): Promise<void>;
}

interface FakeOptions {
  readonly mode: Mode;
  /** After TLS is up, answer the first command one byte at a time, forever. */
  readonly drip?: boolean;
  /** STARTTLS mode only: false leaves it out of EHLO's answer. */
  readonly offerStartTls?: boolean;
  /** Offer PIPELINING once the session is TLS, as nearly every real server does: the envelope then comes as one batch. */
  readonly pipelining?: boolean;
  /** Greet this long after the connection, not at once. */
  readonly greetAfterMs?: number;
  /** STARTTLS mode only: answer STARTTLS, then never take part in the TLS handshake. */
  readonly stallStartTls?: boolean;
}

/**
 * A minimal SMTP server: EHLO, STARTTLS (when offered, before TLS), MAIL,
 * RCPT, DATA, QUIT. Lines are buffered, so a command split across reads is
 * still one command.
 */
async function smtpFake(cert: { readonly key: string; readonly cert: string }, options: FakeOptions): Promise<Fake> {
  const context = createSecureContext({ key: cert.key, cert: cert.cert });
  const messages: Received[] = [];
  const commands: string[] = [];
  const held = new Set<Socket>();
  const drips = new Set<ReturnType<typeof setInterval>>();

  const speak = (io: Duplex, overTls: boolean, greet: boolean, raw: Socket) => {
    let buffered = '';
    let inData = false;
    let body: string[] = [];
    let dripping = false;
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (let end = buffered.indexOf('\r\n'); end >= 0 && !dripping; end = buffered.indexOf('\r\n')) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ data: body.join('\n'), overTls });
            body = [];
            io.write('250 queued\r\n');
          } else body.push(line);
          continue;
        }
        commands.push(line);
        if (options.drip && overTls) {
          dripping = true;
          const t = setInterval(() => io.write('2'), DRIP_MS);
          drips.add(t);
          raw.once('close', () => { clearInterval(t); drips.delete(t); });
          return;
        }
        const verb = line.slice(0, 8).toUpperCase();
        const offer = options.mode === 'starttls' && !overTls && options.offerStartTls !== false;
        if (verb.startsWith('EHLO')) {
          // Sign-in is offered once the session is TLS, as a careful server does.
          const pipelining = options.pipelining ? '250-PIPELINING\r\n' : '';
          io.write(offer ? '250-fake\r\n250 STARTTLS\r\n' : overTls ? `250-fake\r\n${pipelining}250 AUTH PLAIN LOGIN\r\n` : '250 fake\r\n');
        } else if (verb.startsWith('AUTH')) {
          io.write(overTls ? '235 signed in\r\n' : '530 TLS first\r\n');
        } else if (verb.startsWith('STARTTLS') && !offer) {
          io.write('502 not offered\r\n');
        } else if (verb.startsWith('STARTTLS') && options.stallStartTls) {
          io.removeListener('data', onData);
          io.write('220 go ahead\r\n');
          return;
        } else if (verb.startsWith('STARTTLS')) {
          io.removeListener('data', onData);
          io.write('220 go ahead\r\n', () => {
            const secured = new TLSSocket(raw, { isServer: true, secureContext: context });
            secured.on('error', () => raw.destroy());
            secured.once('secure', () => speak(secured, true, false, raw));
          });
          return;
        } else if (verb.startsWith('DATA')) {
          inData = true;
          io.write('354 go on\r\n');
        } else if (verb.startsWith('QUIT')) {
          io.end('221 bye\r\n');
        } else {
          io.write('250 ok\r\n');
        }
      }
    };
    io.on('data', onData);
    if (greet && options.greetAfterMs !== undefined) {
      const t = setTimeout(() => io.write('220 fake ready\r\n'), options.greetAfterMs);
      raw.once('close', () => clearTimeout(t));
    } else if (greet) io.write('220 fake ready\r\n');
  };

  const track = (server: Server) => server.on('connection', (s: Socket) => {
    held.add(s);
    s.on('close', () => held.delete(s));
    s.on('error', () => s.destroy());
  });

  let server: Server;
  if (options.mode === 'implicit') {
    server = createTlsServer({ key: cert.key, cert: cert.cert }, (secured) => {
      secured.on('error', () => secured.destroy());
      speak(secured, true, true, secured);
    });
  } else {
    server = createTcpServer((raw) => speak(raw, false, true, raw));
  }
  track(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    commands,
    open: () => held.size,
    close: () => new Promise<void>((done) => {
      for (const t of drips) clearInterval(t);
      for (const s of held) s.destroy();
      server.close(() => done());
    }),
  };
}

/** How `p` settled within `ms` of wall time — `hung` if it had not. */
function within(p: Promise<unknown>, ms: number): Promise<{ hung: true } | { hung: false; error: unknown }> {
  return new Promise((done) => {
    const timer = setTimeout(() => done({ hung: true }), ms);
    p.then(() => ({ hung: false as const, error: undefined }), (error: unknown) => ({ hung: false as const, error }))
      .then((r) => { clearTimeout(timer); done(r); });
  });
}

/** Resolves once `check` holds, polling every 10 ms; false if it still does not after `ms`. */
function eventually(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (check()) { clearInterval(t); done(true); } else if (Date.now() - start > ms) { clearInterval(t); done(false); }
    }, 10);
  });
}

function smtpConfig(port: number) {
  const loaded = loadConfig({
    AZ_SESSION_SECRET: 'x'.repeat(43), AZ_BACKEND_PUBLIC_URL: 'https://api.example.org', AZ_ALLOWED_ORIGINS: 'https://www.example.org',
    AZ_EMAIL_FROM: 'Studio <no-reply@example.org>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: String(port),
    AZ_SMTP_USER: 'mailer', AZ_SMTP_PASSWORD: 'not-a-real-password',
  }, { database: 'sqlite', email: 'smtp' }, 'Studio');
  assert.ok(loaded.ok);
  return loaded.config;
}

const pem = selfSignedCert();
const MESSAGE = { to: 'ada@example.org', subject: 'Reset your password', text: 'Open this link: https://www.example.org/reset#t' };

for (const mode of ['implicit', 'starttls'] as const) {
  const tls: MailerTls = { secure: mode === 'implicit', ca: pem.cert };

  test(`email smtp ${mode}: the message arrives over TLS, and its connection is closed`, async () => {
    const fake = await smtpFake(pem, { mode });
    try {
      const mailer = await createMailer(smtpConfig(fake.port), { fetch: (...a) => fetch(...a), deadlineMs: HUNG_MS - 1_000, tls });
      const r = await within(mailer.send(MESSAGE), HUNG_MS);
      assert.deepEqual(r, { hung: false, error: undefined });
      assert.equal(fake.messages.length, 1, 'one message');
      assert.equal(fake.messages[0].overTls, true, 'it was sent after TLS was up');
      assert.match(fake.messages[0].data, /Open this link: https:\/\/www\.example\.org\/reset#t/);
      // Sign-in went over TLS too: no AUTH before it, in STARTTLS's plain part.
      const auth = fake.commands.findIndex((c) => c.toUpperCase().startsWith('AUTH'));
      assert.ok(auth >= 0, 'the mailer signed in');
      if (mode === 'starttls') {
        const upgrade = fake.commands.findIndex((c) => c.toUpperCase() === 'STARTTLS');
        assert.ok(upgrade >= 0 && upgrade < auth, `STARTTLS came before AUTH: ${JSON.stringify(fake.commands)}`);
      }
      assert.ok(await eventually(() => fake.open() === 0, CLOSE_MS), `${fake.open()} connection(s) still open after the send`);
    } finally { await fake.close(); }
  });

  test(`email smtp ${mode}: a server that offers PIPELINING gets the envelope after TLS and sign-in, and the message arrives`, async () => {
    const fake = await smtpFake(pem, { mode, pipelining: true });
    try {
      const mailer = await createMailer(smtpConfig(fake.port), { fetch: (...a) => fetch(...a), deadlineMs: HUNG_MS - 1_000, tls });
      const r = await within(mailer.send(MESSAGE), HUNG_MS);
      assert.deepEqual(r, { hung: false, error: undefined });
      assert.equal(fake.messages.length, 1, 'one message');
      assert.equal(fake.messages[0].overTls, true, 'it was sent after TLS was up');
      assert.match(fake.messages[0].data, /Open this link: https:\/\/www\.example\.org\/reset#t/);
      const at = (re: RegExp) => fake.commands.findIndex((c) => re.test(c));
      const [auth, mail, rcpt, data] = [/^AUTH/i, /^MAIL FROM:/i, /^RCPT TO:/i, /^DATA$/i].map(at);
      assert.ok(auth >= 0 && auth < mail && mail < rcpt && rcpt < data, `sign-in, then MAIL, RCPT and DATA: ${JSON.stringify(fake.commands)}`);
      assert.ok(await eventually(() => fake.open() === 0, CLOSE_MS), `${fake.open()} connection(s) still open after the send`);
    } finally { await fake.close(); }
  });

  test(`email smtp ${mode}: a server that drips a byte at a time after the handshake fails the send at the deadline, and its connection is closed`, async () => {
    const fake = await smtpFake(pem, { mode, drip: true });
    try {
      // The silence timeout is longer than the drip, so only the total deadline can end this send.
      const mailer = await createMailer(smtpConfig(fake.port), { fetch: (...a) => fetch(...a), timeoutMs: DEADLINE_MS / 2, deadlineMs: DEADLINE_MS, tls });
      const started = Date.now();
      const r = await within(mailer.send(MESSAGE), HUNG_MS);
      const took = Date.now() - started;
      assert.equal(r.hung, false, `the send was still waiting after ${HUNG_MS} ms`);
      assert.equal(!r.hung && (r.error as Error).name, 'TimeoutError');
      assert.ok(took >= DEADLINE_MS && took < DEADLINE_MS + DEADLINE_SLACK_MS, `failed after ${took} ms, the deadline is ${DEADLINE_MS} ms`);
      assert.ok(fake.commands.length > 0, 'the drip began after TLS was up');
      assert.equal(fake.messages.length, 0);
      assert.ok(await eventually(() => fake.open() === 0, CLOSE_MS), `${fake.open()} connection(s) still open after the deadline`);
    } finally { await fake.close(); }
  });

  test(`email smtp ${mode}: CONTROL: a certificate the mailer does not trust fails the send, and nothing is sent`, async () => {
    const fake = await smtpFake(pem, { mode });
    try {
      const other = selfSignedCert();
      const mailer = await createMailer(smtpConfig(fake.port), { fetch: (...a) => fetch(...a), deadlineMs: HUNG_MS - 1_000, tls: { ...tls, ca: other.cert } });
      const r = await within(mailer.send(MESSAGE), HUNG_MS);
      assert.equal(r.hung, false);
      assert.ok(!r.hung && r.error instanceof Error, 'the send failed');
      assert.equal(fake.messages.length, 0);
      assert.ok(!fake.commands.some((c) => c.toUpperCase().startsWith('AUTH')), 'no credentials were sent');
      assert.ok(await eventually(() => fake.open() === 0, CLOSE_MS), `${fake.open()} connection(s) still open`);
    } finally { await fake.close(); }
  });
}

test('email smtp starttls: a slow greeting and a STARTTLS handshake that never finishes share one setup bound, which fails the send before the deadline', async () => {
  // Each wait alone is inside the bound; together they are past it. The deadline is well past both.
  const fake = await smtpFake(pem, { mode: 'starttls', greetAfterMs: SETUP_MS * 0.8, stallStartTls: true });
  try {
    const mailer = await createMailer(smtpConfig(fake.port), { fetch: (...a) => fetch(...a), timeoutMs: SETUP_MS, deadlineMs: SETUP_MS * 4, tls: { secure: false, ca: pem.cert } });
    const started = Date.now();
    const r = await within(mailer.send(MESSAGE), HUNG_MS);
    const took = Date.now() - started;
    assert.equal(r.hung, false, `the send was still waiting after ${HUNG_MS} ms`);
    assert.equal(!r.hung && (r.error as { code?: unknown }).code, 'ETIMEDOUT');
    assert.ok(took >= SETUP_MS && took < SETUP_MS + DEADLINE_SLACK_MS, `failed after ${took} ms, the setup bound is ${SETUP_MS} ms`);
    assert.equal(fake.messages.length, 0);
    assert.ok(!fake.commands.some((c) => /^(AUTH|MAIL|RCPT|DATA)/i.test(c)), `nothing past STARTTLS in the clear: ${JSON.stringify(fake.commands)}`);
    assert.ok(await eventually(() => fake.open() === 0, CLOSE_MS), `${fake.open()} connection(s) still open`);
  } finally { await fake.close(); }
});

test('email smtp starttls: CONTROL: a server that offers no STARTTLS fails the send — never sent in the clear', async () => {
  const fake = await smtpFake(pem, { mode: 'starttls', offerStartTls: false });
  try {
    const mailer = await createMailer(smtpConfig(fake.port), { fetch: (...a) => fetch(...a), deadlineMs: HUNG_MS - 1_000, tls: { secure: false, ca: pem.cert } });
    const r = await within(mailer.send(MESSAGE), HUNG_MS);
    assert.equal(r.hung, false);
    assert.ok(!r.hung && r.error instanceof Error, 'the send failed');
    assert.equal(fake.messages.length, 0);
    assert.ok(!fake.commands.some((c) => /^(AUTH|MAIL|RCPT|DATA)/i.test(c)), `nothing past EHLO in the clear: ${JSON.stringify(fake.commands)}`);
    assert.ok(await eventually(() => fake.open() === 0, CLOSE_MS), `${fake.open()} connection(s) still open`);
  } finally { await fake.close(); }
});
