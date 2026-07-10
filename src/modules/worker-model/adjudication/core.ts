/**
 * ikbi worker-model — THE ADJUDICATION CORE (decision).
 *
 * `decidePromotability` is the SINGLE authoritative promote/retain/discard judge. Pure and total: same
 * inputs ⇒ same Decision, no I/O, no clock, no model. Its parameter list has NO ProtocolExit and NO
 * stopReason (invariant I4) — protocol status physically cannot influence the verdict.
 *
 * Ordering rationale (fail-closed, green-work-preserving):
 *  1. No work on disk        → discard(no-work).            Nothing green ever existed.
 *  2. Killed mid-run         → retain(adjudication-incomplete). Never promote a half-run; keep for inspection.
 *  3. Assess GREENNESS ON MERIT (verdict=pass ∧ evidence real ∧ tree-bound). If NOT green, the work is
 *     not verified-good → DISCARD with the precise reason (verifier-red / vacuous-green / unresolvable),
 *     EXCEPT a stale tree-hash (verified a DIFFERENT tree) → retain(adjudication-incomplete): we cannot
 *     certify THIS tree, but we do not throw the work away.
 *  4. The work IS green on merit. From here ONLY a safety/governance/critic gate can withhold it, and it
 *     may ONLY RETAIN, never discard (invariant I1: green work is never discarded).
 *  5. All clear → promote(treeHash).
 */

import type { CriticVerdict, Decision, SafetyLedger, WorkAssessment, WorkProduct } from "./contract.js";

/**
 * True iff the assessment is a real, tree-bound green verdict (the only promotable state, per I2/I6).
 *
 * Evidence MUST be `executed` — tests actually ran against THIS tree (Codex C1b). There is no
 * accumulated-pass bypass: a boolean "a prior step was green" flag would let a step promote without any
 * executed evidence on its own tree, which is exactly the vacuous-green hole this gate exists to close.
 * Multi-step builds earn a promotable assessment the same way single-step builds do — the verifier runs
 * on the final tree, producing `executed` evidence bound to that tree hash.
 */
function isGreenOnMerit(work: WorkProduct, assessment: WorkAssessment): boolean {
  return assessment.verdict === "pass" && assessment.testEvidence === "executed" && assessment.treeHash === work.treeHash;
}

/**
 * THE authoritative promotability decision. See the module docstring for the ordering rationale and
 * docs/ADJUDICATION-CORE.md for the invariants (I1–I9) this function anchors.
 *
 * NOTE the signature: `work`, `assessment`, `safety`, `critic` — and NOTHING about how the builder
 * exited. That omission is the whole point (I4). To change WHAT gets promoted, change these facts; to
 * change WHETHER to keep trying, change the EffortPolicy — never add a branch here.
 */
export function decidePromotability(
  work: WorkProduct,
  assessment: WorkAssessment,
  safety: SafetyLedger,
  critic: CriticVerdict,
): Decision {
  // 1. No work exists — a build that produced nothing is not a build.
  if (!work.nonEmpty) return { action: "discard", reason: "no-work" };

  // 2. Interrupted — never promote a half-run; retain for inspection (adjudication may be incomplete).
  if (safety.killed) return { action: "retain", reason: "adjudication-incomplete" };

  // 3. Assess greenness ON MERIT. Not green ⇒ not verified-good.
  if (!isGreenOnMerit(work, assessment)) {
    // A verdict for a DIFFERENT tree cannot certify this one — retain (do not discard) and re-verify.
    if (assessment.treeHash !== work.treeHash) return { action: "retain", reason: "adjudication-incomplete" };
    if (assessment.verdict === "unresolvable") return { action: "discard", reason: "unresolvable" };
    // A "pass" verdict without real test evidence is a VACUOUS green — the strongest false-GREEN guard.
    if (assessment.verdict === "pass") return { action: "discard", reason: "vacuous-green" };
    // Everything else (fail / dry-run / skipped / untrusted / indeterminate / tool_limited-with-fail).
    return { action: "discard", reason: "verifier-red" };
  }

  // 4. The work is GREEN ON MERIT. Only a gate can withhold it now — and only via RETAIN (I1).
  //    Safety forensics first (highest severity), then governance, then goal-alignment.
  if (safety.effectiveBreach || safety.externalInjection || safety.refuted) {
    return { action: "retain", reason: "safety-forensics" };
  }
  if (safety.driftBlocked) return { action: "retain", reason: "governance-withheld" };
  if (!critic.pass) return { action: "retain", reason: "critic-fail-exhausted" };
  if (!safety.gateWallAuthorized) return { action: "retain", reason: "governance-withheld" };

  // 5. Green, tree-bound, evidenced, unvetoed, authorized.
  return { action: "promote", treeHash: work.treeHash, reason: "verified-green" };
}
