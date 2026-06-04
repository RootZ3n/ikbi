/**
 * ikbi worker-model — THE ORCHESTRATOR (freeze-critical).
 *
 * `run(task, operationContext)` is the entry. It:
 *   1. refuses when disabled (opt-in substrate);
 *   2. validates the parent is a genuine ValidatedIdentity (#10 anti-spoof);
 *   3. allocates an isolated workspace (attributed to the parent);
 *   4. dispatches the five roles IN ORDER, each under a SPAWNED identity derived
 *      with `spawnedFrom = parent` and CLAMPED to the parent's trust ceiling — a
 *      role can never out-rank its parent (#10, the load-bearing guard);
 *   5. records each role's outcome (receipts + trust) under the role's identity;
 *   6. short-circuits on the first non-success;
 *   7. PROMOTES the workspace on full success / DISCARDS otherwise (orchestrator
 *      owns the lifecycle; the integrator role supplies the decision next pass).
 *
 * All collaborators are injected (defaults wire the real frozen singletons) so the
 * freeze-critical logic is testable in isolation. `invokeModel` is resolved via a
 * LAZY import so importing this module never eagerly constructs the provider
 * singleton (which fail-closes without an egress guard).
 */

import { autonomyForTier, type AutonomyGrant } from "../../core/trust/contract.js";
import { asTier, clampTier, tierRank, TRUST_FLOOR } from "../../core/trust/index.js";
import type { RecordOutcomeInput, TrustDecision } from "../../core/trust/contract.js";
import type { TrustTier } from "../../core/identity/contract.js";
import type { AgentIdentity, IdentityClaim, IdentityKind } from "../../core/identity/contract.js";
import { isValidatedIdentity, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { OperationContext, ResolveContext, ValidatedIdentity } from "../../core/identity/index.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventBusSurface } from "../../core/events/index.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import { trust as coreTrust } from "../../core/trust/index.js";
import { workspaces as coreWorkspaces } from "../../core/workspace/index.js";
import type { DiscardResult, PromoteResult, WorkspaceEvaluation, WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";

import { builder } from "./builder.js";
import { critic } from "./critic.js";
import { integrator } from "./integrator.js";
import { scout } from "./scout.js";
import { verifier } from "./verifier.js";
import { workerModelConfig, type WorkerModelConfig } from "./config.js";
import {
  workerCompleted,
  workerFailed,
  workerRoleCompleted,
  workerRoleDispatched,
  workerStarted,
} from "./events.js";
import { CONTRACT_VERSION, toOutcomeStatus, WorkerError, WORKER_ROLES } from "./contract.js";
import type {
  RoleContext,
  RoleEngine,
  RoleFn,
  RoleResult,
  WorkerRole,
  WorkerResult,
  WorkerTask,
} from "./contract.js";

const EVENT_SOURCE = "worker-model";

/** Minimal injected surfaces (each a Pick of the real singleton's relevant method). */
export interface OrchestratorDeps {
  readonly config?: WorkerModelConfig;
  /** Resolve a role credential to a validated identity. Default: core resolveIdentity. */
  readonly resolveIdentity?: (claim: IdentityClaim, ctx?: ResolveContext) => ValidatedIdentity;
  /** Produce the credential claim for a role. Default: fail-closed (must be configured). */
  readonly roleClaim?: (role: WorkerRole) => IdentityClaim;
  readonly trust?: { recordOutcome: (input: RecordOutcomeInput) => Promise<TrustDecision> };
  readonly workspaces?: {
    allocate: (opts: { targetRepo: string; identity: AgentIdentity; baseBranch?: string; label?: string }) => Promise<WorkspaceHandle>;
    promote: (handle: WorkspaceHandle, approval: { evaluation: WorkspaceEvaluation; message?: string }) => Promise<PromoteResult>;
    discard: (handle: WorkspaceHandle) => Promise<DiscardResult>;
  };
  readonly receipts?: { append: (input: unknown, identity: AgentIdentity) => Promise<unknown> };
  readonly events?: EventBusSurface;
  readonly invokeModel?: (request: ModelRequest) => Promise<ModelResponse>;
  readonly neutralizeUntrusted?: RoleEngine["neutralizeUntrusted"];
  /** Role implementations (default: the five stubs). Tests override to drive outcomes. */
  readonly roles?: Partial<Record<WorkerRole, RoleFn>>;
}

/** A role identity spawned under the parent ceiling (#10). */
interface SpawnedRole {
  readonly identity: AgentIdentity;
  readonly kind: IdentityKind;
  readonly autonomy: AutonomyGrant;
}

const DEFAULT_ROLES: Record<WorkerRole, RoleFn> = { scout, builder, critic, verifier, integrator };

/** Lazy provider import — never construct the provider singleton at module load. */
async function lazyInvokeModel(request: ModelRequest): Promise<ModelResponse> {
  const mod = await import("../../core/provider/index.js");
  return mod.invokeModel(request);
}

/** The promote/discard decision read from the integrator's result. */
interface IntegratorDecision {
  readonly promote: boolean;
  readonly evaluation: WorkspaceEvaluation;
  readonly rationale?: string;
}

/**
 * Read the integrator's promote/discard DECISION (fail-closed, safely narrowed).
 * Promote ONLY on an affirmative, well-formed integrator promote decision —
 * integrator absent, outcome !== "success", `decision !== "promote"`, or a
 * malformed/non-approving evaluation all fall to DISCARD. Never throws on
 * malformed detail (it is an open `Record<string, unknown>`).
 */
function readIntegratorDecision(integ: RoleResult | undefined): IntegratorDecision {
  const deny = (rationale?: string): IntegratorDecision => ({
    promote: false,
    evaluation: { approved: false },
    ...(rationale !== undefined ? { rationale } : {}),
  });
  if (integ === undefined || integ.outcome !== "success") return deny();
  const detail = integ.detail;
  if (typeof detail !== "object" || detail === null) return deny();
  const d = detail as Record<string, unknown>;
  const rationale = typeof d.rationale === "string" ? d.rationale : undefined;
  if (d.decision !== "promote") return deny(rationale);
  // A promote decision MUST carry a well-formed APPROVING evaluation.
  const ev = d.evaluation;
  if (typeof ev !== "object" || ev === null || (ev as Record<string, unknown>).approved !== true) {
    return deny(rationale);
  }
  const e = ev as Record<string, unknown>;
  const evaluation: WorkspaceEvaluation = {
    approved: true,
    ...(typeof e.score === "number" ? { score: e.score } : {}),
    ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
    ...(typeof e.evaluatorId === "string" ? { evaluatorId: e.evaluatorId } : {}),
  };
  return { promote: true, evaluation, ...(rationale !== undefined ? { rationale } : {}) };
}

/** Build an orchestrator. The default deps wire the real frozen singletons. */
export function createOrchestrator(deps: OrchestratorDeps = {}) {
  const config = deps.config ?? workerModelConfig;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const roleClaim =
    deps.roleClaim ??
    ((role: WorkerRole): IdentityClaim => {
      throw new WorkerError(
        "config",
        `no credential configured for worker role "${role}" — wire roleClaim/resolveIdentity (role identity is required for #10 spawn)`,
      );
    });
  const trust = deps.trust ?? coreTrust;
  const workspaces = deps.workspaces ?? coreWorkspaces;
  const receipts = deps.receipts ?? coreReceipts;
  const events = deps.events ?? coreEvents;
  const invokeModel = deps.invokeModel ?? lazyInvokeModel;
  const neutralizeUntrusted = deps.neutralizeUntrusted ?? coreNeutralize;
  const roles: Record<WorkerRole, RoleFn> = { ...DEFAULT_ROLES, ...deps.roles };

  const engine: RoleEngine = { invokeModel, neutralizeUntrusted };

  /**
   * Spawn a role identity under the parent's trust ceiling (#10). Resolve the role
   * credential (with `spawnedFrom = parent`), then CLAMP its tier so it can NEVER
   * exceed the parent — the single most important guard in this module.
   */
  function spawnRole(role: WorkerRole, parentCtx: OperationContext): SpawnedRole {
    const parent = parentCtx.identity.identity;
    const parentTier: TrustTier = asTier(parent.trustTier ?? TRUST_FLOOR, TRUST_FLOOR);

    const resolved = resolveIdentity(roleClaim(role), {
      spawnedFrom: parent.agentId,
      ...(parentCtx.requestId !== undefined ? { requestId: parentCtx.requestId } : {}),
    });
    const rawTier: TrustTier = asTier(resolved.identity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR);

    // ANTI-ESCALATION GUARD (#10): the parent's tier is the CEILING. clampTier
    // pulls any tier MORE trusted than the parent down to the parent's tier, and
    // never below the floor — so the effective role tier is always ≤ parent.
    const effectiveTier = clampTier(rawTier, TRUST_FLOOR, parentTier);

    // Defense-in-depth invariant: must hold after the clamp. If it ever does not,
    // fail closed rather than spawn an over-privileged role.
    if (tierRank(effectiveTier) < tierRank(parentTier)) {
      throw new WorkerError(
        "escalation",
        `anti-escalation invariant violated: role "${role}" effective tier "${effectiveTier}" out-ranks parent "${parentTier}"`,
      );
    }

    const identity: AgentIdentity = Object.freeze({
      agentId: resolved.identity.agentId,
      functionalRole: role,
      trustTier: effectiveTier,
      spawnedFrom: parent.agentId,
      ...(parent.sessionId !== undefined ? { sessionId: parent.sessionId } : {}),
    });
    return { identity, kind: resolved.kind, autonomy: autonomyForTier(effectiveTier) };
  }

  /** Record a role's outcome to receipts + trust under the role's attributed identity. */
  async function recordRole(
    task: WorkerTask,
    workspace: WorkspaceHandle,
    spawned: SpawnedRole,
    result: RoleResult,
  ): Promise<void> {
    const status = toOutcomeStatus(result.outcome);
    const operation = `worker.role.${result.role}`;
    await receipts.append(
      {
        operation,
        outcome: { status, ...(result.summary !== undefined ? { detail: result.summary } : {}) },
        requestId: task.taskId,
        metadata: { role: result.role, taskId: task.taskId, workspaceId: workspace.id, outcome: result.outcome },
        project: task.targetRepo,
      },
      spawned.identity,
    );
    await trust.recordOutcome({
      agentId: spawned.identity.agentId,
      kind: spawned.kind,
      defaultTrustTier: spawned.identity.trustTier ?? TRUST_FLOOR,
      operation,
      status,
    });
  }

  /** Run a worker task under the parent operation context. */
  async function run(task: WorkerTask, parentCtx: OperationContext): Promise<WorkerResult> {
    if (!config.enabled) {
      throw new WorkerError("disabled", "worker-model is disabled (set IKBI_WORKER_MODEL_ENABLED=true to enable)");
    }
    if (!isValidatedIdentity(parentCtx.identity)) {
      throw new WorkerError("identity", "run requires an OperationContext carrying a validated identity");
    }
    const parentIdentity = parentCtx.identity.identity;

    const workspace = await workspaces.allocate({
      targetRepo: task.targetRepo,
      identity: parentIdentity,
      ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
      label: `worker:${task.taskId}`,
    });

    events.publish(
      workerStarted.create(
        { taskId: task.taskId, workspaceId: workspace.id },
        { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
      ),
    );

    const results: RoleResult[] = [];
    let overall: WorkerResult["outcome"] = "success";

    try {
      for (const role of WORKER_ROLES) {
        const spawned = spawnRole(role, parentCtx);

        events.publish(
          workerRoleDispatched.create(
            { taskId: task.taskId, role, ...(spawned.identity.trustTier !== undefined ? { tier: spawned.identity.trustTier } : {}) },
            { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
          ),
        );

        const ctx: RoleContext = {
          task,
          role,
          identity: spawned.identity,
          autonomy: spawned.autonomy,
          workspace,
          priorResults: [...results],
          engine,
        };
        const result = await roles[role](ctx);
        results.push(result);

        events.publish(
          workerRoleCompleted.create(
            { taskId: task.taskId, role, outcome: result.outcome },
            { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
          ),
        );

        await recordRole(task, workspace, spawned, result);

        if (result.outcome !== "success") {
          overall = result.outcome;
          break; // short-circuit on the first non-success
        }
      }
    } catch (err) {
      // Infrastructure failure mid-run (e.g. escalation guard): discard + fail.
      await safeDiscard(workspaces, workspace);
      const reason = err instanceof Error ? err.message : String(err);
      events.publish(
        workerFailed.create(
          { taskId: task.taskId, reason, workspaceId: workspace.id },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
      throw err;
    }

    // Terminal: ENACT the integrator's promote/discard DECISION (the integrator
    // decides; the orchestrator owns the lifecycle). Promote IFF the integrator
    // returned an affirmative, well-formed promote decision; anything else discards
    // (fail-closed). If a role hard-failed, the loop broke before the integrator ran,
    // so its result is absent → fail-closed discard. That composition is intentional.
    const decision = readIntegratorDecision(results.find((r) => r.role === "integrator"));
    let promoted = false;
    let reason: string | undefined;
    if (decision.promote) {
      const promote = await workspaces.promote(workspace, {
        evaluation: decision.evaluation, // sourced from the integrator, NOT hardcoded
        message: `worker-model: ${task.goal}${decision.rationale !== undefined ? ` — ${decision.rationale}` : ""}`,
      });
      promoted = promote.promoted;
      if (!promoted) {
        // Conflict: the workspace is reconcilable — downgrade to partial, do NOT discard.
        overall = "partial";
        reason = promote.reason ?? "promote did not land (conflict)";
      }
    } else {
      await workspaces.discard(workspace);
      reason =
        decision.rationale ??
        (overall !== "success" ? `run ended with role outcome "${overall}"` : "integrator did not approve promote");
      // Roles ran to completion but the work was judged not promotable → not a
      // misleading "success".
      if (overall === "success") overall = "rejected";
    }

    const result: WorkerResult = {
      contractVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      outcome: overall,
      roles: results,
      workspaceId: workspace.id,
      promoted,
      ...(reason !== undefined ? { reason } : {}),
    };

    if (overall === "success" || overall === "partial") {
      events.publish(
        workerCompleted.create(
          { taskId: task.taskId, outcome: overall, promoted, workspaceId: workspace.id },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
    } else {
      events.publish(
        workerFailed.create(
          { taskId: task.taskId, reason: reason ?? overall, workspaceId: workspace.id },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
    }
    return result;
  }

  return { run, spawnRole };
}

/** Best-effort discard that never masks the original error. */
async function safeDiscard(
  workspaces: NonNullable<OrchestratorDeps["workspaces"]>,
  workspace: WorkspaceHandle,
): Promise<void> {
  try {
    await workspaces.discard(workspace);
  } catch {
    // swallow — the caller is already failing; discard is best-effort cleanup.
  }
}

/** The default orchestrator, wired to the real frozen singletons. */
export const orchestrator = createOrchestrator();

/** The default entry: run a worker task under the parent operation context. */
export function runWorker(task: WorkerTask, parentCtx: OperationContext): Promise<WorkerResult> {
  return orchestrator.run(task, parentCtx);
}
