/**
 * ikbi self-heal — the pure disposition policy.
 *
 * decideDisposition() is a PURE function of already-computed gate results: is the failure
 * harness-suspect, did the build produce a candidate, did the correctness gates (full suite +
 * deterministic judge) pass, and what is the blast-radius severity. It returns the DISPOSITION and
 * the authority signals a caller enacts — no I/O, no model call, fully testable.
 *
 * FAIL-CLOSED: the ONLY path to "applied" is harness-suspect AND a candidate AND suite-green AND
 * judge-pass AND a LOW blast-radius. Any doubt on ANY axis routes to a human (verified fixes that
 * touch a guard/frozen-core/broad surface) or to a diagnosis (fixes that failed a correctness gate).
 * The guard can never auto-heal the guard; a fix can never delete the tests that verify it.
 */

import type { SelfHealGateInput, SelfHealVerdict } from "./contract.js";

export function decideDisposition(input: SelfHealGateInput): SelfHealVerdict {
  // GATE 0 — self-heal only ever acts on HARNESS-suspect failures. A model/task/unknown failure is
  // not ours to auto-repair (a wrong model output is not a harness bug); decline without touching it.
  if (!input.harnessSuspect) {
    return {
      disposition: "rejected",
      verified: false,
      requiresHuman: false,
      requiresOpusReview: false,
      reasons: ["not a harness-suspect failure — self-heal only repairs the harness, never model/task outcomes"],
    };
  }

  // GATE 1 — nothing to gate if the fix build changed nothing (a no-op or a failed generation).
  if (!input.candidateProduced) {
    return {
      disposition: "rejected",
      verified: false,
      requiresHuman: false,
      requiresOpusReview: false,
      reasons: ["the fix build produced no candidate change — nothing to verify or apply"],
    };
  }

  // CORRECTNESS — a fix is only "verified" if it passes BOTH gates: the full ikbi suite AND the judge.
  const verified = input.suiteGreen && input.judgePass;
  const blast = input.blastRadius;

  // A candidate that failed a correctness gate is NEVER applied. It becomes a diagnosed proposal: the
  // attempt + the failing gate are surfaced for a human to read (the honest ceiling — cheap/pro models
  // often can't author a correct fix for a subtle harness bug, and this is the intended safe outcome).
  if (!verified) {
    const reasons: string[] = [];
    if (!input.suiteGreen) reasons.push("the full ikbi test suite did not pass on the candidate");
    if (!input.judgePass) reasons.push("the deterministic judge rejected the candidate");
    reasons.push("surfaced as a diagnosis for a human — an unverified fix is never applied");
    return {
      disposition: "diagnosed-proposal",
      verified: false,
      requiresHuman: true,
      requiresOpusReview: false,
      reasons,
    };
  }

  // VERIFIED + LOW blast-radius → the only auto path. Kept on its BRANCH (never merged to main) for
  // the human to fast-track. "Auto-applied" means auto-committed-to-branch + receipted, not merged.
  if (blast.autoApplyEligible) {
    return {
      disposition: "applied",
      verified: true,
      requiresHuman: false,
      requiresOpusReview: false,
      reasons: ["verified (suite + judge green) and low blast-radius — kept on its branch for the operator to merge", ...blast.reasons],
    };
  }

  // VERIFIED but HIGH/MAX blast-radius → a real fix that only lacks AUTHORITY. The human always
  // decides; Opus advises first. This is where the meta-rule and no-test-drop land: a fix touching a
  // guard, frozen core, a broad surface, or that would drop the suite count can never auto-apply.
  return {
    disposition: "awaiting-authorization",
    verified: true,
    requiresHuman: true,
    requiresOpusReview: blast.requiresOpusReview,
    reasons: ["verified, but the blast-radius requires a human decision (Opus advises first)", ...blast.reasons],
  };
}
