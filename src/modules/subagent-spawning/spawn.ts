/**
 * ikbi subagent-spawning — the spawner (the first real orchestrator consumer).
 *
 * `spawn(request)`:
 *   a. refuses when DISABLED (fail-closed — a disabled spawner denies, never bypasses);
 *   b. validates the parent carries a genuine ValidatedIdentity (#10 anti-spoof);
 *   c. computes the child CEILING = clampTier(requested, FLOOR, parentTier) — the
 *      parent→subagent OUTER boundary: a subagent can request DOWN but NEVER above
 *      its parent. (This is built ON TOP of the orchestrator's per-role clamp, which
 *      independently clamps each role to ≤ the run's parent — not re-implemented.)
 *   d. resolves the CHILD identity with `spawnedFrom = parent` (only the resolver can
 *      mint a ValidatedIdentity, so the child cannot be forged);
 *   e. DEFENSE-IN-DEPTH (mirrors the orchestrator's spawnRole invariant): if the
 *      resolved child out-ranks the ceiling, fail closed rather than run it;
 *   f. runs the worker under the child identity through a GATE-WALL-WIRED orchestrator
 *      — governance is ENFORCED for the spawned run (a probation/untrusted parent is
 *      denied at promote). The bare default orchestrator falls back to advisory-allow;
 *      this module passes gate-wall explicitly so the gate goes from loaded to FIRED.
 *
 * Every collaborator is injected (defaults wire the live singletons) so the
 * freeze-critical logic is testable in isolation.
 */

import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { beginOperation, isValidatedIdentity, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { OperationContext, ResolveContext, ValidatedIdentity } from "../../core/identity/index.js";
import type { AgentIdentity, IdentityClaim, TrustTier } from "../../core/identity/contract.js";
import { asTier, clampTier, tierRank, TRUST_FLOOR } from "../../core/trust/index.js";
import { createOrchestrator } from "../worker-model/index.js";
import type { WorkerResult, WorkerTask } from "../worker-model/index.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import { subagentSpawningConfig, type SubagentSpawningConfig } from "./config.js";
import { spawnClamped, spawnCompleted, spawnDenied, spawnRequested, type SpawnEventPayload } from "./events.js";
import { SpawnError, type ChildIdentitySummary, type SpawnRequest, type SpawnResult, type SubagentSpawner } from "./contract.js";

const EVENT_SOURCE = "subagent-spawning";
const SPAWN_OPERATION = "subagent.spawn";

/** Injectable dependencies (tests substitute orchestrator / resolveIdentity / publish / clock). */
export interface SubagentSpawnerDeps {
  readonly config?: SubagentSpawningConfig;
  /** Resolve the child credential to a validated identity. Default: core resolveIdentity. */
  readonly resolveIdentity?: (claim: IdentityClaim, ctx?: ResolveContext) => ValidatedIdentity;
  /** Produce the child credential claim. Default: fail-closed (must be configured). */
  readonly childClaim?: (ctx: { parent: AgentIdentity; tier: TrustTier }) => IdentityClaim;
  /** Governance evaluator wired into the spawned run's orchestrator. Default: live gate-wall. */
  readonly gateWall?: GateWall;
  /**
   * The orchestrator the spawned run executes on. Default: a gate-wall-wired
   * `createOrchestrator({ gateWall })` so governance is ENFORCED (NOT the bare
   * default singleton, which falls back to advisory-allow).
   */
  readonly orchestrator?: { run: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult> };
  readonly publish?: (input: EventInput<SpawnEventPayload>) => void;
  /** Clock (ms epoch) for the child operation context. Defaults to Date.now. */
  readonly now?: () => number;
}

/** Build a subagent spawner. The default deps wire the live frozen singletons + gate-wall. */
export function createSubagentSpawner(deps: SubagentSpawnerDeps = {}): SubagentSpawner {
  const config = deps.config ?? subagentSpawningConfig;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const childClaim =
    deps.childClaim ??
    ((): IdentityClaim => {
      throw new SpawnError(
        "config",
        "no childClaim configured — wire childClaim/resolveIdentity (a registered child credential is required to mint the subagent identity)",
      );
    });
  const gateWall = deps.gateWall ?? coreGateWall;
  // ENFORCEMENT GOES LIVE HERE: the spawned run uses a gate-wall-wired orchestrator,
  // not the bare default (which advisory-allows at promote).
  const orchestrator = deps.orchestrator ?? createOrchestrator({ gateWall });
  const publish = deps.publish ?? ((input: EventInput<SpawnEventPayload>) => void coreEvents.publish(input));
  const now = deps.now ?? Date.now;

  function emit(
    event: { create: (payload: SpawnEventPayload, opts?: { source?: string; attribution?: { identity?: AgentIdentity; operation?: string; runId?: string } }) => EventInput<SpawnEventPayload> },
    payload: SpawnEventPayload,
    identity: AgentIdentity | undefined,
    runId: string,
  ): void {
    publish(
      event.create(payload, {
        source: EVENT_SOURCE,
        attribution: { ...(identity !== undefined ? { identity } : {}), operation: SPAWN_OPERATION, runId },
      }),
    );
  }

  async function spawn(request: SpawnRequest): Promise<SpawnResult> {
    const { parentCtx, task } = request;

    // (a) disabled ⇒ refuse fail-closed (never bypass to spawn ungoverned work).
    if (!config.enabled) {
      emit(spawnDenied, { reason: "spawner disabled" }, undefined, task.taskId);
      return { spawned: false, reason: "spawner disabled" };
    }

    // (b) the parent MUST carry a genuinely-minted ValidatedIdentity (#10 anti-spoof).
    if (!isValidatedIdentity(parentCtx.identity)) {
      emit(spawnDenied, { reason: "parent identity is not a validated identity" }, undefined, task.taskId);
      return { spawned: false, reason: "parent identity is not a validated identity" };
    }
    const parent = parentCtx.identity.identity;
    const parentTier = asTier(parent.trustTier ?? TRUST_FLOOR, TRUST_FLOOR);
    const requested = request.requestedTier ?? parentTier;

    // (c) #10 OUTER BOUNDARY: cap the requested tier at the parent ceiling (and never
    // below the floor). A subagent can request DOWN, never above its parent.
    const ceilingTier = clampTier(requested, TRUST_FLOOR, parentTier);
    const clamped = tierRank(ceilingTier) !== tierRank(requested);

    emit(spawnRequested, { agentId: parent.agentId, parentTier, childTier: ceilingTier, requestedTier: requested }, parent, task.taskId);
    if (clamped) {
      emit(spawnClamped, { agentId: parent.agentId, parentTier, childTier: ceilingTier, requestedTier: requested }, parent, task.taskId);
    }

    // (d) resolve the CHILD identity under the parent (spawnedFrom = parent.agentId).
    // Only the resolver can mint a ValidatedIdentity, so the child is unforgeable.
    const resolveCtx: ResolveContext = {
      spawnedFrom: parent.agentId,
      ...(parentCtx.requestId !== undefined ? { requestId: parentCtx.requestId } : {}),
    };
    const child = resolveIdentity(childClaim({ parent, tier: ceilingTier }), resolveCtx);
    const childTier = asTier(child.identity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR);

    // (e) DEFENSE-IN-DEPTH (mirrors the orchestrator's spawnRole invariant): the
    // resolved child must NEVER out-rank the permitted ceiling. If it does, fail
    // closed rather than run an over-privileged subagent.
    if (tierRank(childTier) < tierRank(ceilingTier)) {
      throw new SpawnError(
        "escalation",
        `anti-escalation invariant violated: child "${child.identity.agentId}" tier "${childTier}" out-ranks the permitted ceiling "${ceilingTier}" (parent "${parentTier}")`,
      );
    }

    // (f) run the worker under the CHILD identity through the gate-wall-wired
    // orchestrator. Governance is enforced: a probation/untrusted child is denied
    // at promote (autonomyForTier ⇒ requiresApproval ⇒ gate-wall deny).
    const childCtx = beginOperation(child, {
      ...(parentCtx.requestId !== undefined ? { requestId: parentCtx.requestId } : {}),
      now: now(),
    });
    const workerResult = await orchestrator.run(task, childCtx);

    const childIdentitySummary: ChildIdentitySummary = {
      agentId: child.identity.agentId,
      trustTier: childTier,
      spawnedFrom: parent.agentId,
      parentTier,
      requestedTier: requested,
      clamped,
    };

    emit(
      spawnCompleted,
      {
        agentId: child.identity.agentId,
        spawnedFrom: parent.agentId,
        parentTier,
        childTier,
        requestedTier: requested,
        promoted: workerResult.promoted,
        outcome: workerResult.outcome,
      },
      child.identity,
      task.taskId,
    );

    return { spawned: true, workerResult, childIdentitySummary };
  }

  return { spawn };
}

/** The default process-wide spawner, wired to the live frozen singletons + gate-wall. */
export const subagentSpawner: SubagentSpawner = createSubagentSpawner();
