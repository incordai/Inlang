/**
 * The data schema lock on disk (data-spec §6.1–§6.2): a build reads it and
 * never writes it; `az backend plan` writes nothing; `az backend schema`
 * appends one step and refuses destructive changes without their flag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const env = { ...process.env, AZ_WORDS: WORDS, AZ_PUBLIC_BACKEND_URL: 'http://127.0.0.1:8787' };
const az = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv, BIN, ...args], { encoding: 'utf8', env });

const SITE = (data: string) => `az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n${data}page /\n  hero center\n    title "Hi"\n`;
const NOTES = '  data notes\n    title text required\n    body longtext\n    allow anyone read\n';

function project(data: string) {
  const dir = mkdtempSync(join(tmpdir(), 'az-data-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, SITE(data), 'utf8');
  return { dir, file, lock: join(dir, 'site.data.json'), out: join(dir, 'out') };
}

test('a data site with no lock fails the build with AZ1701 and writes nothing', () => {
  const p = project(NOTES);
  for (const cmd of ['build', 'check', 'spec']) {
    const r = az(cmd, p.file, '--out', p.out);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /AZ1701 {2}data: the file and site\.data\.json differ — run: az backend plan site\.az, then az backend schema site\.az/);
  }
  assert.ok(!existsSync(p.out) && !existsSync(p.lock), 'nothing written, lock included');
});

test('plan prints the step and writes nothing; schema records it; the build then passes and never touches it', () => {
  const p = project(NOTES);
  const planned = az('backend', 'plan', p.file);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /step 1 would:\n {2}safe {9}create table notes \(2 fields\)/);
  assert.ok(!existsSync(p.lock));

  const recorded = az('backend', 'schema', p.file);
  assert.equal(recorded.status, 0, recorded.stderr);
  const lock = readFileSync(p.lock, 'utf8');
  assert.match(lock, /^\{\n {2}"format": 1,\n {2}"steps": \[/);
  assert.match(lock, /"digest": "[0-9a-f]{64}"\n\}\n$/);

  const built = az('build', p.file, '--out', p.out);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(readFileSync(p.lock, 'utf8'), lock, 'a build never writes the lock');
  assert.ok(!readdirSync(p.dir).some((f) => f.endsWith('.tmp')), 'no temporary file left');

  const again = az('backend', 'schema', p.file);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /matches the file — nothing to record/);
  assert.equal(readFileSync(p.lock, 'utf8'), lock);
});

test('a destructive change is refused until its flag names it; then it is step 2', () => {
  const p = project(NOTES);
  assert.equal(az('backend', 'schema', p.file).status, 0);
  const before = readFileSync(p.lock, 'utf8');
  writeFileSync(p.file, SITE(NOTES.replace('    body longtext\n', '')), 'utf8');

  const build = az('build', p.file, '--out', p.out);
  assert.equal(build.status, 1);
  assert.match(build.stderr, /AZ1701/);

  const plan = az('backend', 'plan', p.file);
  assert.equal(plan.status, 1);
  assert.match(plan.stderr, /AZ1702 {2}data: dropping notes\.body loses its data — add --drop notes\.body to az backend schema/);

  const refused = az('backend', 'schema', p.file);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /nothing written/);
  assert.equal(readFileSync(p.lock, 'utf8'), before);

  const ok = az('backend', 'schema', p.file, '--drop', 'notes.body');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /recorded step 2 in site\.data\.json:\n {2}destructive {2}drop notes\.body and its values/);
  assert.equal(az('build', p.file, '--out', p.out).status, 0);
});

test('a hand-edited lock is AZ1706 for build and for schema', () => {
  const p = project(NOTES);
  assert.equal(az('backend', 'schema', p.file).status, 0);
  writeFileSync(p.lock, readFileSync(p.lock, 'utf8').replace('"required": true', '"required": false'), 'utf8');
  const build = az('build', p.file, '--out', p.out);
  assert.equal(build.status, 1);
  assert.match(build.stderr, /AZ1706 {2}data: site\.data\.json is edited by hand or damaged \(the digest does not match the steps\)/);
  const schema = az('backend', 'schema', p.file);
  assert.equal(schema.status, 1);
  assert.match(schema.stderr, /AZ1706/);
});

test('bad options are usage errors (exit 2); a missing file is exit 1', () => {
  const p = project(NOTES);
  assert.equal(az('backend', 'schema', p.file, '--force').status, 2);
  assert.equal(az('backend', 'schema', p.file, '--drop').status, 2);
  assert.equal(az('backend', 'schema', p.file, '--drop', 'notes.nope').status, 2);
  assert.ok(!existsSync(p.lock));
  assert.equal(az('backend', 'plan', join(p.dir, 'missing.az')).status, 1);
});

test('CONTROL: a site without data needs no lock, and a stray lock beside it is AZ1701', () => {
  const p = project('');
  assert.equal(az('build', p.file, '--out', p.out).status, 0);
  assert.ok(!existsSync(p.lock));
  const withData = project(NOTES);
  assert.equal(az('backend', 'schema', withData.file).status, 0);
  writeFileSync(p.lock, readFileSync(withData.lock, 'utf8'), 'utf8');
  const r = az('build', p.file, '--out', p.out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AZ1701/);
});

test('a read rule that shows stored rows to more people: build AZ1701, plan and schema AZ1708 until --expose names the table', () => {
  const OWN = '  data notes\n    title text required\n    allow owner read\n    allow signedin create\n';
  const p = project(OWN);
  assert.equal(az('backend', 'schema', p.file).status, 0);
  const before = readFileSync(p.lock, 'utf8');
  writeFileSync(p.file, SITE(OWN.replace('allow owner read', 'allow anyone read')), 'utf8');

  const build = az('build', p.file, '--out', p.out);
  assert.equal(build.status, 1);
  assert.match(build.stderr, /AZ1701/);

  const plan = az('backend', 'plan', p.file);
  assert.equal(plan.status, 1);
  assert.match(plan.stderr, /AZ1708 {2}data: notes becomes readable by anyone \(it was its owner\) — rows stored under the old rules would show; add --expose notes to az backend schema/);

  const refused = az('backend', 'schema', p.file);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /nothing written/);
  assert.equal(readFileSync(p.lock, 'utf8'), before);
  assert.equal(az('backend', 'schema', p.file, '--expose').status, 2, '--expose needs a table');
  assert.equal(az('backend', 'schema', p.file, '--expose', 'nope').status, 2, 'a table that widens nothing is a usage error');
  assert.equal(readFileSync(p.lock, 'utf8'), before);

  const ok = az('backend', 'schema', p.file, '--expose', 'notes');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /recorded step 2 in site\.data\.json:\n {2}exposes {6}notes becomes readable by anyone \(it was its owner\) — rows stored under the old rules now show/);
  assert.equal(az('build', p.file, '--out', p.out).status, 0);

  // CONTROL: narrowing back is a safe step, no flag.
  writeFileSync(p.file, SITE(OWN), 'utf8');
  const back = az('backend', 'schema', p.file);
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, /recorded step 3 in site\.data\.json:\n {2}safe {9}notes is now shown to its owner/);
});
