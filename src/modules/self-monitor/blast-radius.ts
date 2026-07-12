/**
 * ikbi self-heal — blast-radius classifier (the AUTHORITY gate).
 *
 * A proposed harness self-fix passes the CORRECTNESS gates first (deterministic judge + the full
 * test suite in a shadow workspace). This module answers the separate question: how much AUTHORITY
 * does APPLYING it need? It is deterministic and PURE — the gate itself must not be model-judged, or
 * it could be talked past. Severity is computed from observable facts (which paths, how many files,
 * how many lines, whether the test count dropped), and it enforces the two non-negotiable rails:
 *
 *   META-RULE: a self-fix may NEVER auto-modify the systems that VERIFY it — frozen core, the judge,
 *   the gate-wall, governed-exec, check-triage, the verifier, the builder's policy gate, egress, OR
 *   this blast-radius module and the self-monitor themselves. Touching any of those is MAX severity:
 *   Opus advises, the human always decides, never auto-applied. (Else ikbi could fix its way out of
 *   its own guardrails — the confidently-broken-harness failure mode.)
 *
 *   NO-TEST-DROP: a fix that deletes a test file, or lowers the full-suite test count, is treated as
 *   MAX — that is how a fix games the suite green (the same class as the phantom-pass we closed).
 */

export type Severity = "low" | "medium" | "high" | "max";

export interface ProposedFix {
  /** Repo-relative paths added or modified by the fix. */
  readonly changedFiles: readonly string[];
  /** Repo-relative paths the fix DELETES. */
  readonly deletedFiles?: readonly string[];
  /** Total lines added + removed (a size signal). */
  readonly linesChanged?: number;
  /** Full-suite test count before / after the fix — after must not be lower (no gaming). */
  readonly testCountBefore?: number;
  readonly testCountAfter?: number;
  /** True if the fix changes a frozen contract's version/shape. */
  readonly touchesFrozenContract?: boolean;
}

export interface BlastRadius {
  readonly severity: Severity;
  readonly reasons: readonly string[];
  /** high/max: the human always decides. */
  readonly requiresHuman: boolean;
  /** high/max: one Opus call advises before the human decides. */
  readonly requiresOpusReview: boolean;
  /** low only: may auto-apply (to a branch) once judge + full suite are green. */
  readonly autoApplyEligible: boolean;
}

/**
 * MAX-severity paths — the systems that verify/gate a fix, plus frozen core. Touching ANY of these
 * means the self-heal loop cannot auto-apply; it goes to Opus review + human decision. This list
 * INCLUDES self-monitor/blast-radius itself (the meta-rule: the guard cannot auto-heal the guard).
 */
const GUARD_PATHS: readonly RegExp[] = [
  /^src\/core\//,                                   // frozen core (provider, trust, injection, identity, workspace, receipt, substrate, contracts, events)
  /^src\/modules\/self-monitor\//,                  // the classifier + THIS blast-radius module (meta-rule)
  /^src\/modules\/deterministic-judge\//,           // the judge that scrutinizes fixes
  /^src\/modules\/gate-wall\//,                      // the execution gate
  /^src\/modules\/governed-exec\//,                  // governed execution + allowlist
  /^src\/modules\/check-triage\//,                   // the no-vacuous-green / phantom guards
  /^src\/modules\/egress\//,                         // network egress guard
  /^src\/modules\/kill-switch\//,                    // the kill switch
  /^src\/modules\/worker-model\/verifier\.ts$/,      // the verifier
  /^src\/modules\/worker-model\/checks\.ts$/,         // check detection + test-count parsing
  /^src\/modules\/worker-model\/builder\.ts$/,        // contains the policy-violation gate (isPolicyViolation)
];

/** HIGH-severity paths — build orchestration + security-adjacent surfaces (not guards, but serious). */
const HIGH_PATHS: readonly RegExp[] = [
  /^src\/modules\/worker-model\//,                   // the rest of the build pipeline
  /^src\/modules\/escalation\//,
  /^src\/modules\/recovery\//,
];

/** A test file (its deletion / count-drop is the anti-cheat trip). */
function isTestFile(p: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

const rank: Record<Severity, number> = { low: 0, medium: 1, high: 2, max: 3 };
const maxOf = (a: Severity, b: Severity): Severity => (rank[a] >= rank[b] ? a : b);

/** Assess how much authority applying a fix needs. Deterministic; never a model call. */
export function assessBlastRadius(fix: ProposedFix): BlastRadius {
  const reasons: string[] = [];
  let severity: Severity = "low";
  const all = [...fix.changedFiles, ...(fix.deletedFiles ?? [])];

  // NO-TEST-DROP anti-cheat (MAX): a deleted test or a lowered suite count games the green.
  if ((fix.deletedFiles ?? []).some(isTestFile)) {
    severity = maxOf(severity, "max");
    reasons.push("deletes a test file — a fix must not remove the tests that verify it");
  }
  if (fix.testCountBefore !== undefined && fix.testCountAfter !== undefined && fix.testCountAfter < fix.testCountBefore) {
    severity = maxOf(severity, "max");
    reasons.push(`the full-suite test count drops (${fix.testCountBefore} → ${fix.testCountAfter}) — suspected gaming of the suite`);
  }

  // META-RULE (MAX): touches a system that verifies/gates the fix, or frozen core.
  const guardHits = all.filter((p) => GUARD_PATHS.some((re) => re.test(p)));
  if (guardHits.length > 0) {
    severity = maxOf(severity, "max");
    reasons.push(`touches a verification/guard or frozen-core path (${guardHits.slice(0, 3).join(", ")}${guardHits.length > 3 ? ", …" : ""}) — the guard cannot auto-heal the guard`);
  }
  if (fix.touchesFrozenContract === true) {
    severity = maxOf(severity, "max");
    reasons.push("changes a frozen contract");
  }

  // HIGH: build orchestration / escalation / recovery, or a broad change.
  const highHits = all.filter((p) => HIGH_PATHS.some((re) => re.test(p)) && !GUARD_PATHS.some((re) => re.test(p)));
  if (highHits.length > 0) {
    severity = maxOf(severity, "high");
    reasons.push(`touches build-orchestration/escalation code (${highHits.slice(0, 3).join(", ")}${highHits.length > 3 ? ", …" : ""})`);
  }
  // Breadth: many files or large diffs raise severity even in ordinary modules.
  const nonTest = all.filter((p) => !isTestFile(p));
  if (nonTest.length >= 6) { severity = maxOf(severity, "high"); reasons.push(`wide change: ${nonTest.length} non-test files`); }
  else if (nonTest.length >= 2) { severity = maxOf(severity, "medium"); reasons.push(`${nonTest.length} non-test files changed`); }
  if ((fix.linesChanged ?? 0) >= 400) { severity = maxOf(severity, "high"); reasons.push(`large diff (${fix.linesChanged} lines)`); }
  else if ((fix.linesChanged ?? 0) >= 120) { severity = maxOf(severity, "medium"); reasons.push(`${fix.linesChanged} lines changed`); }

  if (reasons.length === 0) reasons.push("a small, localized change in an ordinary module");

  const requiresHuman = severity === "high" || severity === "max";
  return {
    severity,
    reasons,
    requiresHuman,
    requiresOpusReview: requiresHuman, // Opus advises on high/max; the human still decides.
    autoApplyEligible: severity === "low",
  };
}
