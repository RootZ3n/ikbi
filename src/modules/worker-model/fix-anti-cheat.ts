/**
 * ikbi worker-model — FIX ANTI-CHEAT (docs/FIX-MODE-DESIGN.md §7).
 *
 * After a fix patch is applied, this verifies the fix did not CHEAT its way to green. It
 * runs on EVERY fix attempt — even one whose diagnosis said "not fixable" (in which case
 * there are no changes and every check trivially passes). A single failing sub-check makes
 * the whole run UNSAFE_FAIL (the pipeline halts; nothing promotes).
 *
 * NOTE ON `weakening`: the design referenced an existing `weakening.ts`. The verifier's
 * weakening guards (`verifier.ts`) target the JS BUILD surface — tsconfig strictness,
 * package.json "scripts", test-config files — not source-level test bodies. fix mode needs
 * SOURCE-level, language-agnostic test-weakening heuristics (assertion counts, try/except
 * swallowing), so they live here. PURE: no IO, no model, no spawn.
 */

import type { AntiCheatCheckResult } from "./fix-receipt.js";

/** A single file's before/after state. `before: null` ⇒ created; `after: null` ⇒ deleted. */
export interface FileChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface AntiCheatInput {
  /** Every file the fix touched (created / modified / deleted), with before+after content. */
  readonly changes: readonly FileChange[];
  /** The files the diagnosis scoped the repair to. Any change OUTSIDE this set is forbidden. */
  readonly allowedFiles: readonly string[];
  /** Posture: when false, ANY change to a test file is a violation (tests are ground truth). */
  readonly allowTestEdits: boolean;
}

export interface AntiCheatVerdict {
  readonly passed: boolean;
  readonly checks: readonly AntiCheatCheckResult[];
}

/** Normalize a path to POSIX separators for comparison. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Is this a test file (pytest `test_*.py` / `*_test.py`, or JS `.test.`/`.spec.`)? */
export function isTestFile(path: string): boolean {
  const p = norm(path);
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/(^|\/)tests?\//.test(p) && base.endsWith(".py")) return true;
  return false;
}

/**
 * Count assertions in a source body. Language-agnostic and deliberately broad: Python
 * `assert`, `self.assertX(`, `pytest.raises(`; JS/TS `expect(`, `assert(`, `assert.x(`.
 * A lower count after a change is a weakening signal.
 */
export function countAssertions(content: string): number {
  let n = 0;
  // Python: `assert ` / `assert(` at a statement boundary.
  n += (content.match(/(^|\n)\s*assert[\s(]/g) ?? []).length;
  // unittest-style assertions.
  n += (content.match(/\bself\.assert[A-Za-z]*\s*\(/g) ?? []).length;
  // pytest.raises / unittest assertRaises context managers.
  n += (content.match(/\b(?:pytest\.raises|assertRaises)\s*\(/g) ?? []).length;
  // JS/TS expect() and node:assert.
  n += (content.match(/\bexpect\s*\(/g) ?? []).length;
  n += (content.match(/\bassert\.[A-Za-z]+\s*\(/g) ?? []).length;
  return n;
}

/**
 * Detect try/except(catch)-swallow blocks — `except …: pass`, bare `except: pass`, or an
 * empty JS `catch { }`. Returns a count so a caller can compare before vs after.
 */
export function countSwallowBlocks(content: string): number {
  let n = 0;
  // Python: an except clause whose only body is `pass` (allow a docstring/comment-free pass).
  n += (content.match(/except\b[^\n:]*:\s*(?:#[^\n]*\n\s*)*pass\b/g) ?? []).length;
  // JS/TS: an empty catch block.
  n += (content.match(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g) ?? []).length;
  return n;
}

/** Count top-level test functions (pytest `def test_…` / JS `it(`/`test(`). */
function countTestFunctions(content: string): number {
  let n = 0;
  n += (content.match(/(^|\n)\s*def\s+test_\w*\s*\(/g) ?? []).length;
  n += (content.match(/\b(?:it|test)\s*\(\s*['"`]/g) ?? []).length;
  return n;
}

/**
 * Run the anti-cheat suite over the applied changes. Order-independent; each sub-check is
 * recorded with evidence regardless of outcome. `passed` is the AND of every sub-check.
 */
export function antiCheatCheck(input: AntiCheatInput): AntiCheatVerdict {
  const allowed = new Set(input.allowedFiles.map(norm));
  const checks: AntiCheatCheckResult[] = [];

  // 1. NO TEST WEAKENING — assertion count (and test count) must not decrease in a test file,
  //    and a test file must not be edited at all when test edits are disallowed.
  {
    const offenders: string[] = [];
    for (const c of input.changes) {
      if (!isTestFile(c.path)) continue;
      if (!input.allowTestEdits) {
        offenders.push(`${c.path}: tests are ground truth — editing them is forbidden without --allow-test-edits`);
        continue;
      }
      const before = c.before ?? "";
      const after = c.after ?? "";
      const aBefore = countAssertions(before);
      const aAfter = countAssertions(after);
      if (aAfter < aBefore) offenders.push(`${c.path}: assertions ${aBefore} → ${aAfter} (decreased)`);
      const tBefore = countTestFunctions(before);
      const tAfter = countTestFunctions(after);
      if (tAfter < tBefore) offenders.push(`${c.path}: test functions ${tBefore} → ${tAfter} (decreased)`);
    }
    checks.push({
      name: "no_test_weakening",
      passed: offenders.length === 0,
      evidence: offenders.length === 0 ? "no test assertions or test functions were removed" : offenders.join("; "),
    });
  }

  // 2. NO FORBIDDEN FILE CHANGES — every changed file must be within the diagnosed scope.
  {
    const offenders = input.changes.map((c) => norm(c.path)).filter((p) => !allowed.has(p));
    checks.push({
      name: "no_forbidden_file_changes",
      passed: offenders.length === 0,
      evidence:
        offenders.length === 0
          ? `all ${input.changes.length} change(s) within diagnosed scope [${[...allowed].join(", ") || "∅"}]`
          : `changed files outside diagnosis scope: ${offenders.join(", ")}`,
    });
  }

  // 3. NO BROAD VALIDATION REMOVAL — no wholesale deletion of a test/validator file, and no
  //    large drop in assertions within any single file (a "delete most of the checks" move).
  {
    const offenders: string[] = [];
    for (const c of input.changes) {
      if (c.after === null && (isTestFile(c.path) || countAssertions(c.before ?? "") > 0)) {
        offenders.push(`${c.path}: a validating file was deleted entirely`);
        continue;
      }
      const aBefore = countAssertions(c.before ?? "");
      const aAfter = countAssertions(c.after ?? "");
      if (aBefore >= 4 && aAfter <= aBefore / 2) offenders.push(`${c.path}: assertions ${aBefore} → ${aAfter} (>50% removed)`);
    }
    checks.push({
      name: "no_broad_validation_removal",
      passed: offenders.length === 0,
      evidence: offenders.length === 0 ? "no validator file deleted and no broad assertion removal" : offenders.join("; "),
    });
  }

  // 4. NO TRY-EXCEPT-PASS — the fix must not wrap failing code in a swallow block to silence it.
  {
    const offenders: string[] = [];
    for (const c of input.changes) {
      const before = countSwallowBlocks(c.before ?? "");
      const after = countSwallowBlocks(c.after ?? "");
      if (after > before) offenders.push(`${c.path}: try/except-pass (or empty catch) blocks ${before} → ${after} (added ${after - before})`);
    }
    checks.push({
      name: "no_try_except_pass",
      passed: offenders.length === 0,
      evidence: offenders.length === 0 ? "no exception-swallowing blocks were added" : offenders.join("; "),
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}
