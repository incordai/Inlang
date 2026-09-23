/**
 * Every part of every word has a ≤60-character description — the owner's
 * rule, so `az explain` and AI tools can say what any term means cheaply.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const MAX = 60;
/** Brand names a description must never carry (user rule 5). */
const VENDOR = /supabase|firebase|clerk|auth0|okta|vercel|netlify|stripe|google|github|facebook|apple|microsoft|amazon|aws|sendgrid|mailgun|twilio/i;

type Props = Record<string, { type: string; values?: unknown; description?: string; valueDescriptions?: Record<string, string> }>;
type Slot = { description?: string; props?: Props; slots?: Record<string, Slot> };

/** [path, text | undefined] for every describable entry of a manifest. */
function entries(m: any): [string, string | undefined][] {
  const out: [string, string | undefined][] = [[m.name, m.description]];
  for (const v of m.variants ?? []) out.push([`${m.name} variant ${v}`, m.descriptions?.variants?.[v]]);
  for (const v of m.modifiers ?? []) out.push([`${m.name} modifier ${v}`, m.descriptions?.modifiers?.[v]]);
  for (const v of m.children ?? []) out.push([`${m.name} child ${v}`, m.descriptions?.children?.[v]]);
  const props = (base: string, ps: Props | undefined) => {
    for (const [k, p] of Object.entries(ps ?? {})) {
      out.push([`${base} prop ${k}`, p.description]);
      if ((p.type === 'enum' || p.type === 'list') && Array.isArray(p.values)) {
        for (const v of p.values as string[]) out.push([`${base} ${k} value ${v}`, p.valueDescriptions?.[v]]);
      }
    }
  };
  const slots = (base: string, ss: Record<string, Slot> | undefined) => {
    for (const [k, s] of Object.entries(ss ?? {})) {
      out.push([`${base} slot ${k}`, s.description]);
      props(`${base} ${k}`, s.props);
      slots(`${base} ${k}`, s.slots);
    }
  };
  props(m.name, m.props);
  slots(m.name, m.slots);
  return out;
}

const words = readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')));

test('CONTROL: the walk finds every kind of entry', () => {
  const all = words.flatMap((w) => entries(JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8'))));
  assert.ok(all.length >= 200, `only ${all.length} entries found`);
  for (const kind of [' variant ', ' modifier ', ' prop ', ' slot ', ' value ', ' child ']) {
    assert.ok(all.some(([p]) => p.includes(kind)), `no ${kind.trim()} entries walked`);
  }
});

for (const w of words) {
  test(`${w}: every term has a description of at most ${MAX} characters`, () => {
    const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8'));
    for (const [path, text] of entries(m)) {
      assert.ok(typeof text === 'string' && text.trim().length > 0, `${path}: no description`);
      assert.ok(text.length <= MAX, `${path}: ${text.length} characters — '${text}'`);
      assert.ok(!text.endsWith('.'), `${path}: no trailing period`);
      assert.ok(!VENDOR.test(text), `${path}: names a vendor`);
    }
  });
}
