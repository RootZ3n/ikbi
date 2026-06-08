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
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceEvaluation, WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";

import { deterministicJudge } from "../deterministic-judge/index.js";
import type { BuildCandidate, JudgeResult } from "../deterministic-judge/index.js";

import type { GovernedExec } from "../governed-exec/index.js";

import { builder, createBuilder, MAX_TOOL_ITERATIONS } from "./builder.js";
import { resolveChecks } from "./checks.js";
import { builderModel, competitiveBuilderModels } from "./role-models.js";
import { critic } from "./critic.js";
import { integrator } from "./integrator.js";
import { scout } from "./scout.js";
import { createVerifier, verifier } from "./verifier.js";
import {
  MAX_COMPETITIVE_N,
  MIN_COMPETITIVE_N,
  workerModelConfig,
  type WorkerModelConfig,
} from "./config.js";
import {
  workerCompetitiveCompleted,
  workerCompetitiveJudged,
  workerCompetitiveStarted,
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
  readonly trust?: { recordOutcome: (input: RecordOutcomeInput, subject: ValidatedIdentity) => Promise<TrustDecision> };
  readonly workspaces?: {
    allocate: (opts: { targetRepo: string; identity: AgentIdentity; baseBranch?: string; label?: string }) => Promise<WorkspaceHandle>;
    promote: (handle: WorkspaceHandle, approval: { evaluation: WorkspaceEvaluation; governance?: PromoteGovernance; message?: string }) => Promise<PromoteResult>;
    discard: (handle: WorkspaceHandle) => Promise<DiscardResult>;
    /** Unified diff of the workspace vs its base (competitive mode reads it for the diff signal). Optional. */
    diff?: (handle: WorkspaceHandle) => Promise<string>;
    /**
     * Commit the workspace's working tree onto its scratch branch (git add -A + commit; returns
     * false when there is nothing to commit). The orchestrator calls this AFTER the verifier
     * succeeds (gated on autoCommit), so the scratch branch advances and promote sees a non-empty
     * diff. The workspace manager already provides it; this is the orchestrator's local view of it.
     */
    commit?: (handle: WorkspaceHandle, message: string) => Promise<boolean>;
  };
  /**
   * Governance evaluator (gate-wall). Optional in the type, but a promote REQUIRES it:
   * when absent, the promote is DENIED fail-closed (H5) — never advisory-allowed. When
   * present, its PromoteGovernance verdict is passed into promote — the workspace manager
   * is fail-closed on governance. The production orchestrator always wires it.
   */
  readonly gateWall?: {
    evaluate: (input: {
      grant: AutonomyGrant;
      // Action-tagged input (gate-wall ≥1.1.0). The orchestrator only ever gates a
      // promote; the broader GateWallAction union lives in gate-wall's contract.
      action: { kind: "promote"; task: WorkerTask; results: readonly RoleResult[] };
      identity: AgentIdentity;
    }) => Promise<PromoteGovernance>;
  };
  readonly receipts?: { append: (input: unknown, identity: AgentIdentity) => Promise<unknown> };
  readonly events?: EventBusSurface;
  readonly invokeModel?: (request: ModelRequest) => Promise<ModelResponse>;
  readonly neutralizeUntrusted?: RoleEngine["neutralizeUntrusted"];
  /** Role implementations (default: the five stubs). Tests override to drive outcomes. */
  readonly roles?: Partial<Record<WorkerRole, RoleFn>>;
  /** Competitive-mode judge (pure no-model scorer). Default: the live deterministic judge. */
  readonly judge?: { judge: (candidates: readonly BuildCandidate[]) => JudgeResult };
  /**
   * Cooperative kill checkpoint (read-only). Default: the live kill-switch (lazily
   * imported). Checked before starting + at role boundaries; a kill stops cleanly
   * (discard, no half-promote). NEVER publishes a kill — the loop only OBEYS.
   */
  readonly killCheck?: (target: { agentId?: string; runId?: string; requestId?: string }) => Promise<{ killed: boolean; signal?: { mode?: string; reason?: string } }>;
  /**
   * Governed executor the VERIFIER routes its checks through (C1). Default: the live
   * governed-exec singleton (lazily imported inside the verifier). Injectable for tests.
   * A non-allowlisted / gate-denied check fails the verifier CLOSED (never a silent pass).
   */
  readonly governedExec?: Pick<GovernedExec, "run">;
  /** The single builder model (per-candidate fallback). Default: config (IKBI_MODEL_BUILDER). */
  readonly builderModel?: string;
  /** The head-to-head competitive model list. Default: config (IKBI_COMPETITIVE_MODELS). */
  readonly competitiveModels?: readonly string[];
  /**
   * Enforce the fail-closed PROJECT-ROOT GUARD (Fix 1) + per-target check set (Fix 2) on the
   * REAL verifier/builder this run constructs: when true, both are wired with the live
   * `resolveChecks`, so a worktree with no project of its own (or whose nearest manifest is an
   * ANCESTOR — e.g. ikbi's own workspace) fails closed RED instead of vacuously passing. DEFAULT
   * OFF so unit/competitive tests that drive the real verifier/builder against synthetic paths
   * are unchanged; PRODUCTION wiring (`createProductionWorker`) turns it ON.
   */
  readonly enforceProjectRoot?: boolean;
}

/** A role identity spawned under the parent ceiling (#10). */
interface SpawnedRole {
  readonly identity: AgentIdentity;
  readonly kind: IdentityKind;
  readonly autonomy: AutonomyGrant;
  /** The GENUINE ValidatedIdentity (provenance), threaded to trust.recordOutcome as the subject. */
  readonly validated: ValidatedIdentity;
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
  const gateWall = deps.gateWall; // optional in the type — absent → promote DENIED fail-closed (H5)
  const judge = deps.judge ?? deterministicJudge; // competitive-mode scorer (pure, no model)
  const enforceProjectRoot = deps.enforceProjectRoot ?? false; // Fix 1/2 guard — production-only (off in tests)
  // Cooperative kill checkpoint (read-only). Lazy default so worker-model load never
  // eagerly constructs the kill-switch; the loop OBEYS a kill, it never publishes one.
  const killCheck =
    deps.killCheck ??
    (async (target: { agentId?: string; runId?: string; requestId?: string }) => {
      const mod = await import("../kill-switch/index.js");
      return mod.killSwitch.isKilled(target);
    });
  const roles: Record<WorkerRole, RoleFn> = { ...DEFAULT_ROLES, ...deps.roles };

  // Per-candidate builder models (the head-to-head shootout). Default to config; injectable
  // for tests. When `competitiveModelList` is set, competitive mode races one candidate per
  // listed model; otherwise every candidate uses the single builder model (old behavior).
  const singleBuilderModel = deps.builderModel ?? builderModel();
  const competitiveModelList = deps.competitiveModels ?? competitiveBuilderModels();

  const engine: RoleEngine = { invokeModel, neutralizeUntrusted };

  /**
   * The verifier for THIS run (C1). Honors an injected `deps.roles.verifier` (tests),
   * otherwise builds the governed + script-integrity-guarded verifier bound to the run's
   * parent ctx (the validated identity governed-exec needs — the spawned role identity is
   * not a minted ValidatedIdentity) and the workspace diff (LAYER-2 integrity source).
   */
  function verifierFor(parentCtx: OperationContext): RoleFn {
    if (deps.roles?.verifier !== undefined) return deps.roles.verifier;
    return createVerifier({
      ...(deps.governedExec !== undefined ? { governedExec: deps.governedExec } : {}),
      parentCtx,
      ...(workspaces.diff !== undefined ? { diff: (ws: WorkspaceHandle) => workspaces.diff!(ws) } : {}),
      // PROJECT-ROOT GUARD + per-target check set (Fix 1/2): wired ONLY in production
      // (enforceProjectRoot), so a no-manifest / wrong-repo worktree fails closed RED.
      ...(enforceProjectRoot ? { resolveChecks: (ws: string) => resolveChecks(ws) } : {}),
    });
  }

  /**
   * The builder for THIS run. Honors an injected `deps.roles.builder` (tests); otherwise
   * builds it with governedExec + the run's parent ctx — the SAME module-internal injection
   * the verifier uses — so its in-loop `run_checks` runs the verifier's EXACT checks through
   * the same governed path. NO contract change: governedExec/parentCtx are not RoleContext fields.
   */
  function builderFor(parentCtx: OperationContext): RoleFn {
    return builderForModel(parentCtx);
  }

  /** Like `builderFor`, but for a specific per-candidate model (the head-to-head shootout). */
  function builderForModel(parentCtx: OperationContext, modelOverride?: string): RoleFn {
    if (deps.roles?.builder !== undefined) return deps.roles.builder;
    return createBuilder({
      ...(deps.governedExec !== undefined ? { governedExec: deps.governedExec } : {}),
      parentCtx,
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      // Same resolved set the verifier uses (Fix 1/2), wired ONLY in production (enforceProjectRoot).
      ...(enforceProjectRoot ? { resolveChecks: (ws: string) => resolveChecks(ws) } : {}),
    });
  }

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
    return { identity, kind: resolved.kind, autonomy: autonomyForTier(effectiveTier), validated: resolved };
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
    // Thread the GENUINE ValidatedIdentity as the subject (provenance) — recordOutcome
    // derives agentId/kind from it and sources the starting tier from the registry.
    await trust.recordOutcome(
      {
        agentId: spawned.identity.agentId,
        kind: spawned.kind,
        defaultTrustTier: spawned.identity.trustTier ?? TRUST_FLOOR,
        operation,
        status,
      },
      spawned.validated,
    );
  }

  /** Cooperative kill checkpoint: does an active kill target THIS run? (read-only; never publishes). */
  async function killHalt(task: WorkerTask, parentIdentity: AgentIdentity, parentCtx: OperationContext): Promise<string | undefined> {
    const k = await killCheck({ agentId: parentIdentity.agentId, runId: task.taskId, ...(parentCtx.requestId !== undefined ? { requestId: parentCtx.requestId } : {}) });
    return k.killed ? `halted by kill-switch (${k.signal?.mode ?? "soft"})` : undefined;
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

    // COMPETITIVE BUILD MODE (default OFF). When on, take the N-workspace path and
    // return; otherwise fall through to the single-workspace path below — BYTE-UNCHANGED.
    if (config.competitive === true) {
      // N reconciliation: a competitive MODEL LIST means race exactly the listed models —
      // one candidate per model, capped at MAX_COMPETITIVE_N. No list ⇒ competitiveN
      // candidates all on the single builder model (the old workspace-isolation behavior).
      const n =
        competitiveModelList !== undefined && competitiveModelList.length > 0
          ? Math.min(MAX_COMPETITIVE_N, competitiveModelList.length)
          : Math.max(MIN_COMPETITIVE_N, Math.min(MAX_COMPETITIVE_N, config.competitiveN ?? MIN_COMPETITIVE_N));
      return runCompetitive(task, parentCtx, parentIdentity, n);
    }

    // COOPERATIVE KILL CHECKPOINT (prevent NEW work): if a kill targets this run, do
    // not allocate or start anything.
    const preKill = await killHalt(task, parentIdentity, parentCtx);
    if (preKill !== undefined) {
      events.publish(workerFailed.create({ taskId: task.taskId, reason: preKill }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } }));
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason: preKill };
    }

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
    let killedReason: string | undefined;

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
        const roleFn = role === "verifier" ? verifierFor(parentCtx) : role === "builder" ? builderFor(parentCtx) : roles[role];
        const result = await roleFn(ctx);
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

        // COMMIT the VERIFIED-good working tree, gated on autoCommit. The builder's edits live
        // in the working tree (what run_checks + the verifier both check); without committing,
        // the scratch branch HEAD == base HEAD and promote sees an empty diff. After the verifier
        // SUCCEEDS, capture that verified state so the integrator (next role) promotes a real diff.
        // Gated on the worker's autonomy: trusted/operator (autoCommit) commit; lower tiers do not.
        if (role === "verifier" && spawned.autonomy.autoCommit && workspaces.commit !== undefined) {
          await workspaces.commit(workspace, `ikbi: ${task.goal}`);
        }

        // COOPERATIVE KILL CHECKPOINT (role boundary): obey a kill before the NEXT role.
        // "hard"/"soft" both stop here at role granularity (true mid-role abort deferred).
        killedReason = await killHalt(task, parentIdentity, parentCtx);
        if (killedReason !== undefined) {
          overall = "rejected";
          break;
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

    // Terminal: a KILL halted the run mid-loop ⇒ discard cleanly (NEVER promote a
    // half-run), surface the kill, return.
    if (killedReason !== undefined) {
      await safeDiscard(workspaces, workspace);
      events.publish(
        workerFailed.create(
          { taskId: task.taskId, reason: killedReason, workspaceId: workspace.id },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: results, workspaceId: workspace.id, promoted: false, reason: killedReason };
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
      if (gateWall === undefined) {
        // H5 FAIL-CLOSED: a promote REQUIRES gate-wall authorization. An unwired
        // gate-wall is a misconfiguration; the safe response to "can't verify
        // authorization" is to DENY — never advisory-allow an irreversible promote.
        // Discard the workspace, land nothing, reject (same discipline as the verifier's
        // no-diff fail-closed).
        await workspaces.discard(workspace);
        overall = "rejected";
        reason = "gate-wall not wired — promote denied (fail-closed)";
      } else {
        // GOVERNANCE (gate-wall): the workspace manager is fail-closed on governance.
        // The governance subject is the run's parent tier grant (derived here — no
        // per-run grant is in scope at the promote point).
        const governanceGrant = autonomyForTier(asTier(parentIdentity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
        const governance: PromoteGovernance = await gateWall.evaluate({ grant: governanceGrant, action: { kind: "promote", task, results }, identity: parentIdentity });
        const promote = await workspaces.promote(workspace, {
          evaluation: decision.evaluation, // sourced from the integrator, NOT hardcoded
          governance,
          message: `worker-model: ${task.goal}${decision.rationale !== undefined ? ` — ${decision.rationale}` : ""}`,
        });
        promoted = promote.promoted;
        if (!promoted) {
          // Conflict: the workspace is reconcilable — downgrade to partial, do NOT discard.
          overall = "partial";
          reason = promote.reason ?? "promote did not land (conflict)";
        }
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

  // ── COMPETITIVE BUILD MODE (AMG) ────────────────────────────────────────────

  /** Dispatch one role in one workspace (events + recordRole), returning its result.
   *  `roleFnOverride` lets the competitive loop inject a per-candidate builder (its own model). */
  async function dispatchRole(role: WorkerRole, spawned: SpawnedRole, task: WorkerTask, workspace: WorkspaceHandle, priorResults: readonly RoleResult[], parentCtx: OperationContext, roleFnOverride?: RoleFn): Promise<RoleResult> {
    events.publish(
      workerRoleDispatched.create(
        { taskId: task.taskId, role, ...(spawned.identity.trustTier !== undefined ? { tier: spawned.identity.trustTier } : {}) },
        { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
      ),
    );
    const ctx: RoleContext = { task, role, identity: spawned.identity, autonomy: spawned.autonomy, workspace, priorResults: [...priorResults], engine };
    // The verifier (C1) and the builder (its in-loop run_checks) run the governed path
    // bound to the run ctx (parentCtx is the minted ValidatedIdentity governed-exec needs).
    const roleFn = roleFnOverride ?? (role === "verifier" ? verifierFor(parentCtx) : role === "builder" ? builderFor(parentCtx) : roles[role]);
    const result = await roleFn(ctx);
    events.publish(
      workerRoleCompleted.create(
        { taskId: task.taskId, role, outcome: result.outcome },
        { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
      ),
    );
    await recordRole(task, workspace, spawned, result);
    return result;
  }

  /** Best-effort diff line-count (the diff SIGNAL is neutral when unavailable). */
  async function safeDiffLines(workspace: WorkspaceHandle): Promise<number | undefined> {
    if (workspaces.diff === undefined) return undefined;
    try {
      const d = await workspaces.diff(workspace);
      return d.length === 0 ? 0 : d.split("\n").length;
    } catch {
      return undefined;
    }
  }

  /** Map a builder + verifier result (+ diff) to the objective BuildCandidate the judge scores. */
  function buildCandidate(workspace: WorkspaceHandle, builderResult: RoleResult, verifierResult: RoleResult | undefined, diffLines: number | undefined): BuildCandidate {
    const bd = (builderResult.detail ?? {}) as Record<string, unknown>;
    const toolRounds = typeof bd.toolRounds === "number" ? bd.toolRounds : 0;
    const filesWritten = Array.isArray(bd.filesWritten) ? bd.filesWritten.length : 0;
    const rejectedToolCalls = Array.isArray(bd.rejectedToolCalls) ? bd.rejectedToolCalls.length : 0;
    const stopReason = typeof bd.stopReason === "string" ? bd.stopReason : builderResult.outcome === "success" ? "stop" : "error";
    const v = readVerifier(verifierResult);
    return {
      workspaceId: workspace.id,
      typecheckPass: v.typecheckPass,
      testsPass: v.testsPass,
      ...(v.testCount !== undefined ? { testCount: v.testCount } : {}),
      toolRounds,
      maxToolRounds: MAX_TOOL_ITERATIONS,
      rejectedToolCalls,
      filesWritten,
      ...(diffLines !== undefined ? { diffLines } : {}),
      stopReason,
    };
  }

  /** Run N independent build attempts, judge them, promote the winner, discard the rest. */
  async function runCompetitive(task: WorkerTask, parentCtx: OperationContext, parentIdentity: AgentIdentity, n: number): Promise<WorkerResult> {
    events.publish(
      workerCompetitiveStarted.create(
        { taskId: task.taskId, candidateCount: n },
        { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } },
      ),
    );

    // COOPERATIVE KILL CHECKPOINT (prevent NEW work): do not allocate when killed.
    const preKill = await killHalt(task, parentIdentity, parentCtx);
    if (preKill !== undefined) {
      events.publish(workerFailed.create({ taskId: task.taskId, reason: preKill }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason: preKill };
    }

    const handles: WorkspaceHandle[] = [];
    const rolesByWs = new Map<string, RoleResult[]>();
    try {
      // 1. allocate N isolated worktrees (the workspace layer is already concurrent-capable).
      for (let i = 0; i < n; i += 1) {
        handles.push(
          await workspaces.allocate({
            targetRepo: task.targetRepo,
            identity: parentIdentity,
            ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
            label: `worker:${task.taskId}:c${i}`,
          }),
        );
      }

      // 2. scout ONCE (shared, read-only, in the first worktree's clean base state) —
      //    its findings seed every builder. (Per-workspace scout is a future option.)
      const scoutResult = await dispatchRole("scout", spawnRole("scout", parentCtx), task, handles[0]!, [], parentCtx);

      // 3. builder + verifier PER workspace (sequential in v1; parallelism is a future
      //    optimization). Each builder writes into ITS worktree; each verifier checks ITS
      //    worktree. The per-workspace builder is spawned through the SAME #10 clamp.
      const candidates: BuildCandidate[] = [];
      for (let ci = 0; ci < handles.length; ci += 1) {
        const ws = handles[ci]!;
        // COOPERATIVE KILL CHECKPOINT (between candidates): stop cleanly, discard EVERY
        // workspace (no half-promote), surface the kill.
        const killReason = await killHalt(task, parentIdentity, parentCtx);
        if (killReason !== undefined) {
          for (const h of handles) await safeDiscard(workspaces, h);
          events.publish(workerFailed.create({ taskId: task.taskId, reason: killReason, workspaceId: handles[0]?.id ?? ws.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
          return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: rolesByWs.get(handles[0]?.id ?? "") ?? [], ...(handles[0] !== undefined ? { workspaceId: handles[0].id } : {}), promoted: false, reason: killReason };
        }
        // HEAD-TO-HEAD: candidate ci races its OWN model (the Nth listed model, or the single
        // builder model as fallback) in its OWN worktree — each with the full run_checks rail.
        const candidateModel = competitiveModelList?.[ci] ?? singleBuilderModel;
        const candidateBuilder = builderForModel(parentCtx, candidateModel);
        const builderResult = await dispatchRole("builder", spawnRole("builder", parentCtx), task, ws, [scoutResult], parentCtx, candidateBuilder);
        let verifierResult: RoleResult | undefined;
        const verifierSpawn = spawnRole("verifier", parentCtx);
        if (builderResult.outcome === "success") {
          verifierResult = await dispatchRole("verifier", verifierSpawn, task, ws, [scoutResult, builderResult], parentCtx);
        }
        // COMMIT this candidate's VERIFIED-good work (gated on autoCommit) BEFORE the judge —
        // safeDiffLines + buildCandidate read the committed diff, and the winner is promoted, so
        // the candidate's scratch branch must advance first or its diff is empty.
        if (verifierResult?.outcome === "success" && verifierSpawn.autonomy.autoCommit && workspaces.commit !== undefined) {
          await workspaces.commit(ws, `ikbi: ${task.goal}`);
        }
        rolesByWs.set(ws.id, [scoutResult, builderResult, ...(verifierResult !== undefined ? [verifierResult] : [])]);
        candidates.push(buildCandidate(ws, builderResult, verifierResult, await safeDiffLines(ws)));
      }

      // COOPERATIVE KILL CHECKPOINT (before the IRREVERSIBLE boundary — C6): a kill that
      // arrives during the FINAL candidate (after the between-candidates check) must NOT
      // judge or promote. Discard EVERY workspace (no half-promote), surface the kill,
      // return rejected. Every promote has a kill check immediately before it.
      const finalKill = await killHalt(task, parentIdentity, parentCtx);
      if (finalKill !== undefined) {
        for (const h of handles) await safeDiscard(workspaces, h);
        const repId = handles[0]?.id;
        events.publish(workerFailed.create({ taskId: task.taskId, reason: finalKill, ...(repId !== undefined ? { workspaceId: repId } : {}) }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: repId !== undefined ? rolesByWs.get(repId) ?? [] : [], ...(repId !== undefined ? { workspaceId: repId } : {}), promoted: false, reason: finalKill };
      }

      // 4. JUDGE — pure, no model call. Selects the winner (or null = fail-closed).
      const verdict = judge.judge(candidates);
      events.publish(
        workerCompetitiveJudged.create(
          { taskId: task.taskId, candidateCount: n, winnerWorkspaceId: verdict.winner?.workspaceId ?? null },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } },
        ),
      );

      // 5a. NO-PASS (fail-closed): the judge rejected all → discard EVERY workspace, promote nothing.
      if (verdict.winner === null) {
        for (const ws of handles) await safeDiscard(workspaces, ws);
        const reason = verdict.reason ?? "no candidate passed the judge";
        const repId = verdict.ranking[0]?.workspaceId ?? handles[0]?.id;
        events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: null }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        events.publish(workerFailed.create({ taskId: task.taskId, reason, ...(repId !== undefined ? { workspaceId: repId } : {}) }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: repId !== undefined ? rolesByWs.get(repId) ?? [] : [], ...(repId !== undefined ? { workspaceId: repId } : {}), promoted: false, reason };
      }

      // 5b. WINNER: promote it (gate-wall STILL governs), discard ALL losers.
      const winner = handles.find((h) => h.id === verdict.winner!.workspaceId)!;
      const winnerRoles = rolesByWs.get(winner.id) ?? [];

      // H5 FAIL-CLOSED: a promote REQUIRES gate-wall authorization. No gate-wall ⇒ DENY
      // (never advisory-allow an irreversible promote). Discard EVERY workspace, land
      // nothing, reject.
      if (gateWall === undefined) {
        for (const ws of handles) await safeDiscard(workspaces, ws);
        const reason = "gate-wall not wired — promote denied (fail-closed)";
        events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        events.publish(workerFailed.create({ taskId: task.taskId, reason, workspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: winnerRoles, workspaceId: winner.id, promoted: false, reason };
      }

      const governanceGrant = autonomyForTier(asTier(parentIdentity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
      const governance: PromoteGovernance = await gateWall.evaluate({ grant: governanceGrant, action: { kind: "promote", task, results: winnerRoles }, identity: parentIdentity });
      const promote = await workspaces.promote(winner, {
        evaluation: { approved: true, score: verdict.winner.composite, evaluatorId: "deterministic-judge" },
        governance,
        message: `worker-model (competitive): ${task.goal}`,
      });
      for (const ws of handles) if (ws.id !== winner.id) await safeDiscard(workspaces, ws);

      let promoted = promote.promoted;
      let outcome: WorkerResult["outcome"] = "success";
      let reason: string | undefined;
      if (!promoted) {
        // The winner did not land — gate denial or conflict. Fail-closed: discard the
        // winner too (so EVERY workspace is now discarded). A conflict is reconcilable
        // (partial); a governance deny is a rejection.
        await safeDiscard(workspaces, winner);
        outcome = promote.conflicts !== undefined && promote.conflicts.length > 0 ? "partial" : "rejected";
        reason = promote.reason ?? "winner not promoted (gate denied or conflict)";
      }

      events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      if (outcome === "success" || outcome === "partial") {
        events.publish(workerCompleted.create({ taskId: task.taskId, outcome, promoted, workspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      } else {
        events.publish(workerFailed.create({ taskId: task.taskId, reason: reason ?? outcome, workspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      }
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome, roles: winnerRoles, workspaceId: winner.id, promoted, ...(reason !== undefined ? { reason } : {}) };
    } catch (err) {
      // Mid-run failure (allocation / role / judge): discard EVERY allocated workspace —
      // no leaked worktree — then fail.
      for (const ws of handles) await safeDiscard(workspaces, ws);
      const reason = err instanceof Error ? err.message : String(err);
      events.publish(workerFailed.create({ taskId: task.taskId, reason, ...(handles[0] !== undefined ? { workspaceId: handles[0].id } : {}) }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      throw err;
    }
  }

  return { run, spawnRole };
}

/** Parse the verifier's check results into the candidate's pass flags + (best-effort) test count. */
function readVerifier(verifierResult: RoleResult | undefined): { typecheckPass: boolean; testsPass: boolean; testCount?: { passed: number; total: number } } {
  // Builder failed (no verify ran) ⇒ both gates fail.
  if (verifierResult === undefined) return { typecheckPass: false, testsPass: false };
  const detail = (verifierResult.detail ?? {}) as Record<string, unknown>;
  const checks = Array.isArray(detail.checks) ? (detail.checks as Array<Record<string, unknown>>) : [];
  const find = (name: string) => checks.find((c) => c.name === name);
  const typecheck = find("typecheck");
  const test = find("test");
  const typecheckPass = typecheck !== undefined && typecheck.exitCode === 0;
  const testsPass = test !== undefined && test.exitCode === 0;
  const testCount = test !== undefined && typeof test.outputTail === "string" ? parseTestCount(test.outputTail) : undefined;
  return { typecheckPass, testsPass, ...(testCount !== undefined ? { testCount } : {}) };
}

/** Parse the node:test summary tail ("# tests N" / "# pass N") into a count, when present. */
function parseTestCount(output: string): { passed: number; total: number } | undefined {
  const tests = /# tests (\d+)/.exec(output);
  const pass = /# pass (\d+)/.exec(output);
  if (tests !== null && pass !== null) return { passed: Number(pass[1]), total: Number(tests[1]) };
  return undefined;
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
