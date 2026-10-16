/**
 * The files directory's leases (data-lease.ts, data-spec §8): one holder at
 * a time among many contenders, in one process and across two; a dead
 * holder's lease is taken over; every wait is bounded; a released lease
 * leaves nothing behind. Then the image pipeline under them: an upload waits
 * for another process's encode, is refused past its wait as the queue
 * refuses, and is not starved by a long backfill.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { LeaseBusy, takeLease, type LeaseTiming } from '../src/server/data-lease.ts';
import { createImages, ImageError, IMAGE_LEASES, type Images } from '../src/server/data-images.ts';
import { plainJpeg, plainWebp } from './image-fixtures.ts';

/** Fast leases for tests: the same rules at a smaller scale. */
const FAST: LeaseTiming = { waitMs: 10_000, staleMs: 1_000, heartbeatMs: 100, pollMs: 5 };
/** How long another process holds the lease in the cross-process tests. */
const HOLD_MS = 600;
/** A child that has not said it holds the lease by now is broken. */
const CHILD_MS = 10_000;

const freshDir = () => mkdtempSync(join(tmpdir(), 'az-lease-'));

/** Runs `contenders` × `rounds` jobs under one lease name; the most that ever held it at once. */
async function contend(dir: string, contenders: number, rounds: number, timing: LeaseTiming) {
  let active = 0;
  let most = 0;
  let done = 0;
  await Promise.all(Array.from({ length: contenders }, async () => {
    for (let r = 0; r < rounds; r++) {
      const lease = await takeLease(dir, 'encode', timing);
      active++;
      most = Math.max(most, active);
      await sleep(3);
      active--;
      done++;
      await lease.release();
    }
  }));
  return { most, done };
}

test('one holder at a time: eight contenders, five rounds each, never two at once; nothing left behind', async () => {
  const dir = freshDir();
  const r = await contend(dir, 8, 5, FAST);
  assert.deepEqual(r, { most: 1, done: 40 });
  assert.deepEqual(readdirSync(dir), [], 'every lease file is removed on release');
});

test('two lease names do not exclude each other', async () => {
  const dir = freshDir();
  const a = await takeLease(dir, 'encode', FAST);
  const b = await takeLease(dir, 'backfill', { ...FAST, waitMs: 0 });
  await Promise.all([a.release(), b.release()]);
  assert.deepEqual(readdirSync(dir), []);
});

/** A child process holding the lease `name` on `dir` for HOLD_MS; resolves once it holds it. */
async function holdInChild(dir: string, name: string) {
  const lease = fileURLToPath(new URL('../src/server/data-lease.ts', import.meta.url));
  const script = `import { takeLease } from ${JSON.stringify(lease)};
const l = await takeLease(${JSON.stringify(dir)}, ${JSON.stringify(name)}, ${JSON.stringify(FAST)});
process.stdout.write('held\\n');
await new Promise((r) => setTimeout(r, ${HOLD_MS}));
await l.release();
process.stdout.write('released\\n');`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_MS);
  let released = 0;
  const said: string[] = [];
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => { clearTimeout(timer); done(code); }));
  await new Promise<void>((held, failed) => {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        said.push(line);
        if (line === 'held') held();
        if (line === 'released') released = Date.now();
      }
    });
    child.on('exit', () => failed(new Error(`the child ended before it held the lease: ${said.join(',')}`)));
  });
  return { releasedAt: () => released, exited };
}

test('across processes: a lease another process holds is waited for, and taken once it is released', async () => {
  const dir = freshDir();
  const other = await holdInChild(dir, 'encode');
  const asked = Date.now();
  const lease = await takeLease(dir, 'encode', FAST);
  const took = Date.now();
  await lease.release();
  assert.equal(await other.exited, 0);
  assert.ok(other.releasedAt() > 0 && took >= other.releasedAt() - 50, `taken at ${took - asked} ms, released by the other at ${other.releasedAt() - asked} ms`);
  assert.ok(took - asked >= HOLD_MS - 200, `waited ${took - asked} ms for a ${HOLD_MS} ms hold`);
});

test('a dead holder\'s lease (not refreshed for staleMs) is taken over at once, and its file removed', async () => {
  const dir = freshDir();
  const dead = join(dir, 'encode.0123456789abcdef01234567');
  writeFileSync(dead, '');
  const old = new Date(Date.now() - FAST.staleMs - 1_000);
  utimesSync(dead, old, old);
  const asked = Date.now();
  const lease = await takeLease(dir, 'encode', FAST);
  assert.ok(Date.now() - asked < 500, `took ${Date.now() - asked} ms`);
  assert.equal(readdirSync(dir).includes('encode.0123456789abcdef01234567'), false);
  await lease.release();
});

test('a held lease stays fresh past staleMs: its holder refreshes it, so nobody takes it over', async () => {
  const dir = freshDir();
  const held = await takeLease(dir, 'encode', FAST);
  await sleep(FAST.staleMs + 300);
  await assert.rejects(takeLease(dir, 'encode', { ...FAST, waitMs: 0 }), LeaseBusy);
  await held.release();
  const after = await takeLease(dir, 'encode', { ...FAST, waitMs: 0 });
  await after.release();
});

test('every wait is bounded: past waitMs the contender gets LeaseBusy; waitMs 0 tries once', async () => {
  const dir = freshDir();
  const held = await takeLease(dir, 'encode', FAST);
  try {
    const started = Date.now();
    await assert.rejects(takeLease(dir, 'encode', { ...FAST, waitMs: 200 }), LeaseBusy);
    const waited = Date.now() - started;
    assert.ok(waited >= 200 && waited < 700, `gave up after ${waited} ms`);
    const once = Date.now();
    await assert.rejects(takeLease(dir, 'encode', { ...FAST, waitMs: 0 }), LeaseBusy);
    assert.ok(Date.now() - once < 200, 'waitMs 0 does not wait');
  } finally {
    await held.release();
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('a lease name is a fixed word, never a path', async () => {
  const dir = freshDir();
  for (const bad of ['../x', 'a/b', '', 'Encode', 'x.y']) await assert.rejects(takeLease(dir, bad, FAST), /not a lease name/, bad);
});

/* ---- the image pipeline under the leases ------------------------------- */

const imagesIn = (dir: string, encode: Partial<LeaseTiming> = {}): Promise<Images> =>
  createImages({ dir, leases: { encode: { ...FAST, ...encode }, backfill: { ...FAST, waitMs: 0 } } });

async function store(images: Images, bytes: Buffer) {
  const temp = images.tempPath();
  writeFileSync(temp, bytes);
  return images.store(temp);
}

test('the production leases: an encode waits up to 30 s, a backfill never waits for another; both refreshed well inside staleness', () => {
  assert.equal(IMAGE_LEASES.encode.waitMs, 30_000);
  assert.equal(IMAGE_LEASES.backfill.waitMs, 0);
  for (const l of [IMAGE_LEASES.encode, IMAGE_LEASES.backfill]) assert.ok(l.heartbeatMs * 3 <= l.staleMs, JSON.stringify(l));
});

test('a live server\'s upload waits while another process (a backfill) encodes on the same files, then is stored', async () => {
  const dir = freshDir();
  const images = await imagesIn(dir);
  const bytes = await plainJpeg(640, 480);
  // CONTROL: with nobody else encoding, it is quick.
  const quick = Date.now();
  await store(images, bytes);
  const alone = Date.now() - quick;
  assert.ok(alone < HOLD_MS / 2, `alone it took ${alone} ms`);
  const other = await holdInChild(join(dir, '.leases'), 'encode');
  const asked = Date.now();
  const s = await store(images, bytes);
  const took = Date.now() - asked;
  assert.equal(await other.exited, 0);
  assert.match(s.key, /\.full\.webp$/);
  assert.ok(took >= HOLD_MS - 200, `stored after ${took} ms, while the other process encoded for ${HOLD_MS} ms`);
});

test('an upload that cannot take the encoder within its wait is refused as rate_limited, its temporary removed', async () => {
  const dir = freshDir();
  const images = await imagesIn(dir, { waitMs: 150 });
  const held = await takeLease(join(dir, '.leases'), 'encode', FAST);
  try {
    await assert.rejects(store(images, await plainJpeg(64, 64)), (e: unknown) => e instanceof ImageError && e.code === 'rate_limited');
    assert.deepEqual(readdirSync(join(dir, '.tmp')), []);
  } finally {
    await held.release();
  }
  assert.match((await store(images, await plainJpeg(64, 64))).key, /\.full\.webp$/, 'CONTROL: once free, the same upload is stored');
});

test('a live server beside a long backfill on the same files: its uploads take turns between the backfill\'s images, never starved', async () => {
  const dir = freshDir();
  const [server, backfill] = [await imagesIn(dir), await imagesIn(dir)];
  const legacy = await Promise.all(Array.from({ length: 4 }, async () => {
    const key = `${randomUUID()}.webp`;
    writeFileSync(join(dir, key), await plainWebp(1600, 1000));
    return key;
  }));
  const order: string[] = [];
  const widening = (async () => {
    for (const k of legacy) { await backfill.addWidths(k); order.push('widened'); }
  })();
  await sleep(20);
  const uploads = (async () => {
    for (let i = 0; i < 3; i++) { await store(server, await plainJpeg(1200, 800)); order.push('uploaded'); }
  })();
  await Promise.all([widening, uploads]);
  assert.deepEqual(readdirSync(join(dir, '.leases')), [], 'no lease left');
  // The uploads were let in between the backfill's images: the last upload ends before the last image.
  assert.ok(order.lastIndexOf('uploaded') < order.lastIndexOf('widened'), order.join(','));
  assert.equal(order.filter((o) => o === 'uploaded').length, 3);
});
