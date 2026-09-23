/**
 * Findings of the auth security review on the browser side: an open
 * redirect through dot segments in `next`, sign-out that forgot the session
 * locally when the server never ended it, and an address check looser than
 * the backend's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext, validate } from '../src/runtime/contract.ts';
import { createSessionAdapter } from '../src/runtime/session.ts';

const ORIGIN = 'https://site.example';

test('SECURITY next: dot segments and encoded dots cannot turn a path into //host', () => {
  for (const bad of ['/.//evil.example', '/..//evil.example', '/%2e//evil.example', '/%2E%2E//evil.example', '/a/..//evil.example']) {
    assert.equal(safeNext(bad, ORIGIN), null, bad);
  }
  assert.equal(safeNext('/account?tab=1#top', ORIGIN), '/account?tab=1#top', 'CONTROL: an ordinary path passes');
  assert.equal(safeNext('/a/b', ORIGIN), '/a/b');
});

const answering = (status: number) => ({
  fetch: (async (url: string) => {
    if (url.endsWith('/session')) return new Response(JSON.stringify({ session: { user: { id: 'u1', email: 'a@b.example' } } }), { status: 200 });
    return new Response(status === 204 ? null : JSON.stringify({ error: 'unknown' }), { status });
  }) as typeof fetch,
});

test('SECURITY sign-out: when the server did not end the session, the page does not pretend it did', async () => {
  const a = createSessionAdapter({ base: '/api/auth' }, answering(500));
  await a.ready?.();
  await assert.rejects(a.signOut(), 'sign-out reports the failure');
  assert.ok(a.session(), 'still signed in locally, as it still is on the server');
});

test('CONTROL sign-out: a confirmed sign-out forgets the session', async () => {
  const a = createSessionAdapter({ base: '/api/auth' }, answering(204));
  await a.ready?.();
  await a.signOut();
  assert.equal(a.session(), null);
});

test('SECURITY addresses: the form refuses what the backend would refuse', () => {
  const bad = (email: string) => validate({ email }, {}).some((e) => e.field === 'email');
  for (const b of ['x<victim@corp.example>', 'a,b@corp.example', '"q"@corp.example', 'a@b', 'a@b..example']) assert.ok(bad(b), b);
  for (const g of ['ada@studio.test', 'first.last+tag@sub.example.org']) assert.ok(!bad(g), `CONTROL ${g}`);
});
