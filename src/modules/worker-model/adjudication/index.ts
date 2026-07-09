/**
 * ikbi worker-model — THE ADJUDICATION CORE.
 *
 * First-class build-completion / promotion decision: "the builder is a WORKER, not a WITNESS." See
 * docs/ADJUDICATION-CORE.md.
 *
 * @status dormant (library-only, STEP 1) — the pure decision core + fact producers are built and
 * unit-tested, but NOT yet wired into the orchestrator. Step 2 runs `decidePromotability` in SHADOW
 * mode alongside the existing integrator AND-gate (logging divergences, changing nothing); Step 3
 * rewires the control flow to make it authoritative. Until then this has no runtime reachability by
 * design — the staged, shadow-first rollout of a promote-safety change.
 */

export { decidePromotability } from "./core.js";
export { computeWorkProduct, type GitRunner } from "./work-product.js";
export type {
  CriticVerdict,
  Decision,
  DiscardReason,
  ProtocolExit,
  RetainReason,
  SafetyLedger,
  TestEvidence,
  Verdict,
  WorkAssessment,
  WorkProduct,
} from "./contract.js";
