/**
 * ikbi self-monitor — harness-suspect failure classifier.
 *
 * "Blame the harness before the model," made repeatable. Given a build outcome, decide whether a
 * FAILURE looks like a HARNESS/config issue (a gate, trust, verification-contract, or over-strict
 * taint — not the model's fault) versus a MODEL failure (it produced something that failed real
 * checks) or a TASK that was too big/unverifiable. The harness-suspect signatures are exactly the
 * ones this project hit while piloting on cheap models. PURE: no I/O, no model call — testable, and
 * the trustworthy input to the self-heal pipeline (which only ever acts on harness-suspect failures).
 */

export type FailureCategory = "none" | "harness" | "model" | "task" | "unknown";

/** A normalized build outcome (constructible from a WorkerResult or a reconstructed receipt). */
export interface BuildOutcome {
  /** success | failure | partial | rejected */
  readonly outcome: string;
  readonly promoted?: boolean;
  readonly reason?: string;
  /** e.g. "checks_unresolvable" | "ladder" | "index" */
  readonly verificationKind?: string;
  readonly roles?: ReadonlyArray<{ readonly role: string; readonly outcome: string }>;
  /** builder stop reason, when known (no_progress | stuck_detected | done | length | ...) */
  readonly stopReason?: string;
}

export interface FailureClassification {
  readonly category: FailureCategory;
  /** True when this failure is likely the HARNESS's doing, not the model's. Gates the self-heal loop. */
  readonly harnessSuspect: boolean;
  /** A short, stable label for the signature (e.g. "checks_unresolvable", "trust_gate"). */
  readonly signal: string;
  /** Plain-language explanation for a report. */
  readonly evidence: string;
  /** The concrete next step, when there is a clear one. */
  readonly suggestedAction?: string;
}

function harness(signal: string, evidence: string, suggestedAction: string): FailureClassification {
  return { category: "harness", harnessSuspect: true, signal, evidence, suggestedAction };
}

/**
 * Classify one build outcome. Only FAILURES are classified; a promoted success is "none". The harness
 * signatures below are high-confidence (ikbi itself labels several "not a model failure"); anything
 * else falls to "model" (a real quality failure) or "unknown" (ambiguous — never auto-acted on).
 */
export function classifyBuildFailure(o: BuildOutcome): FailureClassification {
  const reason = (o.reason ?? "").toLowerCase();
  const vk = (o.verificationKind ?? "").toLowerCase();
  const verifierPassed = (o.roles ?? []).some((r) => r.role === "verifier" && r.outcome === "success");

  // A clean, promoted build is not a failure.
  if (o.outcome === "success" && o.promoted !== false) {
    return { category: "none", harnessSuspect: false, signal: "promoted", evidence: o.reason ?? "build promoted" };
  }

  // ── HARNESS signatures (a gate/config issue — not the model) ───────────────────────────────────
  // No verification contract: an empty/greenfield repo, or a repo ikbi cannot detect checks for.
  if (vk === "checks_unresolvable" || /no project manifest|no runnable check|checks_unresolvable|verification contract/.test(reason)) {
    return harness("checks_unresolvable",
      "No verification contract — ikbi found no manifest/checks to verify against (a greenfield or config gap, not the model).",
      "Add a project manifest (package.json / pyproject.toml / Cargo.toml / go.mod), or pass an explicit --check \"<cmd>\".");
  }
  // The build tried to change its own verification command; the anti-cheat blocked it. The check is
  // operator-owned by design, so this is an operator fix, not a model failure.
  if (/verification untrusted|modified package\.json script|builder modified.*\btest\b|stub(bed)? (script|hook)/.test(reason)) {
    return harness("verification_command_locked",
      "The build tried to change the verification command; ikbi's anti-cheat blocked it (the check is operator-owned).",
      "Fix the test/check script yourself as the operator, then re-run — a model may not edit what verifies it.");
  }
  // Trust gate: a fresh/demoted worker tier cannot LAND the build (no autoCommit autonomy).
  if (/lacks autocommit|autocommit autonomy|\btier "?(probation|verified)"?|trust grant|worker tier|grant the worker/.test(reason)) {
    return harness("trust_gate",
      "The worker's trust tier can't land the build (no autoCommit) — a trust-config gate, not the model.",
      "Run `ikbi trust grant worker trusted`, then re-run the build.");
  }
  // Test-evidence / phantom pass: verification could not count REAL test execution.
  if (/test evidence.{0,4}(absent|unverified)|phantom|node --test.*(bare )?dir|ran zero tests/.test(reason)) {
    return harness("test_evidence",
      "Verification could not count real test evidence (a phantom-pass or absent-evidence guard fired).",
      "Ensure the test command actually discovers and RUNS the tests (e.g. glob compiled files, not a bare directory).");
  }
  // Over-strict taint: a build the VERIFIER passed was still discarded for a blocked, no-effect action.
  if (verifierPassed && /out-of-policy tool call|policy violation|write scope violation/.test(reason)) {
    return harness("policy_taint",
      "A build the verifier PASSED was discarded for a blocked (no-effect) tool attempt — an over-strict taint, not a model failure.",
      "Review the policy-taint gate (blocked benign attempts should not discard a verified-clean build).");
  }

  // ── MODEL / performance (the model ran out of moves — trust is NOT penalized) ───────────────────
  if (o.stopReason === "no_progress" || o.stopReason === "stuck_detected" || /\bno_progress\b|\bstuck_detected\b/.test(reason)) {
    return { category: "model", harnessSuspect: false, signal: "no_progress",
      evidence: "The model ran out of productive moves (a performance limit; ikbi does not penalize trust for it).",
      suggestedAction: "Narrow the goal or try a stronger model tier; if the step was un-greenable, suspect the harness." };
  }

  // ── Genuine failure with real verification — likely the model's output ─────────────────────────
  if (o.outcome === "failure" || o.outcome === "rejected" || o.outcome === "partial") {
    return { category: "model", harnessSuspect: false, signal: "failure",
      evidence: o.reason ?? "the build did not complete or verify",
      suggestedAction: "Inspect the diff/receipt; if the model wrote something wrong, refine the goal." };
  }

  return { category: "unknown", harnessSuspect: false, signal: "unknown", evidence: o.reason ?? "unclassified outcome" };
}
