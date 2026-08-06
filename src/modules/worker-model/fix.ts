/**
 * ikbi worker-model — THE FIX PIPELINE (docs/FIX-MODE-DESIGN.md).
 *
 *   build = "Create or change something to satisfy a goal."
 *   fix   = "A check failed. Diagnose why. Repair narrowly. Do not cheat."
 *
 * fix mode is ADDITIVE to build mode — it does not touch the 5-role build pipeline. It runs a
 * 12-stage, DIAGNOSIS-FIRST pipeline: stages 1-4 are READ-ONLY (snapshot → reproduce → parse →
 * classify); stage 4 GATES everything (a non-fixable category jumps straight to RESULT as a
 * first-class CORRECT_REFUSAL / TOOL_LIMITATION, with no edits). Only stages 7+ mutate files,
 * and only after an explicit, recorded diagnosis. Anti-cheat runs on EVERY attempt — even a
 * refusal (with no changes, it trivially passes). The receipt records every stage: if it is
 * not in the receipt, it did not happen.
 *
 * NEVER promotes: this slice hardcodes `promoted: false`. Promotion requires explicit human
 * approval (a future flag), by design (§6 `require_approval: true`).
 *
 * The pipeline is fully INJECTABLE (deps pattern, like the builder): the model seam
 * (`invokeModel`, the SAME provider build mode uses) and the check runner (`runCheck`) are
 * supplied by the caller, so the whole pipeline is testable without a live model or a real
 * subprocess.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { neutralizeUntrusted, toUntrustedMessage } from "../../core/injection/index.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/contract.js";
import type { AgentIdentity, ModelMessage, ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { resolveChecks } from "./checks.js";
import { parseCheckOutput } from "../check-triage/index.js";
import { confinePath } from "./builder-tools/confine.js";
import { antiCheatCheck, isTestFile, type FileChange } from "./fix-anti-cheat.js";
import { diagnoseFailure, type Diagnosis, type DiagnosisFile } from "./fix-diagnosis.js";
import { FixReceiptBuilder, type FixReceipt, type FixResult, type ParsedOutcomes } from "./fix-receipt.js";
import { applyFilePatch, extractDiff, parseUnifiedDiff } from "./patchsmith.js";
import { builderModel } from "./role-models.js";
import { escalationConfig } from "../escalation/config.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { MutationActor, MutationCause, MutationSessionBinding, WorkspaceMutationSession, BoundMutationResult } from "../../core/workspace/index.js";
import { applyRepairPlan, createRepairPlan, repairFailure, restoreRepairMutations, type RepairMutationFailure } from "../../core/workspace/repair-plan.js";
import { createRepairSession, standaloneRepairBinding, standaloneRepairWorkspace } from "./repair-runtime.js";

/** A check command fix mode runs to reproduce/verify (e.g. `pytest -q`). */
export interface FixCheckCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Result of running a check: its exit code + combined output. */
export interface CheckRun {
  readonly exitCode: number;
  readonly output: string;
}

/** The LAST-RESORT check when project-type detection fails (no recognizable manifest). */
export const DEFAULT_FIX_CHECK: FixCheckCommand = { command: "python3", args: ["-m", "pytest", "-q"] };

/**
 * Resolve the default reproduce/verify check for a repo by DETECTING its project type — the same
 * detection the verifier and `audit` use (`resolveChecks`: Node→pnpm/npm/yarn test, Rust→cargo test,
 * Go→go test, Python→pytest, Godot→godot --headless). A Node.js repo no longer defaults to pytest
 * (the M1 bug). Picks the suite check (the one named "test", else the last resolved check — typecheck
 * comes first), and honors an operator-set `IKBI_CHECKS`. Falls back to pytest (DEFAULT_FIX_CHECK)
 * ONLY when no project type can be detected, preserving the original thin-slice behavior.
 */
export function defaultFixCheckFor(repo: string, env: NodeJS.ProcessEnv = process.env): FixCheckCommand {
  let root = repo;
  try {
    root = realpathSync(repo);
  } catch {
    /* unresolvable path — resolveChecks will fail closed and we fall back below */
  }
  const resolution = resolveChecks(root, env);
  if (!resolution.ok || resolution.checks.length === 0) return DEFAULT_FIX_CHECK;
  const test = resolution.checks.find((c) => c.name === "test") ?? resolution.checks[resolution.checks.length - 1]!;
  return { command: test.command, args: [...test.args] };
}

const PATCH_TEMPERATURE = 0;
const PATCH_MAX_TOKENS = 4_096;
const MAX_FILE_BYTES = 24_000;
/** How many patch+verify attempts the fix-retry loop makes before giving up (Gap M6). */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * The default per-attempt patch model roster (dual-model escalation, Gap M6): the cheap worker
 * model carries the early attempts, escalating to the mid tier on the LAST attempt. The cheap
 * builder diagnoses well but can stall on a fix; spending a stronger model only on the final retry
 * (after the cheap model has already tried twice) recovers the hard cases without paying the mid
 * tier on every fix. The worker fallback is `base` (the configured builder), and the escalation
 * target is the first entry of `IKBI_ESCALATION_MID_MODELS` (falling back to `base` when unset).
 */
export function defaultEscalationModels(base: string): readonly string[] {
  const mid = escalationConfig.tierModels.mid[0] ?? base;
  return [base, base, mid];
}
const DEFAULT_IDENTITY: AgentIdentity = { agentId: "fix", functionalRole: "fix" };

/** Config files a fix may not touch without `--allow-config-edits` (alters test discovery). */
const CONFIG_FILE_RE = /(^|\/)(pyproject\.toml|setup\.cfg|setup\.py|pytest\.ini|tox\.ini|conftest\.py|package\.json|tsconfig[^/]*\.json|jest\.config\.[cm]?js|vitest\.config\.[cm]?[jt]s|\.coveragerc)$/;

export interface FixOptions {
  /** Absolute path to the target repo. */
  readonly repo: string;
  /** The failing check to reproduce + verify. Default: `pytest -q`. */
  readonly check?: FixCheckCommand;
  /** Allow editing test files (default false — tests are ground truth). */
  readonly allowTestEdits?: boolean;
  /** Allow editing config files that alter test discovery (default false). */
  readonly allowConfigEdits?: boolean;
  /** Hard cap on files the fix may modify (default 5). */
  readonly maxFiles?: number;
  /** Stages 1-4 only (diagnose, no edits). Default false. */
  readonly diagnoseOnly?: boolean;
  /** Optional free-form context handed to diagnosis (e.g. an operator note). */
  readonly goal?: string;
  /**
   * Per-attempt patch model ids (dual-model escalation, Gap M6). Index `i` is the model used on
   * attempt `i+1`; attempts beyond the list reuse the last entry. Default: cheap worker model for
   * the first attempts, escalating to the mid tier on the final attempt (see
   * `defaultEscalationModels`). e.g. ["deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-pro"].
   */
  readonly escalationModels?: readonly string[];
  /** Managed candidate workspace identity, when fix runs inside a worker candidate. */
  readonly mutationWorkspace?: WorkspaceHandle;
  /** Source-generation binding for the repair attempt. */
  readonly mutationBinding?: MutationSessionBinding;
  /** Cause for standalone repair calls; orchestrated model repairs supply this in mutationBinding. */
  readonly mutationActor?: MutationActor;
  readonly mutationCause?: MutationCause;
}

export interface FixDeps {
  /** Run a check in the repo (gate-wall/governed in production; a fake in tests). REQUIRED. */
  readonly runCheck: (repo: string, check: FixCheckCommand) => Promise<CheckRun>;
  /**
   * Cooperative kill-check (default: never cancelled). Polled at the pipeline's check
   * boundaries — before reproduce, before diagnosis, and before each patch attempt — so an
   * operator cancellation stops the run promptly without leaving a half-applied patch on disk.
   */
  readonly isCancelled?: () => boolean;
  /** The model seam — the SAME `invokeModel` build mode uses. Default: the live provider (lazy). */
  readonly invokeModel?: (request: ModelRequest) => Promise<ModelResponse>;
  /** #8 neutralization seam. Default: the core chokepoint. */
  readonly neutralize?: (content: string, context: UntrustedContext) => NeutralizedContent;
  /** Resolve the repo HEAD sha for the snapshot. Default: `git rev-parse HEAD`. */
  readonly head?: (repo: string) => string;
  /** Wall-clock for receipt timestamps. Default: ISO now. */
  readonly now?: () => string;
  /** Gather candidate code+test files for diagnosis. Default: a bounded repo scan. */
  readonly candidateFiles?: (repo: string) => DiagnosisFile[];
  /** Model id. Default: the configured builder model. */
  readonly modelId?: string;
  /** Identity for model calls. Default: a fix-role identity. */
  readonly identity?: AgentIdentity;
  /**
   * H4/Gap C: receipt sink for the ONE fix cost-summary receipt (so `ikbi fix` spend is visible to
   * `ikbi cost`). Default: the live receipt store (lazy). Pass a fake / omit in tests to capture or skip.
   */
  readonly receipts?: { append: (input: unknown, identity: AgentIdentity) => Promise<unknown> };
}

export interface FixOutcome {
  readonly result: FixResult;
  readonly receipt: FixReceipt;
  /** ALWAYS false in this slice — promote requires explicit approval. */
  readonly promoted: boolean;
  readonly filesModified: readonly string[];
  readonly diagnosis: Diagnosis;
  readonly repairError?: RepairMutationFailure;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Stringify a check command for the receipt. */
function checkLabel(c: FixCheckCommand): string {
  return `${c.command} ${c.args.join(" ")}`.trim();
}

/** Detect a COLLECTION / tool crash (import/syntax/internal error) — distinct from an assertion failure. */
export function detectCollectionError(output: string): boolean {
  if (/errors during collection|ERROR collecting|INTERNALERROR|=+\s*ERRORS\s*=+/i.test(output)) return true;
  if (/\bE\s+(ImportError|ModuleNotFoundError|SyntaxError|IndentationError|TabError)\b/.test(output)) return true;
  return false;
}

/** Parse a check run into structured outcomes (deterministic — uses the check-triage parser). */
export function parseOutcomes(check: FixCheckCommand, run: CheckRun): ParsedOutcomes {
  const triage = parseCheckOutput({ name: "test", command: checkLabel(check), exitCode: run.exitCode, stdout: run.output });
  const framework = triage.detectedFrameworks[0];
  return {
    passed: triage.passed,
    failingTests: triage.failures,
    collectionError: detectCollectionError(run.output),
    summary: triage.errorSummary,
    ...(framework !== undefined ? { framework } : {}),
  };
}

/** Default candidate-file scan: bounded recursive walk for code+test sources. */
function defaultCandidateFiles(repo: string): DiagnosisFile[] {
  const exts = [".py", ".js", ".ts", ".jsx", ".tsx"];
  const skip = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".next", ".cache"]);
  const out: DiagnosisFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || out.length >= 40) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 40) return;
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full, depth + 1);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        try {
          const content = readFileSync(full, "utf8").slice(0, MAX_FILE_BYTES);
          const rel = full.slice(repo.length + 1);
          out.push({ path: rel, content, isTest: isTestFile(rel) });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  walk(repo, 0);
  return out;
}

/** Default HEAD resolution (read-only). */
function gitHead(repo: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** The trusted patch-generator instruction (mirrors the patchsmith — cheap models choke on long rules). */
export const FIX_PATCH_SYSTEM =
  "You are a code repair engine. You have a CONFIRMED diagnosis and the file(s) to repair. Produce a " +
  "MINIMAL unified diff that fixes ONLY the diagnosed problem.\n\n" +
  "RULES:\n" +
  "- Return ONLY a unified diff: `--- a/path`, `+++ b/path`, then `@@ ... @@` hunks.\n" +
  "- Change the SMALLEST number of lines. Do not touch unrelated code.\n" +
  "- Do NOT weaken or delete tests. Do NOT wrap code in try/except to silence the failure.\n" +
  "- No commentary outside the diff.";

/** Map a non-fixable / refusal diagnosis category to its terminal result. */
function refusalResult(d: Diagnosis, allowTestEdits: boolean): FixResult | undefined {
  switch (d.category) {
    case "tool_limitation":
    case "parser_bug":
      return "TOOL_LIMITATION";
    case "verifier_environment_missing":
      return "ENVIRONMENT_MISSING";
    case "test_bug":
      return allowTestEdits ? undefined : "CORRECT_REFUSAL";
    case "implementation_bug":
    case "fixture_bug":
      return undefined; // fixable — proceed to repair
    case "unresolved":
      return "UNRESOLVED";
    default:
      return "NEEDS_HUMAN";
  }
}

/**
 * Run the 12-stage fix pipeline. NEVER throws past the boundary — an infrastructure failure
 * surfaces as a SAFE_FAIL/UNRESOLVED outcome with a complete receipt. Never promotes.
 */
export async function runFixPipeline(opts: FixOptions, deps: FixDeps): Promise<FixOutcome> {
  // H4/Gap C: wrap the model seam to ACCUMULATE this fix run's spend, then write ONE cost receipt so
  // `ikbi fix` (previously invisible) is counted by `ikbi cost`. The pipeline body has many terminal
  // returns, so accounting here — around it — is the clean seam that covers every exit path.
  const baseInvoke = deps.invokeModel ?? (async (req: ModelRequest) => (await import("../../core/provider/index.js")).invokeModel(req));
  let fixCostUsd = 0;
  const costingInvoke = async (req: ModelRequest): Promise<ModelResponse> => {
    const r = await baseInvoke(req);
    fixCostUsd += r.cost?.usd ?? 0;
    return r;
  };
  const outcome = await runFixPipelineInner(opts, { ...deps, invokeModel: costingInvoke });
  try {
    const receipts = deps.receipts ?? (await import("../../core/receipt/index.js")).receipts;
    const identity = deps.identity ?? DEFAULT_IDENTITY;
    // Distinct per-run id (fix has no task id) so separate fixes on the same repo don't merge into one
    // group in `ikbi cost`.
    const fixRunId = `fix:${opts.repo}:${(deps.now ?? (() => new Date().toISOString()))()}`;
    await receipts.append(
      {
        operation: "worker.fix.summary",
        outcome: { status: outcome.result === "FIXED_NARROWLY" || outcome.result === "CORRECT_REFUSAL" ? "success" : "failure", detail: outcome.result },
        requestId: fixRunId,
        metadata: {
          taskId: fixRunId,
          targetRepo: opts.repo,
          outcome: outcome.result,
          promoted: outcome.promoted,
          model: deps.modelId ?? builderModel(),
          costUsd: fixCostUsd,
          kind: "fix",
        },
        project: opts.repo,
      },
      identity,
    );
  } catch {
    /* a cost-receipt failure must never fail the fix itself */
  }
  return outcome;
}

async function runFixPipelineInner(opts: FixOptions, deps: FixDeps): Promise<FixOutcome> {
  const check = opts.check ?? defaultFixCheckFor(opts.repo);
  const allowTestEdits = opts.allowTestEdits ?? false;
  const allowConfigEdits = opts.allowConfigEdits ?? false;
  const maxFiles = opts.maxFiles ?? 5;

  const invokeModel = deps.invokeModel ?? (async (req: ModelRequest) => (await import("../../core/provider/index.js")).invokeModel(req));
  const neutralize = deps.neutralize ?? neutralizeUntrusted;
  const headOf = deps.head ?? gitHead;
  const now = deps.now ?? (() => new Date().toISOString());
  const candidateFiles = deps.candidateFiles ?? defaultCandidateFiles;
  const modelId = deps.modelId ?? builderModel();
  const identity = deps.identity ?? DEFAULT_IDENTITY;
  const isCancelled = deps.isCancelled ?? (() => false);

  // ── STAGE 1: SNAPSHOT ──────────────────────────────────────────────────────
  const builder = new FixReceiptBuilder({ timestamp: now(), repo: opts.repo, check: checkLabel(check), head: headOf(opts.repo) });

  // A refusal/terminal that ran NO edits still runs anti-cheat (over zero changes) — §"anti-cheat
  // runs on EVERY attempt". Returns the assembled outcome.
  const terminalNoEdit = (result: FixResult, diagnosis: Diagnosis, repairError?: RepairMutationFailure): FixOutcome => {
    const verdict = antiCheatCheck({ changes: [], allowedFiles: diagnosis.affectedFiles, allowTestEdits });
    builder.recordAntiCheat(verdict.passed, verdict.checks);
    return {
      result,
      receipt: builder.finalize(result),
      promoted: false,
      filesModified: [],
      diagnosis,
      ...(repairError === undefined ? {} : { repairError }),
    };
  };

  // A cancellation terminal: the operator cancelled before this boundary — stop cleanly with a
  // SAFE_FAIL (no changes are owned by a cancelled run; the caller settles status to "cancelled").
  const cancelledDiagnosis: Diagnosis = { category: "unresolved", confidence: 0, evidence: "fix cancelled by operator", affectedFiles: [] };

  // Kill-check #1 — before the (potentially slow) reproduce check runs.
  if (isCancelled()) {
    builder.recordDiagnosis(cancelledDiagnosis);
    return terminalNoEdit("SAFE_FAIL", cancelledDiagnosis);
  }

  // ── STAGE 2: REPRODUCE ─────────────────────────────────────────────────────
  let reproduce: CheckRun;
  try {
    reproduce = await deps.runCheck(opts.repo, check);
  } catch (e) {
    const diagnosis: Diagnosis = { category: "unresolved", confidence: 0, evidence: `could not run the check: ${errMsg(e)}`, affectedFiles: [] };
    builder.recordReproduce(-1, { passed: false, failingTests: [], collectionError: true, summary: `check execution failed: ${errMsg(e)}` }, errMsg(e));
    builder.recordDiagnosis(diagnosis);
    return terminalNoEdit("UNRESOLVED", diagnosis);
  }

  // ── STAGE 3: PARSE ─────────────────────────────────────────────────────────
  const outcomes = parseOutcomes(check, reproduce);
  builder.recordReproduce(reproduce.exitCode, outcomes, reproduce.output);

  // Kill-check #2 — before the diagnosis model call (the next expensive boundary).
  if (isCancelled()) {
    builder.recordDiagnosis(cancelledDiagnosis);
    return terminalNoEdit("SAFE_FAIL", cancelledDiagnosis);
  }

  // ── STAGE 4: CLASSIFY ──────────────────────────────────────────────────────
  const files = candidateFiles(opts.repo);
  const diagnosis = await diagnoseFailure(
    { outcomes, rawOutput: reproduce.output, files, ...(opts.goal !== undefined ? { goal: opts.goal } : {}) },
    { invokeModel, neutralize, modelId, identity },
  );
  builder.recordDiagnosis(diagnosis);

  // GATE: a non-fixable category (or diagnose-only) terminates here with NO edits.
  const refusal = refusalResult(diagnosis, allowTestEdits);
  if (refusal !== undefined) return terminalNoEdit(refusal, diagnosis);
  if (opts.diagnoseOnly === true) return terminalNoEdit("NEEDS_HUMAN", diagnosis);

  // ── STAGE 5: GROUND_TRUTH ──────────────────────────────────────────────────
  // For the thin slice the ground-truth set is the single failing check.

  // ── STAGE 6: PLAN ──────────────────────────────────────────────────────────
  const planFiles = [...diagnosis.affectedFiles].slice(0, maxFiles);
  const plan = {
    files: planFiles,
    change: `Repair ${diagnosis.category} by editing ${planFiles.join(", ") || "(no file identified)"}`,
    why: diagnosis.evidence,
  };
  builder.recordPlan(plan);
  if (planFiles.length === 0) return terminalNoEdit("NEEDS_HUMAN", diagnosis);
  if (diagnosis.affectedFiles.length > maxFiles) return terminalNoEdit("NEEDS_HUMAN", diagnosis);

  // A caller that supplies a managed workspace must also supply its exact
  // candidate/generation binding. Do not manufacture a standalone repair
  // identity for an already-managed candidate; the standalone envelope is
  // reserved for the CLI path that owns the workspace construction itself.
  if (opts.mutationWorkspace !== undefined && opts.mutationBinding === undefined) {
    const repairError: RepairMutationFailure = {
      code: "REPAIR_GENERATION_REVOKED",
      workspaceId: opts.mutationWorkspace.id,
      paths: [...planFiles],
      mutationApplied: false,
      partialMutation: false,
      retryable: false,
      recommendedRecovery: "Provide a fresh candidate generation binding before starting repair.",
      message: "managed repair workspace has no candidate-generation binding",
    };
    return terminalNoEdit("SAFE_FAIL", diagnosis, repairError);
  }

  // Capture exact raw observations once for this attempt. The model receives
  // bounded prompt text, but authority is retained in the complete byte
  // observation held by the mutation session.
  const mutationWorkspace = opts.mutationWorkspace ?? standaloneRepairWorkspace(opts.repo, identity);
  const repairBinding = opts.mutationBinding ?? {
    ...standaloneRepairBinding(mutationWorkspace, "fixer", "1"),
    actor: opts.mutationActor ?? "human",
    cause: opts.mutationCause ?? "human",
  };
  let mutationSession: WorkspaceMutationSession = await createRepairSession(mutationWorkspace, "fixer", repairBinding, "1");
  const observePlanFiles = async (): Promise<{ blocks: Array<{ path: string; body: string }>; beforeText: Map<string, string | null> }> => {
    const blocks: Array<{ path: string; body: string }> = [];
    const beforeText = new Map<string, string | null>();
    for (const f of planFiles) {
      const observed = await mutationSession.observeBytes(f);
      if (observed.bytes === null) {
        beforeText.set(f, null);
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes);
      } catch {
        throw new Error(`repair target is binary or not valid UTF-8: ${f}`);
      }
      beforeText.set(f, content);
      blocks.push({ path: f, body: content.slice(0, MAX_FILE_BYTES) });
    }
    return { blocks, beforeText };
  };
  let observedPlan = await observePlanFiles();
  let fileBlocks = observedPlan.blocks;
  let before = observedPlan.beforeText;

  const worktreeReal = (() => {
    try {
      return realpathSync(opts.repo);
    } catch {
      return opts.repo;
    }
  })();
  const planSet = new Set(planFiles.map((p) => p.replace(/\\/g, "/")));

  // Restore is itself a state-bound repair operation: it succeeds only while
  // every file still equals the prior operation's exact after-state.
  const restore = async (applied: readonly BoundMutationResult[]): Promise<void> => {
    await restoreRepairMutations(mutationSession, [...applied].reverse());
  };

  // Assemble a SAFE_FAIL outcome that left the disk clean (anti-cheat over zero changes).
  const safeFailNoChange = (diff: string, note: string, attempts: number): FixOutcome => {
    builder.recordPatch(diff, []);
    builder.recordTargetedCheck(false, note);
    const v = antiCheatCheck({ changes: [], allowedFiles: planFiles, allowTestEdits });
    builder.recordAntiCheat(v.passed, v.checks);
    builder.recordAttempts(attempts);
    return { result: "SAFE_FAIL", receipt: builder.finalize("SAFE_FAIL"), promoted: false, filesModified: [], diagnosis };
  };

  // ── STAGES 7-10 (THE FIX-RETRY LOOP): APPLY -> TARGETED_CHECK -> ANTI_CHEAT, up to MAX_FIX_ATTEMPTS.
  // The cheap builder diagnoses bugs far more reliably than it fixes them on the first try; feeding
  // it WHY its patch failed and re-prompting closes most of that gap (Gap M6). We retry ONLY a
  // clean-but-ineffective patch: a patch the anti-cheat catches is a terminal UNSAFE_FAIL (we never
  // re-prompt a cheat), and an unusable/garbage patch is a terminal SAFE_FAIL (identical inputs
  // would not help). Anti-cheat runs on EVERY attempt, including each retry.
  let feedbackOutput = reproduce.output; // verification output fed back to the next attempt
  let previousDiff: string | undefined; // the prior failed patch, shown to the model on a retry
  let lastApplied: readonly BoundMutationResult[] = [];
  let lastVerdict = antiCheatCheck({ changes: [], allowedFiles: planFiles, allowTestEdits });
  let lastFilesModified: string[] = [];

  // Per-attempt patch model (dual-model escalation, Gap M6): early attempts use the cheap worker
  // model, the final attempt escalates to the mid tier. Attempts beyond the roster reuse its last
  // entry. `modelId` (the diagnosis model) is the fallback when an entry is missing.
  const attemptModels = opts.escalationModels ?? defaultEscalationModels(modelId);

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    // Kill-check #3 — at each patch/verify boundary. Revert any patch a prior attempt wrote so a
    // cancelled run leaves the repo clean, then terminate (the caller settles status to cancelled).
    if (isCancelled()) {
      if (lastApplied.length > 0) {
        try { await restore(lastApplied); }
        catch (error) {
          const repairError = repairFailure(error, { session: mutationSession, paths: lastApplied.map((m) => m.mutation.path) });
          return { ...safeFailNoChange("", `repair cancellation cleanup refused: ${repairError.message}`, attempt - 1), repairError };
        }
      }
      builder.recordAttempts(attempt - 1);
      return terminalNoEdit("SAFE_FAIL", diagnosis);
    }

    const currentModel = attemptModels[Math.min(attempt - 1, attemptModels.length - 1)] ?? modelId;
    builder.recordAttemptModel(currentModel);

    // Every retry gets a fresh generation and fresh complete observations.
    if (attempt > 1) {
      if (lastApplied.length > 0) {
        try { await restore(lastApplied); }
        catch (error) {
          const repairError = repairFailure(error, { session: mutationSession, paths: lastApplied.map((m) => m.mutation.path) });
          return { ...safeFailNoChange("", `repair retry cleanup refused: ${repairError.message}`, attempt - 1), repairError };
        }
      }
      mutationSession = await createRepairSession(mutationWorkspace, "fixer", repairBinding, String(attempt));
      observedPlan = await observePlanFiles();
      fileBlocks = observedPlan.blocks;
      before = observedPlan.beforeText;
      lastApplied = [];
    }

    // ── STAGE 7: APPLY (generate -> validate every path -> apply) ──────────────
    const patchResult = await generateFixPatch(
      { diagnosis, files: fileBlocks, rawOutput: feedbackOutput, ...(previousDiff !== undefined ? { previousDiff } : {}) },
      { invokeModel, neutralize, modelId: currentModel, identity, attempt },
    );
    if (!patchResult.ok) {
      // Could not produce a usable patch — terminal SAFE_FAIL (nothing changed; no cheat).
      return safeFailNoChange("", `(no patch applied: ${patchResult.reason})`, attempt);
    }

    const parsed = parseUnifiedDiff(patchResult.diff);
    if (!parsed.ok) {
      return safeFailNoChange(patchResult.diff, `(patch did not parse: ${parsed.error})`, attempt);
    }

    // VALIDATE every touched path BEFORE writing a byte (reject the patch WHOLE on any violation).
    const changes: FileChange[] = [];
    const filesModified: string[] = [];
    let violation: string | undefined;
    const plannedMutations: Array<{ path: string; operation: "create" | "replace" | "delete"; afterBytes: Uint8Array | null }> = [];
    for (const fp of parsed.files) {
      const c = confinePath(worktreeReal, fp.path);
      if (!c.ok) {
        violation = c.error;
        break;
      }
      const rel = c.rel.replace(/\\/g, "/");
      if (!planSet.has(rel)) {
        violation = `patch touches a file outside the diagnosed scope: ${rel}`;
        break;
      }
      if (!allowTestEdits && isTestFile(rel)) {
        violation = `patch edits a test file without --allow-test-edits: ${rel}`;
        break;
      }
      if (!allowConfigEdits && CONFIG_FILE_RE.test(rel)) {
        violation = `patch edits a config file without --allow-config-edits: ${rel}`;
        break;
      }
      const observed = mutationSession.currentObservation(rel) ?? await mutationSession.observeBytes(rel);
      if (fp.deleted) {
        plannedMutations.push({ path: rel, operation: "delete", afterBytes: null });
        continue;
      }
      let original = "";
      if (observed.bytes !== null) {
        try { original = new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes); }
        catch { violation = `repair target is binary or not valid UTF-8: ${rel}`; break; }
      }
      const applied = applyFilePatch(original, fp);
      if (!applied.ok) {
        violation = applied.error;
        break;
      }
      plannedMutations.push({ path: rel, operation: fp.created ? "create" : "replace", afterBytes: Buffer.from(applied.content, "utf8") });
    }

    if (violation !== undefined) {
      // A rejected patch wrote NOTHING — terminal SAFE_FAIL (we refused to apply a bad patch).
      return safeFailNoChange(patchResult.diff, `(patch rejected: ${violation})`, attempt);
    }

    let repairPlan;
    let appliedPlan;
    try {
      repairPlan = createRepairPlan({
        session: mutationSession,
        producingAttemptId: mutationSession.binding.attemptId ?? `fixer:${attempt}`,
        producingRole: "fixer",
        ...((mutationSession.binding.invocationId === undefined) ? {} : { producingInvocationId: mutationSession.binding.invocationId }),
        files: plannedMutations,
        rationale: "fixer unified diff computed from complete observed candidate bytes",
      });
      appliedPlan = await applyRepairPlan(mutationSession, repairPlan);
    } catch (error) {
      const repairError = repairFailure(error, { session: mutationSession, paths: plannedMutations.map((p) => p.path) });
      return { ...safeFailNoChange(patchResult.diff, `${repairError.code}: ${repairError.message}`, attempt), repairError };
    }
    lastApplied = appliedPlan.mutations;
    for (const mutation of appliedPlan.mutations) {
      const rel = mutation.mutation.path;
      const beforeText = before.get(rel) ?? null;
      let afterText: string;
      try { afterText = new TextDecoder("utf-8", { fatal: true }).decode(mutation.afterBytes); }
      catch { afterText = ""; }
      filesModified.push(rel);
      changes.push({ path: rel, before: beforeText, after: afterText });
    }
    builder.recordPatch(patchResult.diff, filesModified);

    // ── STAGE 8: TARGETED_CHECK ───────────────────────────────────────────────
    const targeted = await deps.runCheck(opts.repo, check);
    const targetedOutcomes = parseOutcomes(check, targeted);
    builder.recordTargetedCheck(targetedOutcomes.passed, targeted.output);

    // ── STAGE 10: ANTI_CHEAT (runs on EVERY attempt, including each retry) ─────
    const verdict = antiCheatCheck({ changes, allowedFiles: planFiles, allowTestEdits });
    lastVerdict = verdict;
    lastFilesModified = filesModified;

    // A cheat is terminal — NEVER retry it (that would let the loop grind toward a dishonest pass).
    if (!verdict.passed) {
      builder.recordFullCheck(targetedOutcomes.passed, 0);
      builder.recordAntiCheat(verdict.passed, verdict.checks);
      builder.recordAttempts(attempt);
      return { result: "UNSAFE_FAIL", receipt: builder.finalize("UNSAFE_FAIL"), promoted: false, filesModified, diagnosis };
    }
    // An honest green ends the loop — FIXED_NARROWLY (stages 9/11/12).
    if (targetedOutcomes.passed) {
      builder.recordFullCheck(true, 0);
      builder.recordAntiCheat(verdict.passed, verdict.checks);
      builder.recordAttempts(attempt);
      return { result: "FIXED_NARROWLY", receipt: builder.finalize("FIXED_NARROWLY"), promoted: false, filesModified, diagnosis };
    }

    // Clean patch, but the check still fails — feed the failure back and retry (if attempts remain).
    feedbackOutput = targeted.output;
    previousDiff = patchResult.diff;
  }

  // ── STAGES 9/11/12: attempts exhausted without a green check → SAFE_FAIL ──────
  // The last attempt's patch is left applied on disk (it never promotes), mirroring the original
  // single-attempt SAFE_FAIL. Anti-cheat already passed on that attempt (a cheat would have
  // returned UNSAFE_FAIL above).
  builder.recordFullCheck(false, 0);
  builder.recordAntiCheat(lastVerdict.passed, lastVerdict.checks);
  builder.recordAttempts(MAX_FIX_ATTEMPTS);
  return { result: "SAFE_FAIL", receipt: builder.finalize("SAFE_FAIL"), promoted: false, filesModified: lastFilesModified, diagnosis };
}

/** Patch-generation deps (a subset of FixDeps, already defaulted). */
interface PatchDeps {
  readonly invokeModel: (request: ModelRequest) => Promise<ModelResponse>;
  readonly neutralize: (content: string, context: UntrustedContext) => NeutralizedContent;
  readonly modelId: string;
  readonly identity: AgentIdentity;
  /** 1-based attempt number (Gap M6). Tagged onto the model request metadata for observability. */
  readonly attempt?: number;
}

/**
 * Ask the model for a minimal unified diff that repairs the diagnosed problem. On a retry
 * (`args.previousDiff` set), the model is shown its prior failed patch alongside the fresh
 * verification output and explicitly told to try a DIFFERENT approach (Gap M6 fix-retry loop).
 */
export async function generateFixPatch(
  args: { diagnosis: Diagnosis; files: ReadonlyArray<{ path: string; body: string }>; rawOutput: string; previousDiff?: string },
  deps: PatchDeps,
): Promise<{ ok: true; diff: string } | { ok: false; reason: string }> {
  const fileBlocks = args.files.length > 0 ? args.files.map((f) => `--- ${f.path} ---\n${f.body}`).join("\n\n") : "(no source files were located)";
  const retrySection =
    args.previousDiff !== undefined
      ? [
          "",
          "YOUR PREVIOUS PATCH FAILED VERIFICATION. This is the diff you tried last time:",
          args.previousDiff.length > 0 ? args.previousDiff : "(empty diff)",
          "",
          "It did NOT make the check pass — the test still fails (see the verification output above).",
          "Try a DIFFERENT approach. Do not repeat the same diff; reconsider the root cause.",
        ]
      : [];
  const contextBody = [
    `DIAGNOSIS: ${args.diagnosis.category} (confidence ${args.diagnosis.confidence.toFixed(2)})`,
    `EVIDENCE: ${args.diagnosis.evidence}`,
    `REPAIR THESE FILE(S): ${args.diagnosis.affectedFiles.join(", ")}`,
    "",
    "FAILING CHECK OUTPUT:",
    args.rawOutput.length > 0 ? args.rawOutput : "(none)",
    ...retrySection,
    "",
    "FILES:",
    fileBlocks,
  ].join("\n");

  const untrusted: ModelMessage = toUntrustedMessage(deps.neutralize(contextBody, { source: "external", identity: deps.identity, origin: "fix_patch" }), { role: "user" });
  const messages: ModelMessage[] = [{ role: "system", content: FIX_PATCH_SYSTEM }, untrusted];

  let raw: string;
  try {
    const response = await deps.invokeModel({
      model: deps.modelId,
      temperature: PATCH_TEMPERATURE,
      maxTokens: PATCH_MAX_TOKENS,
      identity: deps.identity,
      messages,
      metadata: { fixStage: "patch", ...(deps.attempt !== undefined ? { fixAttempt: deps.attempt } : {}) },
    });
    raw = response.content;
  } catch (e) {
    return { ok: false, reason: `patch model call failed: ${errMsg(e)}` };
  }

  const extracted = extractDiff(raw);
  if (extracted.kind === "diff") return { ok: true, diff: extracted.text };
  if (extracted.kind === "need_context") return { ok: false, reason: `model requested more context: ${extracted.files.join(", ")}` };
  return { ok: false, reason: extracted.reason };
}
