/**
 * ikbi worker-model — EXECUTED-TEST-EVIDENCE POLICY (Phase 10, IKBI-REAUDIT-001).
 *
 * The canonical rule for whether a candidate's TEST EVIDENCE is acceptable for AUTONOMOUS promotion.
 * Autonomous verified completion is only truthful when tests ACTUALLY RAN against the exact candidate
 * tree. A model claim that "tests pass", a test command suggested in prose, or a PRIOR candidate's
 * passing tests are NOT executed-test evidence — only the deterministic verifier's observed `executed`
 * classification is.
 *
 * The verifier classifies test signal four ways (see `readVerifier`): `executed` (a real suite ran with a
 * parsed count > 0), `zero` (a runner ran nothing), `unverified` (a pass with no parseable count — e.g.
 * `echo done`), `absent` (no test check at all). This module maps that class + an explicit policy into a
 * single fail-closed decision, WITHOUT collapsing the distinct states into a bare boolean:
 *   - `executed`                → acceptable.
 *   - `absent` (no tests)       → acceptable ONLY under an explicit, named no-tests policy.
 *   - `zero` / `unverified`     → BLOCK (a green that proved nothing about behavior).
 *   - missing / undefined       → BLOCK (we cannot confirm a real signal — never promote on unproven evidence).
 *
 * This is enforced in BOTH the integrator DECISION and the promotion AUTHORITY (defense in depth): no
 * path — normal, multi-step final, tournament, competitive, adjudication — may autonomously promote
 * without it. A manual, explicitly-unverified operator apply is a separate authority class and does not
 * use this gate.
 */

import type { TestEvidence } from "./adjudication/contract.js";

/** The exact evidence state, with `missing` distinguished from every produced class. */
export type ExecutedTestEvidenceState = TestEvidence | "missing";

export interface TestEvidencePolicy {
  /** An explicit, named task/repository policy that promoting with NO tests configured is acceptable. */
  readonly allowNoTests: boolean;
}

export interface TestEvidenceDecision {
  /** Whether the evidence is acceptable for AUTONOMOUS promotion. */
  readonly acceptable: boolean;
  /** A stable machine reason for receipts/telemetry. */
  readonly reason: string;
  /** The exact evidence state (never collapsed to a boolean). */
  readonly state: ExecutedTestEvidenceState;
}

/**
 * Whether a candidate's executed-test evidence authorizes AUTONOMOUS promotion. Fail-closed: everything
 * other than an authentic `executed`, or an explicitly-policied `absent`, blocks.
 */
export function evaluateExecutedTestEvidence(
  evidence: TestEvidence | undefined,
  policy: TestEvidencePolicy,
): TestEvidenceDecision {
  const state: ExecutedTestEvidenceState = evidence ?? "missing";
  if (state === "executed") return { acceptable: true, reason: "executed", state };
  if (state === "absent") {
    return policy.allowNoTests
      ? { acceptable: true, reason: "no-tests-configured-explicit-policy", state }
      : { acceptable: false, reason: "no-tests-configured-without-policy", state };
  }
  // "zero" | "unverified" | "missing" — a green that proved nothing, or an unconfirmable signal.
  return { acceptable: false, reason: `non-executed-test-evidence:${state}`, state };
}

/**
 * Resolve the explicit no-tests policy for a task. The policy is a NAMED task field
 * (`task.noTestsPolicy`) or the operator env `IKBI_ALLOW_NO_TESTS=true`. Default (unset) is FALSE —
 * "no tests configured" blocks autonomous promotion until the operator explicitly permits it.
 */
export function noTestsPolicyEnabled(
  task: { readonly noTestsPolicy?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return task.noTestsPolicy === true || env.IKBI_ALLOW_NO_TESTS === "true";
}
