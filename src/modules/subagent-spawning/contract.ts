/**
 * ikbi subagent-spawning — THE MODULE CONTRACT (versioned).
 *
 * This is the first real CONSUMER of the worker-model orchestrator. A parent spawns
 * a subagent worker run UNDER THE PARENT'S TRUST CEILING. It does NOT re-implement
 * the orchestrator's per-role clamp (`spawnRole`, TRUST_FLOOR..parentTier); it adds
 * the OUTER boundary — the parent→subagent hop — so the identity handed to
 * `orchestrator.run` as the run's parent can NEVER out-rank the spawning parent
 * (#10, the load-bearing constraint).
 *
 * It reuses the frozen `OperationContext` / `WorkerTask` / `WorkerResult` shapes
 * directly — no adapter, no contract change to the core or to worker-model.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial subagent-spawning contract: SpawnRequest + SpawnResult and the
 *           spawner surface. The child runs through a gate-wall-wired orchestrator,
 *           so governance is ENFORCED for spawned runs (a probation/untrusted
 *           parent is denied at promote). Fail-closed: a disabled spawner, a
 *           non-validated parent, or a child that out-ranks the ceiling all refuse.
 */

import type { OperationContext, TrustTier } from "../../core/identity/index.js";
import type { WorkerResult, WorkerTask } from "../worker-model/index.js";

/** Semantic version of the subagent-spawning contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/**
 * A request to spawn a subagent worker run. `parentCtx` is the SPAWNING parent (a
 * validated identity). `requestedTier` is the tier the subagent ASKS for — advisory:
 * it is clamped to the parent ceiling and can only ever request DOWN, never up.
 */
export interface SpawnRequest {
  /** The spawning parent's operation context (must carry a ValidatedIdentity). */
  readonly parentCtx: OperationContext;
  /** The worker task to run as the spawned subagent. */
  readonly task: WorkerTask;
  /** Optional requested child tier — clamped to the parent ceiling (#10). */
  readonly requestedTier?: TrustTier;
}

/** An auditable summary of the child identity the spawner derived (for the caller). */
export interface ChildIdentitySummary {
  /** The resolved child agent id. */
  readonly agentId: string;
  /** The child's effective trust tier (always ≤ the parent's tier). */
  readonly trustTier: TrustTier;
  /** The spawning parent's agent id (carried onto the child via `spawnedFrom`). */
  readonly spawnedFrom: string;
  /** The spawning parent's tier (the ceiling). */
  readonly parentTier: TrustTier;
  /** The tier the subagent requested (defaults to the parent tier). */
  readonly requestedTier: TrustTier;
  /** True if the requested tier was clamped DOWN to the parent ceiling. */
  readonly clamped: boolean;
}

/**
 * The outcome of a spawn. `spawned` is false (with a `reason`) when the spawner
 * refuses fail-closed (disabled / non-validated parent); on a genuine spawn it
 * carries the `WorkerResult` and the `childIdentitySummary`.
 */
export interface SpawnResult {
  readonly spawned: boolean;
  readonly workerResult?: WorkerResult;
  readonly reason?: string;
  readonly childIdentitySummary?: ChildIdentitySummary;
}

/** The subagent-spawning surface. */
export interface SubagentSpawner {
  spawn(request: SpawnRequest): Promise<SpawnResult>;
}

/** Failure kinds for the spawner. `escalation` is the #10 defense-in-depth trip. */
export type SpawnErrorKind = "config" | "escalation";

/** A typed spawner failure (thrown only for fail-closed invariant violations). */
export class SpawnError extends Error {
  readonly kind: SpawnErrorKind;
  constructor(kind: SpawnErrorKind, message: string) {
    super(message);
    this.name = "SpawnError";
    this.kind = kind;
  }
}
