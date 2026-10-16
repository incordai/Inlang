/**
 * The score thresholds `pnpm test:lighthouse --fail-under` enforces.
 *
 * ROADMAP M5's exit (ASSUMPTIONS A6), as Lighthouse scores 0–100: perf ≥ 85
 * on mobile, a11y 100, SEO ≥ 95 — and best practices 100, which every site
 * here has scored since the 2026-10-07 fixes, so a regression is caught.
 *
 * Performance moves with the machine's load, so it is judged on the median
 * of a site's runs. Accessibility, best practices and SEO do not — the same
 * page gets the same audits — so a run below target is a real finding, and
 * they are judged on every run, never forgiven by a better one.
 */

/** The M5 targets, by Lighthouse category id. */
export const M5_TARGETS = Object.freeze({ performance: 85, accessibility: 100, 'best-practices': 100, seo: 95 });

/** The short names the report prints, and `--fail-under` accepts. */
export const SHORT = Object.freeze({ performance: 'perf', accessibility: 'a11y', 'best-practices': 'bp', seo: 'seo' });

const BY_SHORT = new Map(Object.entries(SHORT).map(([id, short]) => [short, id]));

/**
 * The thresholds `--fail-under <value>` names: `m5` for the M5 targets, or
 * a comma-separated list of `<category>=<score>` (perf, a11y, bp, seo; a
 * whole number 0–100), each category once — only those are enforced.
 * Throws a message naming the mistake.
 */
export function parseFailUnder(value) {
  if (value === 'm5') return { ...M5_TARGETS };
  const targets = {};
  for (const part of value.split(',')) {
    const m = /^([a-z0-9]+)=(\d{1,3})$/.exec(part.trim());
    if (!m) throw new Error(`lighthouse: --fail-under takes m5 or <category>=<score>[,…] — '${part}' is neither`);
    const id = BY_SHORT.get(m[1]);
    if (!id) throw new Error(`lighthouse: --fail-under: no category '${m[1]}' — categories: ${[...BY_SHORT.keys()].join(', ')}`);
    const score = Number(m[2]);
    if (score > 100) throw new Error(`lighthouse: --fail-under: ${m[1]}=${score} — a score is 0–100`);
    if (id in targets) throw new Error(`lighthouse: --fail-under: ${m[1]} given twice — keep one`);
    targets[id] = score;
  }
  return targets;
}

/**
 * Every score in `results` below `targets`: `{ site, category, score, target, run }`,
 * where `run` is null for perf (the median) and the 1-based run otherwise.
 * A result is `{ name, scores, runs: [scores…] }` (`scores` the median-perf
 * run's); one with `error` is not audited and is failed by the caller. A
 * targeted category with no score (Lighthouse's n/a) is below target: an
 * unmeasured score is not a passing one.
 */
export function belowTargets(results, targets) {
  const below = [];
  for (const r of results) {
    if (r.error) continue;
    for (const [category, target] of Object.entries(targets)) {
      if (category === 'performance') {
        const score = r.scores.performance;
        if (score === null || score < target) below.push({ site: r.name, category, score, target, run: null });
        continue;
      }
      r.runs.forEach((run, i) => {
        const score = run[category];
        if (score === null || score < target) below.push({ site: r.name, category, score, target, run: i + 1 });
      });
    }
  }
  return below;
}
