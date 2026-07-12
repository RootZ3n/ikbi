/**
 * ikbi worker-model — THE ADJUDICATION CORE (contract).
 *
 * The first-class build-completion / promotion decision. See docs/ADJUDICATION-CORE.md.
 *
 * THE THESIS: the builder is a WORKER, not a WITNESS. Its exit status is evidence about whether to
 * keep spending EFFORT — never evidence about whether the work on disk is GOOD. The pipeline's
 * recurring "false RED" (correct, green work discarded) comes from conflating those two questions and
 * scattering the answer across ~a dozen orchestrator branches. This module separates the facts into
 * four strict types and routes them to a SINGLE decision function (`decidePromotability`) whose
 * signature CANNOT express a protocol exit — so the conflation becomes a type error, not a patch.
 */

/**
 * WHAT IS PHYSICALLY ON DISK in the worktree — ground truth from `git`, NEVER the builder's
 * self-reported `filesWritten` ledger (which desyncs when files are produced via governed `terminal`
 * or when the tool loop is cut off mid-write). `treeHash` binds a verifier verdict to exactly this
 * state (see WorkAssessment.treeHash + invariant I2): a promote of any OTHER tree with that verdict is
 * impossible by construction.
 */
export interface WorkProduct {
  /** `git write-tree`-equivalent hash of the worktree's current content. */
  readonly treeHash: string;
  /** Files changed vs base + net line delta — telemetry/receipts only. */
  readonly diffStat: { readonly filesChanged: number; readonly insertions: number; readonly deletions: number };
  /** True iff the worktree differs from base — i.e. there is work to adjudicate. */
  readonly nonEmpty: boolean;
}

/**
 * HOW THE BUILDER SESSION ENDED — an EFFORT fact. Feeds the EffortPolicy (keep trying?), the trust
 * ledger (behavior), and receipts (auditability). It is DELIBERATELY absent from `decidePromotability`
 * (invariant I4): protocol status can never reach the promote verdict.
 */
export interface ProtocolExit {
  readonly kind: "done" | "stall" | "hard_error" | "aborted";
  /** The builder's stopReason (no_progress, max_iterations, timeout, stuck_detected, error, …). */
  readonly stopReason?: string;
  /** How many builder attempts (incl. escalation rungs) this run spent. */
  readonly attempts: number;
}

/** Verifier verdicts the pipeline can produce (see verifier.ts). Anything other than "pass" is not green. */
export type Verdict =
  | "pass"
  | "fail"
  | "tool_limited"
  | "dry-run"
  | "skipped"
  | "untrusted"
  | "unresolvable"
  | "indeterminate";

/** Test-evidence classes (see readVerifier). Only "executed" is real evidence tests actually ran. */
export type TestEvidence = "executed" | "zero" | "unverified" | "absent";

/**
 * THE VERIFIER'S JUDGEMENT OF WORK-GOODNESS, bound to the tree it judged. The verifier is the SOLE
 * witness to whether the work is good — it runs real checks on the actual disk state. `treeHash` is
 * the state the verdict applies to; it MUST equal WorkProduct.treeHash to promote (invariant I2 — no
 * post-verify write can ride a stale green verdict).
 */
export interface WorkAssessment {
  readonly verdict: Verdict;
  readonly testEvidence: TestEvidence;
  /** The tree hash the verifier actually ran against. */
  readonly treeHash: string;
  /**
   * Whether an EXPLICIT, named no-tests policy (`task.noTestsPolicy` / `IKBI_ALLOW_NO_TESTS=true`) permits
   * promoting THIS candidate on `absent` test evidence (Phase 10). Default undefined ⇒ false ⇒ a repo with
   * no test suite is NOT autonomously promotable. This is a named policy fact, NOT a fallback for missing
   * evidence: only `absent` (genuinely no test check) is exempted — `zero`/`unverified` still block.
   */
  readonly noTestsAcceptable?: boolean;
}

/**
 * A DERIVED, run-scoped projection of AUTHENTIC safety VETOES (Phase 8 — was the misleadingly-named
 * `SafetyLedger`). It is NOT an authoritative append-only evidence record and it NEVER authorizes a
 * promotion: it can only WITHHOLD (retain) green work in the adjudication decision, and even that is
 * shadow/quarantined (Phase 3). The authoritative promotion-policy boundary is the real gate-wall +
 * `promoteCandidate()`'s stale-tree/CAS checks — which run DOWNSTREAM of this projection.
 *
 * Every field here is a MONOTONE VETO — `true` means "a concrete bad event was OBSERVED by a named
 * runtime component" (never a manufactured affirmative "safe" claim); `false` means "no such veto was
 * raised" (the absence of a positive observation, never a claim that a check was run and passed). The
 * gate-wall is deliberately ABSENT: it is a downstream authority, not this projection's to assert.
 * PREVENTED (governor-rejected) attempts are NOT here — they are effect-judged warnings, never a veto.
 */
export interface SafetyAssessment {
  /** OBSERVED by the neutralization chokepoint: prompt-injection from OUTSIDE content (web/vision/delegate). */
  readonly externalInjection: boolean;
  /** OBSERVED: a control FAILURE that actually LANDED (sandbox escape, egress leak, out-of-workspace write). */
  readonly effectiveBreach: boolean;
  /** OBSERVED by the refuter role: the build was refuted. */
  readonly refuted: boolean;
  /** OBSERVED by the kill-switch / budget: the run was halted — never promote a half-run. */
  readonly killed: boolean;
  /** OBSERVED by the drift governor: this build was blocked (policy=block on detected drift). */
  readonly driftBlocked: boolean;
}

/** @deprecated Phase 8: use `SafetyAssessment`. Kept as a transitional alias so external refs compile. */
export type SafetyLedger = SafetyAssessment;

/** The critic's subjective goal-alignment judgement — a WORK fact (allowed into the decision). */
export interface CriticVerdict {
  readonly pass: boolean;
}

/** Why a build was discarded (not verified-good). Closed set — no free-text reasons (invariant I5). */
export type DiscardReason = "verifier-red" | "no-work" | "vacuous-green" | "unresolvable" | "aborted";

/** Why verified-green work was RETAINED rather than promoted. Green work is NEVER discarded (I1). */
export type RetainReason =
  | "governance-withheld"
  | "critic-fail-exhausted"
  | "safety-forensics"
  | "adjudication-incomplete";

/**
 * THE authoritative disposition. `promote` carries the tree hash it authorizes (the promote must land
 * exactly that tree). `retain` = verified-green work withheld by a gate — a categorically different,
 * non-failure outcome ("green-withheld"), never laundered into "the builder failed". `discard` = the
 * work is not verified-good.
 */
export type Decision =
  | { readonly action: "promote"; readonly treeHash: string; readonly reason: "verified-green" }
  | { readonly action: "retain"; readonly reason: RetainReason }
  | { readonly action: "discard"; readonly reason: DiscardReason };
