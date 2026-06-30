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

import { log } from "../../core/log.js";
import { autonomyForTier, type AutonomyGrant } from "../../core/trust/contract.js";
import { asTier, clampTier, tierRank, TRUST_FLOOR } from "../../core/trust/index.js";
import type { OutcomeStatus, RecordOutcomeInput, TrustDecision } from "../../core/trust/contract.js";
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

// Escalation: the orchestrator folds hard signals across the scoring roles and asks the
// escalation engine whether a higher tier is warranted, emitting `escalation.*` events
// (see observeEscalation). In BUILD MODE it also ACTS on the recommendation: a builder that
// fails on the cheap (worker) tier, when the engine recommends a mid-tier escalation, is
// re-run ONCE on the escalated model in the SAME workspace (see the build-mode escalation
// retry block in run()). Capped at a single retry (escalationAttempted) and fail-closed.
import {
  escalationConfig,
  escalationEngine,
  escalationEvaluated,
  escalationTriggered,
  escalationDeclined,
} from "../escalation/index.js";
import type { EscalationSignals, EscalationDecision } from "../escalation/index.js";
import { decideRecovery } from "../recovery/index.js";
import type { RecoveryAttempt } from "../recovery/index.js";
import { rosterFromIds } from "../model-router/index.js";

import type { ExecRequest, GovernedExec } from "../governed-exec/index.js";
import type { DependencyInstall } from "../dependency-install/contract.js";

import { builder, createBuilder, MAX_TOOL_ITERATIONS } from "./builder.js";
import { createPatchsmith } from "./patchsmith.js";
import { runTournament } from "./tournament.js";
import type { CandidateRun, CandidateSpec, ShadowVerification, TournamentEngine, TournamentEvent } from "./tournament.js";
import { captureStreamedStdout, classifyUnresolvableReason, committedPackageJsonDiff, parseChecksEnv, parseTestCount, PROJECT_MANIFESTS, resolveChecks, resolveCheckTimeoutMs, UNRESOLVABLE_NEXT_STEPS, type VerificationKind, workingTreePackageJsonDiff, workingTreePlanningDiff } from "./checks.js";
import { builderModel, competitiveBuilderModels } from "./role-models.js";
import { createCritic, critic } from "./critic.js";
import { createRefuter, refuter, proposalFromFinding, type RefuterFinding } from "./refuter.js";
import { liveCorrectionAccess } from "./correction-application.js";
import { createCorrection } from "../correction-library/store.js";
import type { CorrectionProposeInput } from "../correction-library/contract.js";
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
  workerRoleSkipped,
  workerStarted,
  workerTrustEstablished,
  workerVerification,
  workerFixLoopCompleted,
  workerCriticFixLoopCompleted,
  workerEscalationRetried,
  workerEscalationSuppressed,
} from "./events.js";
import { CONTRACT_VERSION, toOutcomeStatus, WorkerError, WORKER_ROLES } from "./contract.js";
import { fireStopHooks } from "../hooks/index.js";
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
  builderFailed: boolean;
}

/** Handoff-only context captured from roles (not scored). */
interface EscalationHandoffFields {
  scoutFindings?: string;
  goalAlignment?: { status: string; summary: string; missingFiles: readonly string[] };
  criticFeedback?: string;
  verificationDetails?: string;
}

// ── DEPENDENCY INSTALL: ensure worktree has node_modules ──────────────────────

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, symlinkSync, mkdirSync, type Dirent } from "node:fs";
import { join, basename } from "node:path";

/**
 * Run `git status --porcelain` on `targetRepo`. Returns a human-readable reason
 * string when the repo has uncommitted changes, undefined when clean or when git
 * is unavailable / the path is not a git repo (fail-open: let workspace allocation
 * surface the real error).
 */
function liveCheckTargetDirty(targetRepo: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", targetRepo, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).trim();
    return out.length === 0 ? undefined : "target repo has uncommitted changes — commit or stash them first";
  } catch {
    return undefined; // git unavailable or not a git repo — let workspace allocation handle it
  }
}

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

  // Symlink local file: deps so pnpm install can resolve them in the isolated worktree.
  // Reads package.json from the TARGET repo (not worktree) to find file: references,
  // resolves them relative to the target repo root, and creates symlinks in the worktree
  // parent directory so the relative paths work.
  try {
    const raw = readFileSync(join(workspace.targetRepo, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, Record<string, string>>;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const worktreeParent = join(worktreePath, "..");
    for (const [, spec] of Object.entries(allDeps)) {
      if (!spec.startsWith("file:")) continue;
      const relPath = spec.slice(5); // remove "file:" prefix
      const absTarget = join(workspace.targetRepo, relPath);
      // Use basename to avoid relPath's ".." escaping the worktree parent.
      // e.g. a target repo with "some-pkg": "file:../some-pkg" → symlink at wt/some-pkg
      // pointing at the resolved sibling so the isolated-worktree install can find it.
      const symlinkPath = join(worktreeParent, basename(absTarget));
      if (!existsSync(symlinkPath) && existsSync(absTarget)) {
        mkdirSync(join(symlinkPath, ".."), { recursive: true });
        symlinkSync(absTarget, symlinkPath);
      }
    }
  } catch {
    // Non-fatal: if we can't read/symlink, the install will fail and the builder sees it
  }

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

// ── FAST-FAIL BARE-REPO DIAGNOSTIC (Work Order 2) ─────────────────────────────
// A target with NO project manifest at its root cannot be verified: `resolveChecks`
// fails closed RED, but only AFTER the scout + builder have already burned paid model
// calls — and a bare loose-file repo (e.g. a single `hello.js`) could keep the loop
// churning toward a timeout. We detect the unverifiable shape HERE, before any model
// call or workspace allocation, and reject with an ACTIONABLE diagnostic at zero API cost.

/** Source-file extensions used to tell "loose source, no manifest" from "empty/unrecognized". */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".cts", ".mts",
  ".py", ".rs", ".go", ".gd", ".rb", ".java", ".kt", ".cs",
  ".c", ".h", ".cpp", ".cc", ".hpp", ".hh", ".swift", ".php",
]);

/** Directories never worth scanning for source files (vcs / build / vendor). */
const DIAGNOSTIC_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".ikbi",
]);

/**
 * Diagnose a target repo that cannot be verified. Returns an actionable message when the repo
 * root has NO recognizable project manifest (mirrors `resolveChecks`, which requires a manifest
 * AT the worktree root), or `undefined` when a manifest exists (normal flow) or the path is
 * unreadable (fail-open — let workspace allocation surface the real error). Best-effort and
 * never throws: a bounded, depth-limited walk summarizes whatever source files ARE present so
 * the operator sees what ikbi saw.
 */
function diagnoseBareRepo(root: string): string | undefined {
  // A recognizable manifest AT the root is exactly what resolveChecks needs (root === worktree).
  if (PROJECT_MANIFESTS.some((m) => existsSync(join(root, m)))) return undefined;
  if (!existsSync(root)) return undefined; // unreadable — fail-open

  // No manifest — summarize the source files that ARE here (depth-limited; skip vcs/build dirs).
  const counts = new Map<string, number>();
  let totalFiles = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || totalFiles > 200) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdir — skip (best-effort)
    }
    for (const e of entries) {
      if (totalFiles > 200) return;
      if (e.isDirectory()) {
        if (!DIAGNOSTIC_SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        const ext = dot > 0 ? e.name.slice(dot).toLowerCase() : "";
        if (SOURCE_EXTENSIONS.has(ext)) {
          counts.set(ext, (counts.get(ext) ?? 0) + 1);
          totalFiles += 1;
        }
      }
    }
  };
  walk(root, 0);

  const summary =
    totalFiles === 0
      ? "empty or unrecognized repo (no source files, no manifest)"
      : [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([ext, n]) => `${n} ${ext}`)
          .join(", ");

  return [
    "No project manifest or verifier detected.",
    `Detected files: ${summary}`,
    "Suggested next steps:",
    "  - Initialize a package manifest (e.g., `pnpm init`, `cargo init`)",
    '  - Provide an explicit check command: `ikbi build <repo> --check "python -m pytest"`',
    '  - Use `ikbi fix <repo> --check "<command>"` for fix mode',
  ].join("\n");
}

/** True when the operator declared an explicit, well-formed check override (IKBI_CHECKS). */
function hasExplicitChecks(env: NodeJS.ProcessEnv): boolean {
  const parsed = parseChecksEnv(env.IKBI_CHECKS);
  return parsed !== undefined && parsed !== "malformed";
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
    // builderFailed: ANY builder failure is a strong signal that the cheap model can't handle
    // this task. Combined with the high weight (50), this alone crosses the escalation threshold.
    if (result.outcome === "failure") acc.builderFailed = true;
    // ALSO flag as failed when the builder called done but wrote ZERO files — a model that
    // reads files and calls done without writing anything is functionally failed even though
    // the outcome is "success". This closes the gap where a cheap model produces nothing but
    // the escalation engine never fires because the outcome gate blocks it.
    // ONLY fires when filesWritten is explicitly present and empty — absent means the builder
    // didn't report file counts (stubs, injected test roles), not that it wrote nothing.
    if (result.outcome === "success" && Array.isArray(detail.filesWritten) && detail.filesWritten.length === 0) {
      acc.builderFailed = true;
    }
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
 *
 * Returns BOTH the decision summary for THIS evaluation (so the run can surface the strongest
 * recommendation on its result for operators) AND the full `EscalationDecision` (so the build-mode
 * orchestrator can ACT on it — swap models + retry). `summary`/`decision` are `undefined` when no
 * evaluation ran (escalation disabled, a non-scoring role, or a guarded failure).
 */
interface EscalationObservation {
  readonly summary: WorkerResult["escalation"] | undefined;
  readonly decision: EscalationDecision | undefined;
}

function observeEscalation(
  events: EventBusSurface,
  task: WorkerTask,
  role: WorkerRole,
  result: RoleResult,
  acc: MutableEscalationSignals,
  handoff: EscalationHandoffFields,
  identity: AgentIdentity,
): EscalationObservation {
  try {
    foldRoleSignals(role, result, acc, handoff);
    // Escalation is gated by the global toggle (IKBI_ESCALATION_ENABLED) AND the per-run tier:
    // `--tier mid|frontier` sets escalationDisabled so a single capable builder fails closed
    // rather than silently retrying on a different model. The signals are still folded above so
    // the run's escalation observability (and any downstream report) stays accurate.
    if (!escalationConfig.enabled || task.escalationDisabled === true) return { summary: undefined, decision: undefined };
    // Only the roles that carry escalation-relevant signal trigger an evaluation.
    if (role !== "builder" && role !== "critic" && role !== "verifier") return { summary: undefined, decision: undefined };

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
    // Surface this evaluation on the run result (observe-only summary) AND hand the full decision
    // back so the build-mode orchestrator can act on it (model swap + retry).
    const summary: WorkerResult["escalation"] = {
      recommended: decision.escalate,
      fromTier: decision.currentTier,
      ...(decision.targetTier !== undefined ? { targetTier: decision.targetTier } : {}),
      total: decision.score.total,
      ...(decision.escalate ? { requiresApproval: decision.requiresApproval } : {}),
      ...(decision.escalate
        ? { reason: `escalation recommended → ${decision.targetTier ?? "higher tier"}` }
        : decision.declineReason !== undefined
          ? { reason: decision.declineReason }
          : {}),
    };
    return { summary, decision };
  } catch {
    // Escalation observability is ADVISORY — a fold/eval/publish failure never breaks the run.
    return { summary: undefined, decision: undefined };
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
  /**
   * Sink for the PROPOSED corrections the refuter files after a refuted build. Default writes them
   * to the correction-library store (~/.ikbi/corrections, approved=false). Injectable so tests can
   * capture proposals without touching disk. Best-effort: a throw here never fails the run.
   */
  readonly proposeCorrection?: (input: CorrectionProposeInput) => void;
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
  /** Clock for the whole-pipeline budget deadline. Default Date.now. Injectable for tests. */
  readonly now?: () => number;
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
  /**
   * Pre-allocation dirty-repo check. When the target repo has uncommitted changes the run is
   * rejected immediately with a clear message (before any workspace is allocated). Default: the
   * live `git status --porcelain` check. Injectable for tests so they can drive the rejection
   * path without a real git repo.
   * Returns a non-empty reason string when the repo is dirty, undefined when clean or unknown.
   */
  readonly checkTargetDirty?: (targetRepo: string) => Promise<string | undefined>;
  /**
   * Memory governor — intercepts writes to governed surfaces (CLAUDE.md, .ikbi/*, brain pages)
   * and converts them to operator-reviewed proposals. When wired, the builder's tool-executor
   * routes governed writes through the governor instead of writing directly.
   * Absent ⇒ no interception (backward compatible).
   */
  readonly memoryGovernor?: import("../memory-governor/contract.js").MemoryGovernor;
}

/** A role identity spawned under the parent ceiling (#10). */
interface SpawnedRole {
  readonly identity: AgentIdentity;
  readonly kind: IdentityKind;
  readonly autonomy: AutonomyGrant;
  /** The GENUINE ValidatedIdentity (provenance), threaded to trust.recordOutcome as the subject. */
  readonly validated: ValidatedIdentity;
}

const DEFAULT_ROLES: Record<WorkerRole, RoleFn> = { scout, builder, critic, verifier, refuter, integrator };

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

  // WHOLE-PIPELINE BUDGET (H3 companion): per-role timeouts bound each role, but a run does
  // scout→builder→critic→verifier→integrator with retry/rescue and competitive/tournament
  // fan-out — each role re-armed with a fresh role budget. Without a total ceiling a
  // misbehaving run can consume many multiples of the role timeout. We arm a per-run deadline
  // and surface it through `killHalt`, so the EXISTING role-boundary kill checkpoints enforce
  // it for free (clean stop: discard, no half-promote). `totalBudgetMs <= 0` disables it.
  const nowMs = deps.now ?? Date.now;
  const totalBudgetMs = config.totalBudgetMs ?? 0;
  const buildDeadlines = new WeakMap<WorkerTask, number>();
  function armBudget(task: WorkerTask): void {
    if (totalBudgetMs > 0 && !buildDeadlines.has(task)) buildDeadlines.set(task, nowMs() + totalBudgetMs);
  }
  function budgetExceeded(task: WorkerTask): boolean {
    const deadline = buildDeadlines.get(task);
    return deadline !== undefined && nowMs() > deadline;
  }

  // The active run's mid-loop halt check, handed to the (real) builder so its loop can stop at
  // iteration granularity on a kill or budget overrun. Set at run() entry; builds are serial.
  let activeCheckHalt: (() => Promise<{ halt: boolean; reason?: string }>) | undefined;

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
      ? { run: (req: ExecRequest) => baseGovExec.run({ ...req, onOutput: req.onOutput !== undefined ? (chunk: string, stream: "stdout" | "stderr") => { req.onOutput!(chunk, stream); execSink(chunk, stream); } : execSink }) }
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
  function makeCostingEngine(maxBudgetUsd?: number, effort?: "low" | "medium" | "high" | "max"): { engine: RoleEngine; cost: () => number } {
    let total = 0;
    let budgetExhausted = false;
    const budget = maxBudgetUsd;
    const costingEngine: RoleEngine = {
      invokeModel: async (request: ModelRequest): Promise<ModelResponse> => {
        if (budgetExhausted) {
          throw Object.assign(new Error(`budget exhausted: cumulative cost exceeded $${budget?.toFixed(4)} cap`), { code: "BUDGET_EXHAUSTED" });
        }
        // Apply effort-level overrides to the model request (temperature, maxTokens)
        // when the task specified --effort. These override role defaults.
        const effortParams = effort !== undefined ? (() => { 
          const { effortModelParams: emp } = require("./contract.js") as { effortModelParams: (e?: string) => { temperature: number; maxTokens: number } | undefined };
          return emp(effort);
        })() : undefined;
        const effRequest = effortParams !== undefined
          ? { ...request, temperature: effortParams.temperature, maxTokens: effortParams.maxTokens }
          : request;
        const r = await invokeModel(effRequest);
        total += r.cost?.usd ?? 0;
        if (budget !== undefined && total > budget && budget > 0) {
          budgetExhausted = true;
          const msg = `budget exhausted: cumulative cost $${total.toFixed(4)} exceeds $${budget.toFixed(4)} cap`;
          throw Object.assign(new Error(msg), { code: "BUDGET_EXHAUSTED", costUsd: total, budgetUsd: budget });
        }
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
    // FIX 1b (script integrity — truncation): the working-tree package.json diff MUST be captured in
    // FULL. govExec's ExecResult carries only a bounded `stdoutTail` (~2000 chars), so a scripts
    // mutation near the TOP of a larger diff is truncated away before the JSON-semantic parser sees it
    // (the full diff flags it; the last-2000-char tail returns clean). We stream the diff and
    // accumulate every chunk via `captureStreamedStdout`. This calls baseGovExec directly — the
    // govExecForRoles wrapper OVERRIDES `onOutput` with the UI sink, which would defeat the capture —
    // and forwards each chunk to that UI sink ourselves to preserve live output. baseGovExec is
    // defined whenever govExecForRoles is (the wrapper requires it; the non-wrapped branch IS it).
    const captureFullGitDiff = (args: readonly string[], ws: WorkspaceHandle, purpose: string): Promise<string> =>
      baseGovExec === undefined
        ? Promise.resolve("")
        : captureStreamedStdout(
            (onOutput) => baseGovExec.run({ parentCtx, command: "git", args: [...args], cwd: ws.path, purpose, onOutput }),
            execSink,
          );
    const scriptIntegrityDiff: ((ws: WorkspaceHandle) => Promise<string>) | undefined =
      hasCommitted || govExecForRoles !== undefined
        ? (ws: WorkspaceHandle): Promise<string> => {
            const committedP = hasCommitted ? workspaces.diff!(ws) : Promise.resolve("");
            // C2: the committed base..scratch range above (workspaces.diff) uses git's DEFAULT 3-line
            // context — too narrow for the JSON-semantic parser to reconstruct a whole package.json, so
            // a committed scripts mutation (e.g. a separate-line "test":/value rewrite) falls back to
            // the weaker line-scan and can slip through. Capture the committed package.json range at
            // FULL context too (governed streamed git), so it is caught semantically. Without governed
            // git we keep the 3-line committed diff (no regression).
            const committedPkgP =
              govExecForRoles !== undefined
                ? committedPackageJsonDiff(
                    (args) => captureFullGitDiff(args, ws, "verifier: script-integrity committed package.json diff"),
                    ws.baseRef,
                    ws.scratchBranch,
                  ).catch(() => "")
                : Promise.resolve("");
            const workingP =
              govExecForRoles !== undefined
                ? workingTreePackageJsonDiff(
                    (args) => captureFullGitDiff(args, ws, "verifier: script-integrity working-tree diff"),
                    ws.path,
                    ws.baseRef,
                  ).catch(() => "")
                : Promise.resolve("");
            return Promise.all([committedP, committedPkgP, workingP]).then(([c, cp, w]) => `${c}\n${cp}\n${w}`);
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
      // Codex HIGH-2: load operator-APPROVED corrections so an approved expected_manifest_change
      // actually takes effect when classifying package.json changes (and its appliedCount advances).
      corrections: liveCorrectionAccess,
    });
  }

  /** The critic for THIS run. Honors injected tests, otherwise gives the critic workspace diff access. */
  function criticFor(): RoleFn {
    if (deps.roles?.critic !== undefined) return deps.roles.critic;
    return createCritic({
      ...(workspaces.diff !== undefined ? { diff: (ws: WorkspaceHandle) => workspaces.diff!(ws) } : {}),
    });
  }

  // REFUTER: the OPTIONAL adversarial gate. Enabled ONLY by config.enableRefuter (env
  // IKBI_WORKER_MODEL_ENABLE_REFUTER / deps.config). Deliberately NOT keyed off an injected
  // deps.roles.refuter — tests build the full role map by iterating WORKER_ROLES, so keying on
  // injection would silently enable the refuter (and add a 6th dispatched role) everywhere. With
  // config the sole switch, the default five-role pipeline and every existing full-run test are
  // byte-unchanged; a refuter test opts in via deps.config.enableRefuter.
  const refuterEnabled = config.enableRefuter === true;

  /** The refuter for THIS run. Honors injected tests, otherwise wires it to the workspace diff. */
  function refuterFor(): RoleFn {
    if (deps.roles?.refuter !== undefined) return deps.roles.refuter;
    return createRefuter({
      ...(workspaces.diff !== undefined ? { diff: (ws: WorkspaceHandle) => workspaces.diff!(ws) } : {}),
      // Codex HIGH-2: load operator-APPROVED corrections so an approved correction suppresses the
      // matching refutation finding (and its appliedCount advances) instead of being ignored.
      corrections: liveCorrectionAccess,
      // HIGH-3: wire semantic spec-match (#7) when IKBI_REFUTER_SEMANTIC is set.
      // Without this, check #7 falls through to a trivial heuristic that passes whenever
      // any diff exists — even off-target builds (e.g. reformatting a README instead of
      // fixing an auth bug). Default: false for backward compat.
      ...(process.env.IKBI_REFUTER_SEMANTIC === "true" ? { semantic: true } : {}),
    });
  }

  // Sink for refuter-proposed corrections (best-effort; default writes to the correction store).
  const proposeCorrection: (input: CorrectionProposeInput) => void =
    deps.proposeCorrection ?? ((input) => { createCorrection(input); });

  /**
   * After a REFUTED build, file each failed refuter finding as a PROPOSED correction
   * (approved=false — governance requires human/operator approval before it takes effect).
   * Best-effort: proposing corrections must never fail the run.
   */
  function fileRefuterCorrections(refuterResult: RoleResult, runId: string): void {
    try {
      const detail = (refuterResult.detail ?? {}) as { refuted?: unknown; findings?: unknown };
      if (detail.refuted !== true || !Array.isArray(detail.findings)) return;
      for (const f of detail.findings as RefuterFinding[]) {
        if (f.passed) continue;
        // Only propose corrections for CRITICAL findings (GLM 5.2 MEDIUM-3).
        // Warnings are operator-visible but not reusable lessons.
        if (f.severity !== "critical") continue;
        proposeCorrection(proposalFromFinding(f, runId));
      }
    } catch {
      // best-effort — never let correction proposal break the build pipeline
    }
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
      // Mid-loop kill/budget halt for the real builder loop (no-op when unset / injected roles).
      ...(activeCheckHalt !== undefined ? { checkHalt: activeCheckHalt } : {}),
      // Memory governor: intercepts governed writes into proposals.
      ...(deps.memoryGovernor !== undefined ? { memoryGovernor: deps.memoryGovernor } : {}),
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

  /** Record a role's outcome to receipts. Trust recording is opt-in (skipTrust=true skips it). */
  async function recordRole(
    task: WorkerTask,
    workspace: WorkspaceHandle,
    spawned: SpawnedRole,
    result: RoleResult,
    costUsd?: number,
    model?: string,
    skipTrust?: boolean,
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
      result.outcome === "failure" && (stopReason === "timeout" || stopReason === "max_iterations" || stopReason === "no_progress" || stopReason === "stuck_detected");
    // FIX B: no_progress and stuck_detected are model-behavior limits (the model
    // ran out of productive moves), not quality failures. They join timeout as
    // always-suppressible. max_iterations remains suppressible only without bad-output evidence.
    const suppressEligible = stopReason === "timeout" || stopReason === "no_progress" || stopReason === "stuck_detected" || (stopReason === "max_iterations" && !badOutputEvidence);
    const suppressTrustSignal = isPerformanceFailure && suppressEligible && config.penalizeTimeouts !== true;

    // R1: an explicit, auditable record of the trust decision for EVERY performance-class failure —
    // whether it was suppressed or penalized, and why.
    let perfTrust: { decision: "suppressed" | "penalized"; reason: string } | undefined;
    if (isPerformanceFailure) {
      if (suppressTrustSignal) {
        const whyMap: Record<string, string> = {
          timeout: "wall-clock timeout (performance)",
          no_progress: "model out of productive moves (performance)",
          stuck_detected: "model stuck in loop (performance)",
        };
        const why = whyMap[String(stopReason)] ?? "max_iterations with no bad-output evidence";
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
    // WO4: stream-stall observations (builder rounds cut off mid tool-call) — folded into the
    // role receipt so the run-level audit trail records that stalls happened, alongside the
    // per-stall receipts the builder writes at detection time.
    const toolCallStalls = (result.detail as Record<string, unknown> | undefined)?.toolCallStalls;

    await receipts.append(
      {
        operation,
        outcome: { status, ...(result.summary !== undefined ? { detail: result.summary } : {}) },
        requestId: task.taskId,
        metadata: {
          role: result.role,
          taskId: task.taskId,
          workspaceId: workspace.id,
          targetBranch: workspace.baseBranch,
          outcome: result.outcome,
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(perfTrust !== undefined
            ? { performanceFailure: true, trustDecision: perfTrust.decision, trustDecisionReason: perfTrust.reason }
            : {}),
          ...(doneClaim?.rootCause !== undefined ? { rootCause: doneClaim.rootCause } : {}),
          ...(doneClaim?.fixRationale !== undefined ? { fixRationale: doneClaim.fixRationale } : {}),
          ...(Array.isArray(filesWritten) ? { filesChanged: filesWritten } : {}),
          ...(Array.isArray(toolCallStalls) && toolCallStalls.length > 0 ? { toolCallStalls } : {}),
        },
        project: task.targetRepo,
      },
      spawned.identity,
    );

    // FIX A: per-build trust recording. When skipTrust is set, trust is recorded ONCE
    // after the build completes (worker.build) instead of per-role (worker.role.*).
    // This eliminates the cascade where one failed build = 3-4 consecutive failures.
    if (skipTrust) return;

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

  /**
   * Record ONE trust outcome per BUILD. Called at every terminal exit point.
   *
   * `suppress` is true when the outcome is an operator/governance decision (gate-wall
   * denial, approval rejection, misconfiguration) — NOT a worker quality failure. In that
   * case we write an auditable suppression receipt and skip trust entirely.
   *
   * `statusOverride` lets callers remap the outcome — e.g. a green build that can't
   * autoCommit (sub-trusted tier) is really a `success` for trust purposes, not `partial`.
   */
  async function recordBuildTrust(
    status: OutcomeStatus,
    workerSpawned: SpawnedRole | undefined,
    taskId: string,
    targetRepo: string,
    suppress: boolean,
    reason?: string,
  ): Promise<void> {
    if (workerSpawned === undefined) return;
    if (suppress) {
      await receipts.append(
        {
          operation: "worker.trust.signal_suppressed",
          outcome: { status: "success", detail: `build trust signal suppressed: ${reason ?? "operator/governance decision — not a worker quality failure"}` },
          requestId: taskId,
          metadata: { agentId: workerSpawned.identity.agentId, suppressReason: reason },
          project: targetRepo,
        },
        workerSpawned.identity,
      );
      return;
    }
    await trust.recordOutcome(
      {
        agentId: workerSpawned.identity.agentId,
        kind: workerSpawned.kind,
        defaultTrustTier: workerSpawned.identity.trustTier ?? TRUST_FLOOR,
        operation: "worker.build",
        status,
      },
      workerSpawned.validated,
    );
  }

  /** Cooperative kill checkpoint: does an active kill target THIS run? (read-only; never publishes). */
  async function killHalt(task: WorkerTask, parentIdentity: AgentIdentity, parentCtx: OperationContext): Promise<string | undefined> {
    const k = await killCheck({ agentId: parentIdentity.agentId, runId: task.taskId, ...(parentCtx.requestId !== undefined ? { requestId: parentCtx.requestId } : {}) });
    if (k.killed) return `halted by kill-switch (${k.signal?.mode ?? "soft"})`;
    // Whole-pipeline budget: treat an exceeded deadline like a cooperative halt so the run
    // stops cleanly at this role boundary (discard, no half-promote) instead of grinding on.
    if (budgetExceeded(task)) return `halted: total build budget exceeded (${totalBudgetMs}ms)`;
    return undefined;
  }

  // ── AUTO-VERIFY RESCUE HELPER ────────────────────────────────────────────────
  // Extracted so every orchestrator path (single-run, competitive, tournament) can
  // rescue a builder that wrote correct code but hit a protocol termination (no_progress,
  // max_iterations, timeout, stuck_detected) before ever calling run_checks.
  //
  // Design constraints (from the user spec):
  //   • Only applies to the builder role.
  //   • Only fires on protocol terminations (NOT model-failure stops like error/content_filter).
  //   • Requires filesWritten > 0 (something on disk to verify).
  //   • Requires zero policy violations (fail-closed on unsafe work).
  //   • Runs the REAL verifier — no weakening, no bypass.
  //   • Stamps autoVerifyRescue: true + original_builder_stop + files_written on the result.
  //   • Fail-closed: if the verifier is RED or blocked, the original failure stands.

  const RESCUABLE_TERMINATIONS: ReadonlySet<string> = new Set(["max_iterations", "timeout", "stuck_detected", "no_progress"]);

  /**
   * If `builderResult` is a protocol-terminated builder failure with written files and
   * no policy violations, run the verifier against the workspace. On GREEN, reclassify
   * the builder as success and stamp rescue metadata. On RED or blocked, return unchanged.
   *
   * @param builderResult  The builder's RoleResult (may be mutated on rescue).
   * @param runVerifier    A function that dispatches the verifier and returns its RoleResult.
   * @returns The (possibly rescued) builder result + the rescue verifier result if one ran.
   */
  async function maybeAutoVerifyRescueBuilderResult(
    builderResult: RoleResult,
    runVerifier: () => Promise<RoleResult>,
  ): Promise<{ result: RoleResult; rescueVerify?: RoleResult }> {
    // Guard: only rescue builder failures.
    if (builderResult.role !== "builder" || builderResult.outcome !== "failure") {
      return { result: builderResult };
    }
    const bd = (builderResult.detail ?? {}) as Record<string, unknown>;
    const builderStop = typeof bd.stopReason === "string" ? bd.stopReason : "";
    const builderFilesWritten = Array.isArray(bd.filesWritten) ? bd.filesWritten.length : 0;
    const policyViolations = Array.isArray(bd.policyViolations) ? bd.policyViolations : [];

    // Guard: only protocol terminations, not model-failure stops.
    if (!RESCUABLE_TERMINATIONS.has(builderStop)) return { result: builderResult };
    // Guard: must have files on disk to verify.
    if (builderFilesWritten <= 0) return { result: builderResult };
    // Guard: fail closed on any unsafe policy violation.
    if (policyViolations.length > 0) return { result: builderResult };

    // Run the real verifier against the current workspace.
    const rescueVerify = await runVerifier();
    if (rescueVerify.outcome === "success") {
      const rescued: RoleResult = {
        ...builderResult,
        outcome: "success",
        summary: `${builderResult.summary}; auto-verify rescue: verifier GREEN on written files (no run_checks before ${builderStop})`,
        detail: {
          ...bd,
          autoVerifyRescue: true,
          originalBuilderStop: builderStop,
          filesWritten: bd.filesWritten,
          rescueVerificationResult: "pass",
        },
      };
      return { result: rescued, rescueVerify };
    }
    // Verifier RED: the original failure stands. Stamp the attempt for observability.
    return {
      result: {
        ...builderResult,
        detail: { ...bd, autoVerifyRescueAttempted: true, rescueVerificationResult: "fail" },
      },
      rescueVerify,
    };
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
    // Builder model resolution, highest precedence first:
    //   1. --tier preset (builderModelOverride) — an explicit, operator-chosen tier builder.
    //   2. --complexity large — bump straight to the mid-tier model, skipping flash.
    //   3. the configured single builder model (default).
    const effectiveBuilderModel =
      task.builderModelOverride ?? (task.complexity === "large" ? (escalationConfig.tierModels.mid[0] ?? singleBuilderModel) : singleBuilderModel);
    armBudget(task); // start the whole-pipeline wall-clock deadline (covers every dispatch path)
    // Hand the (real) builder a mid-loop halt check so its loop stops promptly on a kill/budget
    // overrun. Reuses killHalt (kill-switch + budget); no-op for tests that inject a fake builder.
    activeCheckHalt = async () => {
      const reason = await killHalt(task, parentIdentity, parentCtx);
      return reason !== undefined ? { halt: true, reason } : { halt: false };
    };

    // DIRTY REPO CHECK: refuse to build against a repo with uncommitted changes.
    // Runs BEFORE any workspace allocation, regardless of mode (single, competitive, tournament) —
    // all modes allocate worktrees from the same base and would inherit the ambiguous partial state.
    // Skip when reusing a workspace — the step planner already checked on the first step.
    if (task.reuseWorkspace === undefined) {
      const checkDirty = deps.checkTargetDirty ?? ((repo) => Promise.resolve(liveCheckTargetDirty(repo)));
      const dirtyReason = await checkDirty(task.targetRepo);
      if (dirtyReason !== undefined) {
        const reason = `Refusing to build: ${dirtyReason}`;
        events.publish(workerFailed.create({ taskId: task.taskId, reason }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } }));
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason };
      }
    }

    // FAST-FAIL BARE-REPO DIAGNOSTIC (Work Order 2): a target with no project manifest at its
    // root cannot be verified — `resolveChecks` fails RED, but only AFTER the scout + builder have
    // burned paid model calls, and a bare loose-file repo can churn the loop toward a timeout.
    // Detect it HERE, before any model call / workspace allocation, and reject at zero API cost.
    // Gated on `enforceProjectRoot` so it fires for the PRODUCTION wiring only (the same gate that
    // turns on resolveChecks); non-production/test orchestrators do not enforce checks and run
    // bare-file flows legitimately. Bypassed when: the operator declared explicit checks
    // (IKBI_CHECKS / `--check`) — they own verification; a step-planner step reuses a workspace
    // (`reuseWorkspace`) whose manifest may be written by a later step; or `skipVerifier` (a
    // greenfield scaffold step with no tests yet — verified at the final step). Because this
    // returns BEFORE the builder, a manifest-less, check-less run can never start the loop and
    // hang — the fast-fail is the bare-repo timeout guard.
    if (
      enforceProjectRoot &&
      task.reuseWorkspace === undefined &&
      task.skipVerifier !== true &&
      !hasExplicitChecks(modeEnv)
    ) {
      const diagnostic = diagnoseBareRepo(task.targetRepo);
      if (diagnostic !== undefined) {
        // CLASSIFY: a no-manifest target is CHECKS_UNRESOLVABLE — fail closed with the structured
        // verdict (NOT a model failure). This pre-allocation path already escalates nothing (it
        // returns before any model call) and records no trust, satisfying the no-escalate /
        // no-demote contract; the `verification` field + receipt make the classification explicit.
        const concise = diagnostic.split("\n").slice(0, 2).join(" ");
        events.publish(
          workerFailed.create(
            { taskId: task.taskId, reason: diagnostic },
            { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
          ),
        );
        await receipts.append(
          {
            operation: "worker.checks_unresolvable",
            outcome: { status: "success", detail: `checks_unresolvable: ${concise}` },
            requestId: task.taskId,
            metadata: { taskId: task.taskId, targetRepo: task.targetRepo, verificationKind: "checks_unresolvable", reason: concise, escalated: false, trustPenalized: false, nextSteps: [...UNRESOLVABLE_NEXT_STEPS] },
            project: task.targetRepo,
          },
          parentIdentity,
        );
        return {
          contractVersion: CONTRACT_VERSION,
          taskId: task.taskId,
          outcome: "rejected",
          roles: [],
          promoted: false,
          reason: diagnostic,
          verification: { kind: "checks_unresolvable", reason: concise, nextSteps: [...UNRESOLVABLE_NEXT_STEPS] },
        };
      }
    }

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

    // Hooks: loaded once per run (best-effort)
    const hooks = (() => { try { return require("../hooks/index.js").loadHooks(task.targetRepo); } catch { return []; } })();
    // STEP-PLANNER: reuse an existing workspace (changes accumulate across steps)
    // or allocate a fresh one (default single-step behavior).
    const workspace = task.reuseWorkspace ?? await workspaces.allocate({
      targetRepo: task.targetRepo,
      identity: parentIdentity,
      ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
      label: `worker:${task.taskId}`,
    });

    // MANIFEST CHECK: warn early when no project manifest exists in the worktree root.
    // Without a manifest, `resolveChecks` will fail with "no recognizable project manifest"
    // during verification — this gives the operator an actionable early indicator.
    // The check is best-effort (non-fatal): the workspace path may not yet be readable if
    // allocation deferred I/O, and the operator can still inspect the workspace after the run.
    if (existsSync(workspace.path)) {
      const MANIFESTS = ["package.json", "pnpm-workspace.yaml", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json", "deno.jsonc", "project.godot"] as const;
      if (!MANIFESTS.some((m) => existsSync(join(workspace.path, m)))) {
        log.warn(
          { workspaceId: workspace.id, path: workspace.path, manifests: MANIFESTS },
          "worker-model: no project manifest found in workspace — verification checks may fail",
        );
      }
    }

    events.publish(
      workerStarted.create(
        { taskId: task.taskId, workspaceId: workspace.id, verificationMode, retrievalMode },
        { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
      ),
    );

    // Per-run costing engine: accumulates every model invocation's cost across all roles.
    const { engine: runEngine, cost: runCost } = makeCostingEngine(task.maxBudgetUsd, task.effort);

    const results: RoleResult[] = [];
    // Run-level escalation accumulator (ADDITIVE observability; never alters dispatch).
    const escSignals: MutableEscalationSignals = { schemaFailures: 0, retryCount: 0, contextPressure: 0, criticRejected: false, verificationFailed: false, rejectedToolCalls: 0, builderFailed: false };
    const escHandoff: EscalationHandoffFields = {};
    // The STRONGEST escalation recommendation seen across the scoring roles, surfaced on the
    // result (observe-only). A `recommended` recommendation wins over a declined one; ties break
    // on the higher score. Operators read it to decide whether to re-run on a higher tier.
    let escalationOutcome: WorkerResult["escalation"];
    // BUILD-MODE ESCALATION (acts, not just observes): when the builder fails on the cheap tier and
    // the engine recommends a mid-tier retry, re-run the builder ONCE on the escalated model in the
    // SAME workspace. `escalationAttempted` caps it at a single retry per run (fail-closed — a
    // failed escalated retry leaves the original failure standing). `escalationRetryOutcome` surfaces
    // that the swap+retry actually ran (distinct from the observe-only `escalationOutcome` above).
    let escalationAttempted = false;
    // DUAL-MODEL BUILDER: retry the cheap model ONCE with feedback before escalating to pro.
    // The user's expected pattern: flash attempt 1 → flash attempt 2 (with failure feedback) →
    // pro (auto-escalation). This flag caps the cheap retry at one attempt so it never loops.
    let cheapModelRetryAttempted = false;
    let escalationRetryOutcome: WorkerResult["escalationRetry"];
    // UNVERIFIABLE TARGET: set when the post-build worktree has NO derivable checks (no manifest,
    // unsupported project, no IKBI_CHECKS). A stronger model cannot fix a missing verifier, so this
    // SUPPRESSES escalation and the per-build trust penalty, and fails the run closed with an
    // actionable diagnostic — never a misleading "model failed" + a wasted pro retry.
    let checksUnverifiable: { kind: VerificationKind; reason: string } | undefined;
    // Authoritative, post-build, mode-INDEPENDENT classifier: does the CURRENT worktree have a
    // derivable verifier? Uses the SAME `resolveChecks` the verifier/builder use (which honors
    // IKBI_CHECKS and the project-root guard), so a greenfield build that CREATED a manifest is
    // resolvable, an explicit IKBI_CHECKS override is resolvable, and only a genuinely
    // checks-less target classifies unverifiable. Off when the project-root guard is off (the
    // default resolver always returns checks, so "unverifiable" is not a concept there).
    const classifyUnverifiableTarget = (): { kind: VerificationKind; reason: string } | undefined => {
      if (!enforceProjectRoot) return undefined;
      const r = resolveChecks(workspace.path);
      if (r.ok) return undefined;
      return { kind: classifyUnresolvableReason(r.reason), reason: r.reason };
    };
    let overall: WorkerResult["outcome"] = "success";
    let killedReason: string | undefined;
    // FIX A: capture a worker spawned identity for per-build trust recording.
    // The parent is the operator (kind=operator, skipped by trust). The WORKER
    // agent is the entity whose trust we need to record.
    let workerSpawned: SpawnedRole | undefined;
    // ISSUE 1: a critic FAIL feeds the critic's feedback back to the builder for ONE retry
    // (opt-in, config.criticFixLoop). This guard caps it at a single attempt per run so
    // subjective feedback can never loop forever.
    let criticFixAttempted = false;
    // H7: when the verifier-driven fix loop runs (fixIterations > 0) and its LAST verify is GREEN,
    // we reuse that verifier RoleResult for the main verifier role instead of running the FULL
    // typecheck+test suite a second time on identical code. Set in the builder block below, consumed
    // when the loop reaches the verifier role (a redundant verifier pass would just re-confirm green).
    let fixLoopVerifierResult: RoleResult | undefined;
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
        // STEP-PLANNER: skip the critic on intermediate steps (skipCritic). The critic would
        // judge a PARTIAL build against a sub-goal and its verdict is structurally discarded
        // (skipPromote ignores the integrator decision; a critic FAIL still returns success), so
        // running it only burns a model call. No critic result is pushed — the integrator reads
        // "no critic result", but skipPromote returns before that decision is enacted. The final
        // (non-skipping) step runs the critic normally. Distinct from skipCriticOnRed below, which
        // skips a discard-bound critic on a RED verifier in a normal promote run.
        if (role === "critic" && task.skipCritic === true) {
          events.publish(
            workerRoleSkipped.create(
              { taskId: task.taskId, role: "critic", reason: "skipCritic (step-planner intermediate step)" },
              { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.role.critic", runId: task.taskId } },
            ),
          );
          continue;
        }
        // SKIP-CRITIC-ON-RED (default ON): a discard-bound build (verifier RED) does not need a paid
        // goal-alignment verdict. The integrator already discards on verifierPass=false, so the
        // critic would only spend model tokens on a build that is already condemned. Skip it ONLY
        // when no retry will consume its feedback — the verifier-driven fixLoop is off. When fixLoop
        // IS active the critic runs (its feedback can inform the objective-driven retry). DEFAULT ON
        // (skip-on-red is the default; `skipCriticOnRed !== false`) so condemned-build critic calls
        // are not paid for; set IKBI_WORKER_MODEL_SKIP_CRITIC_ON_RED=false to opt back into running
        // the critic after a red verifier. No critic result is pushed — the integrator reads "no
        // critic result" and discards, the same terminal outcome a red verifier already forces.
        if (role === "critic" && config.skipCriticOnRed !== false && !config.fixLoop) {
          const verifierForSkip = results.find((r) => r.role === "verifier");
          if (verifierForSkip !== undefined && verifierForSkip.outcome !== "success") {
            events.publish(
              workerRoleSkipped.create(
                { taskId: task.taskId, role: "critic", reason: "verifier-red-discard-bound" },
                { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.role.critic", runId: task.taskId } },
              ),
            );
            continue;
          }
        }
        // REFUTER (optional gate): skip entirely unless enabled, emitting NO result so the default
        // pipeline's role set + every existing full-run test stay byte-unchanged. When enabled it
        // runs BEFORE the integrator (WORKER_ROLES order), so its result is in the integrator's
        // priorResults. A refuted build (detail.refuted === true) files PROPOSED corrections (below)
        // AND forces the integrator to DISCARD (Codex HIGH-1) — the integrator reads the refuter
        // verdict from priorResults and fail-closes on it.
        if (role === "refuter" && !refuterEnabled) {
          continue;
        }

        const spawned = spawnRole(role, parentCtx);
        if (workerSpawned === undefined) workerSpawned = spawned;
        // FIX 6: assert all roles share the same agent identity (per-build trust invariant).
        // If per-role credentials ever get wired, this will fail loud instead of silently
        // attaching trust to only the first role's identity.
        if (spawned.identity.agentId !== workerSpawned.identity.agentId) {
          throw new WorkerError("identity", `role ${role} identity ${spawned.identity.agentId} != worker identity ${workerSpawned.identity.agentId} — per-build trust requires all roles share one agent`);
        }

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
        // Builder model override for the role dispatch (same precedence as effectiveBuilderModel):
        // a --tier preset wins, else --complexity large bumps to the mid-tier model, else undefined
        // (builderForModel falls back to the configured builder). Kept in sync with line ~1312.
        const complexityModel = task.builderModelOverride ?? (task.complexity === "large" ? escalationConfig.tierModels.mid[0] : undefined);
        const roleFn = role === "verifier" ? verifierFor(parentCtx) : role === "builder" ? builderForModel(parentCtx, complexityModel, resolveBuilderMode(task)) : role === "critic" ? criticFor() : role === "refuter" ? refuterFor() : roles[role];
        // H4: floor the verifier's role timeout at the per-check budget. Without this, a 300s role
        // timeout races against 600s checks — the role fails first, orphaning the still-running check.
        const verifierTimeout = role === "verifier" ? Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)) : undefined;
        // Per-role cost snapshot: capture before execution so we can attribute cost to this role.
        const costBeforeRole = runCost();
        // H7: when the fix loop already verified the SAME code GREEN, reuse its verifier result rather
        // than running the full typecheck+test suite again. The reused result flows through the normal
        // record/commit/integrator path below; only the redundant second verifier dispatch is skipped.
        let result =
          role === "verifier" && fixLoopVerifierResult !== undefined
            ? fixLoopVerifierResult
            : await runRoleFn(role, roleFn, ctx, verifierTimeout);
        results.push(result);

        // REFUTER → CORRECTION LIBRARY: a refuted build files each failed finding as a PROPOSED
        // correction (approved=false). Governance requires a human/operator to approve before any
        // correction takes effect; this only records the lesson. Best-effort (never fails the run).
        if (role === "refuter") {
          fileRefuterCorrections(result, task.taskId);
        }

        // ── AUTO-VERIFY RESCUE: builder wrote files but NEVER ran checks ──────────
        // Delegated to maybeAutoVerifyRescueBuilderResult (shared with competitive/tournament).
        if (role === "builder") {
          const rescue = await maybeAutoVerifyRescueBuilderResult(result, async () => {
            const rescueCtx: RoleContext = {
              task, role: "verifier",
              identity: spawned.identity,
              autonomy: spawned.autonomy,
              workspace,
              priorResults: [...results],
              engine: runEngine,
            };
            return runRoleFn("verifier", verifierFor(parentCtx), rescueCtx, Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)));
          });
          result = rescue.result;
          results[results.length - 1] = result;
        }

        // Per-role cost: compute once after rescue (rescue verifier calls count against builder).
        const roleCost = runCost() - costBeforeRole;
        // Stamp into detail (open shape) so the CLI post-build breakdown can read it without
        // changing the WorkerResult contract. Also stamp the model on the builder role.
        if (roleCost > 0) {
          const prevDetail = (result.detail as Record<string, unknown> | undefined) ?? {};
          result = { ...result, detail: { ...prevDetail, costUsd: roleCost, ...(role === "builder" ? { model: effectiveBuilderModel } : {}) } };
          results[results.length - 1] = result;
        }
        events.publish(
          workerRoleCompleted.create(
            { taskId: task.taskId, role, outcome: result.outcome, ...(roleCost > 0 ? { costUsd: roleCost } : {}) },
            { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
          ),
        );

        await recordRole(task, workspace, spawned, result, roleCost, effectiveBuilderModel, true);

        // SG-5 PROGRESS: structured per-role detail beyond start/end — builder tool activity
        // and the verifier's verdict — so `--verbose` can show what each phase actually did.
        if (role === "scout") {
          const sd = (result.detail ?? {}) as Record<string, unknown>;
          if (typeof sd.retrievalMode === "string") actualRetrievalMode = sd.retrievalMode;
        } else if (role === "builder") {
          const bd = (result.detail ?? {}) as Record<string, unknown>;
          events.publish(
            workerBuilderActivity.create(
              { taskId: task.taskId, toolRounds: typeof bd.toolRounds === "number" ? bd.toolRounds : 0, filesWritten: Array.isArray(bd.filesWritten) ? bd.filesWritten.length : 0, ...(typeof bd.contextPercent === "number" ? { contextPercent: bd.contextPercent } : {}), tier: spawned.autonomy.tier },
              { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: "worker.role.builder", runId: task.taskId } },
            ),
          );
        } else if (role === "verifier") {
          const v = readVerifier(result);
          // C1 — surface the 4-state test-execution evidence on the verifier RESULT (not just the
          // judged candidate) so the integrator's promote gate can require REAL test signal for a
          // single-run build. detail is readonly, so replace the result in `results` (the array the
          // integrator reads via priorResults) with a stamped copy.
          const stamped: RoleResult = { ...result, detail: { ...((result.detail as Record<string, unknown> | undefined) ?? {}), testEvidence: v.testEvidence } };
          const verifierIdx = results.lastIndexOf(result);
          if (verifierIdx >= 0) results[verifierIdx] = stamped;
          result = stamped;
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
          // H7: capture the FULL verifier RoleResult from the fix loop's last verify (the iterative
          // loop only returns the distilled pass/fail). If that last verify is GREEN we reuse this
          // result for the main verifier role instead of re-running the suite (see fixLoopVerifierResult).
          let lastFullVerifierResult: RoleResult | undefined;
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
              lastFullVerifierResult = vResult;
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
                  costUsd: runCost(),
                },
                project: task.targetRepo,
              },
              parentIdentity,
            );
            // H7: the fix loop ran AND its last verify was GREEN — reuse that verifier RoleResult for
            // the main verifier role so the full typecheck+test suite is not run a SECOND time on the
            // identical, already-verified working tree. A FAILED last verify is NOT reused: the main
            // verifier still runs and gives the authoritative final word (fix attempts were exhausted).
            if (fixLoopOutcome.lastVerifierResult?.success === true && lastFullVerifierResult !== undefined) {
              fixLoopVerifierResult = lastFullVerifierResult;
            }
          }
        }

        // ── CRITIC-DRIVEN FIX LOOP: a subjective FAIL is no longer a dead end ──────
        // The verifier runs BEFORE the critic but does NOT short-circuit; the critic runs
        // regardless of the verifier's outcome (so a red verifier still gets semantic
        // feedback). This subjective fix loop, however, is GATED on the verifier PASSING:
        // when the build is objectively GREEN but semantically wrong / off-goal, feed the
        // critic's feedback back to the builder for ONE retry, re-verify, and re-critique.
        // A RED verifier must NOT trigger this loop — the objective (verifier-driven) fix
        // loop owns retries on red checks; retrying on the critic's SUBJECTIVE feedback
        // would leave the actual compile/test errors unaddressed. Capped at a single attempt
        // (criticFixAttempted) so subjective feedback can never loop. COMPLEMENTARY to the
        // verifier-driven loop above.
        // OPT-IN: requires IKBI_WORKER_MODEL_CRITIC_FIX_LOOP=true (default off).
        const verifierForCriticGate = results.find((r) => r.role === "verifier");
        const verifierPassedForCriticGate = verifierForCriticGate !== undefined && verifierForCriticGate.outcome === "success";
        // DIAGNOSTIC: a critic FAIL that does NOT drive the fix loop is a dead end — the build is
        // discarded with the strong critic's feedback thrown away. Record EXACTLY which sub-condition
        // blocked the loop so the no-fire is debuggable from the receipt trail instead of silently
        // swallowed. Emitted only when the critic actually produced a SUBJECTIVE fail verdict
        // (detail.pass === false) — a PASS, or an objective fail-closed gate, is not a missed
        // fix-loop opportunity worth recording.
        if (role === "critic") {
          const criticFailVerdict = ((result.detail ?? {}) as Record<string, unknown>).pass === false;
          const subConditions = {
            criticFixLoopEnabled: config.criticFixLoop === true,
            notAlreadyAttempted: !criticFixAttempted,
            verifierPassedForCriticGate,
            isRetryableCriticFail: isRetryableCriticFail(result),
          };
          const willFire = subConditions.criticFixLoopEnabled && subConditions.notAlreadyAttempted && subConditions.verifierPassedForCriticGate && subConditions.isRetryableCriticFail;
          if (criticFailVerdict && !willFire) {
            await receipts.append(
              {
                operation: "worker.critic_fix_loop.skipped",
                outcome: { status: "failure" },
                requestId: task.taskId,
                metadata: {
                  taskId: task.taskId,
                  workspaceId: workspace.id,
                  reason: "critic returned FAIL but the critic-fix loop did not fire",
                  ...subConditions,
                  blockedBy: Object.entries(subConditions).filter(([, v]) => v !== true).map(([k]) => k),
                },
                project: task.targetRepo,
              },
              parentIdentity,
            );
          }
        }
        if (role === "critic" && config.criticFixLoop && !criticFixAttempted && verifierPassedForCriticGate && isRetryableCriticFail(result)) {
          criticFixAttempted = true;
          // The prior results the re-run roles inherit: everything EXCEPT the stale builder /
          // verifier / critic, which are replaced with their fresh results as produced.
          const carriedPrior = results.filter((r) => r.role !== "builder" && r.role !== "verifier" && r.role !== "critic");
          // CODEX FIX: each retry STAGE runs under its OWN role identity (functionalRole
          // builder/verifier/critic), spawned fresh under the parent ceiling — NOT the critic's
          // `spawned` identity from this iteration. Reusing the critic identity ran the retry
          // builder/verifier with functionalRole="critic", a wrong-attribution / governance hazard.
          const retryBuilder = spawnRole("builder", parentCtx);
          const retryVerifier = spawnRole("verifier", parentCtx);
          const retryCritic = spawnRole("critic", parentCtx);
          const fix = await runCriticFixLoop(result, {
            builder: async (fixGoal: string) => {
              const fixCtx: RoleContext = {
                task: { ...task, goal: fixGoal },
                role: "builder",
                identity: retryBuilder.identity,
                autonomy: retryBuilder.autonomy,
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
                identity: retryVerifier.identity,
                autonomy: retryVerifier.autonomy,
                workspace,
                priorResults: [...carriedPrior, builderResult],
                engine: runEngine,
              };
              const vRes = await runRoleFn("verifier", verifierFor(parentCtx), verifyCtx, Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)));
              // Mirror the main verifier→commit gate: capture the re-verified-good working tree so
              // the integrator/promote sees the post-retry diff (gated on autoCommit, same as above).
              if (vRes.outcome === "success" && workspaces.commit !== undefined && retryVerifier.autonomy.autoCommit) {
                await workspaces.commit(workspace, `ikbi: ${task.goal}`);
              }
              return vRes;
            },
            critic: async (builderResult: RoleResult, verifierResult: RoleResult) => {
              const reCriticCtx: RoleContext = {
                task,
                role: "critic",
                identity: retryCritic.identity,
                autonomy: retryCritic.autonomy,
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
            if (fix.verifierResult !== undefined) {
              // C1: stamp testEvidence onto the re-verified result (mirrors the main role loop above).
              // The raw re-run verifier result carries no testEvidence; without this stamp the
              // integrator's fail-closed test-evidence gate would discard a legitimately-fixed build.
              const reVerifier: RoleResult = {
                ...fix.verifierResult,
                detail: { ...((fix.verifierResult.detail as Record<string, unknown> | undefined) ?? {}), testEvidence: readVerifier(fix.verifierResult).testEvidence },
              };
              replaceRole(reVerifier);
            }
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
                metadata: { taskId: task.taskId, workspaceId: workspace.id, retried: true, criticPass, costUsd: runCost() },
                project: task.targetRepo,
              },
              parentIdentity,
            );
          }
        }

        // ── CRITIC-DRIVEN ESCALATION: the cheap model exhausted its critic-feedback retry ─────
        // When the critic-fix loop RAN (the cheap builder already got ONE retry with the critic's
        // feedback) and the critic STILL rejects a verifier-GREEN build, the cheap model has
        // demonstrably failed to satisfy the critic on this goal. The signal-scored escalation engine
        // will NOT cross its worker→mid threshold on a critic rejection alone (criticRejected weight <
        // the threshold, by design), so the build would simply be discarded with the feedback wasted.
        // This is a DETERMINISTIC, policy-driven escalation that complements the engine's signal path
        // (the build-mode escalation retry below, which fires on a builder FAILURE): swap the builder
        // to the mid tier ONCE, re-verify, and re-critique. It SHARES the `escalationAttempted` cap
        // with that builder-failure escalation — at most one model swap per run, and the two can never
        // both fire (a builder failure breaks the loop before the critic ever runs). FAIL-CLOSED: a
        // still-rejected escalated build leaves the ORIGINAL critic FAIL standing so the integrator
        // discards — there is no half-promote.
        const verifierAfterCriticLoop = results.find((r) => r.role === "verifier");
        const verifierStillGreen = verifierAfterCriticLoop !== undefined && verifierAfterCriticLoop.outcome === "success";
        if (
          role === "critic" &&
          config.criticFixLoop &&
          criticFixAttempted &&
          !escalationAttempted &&
          verifierStillGreen &&
          isRetryableCriticFail(result)
        ) {
          const midModel = task.fallbackModel ?? escalationConfig.tierModels.mid[0];
          if (midModel !== undefined) {
            escalationAttempted = true;
            const rejectedDetail = (result.detail ?? {}) as Record<string, unknown>;
            const criticFeedback = typeof rejectedDetail.feedback === "string" ? rejectedDetail.feedback : (result.summary ?? "");
            const criticIssues = Array.isArray(rejectedDetail.issues) ? rejectedDetail.issues.filter((x): x is string => typeof x === "string") : [];
            // The escalated model gets the original goal PLUS the critic feedback the cheap attempts
            // could not satisfy — the handoff context that makes the stronger model's retry informed.
            const escalatedGoal = [
              task.goal,
              "",
              `[escalation] A cheaper model (${singleBuilderModel}) could not satisfy the critic on this task — even after a retry with the critic's feedback — so it was escalated to you (${midModel}).`,
              ...(criticFeedback.trim().length > 0 ? [`Critic feedback: ${criticFeedback.trim()}`] : []),
              ...(criticIssues.length > 0 ? [`Specific issues: ${criticIssues.join("; ")}`] : []),
              "Resolve the critic's concerns without breaking the passing checks; do not repeat what the previous attempts got wrong.",
            ].join("\n");

            // The carried prior results the re-run roles inherit: everything EXCEPT the stale
            // builder/verifier/critic, which are replaced with their fresh escalated results.
            const carriedPrior = results.filter((r) => r.role !== "builder" && r.role !== "verifier" && r.role !== "critic");

            // Fresh role identities under the parent ceiling — escalation swaps the MODEL, not the tier.
            const escBuilder = spawnRole("builder", parentCtx);
            const escVerifier = spawnRole("verifier", parentCtx);
            const escCritic = spawnRole("critic", parentCtx);

            events.publish(
              workerRoleDispatched.create(
                { taskId: task.taskId, role: "builder", ...(escBuilder.identity.trustTier !== undefined ? { tier: escBuilder.identity.trustTier } : {}) },
                { source: EVENT_SOURCE, attribution: { identity: escBuilder.identity, operation: "worker.role.builder", runId: task.taskId } },
              ),
            );
            const costBeforeEsc = runCost();
            const escBuilderFn = builderForModel(parentCtx, midModel, resolveBuilderMode(task));
            let escBuilderResult = await runRoleFn("builder", escBuilderFn, {
              task: { ...task, goal: escalatedGoal },
              role: "builder",
              identity: escBuilder.identity,
              autonomy: escBuilder.autonomy,
              workspace,
              priorResults: [...carriedPrior],
              engine: runEngine,
            });
            const escBuilderCost = runCost() - costBeforeEsc;
            // Stamp the escalated model (+ marker) so the cost breakdown + audit show this builder ran
            // on the mid tier, not the cheap one.
            escBuilderResult = {
              ...escBuilderResult,
              detail: { ...((escBuilderResult.detail as Record<string, unknown> | undefined) ?? {}), ...(escBuilderCost > 0 ? { costUsd: escBuilderCost } : {}), model: midModel, escalated: true },
            };
            events.publish(
              workerRoleCompleted.create(
                { taskId: task.taskId, role: "builder", outcome: escBuilderResult.outcome, ...(escBuilderCost > 0 ? { costUsd: escBuilderCost } : {}) },
                { source: EVENT_SOURCE, attribution: { identity: escBuilder.identity, operation: "worker.role.builder", runId: task.taskId } },
              ),
            );
            await recordRole(task, workspace, escBuilder, escBuilderResult, escBuilderCost, midModel, true);

            let escSucceeded = false;
            if (escBuilderResult.outcome === "success") {
              const escVerifyResult = await runRoleFn(
                "verifier",
                verifierFor(parentCtx),
                {
                  task,
                  role: "verifier",
                  identity: escVerifier.identity,
                  autonomy: escVerifier.autonomy,
                  workspace,
                  priorResults: [...carriedPrior, escBuilderResult],
                  engine: runEngine,
                },
                Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)),
              );
              // Mirror the main verifier→commit gate: capture the re-verified-good working tree so the
              // integrator/promote sees the escalated diff (gated on autoCommit, as everywhere else).
              if (escVerifyResult.outcome === "success" && workspaces.commit !== undefined && escVerifier.autonomy.autoCommit) {
                await workspaces.commit(workspace, `ikbi: ${task.goal}`);
              }
              // C1: stamp testEvidence onto the re-verified result so the integrator's fail-closed
              // test-evidence gate does not discard a legitimately-escalated, re-verified build.
              const escVerifyStamped: RoleResult = {
                ...escVerifyResult,
                detail: { ...((escVerifyResult.detail as Record<string, unknown> | undefined) ?? {}), testEvidence: readVerifier(escVerifyResult).testEvidence },
              };
              const escCriticResult = await runRoleFn("critic", criticFor(), {
                task,
                role: "critic",
                identity: escCritic.identity,
                autonomy: escCritic.autonomy,
                workspace,
                priorResults: [...carriedPrior, escBuilderResult, escVerifyStamped],
                engine: runEngine,
              });

              const escVerifierPass = escVerifyStamped.outcome === "success";
              const escCriticPass = ((escCriticResult.detail ?? {}) as Record<string, unknown>).pass === true;
              if (escVerifierPass && escCriticPass) {
                // The escalated build CONVERGED — splice the fresh roles in so the integrator (and the
                // run's roles array) reflect the work that actually landed. Replace by role; critic last.
                const replaceRole = (value: RoleResult): void => {
                  const i = results.findIndex((r) => r.role === value.role);
                  if (i >= 0) results[i] = value;
                  else results.push(value);
                };
                replaceRole(escBuilderResult);
                replaceRole(escVerifyStamped);
                result = escCriticResult;
                replaceRole(result);
                escSucceeded = true;
              }
              // A FAILED escalation (builder failed, verifier red, or critic still rejects) is NOT
              // spliced — the original critic FAIL stays in `results`, so the integrator discards
              // (fail-closed). The escalated builder's tree may be committed-but-unpromoted; the
              // workspace is discarded as a unit, so nothing leaks.
            }

            events.publish(
              workerEscalationRetried.create(
                { taskId: task.taskId, fromModel: singleBuilderModel, toModel: midModel, success: escSucceeded },
                { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.escalation.retry", runId: task.taskId } },
              ),
            );
            await receipts.append(
              {
                operation: "worker.escalation.retry",
                outcome: { status: escSucceeded ? "success" : "failure" },
                requestId: task.taskId,
                metadata: { taskId: task.taskId, workspaceId: workspace.id, trigger: "critic-rejected", fromModel: singleBuilderModel, toModel: midModel, success: escSucceeded, costUsd: runCost() },
                project: task.targetRepo,
              },
              parentIdentity,
            );
            escalationRetryOutcome = { attempted: true, model: midModel, succeeded: escSucceeded };
          }
        }

        // ADDITIVE escalation observability — fold signals + emit escalation.* events.
        // Runs before the short-circuit so a failing role's signals are still scored.
        const escObservation = observeEscalation(events, task, role, result, escSignals, escHandoff, parentIdentity);
        const esc = escObservation.summary;
        if (esc !== undefined && (escalationOutcome === undefined || (esc.recommended && !escalationOutcome.recommended) || (esc.recommended === escalationOutcome.recommended && esc.total > escalationOutcome.total))) {
          escalationOutcome = esc;
        }

        // ── UNVERIFIABLE-TARGET ESCALATION SUPPRESSION (fail-closed, NO model swap) ───
        // A builder failure on a target with NO derivable checks (no manifest, unsupported project,
        // no IKBI_CHECKS) is NOT a model failure: a stronger model cannot make a missing verifier
        // appear. Detect it authoritatively from the post-build worktree and SUPPRESS escalation
        // entirely — no cheap retry, no pro swap. The run fails closed with an actionable diagnostic
        // (attached at the terminal) and the per-build trust penalty is suppressed there too. This
        // runs BEFORE the escalation gate, which then no-ops on `checksUnverifiable === undefined`.
        if (
          role === "builder" &&
          (result.outcome === "failure" || escSignals.builderFailed) &&
          checksUnverifiable === undefined
        ) {
          const unverifiable = classifyUnverifiableTarget();
          if (unverifiable !== undefined) {
            checksUnverifiable = unverifiable;
            const failedDetail = (result.detail ?? {}) as Record<string, unknown>;
            const failedModel = typeof failedDetail.model === "string" ? failedDetail.model : singleBuilderModel;
            events.publish(
              workerEscalationSuppressed.create(
                { taskId: task.taskId, fromModel: failedModel, reason: unverifiable.reason, verificationKind: unverifiable.kind },
                { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.escalation.suppressed", runId: task.taskId } },
              ),
            );
            await receipts.append(
              {
                operation: "worker.escalation.suppressed",
                outcome: { status: "success", detail: `escalation suppressed — ${unverifiable.kind}: ${unverifiable.reason}` },
                requestId: task.taskId,
                metadata: { taskId: task.taskId, workspaceId: workspace.id, fromModel: failedModel, verificationKind: unverifiable.kind, reason: unverifiable.reason, nextSteps: [...UNRESOLVABLE_NEXT_STEPS] },
                project: task.targetRepo,
              },
              parentIdentity,
            );
          }
        }

        // ── BUILD-MODE ESCALATION RETRY (the wired follow-up to observe-only) ─────────
        // DUAL-MODEL BUILDER PATTERN: flash attempt 1 → flash attempt 2 (cheap retry with
        // feedback) → pro (auto-escalation). The cheap model gets ONE retry before the mid-tier
        // model is tried. This is the user's expected default behavior — not opt-in.
        //
        // The gate fires on EITHER `result.outcome === "failure"` OR `escSignals.builderFailed`
        // (which is set when the builder writes 0 files even if it called done). This closes
        // the gap where a cheap model produces nothing but the outcome gate blocked escalation.
        // SUPPRESSED on an unverifiable target (`checksUnverifiable`): a stronger model cannot fix
        // a missing manifest/verifier, so escalating would waste a paid pro run, guaranteed to fail.
        const decision = escObservation.decision;
        if (
          role === "builder" &&
          (result.outcome === "failure" || escSignals.builderFailed) &&
          checksUnverifiable === undefined &&
          !escalationAttempted &&
          decision !== undefined &&
          decision.escalate &&
          decision.targetTier === "mid"
        ) {
          const midModel = task.fallbackModel ?? escalationConfig.tierModels.mid[0];
          if (midModel !== undefined) {
            const failedResult = result;
            const failedDetail = (failedResult.detail ?? {}) as Record<string, unknown>;
            const failedModel = typeof failedDetail.model === "string" ? failedDetail.model : singleBuilderModel;

            // ── STEP 1: CHEAP RETRY — same model, with failure feedback ──────
            // Before escalating to the mid-tier model, give the cheap model ONE more chance
            // with the failure context. This implements: flash → flash retry → pro.
            // Fires on ANY builder struggle: explicit failure OR silent success with 0 files.
            if (!cheapModelRetryAttempted) {
              cheapModelRetryAttempted = true;
              const cheapRetryGoal = [
                task.goal,
                "",
                `[retry] Your previous attempt failed. ${failedResult.summary ?? "No files were written."}`,
                ...(escSignals.builderFailed && result.outcome === "success" ? ["You called done but wrote 0 files — you MUST write the actual code changes."] : []),
                "Fix what went wrong; do not repeat the same mistake.",
              ].join("\n");

              const cheapRetrySpawn = spawnRole("builder", parentCtx);
              events.publish(
                workerRoleDispatched.create(
                  { taskId: task.taskId, role: "builder", ...(cheapRetrySpawn.identity.trustTier !== undefined ? { tier: cheapRetrySpawn.identity.trustTier } : {}) },
                  { source: EVENT_SOURCE, attribution: { identity: cheapRetrySpawn.identity, operation: "worker.role.builder", runId: task.taskId } },
                ),
              );
              const cheapRetryBuilder = builderForModel(parentCtx, undefined, resolveBuilderMode(task));
              const cheapRetryCtx: RoleContext = {
                task: { ...task, goal: cheapRetryGoal },
                role: "builder",
                identity: cheapRetrySpawn.identity,
                autonomy: cheapRetrySpawn.autonomy,
                workspace,
                priorResults: [...results],
                engine: runEngine,
              };
              const costBeforeCheapRetry = runCost();
              let cheapRetryResult = await runRoleFn("builder", cheapRetryBuilder, cheapRetryCtx);
              const cheapRetryCost = runCost() - costBeforeCheapRetry;
              cheapRetryResult = {
                ...cheapRetryResult,
                detail: { ...((cheapRetryResult.detail as Record<string, unknown> | undefined) ?? {}), ...(cheapRetryCost > 0 ? { costUsd: cheapRetryCost } : {}), model: failedModel, cheapRetry: true },
              };
              const cheapRetrySucceeded = cheapRetryResult.outcome === "success";

              events.publish(
                workerRoleCompleted.create(
                  { taskId: task.taskId, role: "builder", outcome: cheapRetryResult.outcome, ...(cheapRetryCost > 0 ? { costUsd: cheapRetryCost } : {}) },
                  { source: EVENT_SOURCE, attribution: { identity: cheapRetrySpawn.identity, operation: "worker.role.builder", runId: task.taskId } },
                ),
              );
              await recordRole(task, workspace, cheapRetrySpawn, cheapRetryResult, cheapRetryCost, failedModel, true);

              if (cheapRetrySucceeded) {
                // Cheap retry SUCCEEDED — replace the failed builder result and continue the
                // pipeline (critic → verifier → integrator). No escalation needed.
                const builderIdx = results.lastIndexOf(failedResult);
                if (builderIdx >= 0) results[builderIdx] = cheapRetryResult;
                result = cheapRetryResult;
                events.publish(
                  workerEscalationRetried.create(
                    { taskId: task.taskId, fromModel: failedModel, toModel: `${failedModel} (cheap retry)`, success: true },
                    { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.cheap_retry", runId: task.taskId } },
                  ),
                );
                await receipts.append(
                  {
                    operation: "worker.cheap_retry",
                    outcome: { status: "success" },
                    requestId: task.taskId,
                    metadata: { taskId: task.taskId, workspaceId: workspace.id, fromModel: failedModel, success: true, costUsd: runCost() },
                    project: task.targetRepo,
                  },
                  parentIdentity,
                );
                // Skip the pro escalation — cheap retry worked.
                // KILL CHECKPOINT: the continue skips the role-boundary kill check at line 2311,
                // so check here to obey a kill signal issued during the cheap retry.
                const cheapRetryKill = await killHalt(task, parentIdentity, parentCtx);
                if (cheapRetryKill !== undefined) {
                  killedReason = cheapRetryKill;
                  overall = "rejected";
                  break; // eslint-disable-line no-labels -- exits the for-loop on kill
                }
                continue; // eslint-disable-line no-continue -- exits the escalation block; pipeline continues with critic
              }

              // Cheap retry ALSO failed — log it and fall through to pro escalation.
              events.publish(
                workerEscalationRetried.create(
                  { taskId: task.taskId, fromModel: failedModel, toModel: `${failedModel} (cheap retry)`, success: false },
                  { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.cheap_retry", runId: task.taskId } },
                ),
              );
              await receipts.append(
                {
                  operation: "worker.cheap_retry",
                  outcome: { status: "failure" },
                  requestId: task.taskId,
                  metadata: { taskId: task.taskId, workspaceId: workspace.id, fromModel: failedModel, success: false, costUsd: runCost() },
                  project: task.targetRepo,
                },
                parentIdentity,
              );
              // Update the failed result to the cheap retry's result (the more recent failure).
              // The pro escalation will use this as the "what went wrong" context.
              // NOTE: do NOT update `result` here — the pro escalation block reads the ORIGINAL
              // failed result. The cheap retry's failure is recorded in receipts for audit.
            }

            // ── STEP 2+: POOL SWEEP — call upon worker+mid models, UP THE LADDER ─────────
            // The cheap model failed (initial + cheap retry). Now sweep the worker+mid POOL via the
            // recovery policy instead of a single mid[0] swap: try the cheapest eligible untried
            // model, never below the floor (up the ladder), until a build converges or the pool is
            // exhausted. The FRONTIER (consult) is gated — unattended, recovery stops at the mid
            // ceiling and the original failure stands with a clear needs-authorization reason; the
            // verification ladder still gates promotion downstream exactly as before.
            escalationAttempted = true;
            const recoveryRosters = {
              worker: rosterFromIds(escalationConfig.tierModels.worker),
              mid: rosterFromIds(escalationConfig.tierModels.mid),
              frontier: rosterFromIds(escalationConfig.tierModels.frontier),
            };
            const seedTier =
              (["worker", "mid", "frontier"] as const).find((t) => escalationConfig.tierModels[t].includes(failedModel)) ?? "worker";
            const recAttempts: RecoveryAttempt[] = [{ tier: seedTier, model: failedModel, outcome: "fail" }];
            const handoff = decision.handoffContext;
            let recovered = false;
            let lastSwapModel = failedModel;

            for (;;) {
              const action = decideRecovery({
                attempts: recAttempts,
                tierRosters: recoveryRosters,
                autoCeiling: "mid",
                frontierAuthorized: false, // frontier consult is a gated follow-up (needs the apply+re-verify path)
                startTier: seedTier,
                // An operator's --fallback-model is honored as the FIRST pick (still up the ladder);
                // once tried, the sweep continues cheapest-first through the rest of the pool.
                ...(task.fallbackModel !== undefined ? { requestedModel: task.fallbackModel } : {}),
              });
              if (action.kind !== "attempt") {
                break; // terminate (exhausted | needs-authorization). Consult is gated this pass.
              }
              const swapModel = action.model;
              lastSwapModel = swapModel;
              const priorFails = recAttempts.filter((a) => a.outcome === "fail").map((a) => a.model);
              // The escalated model gets the original goal PLUS what the prior attempts got wrong.
              const escalatedGoal = [
                task.goal,
                "",
                `[escalation] Cheaper models (${priorFails.join(", ")}) failed this task and it was escalated to you (${swapModel}).`,
                ...(handoff !== undefined ? [`Reason: ${handoff.escalationReason}.`] : []),
                ...(failedResult.summary !== undefined ? [`Previous attempt outcome: ${failedResult.summary}`] : []),
                ...(handoff?.verificationDetails !== undefined ? [`Verification failure: ${handoff.verificationDetails}`] : []),
                ...(handoff?.criticFeedback !== undefined ? [`Critic feedback: ${handoff.criticFeedback}`] : []),
                "Fix what the previous attempt got wrong; do not repeat it.",
              ].join("\n");

              // Fresh role identity per attempt (clamped under the parent ceiling, like every role —
              // escalation swaps the MODEL, never the trust tier).
              const escalatedSpawn = spawnRole("builder", parentCtx);
              events.publish(
                workerRoleDispatched.create(
                  { taskId: task.taskId, role: "builder", ...(escalatedSpawn.identity.trustTier !== undefined ? { tier: escalatedSpawn.identity.trustTier } : {}) },
                  { source: EVENT_SOURCE, attribution: { identity: escalatedSpawn.identity, operation: "worker.role.builder", runId: task.taskId } },
                ),
              );
              const escalatedBuilder = builderForModel(parentCtx, swapModel, resolveBuilderMode(task));
              const escalatedCtx: RoleContext = {
                task: { ...task, goal: escalatedGoal },
                role: "builder",
                identity: escalatedSpawn.identity,
                autonomy: escalatedSpawn.autonomy,
                workspace,
                priorResults: [...results],
                engine: runEngine,
              };
              const costBeforeRetry = runCost();
              let escalatedResult = await runRoleFn("builder", escalatedBuilder, escalatedCtx);
              const retryCost = runCost() - costBeforeRetry;
              // Stamp the escalated model (+ a marker) so the cost breakdown + audit show which model ran.
              escalatedResult = {
                ...escalatedResult,
                detail: { ...((escalatedResult.detail as Record<string, unknown> | undefined) ?? {}), ...(retryCost > 0 ? { costUsd: retryCost } : {}), model: swapModel, escalated: true },
              };
              const swapSucceeded = escalatedResult.outcome === "success";
              events.publish(
                workerRoleCompleted.create(
                  { taskId: task.taskId, role: "builder", outcome: escalatedResult.outcome, ...(retryCost > 0 ? { costUsd: retryCost } : {}) },
                  { source: EVENT_SOURCE, attribution: { identity: escalatedSpawn.identity, operation: "worker.role.builder", runId: task.taskId } },
                ),
              );
              events.publish(
                workerEscalationRetried.create(
                  { taskId: task.taskId, fromModel: failedModel, toModel: swapModel, success: swapSucceeded },
                  { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.escalation.retry", runId: task.taskId } },
                ),
              );
              await recordRole(task, workspace, escalatedSpawn, escalatedResult, retryCost, swapModel, true);
              await receipts.append(
                {
                  operation: "worker.escalation.retry",
                  outcome: { status: swapSucceeded ? "success" : "failure" },
                  requestId: task.taskId,
                  metadata: { taskId: task.taskId, workspaceId: workspace.id, fromModel: failedModel, toModel: swapModel, success: swapSucceeded, costUsd: runCost() },
                  project: task.targetRepo,
                },
                parentIdentity,
              );
              recAttempts.push({ tier: action.tier, model: swapModel, outcome: swapSucceeded ? "green" : "fail" });

              if (swapSucceeded) {
                // Converged — REPLACE the failed builder entry so the integrator + roles array reflect
                // the work that landed; the pipeline continues to the verifier (the ladder still gates).
                const builderIdx = results.lastIndexOf(failedResult);
                if (builderIdx >= 0) results[builderIdx] = escalatedResult;
                result = escalatedResult;
                recovered = true;
                break;
              }

              // Failed attempt — obey a kill signal before paying for the next pool model.
              const sweepKill = await killHalt(task, parentIdentity, parentCtx);
              if (sweepKill !== undefined) {
                killedReason = sweepKill;
                overall = "rejected";
                break;
              }
            }

            escalationRetryOutcome = { attempted: true, model: lastSwapModel, succeeded: recovered };

            if (!recovered && killedReason === undefined && result.outcome === "success") {
              // SILENT SUCCESS + EXHAUSTED SWEEP: the original builder called done but wrote 0 files
              // and no pool model converged. Force failure so the short-circuit breaks the pipeline.
              result = { ...result, outcome: "failure" as const, summary: `escalation across the worker+mid pool did not converge (last: ${lastSwapModel})` };
              const builderIdx = results.lastIndexOf(failedResult);
              if (builderIdx >= 0) results[builderIdx] = result;
            }
          }
        }

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
      // Budget exhausted is NOT an infrastructure failure — it's a controlled abort.
      // Surface the cost so the operator can adjust and re-run.
      const errCode = (err as { code?: string }).code;
      if (errCode === "BUDGET_EXHAUSTED") {
        const budgetErr = err as { costUsd?: number; budgetUsd?: number; message: string };
        const costToReport = budgetErr.costUsd ?? runCost();
        events.publish(
          workerFailed.create(
            { taskId: task.taskId, reason: budgetErr.message, workspaceId: workspace.id, ...(costToReport > 0 ? { costUsd: costToReport } : {}) },
            { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
          ),
        );
        if (retainFailedWorkspaces) await safeRetain(workspaces, workspace, budgetErr.message);
        else await safeDiscard(workspaces, workspace);
        return {
          contractVersion: CONTRACT_VERSION,
          taskId: task.taskId,
          outcome: "rejected",
          roles: results,
          workspaceId: workspace.id,
          promoted: false,
          reason: budgetErr.message,
          costUsd: costToReport,
        };
      }
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

    // UNVERIFIABLE TARGET (authoritative, post-loop): if the run did not succeed, classify the
    // worktree's verifiability NOW — while the workspace still exists on disk (the promote/discard
    // terminals below may remove it, and resolveChecks reads the filesystem). Covers failure paths
    // that did not pass through the builder escalation gate (e.g. a non-builder failure). Only when
    // overall is non-success: a successful build is verifiable by definition. `??=` preserves any
    // classification the escalation-suppression block already made.
    if (overall !== "success") checksUnverifiable ??= classifyUnverifiableTarget();

    // Terminal: a KILL halted the run mid-loop ⇒ stop cleanly (NEVER promote a half-run),
    // surface the kill, return. The workspace is RETAINED (not discarded) so its partial work
    // survives for inspection — `ikbi workspace ls` shows it; `ikbi workspace discard <id>` or
    // `ikbi clean --force` removes it deliberately. Falls back to discard when retention is off
    // or the manager has no retain method.
    // SKIP-PROMOTE EXEMPTION: a step-planner middle step (skipPromote) shares its worktree
    // with the surrounding steps — discarding it here would destroy the accumulated work of a
    // multi-step plan. When skipPromote is set, leave the workspace ALIVE and let the
    // skipPromote terminal below report the outcome; the step planner owns the shared lifecycle.
    if (killedReason !== undefined && task.skipPromote !== true) {
      if (retainFailedWorkspaces) await safeRetain(workspaces, workspace, `interrupted: ${killedReason}`);
      else await safeDiscard(workspaces, workspace);
      events.publish(
        workerFailed.create(
          { taskId: task.taskId, reason: killedReason, workspaceId: workspace.id },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
      fireStopHooks(hooks, task.targetRepo).catch(() => {});
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: results, workspaceId: workspace.id, promoted: false, reason: killedReason };
    }

    // Terminal: a GREEN build whose worker tier lacks autoCommit autonomy left its verified
    // work uncommitted by policy (see the verifier-commit gate). A promote here would find an
    // empty diff and report a misleading "no changes to promote". Instead, RETAIN the verified
    // work and return a precise, actionable reason — a green build is never silently dropped,
    // and the operator is told exactly how to land it. (This does NOT auto-commit: the autonomy
    // model is intact; it only replaces a confusing empty-diff outcome with a clear one.)
    // SKIP-PROMOTE EXEMPTION: this block RETAINS-or-DISCARDS the workspace as a terminal
    // disposition for a single-run build whose tier could not commit. A step-planner middle step
    // (skipPromote) must not be disposed of here — its worktree is shared across steps and the
    // skipPromote terminal below leaves it alive on disk for the next step / final pass.
    if (autoCommitSkippedTier !== undefined && overall === "success" && task.skipPromote !== true) {
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
      // FIX 1A: green build by sub-trusted worker → record SUCCESS to trust.
      // The worker did verified-good work; it just can't autoCommit. Record the
      // success so it can EARN trust toward the autoCommit tier.
      await recordBuildTrust("success", workerSpawned, task.taskId, task.targetRepo, false);
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
    // FIX 1B: track whether the rejection was an operator/governance decision
    // (not a worker quality failure) so trust can be suppressed.
    let trustSuppressed = false;
    let trustSuppressReason: string | undefined;
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
        trustSuppressed = true;
        trustSuppressReason = "operator rejected at approval gate";
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
        trustSuppressed = true;
        trustSuppressReason = "gate-wall not wired (operator misconfiguration)";
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
          trustSuppressed = true;
          trustSuppressReason = "gate-wall denied promotion (governance decision)";
        } else {
          const promote = await workspaces.promote(workspace, {
            evaluation: decision.evaluation, // sourced from the integrator, NOT hardcoded
            governance,
            // Auditability: record the verification scope the promote relied on in the commit message.
            message: `worker-model: ${task.goal}${decision.rationale !== undefined ? ` — ${decision.rationale}` : ""}${verificationScope !== undefined ? ` [verification: ${verificationScope}]` : ""}`,
            requestId: task.taskId,
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

    // UNVERIFIABLE-TARGET REASON: when the run failed closed because no checks could be derived,
    // replace the generic role-outcome reason with a concise, actionable one. The full operator
    // next-steps are carried on `verification` + rendered by the CLI; this keeps receipts readable.
    if (checksUnverifiable !== undefined && overall !== "success") {
      reason = `unverifiable target (${checksUnverifiable.kind}): ${checksUnverifiable.reason}`;
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
      ...(checksUnverifiable !== undefined && overall !== "success"
        ? { verification: { kind: checksUnverifiable.kind, reason: checksUnverifiable.reason, nextSteps: [...UNRESOLVABLE_NEXT_STEPS] } }
        : {}),
      ...(escalationOutcome !== undefined ? { escalation: escalationOutcome } : {}),
      ...(escalationRetryOutcome !== undefined ? { escalationRetry: escalationRetryOutcome } : {}),
    };

    // TRUST-TIER UX (WO5): the work LANDED (verified + promoted) — surface the trust tier that
    // authorized it as a clear, standalone event BEFORE the generic completion line. The tier and
    // its autonomy grant are read straight from the governance tier already used for the promote
    // (no new decision, no weakening) — this is pure visibility into the bootstrap's trust posture.
    if (promoted) {
      const landedGrant = autonomyForTier(asTier(parentIdentity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
      events.publish(
        workerTrustEstablished.create(
          {
            taskId: task.taskId,
            workspaceId: workspace.id,
            tier: landedGrant.tier,
            sandboxed: landedGrant.sandboxed,
            gateLevel: landedGrant.gateLevel,
            requiresApproval: landedGrant.requiresApproval,
            autoCommit: landedGrant.autoCommit,
          },
          { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } },
        ),
      );
    }
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

    // Write a run-level summary receipt that captures the full standardized metadata for this
    // task. This is the single place in the trail that has: taskId, workspaceId, repo, branch,
    // model, cost, verification result, and promotion result — enabling `receipts --task` to
    // show a complete picture without inspecting individual role receipts.
    const verifierResult = results.find((r) => r.role === "verifier");
    await receipts.append(
      {
        operation: "worker.run.summary",
        outcome: { status: toOutcomeStatus(overall), ...(reason !== undefined ? { detail: reason } : {}) },
        requestId: task.taskId,
        metadata: {
          taskId: task.taskId,
          workspaceId: workspace.id,
          targetBranch: workspace.baseBranch,
          targetRepo: task.targetRepo,
          outcome: overall,
          promoted,
          model: singleBuilderModel,
          costUsd: runCost(),
          verificationResult: verifierResult !== undefined ? verifierResult.outcome : "not_run",
          verificationMode: ranVerificationMode,
          retrievalMode: ranRetrievalMode,
          ...(task.originAgent !== undefined ? { originAgent: task.originAgent } : {}),
        },
        project: task.targetRepo,
      },
      parentIdentity,
    );

    // UNVERIFIABLE-TARGET CLASSIFICATION RECEIPT (post-build path, where the builder actually ran —
    // the WO2 preflight path emits its own `worker.checks_unresolvable` and returns before here). One
    // receipt that records the classification, reason, next steps, and that BOTH escalation and the
    // trust penalty were suppressed — the single audit row that says "this was not a model failure".
    if (checksUnverifiable !== undefined && overall !== "success") {
      await receipts.append(
        {
          operation: "worker.checks_unresolvable",
          outcome: { status: "success", detail: `${checksUnverifiable.kind}: ${checksUnverifiable.reason}` },
          requestId: task.taskId,
          metadata: {
            taskId: task.taskId,
            workspaceId: workspace.id,
            targetRepo: task.targetRepo,
            verificationKind: checksUnverifiable.kind,
            reason: checksUnverifiable.reason,
            escalationSuppressed: true,
            trustSuppressed: true,
            modelFailure: false,
            nextSteps: [...UNRESOLVABLE_NEXT_STEPS],
          },
          project: task.targetRepo,
        },
        parentIdentity,
      );
    }

    // FIX A: record ONE trust outcome per BUILD (not per role). Uses the helper
    // which handles suppression for operator/governance decisions (Fix 1B).
    // FIX 4.2 backstop: if the build failed and ALL failures were performance-class
    // (timeout/no_progress/stuck_detected with no bad output), count ONE failure to
    // prevent unbounded evasion. The model keeps consuming budget with zero trust consequence.
    let buildTrustStatus = toOutcomeStatus(overall);
    let buildTrustSuppressed = trustSuppressed;
    let buildTrustReason = trustSuppressReason;
    // UNVERIFIABLE TARGET: a fail-closed terminal because no checks could be derived is NOT a worker
    // quality/code failure — the model could not have succeeded against a missing verifier. SUPPRESS
    // the trust signal (no demotion, no consecutive-failure cascade) and receipt the reason. Wins
    // over the performance-class backstop below (it is the more specific, non-model cause).
    if (checksUnverifiable !== undefined && overall !== "success" && !buildTrustSuppressed) {
      buildTrustSuppressed = true;
      buildTrustReason = `verification ${checksUnverifiable.kind} (no derivable checks) — not a worker quality failure`;
    }
    if (checksUnverifiable === undefined && overall === "failure" && !trustSuppressed) {
      const failedRoles = results.filter((r) => r.outcome === "failure");
      const allPerformanceFailures = failedRoles.every((r) => {
        const d = (r.detail ?? {}) as Record<string, unknown>;
        const stop = String(d.stopReason ?? "");
        const hasEvidence = Array.isArray(d.toolFormatErrors) && d.toolFormatErrors.length > 0;
        return ["timeout", "no_progress", "stuck_detected", "max_iterations"].includes(stop) && !hasEvidence;
      });
      if (allPerformanceFailures && failedRoles.length > 0 && config.penalizeTimeouts !== true) {
        // All failures were performance-class with no bad output evidence.
        // Suppress the trust signal (don't demote) but count toward the backstop.
        buildTrustSuppressed = true;
        buildTrustReason = "all failures are performance-class (backstop: suppressed, not penalized)";
      }
    }
    await recordBuildTrust(buildTrustStatus, workerSpawned, task.taskId, task.targetRepo, buildTrustSuppressed, buildTrustReason);

    return result;
  }

  // ── COMPETITIVE BUILD MODE (AMG) ────────────────────────────────────────────

  /** Dispatch one role in one workspace (events + recordRole), returning its result.
   *  `roleFnOverride` lets the competitive loop inject a per-candidate builder (its own model). */
  async function dispatchRole(role: WorkerRole, spawned: SpawnedRole, task: WorkerTask, workspace: WorkspaceHandle, priorResults: readonly RoleResult[], parentCtx: OperationContext, engine: RoleEngine, roleFnOverride?: RoleFn, cost?: () => number): Promise<RoleResult> {
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
    const costBeforeRole = cost?.() ?? 0;
    const result = await runRoleFn(role, roleFn, ctx, verifierTimeout);
    events.publish(
      workerRoleCompleted.create(
        { taskId: task.taskId, role, outcome: result.outcome },
        { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
      ),
    );
    const roleCost = cost !== undefined ? cost() - costBeforeRole : undefined;
    await recordRole(task, workspace, spawned, result, roleCost, singleBuilderModel, true);
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
      await recordBuildTrust("rejected", undefined, task.taskId, task.targetRepo, true, preKill);
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason: preKill };
    }

    // Per-run costing engine: accumulates model cost across the shared scout + every candidate.
    const { engine: runEngine, cost: runCost } = makeCostingEngine(task.maxBudgetUsd, task.effort);

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
    // FIX 5: capture worker identity for trust recording (competitive mode).
    // Declared outside try so the catch block can record trust too.
    let compWorkerSpawned: SpawnedRole | undefined;
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
      const scoutSpawn = spawnRole("scout", parentCtx);
      const scoutResult = await dispatchRole("scout", scoutSpawn, task, handles[0]!, [], parentCtx, runEngine, undefined, runCost);
      // FIX 5: capture worker identity for trust recording (competitive mode).
      // The first spawned role carries the shared agent identity — subsequent roles
      // assert the same identity (Fix 6 invariant), so one capture suffices.
      const compWorkerSpawned: SpawnedRole = scoutSpawn;

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
          await recordBuildTrust("rejected", compWorkerSpawned, task.taskId, task.targetRepo, true, killReason);
          return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: rolesByWs.get(handles[0]?.id ?? "") ?? [], ...(handles[0] !== undefined ? { workspaceId: handles[0].id } : {}), promoted: false, reason: killReason };
        }
        // HEAD-TO-HEAD: candidate ci races its OWN model (the Nth listed model, or the single
        // builder model as fallback) in its OWN worktree — each with the full run_checks rail.
        const candidateModel = competitiveModelList?.[ci] ?? singleBuilderModel;
        const candidateBuilder = builderForModel(parentCtx, candidateModel, resolveBuilderMode(task));
        const builderResult = await dispatchRole("builder", spawnRole("builder", parentCtx), task, ws, [scoutResult], parentCtx, runEngine, candidateBuilder, runCost);
        // AUTO-VERIFY RESCUE: if the builder wrote files but hit a protocol termination,
        // try the verifier. On GREEN, reclassify the builder so the candidate proceeds.
        const rescue = await maybeAutoVerifyRescueBuilderResult(builderResult, async () => {
          return dispatchRole("verifier", spawnRole("verifier", parentCtx), task, ws, [scoutResult, builderResult], parentCtx, runEngine, undefined, runCost);
        });
        const finalBuilderResult = rescue.result;
        let verifierResult: RoleResult | undefined;
        const verifierSpawn = spawnRole("verifier", parentCtx);
        if (finalBuilderResult.outcome === "success") {
          verifierResult = rescue.rescueVerify ?? await dispatchRole("verifier", verifierSpawn, task, ws, [scoutResult, finalBuilderResult], parentCtx, runEngine, undefined, runCost);
        }
        // COMMIT this candidate's VERIFIED-good work (gated on autoCommit) BEFORE the judge —
        // safeDiffLines + buildCandidate read the committed diff, and the winner is promoted, so
        // the candidate's scratch branch must advance first or its diff is empty.
        if (verifierResult?.outcome === "success" && verifierSpawn.autonomy.autoCommit && workspaces.commit !== undefined) {
          await workspaces.commit(ws, `ikbi: ${task.goal}`);
        }
        rolesByWs.set(ws.id, [scoutResult, finalBuilderResult, ...(verifierResult !== undefined ? [verifierResult] : [])]);
        candidates.push(buildCandidate(ws, finalBuilderResult, verifierResult, await safeDiffLines(ws)));
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
        await recordBuildTrust("rejected", compWorkerSpawned, task.taskId, task.targetRepo, true, finalKill);
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
        await recordBuildTrust("rejected", compWorkerSpawned, task.taskId, task.targetRepo, false);
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
        await recordBuildTrust("rejected", compWorkerSpawned, task.taskId, task.targetRepo, true, reason);
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: winnerRoles, workspaceId: retained.retained?.id ?? winner.id, promoted: false, reason: retained.reason };
      }

      const governanceGrant = autonomyForTier(asTier(parentIdentity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
      const governance: PromoteGovernance = await gateWall.evaluate({ grant: governanceGrant, action: { kind: "promote", task, results: winnerRoles }, identity: parentIdentity });
      if (!governance.allow) {
        const reason = governance.reason ?? "gate-wall denied promotion";
        const retained = await retainCompetitiveFailure(reason, winner.id);
        events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        events.publish(workerFailed.create({ taskId: task.taskId, reason: retained.reason, workspaceId: retained.retained?.id ?? winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        await recordBuildTrust("rejected", compWorkerSpawned, task.taskId, task.targetRepo, true, reason);
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: winnerRoles, workspaceId: retained.retained?.id ?? winner.id, promoted: false, reason: retained.reason, costUsd: runCost() };
      }
      const promote = await workspaces.promote(winner, {
        evaluation: { approved: true, score: verdict.winner.composite, evaluatorId: "deterministic-judge" },
        governance,
        message: `worker-model (competitive): ${task.goal}`,
        requestId: task.taskId,
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
      // FIX 5: record trust for the competitive build outcome.
      // `outcome` maps directly to OutcomeStatus. Suppress only if the promotion
      // itself was denied by governance (operator decision), not if the worker earned it.
      const compSuppress = !promoted && outcome === "rejected";
      await recordBuildTrust(outcome as OutcomeStatus, compWorkerSpawned, task.taskId, task.targetRepo, compSuppress, reason);
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome, roles: winnerRoles, workspaceId: winner.id, promoted, ...(reason !== undefined ? { reason } : {}), costUsd: runCost() };
    } catch (err) {
      // Mid-run failure (allocation / role / judge): retain one useful failed candidate when
      // supported, discard the rest, and fail.
      const reason = err instanceof Error ? err.message : String(err);
      const retained = await retainCompetitiveFailure(reason);
      events.publish(workerFailed.create({ taskId: task.taskId, reason: retained.reason, ...(retained.retained !== undefined ? { workspaceId: retained.retained.id } : handles[0] !== undefined ? { workspaceId: handles[0].id } : {}) }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
      // FIX 5: mid-run failure is a genuine failure (not operator decision).
      await recordBuildTrust("rejected", compWorkerSpawned, task.taskId, task.targetRepo, false, reason);
      throw err;
    }
  }

  // ── CANDIDATE TOURNAMENT MODE (#tournament) ─────────────────────────────────

  /** Map a tournament lifecycle event onto the event bus (parent attribution). */
  async function emitTournamentEvent(task: WorkerTask, parentIdentity: AgentIdentity, ev: TournamentEvent, tournWorkerSpawned?: SpawnedRole): Promise<void> {
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
        // FIX 5: record trust for tournament completion.
        const tournStatus: OutcomeStatus = ev.promoted ? "success" : "partial";
        await recordBuildTrust(tournStatus, tournWorkerSpawned, task.taskId, task.targetRepo, !ev.promoted, ev.promoted ? undefined : "tournament shadow not promoted");
        break;
      case "failed":
        events.publish(workerFailed.create({ taskId: task.taskId, reason: ev.reason, ...(ev.workspaceId !== undefined ? { workspaceId: ev.workspaceId } : {}) }, attribution));
        // FIX 5: record trust for tournament failure (not suppressed — genuine failure).
        await recordBuildTrust("rejected", tournWorkerSpawned, task.taskId, task.targetRepo, false, ev.reason);
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
    const { engine: runEngine, cost: runCost } = makeCostingEngine(task.maxBudgetUsd, task.effort);
    // FIX 5: capture worker identity for trust recording (tournament mode).
    // The first spawned role carries the shared agent identity.
    let tournWorkerSpawned: SpawnedRole | undefined;

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
      const scoutSpawn = spawnRole("scout", parentCtx);
      if (tournWorkerSpawned === undefined) tournWorkerSpawned = scoutSpawn;
      const scoutResult = await dispatchRole("scout", scoutSpawn, t, ws, [], parentCtx, runEngine, undefined, runCost);
      const candidateBuilder = builderForModel(parentCtx, spec.model, spec.mode);
      const builderResult = await dispatchRole("builder", spawnRole("builder", parentCtx), t, ws, [scoutResult], parentCtx, runEngine, candidateBuilder, runCost);
      // AUTO-VERIFY RESCUE: if the builder wrote files but hit a protocol termination,
      // try the verifier. On GREEN, reclassify the builder so the candidate proceeds.
      const rescue = await maybeAutoVerifyRescueBuilderResult(builderResult, async () => {
        return dispatchRole("verifier", spawnRole("verifier", parentCtx), t, ws, [scoutResult, builderResult], parentCtx, runEngine, undefined, runCost);
      });
      const finalBuilderResult = rescue.result;
      let verifierResult: RoleResult | undefined;
      const verifierSpawn = spawnRole("verifier", parentCtx);
      if (finalBuilderResult.outcome === "success") {
        verifierResult = rescue.rescueVerify ?? await dispatchRole("verifier", verifierSpawn, t, ws, [scoutResult, finalBuilderResult], parentCtx, runEngine, undefined, runCost);
      }
      // COMMIT verified work so the candidate's diff is the clean committed range — that range is
      // both what the judge scores (diffLines) and what gets replayed into the shadow if it wins.
      if (verifierResult?.outcome === "success" && verifierSpawn.autonomy.autoCommit && workspaces.commit !== undefined) {
        await workspaces.commit(ws, `ikbi: ${t.goal}`);
      }
      const diffText = workspaces.diff !== undefined ? await workspaces.diff(ws).catch(() => "") : "";
      const candidate = buildCandidate(ws, finalBuilderResult, verifierResult, await safeDiffLines(ws));
      const roles = [scoutResult, finalBuilderResult, ...(verifierResult !== undefined ? [verifierResult] : [])];
      return { spec, workspace: ws, roles, candidate, diff: diffText };
    };

    const verifyShadow = async (t: WorkerTask, ws: WorkspaceHandle): Promise<ShadowVerification> => {
      // Install deps in the shadow workspace before verifying — the shadow is a clean
      // worktree without node_modules, so pnpm test / vitest will fail without this.
      await installWorkspaceDeps(ws, parentCtx, deps.dependencyInstall);
      const verifierResult = await dispatchRole("verifier", spawnRole("verifier", parentCtx), t, ws, [], parentCtx, runEngine, undefined, runCost);
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
        requestId: t.taskId,
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
              costUsd: runCost(),
            },
            project: task.targetRepo,
          },
          parentIdentity,
        );
      },
      cost: runCost,
      killed: async () => killHalt(task, parentIdentity, parentCtx),
      emit: (ev) => emitTournamentEvent(task, parentIdentity, ev, tournWorkerSpawned),
    };
  }

  return { run, spawnRole };
}

/** Parse the verifier's check results into the candidate's pass flags + (best-effort) test count. */
export function readVerifier(verifierResult: RoleResult | undefined): { typecheckPass: boolean; testsPass: boolean; testCount?: { passed: number; total: number }; testEvidence: "executed" | "zero" | "unverified" | "absent"; checks: ReadonlyArray<{ name: string; passed: boolean }> } {
  // Builder failed (no verify ran) ⇒ both gates fail.
  if (verifierResult === undefined) return { typecheckPass: false, testsPass: false, testEvidence: "absent", checks: [] };
  const detail = (verifierResult.detail ?? {}) as Record<string, unknown>;
  const checks = Array.isArray(detail.checks) ? (detail.checks as Array<Record<string, unknown>>) : [];
  const find = (name: string) => checks.find((c) => c.name === name);
  const typecheck = find("typecheck");
  const verdict = detail.verdict;
  const authoritativePass = verdict === "pass" && verifierResult.outcome === "success";
  const typecheckPass = typecheck !== undefined ? typecheck.exitCode === 0 : authoritativePass;

  // Extract a test count from a single check: the mapExec-STAMPED count (robust to outputTail
  // truncation) first, else a parse of the bounded tail (legacy results that predate the stamp).
  const countOf = (c: Record<string, unknown> | undefined): { passed: number; total: number } | undefined => {
    if (c === undefined) return undefined;
    const raw = c.testCount;
    if (
      typeof raw === "object" && raw !== null &&
      typeof (raw as { passed?: unknown }).passed === "number" &&
      typeof (raw as { total?: unknown }).total === "number"
    ) {
      return { passed: (raw as { passed: number }).passed, total: (raw as { total: number }).total };
    }
    return typeof c.outputTail === "string" ? parseTestCount(c.outputTail) : undefined;
  };

  // AGGREGATE TEST EVIDENCE ACROSS EVERY "test" CHECK. The ladder runs the suite across stages
  // (nearest-tests → package-checks → full), so there can be MORE THAN ONE check named "test". A
  // scope-limited earlier run can pass with no parseable tally while a later SUCCESSFUL full-scope
  // run carried a real count — keying evidence off only the first "test" check then under-reports it
  // as "unverified" and the integrator discards a build that verification actually proved. So carry
  // the STRONGEST real evidence any successful test check produced. This NEVER manufactures a count:
  // with no real tally anywhere it still reports unverified/absent and the fail-closed gate holds.
  const testChecks = checks.filter((c) => c.name === "test");
  const testsPass = testChecks.length > 0 ? testChecks.every((c) => c.exitCode === 0) : authoritativePass;
  const testCounts = testChecks.map((c) => countOf(c)).filter((x): x is { passed: number; total: number } => x !== undefined);
  // Prefer a count from a check that actually ran tests (total>0); else any count (e.g. a real 0).
  const testCount = testCounts.find((c) => c.total > 0) ?? testCounts[0];
  // Finding D — TEST-EXECUTION EVIDENCE: distinguish a REAL executed suite from a passing command
  // that proved nothing. A "test" check with a parsed count>0 is "executed"; a count of 0 is "zero"
  // (a runner that ran nothing); a pass with no parseable count anywhere is "unverified" (e.g. `echo
  // done`); NO "test" check at all (only custom checks like `ci`) is "absent".
  let testEvidence: "executed" | "zero" | "unverified" | "absent";
  if (testChecks.length === 0) {
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
