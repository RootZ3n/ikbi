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
  configureEscalationResolver,
  escalationEvaluated,
  escalationTriggered,
  escalationDeclined,
} from "../escalation/index.js";
import type { EscalationSignals, EscalationDecision } from "../escalation/index.js";
import { decideRecovery } from "../recovery/index.js";
import type { RecoveryAttempt } from "../recovery/index.js";
import { DriftBlockedError } from "../drift-prevention/index.js";
import type { DriftPrevention, DriftReport } from "../drift-prevention/index.js";
import { rosterFromIds } from "../model-router/index.js";
import { rentBuilderExpert, classifyTaskTier, resolveClassifierModel, laneRoster, type RentedExpert } from "./expert-rental.js";
import { semanticPromotionEligible, semanticDuelEligible, type SemanticVerdict, type SemanticVerdictKind } from "./semantic-verdict.js";
import { evaluateExecutedTestEvidence, noTestsPolicyEnabled } from "./executed-evidence.js";
import type { TestEvidence } from "./adjudication/contract.js";
import {
  loadRuntimeTruthReader,
  runtimeTruthEvidenceEnabled,
  resolveEvidenceLimits,
  resolveFreshnessWindowMs,
  filterAndBoundEvidence,
  type RuntimeEvidence,
  type RuntimeTruthEvidenceReader,
  type EvidenceRequestScope,
} from "../runtime-truth/index.js";
import { applyConsultPatch } from "./consult-apply.js";
import type { ApplyConsultPatchInput, ApplyConsultPatchResult } from "./consult-apply.js";

import type { ExecRequest, GovernedExec } from "../governed-exec/index.js";
import type { DependencyInstall } from "../dependency-install/contract.js";

import { builder, createBuilder, MAX_TOOL_ITERATIONS } from "./builder.js";
import { createPatchsmith } from "./patchsmith.js";
import { runTournament } from "./tournament.js";
import type { CandidateRun, CandidateSpec, ShadowVerification, TournamentEngine, TournamentEvent } from "./tournament.js";
import { captureStreamedStdout, classifyUnresolvableReason, committedPackageJsonDiff, parseChecksEnv, parseTestCount, PROJECT_MANIFESTS, resolveChecks, resolveCheckTimeoutMs, UNRESOLVABLE_NEXT_STEPS, type VerificationKind, workingTreePackageJsonDiff, workingTreePlanningDiff } from "./checks.js";
import { builderModel, competitiveBuilderModels } from "./role-models.js";
import { estimatePromptTokens, contextExceedsWindow } from "./context-preflight.js";
import { getCapabilities } from "../../core/provider/capabilities.js";
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
  resolveBuilderTimeoutMs,
  resolveTotalBudgetMs,
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
/** The receipt operation a builder role writes (`worker.role.builder`) — the drift baseline key the
 *  build-path governor consults for builder reliability. Kept in sync with recordRole's operation. */
const BUILDER_OPERATION = "worker.role.builder";

/**
 * Pre-flight context threshold: bump the builder to a bigger-window model when the KNOWN base
 * context (goal + project instructions + scout brief) already exceeds this fraction of the worker
 * model's window. High (0.7) on purpose — it estimates only the pre-loop base (runtime file reads
 * aren't counted), so it upgrades only when the size is unmistakable, never on a task the cheap
 * model could have handled. The reactive on-overflow escalation is the backstop for the rest.
 */
const CONTEXT_PREFLIGHT_FRACTION = 0.7;
/** Repair budget (Phase 6): the hard per-run cap on fixer/rescue model passes — prevents repair loops. */
const MAX_FIXER_ROUNDS = 2;

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
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { computeWorkProduct, decidePromotability, type Decision, type GitRunner, type SafetyAssessment, type Verdict, type WorkAssessment } from "./adjudication/index.js";

/**
 * Given `git status --porcelain` output, report whether the working tree has TRACKED
 * uncommitted changes (staged or unstaged). Untracked files (the `??` lines) are IGNORED:
 * a build worktree is cut from HEAD, so untracked files are never carried into it and cannot
 * conflict with auto-commit promotion — refusing on them (e.g. a stray build tarball or a
 * generated lockfile) blocks the common case to guard a rare one. A genuine path collision
 * (an untracked file at a path the build later creates) surfaces at promotion time, where the
 * workspace manager already fails closed. Exported for unit testing.
 */
export function porcelainHasTrackedChanges(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .some((line) => !line.startsWith("??"));
}

/**
 * Run `git status --porcelain` on `targetRepo`. Returns a human-readable reason
 * string when the repo has uncommitted TRACKED changes, undefined when clean (or only
 * untracked files are present), or when git is unavailable / the path is not a git repo
 * (fail-open: let workspace allocation surface the real error).
 */
function liveCheckTargetDirty(targetRepo: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", targetRepo, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return porcelainHasTrackedChanges(out)
      ? "target repo has uncommitted changes — commit or stash them first"
      : undefined;
  } catch {
    return undefined; // git unavailable or not a git repo — let workspace allocation handle it
  }
}

/**
 * ADJUDICATION CORE — WorkProduct producer. Runs read-only git in the worktree (a throwaway index for
 * the tree hash, so the real index/working tree are untouched) to get GROUND-TRUTH work-on-disk — the
 * replacement for the builder's self-reported `filesWritten` ledger. Used by the Step-2 shadow
 * instrumentation (wrapped in try/catch) AND by the auto-verify rescue's work detection.
 */
async function computeWorktreeWorkProduct(workspacePath: string, baseRef: string, taskId: string): Promise<import("./adjudication/index.js").WorkProduct> {
  const git: GitRunner = async (args, opts) =>
    execFileSync("git", ["-C", workspacePath, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      env: opts?.env !== undefined ? { ...process.env, ...opts.env } : process.env,
    });
  return computeWorkProduct(git, { baseRef, tempIndexPath: join(tmpdir(), `ikbi-adj-${taskId}.index`) });
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

/** A bare-repo diagnosis: the actionable message plus whether the target is EMPTY (greenfield). */
interface BareRepoDiagnosis {
  readonly message: string;
  /** True when the target has NO manifest AND no source files — a greenfield scaffold candidate
   *  (vs. loose source without a manifest, which is an existing project missing its manifest). */
  readonly greenfield: boolean;
}

/**
 * Diagnose a target repo that cannot be verified. Returns an actionable message (+ whether the
 * target is greenfield-empty) when the repo root has NO recognizable project manifest (mirrors
 * `resolveChecks`, which requires a manifest AT the worktree root), or `undefined` when a manifest
 * exists (normal flow) or the path is unreadable (fail-open — let workspace allocation surface the
 * real error). Best-effort and never throws: a bounded, depth-limited walk summarizes whatever
 * source files ARE present so the operator sees what ikbi saw.
 */
function diagnoseBareRepo(root: string): BareRepoDiagnosis | undefined {
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

  return {
    greenfield: totalFiles === 0,
    message: [
      "No project manifest or verifier detected.",
      `Detected files: ${summary}`,
      "Suggested next steps:",
      "  - Initialize a package manifest (e.g., `pnpm init`, `cargo init`)",
      '  - Provide an explicit check command: `ikbi build <repo> --check "python -m pytest"`',
      '  - Use `ikbi fix <repo> --check "<command>"` for fix mode',
    ].join("\n"),
  };
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
    promote: (handle: WorkspaceHandle, approval: { evaluation: WorkspaceEvaluation; governance?: PromoteGovernance; message?: string; requestId?: string; verifiedAgainst?: { targetHead: string; integratedTree: string } }) => Promise<PromoteResult>;
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
  /** The recovery loop's frontier executor (consult patch → apply). Default: the real applyConsultPatch. Injectable for tests. */
  readonly applyConsultPatch?: (input: ApplyConsultPatchInput) => Promise<ApplyConsultPatchResult>;
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
   * Reads the content tree hash of a candidate workspace (Phase 3 stale-tree protection). The
   * canonical promotion authority captures this at verification time and re-reads it immediately
   * before promotion; a mismatch blocks the promote (the candidate mutated since it was verified).
   * Default: `git -C <path> rev-parse HEAD^{tree}` (undefined when the path is not a git worktree,
   * e.g. an in-memory test workspace — the authority then skips the tree check, unchanged behavior).
   */
  readonly readTreeHash?: (workspacePath: string) => Promise<string | undefined>;
  /**
   * Whether a workspace path is a real git worktree (Phase 10, IKBI-REAUDIT-006). Used to fail the
   * promote CLOSED when a git-backed candidate's tree identity cannot be read (vs a genuinely non-git
   * in-memory/test workspace, which is exempt). Default: `git rev-parse --is-inside-work-tree`.
   */
  readonly isGitBacked?: (workspacePath: string) => Promise<boolean>;
  /**
   * Production runtime-truth EVIDENCE reader (Phase 5). When provided (or resolvable from the
   * configured `IKBI_RUNTIME_TRUTH_READER_MODULE`), the orchestrator requests bounded, task/candidate-
   * scoped evidence and injects it into the builder/critic model context. Absent + disabled ⇒ inert.
   */
  readonly runtimeTruthReader?: import("../runtime-truth/index.js").RuntimeTruthEvidenceReader;
  /**
   * Memory governor — intercepts writes to governed surfaces (CLAUDE.md, .ikbi/*, brain pages)
   * and converts them to operator-reviewed proposals. When wired, the builder's tool-executor
   * routes governed writes through the governor instead of writing directly.
   * Absent ⇒ no interception (backward compatible).
   */
  readonly memoryGovernor?: import("../memory-governor/contract.js").MemoryGovernor;
  /**
   * Drift GOVERNOR — the reliability watchdog on the BUILD PATH (step 3). Before spending on any
   * paid role, it reads the builder agent's durable baseline vs. its recent success rate for this
   * project and, per the drift POLICY (IKBI_DRIFT_PREVENTION_POLICY):
   *   - reportOnly (default) ⇒ advisory: emit + attach a note; the build proceeds unchanged.
   *   - warn ⇒ log + attach a warning note; the build proceeds.
   *   - block ⇒ REFUSE the build at zero API cost (a degraded agent must not keep burning spend).
   * Absent ⇒ no build-path governor (backward compatible; tests + bare orchestrators unaffected).
   * Wired to the live singleton by `createProductionWorker`. Fail-OPEN: a drift READ error never
   * breaks a build — drift is advisory infrastructure, not a correctness gate.
   */
  readonly driftGovernor?: DriftPrevention;
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

/**
 * Wire the escalation engine's "is this model wired?" resolver from the provider registry —
 * ONCE, lazily, via the same dynamic import as `lazyInvokeModel` (so the provider singleton
 * is never constructed at module load, before the egress-fetch-guard floor registers). After
 * this runs, the escalation cascade skips unwired/stub tier models in favor of a live one.
 */
let escalationResolverWired = false;
async function ensureEscalationResolver(): Promise<void> {
  if (escalationResolverWired) return;
  try {
    const { registry } = await import("../../core/provider/index.js");
    configureEscalationResolver((modelId) => {
      const spec = registry.getModel(modelId);
      return spec !== undefined && spec.providers.some((route) => registry.getProvider(route.provider) !== undefined);
    });
    escalationResolverWired = true; // only latch on success, so a properly-loaded run can still wire it
  } catch {
    // The provider registry isn't constructible yet (e.g. a unit test that hasn't loaded the egress
    // floor). Wiring is best-effort hardening — leave the resolver unset (cascade behaves as before,
    // preferring roster[0]) and retry on the next run. Never fail a build over this.
  }
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
/**
 * C-A1 (fail-closed): the injection / policy-taint promote gate must cover EVERY promote path. The
 * single-run path checks run-global flags; competitive & tournament race independent candidates in
 * SEPARATE worktrees and only the WINNER promotes — so the winner's OWN role details are the right thing
 * to inspect (a tainted loser is discarded regardless, and a run-global flag would false-block a clean
 * winner). Returns a discard reason when the winner's build was injected or attempted an out-of-policy
 * tool call, else undefined.
 */
function winnerTaintReason(roles: readonly RoleResult[]): string | undefined {
  for (const r of roles) {
    const d = r.detail as Record<string, unknown> | undefined;
    if (d?.externalInjectionDetected === true) {
      return "prompt-injection from OUTSIDE content detected by the neutralization chokepoint during the winning candidate's build (fail-closed — must not promote)";
    }
    // NB: injection NEUTRALIZED in the candidate's OWN worktree output (e.g. self-hosting test
    // fixtures) does NOT taint the winner — judge by effect, like the policy-taint case below.
    // NB: a PREVENTED (rejected) out-of-policy tool ATTEMPT does NOT taint the winner. Judge by effect,
    // not intent — the governor blocked it (no effect) and the candidate was verified green. It is a
    // recorded warning + learning signal, not a discard (see the single-build promote gate). Only an
    // EFFECTIVE breach (a control failure that landed) would discard, and that is a separate alarm.
  }
  return undefined;
}

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

/**
 * The ONE authoritative, attempt-scoped builder-model decision (IKBI-RT-001).
 *
 * Everything downstream reads from this single object: the initial builder dispatch, cost
 * attribution, the builder receipt, and lane-constrained retries. It is made ONCE per attempt at
 * rental time and is only replaced when an explicit NEW dispatch decision is made (the pre-flight
 * context-size escalation), which records itself. This is what enforces the invariant:
 *
 *     rented model == dispatched model == billed model == receipt model
 *
 * `alias` is the identity that was REQUESTED (an operator `--tier` override, the semantically-rented
 * expert id, or the configured default). `model` is the concrete id actually sent to the provider.
 * In ikbi these are the same id string (the roster ids ARE the provider-facing model ids; the
 * host/provider-model mapping happens one layer down, in the provider registry, from this exact
 * `model`), so recording both truthfully means never claiming an unrequested model was dispatched.
 */
interface AttemptModelDecision {
  /** The concrete model id dispatched to the provider (== billed == receipt). */
  readonly model: string;
  /** The identity that was requested/rented (equals `model` in ikbi's id scheme). */
  readonly alias: string;
  /** Why this model was chosen — for truthful receipts + logs. */
  readonly source: "tier-override" | "moe-rental" | "complexity-large" | "default" | "preflight-context-escalation";
  /** The vendor lane this attempt is pinned to (undefined = unpinned); constrains every retry. */
  readonly vendorLane?: string;
  /** Human-readable rationale (rental reason / escalation trigger). */
  readonly rationale?: string;
}

/**
 * The strategy that PRODUCED a promotion candidate. Candidate generation/selection may differ per
 * strategy, but the definition of promotion does NOT — every one of these routes through the single
 * canonical promotion authority (`promoteCandidate`). (Phase 3, IKBI-RT-004.)
 */
export type PromotionStrategy = "normal" | "duel-primary" | "duel-peer" | "tournament" | "competitive";

/**
 * A uniquely identifiable proposed tree produced by one attempt/strategy (Phase 3). It carries the
 * provenance the canonical promotion authority needs to prove the identity chain:
 *   generated == selected == verified == policy-evaluated == promoted == receipt candidate.
 * `verifiedTree` is the content tree hash the deterministic verifier certified; the authority refuses
 * to promote if the workspace's live tree no longer matches it (stale-tree / post-verify mutation).
 */
export interface PromotionCandidate {
  readonly taskId: string;
  /** The attempt this candidate belongs to (== the lane-distinct taskId; Phase 2). */
  readonly attemptId: string;
  readonly strategy: PromotionStrategy;
  readonly workspaceId: string;
  readonly workspacePath: string;
  /** The executed builder model (Phase 1) — for the truthful promotion receipt. */
  readonly model?: string;
  /** The attempt's vendor lane (Phase 2). */
  readonly vendorLane?: string;
  /** The content tree hash the verifier certified. Undefined ⇒ tree identity could not be read. */
  readonly verifiedTree?: string;
  /** The target-branch head verification ran against (for hash-bound promote authorization). */
  readonly targetHead?: string;
  /**
   * Whether the workspace is a real git worktree, so an ENFORCEABLE tree identity is REQUIRED (Phase 10,
   * IKBI-REAUDIT-006). When true, an unreadable/absent tree hash fails the promote CLOSED instead of
   * silently dropping the stale-tree + CAS checks. In-memory/non-git test workspaces leave this false and
   * legitimately have no tree.
   */
  readonly treeIdentityRequired?: boolean;
}

/** How the critic's verdict was resolved (Phase 3 critic-parser boundary). */
// The canonical semantic verdict kinds (Phase 4) — re-exported for the promotion evidence.
export type { SemanticVerdictKind };

/**
 * Candidate-BOUND evidence submitted to the canonical promotion authority (Phase 3). Every field
 * describes THIS candidate; the authority does not synthesize verification/safety facts, and a
 * strategy may not reuse another candidate's evidence. `semanticKind === "indeterminate"` marks a
 * bare/unparsable critic FAIL that is NOT a concrete defect — it must never be recorded as one.
 */
export interface CandidateEvidence {
  /** Deterministic verifier result for this candidate. The authority REJECTS a false value (Phase 10). */
  readonly verificationPassed: boolean;
  readonly verificationMode?: string;
  /**
   * The candidate's EXECUTED-TEST evidence class (Phase 10, IKBI-REAUDIT-001), from the verifier. The
   * authority requires `executed` (or `absent` under an explicit no-tests policy); `zero`/`unverified`/
   * missing block autonomous promotion. Undefined is treated as missing → fail-closed.
   */
  readonly testEvidence?: TestEvidence;
  /** Whether the explicit no-tests policy permits promoting THIS candidate on `absent` evidence (Phase 10). */
  readonly noTestsAcceptable?: boolean;
  /** Semantic (critic) verdict, classified. `not-evaluated` = the strategy ran no model critic. */
  readonly semanticKind: SemanticVerdictKind;
  /** The durable `worker.semantic` evidence id backing this verdict (Phase 9) — the promotion receipt
   *  references it rather than duplicating the full validated defect set. */
  readonly semanticEvaluationId?: string;
  /** Whether policy explicitly permits promoting THIS candidate without semantic evaluation (Phase 4). */
  readonly semanticEvaluationOptional?: boolean;
  /** The authoritative policy decision (integrator/judge/adjudication) — promote iff true. */
  readonly policyPromote: boolean;
  /** The real gate-wall governance decision — must allow, or the authority refuses. */
  readonly governance: PromoteGovernance;
  readonly evaluation: WorkspaceEvaluation;
  readonly message: string;
  readonly rationale?: string;
}

/**
 * Classify the critic's verdict for the canonical evidence (Phase 3 critic-parser boundary). A bare
 * `FAIL` with no concrete issue — or a critic role that failed to parse — is NOT authentic defect
 * evidence: it is `indeterminate`, and must never be recorded as a fabricated concrete defect. Only a
 * FAIL that carries at least one concrete issue (or substantive feedback) is `concrete-fail`. This
 * does not change the fail-closed decision (an indeterminate critic still does not promote); it makes
 * the recorded EVIDENCE truthful. A dedicated later phase may improve the critic contract/retries.
 */
export function classifySemanticVerdict(critic: RoleResult | undefined): SemanticVerdictKind {
  if (critic === undefined) return "not-evaluated";
  const d = (critic.detail ?? {}) as Record<string, unknown>;
  // Prefer the canonical semantic verdict the critic stamped (Phase 4) — the single source of truth.
  const sv = d.semanticVerdict;
  if (typeof sv === "object" && sv !== null && typeof (sv as SemanticVerdict).kind === "string") {
    return (sv as SemanticVerdict).kind;
  }
  // Fallback (an injected/legacy critic WITHOUT a stamped verdict — the production critic always
  // stamps one, so this only affects test doubles). A bare `FAIL` with no concrete issue is
  // indeterminate, never a fabricated defect. A critic that RAN (outcome success) and raised no
  // explicit `pass:false` is a pass (it produced no blocking objection).
  if (d.pass === true) return "pass";
  if (d.pass === false) {
    const issues = Array.isArray(d.issues) ? d.issues.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
    const fb = typeof d.feedback === "string" ? d.feedback.trim() : "";
    const substantiveFeedback = fb.length > 0 && fb.toUpperCase() !== "FAIL" && fb.toUpperCase() !== "PASS";
    return issues.length > 0 || substantiveFeedback ? "fail" : "indeterminate";
  }
  return critic.outcome === "success" ? "pass" : "indeterminate";
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
  const driftGovernor = deps.driftGovernor; // absent → no build-path drift governor (backward compatible)
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
  // TRUST LADDER (default OFF): earned-trust tier governance for building. OFF ⇒ build outcomes never
  // move the worker's tier (no demotion) AND verified-green work promotes regardless of tier. ON only
  // when explicitly enabled (IKBI_WORKER_MODEL_TRUST_LADDER=true). Safety controls are independent.
  const trustLadderActive = config.trustLadder === true;
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
    // Scale the whole-pipeline ceiling for a --complexity large build so the scaled builder role (plus
    // the usual roles + any retry) fits inside it rather than tripping the total budget mid-run.
    const budgetMs = resolveTotalBudgetMs(totalBudgetMs, task.complexity);
    if (budgetMs > 0 && !buildDeadlines.has(task)) buildDeadlines.set(task, nowMs() + budgetMs);
  }
  function budgetExceeded(task: WorkerTask): boolean {
    const deadline = buildDeadlines.get(task);
    return deadline !== undefined && nowMs() > deadline;
  }

  /**
   * BUILD-PATH DRIFT GOVERNOR (step 3). Consult the wired drift detector for the builder agent's
   * reliability on this project, BEFORE any paid role runs. Returns the drifted reports for advisory
   * attachment, plus a `blockReason` when the drift "block" policy fired (the caller turns that into a
   * zero-cost rejection). FAIL-OPEN: any drift READ error is swallowed (empty result) — drift is
   * advisory infrastructure and must never break a build. Only the drift POLICY (block) refuses, and
   * only on genuine detected drift. Caller has already checked driftGovernor !== undefined.
   */
  async function checkBuildDrift(task: WorkerTask, builderAgentId: string): Promise<{ reports: DriftReport[]; blockReason?: string }> {
    try {
      const reports = (await driftGovernor!.check({ agent: builderAgentId, operation: BUILDER_OPERATION, project: task.targetRepo })).filter((r) => r.drifted);
      return { reports };
    } catch (err) {
      if (err instanceof DriftBlockedError) {
        const detail = err.reports
          .map((r) => `${r.operation} recent ${Math.round(r.recentRate * 100)}% vs baseline ${Math.round(r.baselineRate * 100)}% (${r.severity ?? "minor"})`)
          .join("; ");
        const blockReason = `Refusing to build: builder reliability has drifted for this project — ${detail}. Held under the drift "block" policy; investigate the degradation or set IKBI_DRIFT_PREVENTION_POLICY=warn to proceed.`;
        return { reports: [...err.reports], blockReason };
      }
      // Any OTHER error → fail open. A drift read failure must never break a build.
      log.debug({ taskId: task.taskId, err: err instanceof Error ? err.message : String(err) }, "drift governor read failed — proceeding (fail-open)");
      return { reports: [] };
    }
  }

  // The active run's mid-loop halt check, handed to the (real) builder so its loop can stop at
  // iteration granularity on a kill or budget overrun. Set at run() entry; builds are serial.
  let activeCheckHalt: (() => Promise<{ halt: boolean; reason?: string }>) | undefined;

  // INJECTION SIGNAL (per-run): set by recordRole when the neutralization chokepoint blocked a tool
  // result in ANY role this build. Read by recordBuildTrust to attribute it to the per-build trust
  // outcome (trust is recorded per-build, not per-role — FIX A), so the NON-RECOVERABLE injection
  // flag is set when the ladder is active. ALSO a fail-closed IN-RUN promote gate (below) so the
  // OFFENDING build cannot promote — the trust demotion only affects FUTURE builds and is off by
  // default. Reset at every run entry; builds are serial (like activeCheckHalt).
  let injectionDetectedThisBuild = false;
  // ENFORCEMENT subset (per-run): injection whose blocked content came from OUTSIDE the worktree
  // (web/vision/delegate/brain/phone/unknown origin). ONLY this discards a green build and feeds the
  // trust signal. Injection in the build's OWN worktree output (run_checks, file reads — e.g. ikbi's
  // own injection-test fixtures when self-hosting) is neutralized-and-inert: recorded via
  // injectionDetectedThisBuild for audit, but judged by effect, not enforced. See isExternalToolOrigin.
  let externalInjectionDetectedThisBuild = false;
  // POLICY-TAINT (per-run): set by recordRole when ANY builder ATTEMPT this build attempted an
  // out-of-policy tool call. recordRole records the INITIAL builder BEFORE the retry/escalation
  // blocks replace its result, so a later clean retry cannot LAUNDER the taint (the tainted
  // attempt's writes may still be on disk in the shared worktree). A fail-closed in-run promote gate
  // reads it, mirroring the auto-verify-rescue policy guard across every retry path.
  let policyTaintedThisBuild = false;
  // FIXER PREVENTED ATTEMPTS (per-run, A2/D3): the off-books last-mile FIXER pass's PREVENTED
  // (governor-blocked) out-of-policy attempts. The fixer bypasses recordRole and its result never enters
  // `results`, so these are collected here and (a) stamped onto the builder result before the integrator
  // dispatches, feeding the review threshold + risk signal; (b) read directly by the run-summary risk
  // telemetry, so they accrue as evidence even on failed runs that never reach the integrator. Reset at
  // every run entry; builds are serial (like injectionDetectedThisBuild / policyTaintedThisBuild).
  let fixerPreventedThisBuild: Array<Record<string, unknown>> = [];
  // BUILD-PATH DRIFT (per-run, step 3): the advisory drifted reports the build-path governor surfaced
  // for THIS build (reportOnly/warn policies). Recorded on the run-summary receipt so the reliability
  // signal is auditable without a separate query. A "block" outcome never reaches here — it rejects the
  // build at entry before any role runs. Reset at every run entry; builds are serial.
  let buildDriftReports: DriftReport[] = [];

  // Accumulate a builder attempt's security signals (injection / policy taint) into the per-run flags.
  // recordRole does this for the roles it records; RETRY builders that bypass recordRole (the
  // critic-fix loop, the verifier-driven fix loop, the critic-driven escalation) call this directly so
  // an injection/taint on a RETRY still reaches the fail-closed in-run promote gate.
  const noteBuilderSignals = (r: RoleResult): void => {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    if (d.injectionDetected === true) injectionDetectedThisBuild = true;
    if (d.externalInjectionDetected === true) externalInjectionDetectedThisBuild = true;
    if (Array.isArray(d.policyViolations) && d.policyViolations.length > 0) policyTaintedThisBuild = true;
  };

  // The raw PREVENTED (governor-blocked) tool attempts a builder attempt recorded. Mirrors the
  // integrator's source-of-truth precedence: the reclassified `policyViolations` set if present, else
  // the fuller raw `rejectedToolCalls` set. Used to thread an off-books FIXER pass's prevented attempts
  // into run-level risk accounting (A2/D3).
  const preventedAttemptsOf = (r: RoleResult): Array<Record<string, unknown>> => {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    if (Array.isArray(d.policyViolations)) return d.policyViolations as Array<Record<string, unknown>>;
    if (Array.isArray(d.rejectedToolCalls)) return d.rejectedToolCalls as Array<Record<string, unknown>>;
    return [];
  };

  async function runRoleFn(role: WorkerRole, roleFn: RoleFn, ctx: RoleContext, timeoutOverrideMs?: number): Promise<RoleResult> {
    // The BUILDER role's per-role race honors the --complexity-large wall-clock bump (same resolver the
    // builder self-bounds with), so a large greenfield scaffold isn't cut off at the base 5-min timeout.
    // Applied here — the one chokepoint every builder dispatch (main + fix/escalation retries) flows
    // through — so every builder call site inherits the scaled deadline without threading it manually.
    // An explicit override (the verifier's check-floored timeout) still wins.
    const roleBaseTimeout = role === "builder" ? resolveBuilderTimeoutMs(roleTimeoutMs, ctx.task.complexity) : roleTimeoutMs;
    const effectiveTimeout = timeoutOverrideMs ?? roleBaseTimeout;
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
  function makeCostingEngine(maxBudgetUsd?: number, effort?: "low" | "medium" | "high" | "max"): { engine: RoleEngine; cost: () => number; addCost: (usd: number) => void } {
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
    // Gap B: fold a cost incurred OUTSIDE this engine (e.g. the frontier consult, which uses the raw
    // provider) into the run total, so runCost() — and every receipt/summary that reports it — includes
    // it. C-A3: and ENFORCE the budget cap on that external cost the same way invokeModel does — throw
    // BUDGET_EXHAUSTED when it pushes the run over, rather than deferring enforcement to the NEXT role
    // call (which may never happen: a consult that lands the fix and finishes could otherwise promote
    // over budget). The throw propagates to the run's budget-abort handler.
    const addCost = (usd: number): void => {
      total += Math.max(0, usd);
      if (budget !== undefined && total > budget && budget > 0) {
        budgetExhausted = true;
        throw Object.assign(
          new Error(`budget exhausted: cumulative cost $${total.toFixed(4)} exceeds $${budget.toFixed(4)} cap`),
          { code: "BUDGET_EXHAUSTED", costUsd: total, budgetUsd: budget },
        );
      }
    };
    return { engine: costingEngine, cost: () => total, addCost };
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
      // Phase 9: bind the semantic verdict to the tree the verifier certified. Real-critic only — an
      // injected test double returns above, so this never perturbs the Phase 3 stale-tree read sequence.
      resolveVerifiedTree: (ws: WorkspaceHandle) => readTreeHash(ws.path),
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
    // TRUST LADDER (default OFF for building): the trust tier must not GATE building. With the ladder
    // off, verified-green work promotes regardless of tier — force autoCommit on. Everything else is
    // left exactly as the tier dictates: `sandboxed`/`gateLevel` (execution confinement, enforced by
    // governed-exec + the OS sandbox) AND `requiresApproval` (the SG-10 human gate) are UNCHANGED, so
    // this lifts only the promotion friction, never a safety or operator control.
    const grant = autonomyForTier(effectiveTier);
    const autonomy: AutonomyGrant = trustLadderActive ? grant : { ...grant, autoCommit: true };
    return { identity, kind: resolved.kind, autonomy, validated: resolved };
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
    // INJECTION SIGNAL: the neutralization chokepoint returned a `block` verdict on a tool result
    // this role. It is ALWAYS recorded in the role receipt below (durable audit, independent of the
    // trust ladder) and, when the ladder is active, attributed as signals.injection so the trust
    // rules set the NON-RECOVERABLE injection flag — the marketed defense, wired detection→enforcement.
    const injectionDetected = ((result.detail ?? {}) as Record<string, unknown>).injectionDetected === true;
    const externalInjectionDetected = ((result.detail ?? {}) as Record<string, unknown>).externalInjectionDetected === true;
    if (injectionDetected) {
      injectionDetectedThisBuild = true; // audit: recorded in the role receipt regardless of origin
      if (externalInjectionDetected) {
        externalInjectionDetectedThisBuild = true; // ENFORCEMENT: carried to the per-build trust outcome + in-run promote gate
        log.warn({ role: result.role, taskId: task.taskId, agentId: spawned.identity.agentId }, "INJECTION DETECTED (external origin) — chokepoint blocked a tool result; recorded as a trust signal + blocks promotion");
      } else {
        // Neutralized injection in the build's OWN worktree output (e.g. self-hosting test fixtures):
        // the model never saw the raw text. Recorded for audit; judged by effect, not enforced.
        log.warn({ role: result.role, taskId: task.taskId, agentId: spawned.identity.agentId }, "injection neutralized in the build's own worktree output — recorded for audit, judged by effect (not blocking promotion)");
      }
    }
    // POLICY TAINT: a builder attempt that tried an out-of-policy tool call taints the whole build —
    // captured HERE (recordRole runs on the INITIAL builder before any retry replaces its result), so
    // a later clean retry can't launder it. Attempt-level, not the final integrator view.
    if (result.role === "builder") {
      const bd = (result.detail ?? {}) as Record<string, unknown>;
      const pv = Array.isArray(bd.policyViolations) ? bd.policyViolations : [];
      if (pv.length > 0) policyTaintedThisBuild = true;
    }

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
          ...(injectionDetected ? { injectionDetected: true } : {}),
        },
        project: task.targetRepo,
      },
      spawned.identity,
    );

    // FIX A: per-build trust recording. When skipTrust is set, trust is recorded ONCE
    // after the build completes (worker.build) instead of per-role (worker.role.*).
    // This eliminates the cascade where one failed build = 3-4 consecutive failures.
    // TRUST LADDER OFF (default): build outcomes never move the worker's trust tier — skip the
    // per-role trust signal entirely (the role receipt above still records the outcome for audit).
    if (skipTrust || !trustLadderActive) return;

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
        ...(externalInjectionDetected ? { signals: { injection: true } } : {}),
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
    // TRUST LADDER OFF (default): a build outcome must NOT move the worker's trust tier. Write one
    // auditable receipt recording that the ladder was disabled (so the trail explains why trust did
    // not move) and skip trust.recordOutcome entirely — no demotion, no promotion-streak. This is the
    // fix for harness-caused demotion (an over-decomposition artifact or a blocked no-effect probe
    // classified as a policy violation must never strip a worker's autonomy during building).
    if (!trustLadderActive) {
      await receipts.append(
        {
          operation: "worker.trust.ladder_disabled",
          outcome: { status: "success", detail: `trust ladder OFF — build outcome "${status}" did not move worker trust (set IKBI_WORKER_MODEL_TRUST_LADDER=true to enable earned-trust demotion/promotion).${reason !== undefined ? ` (${reason})` : ""}` },
          requestId: taskId,
          metadata: { agentId: workerSpawned.identity.agentId, buildStatus: status, ...(reason !== undefined ? { reason } : {}) },
          project: targetRepo,
        },
        workerSpawned.identity,
      );
      return;
    }
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
        // Attribute an EXTERNAL-origin chokepoint injection (any role this build) to the trust outcome —
        // the trust rules then set the NON-RECOVERABLE injection flag that blocks promotion while flagged.
        // Own-worktree injection (neutralized-and-inert, e.g. self-hosting fixtures) is NOT a trust signal.
        ...(externalInjectionDetectedThisBuild ? { signals: { injection: true } } : {}),
      },
      workerSpawned.validated,
    );
  }

  // ── CANONICAL PROMOTION AUTHORITY (Phase 3, IKBI-RT-004/005) ────────────────────────────────
  // The SOLE caller of `workspaces.promote`. Every promotion-capable strategy (normal, duel primary/
  // peer, tournament, competitive) submits a candidate + candidate-BOUND evidence here; no strategy
  // promotes, marks completion, or emits a success receipt on its own. This is what makes the identity
  // chain hold: generated == selected == verified == policy-evaluated == promoted == receipt candidate.
  //
  // The authority: (1) refuses unless the policy decision is promote AND the real gate-wall allowed;
  // (2) STALE-TREE — re-reads the candidate's live tree and refuses if it no longer matches the tree
  // that was verified (a post-verify/post-fix mutation, IKBI-RT-005); (3) binds `verifiedAgainst` so
  // the workspace CAS also refuses a moved target / a landed tree ≠ the certified tree; (4) performs
  // the one promote; (5) emits the canonical `worker.promotion` receipt carrying the full chain.
  const readTreeHash: (workspacePath: string) => Promise<string | undefined> =
    deps.readTreeHash ??
    (async (workspacePath: string): Promise<string | undefined> => {
      try {
        return execFileSync("git", ["-C", workspacePath, "rev-parse", "HEAD^{tree}"], { encoding: "utf8", timeout: 10_000 }).trim();
      } catch {
        return undefined; // not a git worktree (e.g. an in-memory test workspace) — skip the tree check
      }
    });

  // Is the workspace a REAL git worktree? (Phase 10, IKBI-REAUDIT-006.) `readTreeHash` returns undefined
  // for BOTH "not a git worktree" and "a transient git-read error on a real worktree" — indistinguishable,
  // so a read failure on a production workspace silently dropped the stale-tree + CAS enforcement. This
  // probe distinguishes the two: a git-backed candidate must FAIL CLOSED when its tree cannot be read; a
  // genuinely non-git (in-memory/test) workspace legitimately has no tree and is exempt.
  const isGitBacked: (workspacePath: string) => Promise<boolean> =
    deps.isGitBacked ??
    (async (workspacePath: string): Promise<boolean> => {
      try {
        return execFileSync("git", ["-C", workspacePath, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
      } catch {
        return false; // not a git worktree
      }
    });

  // ── RUNTIME-TRUTH EVIDENCE (Phase 5) ────────────────────────────────────────────────────────────
  // Resolve the production reader ONCE per orchestrator (an injected dep, else the configured dynamic
  // module, else inert). Fail-closed: a missing/broken reader yields no evidence + an advisory receipt,
  // never a fabricated success and never a build block. `requestRuntimeEvidence` builds a task/candidate-
  // scoped request, reads → scope-filters → bounds the evidence, emits `worker.runtime_truth`, and
  // returns the kept items for injection into the role's model context.
  let runtimeTruthResolved: { reader: RuntimeTruthEvidenceReader } | { error: string } | undefined | "unresolved" = "unresolved";
  const resolveRuntimeTruthReader = async (): Promise<{ reader: RuntimeTruthEvidenceReader } | { error: string } | undefined> => {
    if (runtimeTruthResolved === "unresolved") {
      try {
        runtimeTruthResolved = await loadRuntimeTruthReader(deps.runtimeTruthReader, modeEnv);
      } catch (err) {
        runtimeTruthResolved = { error: `runtime-truth reader resolution failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return runtimeTruthResolved;
  };
  const requestRuntimeEvidence = async (
    task: WorkerTask,
    role: WorkerRole,
    workspace: WorkspaceHandle,
    identity: AgentIdentity,
    binding: { attemptId?: string; candidateId?: string; needsVerifiedTree?: boolean; strategy?: string },
  ): Promise<readonly RuntimeEvidence[]> => {
    // Off + no dep + not configured ⇒ fully inert: no reader call, NO extra tree read, no receipt.
    const resolved = await resolveRuntimeTruthReader();
    if (resolved === undefined) return [];
    // Compute the candidate's verified tree ONLY when a reader is active (so a disabled build makes no
    // extra readTreeHash call — it must not perturb the Phase 3 stale-tree tree-read sequence).
    const verifiedTree = binding.needsVerifiedTree === true ? await readTreeHash(workspace.path) : undefined;
    const scope: EvidenceRequestScope = {
      taskId: task.taskId,
      repo: task.targetRepo,
      role,
      ...(binding.attemptId !== undefined ? { attemptId: binding.attemptId } : {}),
      workspaceId: workspace.id,
      ...(binding.candidateId !== undefined ? { candidateId: binding.candidateId } : {}),
      ...(verifiedTree !== undefined ? { verifiedTree } : {}),
      ...(binding.strategy !== undefined ? { strategy: binding.strategy } : {}),
      now: Date.now(),
      freshnessWindowMs: resolveFreshnessWindowMs(modeEnv),
    };
    let kept: readonly RuntimeEvidence[] = [];
    let omitted: { id: string; reason: string }[] = [];
    let truncated = false;
    let error: string | undefined = (resolved as { error?: string }).error;
    if ("reader" in resolved) {
      try {
        const raw = await Promise.resolve(resolved.reader.readEvidence(scope));
        const bounded = filterAndBoundEvidence(raw ?? [], scope, resolveEvidenceLimits(modeEnv));
        kept = bounded.kept;
        omitted = bounded.omitted;
        truncated = bounded.truncated;
      } catch (err) {
        // Reader execution failure is ADVISORY: no evidence, a truthful operational status, no block,
        // no candidate-defect classification, no duel. The build proceeds unchanged.
        error = `runtime-truth reader execution failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // TRUTHFUL RECEIPT: `injected` is exactly `kept.length > 0` because the builder/critic
    // DETERMINISTICALLY inject `ctx.runtimeEvidence` whenever it is present (the orchestrator sets it
    // only when kept is non-empty). The conformance tests assert the actual provider request carries
    // the evidence, so a receipt claiming injection can never diverge from the model context.
    try {
      await receipts.append(
        {
          operation: "worker.runtime_truth",
          outcome: { status: error !== undefined ? "failure" : "success", ...(error !== undefined ? { detail: error } : {}) },
          requestId: task.taskId,
          metadata: {
            taskId: task.taskId, role, readerId: "reader" in resolved ? resolved.reader.id : undefined,
            enabled: runtimeTruthEvidenceEnabled(modeEnv) || deps.runtimeTruthReader !== undefined,
            requestScope: { taskId: scope.taskId, repo: scope.repo, role, ...(scope.candidateId !== undefined ? { candidateId: scope.candidateId } : {}), ...(scope.verifiedTree !== undefined ? { verifiedTree: scope.verifiedTree } : {}) },
            keptCount: kept.length, keptIds: kept.map((e) => e.id), omittedCount: omitted.length, omitted, truncated, injected: kept.length > 0,
            ...(error !== undefined ? { error } : {}),
          },
          project: task.targetRepo,
        },
        identity,
      );
    } catch { /* receipt failure must never break the build */ }
    return kept;
  };

  interface CanonicalPromotionResult {
    readonly promote: PromoteResult;
    /** Set when the authority REFUSED before/at promote (policy, governance, stale-tree, or semantic). */
    readonly blockedReason?: string;
    /** True when the refusal was a stale-tree / post-verify mutation (candidate ≠ verified). */
    readonly staleTree?: boolean;
    /** True when the refusal was the semantic policy gate (a non-pass / unevaluated verdict). */
    readonly semanticWithheld?: boolean;
    /** True when the refusal was the executed-test / verification evidence gate (Phase 10). */
    readonly evidenceWithheld?: boolean;
    /** True when the refusal was an unenforceable tree identity on a git-backed candidate (Phase 10). */
    readonly treeIdentityUnavailable?: boolean;
  }

  async function promoteCandidate(
    handle: WorkspaceHandle,
    candidate: PromotionCandidate,
    evidence: CandidateEvidence,
    parentIdentity: AgentIdentity,
  ): Promise<CanonicalPromotionResult> {
    const noPromote = (reason: string, extra?: Record<string, unknown>): PromoteResult => ({
      promoted: false,
      workspaceId: handle.id,
      targetBranch: handle.baseBranch,
      beforeRef: candidate.targetHead ?? handle.baseRef,
      reason,
      ...extra,
    });
    // (1) POLICY + GOVERNANCE must both authorize — defense in depth (callers already gate these).
    if (!evidence.policyPromote) return { promote: noPromote("policy declined promotion"), blockedReason: "policy declined promotion" };
    if (evidence.governance.allow !== true) {
      return { promote: noPromote(evidence.governance.reason ?? "governance denied promotion"), blockedReason: "governance denied" };
    }
    // (1b) SEMANTIC POLICY (Phase 4): only a semantic `pass` is autonomously promotable. `not-evaluated`
    // promotes only when policy explicitly marks semantic evaluation optional for this candidate;
    // `fail`/`incomplete`/`indeterminate`/`infrastructure-failure` never autonomously promote. This is
    // the gate that stops a tournament/competitive winner from promoting as `not-evaluated` by default.
    if (!semanticPromotionEligible(evidence.semanticKind, evidence.semanticEvaluationOptional === true)) {
      const reason = `semantic policy: a "${evidence.semanticKind}" verdict is not autonomously promotable (only a semantic pass is; not-evaluated requires explicit optional policy)`;
      await receipts.append(
        {
          operation: "worker.promotion.semantic_withheld",
          outcome: { status: "failure", detail: reason },
          requestId: candidate.taskId,
          metadata: { taskId: candidate.taskId, attemptId: candidate.attemptId, strategy: candidate.strategy, workspaceId: candidate.workspaceId, semanticVerdict: evidence.semanticKind, semanticEvaluationOptional: evidence.semanticEvaluationOptional === true },
          project: handle.targetRepo,
        },
        parentIdentity,
      );
      log.warn({ taskId: candidate.taskId, strategy: candidate.strategy, semanticVerdict: evidence.semanticKind }, "canonical promotion: SEMANTIC withheld — non-pass verdict is not autonomously promotable");
      return { promote: noPromote(reason), blockedReason: reason, semanticWithheld: true };
    }
    // (1c) VERIFICATION + EXECUTED-TEST EVIDENCE (Phase 10, IKBI-REAUDIT-001). The AUTHORITY itself — not
    // only the integrator — requires authentic candidate-bound verification evidence, so NO path (normal,
    // multi-step final, tournament, competitive, adjudication) can autonomously promote without it. The
    // deterministic verifier must be green, AND real `executed` test evidence must exist (a no-tests
    // `absent` tree promotes only under an explicit policy; `zero`/`unverified`/missing always block).
    const evidenceWithheld = async (reason: string, detail: Record<string, unknown>): Promise<CanonicalPromotionResult> => {
      await receipts.append(
        {
          operation: "worker.promotion.evidence_withheld",
          outcome: { status: "failure", detail: reason },
          requestId: candidate.taskId,
          metadata: { taskId: candidate.taskId, attemptId: candidate.attemptId, strategy: candidate.strategy, workspaceId: candidate.workspaceId, ...detail },
          project: handle.targetRepo,
        },
        parentIdentity,
      ).catch(() => {});
      log.warn({ taskId: candidate.taskId, strategy: candidate.strategy, reason }, "canonical promotion: EVIDENCE withheld — no authentic executed verification evidence");
      return { promote: noPromote(reason), blockedReason: reason, evidenceWithheld: true };
    };
    if (evidence.verificationPassed !== true) {
      return evidenceWithheld("verification did not pass — the deterministic verifier is not green; refusing autonomous promotion", { verificationPassed: evidence.verificationPassed });
    }
    const testDecision = evaluateExecutedTestEvidence(evidence.testEvidence, { allowNoTests: evidence.noTestsAcceptable === true });
    if (!testDecision.acceptable) {
      return evidenceWithheld(`executed-test evidence not acceptable for autonomous promotion (${testDecision.reason}) — a green with test evidence "${testDecision.state}" proved nothing about behavior`, { testEvidence: testDecision.state, testEvidenceReason: testDecision.reason, noTestsAcceptable: evidence.noTestsAcceptable === true });
    }
    // (2) TREE IDENTITY (Phase 10, IKBI-REAUDIT-006) — fail CLOSED when a git-backed candidate's tree
    // identity is unavailable. Reading undefined is legitimate ONLY for a genuinely non-git (in-memory/
    // test) workspace; on a real git worktree a missing verified tree OR an unreadable live tree means we
    // cannot establish an enforceable identity, so the stale-tree + CAS binding would silently disappear.
    const currentTree = await readTreeHash(candidate.workspacePath);
    if (candidate.treeIdentityRequired === true && (candidate.verifiedTree === undefined || currentTree === undefined)) {
      const which = candidate.verifiedTree === undefined ? "no verified tree was captured at verification time" : "the candidate's live tree is unreadable at promote time";
      const reason = `tree-identity: ${which} on a git-backed candidate — refusing to promote without an enforceable tree identity (stale-tree/CAS cannot be established)`;
      await receipts.append(
        {
          operation: "worker.promotion.tree_identity_unavailable",
          outcome: { status: "failure", detail: reason },
          requestId: candidate.taskId,
          metadata: { taskId: candidate.taskId, attemptId: candidate.attemptId, strategy: candidate.strategy, workspaceId: candidate.workspaceId, verifiedTree: candidate.verifiedTree ?? null, liveTree: currentTree ?? null },
          project: handle.targetRepo,
        },
        parentIdentity,
      ).catch(() => {});
      log.warn({ taskId: candidate.taskId, attemptId: candidate.attemptId }, "canonical promotion: TREE-IDENTITY unavailable on a git-backed candidate — promote refused (fail-closed)");
      return { promote: noPromote(reason, { strategy: "noop" }), blockedReason: reason, treeIdentityUnavailable: true };
    }
    // (2b) STALE-TREE: the candidate that is promoted must be the exact candidate that was verified.
    if (candidate.verifiedTree !== undefined && currentTree !== undefined && currentTree !== candidate.verifiedTree) {
      const reason = `stale-tree: candidate ${candidate.attemptId} changed since verification (verified tree ${candidate.verifiedTree}, live tree ${currentTree}) — refusing to promote unverified work`;
      await receipts.append(
        {
          operation: "worker.promotion.stale_tree",
          outcome: { status: "failure", detail: reason },
          requestId: candidate.taskId,
          metadata: { taskId: candidate.taskId, attemptId: candidate.attemptId, strategy: candidate.strategy, workspaceId: candidate.workspaceId, verifiedTree: candidate.verifiedTree, liveTree: currentTree },
          project: handle.targetRepo,
        },
        parentIdentity,
      );
      log.warn({ taskId: candidate.taskId, attemptId: candidate.attemptId, verifiedTree: candidate.verifiedTree, liveTree: currentTree }, "canonical promotion: STALE-TREE — candidate mutated since verification; promote refused");
      return { promote: noPromote(reason, { strategy: "noop" }), blockedReason: reason, staleTree: true };
    }
    // (3) HASH-BOUND authorization for the workspace CAS (moved target / landed tree ≠ certified tree).
    const verifiedAgainst =
      candidate.verifiedTree !== undefined && candidate.targetHead !== undefined
        ? { targetHead: candidate.targetHead, integratedTree: candidate.verifiedTree }
        : undefined;
    // (4) THE promote — the only `workspaces.promote` call in the module.
    const result = await workspaces.promote(handle, {
      evaluation: evidence.evaluation,
      governance: evidence.governance,
      message: evidence.message,
      requestId: candidate.taskId,
      ...(verifiedAgainst !== undefined ? { verifiedAgainst } : {}),
    });
    // (5) CANONICAL PROMOTION RECEIPT — the full identity chain, for every strategy uniformly.
    await receipts.append(
      {
        operation: "worker.promotion",
        outcome: { status: result.promoted ? "success" : "failure", ...(result.reason !== undefined ? { detail: result.reason } : {}) },
        requestId: candidate.taskId,
        metadata: {
          taskId: candidate.taskId,
          attemptId: candidate.attemptId,
          strategy: candidate.strategy,
          workspaceId: candidate.workspaceId,
          ...(candidate.model !== undefined ? { model: candidate.model } : {}),
          ...(candidate.vendorLane !== undefined ? { vendorLane: candidate.vendorLane } : {}),
          ...(candidate.verifiedTree !== undefined ? { verifiedTree: candidate.verifiedTree } : {}),
          verificationPassed: evidence.verificationPassed,
          ...(evidence.verificationMode !== undefined ? { verificationMode: evidence.verificationMode } : {}),
          semanticVerdict: evidence.semanticKind,
          ...(evidence.semanticEvaluationId !== undefined ? { semanticEvaluationId: evidence.semanticEvaluationId } : {}),
          policyPromote: evidence.policyPromote,
          gateWallAllowed: evidence.governance.allow,
          staleTreeChecked: candidate.verifiedTree !== undefined && currentTree !== undefined,
          promoted: result.promoted,
          ...(result.afterRef !== undefined ? { landedRef: result.afterRef } : {}),
          ...(evidence.rationale !== undefined ? { rationale: evidence.rationale } : {}),
        },
        project: handle.targetRepo,
      },
      parentIdentity,
    );
    return { promote: result };
  }

  /**
   * DURABLE SEMANTIC EVIDENCE (Phase 9, IKBI-RT-006). Persist the FULL validated semantic evaluation for a
   * final critic result — not just the KIND, but the complete validated blocking-defect set, missing
   * requirements, advisories, the structured-output recovery trail, and the policy consequence. This is
   * what the fixer, operator, and a later audit read to know WHY a candidate was rejected (the promotion
   * receipt records the `semanticEvaluationId` and never has to duplicate the defect set). Persists ONLY
   * parser-VALIDATED defects (the parser already dropped malformed/generic/cross-candidate/invented ones)
   * and a raw-output HASH (never the raw model output). Best-effort: a receipt failure never breaks a build.
   * Returns the stable `semanticEvaluationId`, or undefined when no model critic produced a verdict.
   */
  async function emitSemanticEvidence(
    criticResult: RoleResult | undefined,
    binding: { taskId: string; attemptId: string; candidateId: string; verifiedTree?: string; strategy: string; verificationPassed: boolean; targetRepo: string },
    parentIdentity: AgentIdentity,
  ): Promise<string | undefined> {
    if (criticResult === undefined) return undefined;
    const d = (criticResult.detail ?? {}) as Record<string, unknown>;
    const sv = d.semanticVerdict as SemanticVerdict | undefined;
    if (typeof sv !== "object" || sv === null || typeof sv.kind !== "string") return undefined;
    const semanticEvaluationId = `${binding.candidateId}:${binding.verifiedTree ?? "novt"}:sem`;
    const recoveryInvoked = d.recoveryInvoked === true;
    // Distinct RECOVERY receipt (Phase 9): the ONE model-backed reformat call — its own invocation id,
    // in-lane model, and separately-attributed cost/status. Emitted only when recovery actually ran.
    if (recoveryInvoked) {
      try {
        await receipts.append(
          {
            operation: "worker.critic_recovery",
            outcome: { status: d.recoveryOutcome === "repaired" ? "success" : "failure", detail: String(d.recoveryOutcome ?? "") },
            requestId: binding.taskId,
            metadata: {
              semanticEvaluationId, taskId: binding.taskId, attemptId: binding.attemptId, candidateId: binding.candidateId,
              invocationId: d.recoveryInvocationId, recoveryModel: d.recoveryModel, dispatchedModel: d.recoveryModel,
              ...(d.recoveryVendorLane !== undefined ? { vendorLane: d.recoveryVendorLane } : {}),
              outcome: d.recoveryOutcome, rejectReason: d.recoveryRejectReason ?? d.recoveryFailReason,
              costUsd: d.recoveryCostUsd, costStatus: d.recoveryCostStatus,
              eligibilityReason: d.recoveryEligibilityReason, finalVerdict: sv.kind,
            },
            project: binding.targetRepo,
          },
          parentIdentity,
        );
      } catch { /* receipt failure must never break the build */ }
    }
    try {
      await receipts.append(
        {
          operation: "worker.semantic",
          outcome: { status: sv.kind === "pass" ? "success" : "failure", detail: sv.summary },
          requestId: binding.taskId,
          metadata: {
            semanticEvaluationId,
            taskId: binding.taskId, attemptId: binding.attemptId, candidateId: binding.candidateId,
            ...(binding.verifiedTree !== undefined ? { verifiedTree: binding.verifiedTree } : {}),
            strategy: binding.strategy,
            verificationPassed: binding.verificationPassed,
            verdict: sv.kind,
            ...(sv.evaluatorModel !== undefined ? { evaluatorModel: sv.evaluatorModel } : {}),
            criticModel: sv.evaluatorModel,
            parseStatus: sv.parseStatus,
            summary: sv.summary,
            blockingDefects: sv.blockingDefects, // FULL parser-validated set (Phase 9)
            missingRequirements: sv.incompleteRequirements,
            advisories: sv.advisories,
            ...(typeof d.rawOutputHash === "string" ? { rawOutputHash: d.rawOutputHash } : {}),
            recoveryInvoked,
            ...(d.recoveryEligible !== undefined ? { recoveryEligible: d.recoveryEligible } : {}),
            ...(d.recoveryOutcome !== undefined ? { recoveryOutcome: d.recoveryOutcome } : {}),
            ...(d.recoveryInvocationId !== undefined ? { recoveryInvocationId: d.recoveryInvocationId } : {}),
            ...(d.recoveryModel !== undefined ? { recoveryModel: d.recoveryModel } : {}),
            ...(d.recoveryCostUsd !== undefined ? { recoveryCostUsd: d.recoveryCostUsd, recoveryCostStatus: d.recoveryCostStatus } : {}),
            promotionEligible: semanticPromotionEligible(sv.kind, false),
            duelEligible: semanticDuelEligible(sv.kind),
          },
          project: binding.targetRepo,
        },
        parentIdentity,
      );
    } catch { /* receipt failure must never break the build */ }
    return semanticEvaluationId;
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

  // ── AUTO-VERIFY RESCUE HELPER (ADJUDICATION, targeted increment) ─────────────
  // Adjudicate ANY builder failure that left work on disk: the verifier — not the builder's exit
  // code — is the witness to whether the work is good. Shared by every orchestrator path (single-run,
  // competitive, tournament).
  //
  // WHAT CHANGED (root fix for the recurring false-RED): the old version rescued ONLY four
  // "protocol-termination" stop reasons (no_progress/max_iterations/timeout/stuck_detected) and keyed
  // work-on-disk off the builder's self-reported `filesWritten` LEDGER. That discarded correct GREEN
  // work for every OTHER exit (tool_call_stalled, context_overflow, a hard error that still left a
  // green tree) and whenever the ledger desynced from disk (files written via governed `terminal`, or
  // the loop cut mid-write). Now: rescue fires on ANY builder failure, and work-on-disk is GIT ground
  // truth when a detector is wired (else the ledger, for callers that don't wire one).
  //
  // This can NEVER promote bad work — the REAL verifier is the gate; a red/blocked verifier still
  // fails closed and the original failure stands. It only stops discarding GOOD work unseen. A KILLED
  // run is handled by the orchestrator's kill short-circuit BEFORE the rescue, so a half-run is never
  // adjudicated here.
  //
  // Invariants preserved: runs the REAL verifier (no weakening); prevented policy violations are judged
  // by effect (a governor-blocked attempt does not block adjudication); RED verifier ⇒ original failure
  // stands; stamps autoVerifyRescue + originalBuilderStop for observability.

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
    // OPTIONAL last-mile fixer. Invoked ONLY when the rescue verifier is RED. It runs a bounded fix
    // pass with the configured fixer model (a DIFFERENT model than the builder) on the same workspace,
    // then re-verifies, and reports whether it closed the checks. Absent ⇒ a red verifier is terminal
    // (unchanged behavior). See config.fixerModel.
    runFixer?: (redVerify: RoleResult) => Promise<{ fixed: boolean; verify: RoleResult; model: string }>,
    // ADJUDICATION: ground-truth work-on-disk detector (git). When wired, work is read from the
    // worktree; absent ⇒ fall back to the builder's filesWritten ledger. Returns nonEmpty.
    detectWork?: () => Promise<{ nonEmpty: boolean }>,
  ): Promise<{ result: RoleResult; rescueVerify?: RoleResult }> {
    // Guard: only rescue builder failures.
    if (builderResult.role !== "builder" || builderResult.outcome !== "failure") {
      return { result: builderResult };
    }
    const bd = (builderResult.detail ?? {}) as Record<string, unknown>;
    const builderStop = typeof bd.stopReason === "string" ? bd.stopReason : "";
    const builderFilesWritten = Array.isArray(bd.filesWritten) ? bd.filesWritten.length : 0;

    // Guard: must have WORK ON DISK to verify — git ground truth when wired, else the ledger. NO
    // stop-reason allowlist: any failing exit that left work is adjudicated (the verifier is the gate).
    // A git-detection failure degrades to the ledger (never throws out of the rescue).
    let hasWork: boolean;
    if (detectWork !== undefined) {
      try {
        hasWork = (await detectWork()).nonEmpty;
      } catch {
        hasWork = builderFilesWritten > 0;
      }
    } else {
      hasWork = builderFilesWritten > 0;
    }
    if (!hasWork) return { result: builderResult };
    // JUDGE BY EFFECT, NOT INTENT: a policy violation in ikbi is a PREVENTED (rejected) tool call — the
    // governor/sandbox blocked it, so it had NO effect. A prevented attempt is evidence the governor
    // WORKED; it must NOT block the rescue/fixer from running the REAL verifier on the actual worktree.
    // (An EFFECTIVE breach — a sandbox/egress/confinement FAILURE that actually landed — is a separate,
    // higher-severity alarm, not a rejected tool call, and never reaches here.) The prevented attempt is
    // still recorded on the builder receipt as a warning + learning signal.

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

    // Verifier RED. A cheap builder often writes the WHOLE project then can't close the last errors it
    // left (it floundered re-reading and tripped no_progress). If a dedicated FIXER is configured, give
    // that DIFFERENT model ONE bounded pass to repair the red checks on the same worktree — the
    // automatic form of the staged, verify-between-modules oversight a human used to provide.
    if (runFixer !== undefined) {
      const fix = await runFixer(rescueVerify);
      if (fix.fixed) {
        const rescued: RoleResult = {
          ...builderResult,
          outcome: "success",
          summary: `${builderResult.summary}; fixer rescue: ${fix.model} closed the red checks after ${builderStop}`,
          detail: {
            ...bd,
            fixerRescue: true,
            fixerModel: fix.model, // the LANE-VALID model actually dispatched (Phase 6), not the raw config
            originalBuilderStop: builderStop,
            filesWritten: bd.filesWritten,
            rescueVerificationResult: "pass",
          },
        };
        return { result: rescued, rescueVerify: fix.verify };
      }
      // The fixer could not close it either — original failure stands, stamp both attempts.
      return {
        result: {
          ...builderResult,
          detail: { ...bd, autoVerifyRescueAttempted: true, fixerRescueAttempted: true, fixerModel: fix.model, rescueVerificationResult: "fail" },
        },
        rescueVerify: fix.verify,
      };
    }

    // Verifier RED, no fixer: the original failure stands. Stamp the attempt for observability.
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
    injectionDetectedThisBuild = false; // reset the per-run injection flag (builds are serial)
    externalInjectionDetectedThisBuild = false; // reset the per-run external-injection enforcement flag
    policyTaintedThisBuild = false; // reset the per-run policy-taint flag
    fixerPreventedThisBuild = []; // reset the per-run off-books fixer prevented-attempt accumulator
    buildDriftReports = []; // reset the per-run build-path drift advisory reports
    // Wire the escalation resolver (once) so the tier cascade skips unwired/stub models — done
    // here, in the async build entry, where the egress floor + provider registry are fully loaded.
    await ensureEscalationResolver();
    // Builder model resolution, highest precedence first:
    //   1. --tier preset (builderModelOverride) — an explicit, operator-chosen tier builder.
    //   2. MIXTURE OF EXPERTS (moeExpertRental) — the cheap-tier coordinator RENTS the cheapest-
    //      sufficient expert for THIS sub-task by difficulty (worker roster for mechanical work, mid
    //      roster for reasoning), up front. This is the 4-model pool acting as one virtual builder;
    //      each step of a decomposed build is its own rental (its own orchestrator.run).
    //   3. --complexity large — bump straight to the mid-tier model, skipping flash.
    //   4. the configured single builder model (default).
    // `let` so the pre-flight context-size check (below, once the scout brief is known) can bump it
    // to a bigger-window model — keeping cost attribution + the recorded model consistent with the
    // model the builder actually runs on.
    let rentedExpert: RentedExpert | undefined = undefined;
    // CLASSIFIER COST ACCOUNTING (Phase 7, IKBI-RT-011): the semantic-difficulty classifier is a REAL
    // provider invocation that runs BEFORE the costing engine exists — its spend was previously
    // discarded (invisible to runCost/the run-summary/the budget). Capture its cost/usage/model here;
    // fold it into runCost after the engine is built (below), and receipt it truthfully. The classifier
    // cost belongs to the CLASSIFIER model (e.g. deepseek-v4-flash), NEVER the expert it selects.
    let classifierCostUsd = 0;
    let classifierUsage: unknown;
    let classifierCalled = false; // a real provider invocation was attempted
    let classifierCostMeasured = false; // the provider returned a cost
    let classifierProvider: string | undefined;
    let classifierResponseModel: string | undefined;
    let classifierRetries = 0;
    let classifierDecisionSource: string | undefined;
    let classifierModelUsed: string | undefined;
    if (task.builderModelOverride === undefined && task.moeExpertRental === true) {
      // ROUTER (the coordinator's brain): semantically rate this sub-task's difficulty with ONE cheap
      // classifier call, then rent the cheapest-sufficient expert at that tier. The classifier + rental
      // both fall back to a zero-cost heuristic on any failure, so routing degrades gracefully and can
      // never block a build.
      const classifierModel = resolveClassifierModel(escalationConfig.tierModels, singleBuilderModel);
      classifierModelUsed = classifierModel;
      const verdict = await classifyTaskTier(
        task.goal,
        async (prompt) => {
          classifierRetries += 1; // each ACTUAL provider attempt is a distinct invocation
          classifierCalled = true;
          try {
            const res = await invokeModel({ model: classifierModel, prompt, temperature: 0, maxTokens: 200, identity: parentIdentity });
            // MEASURED when the provider returned a cost; UNAVAILABLE when it did not (never assume zero).
            if (res.cost?.usd !== undefined) { classifierCostUsd += res.cost.usd; classifierCostMeasured = true; }
            classifierUsage = res.usage;
            classifierProvider = res.provider;
            classifierResponseModel = res.model;
            return typeof res.content === "string" ? res.content : "";
          } catch {
            // A provider error loses the pre/post-dispatch distinction → cost UNKNOWN, never zero.
            return "";
          }
        },
        task.complexity !== undefined ? { complexity: task.complexity } : {},
      );
      classifierDecisionSource = verdict.source; // "model" (a provider call ran) | "heuristic" (deterministic)
      rentedExpert = rentBuilderExpert({
        goal: task.goal,
        ...(task.complexity !== undefined ? { complexity: task.complexity } : {}),
        tierRosters: escalationConfig.tierModels,
        fallback: singleBuilderModel,
        tierOverride: verdict.tier,
        ...(task.moeVendorLane !== undefined ? { vendorLane: task.moeVendorLane } : {}),
      });
      // IDENTITY CHAIN: pricing/usage/receipt all bind to the CLASSIFIER model, distinct from the
      // selected expert. `worker.classifier` records the routing invocation; a deterministic (heuristic)
      // decision is a NO-CALL with zero model cost — never a fabricated invocation.
      const status = classifierCalled ? (classifierCostMeasured ? "measured" : "unavailable") : "no-call";
      try {
        await receipts.append(
          {
            operation: "worker.classifier",
            outcome: { status: status === "unavailable" ? "failure" : "success", detail: `difficulty=${verdict.tier} via ${verdict.source}` },
            requestId: task.taskId,
            metadata: {
              taskId: task.taskId, stage: "classifier", invocationId: `${task.taskId}:classifier`,
              // DISPATCHED == the model SENT to the provider (== billed == priced). The provider's echoed
              // model is recorded separately as `providerReportedModel` (they match in production).
              classifierModel, dispatchedModel: classifierModel,
              ...(classifierResponseModel !== undefined && classifierResponseModel !== classifierModel ? { providerReportedModel: classifierResponseModel } : {}),
              ...(classifierProvider !== undefined ? { provider: classifierProvider } : {}),
              decision: verdict.tier, decisionSource: verdict.source, modelBacked: classifierCalled,
              selectedExpert: rentedExpert.modelId, // SEPARATE from the classifier model — its cost is NOT charged here
              ...(task.moeVendorLane !== undefined ? { vendorLane: task.moeVendorLane } : {}),
              ...(classifierUsage !== undefined ? { usage: classifierUsage } : {}),
              costUsd: classifierCostUsd, costStatus: status, retryCount: classifierRetries,
            },
            project: task.targetRepo,
          },
          parentIdentity,
        );
      } catch { /* classifier receipt failure must never break the build */ }
      log.info({ taskId: task.taskId, difficulty: verdict.tier, source: verdict.source, rationale: verdict.rationale, classifier: classifierModel, model: rentedExpert.modelId, classifierCostUsd, classifierCostStatus: status }, "MoE: router classified difficulty + rented builder expert");
    }
    // The ONE authoritative model decision for this attempt (IKBI-RT-001). Precedence, highest
    // first: an operator --tier preset (builderModelOverride) → the semantically-rented MoE expert
    // → --complexity large's mid-tier bump → the configured default builder. This SAME value is what
    // the initial builder dispatches on, what cost is attributed to, and what the receipt records —
    // there is no longer a parallel "complexityModel" that could diverge from it. `let` so the sole
    // legitimate post-rental replacement (the pre-flight context-size escalation, below) can install
    // a NEW, recorded decision; nothing else recomputes model identity.
    let modelDecision: AttemptModelDecision =
      task.builderModelOverride !== undefined
        ? { model: task.builderModelOverride, alias: task.builderModelOverride, source: "tier-override", ...(task.moeVendorLane !== undefined ? { vendorLane: task.moeVendorLane } : {}) }
        : rentedExpert !== undefined
          ? { model: rentedExpert.modelId, alias: rentedExpert.modelId, source: "moe-rental", rationale: rentedExpert.reason, ...(task.moeVendorLane !== undefined ? { vendorLane: task.moeVendorLane } : {}) }
          : task.complexity === "large"
            ? { model: escalationConfig.tierModels.mid[0] ?? singleBuilderModel, alias: escalationConfig.tierModels.mid[0] ?? singleBuilderModel, source: "complexity-large", ...(task.moeVendorLane !== undefined ? { vendorLane: task.moeVendorLane } : {}) }
            : { model: singleBuilderModel, alias: singleBuilderModel, source: "default", ...(task.moeVendorLane !== undefined ? { vendorLane: task.moeVendorLane } : {}) };
    // LANE DISCIPLINE (IKBI-RT-002): a lane-pinned attempt (the duel peer) must keep EVERY model pick —
    // escalation swap, pool sweep, retries — inside its vendor lane, not just the initial rental, so a
    // "duel-on-failure" attempt is a genuine single-vendor peer and its receipts prove it. `laneModelsFor`
    // filters an escalation roster to the attempt's lane; it is a NO-OP (returns the full roster) when no
    // lane is pinned, so the default single-attempt path is byte-unchanged.
    const laneModelsFor = (ids: readonly string[]): readonly string[] => laneRoster(ids, modelDecision.vendorLane);
    // An operator --fallback-model is honored as an escalation pick only when it is IN this attempt's
    // vendor lane. A cross-lane fallback would silently mutate a lane-pinned attempt's identity (Phase 2),
    // so it is NOT applied within this attempt — the in-lane ladder is used instead, and the operator's
    // other-lane preference is realized by the PEER attempt (a genuinely new attempt in that lane). For an
    // unpinned attempt every model is "in lane", so this returns the operator's choice unchanged.
    const laneFallbackModel: string | undefined =
      task.fallbackModel !== undefined && (modelDecision.vendorLane === undefined || task.fallbackModel.startsWith(modelDecision.vendorLane))
        ? task.fallbackModel
        : undefined;
    // SAME-LANE FIXER (Phase 6, IKBI-RT-012): a repair pass runs INSIDE the current attempt, so it must
    // use a lane-valid model. `config.fixerModel` (e.g. mimo-v2.5-pro) is honored ONLY when it is in the
    // attempt's vendor lane; a cross-lane fixer model would be a SILENT cross-lane execution inside the
    // attempt (the IKBI-RT-012 defect) — instead the repair falls back to the lane's strongest (mid)
    // model. For an unpinned attempt (a normal build, no duel) config.fixerModel is used verbatim (no
    // lane to violate). Cross-lane repair is owned by the Phase 2 PEER attempt (the other vendor lane),
    // never a hidden substitution — so no third vendor-lane attempt exists and the peer is not paid twice.
    const laneFixerModel: string | undefined = (() => {
      const configured = config.fixerModel;
      if (configured === undefined || configured === "") return undefined;
      if (modelDecision.vendorLane === undefined || configured.startsWith(modelDecision.vendorLane)) return configured;
      return laneModelsFor(escalationConfig.tierModels.mid)[0] ?? undefined;
    })();
    // EXPLICIT ATTEMPT-DECISION RECORD (Phase 2): on the MoE/duel path, persist the authoritative model
    // decision (and any pre-dispatch replacement) as its own receipt so the trail distinguishes each
    // attempt truthfully — even a pre-dispatch abort records which model this attempt intended, without
    // claiming it executed. Gated on moeExpertRental so ordinary single builds' receipt trail is
    // byte-unchanged. `attemptId` == this attempt's taskId (lane-distinct for a duel's primary vs peer).
    const recordModelDecision = async (d: AttemptModelDecision, phase: "initial" | "preflight-replacement"): Promise<void> => {
      if (task.moeExpertRental !== true) return;
      try {
        await receipts.append(
          {
            operation: "worker.model_decision",
            outcome: { status: "success", detail: `${d.source}: ${d.model}${d.vendorLane !== undefined ? ` [${d.vendorLane} lane]` : ""}` },
            requestId: task.taskId,
            metadata: {
              taskId: task.taskId,
              attemptId: task.taskId,
              phase,
              model: d.model,
              modelAlias: d.alias,
              modelSource: d.source,
              ...(d.vendorLane !== undefined ? { vendorLane: d.vendorLane } : {}),
              ...(d.rationale !== undefined ? { rationale: d.rationale } : {}),
            },
            project: task.targetRepo,
          },
          parentIdentity,
        );
      } catch {
        /* decision recording is best-effort observability — never break a build */
      }
    };
    await recordModelDecision(modelDecision, "initial");
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
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason, nonPromotion: { class: "governance-refused", duelEligible: false } };
      }
    }

    // BUILD-PATH DRIFT GOVERNOR (step 3): turn drift DETECTION into INTERVENTION on the build path.
    // Before spending on any paid role, consult the drift detector for the builder agent's reliability
    // on THIS project. Skipped on a reuseWorkspace step (a mid-chain step-planner pass — the governor
    // fires on the first/standalone build, like the dirty check) and when no governor is wired.
    // FAIL-OPEN by construction (see checkBuildDrift): a drift READ error never blocks a build; only a
    // deliberate "block" policy on genuine detected drift refuses — at zero API cost.
    if (task.reuseWorkspace === undefined && driftGovernor !== undefined) {
      const builderAgentId = spawnRole("builder", parentCtx).identity.agentId;
      const drift = await checkBuildDrift(task, builderAgentId);
      buildDriftReports = drift.reports;
      if (drift.blockReason !== undefined) {
        events.publish(workerFailed.create({ taskId: task.taskId, reason: drift.blockReason }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.run", runId: task.taskId } }));
        await receipts.append(
          {
            operation: "worker.run.drift_blocked",
            outcome: { status: "rejected", detail: drift.blockReason },
            requestId: task.taskId,
            metadata: { taskId: task.taskId, agentId: builderAgentId, targetRepo: task.targetRepo, driftedOperations: drift.reports.map((r) => r.operation) },
            project: task.targetRepo,
          },
          parentIdentity,
        );
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason: drift.blockReason, nonPromotion: { class: "governance-refused", duelEligible: false } };
      }
      if (buildDriftReports.length > 0) {
        log.warn({ taskId: task.taskId, agentId: builderAgentId, drifted: buildDriftReports.map((r) => `${r.operation} ${Math.round(r.recentRate * 100)}%<${Math.round(r.baselineRate * 100)}%`) }, "drift governor: builder reliability drifted for this project — proceeding (advisory)");
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
      // GREENFIELD SCAFFOLD (opt-in via task.allowGreenfieldScaffold): an EMPTY target (no manifest,
      // no source) is a from-scratch project the builder can make verifiable by scaffolding a manifest
      // + tests. Rather than reject before the builder runs, let it proceed — verification is resolved
      // POST-build from the now-populated workspace, and promotion STILL requires a green verify (a
      // build that fails to produce a verifiable project simply doesn't promote; the post-build
      // classifyUnverifiableTarget path handles it). Only a genuinely EMPTY target qualifies: loose
      // source without a manifest still fast-fails (adding a manifest there is the operator's call).
      if (diagnostic !== undefined && diagnostic.greenfield && task.allowGreenfieldScaffold === true) {
        events.publish(
          workerRoleDispatched.create(
            { taskId: task.taskId, role: "builder" },
            { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.greenfield_scaffold", runId: task.taskId } },
          ),
        );
        // fall through to the normal build flow — the builder scaffolds; the verifier gates promotion.
      } else if (diagnostic !== undefined) {
        // CLASSIFY: a no-manifest target is CHECKS_UNRESOLVABLE — fail closed with the structured
        // verdict (NOT a model failure). This pre-allocation path already escalates nothing (it
        // returns before any model call) and records no trust, satisfying the no-escalate /
        // no-demote contract; the `verification` field + receipt make the classification explicit.
        const concise = diagnostic.message.split("\n").slice(0, 2).join(" ");
        events.publish(
          workerFailed.create(
            { taskId: task.taskId, reason: diagnostic.message },
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
          reason: diagnostic.message,
          verification: { kind: "checks_unresolvable", reason: concise, nextSteps: [...UNRESOLVABLE_NEXT_STEPS] },
          nonPromotion: { class: "unverifiable", duelEligible: false },
        };
      }
    }

    // CANDIDATE TOURNAMENT MODE (#tournament, default OFF). When the task (or config) names
    // candidate models, race them independently, verify + score all, replay the WINNER's diff into
    // a clean shadow workspace, re-verify, then take the existing promote path. Takes precedence
    // over competitive. Byte-unchanged when no candidate models are configured.
    const taskCandidates = task.candidates !== undefined && task.candidates.length > 0 ? task.candidates : candidateModelList;
    // STEP-PLANNER GUARD: a step that REUSES a shared workspace, or skips promote/verify (an
    // intermediate or final step of a multi-step plan), MUST take the single-workspace path — the
    // tournament/competitive paths allocate FRESH worktrees and would ABANDON the accumulated work,
    // run the verifier against a deliberately-partial project (guaranteed red), and could even try to
    // promote mid-plan. So a multi-step build never enters those modes even when their env is set.
    const isStepPlannerStep = task.reuseWorkspace !== undefined || task.skipPromote === true || task.skipVerifier === true;
    if (!isStepPlannerStep && taskCandidates.length > 0) {
      const mode = resolveBuilderMode(task);
      const specs: CandidateSpec[] = taskCandidates.slice(0, MAX_CANDIDATE_MODELS).map((model) => ({ model, mode }));
      return runTournament(task, parentCtx, specs, makeTournamentEngine(task, parentCtx, parentIdentity));
    }

    // COMPETITIVE BUILD MODE (default OFF). When on, take the N-workspace path and
    // return; otherwise fall through to the single-workspace path below — BYTE-UNCHANGED.
    if (!isStepPlannerStep && config.competitive === true) {
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
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: [], promoted: false, reason: preKill, nonPromotion: { class: "interrupted", duelEligible: false } };
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
    const { engine: runEngine, cost: runCost, addCost: addRunCost } = makeCostingEngine(task.maxBudgetUsd, task.effort);
    // ROUTING OVERHEAD (Phase 7): fold the pre-engine classifier spend into the run total + the budget,
    // so `ikbi cost`, the run-summary, and the budget cap all see it. It is ROUTING overhead — kept as a
    // distinct subtotal on the summary (not blurred into builder cost). `addRunCost` may throw
    // BUDGET_EXHAUSTED if the classifier alone exceeds a tiny cap — correct: the classifier IS spend.
    const routingOverheadUsd = classifierCostUsd;
    // The classifier's cost STATUS: no-call (deterministic/off) | measured | unavailable (a call ran but
    // the provider returned no cost — UNKNOWN, never zero).
    const classifierCostStatus: "measured" | "unavailable" | "no-call" = classifierCalled ? (classifierCostMeasured ? "measured" : "unavailable") : "no-call";
    // Aggregate cost is PARTIAL when any accounted invocation's cost is unknown (never a false-precise total).
    const costPartial = classifierCostStatus === "unavailable";

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
    // REPAIR BUDGET (Phase 6): a hard per-run cap on fixer/rescue model passes so a repair can never
    // loop. Each `makeRunFixer` dispatch consumes one round; past the cap the fixer no-ops (the original
    // failure stands). Combined with the "unchanged tree ⇒ stop" guard inside the fixer.
    let fixerRoundsUsed = 0;
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

    // H4/Gap A: every TERMINATED build must write ONE authoritative cost receipt — `ikbi cost`
    // reads the run-summary's costUsd, so a build that ABORTS (budget exhausted, kill, infra failure)
    // and returns/throws before the normal summary below would leave its spend uncounted. The abort
    // branches call this to emit a minimal terminal summary. Best-effort: a receipt failure here must
    // never mask the abort we're already handling. (`aborted: true` distinguishes it in the trail.)
    const writeTerminalCostSummary = async (outcome: WorkerResult["outcome"], costUsd: number, detail: string, aborted = true): Promise<void> => {
      try {
        await receipts.append(
          {
            operation: "worker.run.summary",
            outcome: { status: toOutcomeStatus(outcome), detail },
            requestId: task.taskId,
            metadata: {
              taskId: task.taskId,
              workspaceId: workspace.id,
              targetBranch: workspace.baseBranch,
              targetRepo: task.targetRepo,
              outcome,
              promoted: false,
              // The attempt's authoritative model (IKBI-RT-001). `aborted: true` already marks this
              // as a terminated run, so this is the model the attempt SELECTED, never a claim that it
              // executed — a pre-dispatch abort still reports the chosen model honestly, not a default.
              model: modelDecision.model,
              costUsd,
              aborted,
              ...(task.originAgent !== undefined ? { originAgent: task.originAgent } : {}),
            },
            project: task.targetRepo,
          },
          parentIdentity,
        );
      } catch {
        /* a terminal-summary receipt failure must not mask the outcome being handled */
      }
    };

    try {
      // ROUTING OVERHEAD (Phase 7): fold the pre-engine classifier spend into runCost + the budget HERE,
      // inside the try, so a classifier that exceeds a tiny cap trips BUDGET_EXHAUSTED and is handled by
      // the abort path below (which writes a truthful terminal summary) rather than throwing out of run.
      if (routingOverheadUsd > 0) addRunCost(routingOverheadUsd);
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

        // A2/D3: before the integrator judges, fold any off-books FIXER prevented attempts onto the
        // builder result so the integrator's review threshold + risk signal account for them (the fixer
        // ran during the builder/verifier roles, both of which have now passed). Provenance-preserved:
        // stamped as a SEPARATE `fixerPreventedViolations` field, not merged into the builder's own set.
        if (role === "integrator" && fixerPreventedThisBuild.length > 0) {
          const bIdx = results.findIndex((r) => r.role === "builder");
          const builderRole = bIdx >= 0 ? results[bIdx] : undefined;
          if (builderRole !== undefined) {
            const bd = (builderRole.detail ?? {}) as Record<string, unknown>;
            results[bIdx] = { ...builderRole, detail: { ...bd, fixerPreventedViolations: [...fixerPreventedThisBuild] } };
          }
        }

        // RUNTIME-TRUTH (Phase 5): the builder + critic receive bounded, task/candidate-scoped runtime
        // evidence in their model context. The critic binds to the verified tree (candidate identity);
        // the builder binds to the attempt. Other roles run unchanged. Inert unless a reader is wired.
        const roleRuntimeEvidence =
          role === "builder" || role === "critic"
            ? await requestRuntimeEvidence(task, role, workspace, spawned.identity, {
                attemptId: task.taskId,
                candidateId: task.taskId,
                needsVerifiedTree: role === "critic",
                strategy: task.moeVendorLane !== undefined ? `duel-${task.moeVendorLane}` : "normal",
              })
            : [];
        const ctx: RoleContext = {
          task,
          role,
          identity: spawned.identity,
          autonomy: spawned.autonomy,
          workspace,
          priorResults: [...results],
          engine: runEngine,
          ...(roleRuntimeEvidence.length > 0 ? { runtimeEvidence: roleRuntimeEvidence } : {}),
        };
        // PRE-FLIGHT CONTEXT SIZE (proactive) — the ONE legitimate post-rental model change. The scout
        // has run, so its brief is known. If the base builder context (goal + project instructions +
        // scout brief) already fills most of the SELECTED model's window, install a NEW model decision on
        // a bigger-window mid model rather than burn a doomed attempt that would only overflow (the
        // reactive on-overflow path would then recover it). This is an explicit, RECORDED replacement of
        // the attempt decision — source "preflight-context-escalation" — so identity stays truthful.
        // Only fires when no --tier/--complexity model was pinned and the cascade is enabled; only bumps
        // UP (strictly larger window); LANE-AWARE, so a lane-pinned attempt bumps within its own vendor
        // lane and never crosses it.
        if (
          role === "builder" &&
          task.builderModelOverride === undefined &&
          task.complexity !== "large" &&
          task.escalationDisabled !== true
        ) {
          const scoutResult = results.find((r) => r.role === "scout");
          const brief = typeof (scoutResult?.detail as Record<string, unknown> | undefined)?.brief === "string"
            ? ((scoutResult!.detail as Record<string, unknown>).brief as string)
            : undefined;
          const estTokens = estimatePromptTokens([task.goal, task.projectInstructions, brief]);
          const currentWindow = getCapabilities(modelDecision.model).context_window;
          if (contextExceedsWindow(estTokens, currentWindow, CONTEXT_PREFLIGHT_FRACTION)) {
            const midModel = laneRoster(escalationConfig.tierModels.mid, modelDecision.vendorLane)[0];
            if (midModel !== undefined && midModel !== modelDecision.model && getCapabilities(midModel).context_window > currentWindow) {
              const fromModel = modelDecision.model;
              modelDecision = {
                model: midModel,
                alias: midModel,
                source: "preflight-context-escalation",
                ...(modelDecision.vendorLane !== undefined ? { vendorLane: modelDecision.vendorLane } : {}),
                rationale: `base context ~${estTokens} tok exceeds ${fromModel}'s window — pre-escalated to a bigger-window model`,
              };
              log.info({ taskId: task.taskId, fromModel, toModel: midModel, estTokens }, "pre-flight context escalation: bumped builder to a bigger-window model before dispatch");
              events.publish(
                workerRoleDispatched.create(
                  { taskId: task.taskId, role: "builder" },
                  { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.preflight_context_escalation", runId: task.taskId } },
                ),
              );
              // Record the pre-dispatch decision REPLACEMENT explicitly (still same lane, still before any
              // provider call) — the attempt's decision-replacement history, not a new attempt.
              await recordModelDecision(modelDecision, "preflight-replacement");
            }
          }
        }
        // Dispatch the builder on the ONE authoritative attempt model (IKBI-RT-001) — the rented
        // expert, the operator override, or the default, WHATEVER modelDecision resolved to. This is the
        // same value cost + the receipt attribute to, so the rented model is truly the dispatched model.
        const roleFn = role === "verifier" ? verifierFor(parentCtx) : role === "builder" ? builderForModel(parentCtx, modelDecision.model, resolveBuilderMode(task)) : role === "critic" ? criticFor() : role === "refuter" ? refuterFor() : roles[role];
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

        // ── LAST-MILE FIXER MACHINERY (shared by the builder-stop rescue AND the verifier-fail rescue) ──
        // The configured fixer model (a DIFFERENT model than the builder — e.g. deepseek builds,
        // mimo-v2.5-pro fixes) gets ONE bounded repair pass on the SAME worktree, then a re-verify.
        const makeRescueVerifier = (rescueSpawn: SpawnedRole) => async (): Promise<RoleResult> => {
          const rescueCtx: RoleContext = { task, role: "verifier", identity: rescueSpawn.identity, autonomy: rescueSpawn.autonomy, workspace, priorResults: [...results], engine: runEngine };
          return runRoleFn("verifier", verifierFor(parentCtx), rescueCtx, Math.max(roleTimeoutMs, resolveCheckTimeoutMs(modeEnv)));
        };
        const makeRunFixer = (runRescueVerifier: () => Promise<RoleResult>, fixerTrigger: string): ((redVerify: RoleResult) => Promise<{ fixed: boolean; verify: RoleResult; model: string }>) | undefined => {
          // SAME-LANE FIXER (Phase 6): dispatch a LANE-VALID repair model (never a silent cross-lane
          // substitution). No configured fixer, or none resolvable in-lane ⇒ no fixer.
          const fixerModel = laneFixerModel;
          if (!fixerModel) return undefined;
          return async (redVerify: RoleResult): Promise<{ fixed: boolean; verify: RoleResult; model: string }> => {
            // REPAIR BUDGET: never loop. Past the cap, the original failure stands.
            if (fixerRoundsUsed >= MAX_FIXER_ROUNDS) return { fixed: false, verify: redVerify, model: fixerModel };
            fixerRoundsUsed += 1;
            const fixerRound = fixerRoundsUsed;
            // PROVENANCE: snapshot the SOURCE candidate tree + the concrete failing checks the repair acts
            // on, so the repaired candidate is traceable and the trigger is authentic (a deterministic
            // verifier failure, never a bare/indeterminate critic verdict).
            const sourceTree = await readTreeHash(workspace.path);
            const failingChecks = readVerifier(redVerify).checks.filter((c) => c.passed === false).map((c) => c.name);
            const fixSpawn = spawnRole("builder", parentCtx);
            const fixGoal = [
              task.goal,
              "",
              "[FIX PASS] The project is already written but `run_checks` is RED. Do NOT rewrite working code or start over.",
              "Run run_checks, read the SPECIFIC errors it reports, and change ONLY what is needed to make every check pass.",
              "Iterate tightly: fix a file, run_checks, repeat until green, then call done.",
            ].join("\n");
            events.publish(
              workerRoleDispatched.create(
                { taskId: task.taskId, role: "builder", ...(fixSpawn.identity.trustTier !== undefined ? { tier: fixSpawn.identity.trustTier } : {}) },
                { source: EVENT_SOURCE, attribution: { identity: fixSpawn.identity, operation: "worker.role.fixer", runId: task.taskId } },
              ),
            );
            // RUNTIME-TRUTH (Phase 5): the same-attempt repair receives task/attempt/candidate-scoped
            // evidence — never another attempt's. Inert unless a reader is wired.
            const fixerEvidence = await requestRuntimeEvidence(task, "builder", workspace, fixSpawn.identity, { attemptId: task.taskId, candidateId: task.taskId, strategy: `fixer:${fixerTrigger}` });
            const fixCtx: RoleContext = {
              // Preserve the task's declared write scope — a fix pass must NOT silently widen a
              // `new_only`/`none` task to full write access just because one check went red.
              task: { ...task, goal: fixGoal, writeScope: task.writeScope ?? "all" },
              role: "builder",
              identity: fixSpawn.identity,
              autonomy: fixSpawn.autonomy,
              workspace,
              priorResults: [...results],
              engine: runEngine,
              ...(fixerEvidence.length > 0 ? { runtimeEvidence: fixerEvidence } : {}),
            };
            // COST: bill the fixer's provider calls to the fixer model, separately from the builder role.
            const costBeforeFixer = runCost();
            const fixResult = await runRoleFn("builder", builderForModel(parentCtx, fixerModel, resolveBuilderMode(task)), fixCtx);
            const fixerCost = runCost() - costBeforeFixer;
            events.publish(
              workerRoleCompleted.create(
                { taskId: task.taskId, role: "builder", outcome: fixResult.outcome },
                { source: EVENT_SOURCE, attribution: { identity: fixSpawn.identity, operation: "worker.role.fixer", runId: task.taskId } },
              ),
            );
            noteBuilderSignals(fixResult); // a fixer taint/injection reaches the fail-closed promote gate
            // A2/D3: thread the fixer pass's PREVENTED (governor-blocked) attempts into run-level risk
            // accounting. The fixer runs off-books — no recordRole, its result never enters `results` — so
            // without this its blocked out-of-policy attempts are INVISIBLE to the integrator's review
            // threshold AND the run-summary risk telemetry. Accumulate them here; they are stamped onto the
            // builder result before the integrator dispatches (so the review threshold sees them) and read
            // directly by the run-summary telemetry (so they accrue as risk evidence even on FAILED runs
            // that never reach the integrator). Kept SEPARATE from the builder's own prevented set.
            fixerPreventedThisBuild.push(...preventedAttemptsOf(fixResult));
            const verify = await runRescueVerifier();
            // The REPAIRED candidate's tree (post-fix) — the exact tree the re-verify (and later the
            // critic/promotion) judge. Distinct from `sourceTree`; the source verdicts are now stale.
            const resultingTree = await readTreeHash(workspace.path);
            const fixed = verify.outcome === "success";
            // TRUTHFUL FIXER RECEIPT (Phase 6, IKBI-RT-012): the repair is no longer off-books. Records
            // the provenance chain + the LANE-VALID model actually dispatched (selected == dispatched ==
            // billed == receipt) + its own cost. `crossLaneAvoided` marks when a cross-lane config.fixerModel
            // was replaced by the in-lane model (the cross-lane repair is owned by the peer attempt).
            try {
              await receipts.append(
                {
                  operation: "worker.fixer",
                  outcome: { status: fixed ? "success" : "failure", detail: fixed ? "repair closed the red checks" : "repair did not close the red checks" },
                  requestId: task.taskId,
                  metadata: {
                    sourceTaskId: task.taskId, sourceAttemptId: task.taskId, sourceCandidateTree: sourceTree,
                    repairAttemptId: task.taskId, repairRound: fixerRound, repairStrategy: "same-lane", fixerTrigger,
                    failingChecks, fixerModel, dispatchedModel: fixerModel,
                    ...(modelDecision.vendorLane !== undefined ? { vendorLane: modelDecision.vendorLane } : {}),
                    crossLaneAvoided: config.fixerModel !== undefined && fixerModel !== config.fixerModel,
                    resultingCandidateTree: resultingTree, treeUnchanged: sourceTree !== undefined && sourceTree === resultingTree,
                    verificationOutcome: verify.outcome, costUsd: fixerCost, promoted: false,
                  },
                  project: task.targetRepo,
                },
                fixSpawn.identity,
              );
            } catch { /* receipt failure must never break the repair */ }
            return { fixed, verify, model: fixerModel };
          };
        };

        // ── AUTO-VERIFY RESCUE: builder wrote files but hit a protocol stop before run_checks ──
        // Delegated to maybeAutoVerifyRescueBuilderResult (shared with competitive/tournament).
        // Rescue verifier reuses the builder's spawn (unchanged behavior).
        // NOTE: adjudication of a builder failure is done ONCE, at the TERMINAL adjudication point below
        // (just before the short-circuit), on the FINAL builder result — so it covers work produced by
        // ESCALATION too, and there is a single verifier dispatch (one decision point, per the design).
        // The old per-attempt rescue here only saw the FIRST attempt and missed escalated work.

        // ── FIXER-ON-VERIFIER-FAIL RESCUE: the builder declared SUCCESS but the MAIN verifier caught a
        // FIXABLE red check (e.g. one leftover TS error). Without this, that build is discarded
        // (skip-critic-on-red → integrator discard) with a ~$0.01 fixer pass in reach — the last-mile
        // fixer above only fires on builder PROTOCOL-STOPS, never on a verifier catch after builder
        // success. Give the fixer model ONE bounded pass + re-verify HERE, at the verifier boundary, so
        // the critic/integrator see a GREEN verifier when it works (and an unchanged RED one when it does
        // not). Fail-closed: only genuine, fixable check failures are retried (not injection / unresolvable
        // / skipped), and a still-red re-verify leaves the original failure to discard as before.
        if (role === "verifier" && isFixableVerifierFailure(result)) {
          const runFixer = makeRunFixer(makeRescueVerifier(spawnRole("verifier", parentCtx)), "verifier_fail");
          if (runFixer !== undefined) {
            const fix = await runFixer(result);
            const vd = (result.detail as Record<string, unknown> | undefined) ?? {};
            // The fixer now emits its own `worker.fixer` receipt (Phase 6); the stamps below reflect the
            // LANE-VALID model actually dispatched (`laneFixerModel`), not the raw config, so the trail is
            // truthful about which model ran inside this attempt's lane.
            log.warn({ taskId: task.taskId, fixerModel: laneFixerModel, fixed: fix.fixed, trigger: "verifier_fail" }, fix.fixed ? "fixer rescue: closed a verifier-caught red check" : "fixer rescue: could not close the verifier-caught red check");
            result = fix.fixed
              ? {
                  ...fix.verify,
                  summary: `${fix.verify.summary}; fixer rescue: ${laneFixerModel} closed a verifier-caught red check`,
                  detail: { ...((fix.verify.detail as Record<string, unknown> | undefined) ?? {}), fixerRescue: true, fixerModel: laneFixerModel, fixerTrigger: "verifier_fail", rescueVerificationResult: "pass" },
                }
              : { ...result, detail: { ...vd, fixerRescueAttempted: true, fixerModel: laneFixerModel, fixerTrigger: "verifier_fail", rescueVerificationResult: "fail" } };
            results[results.length - 1] = result;
          }
        }

        // Per-role cost: compute once after rescue (rescue verifier calls count against builder).
        const roleCost = runCost() - costBeforeRole;
        // Stamp into detail (open shape) so the CLI post-build breakdown can read it without
        // changing the WorkerResult contract. Also stamp the model on the builder role.
        // Stamp the builder's model UNCONDITIONALLY (not only when cost>0) — a free/local provider
        // reports roleCost 0, and an unstamped model made downstream paths (the recovery seed,
        // the cheap-retry attribution) fall back to the default instead of the model that actually ran.
        if (roleCost > 0 || role === "builder") {
          const prevDetail = (result.detail as Record<string, unknown> | undefined) ?? {};
          // The builder role records the AUTHORITATIVE attempt decision (IKBI-RT-001): the concrete
          // dispatched `model`, plus the requested `modelAlias`, the `modelSource` (why it was chosen),
          // and the `vendorLane` it was pinned to. `model` is exactly what builderForModel dispatched
          // and what runCost() billed above, so request == dispatch == bill == receipt.
          result = {
            ...result,
            detail: {
              ...prevDetail,
              ...(roleCost > 0 ? { costUsd: roleCost } : {}),
              ...(role === "builder"
                ? {
                    model: modelDecision.model,
                    modelAlias: modelDecision.alias,
                    modelSource: modelDecision.source,
                    ...(modelDecision.vendorLane !== undefined ? { vendorLane: modelDecision.vendorLane } : {}),
                  }
                : {}),
            },
          };
          results[results.length - 1] = result;
        }
        events.publish(
          workerRoleCompleted.create(
            { taskId: task.taskId, role, outcome: result.outcome, ...(roleCost > 0 ? { costUsd: roleCost } : {}) },
            { source: EVENT_SOURCE, attribution: { identity: spawned.identity, operation: `worker.role.${role}`, runId: task.taskId } },
          ),
        );

        // Attribute the builder's model ONLY to the builder role — scout/critic/verifier/refuter run
        // their OWN models, so recording the builder's model on their receipts is an audit lie.
        await recordRole(task, workspace, spawned, result, roleCost, role === "builder" ? modelDecision.model : undefined, true);

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
              const br = await runRoleFn("builder", fixBuilderFn, fixCtx);
              noteBuilderSignals(br); // injection/taint on a verifier-driven fix retry must reach the promote gate
              return br;
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
            withinBudget: !budgetExceeded(task),
            notAlreadyAttempted: !criticFixAttempted,
            verifierPassedForCriticGate,
            isRetryableCriticFail: isRetryableCriticFail(result),
          };
          const willFire = subConditions.criticFixLoopEnabled && subConditions.withinBudget && subConditions.notAlreadyAttempted && subConditions.verifierPassedForCriticGate && subConditions.isRetryableCriticFail;
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
        // BUDGET GUARD (critic-fix is ON by default): the loop spends another builder+verifier+critic
        // round, so don't even START it once the whole-build wall-clock deadline is blown — the run is
        // already condemned to halt. (The per-call dollar budget independently hard-stops runaway spend.)
        if (role === "critic" && config.criticFixLoop && !budgetExceeded(task) && !criticFixAttempted && verifierPassedForCriticGate && isRetryableCriticFail(result)) {
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
              const br = await runRoleFn("builder", builderFor(parentCtx, resolveBuilderMode(task)), fixCtx);
              noteBuilderSignals(br); // injection/taint on a critic-fix retry must reach the promote gate
              return br;
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
          // Escalate within the attempt's vendor lane (IKBI-RT-002). An operator --fallback-model wins ONLY
          // when it is in-lane (laneFallbackModel); a cross-lane fallback is deferred to the peer attempt.
          const midModel = laneFallbackModel ?? laneModelsFor(escalationConfig.tierModels.mid)[0];
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
            const failedModel = typeof failedDetail.model === "string" ? failedDetail.model : modelDecision.model;
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
        // GUARANTEED flash→pro (IKBI_ESCALATION_ALWAYS_ESCALATE, default on): on the cheap/default
        // path, a builder that FAILED or STALLED always escalates to the mid (pro) tier — bypassing
        // the worker→mid SCORE threshold, which is a boundary coin-flip (builderFailed weight == the
        // threshold, so whether it fires depends on score arithmetic rather than "did the cheap model
        // finish?"). Fail-closed: off when escalation is disabled or a tier was explicitly pinned
        // (--tier mid|frontier sets escalationDisabled). Still bounded by !escalationAttempted (once),
        // maxEscalations, and the per-build budget cap. When enabled + role builder, escObservation
        // always returns a defined `decision` (see the guard at its top), so the block body is safe.
        const alwaysEscalateToPro =
          escalationConfig.enabled &&
          escalationConfig.alwaysEscalate &&
          task.escalationDisabled !== true;
        if (
          role === "builder" &&
          (result.outcome === "failure" || escSignals.builderFailed) &&
          checksUnverifiable === undefined &&
          !escalationAttempted &&
          (alwaysEscalateToPro ||
            (decision !== undefined && decision.escalate && decision.targetTier === "mid"))
        ) {
          if (alwaysEscalateToPro && !(decision?.escalate && decision.targetTier === "mid")) {
            log.info(
              { taskId: task.taskId, failedRole: role, stopReason: (result.detail as Record<string, unknown> | undefined)?.stopReason },
              "guaranteed flash→pro escalation: builder failed/stalled — escalating to the mid (pro) tier regardless of the escalation score (IKBI_ESCALATION_ALWAYS_ESCALATE)",
            );
          }
          // Escalate within the attempt's vendor lane (IKBI-RT-002). An operator --fallback-model wins ONLY
          // when it is in-lane (laneFallbackModel); a cross-lane fallback is deferred to the peer attempt.
          const midModel = laneFallbackModel ?? laneModelsFor(escalationConfig.tierModels.mid)[0];
          if (midModel !== undefined) {
            const failedResult = result;
            const failedDetail = (failedResult.detail ?? {}) as Record<string, unknown>;
            const failedModel = typeof failedDetail.model === "string" ? failedDetail.model : modelDecision.model;
            // CONTEXT-OVERFLOW: the builder's prompt exceeded the current model's window. Re-running the
            // SAME small window with an even LONGER prompt (goal + failure feedback) is guaranteed to
            // overflow again, so SKIP the cheap same-model retry and go straight to the pool sweep, which
            // escalates up the ladder to a larger-window model. Turns a permanent overflow-fail into recovery.
            const failedOnOverflow = failedDetail.stopReason === "context_overflow";
            if (failedOnOverflow && !cheapModelRetryAttempted) {
              cheapModelRetryAttempted = true; // consume the cheap-retry slot without spending a doomed call
              events.publish(
                workerEscalationRetried.create(
                  { taskId: task.taskId, fromModel: failedModel, toModel: `${failedModel} (cheap retry skipped — context overflow)`, success: false },
                  { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.cheap_retry", runId: task.taskId } },
                ),
              );
            }

            // ── STEP 1: CHEAP RETRY — same model, with failure feedback ──────
            // Before escalating to the mid-tier model, give the cheap model ONE more chance
            // with the failure context. This implements: flash → flash retry → pro.
            // Fires on ANY builder struggle: explicit failure OR silent success with 0 files.
            // Skipped for a context-overflow (handled just above — a bigger window is what's needed).
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
              // Retry on the EXACT model that actually failed — `failedModel` is the stamped model of
              // the failed builder (it reflects any pre-flight/--complexity/rental bump), and it is ALSO
              // the model stamped onto this retry's result below, so dispatch == receipt for the retry
              // (IKBI-RT-001). Passing `undefined` would drop a bumped builder back to the weaker default,
              // so a "same-model retry" would silently retry a WEAKER model than the one that failed.
              const cheapRetryBuilder = builderForModel(parentCtx, failedModel, resolveBuilderMode(task));
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
            // Sweep the pool WITHIN the attempt's vendor lane (IKBI-RT-002): a lane-pinned peer never
            // crosses into the other vendor's models on a retry. `laneModelsFor` is a no-op (full roster)
            // for an unpinned attempt, so the default recovery ladder is unchanged.
            const recoveryRosters = {
              worker: rosterFromIds(laneModelsFor(escalationConfig.tierModels.worker)),
              mid: rosterFromIds(laneModelsFor(escalationConfig.tierModels.mid)),
              frontier: rosterFromIds(laneModelsFor(escalationConfig.tierModels.frontier)),
            };
            const seedTier =
              (["worker", "mid", "frontier"] as const).find((t) => escalationConfig.tierModels[t].includes(failedModel)) ?? "worker";
            // A CONTEXT-OVERFLOW needs a bigger WINDOW, not a cheaper same-tier model — start the sweep
            // at the mid tier so it skips the small-window worker pool (which would just overflow again).
            // recoveryFloor takes max(attempt tiers, startTier), so the accurate worker seed below is not
            // dragged down; the mid start simply raises the floor to bigger-window models.
            const sweepStartTier = failedOnOverflow && seedTier === "worker" ? "mid" : seedTier;
            const recAttempts: RecoveryAttempt[] = [{ tier: seedTier, model: failedModel, outcome: "fail" }];
            // `decision` is defined whenever we reach here (escObservation returns a decision for a
            // builder role when escalation is enabled + not tier-pinned — the always-escalate
            // preconditions). The `?.` keeps the compiler happy for the score-independent path.
            const handoff = decision?.handoffContext;
            let recovered = false;
            let lastSwapModel = failedModel;

            for (;;) {
              const action = decideRecovery({
                attempts: recAttempts,
                tierRosters: recoveryRosters,
                autoCeiling: "mid",
                // Frontier (consult) crossing is authorized only by --escalate / a frontier budget.
                frontierAuthorized: task.allowFrontierConsult === true,
                startTier: sweepStartTier,
                // An operator's --fallback-model is honored as the FIRST pick (still up the ladder), but
                // ONLY when it is in this attempt's vendor lane (laneFallbackModel) — a cross-lane fallback
                // would break lane purity, so the pool sweep stays in-lane and the operator's other-lane
                // choice lands in the peer attempt. Once tried, the sweep continues cheapest-first.
                ...(laneFallbackModel !== undefined ? { requestedModel: laneFallbackModel } : {}),
              });
              if (action.kind === "terminate") {
                break; // exhausted | needs-authorization — original failure stands.
              }
              if (action.kind === "consult") {
                // FRONTIER STEP (authorized): ONE bounded consult patch, applied in the worktree; the
                // pipeline verifier (below) gates it like any build. Opus advises via a diff — no tool loop.
                const triedSummary = recAttempts.map((a) => ({ role: "builder", summary: `${a.tier}/${a.model}`, outcome: a.outcome === "green" ? "verified green" : "failed" }));
                let applyRes: ApplyConsultPatchResult;
                try {
                  applyRes = await (deps.applyConsultPatch ?? applyConsultPatch)({
                    workspacePath: workspace.path,
                    request: {
                      question: `Cheaper models exhausted the worker+mid pool on this task. Provide the minimal fix as a unified diff.`,
                      identity: parentIdentity,
                      goal: task.goal,
                      ...(handoff?.verificationDetails !== undefined ? { failingChecks: handoff.verificationDetails } : {}),
                      triedAndFailed: triedSummary,
                    },
                  });
                } catch (e) {
                  applyRes = { applied: false, filesChanged: [], error: e instanceof Error ? e.message : String(e) };
                }
                // Gap B / A2: the frontier consult uses the RAW provider, NOT the run's costing engine.
                // Its spend must be (a) reflected in this receipt's costUsd, (b) folded into the run total
                // for `ikbi cost` + the budget cap, and (c) recorded on the receipt EVEN IF folding it
                // trips the cap. So compute the cost, write the receipt with the consult-inclusive total
                // FIRST, THEN fold+enforce — the BUDGET_EXHAUSTED throw (A2) can no longer skip this
                // receipt, and the spend is still counted in the terminal summary the abort writes.
                const consultUsd = applyRes.consult?.cost?.usd ?? 0;
                const consultModelId = applyRes.modelId ?? "frontier:consult";
                lastSwapModel = consultModelId;
                events.publish(
                  workerEscalationRetried.create(
                    { taskId: task.taskId, fromModel: failedModel, toModel: consultModelId, success: applyRes.applied },
                    { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.escalation.consult", runId: task.taskId } },
                  ),
                );
                await receipts.append(
                  {
                    operation: "worker.escalation.consult",
                    outcome: { status: applyRes.applied ? "success" : "failure", ...(applyRes.error !== undefined ? { detail: applyRes.error } : {}) },
                    requestId: task.taskId,
                    metadata: { taskId: task.taskId, workspaceId: workspace.id, model: consultModelId, applied: applyRes.applied, filesChanged: applyRes.filesChanged.length, ...(applyRes.stopReason !== undefined ? { stopReason: applyRes.stopReason } : {}), costUsd: runCost() + consultUsd },
                    project: task.targetRepo,
                  },
                  parentIdentity,
                );
                if (consultUsd > 0) addRunCost(consultUsd); // fold + enforce the cap AFTER the receipt is durable (may throw BUDGET_EXHAUSTED)
                recAttempts.push({ tier: "frontier", model: consultModelId, outcome: applyRes.applied ? "green" : "fail" });
                if (applyRes.applied) {
                  // Splice a success builder result so the pipeline verifier validates the applied diff.
                  const synth: RoleResult = {
                    role: "builder",
                    outcome: "success",
                    summary: `frontier consult patch applied by ${consultModelId} (${applyRes.filesChanged.length} file(s))`,
                    // policyViolations: [] is TRUTHFUL — the consult path is a diff apply (applyConsultPatch),
                    // not a builder tool loop, so no tool-call policy could be violated. Without it the
                    // integrator's fail-closed policy gate reads `undefined` ("cannot confirm clean") and
                    // discards every authorized frontier recovery — making the feature structurally unreachable.
                    detail: { model: consultModelId, escalated: true, consult: true, filesWritten: [...applyRes.filesChanged], policyViolations: [] },
                  };
                  const builderIdx = results.lastIndexOf(failedResult);
                  if (builderIdx >= 0) results[builderIdx] = synth;
                  result = synth;
                  recovered = true;
                  break;
                }
                continue; // frontier attempt recorded; decideRecovery now terminates exhausted
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

        // TERMINAL ADJUDICATION (Adjudication Core): `result` here is the FINAL builder result — INCLUDING
        // work produced by ESCALATION (the pro tier), which the per-attempt rescue above (it runs BEFORE
        // escalation) never sees. If that final tree has work on a verifiable target, adjudicate it once
        // more: run the verifier on the FINAL disk state and rescue on GREEN. THIS is what closes the
        // false-RED that the per-attempt rescue alone could not — a stalled builder OR a stalled ESCALATED
        // builder that left correct green work is no longer discarded unseen. Fail-closed: a red verifier
        // leaves the failure to short-circuit below; killed runs never reach here (kill short-circuits).
        const adjudicable = role === "builder" && result.outcome !== "success";
        const adjUnverifiable = adjudicable ? classifyUnverifiableTarget() !== undefined : false;
        if (adjudicable && !adjUnverifiable) {
          const runRescueVerifier = makeRescueVerifier(spawned);
          const detectWork = async (): Promise<{ nonEmpty: boolean }> => {
            const wp = await computeWorktreeWorkProduct(workspace.path, workspace.baseRef, task.taskId);
            return { nonEmpty: wp.nonEmpty };
          };
          // Always apply the rescue result: on GREEN it is the rescued success; on RED it is the
          // original failure with the rescue stamps (autoVerifyRescueAttempted / rescueVerificationResult)
          // for observability. Either way it never turns a success into a failure.
          const rescue = await maybeAutoVerifyRescueBuilderResult(result, runRescueVerifier, makeRunFixer(runRescueVerifier, "builder_stop"), detectWork);
          result = rescue.result;
          results[results.length - 1] = result;
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
        await writeTerminalCostSummary("rejected", costToReport, budgetErr.message); // Gap A: budget-abort spend is counted
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
      await writeTerminalCostSummary("failure", runCost(), `infrastructure failure: ${reason}`); // Gap A: spend-so-far is counted even on a throw
      throw err;
    }

    // UNVERIFIABLE TARGET (authoritative, post-loop): if the run did not succeed, classify the
    // worktree's verifiability NOW — while the workspace still exists on disk (the promote/discard
    // terminals below may remove it, and resolveChecks reads the filesystem). Covers failure paths
    // that did not pass through the builder escalation gate (e.g. a non-builder failure). Only when
    // overall is non-success: a successful build is verifiable by definition. `??=` preserves any
    // classification the escalation-suppression block already made.
    if (overall !== "success") checksUnverifiable ??= classifyUnverifiableTarget();

    // ── ADJUDICATION CORE — the centralized promotability decision ───────────────────────────────
    // Compute the single `decidePromotability` verdict from the four fact-types. Two modes, one
    // computation:
    //   • SHADOW (IKBI_ADJUDICATION_SHADOW, default on): log any divergence vs the old integrator gate;
    //     changes nothing. Validates the core against real builds.
    //   • AUTHORITATIVE (IKBI_LEGACY_COMPLETION=off, Step 4 flip): the verdict below REPLACES the
    //     integrator's promote intent at the terminal gate. DEFAULT IS LEGACY (flag on) — so with no
    //     env override this block is pure telemetry and the terminal path is byte-unchanged. The flip is
    //     rolled out by dogfood validation (its risk is more false-GREEN surface); flag-off enables it.
    // Wrapped so a computation failure never crashes the build; in authoritative mode an unavailable
    // verdict fails CLOSED at the terminal (no promote). `adjDecision`/`adjIntegratedTree` feed the gate.
    const adjudicationAuthoritative = (modeEnv.IKBI_LEGACY_COMPLETION ?? "on") === "off";
    const shadowEnabled = (modeEnv.IKBI_ADJUDICATION_SHADOW ?? "on") !== "off";
    let adjDecision: Decision | undefined;
    if (shadowEnabled || adjudicationAuthoritative) {
      try {
        const wp = await computeWorktreeWorkProduct(workspace.path, workspace.baseRef, task.taskId);
        const verifierResult = results.find((r) => r.role === "verifier");
        const rv = readVerifier(verifierResult);
        const rawVerdict = (verifierResult?.detail as Record<string, unknown> | undefined)?.verdict;
        const assessment: WorkAssessment = {
          verdict: (typeof rawVerdict === "string" ? rawVerdict : "fail") as Verdict,
          testEvidence: rv.testEvidence,
          treeHash: wp.treeHash, // the verifier judged this worktree; C1c re-checks the landed tree at promote
        };
        const criticDetail = (results.find((r) => r.role === "critic")?.detail ?? {}) as Record<string, unknown>;
        const refuterDetail = (results.find((r) => r.role === "refuter")?.detail ?? {}) as Record<string, unknown>;
        // SAFETY ASSESSMENT (Phase 8): a DERIVED projection of AUTHENTIC monotone vetoes — each `true`
        // is a concrete event OBSERVED by a named runtime component, never a manufactured affirmative
        // "safe" claim. The gate-wall is deliberately ABSENT: it is a DOWNSTREAM authority enforced by
        // `promoteCandidate()`, so this projection no longer fabricates `gateWallAuthorized: true`.
        // `effectiveBreach`/`driftBlocked` are NOT-DETERMINED-HERE monotone-veto slots (an effective
        // breach raises a separate alarm; a drift block rejects at entry) → false = "no such veto raised".
        const safety: SafetyAssessment = {
          externalInjection: externalInjectionDetectedThisBuild, // observed: neutralization chokepoint
          effectiveBreach: false, // not tracked by this projection (separate higher-severity alarm) — no veto raised
          refuted: refuterDetail.refuted === true, // observed: refuter role
          killed: killedReason !== undefined, // observed: kill-switch / budget
          driftBlocked: false, // a drift block rejects at ENTRY (before roles) — cannot reach this terminal
        };
        adjDecision = decidePromotability(wp, assessment, safety, { pass: criticDetail.pass === true });
        // TRUTHFUL PROVENANCE RECEIPT: record WHICH fields are authentic OBSERVATIONS vs NOT-DETERMINED
        // here, and the AUTHORITY — this assessment is advisory to the adjudication decision and NEVER a
        // promotion authorizer (the real gate-wall + stale-tree in promoteCandidate are authoritative).
        try {
          await receipts.append(
            {
              operation: "worker.safety_assessment",
              outcome: { status: "success", detail: `adjudication ${adjDecision.action} (${adjDecision.reason})` },
              requestId: task.taskId,
              metadata: {
                taskId: task.taskId, treeHash: wp.treeHash,
                authority: "advisory-to-adjudication; NOT a promotion authorizer (gate-wall + promoteCandidate are authoritative)",
                observedVetoes: { externalInjection: safety.externalInjection, refuted: safety.refuted, killed: safety.killed },
                notDeterminedHere: ["effectiveBreach", "driftBlocked", "gateWallAuthorized"],
                adjudicationAction: adjDecision.action, adjudicationReason: adjDecision.reason,
                mode: adjudicationAuthoritative ? "authoritative" : "shadow",
              },
              project: task.targetRepo,
            },
            parentIdentity,
          );
        } catch { /* provenance receipt failure must never break the build */ }

        if (shadowEnabled) {
          const oldIntent = readIntegratorDecision(results.find((r) => r.role === "integrator")).promote === true;
          const newPromote = adjDecision.action === "promote";
          if (oldIntent !== newPromote) {
            await receipts.append(
              { operation: "worker.decision.divergence", outcome: { status: "success" }, project: task.targetRepo, requestId: task.taskId,
                metadata: { taskId: task.taskId, oldPromote: oldIntent, newAction: adjDecision.action, newReason: adjDecision.reason, authoritative: adjudicationAuthoritative, verifierRan: verifierResult !== undefined, verdict: assessment.verdict, testEvidence: assessment.testEvidence, workNonEmpty: wp.nonEmpty, filesChanged: wp.diffStat.filesChanged } },
              parentIdentity,
            );
            log.warn({ taskId: task.taskId, oldPromote: oldIntent, newAction: adjDecision.action, newReason: adjDecision.reason }, "adjudication: promotability DIVERGENCE (old gate vs core)");
          }
          if (verifierResult === undefined && wp.nonEmpty && !oldIntent) {
            // The builder short-circuited (no verification) but left work on disk — the false-RED
            // candidate. The Adjudication Core would route this tree to the verifier instead of discarding
            // it unseen. Behavior is unchanged in shadow; this measures how often the false-RED path fires.
            await receipts.append(
              { operation: "worker.adjudication.unverified_work", outcome: { status: "success" }, project: task.targetRepo, requestId: task.taskId,
                metadata: { taskId: task.taskId, filesChanged: wp.diffStat.filesChanged, insertions: wp.diffStat.insertions, deletions: wp.diffStat.deletions, builderStopReason: String((results.find((r) => r.role === "builder")?.detail as Record<string, unknown> | undefined)?.stopReason ?? "unknown") } },
              parentIdentity,
            );
            log.warn({ taskId: task.taskId, filesChanged: wp.diffStat.filesChanged }, "adjudication: nonEmpty work discarded WITHOUT verification (false-RED candidate — the core would adjudicate it)");
          }
        }
      } catch (adjErr) {
        // A computation failure must NEVER crash the build. In SHADOW it's pure telemetry; in
        // AUTHORITATIVE mode `adjDecision` stays undefined ⇒ the terminal gate fails CLOSED (no promote).
        adjDecision = undefined;
        log.debug?.({ taskId: task.taskId, authoritative: adjudicationAuthoritative, err: adjErr instanceof Error ? adjErr.message : String(adjErr) }, "adjudication: fact computation skipped (non-fatal)");
      }
    }

    // STALE-TREE BINDING (Phase 3): snapshot the content tree the verifier certified, AFTER every role
    // + escalation + rescue has run and committed its work. The canonical promotion authority re-reads
    // the live tree immediately before promoting and refuses if it changed — the exact candidate that
    // was verified is the exact candidate that promotes. Captured via the injectable readTreeHash seam
    // (undefined for a non-git/in-memory test workspace ⇒ the authority skips the check, unchanged).
    const verifiedTree = await readTreeHash(workspace.path);
    const verifiedTargetHead = workspace.baseRef;

    // DURABLE SEMANTIC EVIDENCE (Phase 9, IKBI-RT-006): persist the FULL validated verdict for the final
    // critic result — whether the build promotes or is rejected — and reference its id from the promotion
    // receipt. Runs after all roles/rescue so it captures the post-fix critic. No-op when no critic ran.
    const normalSemanticEvaluationId = await emitSemanticEvidence(
      results.find((r) => r.role === "critic"),
      {
        taskId: task.taskId,
        attemptId: task.taskId,
        candidateId: task.taskId,
        ...(verifiedTree !== undefined ? { verifiedTree } : {}),
        strategy: task.moeVendorLane === "mimo" ? "duel-peer" : task.moeVendorLane === "deepseek" ? "duel-primary" : "normal",
        verificationPassed: results.find((r) => r.role === "verifier")?.outcome === "success",
        targetRepo: task.targetRepo,
      },
      parentIdentity,
    );

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
      await writeTerminalCostSummary("rejected", runCost(), `interrupted: ${killedReason}`); // Gap A: mid-run kill spend is counted
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: results, workspaceId: workspace.id, promoted: false, reason: killedReason, nonPromotion: { class: "interrupted", duelEligible: false } };
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
      // C-A4: this is a CLEAN non-promoting terminal (verified-good, tier lacks autoCommit) — write the
      // authoritative run-summary so `ikbi cost` groups by IT (not by summing the run's per-role/retry
      // receipts, which would double-count the cumulative-stamped ones). aborted:false — it did not abort.
      await writeTerminalCostSummary("partial", runCost(), reason ?? "verified-good; autoCommit tier gate", false);
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "partial", roles: results, workspaceId: workspace.id, promoted: false, reason, costUsd: runCost(), nonPromotion: { class: "governance-refused", duelEligible: false } };
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
      // C-A4: a step-planner step is a clean non-promoting terminal — write the authoritative run-summary
      // so its spend is grouped by IT, not double-counted by summing the step's per-role/retry receipts.
      await writeTerminalCostSummary(overall, runCost(), `step completed (skipPromote) with outcome "${overall}"`, false);
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: overall, roles: results, workspaceId: workspace.id, promoted: false, ...(overall !== "success" ? { reason: `step completed with outcome "${overall}"` } : {}), costUsd: runCost() };
    }

    // Terminal: ENACT the integrator's promote/discard DECISION (the integrator
    // decides; the orchestrator owns the lifecycle). Promote IFF the integrator
    // returned an affirmative, well-formed promote decision; anything else discards
    // (fail-closed). If a role hard-failed, the loop broke before the integrator ran,
    // so its result is absent → fail-closed discard. That composition is intentional.
    let decision = readIntegratorDecision(results.find((r) => r.role === "integrator"));
    // ── CX — ADJUDICATION CORE AUTHORITATIVE (IKBI_LEGACY_COMPLETION=off) ──────────────────────────
    // When the flip is enabled, `decidePromotability` (computed above) REPLACES the integrator's promote
    // intent: promote ⇒ promote, retain ⇒ withhold-but-keep the green work (never discard, invariant I1),
    // discard ⇒ discard. The downstream approval + gate-wall gates STILL run on a promote (defense in
    // depth). Fail-closed: if the verdict couldn't be computed, do NOT promote. DEFAULT (flag on /
    // legacy) leaves `decision` exactly as the integrator returned it — no change.
    // NOTE: C1c `verifiedAgainst` (the hash-bound promote in WorkspaceManager) is NOT yet threaded from
    // here, so the manager does not re-check the landed tree against what the verifier saw — a follow-up
    // (Fable C-2/C-4) before the default flip.
    let adjRetain = false;
    if (adjudicationAuthoritative) {
      if (adjDecision === undefined) {
        // H-3 (Fable, I1): facts unavailable ⇒ fail closed to NO-PROMOTE, but RETAIN the work (never
        // discard) — the core's contract for "cannot certify this tree" is retain(adjudication-incomplete),
        // and destroying possibly-good work on a transient fact-computation failure (e.g. a git timeout)
        // is the wrong fail-closed. The operator can inspect + discard deliberately.
        adjRetain = true;
        decision = { ...decision, promote: false, rationale: "adjudication core authoritative but the promotability verdict was unavailable — fail closed (no promote; work retained for inspection)" };
      } else if (adjDecision.action === "promote") {
        // QUARANTINE (Phase 3, IKBI-RT-005), preserved. The adjudication core's `promote` is only a
        // RECOMMENDATION over authentic vetoes (Phase 8 removed the manufactured `gateWallAuthorized:true`;
        // the `SafetyAssessment` no longer fabricates gate-wall authorization). It must NOT manufacture an
        // autonomous promote: it may CONFIRM a promote the integrator ALSO approved (which then still
        // passes through the canonical authority's real gate-wall + stale-tree binding), but when the
        // integrator did NOT approve it fails CLOSED and retains the work — the experimental path can never
        // override an integrator discard. The real gate-wall + promoteCandidate remain the sole authority.
        if (decision.promote === true) {
          decision = { ...decision, rationale: `adjudication core: promote — confirms the integrator (${adjDecision.reason})` };
        } else {
          adjRetain = true;
          decision = {
            ...decision,
            promote: false,
            rationale:
              "adjudication core recommended promote, but the integrator did not approve — QUARANTINED: the experimental IKBI_LEGACY_COMPLETION=off path cannot autonomously promote from synthesized safety evidence (no promote; work retained for inspection)",
          };
        }
      } else {
        adjRetain = adjDecision.action === "retain";
        decision = { ...decision, promote: false, rationale: `adjudication core: ${adjDecision.action} (${adjDecision.reason})` };
      }
    }
    // FAIL-CLOSED IN-RUN GATE (enforced on THIS build's promote, independent of the trust ladder):
    //  INJECTION: the neutralization chokepoint blocked a tool result in some role this build — the
    //  "injection blocks promotion" defense, enforced HERE. The trust-ladder demotion only affects
    //  FUTURE builds and is off by default, so it cannot block the OFFENDING build. This is a genuine
    //  gate failure (not an operator/governance decision) → trust is NOT suppressed.
    if (decision.promote && externalInjectionDetectedThisBuild) {
      decision = { ...decision, promote: false, rationale: "discard: prompt-injection from OUTSIDE content (web/vision/delegate/…) detected by the neutralization chokepoint during this build (fail-closed — the injected build must not promote)" };
    } else if (decision.promote && injectionDetectedThisBuild) {
      // Injection was detected but only in the build's OWN worktree output (neutralized-and-inert —
      // e.g. ikbi's own injection-test fixtures when self-hosting). The model never acted on it, and
      // planting it needs repo-write (outside the injection threat model). Judge by effect: record +
      // proceed, mirroring the policy-taint gate below. External-origin injection still discards above.
      log.warn(
        { taskId: task.taskId, workspaceId: workspace.id },
        "promote proceeds despite injection NEUTRALIZED in the build's own worktree output — recorded for audit, not a discard (judge by effect; external-origin injection would still block)",
      );
    } else if (decision.promote && policyTaintedThisBuild) {
      // JUDGE BY EFFECT, NOT INTENT. A policy violation in ikbi is a PREVENTED (rejected) tool call —
      // the governor/sandbox blocked it, so it had NO effect, and the verifier passed on the real
      // worktree. A prevented attempt is evidence the governor WORKED, not that the build is bad. It is
      // recorded as a warning + learning signal (the builder receipt / detail.policyViolations carry it,
      // and self-heal can adapt the prompt/context), and it feeds a small trust delta — but it does NOT
      // discard a verified-green build. Only an EFFECTIVE breach (a control FAILURE that actually landed
      // — sandbox escape, egress leak, out-of-workspace write, receipt tampering) discards, and those
      // surface as separate higher-severity alarms, not as rejected tool calls. Cheap models improvise
      // blocked commands routinely; discarding green work over a prevented attempt measures obedience,
      // not engineering, and would collapse the autonomous success rate for reasons unrelated to code.
      log.warn(
        { taskId: task.taskId, workspaceId: workspace.id },
        "promote proceeds despite a PREVENTED (blocked) out-of-policy attempt — recorded as a learning signal, not a discard (judge by effect, not intent)",
      );
    }
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
          // CANONICAL PROMOTION (Phase 3): submit the candidate + its candidate-bound evidence to the
          // single promotion authority — the normal path no longer calls workspaces.promote directly.
          const builderDetail = (results.find((r) => r.role === "builder")?.detail ?? {}) as Record<string, unknown>;
          const normalVerifier = results.find((r) => r.role === "verifier");
          const normalTreeIdentityRequired = await isGitBacked(workspace.path);
          const candidate: PromotionCandidate = {
            taskId: task.taskId,
            attemptId: task.taskId,
            strategy: task.moeVendorLane === "mimo" ? "duel-peer" : task.moeVendorLane === "deepseek" ? "duel-primary" : "normal",
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            ...(typeof builderDetail.model === "string" ? { model: builderDetail.model } : {}),
            ...(task.moeVendorLane !== undefined ? { vendorLane: task.moeVendorLane } : {}),
            ...(verifiedTree !== undefined ? { verifiedTree } : {}),
            targetHead: verifiedTargetHead,
            treeIdentityRequired: normalTreeIdentityRequired,
          };
          const evidence: CandidateEvidence = {
            verificationPassed: normalVerifier?.outcome === "success",
            ...(actualVerificationMode !== undefined ? { verificationMode: actualVerificationMode } : {}),
            testEvidence: readVerifier(normalVerifier).testEvidence,
            noTestsAcceptable: noTestsPolicyEnabled(task),
            semanticKind: classifySemanticVerdict(results.find((r) => r.role === "critic")),
            ...(normalSemanticEvaluationId !== undefined ? { semanticEvaluationId: normalSemanticEvaluationId } : {}),
            policyPromote: true, // the integrator (or authoritative adjudication) already decided promote
            governance,
            evaluation: decision.evaluation, // sourced from the integrator, NOT hardcoded
            message: `worker-model: ${task.goal}${decision.rationale !== undefined ? ` — ${decision.rationale}` : ""}${verificationScope !== undefined ? ` [verification: ${verificationScope}]` : ""}`,
            ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
          };
          const canon = await promoteCandidate(workspace, candidate, evidence, parentIdentity);
          promoted = canon.promote.promoted;
          if (!promoted) {
            if (canon.staleTree === true) {
              // Post-verify mutation: the promoted tree would not be the verified tree. Fail CLOSED —
              // discard the unverified work, reject, and suppress trust (an integrity/timing issue, not
              // a worker quality failure).
              await workspaces.discard(workspace);
              overall = "rejected";
              reason = canon.blockedReason;
              trustSuppressed = true;
              trustSuppressReason = "stale-tree: candidate mutated since verification (not a worker quality failure)";
            } else if (canon.semanticWithheld === true) {
              // The integrator approved but the canonical semantic verdict is not a pass (e.g. a
              // contradictory PASS-with-defects → indeterminate). Fail CLOSED — retain for inspection,
              // reject, suppress trust (a semantic-evaluation gap, not a proven worker quality failure).
              await safeRetain(workspaces, workspace, canon.blockedReason ?? "semantic policy withheld promotion");
              overall = "rejected";
              reason = canon.blockedReason;
              trustSuppressed = true;
              trustSuppressReason = "semantic policy withheld promotion (non-pass verdict)";
            } else {
              // Conflict: the workspace is reconcilable — downgrade to partial, do NOT discard.
              overall = "partial";
              reason = canon.promote.reason ?? "promote did not land (conflict)";
            }
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
      // CX (I1): when the adjudication core withheld GREEN work (action=retain — governance/critic/
      // safety-forensics), KEEP it (never discard green work), even though `overall` is "success".
      if (adjRetain || (retainFailedWorkspaces && overall !== "success")) {
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
    // NON-PROMOTION CLASSIFICATION (Phase 2): why this attempt did not promote, so the duel scheduler
    // launches a peer vendor lane ONLY for a real candidate the pipeline judged not-promotable. A
    // governance refusal, an unverifiable target, an injection block, or an unlandable conflict are
    // failures a different vendor cannot fix — the peer must not run. Order matters: the most specific
    // structural/security/governance classes win over the generic "candidate-rejected".
    // Phase 4: an INDETERMINATE or INFRASTRUCTURE critic verdict is NOT a candidate rejection — the
    // critic could not render a concrete judgment, so a peer vendor lane cannot fix it (a duel would
    // waste the peer's cost). Only a concrete quality rejection (fail/incomplete, or a builder/verifier
    // failure where the critic gave no blocking verdict) stays duel-eligible.
    const criticSemantic = classifySemanticVerdict(results.find((r) => r.role === "critic"));
    const semanticNonDuel = criticSemantic === "indeterminate" || criticSemantic === "infrastructure-failure";
    const nonPromotion: WorkerResult["nonPromotion"] = promoted
      ? undefined
      : checksUnverifiable !== undefined
        ? { class: "unverifiable", duelEligible: false }
        : externalInjectionDetectedThisBuild
          ? { class: "injection-blocked", duelEligible: false }
          : trustSuppressed
            ? { class: "governance-refused", duelEligible: false }
            : overall === "partial"
              ? { class: "candidate-conflict", duelEligible: false }
              : semanticNonDuel
                ? { class: "semantic-indeterminate", duelEligible: false }
                : { class: "candidate-rejected", duelEligible: true };
    const result: WorkerResult = {
      contractVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      outcome: overall,
      roles: results,
      workspaceId: workspace.id,
      promoted,
      ...(nonPromotion !== undefined ? { nonPromotion } : {}),
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
    // PASSIVE RISK TELEMETRY: record this build's PREVENTED policy attempts (count + command shapes)
    // on the run summary EVERY build writes. Prevented attempts no longer discard (effect-based gate),
    // but recording them here means risk evidence accrues on ordinary usage — no dedicated (paid)
    // observation campaign is ever needed to answer "which prevented behaviours are normal cheap-model
    // noise vs. patterns that predict bad outcomes?" before designing graduated trust scoring.
    const riskDetail = (results.find((r) => r.role === "builder")?.detail ?? {}) as Record<string, unknown>;
    // A2/D3: the off-books FIXER pass's prevented attempts (accumulated across the run). Merge them into
    // BOTH the notable and the fuller raw set so the passive risk telemetry is not blind to what a fixer
    // pass tried and the governor blocked — read the accumulator directly so a FAILED run that never
    // reached the integrator (no builder-result stamp) still records its fixer attempts as evidence.
    const fixerPrevented = fixerPreventedThisBuild;
    const notablePrevented = [...(Array.isArray(riskDetail.policyViolations) ? (riskDetail.policyViolations as Array<Record<string, unknown>>) : []), ...fixerPrevented];
    // For EVIDENCE, record the FULLER raw set (rejectedToolCalls — includes the benign-reclassified rm/mv/
    // probes filtered out of policyViolations) so the risk histogram is not blind to exactly the behaviours
    // the effect-based gate reclassified. `preventedCount` stays the NOTABLE count (what the threshold uses).
    const allPrevented = [...(Array.isArray(riskDetail.rejectedToolCalls) ? (riskDetail.rejectedToolCalls as Array<Record<string, unknown>>) : (Array.isArray(riskDetail.policyViolations) ? (riskDetail.policyViolations as Array<Record<string, unknown>>) : [])), ...fixerPrevented];
    const preventedCommands = allPrevented
      .map((v) => {
        const tool = typeof v.tool === "string" ? v.tool : "tool";
        const path = typeof v.path === "string" ? v.path : "";
        return path ? `${tool}:${path}` : tool;
      })
      .slice(0, 30);
    const integratorDetail = (results.find((r) => r.role === "integrator")?.detail ?? {}) as Record<string, unknown>;
    const requiresReview = integratorDetail.requiresReview === true;
    const highRiskCount = typeof integratorDetail.highRiskCount === "number" ? integratorDetail.highRiskCount : 0;
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
          // COST TRUTH (Phase 7, IKBI-RT-011): `costUsd` now INCLUDES routing overhead (the classifier).
          // `routingOverheadUsd` breaks it out as a distinct subtotal; `costStatus` is "partial" when any
          // accounted invocation's cost is unknown, so a total never falsely implies completeness.
          routingOverheadUsd,
          costStatus: costPartial ? "partial" : "complete",
          ...(classifierModelUsed !== undefined ? { classifierModel: classifierModelUsed, classifierDecisionSource, classifierCostStatus } : {}),
          verificationResult: verifierResult !== undefined ? verifierResult.outcome : "not_run",
          verificationMode: ranVerificationMode,
          retrievalMode: ranRetrievalMode,
          ...(allPrevented.length > 0 ? { preventedCount: notablePrevented.length, allPreventedCount: allPrevented.length, highRiskCount, preventedCommands, requiresReview } : {}),
          // BUILD-PATH DRIFT (step 3): the advisory drifted operations the governor surfaced (reportOnly/warn).
          ...(buildDriftReports.length > 0 ? { driftedOperations: buildDriftReports.map((r) => ({ operation: r.operation, recentRate: r.recentRate, baselineRate: r.baselineRate, severity: r.severity ?? "minor" })) } : {}),
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
    // RUNTIME-TRUTH (Phase 5): the tournament/competitive builder + winner critic reached via this
    // shared dispatcher also receive candidate-bound runtime evidence. The critic binds to the winner
    // workspace's verified tree so its semantic evaluation cannot receive another candidate's evidence.
    const dispatchRuntimeEvidence =
      role === "builder" || role === "critic"
        ? await requestRuntimeEvidence(task, role, workspace, spawned.identity, {
            attemptId: task.taskId,
            candidateId: workspace.id,
            needsVerifiedTree: role === "critic",
          })
        : [];
    const ctx: RoleContext = { task, role, identity: spawned.identity, autonomy: spawned.autonomy, workspace, priorResults: [...priorResults], engine, ...(dispatchRuntimeEvidence.length > 0 ? { runtimeEvidence: dispatchRuntimeEvidence } : {}) };
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
      // assert the same identity (Fix 6 invariant), so one capture suffices. ASSIGN the
      // outer binding (declared before the try) — a `const` here would SHADOW it, leaving the
      // catch-path's recordBuildTrust with `undefined` (no trust outcome, no audit receipt).
      compWorkerSpawned = scoutSpawn;

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
        // DEPENDENCY INSTALL (per candidate): each candidate has its OWN fresh worktree with no
        // node_modules. Without this, its builder's in-loop run_checks and the verifier both fail with
        // "command not found" / "Cannot find module" → every candidate is disqualified and competitive
        // mode systematically fails on any repo needing installs. Mirrors the single-run + tournament paths.
        await installWorkspaceDeps(ws, parentCtx, deps.dependencyInstall);
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
      const selectedRoles = rolesByWs.get(winner.id) ?? [];
      // Phase 4: the deterministic judge SELECTED this candidate, but ranking is NOT semantic
      // verification. Run the canonical critic on the winner so it reaches promotion with a REAL
      // semantic verdict (never `not-evaluated`); a concrete-defect fail then blocks the promote.
      const compCritic = await dispatchRole("critic", spawnRole("critic", parentCtx), task, winner, selectedRoles, parentCtx, runEngine, criticFor(), runCost);
      const winnerRoles = [...selectedRoles, compCritic];
      const compSemanticKind = classifySemanticVerdict(compCritic);

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
      // C-A1: fail-closed injection/policy-taint gate for the competitive winner (parity with single-run).
      const compTaint = winnerTaintReason(winnerRoles);
      if (compTaint !== undefined) {
        const retained = await retainCompetitiveFailure(compTaint, winner.id);
        events.publish(workerCompetitiveCompleted.create({ taskId: task.taskId, candidateCount: n, winnerWorkspaceId: winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        events.publish(workerFailed.create({ taskId: task.taskId, reason: retained.reason, workspaceId: retained.retained?.id ?? winner.id }, { source: EVENT_SOURCE, attribution: { identity: parentIdentity, operation: "worker.competitive", runId: task.taskId } }));
        await recordBuildTrust("rejected", compWorkerSpawned, task.taskId, task.targetRepo, false, compTaint); // NOT suppressed — a genuine gate failure
        return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "rejected", roles: winnerRoles, workspaceId: retained.retained?.id ?? winner.id, promoted: false, reason: retained.reason, costUsd: runCost() };
      }
      // CANONICAL PROMOTION (Phase 3 authority + Phase 4 semantic): the competitive winner is a
      // SELECTED, semantically-evaluated candidate — it does not promote itself. It enters the same
      // authority as every strategy (stale-tree + verifiedAgainst + canonical receipt + semantic gate).
      const compWinnerModel = (selectedRoles.find((r) => r.role === "builder")?.detail as Record<string, unknown> | undefined)?.model;
      const compVerifiedTree = await readTreeHash(winner.path);
      const compVerifier = selectedRoles.find((r) => r.role === "verifier");
      const compTreeIdentityRequired = await isGitBacked(winner.path);
      const compSemanticEvaluationId = await emitSemanticEvidence(
        compCritic,
        { taskId: task.taskId, attemptId: task.taskId, candidateId: winner.id, ...(compVerifiedTree !== undefined ? { verifiedTree: compVerifiedTree } : {}), strategy: "competitive", verificationPassed: compVerifier?.outcome === "success", targetRepo: task.targetRepo },
        parentIdentity,
      );
      const canon = await promoteCandidate(
        winner,
        {
          taskId: task.taskId, attemptId: task.taskId, strategy: "competitive", workspaceId: winner.id, workspacePath: winner.path,
          ...(typeof compWinnerModel === "string" ? { model: compWinnerModel } : {}),
          ...(compVerifiedTree !== undefined ? { verifiedTree: compVerifiedTree } : {}), targetHead: winner.baseRef,
          treeIdentityRequired: compTreeIdentityRequired,
        },
        {
          verificationPassed: compVerifier?.outcome === "success",
          testEvidence: readVerifier(compVerifier).testEvidence,
          noTestsAcceptable: noTestsPolicyEnabled(task),
          semanticKind: compSemanticKind,
          ...(compSemanticEvaluationId !== undefined ? { semanticEvaluationId: compSemanticEvaluationId } : {}),
          policyPromote: true, governance,
          evaluation: { approved: true, score: verdict.winner.composite, evaluatorId: "deterministic-judge" },
          message: `worker-model (competitive): ${task.goal}`,
        },
        parentIdentity,
      );
      const promote = canon.promote;
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

    const promote = async (t: WorkerTask, ws: WorkspaceHandle, roleResults: readonly RoleResult[], composite: number): Promise<{ promoted: boolean; reason?: string; conflicts?: readonly string[]; receiptStatus?: "recorded" | "failed" }> => {
      // H5 FAIL-CLOSED: a promote REQUIRES gate-wall authorization — no gate-wall ⇒ DENY.
      if (gateWall === undefined) return { promoted: false, reason: "gate-wall not wired — promote denied (fail-closed)" };
      const governanceGrant = autonomyForTier(asTier(parentIdentity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
      const governance: PromoteGovernance = await gateWall.evaluate({ grant: governanceGrant, action: { kind: "promote", task: t, results: [...roleResults] }, identity: parentIdentity });
      if (!governance.allow) return { promoted: false, reason: governance.reason ?? "gate-wall denied promotion" };
      // Phase 4: the clean-shadow replay is a SELECTED, reverified candidate — but tournament ranking is
      // NOT semantic verification. Run the canonical critic on the shadow so the winner reaches promotion
      // with a REAL semantic verdict (never `not-evaluated`); a concrete-defect fail blocks the promote.
      const tourCritic = await dispatchRole("critic", spawnRole("critic", parentCtx), t, ws, roleResults, parentCtx, runEngine, criticFor(), runCost);
      const shadowRoles = [...roleResults, tourCritic];
      // C-A1: fail-closed injection/policy-taint gate for the tournament winner (parity with single-run).
      const tourTaint = winnerTaintReason(shadowRoles);
      if (tourTaint !== undefined) return { promoted: false, reason: `discard: ${tourTaint}` };
      // CANONICAL PROMOTION (Phase 3 authority + Phase 4 semantic): enter the single promotion authority
      // like every strategy (stale-tree + verifiedAgainst + canonical receipt + semantic gate).
      const tourWinnerModel = (roleResults.find((r) => r.role === "builder")?.detail as Record<string, unknown> | undefined)?.model;
      const tourVerifiedTree = await readTreeHash(ws.path);
      const tourVerifier = roleResults.find((r) => r.role === "verifier");
      const tourTreeIdentityRequired = await isGitBacked(ws.path);
      const tourSemanticEvaluationId = await emitSemanticEvidence(
        tourCritic,
        { taskId: t.taskId, attemptId: t.taskId, candidateId: ws.id, ...(tourVerifiedTree !== undefined ? { verifiedTree: tourVerifiedTree } : {}), strategy: "tournament", verificationPassed: tourVerifier?.outcome === "success", targetRepo: t.targetRepo },
        parentIdentity,
      );
      const canon = await promoteCandidate(
        ws,
        {
          taskId: t.taskId, attemptId: t.taskId, strategy: "tournament", workspaceId: ws.id, workspacePath: ws.path,
          ...(typeof tourWinnerModel === "string" ? { model: tourWinnerModel } : {}),
          ...(tourVerifiedTree !== undefined ? { verifiedTree: tourVerifiedTree } : {}), targetHead: ws.baseRef,
          treeIdentityRequired: tourTreeIdentityRequired,
        },
        {
          verificationPassed: tourVerifier?.outcome === "success",
          testEvidence: readVerifier(tourVerifier).testEvidence,
          noTestsAcceptable: noTestsPolicyEnabled(t),
          semanticKind: classifySemanticVerdict(tourCritic),
          ...(tourSemanticEvaluationId !== undefined ? { semanticEvaluationId: tourSemanticEvaluationId } : {}),
          policyPromote: true, governance,
          evaluation: { approved: true, score: composite, evaluatorId: "deterministic-judge" },
          message: `worker-model (tournament): ${t.goal}`,
        },
        parentIdentity,
      );
      const result = canon.promote;
      if (result.promoted && result.receiptStatus === "failed") {
        log.warn({ workspaceId: ws.id, taskId: t.taskId, receiptStatus: result.receiptStatus }, "tournament promote landed but receipt append failed");
      }
      return {
        promoted: result.promoted,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}),
        ...(result.receiptStatus !== undefined ? { receiptStatus: result.receiptStatus } : {}),
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

/**
 * Whether a RED verifier result is a GENUINE, FIXABLE check failure worth handing to the last-mile
 * fixer (a leftover typecheck/test error the builder declared success on). Excludes cases a fixer
 * cannot or must not "repair around": injection (content hijack — a security signal, never fixed),
 * a skipped verifier (nothing ran), and checks_unresolvable (no meaningful verifier to satisfy). A
 * permissive positive (a failed typecheck or failed tests) is safe because the fixer + re-verify is
 * the real gate — a still-red re-verify simply leaves the original failure to discard.
 */
export function isFixableVerifierFailure(verifierResult: RoleResult): boolean {
  if (verifierResult.role !== "verifier" || verifierResult.outcome === "success") return false;
  const d = (verifierResult.detail ?? {}) as Record<string, unknown>;
  // Only EXTERNAL-origin injection (content hijack from outside) makes a failure unfixable — a
  // neutralized-and-inert own-worktree detection (self-hosting fixtures) must not block the fixer.
  if (d.externalInjectionDetected === true) return false;
  if (d.verdict === "skipped" || d.skipped === true) return false;
  if (d.verificationKind === "checks_unresolvable") return false;
  const v = readVerifier(verifierResult);
  return v.typecheckPass === false || v.testsPass === false;
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
