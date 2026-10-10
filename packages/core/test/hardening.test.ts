/**
 * Compiler hardening — findings from the independent core review, each with
 * the input that broke it and a control that must keep working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, intentOf, lex, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const run = (src: string) => compile(src, { manifests });
const codes = (src: string) => run(src).diagnostics.map((d) => d.code);
const site = (body: string) => `az 1\nsite aurora\npage /\n${body}`;

/* ---- author words that name Object.prototype members -------------------- */

test('`constructor` as a backend setting is a diagnostic, not a crash', () => {
  const src = 'az 1\nsite x\n  auth\n    adapter azbackend\n  backend\n    constructor sqlite\npage /\n';
  assert.doesNotThrow(() => run(src));
  assert.ok(codes(src).includes('AZ1224'));
});

test('`constructor` as a value keyed by requiresWhen is a diagnostic, not a crash', () => {
  const src = 'az 1\nsite x\n  auth\n    adapter constructor\npage /\n';
  assert.doesNotThrow(() => run(src));
  assert.ok(run(src).diagnostics.some((d) => d.severity === 'error'));
});

test('a `constructor:` scheme has no intent', () => {
  assert.equal(intentOf({ kind: 'pair', value: 'constructor:x' }), null);
  assert.equal(intentOf({ kind: 'pair', value: 'tel:+1' }), 'call', 'CONTROL: a listed scheme still maps');
});

/* ---- AZ1404: destinations use only the listed schemes ------------------- */

const cta = (dest: string) => site(`  hero center\n    title "t"\n    cta "x" ${dest}\n`);

for (const dest of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'ftp://host/f', 'mailt:a@b.c']) {
  test(`AZ1404: a bare '${dest}' destination is refused`, () => {
    assert.ok(codes(cta(dest)).includes('AZ1404'));
  });
}

for (const dest of ['"javascript:alert(1)"', '" JavaScript:alert(1)"', '"java\tscript:x"', '"data:text/html,x"']) {
  test(`AZ1404: a quoted ${dest} destination is refused`, () => {
    assert.ok(codes(cta(dest)).includes('AZ1404'));
  });
}

for (const dest of ['/work', '#pricing', 'tel:+50412345678', 'mailto:hi@example.test', 'https://example.test/x',
  'copy:AZ-2026', '"https://example.test/x"']) {
  test(`CONTROL: ${dest} is a supported destination`, () => {
    const src = cta(dest) + (dest === '/work' ? 'page /work\n' : '');
    assert.ok(!codes(src).includes('AZ1404'), codes(src).join(' '));
  });
}

test('CONTROL: text in a second argument that is not a script URL is left alone', () => {
  assert.ok(!codes(cta('"Note: open daily"')).includes('AZ1404'));
});

/* ---- lexer conformance with GRAMMAR §1–§2 --------------------------------- */

test('§1.2: a leading BOM is stripped', () => {
  assert.deepEqual(run('﻿az 1\nsite aurora\npage /\n').diagnostics, []);
});

test('§1.2: trailing tabs are stripped, and a tab after a word separates tokens', () => {
  assert.deepEqual(run('az 1\nsite aurora\t\npage /\n  hero\tcenter\n    title "t"\t\n').diagnostics, []);
});

/*
 * Input size is the author's, so the compiler's time must grow with it, not
 * with its square. 40 000 characters took over two seconds through the
 * trailing-blank and trailing-slash patterns these replaced; the linear scans
 * take milliseconds, so a one-second budget fails only the old shape.
 */
const LONG_RUN = 80_000;
const LINEAR_BUDGET_MS = 1_000;
const timed = <T>(f: () => T): { result: T; ms: number } => {
  const start = performance.now();
  const result = f();
  return { result, ms: performance.now() - start };
};

test('§1.2: a long run of tabs inside a line is lexed in linear time', () => {
  const { result, ms } = timed(() => lex(`az 1\nsite aurora\npage /\n  hero center\n    title "t"${'\t'.repeat(LONG_RUN)}x\n`));
  assert.ok(ms < LINEAR_BUDGET_MS, `${ms.toFixed(0)}ms`);
  assert.ok(result.tokens.some((t) => t.value === 'x'), 'CONTROL: the word after the tabs is still a token');
});

test('AZ1413: a route with a long run of slashes before its last is reported in linear time', () => {
  const route = `/a${'/'.repeat(LONG_RUN)}b/`;
  const { result, ms } = timed(() => run(`az 1\nsite aurora\npage ${route}\n`));
  assert.ok(ms < LINEAR_BUDGET_MS, `${ms.toFixed(0)}ms`);
  const d = result.diagnostics.find((x) => x.code === 'AZ1413');
  assert.ok(d?.message.endsWith(`write: page ${route.slice(0, -1)}`), 'CONTROL: the fix it suggests drops only the trailing slash');
});

test('CONTROL AZ1413: every trailing slash is dropped from the suggestion', () => {
  const d = run('az 1\nsite aurora\npage /\npage /work///\n').diagnostics.find((x) => x.code === 'AZ1413');
  assert.equal(d?.message, "page: '/work///' ends with '/' — write: page /work");
});

test('§1.1 AZ1022: a control byte is refused', () => {
  assert.ok(codes('az 1\nsite aurora\npage /\n  hero center\n    title "a\u000bb"\n').includes('AZ1022'));
});

test('§1.1 AZ1023: an empty file says so', () => {
  assert.deepEqual(codes(''), ['AZ1023']);
  assert.deepEqual(codes('# only a comment\n\n'), ['AZ1023']);
});

test('§1.1 AZ1024: non-ASCII outside a string is refused; inside a string it is copy', () => {
  assert.ok(codes('az 1\nsite café\npage /\n').includes('AZ1024'));
  assert.ok(!codes(site('  hero center\n    title "Café"\n')).includes('AZ1024'), 'CONTROL');
});

test('§2.5 AZ1005 is the depth limit (AZ1004 is the unreachable dedent case)', () => {
  const deep = 'az 1\nsite a\n  nav bar\n    group "g"\n      link "l" /\n        x y\n          z w\npage /\n';
  assert.ok(lex(deep).diagnostics.some((d) => d.code === 'AZ1005'));
  assert.ok(!lex(deep).diagnostics.some((d) => d.code === 'AZ1004'));
});

/* ---- parser ---------------------------------------------------------------- */

test('a refused word does not leave a phantom "\'\' is not a word"', () => {
  const ds = run('az 1\nsite aurora\n  Nav\npage /\n').diagnostics;
  assert.ok(ds.some((d) => d.code === 'AZ1008'));
  assert.ok(!ds.some((d) => d.code === 'AZ1104'), ds.map((d) => `${d.code} ${d.message}`).join('\n'));
});

test('§7.3: version errors are fatal and use AZ1020/AZ1021', () => {
  assert.deepEqual(codes('site aurora\npage /\n'), ['AZ1020']);
  assert.deepEqual(codes('az 2\nsite aurora\npage /\n'), ['AZ1021']);
  assert.deepEqual(codes('az\nsite aurora\npage /\n'), ['AZ1020']);
});

test('§7.2 rule 6: reporting stops at 100 with AZ1099', () => {
  const src = 'az 1\nsite a\npage /\n' + '  Bad\n'.repeat(150);
  const ds = run(src).diagnostics;
  assert.equal(ds.length, 101);
  assert.equal(ds[100].code, 'AZ1099');
});

/* ---- routes ---------------------------------------------------------------- */

for (const [route, why] of [['/about/', 'trailing slash'], ['"/a b"', 'space'], ['"about"', 'no leading slash'],
  ['"/café"', 'non-ASCII']] as const) {
  test(`AZ1413: page ${route} (${why}) can never be served, so it is refused`, () => {
    assert.ok(codes(`az 1\nsite aurora\npage /\npage ${route}\n`).includes('AZ1413'));
  });
}

test('AZ1509: two pages on one route', () => {
  assert.ok(codes('az 1\nsite aurora\npage /\npage /\n').includes('AZ1509'));
});

test('AZ1509: two routes that differ only in case are one folder on a case-insensitive disk (review #10)', () => {
  const r = compile('az 1\nsite aurora\npage /\npage /about\npage /About\n', { manifests: new Map() });
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'AZ1509').map((d) => d.message),
    ["page: '/About' and '/about' differ only in case — rename one"]);
  assert.ok(!codes('az 1\nsite aurora\npage /\npage /about\npage /aboutus\n').includes('AZ1509'), 'CONTROL: different routes');
});

test('AZ1508: a second site', () => {
  assert.ok(codes('az 1\nsite aurora\nsite other\npage /\n').includes('AZ1508'));
});

test('CONTROL: ordinary routes compile clean', () => {
  assert.deepEqual(codes('az 1\nsite aurora\npage /\npage /work\npage /signup/studio\npage /v1.2_x~y\n'), []);
});

/* ---- diagnostics never repeat a secret-looking value --------------------- */

test('a credential-shaped value is not echoed in a diagnostic', () => {
  const key = 'sk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
  const src = `az 1\nsite x\n  auth\n    adapter azbackend\n  backend\n    database ${key}\n    email smtp\npage /\n`;
  const text = run(src).diagnostics.map((d) => d.message).join('\n');
  assert.ok(!text.includes(key), text);
});
