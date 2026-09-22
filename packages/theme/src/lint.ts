/**
 * The theme lint — CONVENTIONS §4, "the theme rule — hard".
 *
 * Tests ASSUMPTION A7: that theme compliance is mechanically enforceable by
 * static analysis of word source. If it is not, the fallback is a runtime
 * token-only API — and explicitly NOT code review, which A7 says will not hold.
 *
 * The rationale is worth restating because it is what makes this
 * non-negotiable per-word: ten contributors picking their own blues produces a
 * ransom note. This rule is the only thing preventing that.
 */

export interface LintFinding {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly rule: string;
  readonly message: string;
}

/** Legal spacing values — PRD §7.3. Anything else in px is off-scale. */
const SPACE_SCALE = new Set([0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128]);

interface Rule {
  readonly name: string;
  /** Global-flagged; each match is reported. */
  readonly pattern: RegExp;
  /** Return null to accept a match — used where a value may be legal. */
  readonly message: (match: RegExpExecArray) => string | null;
}

const RULES: Rule[] = [
  {
    name: 'no-hex',
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    message: (m) =>
      `'${m[0]}' is a raw colour — use a theme token, e.g. ctx.theme.color.accent`,
  },
  {
    name: 'no-colour-function',
    // `color-mix` is allowed: it composes tokens rather than naming a colour.
    pattern: /\b(?:rgba?|hsla?|oklch|oklab)\s*\(/g,
    message: (m) =>
      `'${m[0].trim()}' is a raw colour — use a theme token`,
  },
  {
    name: 'no-off-scale-px',
    pattern: /\b(\d+)px\b/g,
    message: (m) => {
      const n = Number(m[1]);
      // 1px is the hairline, and 0 is not a measurement.
      if (n === 1 || SPACE_SCALE.has(n)) return null;
      return `'${m[0]}' is off the space scale — use ctx.theme.space[…] (${[...SPACE_SCALE].join(', ')})`;
    },
  },
  {
    name: 'no-font-family',
    // Only a LITERAL family is a violation. `fontFamily: t.type.display` is
    // the correct form, and banning the property outright failed every real
    // emitter — the "linter that rejects everything" failure the A7 control
    // exists to catch. Match the property followed by a quoted value.
    pattern: /(?:font-family|fontFamily)\s*:\s*['"]/g,
    message: () =>
      'a literal font family is a theme decision — use ctx.theme.type.body or type.display',
  },
  {
    name: 'no-raw-z-index',
    pattern: /z-?[iI]ndex\s*:\s*(-?\d+)/g,
    message: (m) =>
      `'z-index: ${m[1]}' is a raw stacking value — use ctx.theme.layer.…`,
  },
];

/** Lines that are comments or token references, which the rules must not flag. */
function isExempt(line: string): boolean {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return true;
  // A line that only READS a token is the correct form, not a violation.
  return /ctx\.theme\./.test(t) && !/#[0-9a-fA-F]{3,8}\b/.test(t);
}

/**
 * Lint one source file.
 *
 * Text-based rather than AST-based on purpose: a word's source may be TSX,
 * CSS-in-JS or a template literal, and the values this rule bans are
 * recognisable in all three without parsing any of them.
 */
export function lintSource(file: string, source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((line, i) => {
    if (isExempt(line)) return;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(line)) !== null) {
        const message = rule.message(m);
        if (message === null) continue;
        findings.push({
          file,
          line: i + 1,
          col: m.index + 1,
          rule: rule.name,
          message,
        });
      }
    }
  });

  return findings;
}

/** Format findings the same shape as compiler diagnostics, so tools parse both. */
export function formatFindings(findings: LintFinding[]): string {
  return findings
    .map((f) => `${f.file}:${f.line}:${f.col} error ${f.rule}  ${f.message}`)
    .join('\n');
}
