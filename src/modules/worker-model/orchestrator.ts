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

// Escalation (ADDITIVE, hook-only): the orchestrator folds hard signals across the
// scoring roles and asks the escalation engine whether a higher tier is warranted,
// emitting `escalation.*` events. It NEVER alters dispatch/promote/discard — the
// actual model swap + retry is a separately-reviewed follow-up. See observeEscalation.
import {
  escalationConfig,
  escalationEngine,
  escalationEvaluated,
  escalationTriggered,
  escalationDeclined,
} from "../escalation/index.js";
import type { EscalationSignals } from "../escalation/index.js";

import type { ExecRequest, GovernedExec } from "../governed-exec/index.js";
import type { DependencyInstall } from "../dependency-install/contract.js";

import { builder, createBuilder, MAX_TOOL_ITERATIONS } from "./builder.js";
import { createPatchsmith } from "./patchsmith.js";
import { runTournament } from "./tournament.js";
import type { CandidateRun, CandidateSpec, ShadowVerification, TournamentEngine, TournamentEvent } from "./tournament.js";
import { resolveChecks, resolveCheckTimeoutMs, workingTreePackageJsonDiff, workingTreePlanningDiff } from "./checks.js";
import { builderModel, competitiveBuilderModels } from "./role-models.js";
import { createCritic, critic } from "./critic.js";
import { integrator } from "./integrator.js";
import { createScout, scout } from "./scout.js";
import { createVerifier, verifier } from "./verifier.js";
import { resolveRetrievalMode, resolveVerificationMode } from "./modes.js";
import type { ProjectRetrievalApi } from "../project-retrieval/index.js";
import {
  type BuilderMode,
  MAX_CANDIDATE_MODELS,
  MAX_COMPETITIVE_N,
  MIN_COMPETITIVE_N,
  workerModelConfig,
  type WorkerModelConfig,
} from "./config.js";
import {
  workerCompetitiveCompleted,
  workerCompetitiveJudged,
  workerCompetitiveStarted,
  workerTournamentStarted,
  workerTournamentJudged,
  workerTournamentCompleted,
  workerApprovalRequested,
  workerApprovalResolved,
  workerBuilderActivity,
  workerCompleted,
  workerFailed,
  workerRoleCompleted,
  workerRoleDispatched,
  workerStarted,
  workerVerification,
  workerFixLoopCompleted,
  workerCriticFixLoopCompleted,
} from "./events.js";
import { CONTRACT_VERSION, toOutcomeStatus, WorkerError, WORKER_ROLES } from "./contract.js";
import { runIterativeLoop, DEFAULT_MAX_FIX_ITERATIONS, extractVerifierCheckResult } from "./iterative-loop.js";
import { runCriticFixLoop, isRetryableCriticFail } from "./critic-fix-loop.js";
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

/** A mutable signal accumulator folded across roles within one run (see observeEscalation). */
interface MutableEscalationSignals {
  schemaFailures: number;
  retryCount: number;
  scoutScore?: number;
  contextPressure: number;
  criticRejected: boolean;
  verificationFailed: boolean;
  stopReason?: string;
  rejectedToolCalls: number;
}

/** Handoff-only context captured from roles (not scored). */
interface EscalationHandoffFields {
  scoutFindings?: string;
  goalAlignment?: { status: string; summary: string; missingFiles: readonly string[] };
  criticFeedback?: string;
  verificationDetails?: string;
}

// ── DEPENDENCY INSTALL: ensure worktree has node_modules ──────────────────────

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Install dependencies in the worktree if node_modules is missing.
 *
 * H2: delegates to the HARDENED `dependency-install` module — gate-walled, lockfile-only
 * (frozen), registry-allowlisted, and receipted — instead of running `pnpm install
 * --no-frozen-lockfile` inline (which bypassed every one of those controls). A lazy import
 * keeps the module-load graph acyclic and lets tests inject a double. Non-fatal: if the
 * install is denied or fails, the builder will see the error in run_checks and can react.
 */
async function installWorkspaceDeps(
  workspace: WorkspaceHandle,
  parentCtx: OperationContext,
  installer?: DependencyInstall,
): Promise<void> {
  const worktreePath = workspace.path;
  const pkgJson = join(worktreePath, "package.json");
  const nodeModules = join(worktreePath, "node_modules");

  if (!existsSync(pkgJson) || existsSync(nodeModules)) return; // nothing to install

  // Detect package manager from lockfile (the hardened installer is frozen-lockfile-only;
  // an npm-locked repo uses `npm ci`, otherwise default to pnpm's frozen install).
  const hasPnpmLock = existsSync(join(worktreePath, "pnpm-lock.yaml"));
  const hasNpmLock = existsSync(join(worktreePath, "package-lock.json"));
  const pm: "pnpm" | "npm" = hasNpmLock && !hasPnpmLock ? "npm" : "pnpm";

  try {
    const di = installer ?? (await import("../dependency-install/index.js")).dependencyInstall;
    await di.run({ parentCtx, workspace, packageManager: pm });
  } catch {
    // Non-fatal: the builder will see missing deps in run_checks
  }
}

/** Coerce an unknown detail field to a finite number, else undefined. */
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Fold one role's hard signals into the run-level accumulator. Reads the role's
 * open `detail` shape DEFENSIVELY (every field optional) so a shape change never
 * throws into the run. Pure bookkeeping — no events, no decision.
 */
function foldRoleSignals(
  role: WorkerRole,
  result: RoleResult,
  acc: MutableEscalationSignals,
  handoff: EscalationHandoffFields,
): void {
  const detail = (result.detail ?? {}) as Record<string, unknown>;
  if (role === "scout") {
    const s = asNumber(detail.score);
    if (s !== undefined) acc.scoutScore = s;
    if (typeof detail.brief === "string") handoff.scoutFindings = detail.brief;
    // Layer 2: capture goal-file alignment from the scout
    const ga = detail.goalAlignment as { status?: string; summary?: string; missingFiles?: readonly string[] } | undefined;
    if (ga !== undefined && typeof ga.status === "string") {
      handoff.goalAlignment = { status: ga.status, summary: ga.summary ?? "", missingFiles: ga.missingFiles ?? [] };
    }
  } else if (role === "builder") {
    const policy = Array.isArray(detail.policyViolations) ? detail.policyViolations.length : Array.isArray(detail.rejectedToolCalls) ? detail.rejectedToolCalls.length : 0;
    const format = Array.isArray(detail.toolFormatErrors) ? detail.toolFormatErrors.length : 0;
    acc.schemaFailures += format;
    acc.rejectedToolCalls += policy;
    const retries = asNumber(detail.retryCount) ?? asNumber(detail.bareStops);
    if (retries !== undefined) acc.retryCount += retries;
    const pct = asNumber(detail.contextPercent);
    if (pct !== undefined) acc.contextPressure = Math.min(1, Math.max(0, pct / 100));
    if (typeof detail.stopReason === "string") acc.stopReason = detail.stopReason;
  } else if (role === "critic") {
    if (result.outcome === "failure" || result.outcome === "rejected") acc.criticRejected = true;
    if (typeof result.summary === "string") handoff.criticFeedback = result.summary;
  } else if (role === "verifier") {
    if (result.outcome !== "success") acc.verificationFailed = true;
    const reason = typeof detail.reason === "string" ? detail.reason : result.summary;
    if (typeof reason === "string") handoff.verificationDetails = reason;
  }
}

/**
 * ADDITIVE escalation hook (chosen integration depth: observe-only). After a scoring
 * role completes, fold its signals and — for the builder/critic/verifier roles — ask
 * the escalation engine whether a higher tier is warranted, emitting `escalation.*`
 * events with the full score breakdown. The run's worker roles execute at the cheap
 * (`worker`) tier, so evaluation runs against that tier. This NEVER mutates the run:
 * no model swap, no retry, no change to promote/discard. Best-effort — it must never
 * throw into the dispatch loop, so the whole body is guarded.
 */
function observeEscalation(
  events: EventBusSurface,
  task: WorkerTask,
  role: WorkerRole,
  result: RoleResult,
  acc: MutableEscalationSignals,
  handoff: EscalationHandoffFields,
  identity: AgentIdentity,
): void {
  try {
    foldRoleSignals(role, result, acc, handoff);
    if (!escalationConfig.enabled) return;
    // Only the roles that carry escalation-relevant signal trigger an evaluation.
    if (role !== "builder" && role !== "critic" && role !== "verifier") return;

    const signals: EscalationSignals = { ...acc };
    const decision = escalationEngine.evaluate({
      taskId: task.taskId,
      currentTier: "worker",
      goal: task.goal,
      signals,
      ...(handoff.scoutFindings !== undefined ? { scoutFindings: handoff.scoutFindings } : {}),
      ...(handoff.criticFeedback !== undefined ? { criticFeedback: handoff.criticFeedback } : {}),
      ...(handoff.verificationDetails !== undefined ? { verificationDetails: handoff.verificationDetails } : {}),
    });

    // Emitted BY the worker-model orchestrator, so the source is worker-model; the
    // escalation.* event TYPE namespaces them. (#identity attribution: the parent.)
    const attribution = { source: EVENT_SOURCE, attribution: { identity, operation: "escalation.evaluate", runId: task.taskId } };
    events.publish(
      escalationEvaluated.create(
        { taskId: task.taskId, currentTier: decision.currentTier, total: decision.score.total, shouldEscalate: decision.score.shouldEscalate, escalate: decision.escalate },
        attribution,
      ),
    );
    if (decision.escalate && decision.targetTier !== undefined) {
      events.publish(
        escalationTriggered.create(
          { taskId: task.taskId, from: decision.currentTier, to: decision.targetTier, total: decision.score.total, requiresApproval: decision.requiresApproval, ...(decision.targetModel !== undefined ? { targetModel: decision.targetModel } : {}) },
          attribution,
        ),
      );
      // CRITICAL FIX (C1): recordEscalation MUST be called after evaluate returns
      // escalate:true — otherwise the per-task cap never advances and the engine
      // recommends escalation indefinitely. The engine's two-phase API (evaluate is
      // idempotent; recordEscalation commits the transition) is correct by design,
      // but the orchestrator must maintain the coupling.
      escalationEngine.recordEscalation(task.taskId, decision.currentTier, decision.targetTier);
    } else if (decision.declineReason !== undefined) {
      events.publish(
        escalationDeclined.create(
          { taskId: task.taskId, currentTier: decision.currentTier, total: decision.score.total, reason: decision.declineReason },
          attribution,
        ),
      );
    }
  } catch {
    // Escalation observability is ADVISORY — a fold/eval/publish failure never breaks the run.
  }
}

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
    /**
     * Retain a FAILED build's workspace (mark it terminal-failed but KEEP the worktree on disk
     * for inspection) instead of discarding it. Optional: when absent (older injected doubles)
     * the orchestrator falls back to discard, so behavior is unchanged. The real manager provides
     * it; `ikbi clean` reclaims retained workspaces later. (Bug 2 fix.)
     */
    retain?: (handle: WorkspaceHandle, reason: string) => Promise<DiscardResult>;
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
  /**
   * Dependency installer (H2). Default: the live hardened `dependency-install` singleton
   * (lazily imported). The orchestrator calls it once per run to populate node_modules in a
   * fresh worktree, through the gate-walled / lockfile-only / receipted path. Injectable for tests.
   */
  readonly dependencyInstall?: DependencyInstall;
  /**
   * LIVE OUTPUT SINK (SG-1): when set, every governed check (verifier + builder run_checks)
   * STREAMS its stdout/stderr here chunk-by-chunk as it runs — so the operator sees long
   * check output live, not just the buffered tail at the end. The CLI wires it to stdout.
   */
  readonly onExecOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * HUMAN-APPROVAL GATE (SG-10, opt-in). When set, after a build VERIFIES and the integrator
   * decides to promote, the orchestrator pauses and calls this for the operator's decision —
   * `false` DISCARDS instead of promoting. Absent ⇒ no gate (backward compatible). The CLI
   * wires a stdin y/N prompt when IKBI_REQUIRE_APPROVAL is set.
   */
  readonly requestApproval?: (req: { taskId: string; workspaceId: string; goal: string }) => Promise<boolean>;
  /** The single builder model (per-candidate fallback). Default: config (IKBI_MODEL_BUILDER). */
  readonly builderModel?: string;
  /** The head-to-head competitive model list. Default: config (IKBI_COMPETITIVE_MODELS). */
  readonly competitiveModels?: readonly string[];
  /**
   * The TOURNAMENT candidate model list. Default: the task's own `candidates`, else config
   * (IKBI_CANDIDATE_MODELS). A non-empty list takes the candidate-tournament path (#tournament).
   */
  readonly candidateModels?: readonly string[];
  /**
   * Apply a unified diff into a CLEAN workspace and commit it (the tournament's SHADOW REPLAY).
   * Default: a governed `git apply` + commit (see `defaultApplyDiff`). Injectable for tests so the
   * tournament's shadow-replay can be driven without a real worktree. Returns whether the diff both
   * applied AND produced a committed change (an empty/failed apply ⇒ `applied: false`).
   */
  readonly applyDiff?: (workspace: WorkspaceHandle, diff: string) => Promise<{ applied: boolean; reason?: string }>;
  /**
   * Enforce the fail-closed PROJECT-ROOT GUARD (Fix 1) + per-target check set (Fix 2) on the
   * REAL verifier/builder this run constructs: when true, both are wired with the live
   * `resolveChecks`, so a worktree with no project of its own (or whose nearest manifest is an
   * ANCESTOR — e.g. ikbi's own workspace) fails closed RED instead of vacuously passing. DEFAULT
   * OFF so unit/competitive tests that drive the real verifier/builder against synthetic paths
   * are unchanged; PRODUCTION wiring (`createProductionWorker`) turns it ON.
   */
  readonly enforceProjectRoot?: boolean;
  /**
   * Env source for production mode resolution (verification + retrieval). Default: process.env.
   * Injectable so wiring tests can prove "production ⇒ ladder/index" and the explicit
   * `IKBI_VERIFY=legacy` / `IKBI_RETRIEVAL=legacy` overrides deterministically.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Project-retrieval API the PRODUCTION scout uses under index retrieval. Default: the live
   * singleton (lazily imported inside the scout). Injectable so a wiring test can prove the
   * production scout takes the index path without touching the filesystem.
   */
  readonly retrieval?: ProjectRetrievalApi;
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
  // HARDENED-BY-DEFAULT (production): the verification + retrieval modes this run wires. The
  // production wiring (`createProductionWorker` ⇒ enforceProjectRoot) defaults to ladder + index;
  // a bare/test orchestrator stays legacy unless env opts in; an explicit IKBI_VERIFY/RETRIEVAL=legacy
  // opts back out. These are the modes surfaced for observability (startup event + result + receipts).
  const modeEnv = deps.env ?? process.env;
  const verificationMode = resolveVerificationMode(modeEnv, { production: enforceProjectRoot });
  const retrievalMode = resolveRetrievalMode(modeEnv, { production: enforceProjectRoot });
  // Bug 2: retain (don't discard) a FAILED build's workspace so its work survives for inspection.
  const retainFailedWorkspaces = config.retainFailedWorkspaces ?? true;
  const requestApproval = deps.requestApproval; // SG-10 human-approval gate (undefined ⇒ no gate)

  // H3: enforce a per-role WALL-CLOCK timeout. Only the builder self-checks between model calls;
  // a hung scout/critic/verifier/integrator (a stuck model stream, a wedged subprocess) would
  // otherwise run unbounded. On timeout the role FAILS — a non-success outcome short-circuits the
  // run through the normal failure path (discard/retain). The abandoned promise is left to settle
  // and is ignored (JS cannot cancel it). `roleTimeoutMs <= 0` disables the guard.
  const roleTimeoutMs = config.roleTimeoutMs;
  async function runRoleFn(role: WorkerRole, roleFn: RoleFn, ctx: RoleContext, timeoutOverrideMs?: number): Promise<RoleResult> {
    const effectiveTimeout = timeoutOverrideMs ?? roleTimeoutMs;
    if (!(effectiveTimeout > 0)) return roleFn(ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RoleResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ role, outcome: "failure", summary: `role "${role}" exceeded its ${effectiveTimeout}ms wall-clock timeout`, detail: { timedOut: true, timeoutMs: effectiveTimeout } }),
        effectiveTimeout,
      );
    });
    try {
      return await Promise.race([Promise.resolve(roleFn(ctx)), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  // SG-1: when a live-output sink is wired, wrap the injected governed executor so EVERY check
  // it runs streams its output to the sink. No sink (the common/test case) ⇒ the base executor
  // unchanged. (Only wraps an explicitly-injected governedExec — the verifier/builder lazy
  // fallback is used otherwise, and streaming requires the explicit production wiring anyway.)
  const baseGovExec = deps.governedExec;
  const execSink = deps.onExecOutput;
  const govExecForRoles: Pick<GovernedExec, "run"> | undefined =
    baseGovExec !== undefined && execSink !== undefined
      ? { run: (req: ExecRequest) => baseGovExec.run({ ...req, onOutput: execSink }) }
      : baseGovExec;
  // Cooperative kill checkpoint (read-only). Lazy default so worker-model load never
  // eagerly constructs the kill-switch; the loop OBEYS a kill, it never publishes one.
  const killCheck =
    deps.killCheck ??
    (async (target: { agentId?: string; runId?: string; requestId?: string }) => {
      const mod = await import("../kill-switch/index.js");
      return mod.killSwitch.isKilled(target);
    });
  const roles: Record<WorkerRole, RoleFn> = { ...DEFAULT_ROLES, ...deps.roles };
  // SCOUT retrieval mode (B): wire the resolved mode into the scout so production defaults to
  // index retrieval. An injected `deps.roles.scout` (tests) always wins; otherwise we rebuild
  // the default scout bound to the resolved mode + env. Behavior is byte-unchanged for a
  // non-production orchestrator (resolveRetrievalMode(..., { production:false }) == legacy
  // unless env opts in, which is exactly the bare scout's own env read).
  if (deps.roles?.scout === undefined) {
    roles.scout = createScout({ mode: retrievalMode, env: modeEnv, ...(deps.retrieval !== undefined ? { retrieval: deps.retrieval } : {}) });
  }

  // Per-candidate builder models (the head-to-head shootout). Default to config; injectable
  // for tests. When `competitiveModelList` is set, competitive mode races one candidate per
  // listed model; otherwise every candidate uses the single builder model (old behavior).
  const singleBuilderModel = deps.builderModel ?? builderModel();
  const competitiveModelList = deps.competitiveModels ?? competitiveBuilderModels();
  // TOURNAMENT candidate models (deps → config). A task's own `candidates` overrides both at run().
  const candidateModelList = deps.candidateModels ?? config.candidateModels ?? [];

  /**
   * A per-run COSTING engine: wraps `invokeModel` so every call across all roles (and
   * competitive candidates) accumulates `response.cost.usd` into one running total. The
   * neutralization seam is passed through untouched. `cost()` reads the accumulated total.
   */
  function makeCostingEngine(): { engine: RoleEngine; cost: () => number } {
    let total = 0;
    const costingEngine: RoleEngine = {
      invokeModel: async (request: ModelRequest): Promise<ModelResponse> => {
        const r = await invokeModel(request);
        total += r.cost?.usd ?? 0;
        return r;
      },
      neutralizeUntrusted,
    };
    return { engine: costingEngine, cost: () => total };
  }

  /**
   * The verifier for THIS run (C1). Honors an injected `deps.roles.verifier` (tests),
   * otherwise builds the governed + script-integrity-guarded verifier bound to the run's
   * parent ctx (the validated identity governed-exec needs — the spawned role identity is
   * not a minted ValidatedIdentity) and the workspace diff (LAYER-2 integrity source).
   */
  function verifierFor(parentCtx: OperationContext): RoleFn {
    if (deps.roles?.verifier !== undefined) return deps.roles.verifier;
    // FIX 1 (script integrity): the guard must see the UNION of (a) the committed base..scratch
    // diff — non-empty for competitive candidates that commit before judging — and (b) the
    // WORKING-TREE package.json changes — the normal single-run flow does NOT commit before the
    // verifier, so the committed range is empty there. (b) is a governed (read-only, allowlisted)
    // `git diff <baseRef> -- *package.json`, best-effort (errors → ""); (a) is NOT swallowed, so a
    // genuinely-unreadable diff still fails the verifier CLOSED.
    const hasCommitted = workspaces.diff !== undefined;
    const scriptIntegrityDiff: ((ws: WorkspaceHandle) => Promise<string>) | undefined =
      hasCommitted || govExecForRoles !== undefined
        ? (ws: WorkspaceHandle): Promise<string> => {
            const committedP = hasCommitted ? workspaces.diff!(ws) : Promise.resolve("");
            const workingP =
              govExecForRoles !== undefined
                ? workingTreePackageJsonDiff(
                    async (args) => (await govExecForRoles.run({ parentCtx, command: "git", args: [...args], cwd: ws.path, purpose: "verifier: script-integrity working-tree diff" })).stdoutTail ?? "",
                    ws.path,
                    ws.baseRef,
                  ).catch(() => "")
                : Promise.resolve("");
            return Promise.all([committedP, workingP]).then(([c, w]) => `${c}\n${w}`);
          }
        : undefined;
    const runGitForDiff = async (args: readonly string[], ws: WorkspaceHandle, purpose: string): Promise<string> => {
      if (govExecForRoles === undefined) throw new Error("governed-exec unavailable for verifier planning diff");
      const res = await govExecForRoles.run({ parentCtx, command: "git", args: [...args], cwd: ws.path, purpose });
      if (!res.executed || res.exitCode !== 0) throw new Error(res.reason ?? `git exited ${res.exitCode ?? "unknown"}`);
      return res.stdoutTail ?? "";
    };
    const planningDiff: ((ws: WorkspaceHandle) => Promise<string>) | undefined =
      hasCommitted || govExecForRoles !== undefined
        ? (ws: WorkspaceHandle): Promise<string> => {
            const committedP = hasCommitted ? workspaces.diff!(ws) : Promise.resolve("");
            const workingP =
              govExecForRoles !== undefined
                ? workingTreePlanningDiff((args) => runGitForDiff(args, ws, "verifier: ladder planning working-tree diff"), ws.path, ws.baseRef)
                : Promise.resolve("");
            return Promise.all([committedP, workingP]).then(([c, w]) => `${c}\n${w}`);
          }
        : undefined;
    return createVerifier({
      ...(govExecForRoles !== undefined ? { governedExec: govExecForRoles } : {}),
      parentCtx,
      ...(scriptIntegrityDiff !== undefined ? { diff: scriptIntegrityDiff } : {}),
      ...(planningDiff !== undefined ? { planningDiff } : {}),
      // PROJECT-ROOT GUARD + per-target check set (Fix 1/2): wired ONLY in production
      // (enforceProjectRoot), so a no-manifest / wrong-repo worktree fails closed RED.
      ...(enforceProjectRoot ? { resolveChecks: (ws: string) => resolveChecks(ws) } : {}),
      // VERIFICATION MODE (A): production defaults to the HARDENED ladder (stub detection,
      // no-vacuous-green, alias/impact escalation, neutral-package handling, scope stamp).
      // The resolved mode honors an explicit IKBI_VERIFY=legacy opt-out + env IKBI_VERIFY=ladder.
      mode: verificationMode,
      env: modeEnv,
    });
  }

  /** The critic for THIS run. Honors injected tests, otherwise gives the critic workspace diff access. */
  function criticFor(): RoleFn {
    if (deps.roles?.critic !== undefined) return deps.roles.critic;
    return createCritic({
      ...(workspaces.diff !== undefined ? { diff: (ws: WorkspaceHandle) => workspaces.diff!(ws) } : {}),
    });
  }

  /**
   * The builder for THIS run. Honors an injected `deps.roles.builder` (tests); otherwise
   * builds it with governedExec + the run's parent ctx — the SAME module-internal injection
   * the verifier uses — so its in-loop `run_checks` runs the verifier's EXACT checks through
   * the same governed path. NO contract change: governedExec/parentCtx are not RoleContext fields.
   */
  /**
   * Resolve the BUILDER LANE for a task: the task's own `builderMode` wins, else the operator
   * default (IKBI_BUILDER_MODE → config.builderMode). "patch" routes through the Patchsmith lane.
   */
  function resolveBuilderMode(task: WorkerTask): BuilderMode {
    return task.builderMode ?? config.builderMode ?? "agent";
  }

  function builderFor(parentCtx: OperationContext, mode: BuilderMode = "agent"): RoleFn {
    return builderForModel(parentCtx, undefined, mode);
  }

  /** Like `builderFor`, but for a specific per-candidate model (the head-to-head shootout). */
  function builderForModel(parentCtx: OperationContext, modelOverride?: string, mode: BuilderMode = "agent"): RoleFn {
    if (deps.roles?.builder !== undefined) return deps.roles.builder;
    // The Patchsmith lane and the agent lane share the SAME module-internal deps (governed checks,
    // parent identity, the verifier's resolved check set). The lane only changes which RoleFn runs.
    const builderDeps = {
      ...(govExecForRoles !== undefined ? { governedExec: govExecForRoles } : {}),
      parentCtx,
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      // Same resolved set the verifier uses (Fix 1/2), wired ONLY in production (enforceProjectRoot).
      ...(enforceProjectRoot ? { resolveChecks: (ws: string) => resolveChecks(ws) } : {}),
    };
    return mode === "patch" ? createPatchsmith(builderDeps) : createBuilder(builderDeps);
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

    // ISSUE 1 (+ R1) — separate PERFORMANCE failures from trust demotion, WITHOUT letting a
    // flailing/bad-output worker hide behind non-convergence. A wall-clock `timeout` is a pure
    // performance signal (suppressible by default). A `max_iterations` stop is suppressible ONLY
    // when there is no evidence of bad output — `detail.rejectedToolCalls` captures malformed JSON,
    // schema-validation failures, and repeated invalid actions; if any are present, the run was
    // flailing, so it is counted against trust as a real failure. Policy (penalizeTimeouts) forces
    // ALL performance-class failures to count. REAL failures (failed verification, safety/policy)
    // were never in this class and always count.
    const detailRec = (result.detail as Record<string, unknown> | undefined) ?? {};
    const stopReason = detailRec.stopReason;
    const rejectedToolCalls = Array.isArray(detailRec.policyViolations) ? detailRec.policyViolations : Array.isArray(detailRec.rejectedToolCalls) ? detailRec.rejectedToolCalls : [];
    const toolFormatErrors = Array.isArray(detailRec.toolFormatErrors) ? detailRec.toolFormatErrors : [];
    const badOutputEvidence = toolFormatErrors.length > 0;
    const isPerformanceFailure =
      result.outcome === "failure" && (stopReason === "timeout" || stopReason === "max_iterations");
    // timeout: always suppressible. max_iterations: suppressible only WITHOUT bad-output evidence.
    const suppressEligible = stopReason === "timeout" || (stopReason === "max_iterations" && !badOutputEvidence);
    const suppressTrustSignal = isPerformanceFailure && suppressEligible && config.penalizeTimeouts !== true;

    // R1: an explicit, auditable record of the trust decision for EVERY performance-class failure —
    // whether it was suppressed or penalized, and why.
    let perfTrust: { decision: "suppressed" | "penalized"; reason: string } | undefined;
    if (isPerformanceFailure) {
      if (suppressTrustSignal) {
        const why = stopReason === "timeout" ? "wall-clock timeout (performance)" : "max_iterations with no bad-output evidence";
        perfTrust = { decision: "suppressed", reason: `${why} — trust signal suppressed (not counted)` };
      } else {
        const why =
          config.penalizeTimeouts === true
            ? "IKBI_WORKER_MODEL_PENALIZE_TIMEOUTS policy is on"
            : `max_iterations with ${toolFormatErrors.length} tool format error(s) (bad-output evidence)`;
        perfTrust = { decision: "penalized", reason: `${String(stopReason)}: ${why} — counted against trust` };
      }
    }

    // ISSUE 3: a repair run's narrative (root cause + fix rationale, from the builder's `done`
    // claim) is persisted into the role receipt's metadata so the trail records WHY the change
    // was made — not just that files moved.
    const doneClaim = (result.detail as Record<string, unknown> | undefined)?.doneClaim as
      | { rootCause?: string; fixRationale?: string }
      | undefined;
    const filesWritten = (result.detail as Record<string, unknown> | undefined)?.filesWritten;

    await receipts.append(
      {
        operation,
        outcome: { status, ...(result.summary !== undefined ? { detail: result.summary } : {}) },
        requestId: task.taskId,
        metadata: {
          role: result.role,
          taskId: task.taskId,
          workspaceId: workspace.id,
          outcome: result.outcome,
          ...(perfTrust !== undefined
            ? { performanceFailure: true, trustDecision: perfTrust.decision, trustDecisionReason: perfTrust.reason }
            : {}),
          ...(doneClaim?.rootCause !== undefined ? { rootCause: doneClaim.rootCause } : {}),
          ...(doneClaim?.fixRationale !== undefined ? { fixRationale: doneClaim.fixRationale } : {}),
          ...(Array.isArray(filesWritten) ? { filesChanged: filesWritten } : {}),
        },
        project: task.targetRepo,
      },
      spawned.identity,
    );

    if (suppressTrustSignal) {
      // EXPLICIT, auditable receipt for the autonomy decision: trust is deliberately left
      // unchanged for this performance failure (so there is a clear trail for "why trust did
      // not move"). No trust.recordOutcome call → no demotion, no transition event.
      await receipts.append(
        {
          operation: "worker.trust.signal_suppressed",
          outcome: {
            status: "success",
            detail: `role ${result.role}: ${perfTrust?.reason ?? "performance failure — trust signal suppressed"} (set IKBI_WORKER_MODEL_PENALIZE_TIMEOUTS=true to count performance failures).`,
          },
          requestId: task.taskId,
          metadata: { role: result.role, taskId: task.taskId, agentId: spawned.identity.agentId, stopReason: String(stopReason), rejectedToolCalls: rejectedToolCalls.length, penalizeTimeouts: false },
          project: task.targetRepo,
        },
        spawned.identity,
      );
      return;
    }

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

    // CANDIDATE TOURNAMENT MODE (#tournament, default OFF). When the task (or config) names
    // candidate models, race them independently, verify + score all, replay the WINNER's diff into
    // a clean shadow workspace, re-verify, then take the existing promote path. Takes precedence
    // over competitive. Byte-unchanged when no candidate models are configured.
    const taskCandidates = task.candidates !== undefined && task.candidates.length > 0 ? task.candidates : candidateModelList;
    if (taskCandidates.length > 0) {
      const mode = resolveBuilderMode(task);
      const specs: CandidateSpec[] = taskCandidates.slice(0, MAX_CANDIDATE_MODELS).map((model) => ({ model, mode }));
      return runTournament(task, parentCtx, specs, makeTournamentEngine(task, parentCtx, parentIdentity));
    }

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
    // not allocate or start anything. Skip the kill check when reusing a workspace —
    // the step planner already checked on the first step.
    if (task.reuseWorkspace === undefined) {
      const preKill = await killHalt(task, parentIdentity, parentCtx);
      if (preKill !== undefined) {
        events.publish(workerFailed.create({ taskId: task.taskId, reason: preKill }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } }));
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason: preKill };
      }
    }

    // STEP-PLANNER: reuse an existing workspace (changes accumulate across steps)
    // or allocate a fresh one (default single-step behavior).
    const workspace = task.reuseWorkspace ?? await workspaces.allocate({
      targetRepo: task.targetRepo,
      identity: parentIdentity,
      ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
      label: `worker:${task.taskId}`,
    });

    events.publish(
      workerStarted.create(
        { taskId: task.taskId, workspaceId: workspace.id, verificationMode, retrievalMode },
        { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
      ),
    );

    // Per-run costing engine: accumulates every model invocation's cost across all roles.
    const { engine: runEngine, cost: runCost } = makeCostingEngine();

    const results: RoleResult[] = [];
    // Run-level escalation accumulator (ADDITIVE observability; never alters dispatch).
    const escSignals: MutableEscalationSignals = { schemaFailures: 0, retryCount: 0, contextPressure: 0, criticRejected: false, verificationFailed: false, rejectedToolCalls: 0 };
    const escHandoff: EscalationHandoffFields = {};
    let overall: WorkerResult["outcome"] = "success";
    let killedReason: string | undefined;
    // ISSUE 1: a critic FAIL feeds the critic's feedback back to the builder for ONE retry
    // (opt-in, config.criticFixLoop). This guard caps it at a single attempt per run so
    // subjective feedback can never loop forever.
    let criticFixAttempted = false;
    // Set when a build runs GREEN but its worker tier lacks autoCommit autonomy, so the
    // verified work is deliberately left uncommitted. Carrying the tier + agent lets the terminal
    // step report an explicit, actionable reason instead of a misleading "no changes to promote".
    let autoCommitSkippedTier: string | undefined;
    let autoCommitSkippedAgent: string | undefined;
    // The verification scope the verifier stamped ("impact" | "full"), surfaced into the
    // verification event, the completed event, and the promote message for auditability.
    let verificationScope: "impact" | "full" | undefined;
    // OBSERVABILITY (E): the ACTUAL modes the roles reported (verifier detail.verificationMode,
    // scout detail.retrievalMode). They fall back to the resolved wiring decision below — so the
    // run result + completion event always carry which path actually ran.
    let actualVerificationMode: string | undefined;
    let actualRetrievalMode: string | undefined;

    try {
      // ── DEPENDENCY INSTALL: ensure node_modules exists before running checks ──
      // If the worktree has a package.json but no node_modules, install dependencies
      // so run_checks (typecheck + tests) can actually succeed. This is the fix for
      // the "vitest: command not found" / "Cannot find module" failures.
      await installWorkspaceDeps(workspace, parentCtx, deps.dependencyInstall);

      for (const role of WORKER_ROLES) {
        // STEP-PLANNER: skip verifier on intermediate steps (no tests exist yet).
        if (role === "verifier" && task.skipVerifier === true) {
          // CODEX FIX: mark the skipped verifier with verdict "skipped" — NOT a bare success that
          // the critic (which runs after the verifier and reads its verdict) would read as a fake
          // "pass". `verdict: "skipped"` makes formatVerifierContext surface "verdict: skipped"
          // instead of inferring a pass from the outcome, and the integrator's AND-gate (verdict ===
          // "pass") still correctly withholds promotion — same as the old bare result did.
          results.push({ role: "verifier", outcome: "success", summary: "skipped (skipVerifier)", detail: { verdict: "skipped", skipped: true } });
          continue;
        }
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
          engine: runEngine,
        };
        const roleFn = role === "verifier" ? verifierFor(parentCtx) : role === "builder" ? builderFor(parentCtx, resolveBuilderMode(task)) : role === "critic" ? criticFor() : roles[role];
        // H4: floor the verifier's role timeout at the per-check budget. Without this, a 300s role
        // timeout races against 600s checks — the role fails first, orphaning the still-running check.
        const verifierTimeout = role === "verifier" ? Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)) : undefined;
        let result = await runRoleFn(role, roleFn, ctx, verifierTimeout);
        results.push(result);

        events.publish(
          workerRoleCompleted.create(
            { taskId: task.taskId, role, outcome: result.outcome },
            { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
          ),
        );

        await recordRole(task, workspace, spawned, result);

        // SG-5 PROGRESS: structured per-role detail beyond start/end — builder tool activity
        // and the verifier's verdict — so `--verbose` can show what each phase actually did.
        if (role === "scout") {
          const sd = (result.detail ?? {}) as Record<string, unknown>;
          if (typeof sd.retrievalMode === "string") actualRetrievalMode = sd.retrievalMode;
        } else if (role === "builder") {
          const bd = (result.detail ?? {}) as Record<string, unknown>;
          events.publish(
            workerBuilderActivity.create(
              { taskId: task.taskId, toolRounds: typeof bd.toolRounds === "number" ? bd.toolRounds : 0, filesWritten: Array.isArray(bd.filesWritten) ? bd.filesWritten.length : 0, ...(typeof bd.contextPercent === "number" ? { contextPercent: bd.contextPercent } : {}) },
              { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: "worker.role.builder", runId: task.taskId } },
            ),
          );
        } else if (role === "verifier") {
          const v = readVerifier(result);
          const vd = (result.detail as Record<string, unknown> | undefined) ?? {};
          const verdict = vd.verdict;
          const scope = vd.verificationScope === "impact" || vd.verificationScope === "full" ? vd.verificationScope : undefined;
          verificationScope = scope; // carried to the completed event + promote message (auditability)
          if (typeof vd.verificationMode === "string") actualVerificationMode = vd.verificationMode;
          events.publish(
            workerVerification.create(
              {
                taskId: task.taskId,
                verdict: typeof verdict === "string" ? verdict : result.outcome === "success" ? "pass" : "fail",
                typecheckPassed: v.typecheckPass,
                testsPassed: v.testsPass,
                checks: v.checks,
                ...(scope !== undefined ? { verificationScope: scope } : {}),
              },
              { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: "worker.role.verifier", runId: task.taskId } },
            ),
          );
        }

        // ── ITERATIVE FIX LOOP: verify → auto-fix → re-verify ──────────────────
        // After the builder succeeds, run a quick verifier check. If verification
        // fails, feed the errors back to the builder as a fix goal and retry.
        // Up to MAX_FIX_ITERATIONS attempts. This is WRAPPER logic — the builder
        // and verifier internals are unchanged.
        // OPT-IN: requires IKBI_WORKER_MODEL_FIX_LOOP=true (default off).
        if (role === "builder" && result.outcome === "success" && config.fixLoop) {
          const fixLoopOutcome = await runIterativeLoop(result, {
            maxFixIterations: DEFAULT_MAX_FIX_ITERATIONS,
            verifier: async () => {
              const verifyFn = verifierFor(parentCtx);
              const verifyCtx: RoleContext = {
                task, role: "verifier",
                identity: spawned.identity,
                autonomy: spawned.autonomy,
                workspace,
                priorResults: [...results],
                engine: runEngine,
              };
              const vResult = await runRoleFn("verifier", verifyFn, verifyCtx, Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)));
              return extractVerifierCheckResult(vResult);
            },
            builder: async (fixGoal: string) => {
              const fixBuilderFn = builderFor(parentCtx, resolveBuilderMode(task));
              const fixCtx: RoleContext = {
                task: { ...task, goal: fixGoal },
                role: "builder",
                identity: spawned.identity,
                autonomy: spawned.autonomy,
                workspace,
                priorResults: [...results],
                engine: runEngine,
              };
              return runRoleFn("builder", fixBuilderFn, fixCtx);
            },
          });

          if (fixLoopOutcome.fixIterations > 0) {
            // The fix loop ran — update the builder result and emit an event.
            const prevDetail = (result.detail ?? {}) as Record<string, unknown>;
            const loopDetail = (fixLoopOutcome.buildResult.detail ?? {}) as Record<string, unknown>;
            result = {
              ...fixLoopOutcome.buildResult,
              detail: { ...prevDetail, ...loopDetail, fixIterations: fixLoopOutcome.fixIterations },
            };
            results[results.length - 1] = result;
            events.publish(
              workerFixLoopCompleted.create(
                {
                  taskId: task.taskId,
                  fixIterations: fixLoopOutcome.fixIterations,
                  success: fixLoopOutcome.buildResult.outcome === "success",
                  ...(fixLoopOutcome.lastVerifierResult !== undefined ? { lastErrors: fixLoopOutcome.lastVerifierResult.errors.slice(0, 500) } : {}),
                },
                { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.fix_loop", runId: task.taskId } },
              ),
            );
            // Record a receipt for the fix loop so the trail shows how many iterations ran.
            await receipts.append(
              {
                operation: "worker.fix_loop",
                outcome: { status: fixLoopOutcome.buildResult.outcome === "success" ? "success" : "failure" },
                requestId: task.taskId,
                metadata: {
                  taskId: task.taskId,
                  workspaceId: workspace.id,
                  fixIterations: fixLoopOutcome.fixIterations,
                  success: fixLoopOutcome.buildResult.outcome === "success",
                },
                project: task.targetRepo,
              },
              parentIdentity,
            );
          }
        }

        // ── CRITIC-DRIVEN FIX LOOP: a subjective FAIL is no longer a dead end ──────
        // When the critic returns a model FAIL verdict (the build is objectively GREEN
        // — a red verifier short-circuits before the critic — but semantically wrong /
        // off-goal), feed its feedback back to the builder for ONE retry, re-verify,
        // and re-critique. Capped at a single attempt (criticFixAttempted) so subjective
        // feedback can never loop. COMPLEMENTARY to the verifier-driven loop above.
        // OPT-IN: requires IKBI_WORKER_MODEL_CRITIC_FIX_LOOP=true (default off).
        if (role === "critic" && config.criticFixLoop && !criticFixAttempted && isRetryableCriticFail(result)) {
          criticFixAttempted = true;
          // The prior results the re-run roles inherit: everything EXCEPT the stale builder /
          // verifier / critic, which are replaced with their fresh results as produced.
          const carriedPrior = results.filter((r) => r.role !== "builder" && r.role !== "verifier" && r.role !== "critic");
          const fix = await runCriticFixLoop(result, {
            builder: async (fixGoal: string) => {
              const fixCtx: RoleContext = {
                task: { ...task, goal: fixGoal },
                role: "builder",
                identity: spawned.identity,
                autonomy: spawned.autonomy,
                workspace,
                priorResults: [...carriedPrior],
                engine: runEngine,
              };
              return runRoleFn("builder", builderFor(parentCtx, resolveBuilderMode(task)), fixCtx);
            },
            verifier: async (builderResult: RoleResult) => {
              const verifyCtx: RoleContext = {
                task,
                role: "verifier",
                identity: spawned.identity,
                autonomy: spawned.autonomy,
                workspace,
                priorResults: [...carriedPrior, builderResult],
                engine: runEngine,
              };
              const vRes = await runRoleFn("verifier", verifierFor(parentCtx), verifyCtx, Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)));
              // Mirror the main verifier→commit gate: capture the re-verified-good working tree so
              // the integrator/promote sees the post-retry diff (gated on autoCommit, same as above).
              if (vRes.outcome === "success" && workspaces.commit !== undefined && spawned.autonomy.autoCommit) {
                await workspaces.commit(workspace, `ikbi: ${task.goal}`);
              }
              return vRes;
            },
            critic: async (builderResult: RoleResult, verifierResult: RoleResult) => {
              const reCriticCtx: RoleContext = {
                task,
                role: "critic",
                identity: spawned.identity,
                autonomy: spawned.autonomy,
                workspace,
                priorResults: [...carriedPrior, builderResult, verifierResult],
                engine: runEngine,
              };
              return runRoleFn("critic", criticFor(), reCriticCtx);
            },
          });

          if (fix.ran) {
            // Splice the fresh role results back into the run so the integrator (and the final
            // WorkerResult.roles) reflect the post-retry state. Replace by role; critic stays last.
            const replaceRole = (value: RoleResult): void => {
              const i = results.findIndex((r) => r.role === value.role);
              if (i >= 0) results[i] = value;
              else results.push(value);
            };
            if (fix.builderResult !== undefined) replaceRole(fix.builderResult);
            if (fix.verifierResult !== undefined) replaceRole(fix.verifierResult);
            result = fix.criticResult;
            replaceRole(result);

            const criticPass = ((result.detail ?? {}) as Record<string, unknown>).pass === true;
            const verifierPass = ((fix.verifierResult?.detail ?? {}) as Record<string, unknown>).verdict === "pass";
            events.publish(
              workerCriticFixLoopCompleted.create(
                {
                  taskId: task.taskId,
                  retried: true,
                  criticPass,
                  ...(fix.builderResult !== undefined ? { builderOk: fix.builderResult.outcome === "success" } : {}),
                  ...(fix.verifierResult !== undefined ? { verifierPass } : {}),
                },
                { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.critic_fix_loop", runId: task.taskId } },
              ),
            );
            await receipts.append(
              {
                operation: "worker.critic_fix_loop",
                outcome: { status: criticPass ? "success" : "failure" },
                requestId: task.taskId,
                metadata: { taskId: task.taskId, workspaceId: workspace.id, retried: true, criticPass },
                project: task.targetRepo,
              },
              parentIdentity,
            );
          }
        }

        // ADDITIVE escalation observability — fold signals + emit escalation.* events.
        // Runs before the short-circuit so a failing role's signals are still scored.
        observeEscalation(events, task, role, result, escSignals, escHandoff, parentIdentity);

        if (result.outcome !== "success") {
          overall = result.outcome;
          // CODEX FIX: do NOT short-circuit on a VERIFIER failure. The critic runs AFTER the
          // verifier (the whole point of the reorder) and must see the verifier's results —
          // INCLUDING failures — to give meaningful semantic feedback. Let the critic (and the
          // integrator's order-independent AND-gate) run; `overall` already records the failure,
          // the integrator discards on a red verifier, and the post-loop path retains/discards
          // the workspace exactly as a short-circuit would. Any OTHER non-success role still
          // breaks: a failed scout/builder leaves nothing for the critic to review.
          if (role !== "verifier") break;
        }

        // COMMIT the VERIFIED-good working tree, gated on autoCommit. The builder's edits live
        // in the working tree (what run_checks + the verifier both check); without committing,
        // the scratch branch HEAD == base HEAD and promote sees an empty diff. After the verifier
        // SUCCEEDS, capture that verified state so the integrator (next role) promotes a real diff.
        // Gated on the worker's autonomy: trusted/operator (autoCommit) commit; lower tiers do not.
        // Guarded on verifier SUCCESS: the verifier no longer short-circuits on failure (the critic
        // must still run), so this commit gate must explicitly require a green verifier — a failed
        // verification is never committed.
        if (role === "verifier" && result.outcome === "success" && workspaces.commit !== undefined) {
          if (spawned.autonomy.autoCommit) {
            await workspaces.commit(workspace, `ikbi: ${task.goal}`);
          } else {
            // Verified-good, but this tier lacks autoCommit autonomy → its work is intentionally
            // NOT committed (the autonomy model; an existing test pins commit-count == 0 here).
            // Record WHY so the terminal step surfaces it instead of silently dropping a green build.
            autoCommitSkippedTier = spawned.autonomy.tier;
            autoCommitSkippedAgent = spawned.identity.agentId;
          }
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
      // Infrastructure failure mid-run (e.g. escalation guard): RETAIN the work for inspection
      // (Bug 2) instead of discarding it — the worktree may hold real progress. `ikbi clean`
      // reclaims it later. Falls back to discard when retention is off / unavailable.
      const reason = err instanceof Error ? err.message : String(err);
      if (retainFailedWorkspaces) await safeRetain(workspaces, workspace, `infrastructure failure: ${reason}`);
      else await safeDiscard(workspaces, workspace);
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

    // Terminal: a GREEN build whose worker tier lacks autoCommit autonomy left its verified
    // work uncommitted by policy (see the verifier-commit gate). A promote here would find an
    // empty diff and report a misleading "no changes to promote". Instead, RETAIN the verified
    // work and return a precise, actionable reason — a green build is never silently dropped,
    // and the operator is told exactly how to land it. (This does NOT auto-commit: the autonomy
    // model is intact; it only replaces a confusing empty-diff outcome with a clear one.)
    if (autoCommitSkippedTier !== undefined && overall === "success") {
      const agent = autoCommitSkippedAgent ?? "worker";
      // R2: the disposition note must match what ACTUALLY happens. Retention only occurs when the
      // policy is on AND the workspace manager can retain (safeRetain falls back to discard when it
      // cannot). Decide first, then describe — never claim a retained workspace that was discarded.
      const retained = retainFailedWorkspaces && workspaces.retain !== undefined;
      const disposition = retained
        ? `Its verified changes were left uncommitted, but the workspace (${workspace.id}) was RETAINED at ${workspace.path} — no work was lost. Inspect it with \`ikbi diff ${workspace.id}\` (or open ${workspace.path}); when done, remove it deliberately with \`ikbi workspace discard ${workspace.id}\` (\`ikbi clean\` preserves retained work — use \`ikbi clean --force\` to sweep it).`
        : "Its verified changes were left uncommitted and the workspace was DISCARDED — no retained workspace is available.";
      const reason =
        "verification PASSED, but promotion was BLOCKED. " +
        `Reason: the worker tier "${autoCommitSkippedTier}" lacks autoCommit autonomy. ${disposition} ` +
        `To land this work, run: \`ikbi trust grant ${agent} trusted\` then re-run the build (or promote via a higher-tier run).`;
      if (retained) await safeRetain(workspaces, workspace, reason);
      else await workspaces.discard(workspace);
      events.publish(
        workerCompleted.create(
          { taskId: task.taskId, outcome: "partial", promoted: false, workspaceId: workspace.id },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "partial", roles: results, workspaceId: workspace.id, promoted: false, reason, costUsd: runCost() };
    }

    // STEP-PLANNER: when skipPromote is set, run the role pipeline but leave the
    // workspace alive on disk. No promote, no discard — the step planner will
    // either run more steps or do a final verification pass.
    if (task.skipPromote === true) {
      events.publish(
        workerCompleted.create(
          { taskId: task.taskId, outcome: overall, promoted: false, workspaceId: workspace.id, ...(verificationScope !== undefined ? { verificationScope } : {}) },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: overall, roles: results, workspaceId: workspace.id, promoted: false, ...(overall !== "success" ? { reason: `step completed with outcome "${overall}"` } : {}), costUsd: runCost() };
    }

    // Terminal: ENACT the integrator's promote/discard DECISION (the integrator
    // decides; the orchestrator owns the lifecycle). Promote IFF the integrator
    // returned an affirmative, well-formed promote decision; anything else discards
    // (fail-closed). If a role hard-failed, the loop broke before the integrator ran,
    // so its result is absent → fail-closed discard. That composition is intentional.
    const decision = readIntegratorDecision(results.find((r) => r.role === "integrator"));
    let promoted = false;
    let reason: string | undefined;
    // SG-10 HUMAN-APPROVAL GATE (opt-in): the build is VERIFIED and the integrator approved —
    // pause for the operator before the irreversible promote. A rejection DISCARDS the work.
    let approvalRejected = false;
    if (decision.promote && requestApproval !== undefined) {
      events.publish(
        workerApprovalRequested.create({ taskId: task.taskId, workspaceId: workspace.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } }),
      );
      const approved = await requestApproval({ taskId: task.taskId, workspaceId: workspace.id, goal: task.goal });
      events.publish(
        workerApprovalResolved.create({ taskId: task.taskId, workspaceId: workspace.id, approved }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } }),
      );
      if (!approved) {
        await workspaces.discard(workspace);
        overall = "rejected";
        reason = "promotion rejected by operator (approval gate)";
        approvalRejected = true;
      }
    }
    if (decision.promote && !approvalRejected) {
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
        if (!governance.allow) {
          await workspaces.discard(workspace);
          overall = "rejected";
          reason = governance.reason ?? "gate-wall denied promotion";
        } else {
          const promote = await workspaces.promote(workspace, {
            evaluation: decision.evaluation, // sourced from the integrator, NOT hardcoded
            governance,
            // Auditability: record the verification scope the promote relied on in the commit message.
            message: `worker-model: ${task.goal}${decision.rationale !== undefined ? ` — ${decision.rationale}` : ""}${verificationScope !== undefined ? ` [verification: ${verificationScope}]` : ""}`,
          });
          promoted = promote.promoted;
          if (!promoted) {
            // Conflict: the workspace is reconcilable — downgrade to partial, do NOT discard.
            overall = "partial";
            reason = promote.reason ?? "promote did not land (conflict)";
          }
        }
      }
    } else if (!approvalRejected) {
      // The integrator did not approve promote (and it was not an approval-gate rejection,
      // which already discarded above). Fail-closed: nothing lands.
      reason =
        decision.rationale ??
        (overall !== "success" ? `run ended with role outcome "${overall}"` : "integrator did not approve promote");
      // Bug 2: when the build actually FAILED (a role did not converge — overall is not
      // "success"), RETAIN the workspace so its work survives for inspection instead of
      // discarding it (the builder may have written real files before the failure). A build
      // that ran GREEN but the integrator declined to promote is a deliberate "not promotable"
      // verdict → discard as before. Retention is gated (default on); off ⇒ old eager discard.
      if (retainFailedWorkspaces && overall !== "success") {
        await safeRetain(workspaces, workspace, reason);
      } else {
        await workspaces.discard(workspace);
      }
      // Roles ran to completion but the work was judged not promotable → not a
      // misleading "success".
      if (overall === "success") overall = "rejected";
    }

    // OBSERVABILITY (E): which paths ACTUALLY ran — the role's own report when present, else the
    // wired decision. Always present on the result so the CLI summary + receipts can show them.
    const ranVerificationMode = actualVerificationMode ?? verificationMode;
    const ranRetrievalMode = actualRetrievalMode ?? retrievalMode;
    const result: WorkerResult = {
      contractVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      outcome: overall,
      roles: results,
      workspaceId: workspace.id,
      promoted,
      ...(reason !== undefined ? { reason } : {}),
      verificationMode: ranVerificationMode,
      retrievalMode: ranRetrievalMode,
      costUsd: runCost(),
    };

    if (overall === "success" || overall === "partial") {
      events.publish(
        workerCompleted.create(
          { taskId: task.taskId, outcome: overall, promoted, workspaceId: workspace.id, verificationMode: ranVerificationMode, retrievalMode: ranRetrievalMode, ...(verificationScope !== undefined ? { verificationScope } : {}) },
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
  async function dispatchRole(role: WorkerRole, spawned: SpawnedRole, task: WorkerTask, workspace: WorkspaceHandle, priorResults: readonly RoleResult[], parentCtx: OperationContext, engine: RoleEngine, roleFnOverride?: RoleFn): Promise<RoleResult> {
    events.publish(
      workerRoleDispatched.create(
        { taskId: task.taskId, role, ...(spawned.identity.trustTier !== undefined ? { tier: spawned.identity.trustTier } : {}) },
        { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
      ),
    );
    const ctx: RoleContext = { task, role, identity: spawned.identity, autonomy: spawned.autonomy, workspace, priorResults: [...priorResults], engine };
    // The verifier (C1) and the builder (its in-loop run_checks) run the governed path
    // bound to the run ctx (parentCtx is the minted ValidatedIdentity governed-exec needs).
    const roleFn = roleFnOverride ?? (role === "verifier" ? verifierFor(parentCtx) : role === "builder" ? builderFor(parentCtx, resolveBuilderMode(task)) : roles[role]);
    // H4: floor the verifier's role timeout at the per-check budget (same as the cooperative path).
    const verifierTimeout = role === "verifier" ? Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)) : undefined;
    const result = await runRoleFn(role, roleFn, ctx, verifierTimeout);
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
    const rejectedToolCalls = Array.isArray(bd.policyViolations) ? bd.policyViolations.length : Array.isArray(bd.rejectedToolCalls) ? bd.rejectedToolCalls.length : 0;
    const stopReason = typeof bd.stopReason === "string" ? bd.stopReason : builderResult.outcome === "success" ? "stop" : "error";
    const v = readVerifier(verifierResult);
    return {
      workspaceId: workspace.id,
      typecheckPass: v.typecheckPass,
      testsPass: v.testsPass,
      ...(v.testCount !== undefined ? { testCount: v.testCount } : {}),
      testEvidence: v.testEvidence,
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

    // Per-run costing engine: accumulates model cost across the shared scout + every candidate.
    const { engine: runEngine, cost: runCost } = makeCostingEngine();

    const handles: WorkspaceHandle[] = [];
    const rolesByWs = new Map<string, RoleResult[]>();
    const retainCompetitiveFailure = async (reason: string, preferredWorkspaceId?: string): Promise<{ retained?: WorkspaceHandle; reason: string }> => {
      const preferred = preferredWorkspaceId !== undefined ? handles.find((h) => h.id === preferredWorkspaceId) : undefined;
      const withEdits = [...handles].reverse().find((h) => {
        const builder = rolesByWs.get(h.id)?.find((r) => r.role === "builder");
        const detail = (builder?.detail ?? {}) as { filesWritten?: unknown };
        return Array.isArray(detail.filesWritten) && detail.filesWritten.length > 0;
      });
      const keep = preferred ?? withEdits ?? handles.at(-1);
      if (keep === undefined || !retainFailedWorkspaces || workspaces.retain === undefined) {
        for (const h of handles) await safeDiscard(workspaces, h);
        return { reason };
      }
      await safeRetain(workspaces, keep, reason);
      for (const h of handles) if (h.id !== keep.id) await safeDiscard(workspaces, h);
      return {
        retained: keep,
        reason: `${reason}; retained candidate workspace ${keep.id} at ${keep.path}. Inspect with \`ikbi diff ${keep.id}\`; discard with \`ikbi workspace discard ${keep.id}\`.`,
      };
    };
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
      const scoutResult = await dispatchRole("scout", spawnRole("scout", parentCtx), task, handles[0]!, [], parentCtx, runEngine);

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
        const candidateBuilder = builderForModel(parentCtx, candidateModel, resolveBuilderMode(task));
        const builderResult = await dispatchRole("builder", spawnRole("builder", parentCtx), task, ws, [scoutResult], parentCtx, runEngine, candidateBuilder);
        let verifierResult: RoleResult | undefined;
        const verifierSpawn = spawnRole("verifier", parentCtx);
        if (builderResult.outcome === "success") {
          verifierResult = await dispatchRole("verifier", verifierSpawn, task, ws, [scoutResult, builderResult], parentCtx, runEngine);
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
        const reason = verdict.reason ?? "no candidate passed the judge";
        const repId = verdict.ranking[0]?.workspaceId ?? handles[0]?.id;
        const retained = await retainCompetitiveFailure(reason, repId);
        events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: null }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        events.publish(workerFailed.create({ taskId: task.taskId, reason: retained.reason, ...(retained.retained !== undefined ? { workspaceId: retained.retained.id } : repId !== undefined ? { workspaceId: repId } : {}) }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        const resultId = retained.retained?.id ?? repId;
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: resultId !== undefined ? rolesByWs.get(resultId) ?? [] : [], ...(resultId !== undefined ? { workspaceId: resultId } : {}), promoted: false, reason: retained.reason };
      }

      // 5b. WINNER: promote it (gate-wall STILL governs), discard ALL losers.
      const winner = handles.find((h) => h.id === verdict.winner!.workspaceId)!;
      const winnerRoles = rolesByWs.get(winner.id) ?? [];

      // H5 FAIL-CLOSED: a promote REQUIRES gate-wall authorization. No gate-wall ⇒ DENY
      // (never advisory-allow an irreversible promote). Discard EVERY workspace, land
      // nothing, reject.
      if (gateWall === undefined) {
        const reason = "gate-wall not wired — promote denied (fail-closed)";
        const retained = await retainCompetitiveFailure(reason, winner.id);
        events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        events.publish(workerFailed.create({ taskId: task.taskId, reason: retained.reason, workspaceId: retained.retained?.id ?? winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: winnerRoles, workspaceId: retained.retained?.id ?? winner.id, promoted: false, reason: retained.reason };
      }

      const governanceGrant = autonomyForTier(asTier(parentIdentity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
      const governance: PromoteGovernance = await gateWall.evaluate({ grant: governanceGrant, action: { kind: "promote", task, results: winnerRoles }, identity: parentIdentity });
      if (!governance.allow) {
        const reason = governance.reason ?? "gate-wall denied promotion";
        const retained = await retainCompetitiveFailure(reason, winner.id);
        events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        events.publish(workerFailed.create({ taskId: task.taskId, reason: retained.reason, workspaceId: retained.retained?.id ?? winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: winnerRoles, workspaceId: retained.retained?.id ?? winner.id, promoted: false, reason: retained.reason, costUsd: runCost() };
      }
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
        // winner too unless failed-workspace retention is enabled. A conflict is reconcilable
        // (partial); a governance deny is a rejection.
        outcome = promote.conflicts !== undefined && promote.conflicts.length > 0 ? "partial" : "rejected";
        reason = promote.reason ?? "winner not promoted (gate denied or conflict)";
        const retained = await retainCompetitiveFailure(reason, winner.id);
        reason = retained.reason;
      }

      events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      if (outcome === "success" || outcome === "partial") {
        events.publish(workerCompleted.create({ taskId: task.taskId, outcome, promoted, workspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      } else {
        events.publish(workerFailed.create({ taskId: task.taskId, reason: reason ?? outcome, workspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      }
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome, roles: winnerRoles, workspaceId: winner.id, promoted, ...(reason !== undefined ? { reason } : {}), costUsd: runCost() };
    } catch (err) {
      // Mid-run failure (allocation / role / judge): retain one useful failed candidate when
      // supported, discard the rest, then fail.
      const reason = err instanceof Error ? err.message : String(err);
      const retained = await retainCompetitiveFailure(reason);
      events.publish(workerFailed.create({ taskId: task.taskId, reason: retained.reason, ...(retained.retained !== undefined ? { workspaceId: retained.retained.id } : handles[0] !== undefined ? { workspaceId: handles[0].id } : {}) }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      throw err;
    }
  }

  // ── CANDIDATE TOURNAMENT MODE (#tournament) ─────────────────────────────────

  /** Map a tournament lifecycle event onto the event bus (parent attribution). */
  function emitTournamentEvent(task: WorkerTask, parentIdentity: AgentIdentity, ev: TournamentEvent): void {
    const attribution = { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.tournament", runId: task.taskId } };
    switch (ev.kind) {
      case "started":
        events.publish(workerTournamentStarted.create({ taskId: task.taskId, candidateCount: ev.candidateCount }, attribution));
        break;
      case "judged":
        events.publish(workerTournamentJudged.create({ taskId: task.taskId, candidateCount: ev.candidateCount, winnerWorkspaceId: ev.winnerWorkspaceId }, attribution));
        break;
      case "completed":
        events.publish(workerTournamentCompleted.create({ taskId: task.taskId, winnerWorkspaceId: ev.winnerWorkspaceId, ...(ev.shadowWorkspaceId !== undefined ? { shadowWorkspaceId: ev.shadowWorkspaceId } : {}), promoted: ev.promoted }, attribution));
        if (ev.shadowWorkspaceId !== undefined) {
          events.publish(workerCompleted.create({ taskId: task.taskId, outcome: ev.promoted ? "success" : "partial", promoted: ev.promoted, workspaceId: ev.shadowWorkspaceId, ...(verificationMode !== undefined ? { verificationMode } : {}) }, attribution));
        }
        break;
      case "failed":
        events.publish(workerFailed.create({ taskId: task.taskId, reason: ev.reason, ...(ev.workspaceId !== undefined ? { workspaceId: ev.workspaceId } : {}) }, attribution));
        break;
    }
  }

  /**
   * DEFAULT shadow-replay applier: apply the winner's unified diff into a clean workspace via a
   * GOVERNED `git apply` (the same governed-exec the verifier routes its checks through — defense in
   * depth, auditable), then COMMIT it so the shadow's scratch branch advances and the existing
   * promote path sees the change. An empty diff, a failed apply, or a no-op commit ⇒ `applied: false`
   * (the tournament then fails closed). Git-mutation governance still applies: `git apply` is
   * allowlisted but cannot redirect the worktree (the `-C`/`--work-tree` flags are denied upstream).
   */
  async function defaultApplyDiff(parentCtx: OperationContext, workspace: WorkspaceHandle, diff: string, goal: string): Promise<{ applied: boolean; reason?: string }> {
    if (diff.trim().length === 0) return { applied: false, reason: "winner produced an empty diff" };
    const gov = govExecForRoles ?? (await import("../governed-exec/index.js")).governedExec;
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const patchPath = path.join(os.tmpdir(), `ikbi-tournament-${workspace.id}.patch`);
    await fs.writeFile(patchPath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
    try {
      const res = await gov.run({ parentCtx, command: "git", args: ["apply", "--whitespace=nowarn", patchPath], cwd: workspace.path, purpose: "tournament: shadow replay (git apply)" });
      if (!res.executed || res.exitCode !== 0) {
        const detail = res.reason ?? res.stderrTail ?? `git apply exited ${res.exitCode ?? "unknown"}`;
        return { applied: false, reason: detail };
      }
      const committed = workspaces.commit !== undefined ? await workspaces.commit(workspace, `ikbi: ${goal}`) : false;
      if (!committed) return { applied: false, reason: "diff applied but produced no committed change" };
      return { applied: true };
    } catch (err) {
      return { applied: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      await fs.rm(patchPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Build the TournamentEngine for ONE run, bound to its task + identity. Reuses the SAME dispatch /
   * spawn / verifier / judge / promote closures the other modes use, so the tournament inherits the
   * #10 trust clamp, the governed verifier, and the H5 fail-closed promote unchanged. One costing
   * engine is shared across every candidate + the shadow.
   */
  function makeTournamentEngine(task: WorkerTask, parentCtx: OperationContext, parentIdentity: AgentIdentity): TournamentEngine {
    const { engine: runEngine, cost: runCost } = makeCostingEngine();

    const allocate = async (label: string): Promise<WorkspaceHandle | null> => {
      try {
        return await workspaces.allocate({
          targetRepo: task.targetRepo,
          identity: parentIdentity,
          ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
          label,
        });
      } catch {
        return null; // a candidate whose allocation fails is skipped (the others continue).
      }
    };

    const runCandidate = async (t: WorkerTask, ws: WorkspaceHandle, spec: CandidateSpec): Promise<CandidateRun> => {
      // Each candidate scouts + builds + verifies in ITS OWN worktree — fully isolated, never seeing
      // another candidate's workspace or output (no model-to-model communication).
      // Install deps first so run_checks can find vitest/tsc/etc.
      await installWorkspaceDeps(ws, parentCtx, deps.dependencyInstall);
      const scoutResult = await dispatchRole("scout", spawnRole("scout", parentCtx), t, ws, [], parentCtx, runEngine);
      const candidateBuilder = builderForModel(parentCtx, spec.model, spec.mode);
      const builderResult = await dispatchRole("builder", spawnRole("builder", parentCtx), t, ws, [scoutResult], parentCtx, runEngine, candidateBuilder);
      let verifierResult: RoleResult | undefined;
      const verifierSpawn = spawnRole("verifier", parentCtx);
      if (builderResult.outcome === "success") {
        verifierResult = await dispatchRole("verifier", verifierSpawn, t, ws, [scoutResult, builderResult], parentCtx, runEngine);
      }
      // COMMIT verified work so the candidate's diff is the clean committed range — that range is
      // both what the judge scores (diffLines) and what gets replayed into the shadow if it wins.
      if (verifierResult?.outcome === "success" && verifierSpawn.autonomy.autoCommit && workspaces.commit !== undefined) {
        await workspaces.commit(ws, `ikbi: ${t.goal}`);
      }
      const diffText = workspaces.diff !== undefined ? await workspaces.diff(ws).catch(() => "") : "";
      const candidate = buildCandidate(ws, builderResult, verifierResult, await safeDiffLines(ws));
      const roles = [scoutResult, builderResult, ...(verifierResult !== undefined ? [verifierResult] : [])];
      return { spec, workspace: ws, roles, candidate, diff: diffText };
    };

    const verifyShadow = async (t: WorkerTask, ws: WorkspaceHandle): Promise<ShadowVerification> => {
      // Install deps in the shadow workspace before verifying — the shadow is a clean
      // worktree without node_modules, so pnpm test / vitest will fail without this.
      await installWorkspaceDeps(ws, parentCtx, deps.dependencyInstall);
      const verifierResult = await dispatchRole("verifier", spawnRole("verifier", parentCtx), t, ws, [], parentCtx, runEngine);
      const verdict = (verifierResult.detail as { verdict?: unknown } | undefined)?.verdict;
      const pass = verifierResult.outcome === "success" && verdict === "pass";
      return { pass, roles: [verifierResult], ...(pass ? {} : { reason: verifierResult.summary ?? "shadow verifier did not pass" }) };
    };

    const promote = async (t: WorkerTask, ws: WorkspaceHandle, roleResults: readonly RoleResult[], composite: number): Promise<{ promoted: boolean; reason?: string; conflicts?: readonly string[] }> => {
      // H5 FAIL-CLOSED: a promote REQUIRES gate-wall authorization — no gate-wall ⇒ DENY.
      if (gateWall === undefined) return { promoted: false, reason: "gate-wall not wired — promote denied (fail-closed)" };
      const governanceGrant = autonomyForTier(asTier(parentIdentity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
      const governance: PromoteGovernance = await gateWall.evaluate({ grant: governanceGrant, action: { kind: "promote", task: t, results: [...roleResults] }, identity: parentIdentity });
      if (!governance.allow) return { promoted: false, reason: governance.reason ?? "gate-wall denied promotion" };
      const result = await workspaces.promote(ws, {
        evaluation: { approved: true, score: composite, evaluatorId: "deterministic-judge" },
        governance,
        message: `worker-model (tournament): ${t.goal}`,
      });
      return {
        promoted: result.promoted,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}),
      };
    };

    return {
      ...(verificationMode !== undefined ? { verificationMode } : {}),
      allocate,
      runCandidate,
      judge: (candidates) => judge.judge(candidates),
      applyDiff: async (ws, diff) => (deps.applyDiff !== undefined ? deps.applyDiff(ws, diff) : defaultApplyDiff(parentCtx, ws, diff, task.goal)),
      verifyShadow,
      promote,
      discard: async (ws) => safeDiscard(workspaces, ws),
      retain: async (ws, reason) => (retainFailedWorkspaces && workspaces.retain !== undefined ? safeRetain(workspaces, ws, reason) : safeDiscard(workspaces, ws)),
      recordReceipt: async (receipt) => {
        await receipts.append(
          {
            operation: "worker.tournament",
            outcome: { status: receipt.promoted ? "success" : "failure", ...(receipt.reason !== undefined ? { detail: receipt.reason } : {}) },
            requestId: task.taskId,
            metadata: {
              taskId: task.taskId,
              candidates: receipt.candidates,
              winner: receipt.winner,
              shadow: receipt.shadow,
              promoted: receipt.promoted,
            },
            project: task.targetRepo,
          },
          parentIdentity,
        );
      },
      cost: runCost,
      killed: async () => killHalt(task, parentIdentity, parentCtx),
      emit: (ev) => emitTournamentEvent(task, parentIdentity, ev),
    };
  }

  return { run, spawnRole };
}

/** Parse the verifier's check results into the candidate's pass flags + (best-effort) test count. */
function readVerifier(verifierResult: RoleResult | undefined): { typecheckPass: boolean; testsPass: boolean; testCount?: { passed: number; total: number }; testEvidence: "executed" | "zero" | "unverified" | "absent"; checks: ReadonlyArray<{ name: string; passed: boolean }> } {
  // Builder failed (no verify ran) ⇒ both gates fail.
  if (verifierResult === undefined) return { typecheckPass: false, testsPass: false, testEvidence: "absent", checks: [] };
  const detail = (verifierResult.detail ?? {}) as Record<string, unknown>;
  const checks = Array.isArray(detail.checks) ? (detail.checks as Array<Record<string, unknown>>) : [];
  const find = (name: string) => checks.find((c) => c.name === name);
  const typecheck = find("typecheck");
  const test = find("test");
  const verdict = detail.verdict;
  const authoritativePass = verdict === "pass" && verifierResult.outcome === "success";
  const typecheckPass = typecheck !== undefined ? typecheck.exitCode === 0 : authoritativePass;
  const testsPass = test !== undefined ? test.exitCode === 0 : authoritativePass;
  const testCount = test !== undefined && typeof test.outputTail === "string" ? parseTestCount(test.outputTail) : undefined;
  // Finding D — TEST-EXECUTION EVIDENCE: distinguish a REAL executed suite from a passing command
  // that proved nothing, so the judge cannot score them identically. A passing "test" check with a
  // parsed count>0 is "executed"; a parsed count of 0 is "zero" (a runner that ran nothing); a pass
  // with no parseable count is "unverified" (e.g. `echo done` — exit 0 but no test tally); NO "test"
  // check at all (only custom checks like `ci`) is "absent". This is an objective, deterministic fact.
  let testEvidence: "executed" | "zero" | "unverified" | "absent";
  if (test === undefined) {
    testEvidence = "absent";
  } else if (testCount !== undefined) {
    testEvidence = testCount.total > 0 ? "executed" : "zero";
  } else {
    testEvidence = "unverified";
  }
  // ISSUE 4: carry the ACTUAL per-check results (by their real names) so the UI shows custom
  // IKBI_CHECKS correctly instead of forcing every run onto the typecheck/tests axes.
  const checkList = checks.map((c) => ({ name: String(c.name), passed: c.exitCode === 0 }));
  return { typecheckPass, testsPass, ...(testCount !== undefined ? { testCount } : {}), testEvidence, checks: checkList };
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

/**
 * Best-effort RETAIN (Bug 2) for a failed build: keep the worktree on disk for inspection
 * instead of discarding it. Falls back to discard when the manager has no `retain` (older
 * injected doubles) so behavior degrades safely. Never masks the original error.
 */
async function safeRetain(
  workspaces: NonNullable<OrchestratorDeps["workspaces"]>,
  workspace: WorkspaceHandle,
  reason: string,
): Promise<void> {
  try {
    if (workspaces.retain !== undefined) await workspaces.retain(workspace, reason);
    else await workspaces.discard(workspace);
  } catch {
    // swallow — the caller is already failing; retain is best-effort.
  }
}

/** The default orchestrator, wired to the real frozen singletons. */
export const orchestrator = createOrchestrator();

/** The default entry: run a worker task under the parent operation context. */
export function runWorker(task: WorkerTask, parentCtx: OperationContext): Promise<WorkerResult> {
  return orchestrator.run(task, parentCtx);
}
