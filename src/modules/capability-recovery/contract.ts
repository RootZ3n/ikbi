/**
 * ikbi capability-recovery — THE MODULE CONTRACT (versioned).
 *
 * A non-executing recovery PLANNER. It detects when a previously-known capability is
 * now unavailable or degraded, diagnoses the likely cause CLASS, and produces a
 * `CapabilityRecoveryPlan` that RECOMMENDS which module should handle the repair — a
 * recommendation, never an invocation.
 *
 * DISTINCT from the others (do not flatten this):
 *   - the worker/builder pipeline FIXES code ("the code is broken; patch it").
 *   - drift-prevention detects success-RATE decay ("this operation is degrading").
 *   - capability-recovery detects LOST ABILITIES ("this USED TO WORK and no longer
 *     does — diagnose the cause class and route recovery"). Examples: test execution
 *     broke because a dependency is missing; an entrypoint moved (registration); a
 *     model/provider's credentials changed (credentials); a memory path changed (path).
 *
 * v1 IS DETECT-AND-PLAN ONLY: it executes no repair, patches no code, calls no
 * builder / governed-exec / dependency-install (it imports NONE of them — the
 * import-surface absence is the boundary). Routing-to-repair is a DEFERRED seam. Its
 * only outputs are a returned `CapabilityRecoveryPlan` + a `recovery.*` event;
 * `recommendedRepair` is a SUGGESTION, not a dispatch.
 *
 * It READS to diagnose: lab-context-memory (the it-used-to-work record + capability
 * registry, read-only), receipts (last-known-good + breakage evidence, read-only), and
 * optionally drift-prevention's read-only `check()`. The capability name + caller
 * evidence + retrieved memory are UNTRUSTED → neutralized before the model.
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial capability-recovery contract: CapabilityRecoveryInput /
 *           CapabilityRecoveryPlan, the status enum + cause taxonomy + recommendedRepair.
 *           Detect-and-plan; recommends-not-invokes.
 */

import type { OperationContext } from "../../core/identity/index.js";

/** Semantic version of the capability-recovery contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** Current availability of the capability. */
export type CapabilityStatus = "available" | "degraded" | "unavailable" | "unknown";

/** The cause taxonomy — the CLASS of what broke. */
export type CauseClass =
  | "config"
  | "dependency"
  | "registration"
  | "credentials"
  | "model-provider"
  | "path"
  | "permission"
  | "code"
  | "unknown";

/** Modules capability-recovery may RECOMMEND for the repair (a suggestion — never invoked here). */
export type RepairModule = "worker-model" | "governed-exec" | "dependency-install" | "agent-router" | "manual";

/** A repair RECOMMENDATION (data, not a dispatch). */
export interface RecommendedRepair {
  readonly module: RepairModule;
  readonly action: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Input to a capability assessment. */
export interface CapabilityRecoveryInput {
  /** The caller's operation context (must carry a ValidatedIdentity). */
  readonly parentCtx: OperationContext;
  /** The capability id/name to check (e.g. "test-execution", a tool/command name). */
  readonly capability: string;
  /** Who is asking (attribution). Defaults to the caller's agentId. */
  readonly agentId?: string;
  readonly project?: string;
  /** Optional probe/failure evidence the caller already has (UNTRUSTED — neutralized). */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/** When/where the capability last worked. */
export interface LastKnownGood {
  readonly when: number;
  readonly source: string;
}

/** The recovery plan — diagnosis + a routing recommendation. Executes nothing. */
export interface CapabilityRecoveryPlan {
  readonly capability: string;
  readonly status: CapabilityStatus;
  /** When/where it last worked (from memory/receipts), when there is a record. */
  readonly lastKnownGood?: LastKnownGood;
  /** Structural evidence it is broken now (operation+status, evidence keys — not content). */
  readonly evidenceOfBreakage: readonly string[];
  readonly likelyCause: CauseClass;
  /** Confidence in the cause, in [0,1]. */
  readonly causeConfidence: number;
  readonly rationale: string;
  /** The repair RECOMMENDATION (not an invocation). */
  readonly recommendedRepair?: RecommendedRepair;
}

/** Failure kinds for the recovery planner. */
export type CapabilityRecoveryErrorKind = "disabled" | "identity";

/** A typed failure (thrown only on a fail-closed refusal). */
export class CapabilityRecoveryError extends Error {
  readonly kind: CapabilityRecoveryErrorKind;
  constructor(kind: CapabilityRecoveryErrorKind, message: string) {
    super(message);
    this.name = "CapabilityRecoveryError";
    this.kind = kind;
  }
}

/** The capability-recovery surface (assess; reads to diagnose, executes nothing). */
export interface CapabilityRecovery {
  assess(input: CapabilityRecoveryInput): Promise<CapabilityRecoveryPlan>;
}
