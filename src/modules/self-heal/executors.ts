/**
 * ikbi self-heal — executors: the bridge from the pure loop to the real subsystems.
 *
 * runSelfHeal() (driver.ts) is pure of I/O; it enacts an injected SelfHealExecutors. This file
 * BUILDS that executor set from a small IO-ports object (SelfHealIo) so the WIRING glue — how a
 * WorkerResult + a suite run + a judge verdict become a CandidateFix/SuiteResult/JudgeResult — is
 * testable with fakes, while `liveSelfHealIo()` supplies the real defaults (a build on the ikbi repo,
 * the full `pnpm test`, the deterministic judge, a frontier advisory call, a receipt).
 *
 * @status the pure adapter helpers + composeExecutors() are covered by tests; liveSelfHealIo() wires
 * real subsystems but its last-mile I/O (an isolated worktree's node_modules, a live advisory model)
 * must be integration-validated before self-heal is enabled unattended — hence library-only for now.
 */

import { spawn } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { BuildCandidate, JudgeResult as DetJudgeResult } from "../deterministic-judge/contract.js";
import type { WorkerResult, WorkerTask } from "../worker-model/contract.js";
import { parseTestCount } from "../worker-model/checks.js";
import { TIER_PRESETS, type BuildTier } from "../worker-model/tier-presets.js";
import type {
  CandidateFix,
  JudgeResult,
  OpusAdviceContext,
  SelfHealExecutors,
  SelfHealFailure,
  SelfHealResult,
  SuiteResult,
} from "./contract.js";

/** How self-heal talks to the world. Every method is a seam a test replaces with a fake. */
export interface SelfHealIo {
  /** Allocate an ISOLATED worktree + scratch branch off the target repo (never touches main). */
  readonly allocate: (targetRepo: string) => Promise<WorkspaceHandle>;
  /** Run the fix build in the given workspace (skipPromote — leaves the worktree for us to read). */
  readonly build: (task: WorkerTask) => Promise<WorkerResult>;
  /** Read the candidate diff from a finished worktree: staged + untracked, vs the isolation base. */
  readonly readDiff: (handle: WorkspaceHandle) => Promise<DiffStat>;
  /** Run the FULL ikbi correctness gate (typecheck + `pnpm test`) in the worktree. */
  readonly runSuite: (handle: WorkspaceHandle) => Promise<SuiteResult & { readonly typecheckPass?: boolean }>;
  /** Score the candidate with the deterministic judge. */
  readonly judge: (candidates: readonly BuildCandidate[]) => DetJudgeResult;
  /** One tool-free advisory model call; returns the recommendation text for the human. */
  readonly advise: (messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>) => Promise<string>;
  /** Persist the terminal outcome as a receipt. */
  readonly writeReceipt: (result: SelfHealResult) => Promise<void>;
}

/** The parsed shape of a candidate diff (from `git diff` numstat + name-status). */
export interface DiffStat {
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly linesChanged: number;
}

/** Options controlling how a fix is generated. */
export interface SelfHealExecutorOptions {
  /** The build tier the fix runs on (default "mid" — the "pro" roster; frontier for hard bugs). */
  readonly tier?: BuildTier;
  /** The tool-round ceiling reported to the judge (normalizes the efficiency family). */
  readonly maxToolRounds?: number;
}

// ── PURE ADAPTER HELPERS (exported for direct testing) ──────────────────────────────────────────

/**
 * Build the WorkerTask that generates a fix. Runs in the caller's ISOLATED workspace (reuseWorkspace)
 * with skipPromote so the orchestrator never promotes or discards — the candidate stays on its scratch
 * branch for us to gate. The goal instructs a harness fix and forbids weakening the tests (the
 * blast-radius no-test-drop rule is the hard backstop, but say it in the goal too).
 */
export function buildFixTask(
  failure: SelfHealFailure,
  handle: WorkspaceHandle,
  opts: SelfHealExecutorOptions = {},
): WorkerTask {
  const tier = opts.tier ?? "mid";
  const preset = TIER_PRESETS[tier];
  const c = failure.classification;
  const goal =
    `ikbi self-heal — repair a HARNESS-suspect failure in ikbi's own build harness.\n` +
    `Classification: ${c.signal} (${c.category}). Evidence: ${c.evidence}\n` +
    (c.suggestedAction !== undefined ? `Suggested direction: ${c.suggestedAction}\n` : "") +
    (failure.reason !== undefined ? `Original failure reason: ${failure.reason}\n` : "") +
    `Fix the harness so this class of failure no longer occurs. Keep the change narrow and localized. ` +
    `Do NOT delete or weaken any test, and do NOT lower the suite's test count — add tests if the fix ` +
    `needs new coverage. \`pnpm build\` and \`pnpm test\` must both stay green.`;
  return {
    taskId: `selfheal-${failure.taskId}`,
    targetRepo: failure.targetRepo,
    goal,
    reuseWorkspace: handle,
    skipPromote: true,
    builderModelOverride: preset.builderModel,
    criticModelOverride: preset.criticModel,
    escalationDisabled: !preset.escalation,
    originAgent: "self-heal",
    metadata: { selfHeal: true, healingTaskId: failure.taskId, signal: c.signal, tier },
  };
}

/** Parse `git diff <base> --numstat` — lines like `12\t3\tpath` (or `-\t-\tpath` for binary). */
export function parseNumstat(output: string): { changedFiles: string[]; linesChanged: number } {
  const changedFiles: string[] = [];
  let linesChanged = 0;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m === null) continue;
    const added = m[1] === "-" ? 0 : Number(m[1]);
    const removed = m[2] === "-" ? 0 : Number(m[2]);
    changedFiles.push(m[3] as string);
    linesChanged += added + removed;
  }
  return { changedFiles, linesChanged };
}

/** Parse `git diff <base> --name-status --diff-filter=D` — deleted paths (status `D\tpath`). */
export function parseDeleted(output: string): string[] {
  const deleted: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = /^D\t(.+)$/.exec(line);
    if (m !== null) deleted.push(m[1] as string);
  }
  return deleted;
}

/**
 * Merge the two git views into a clean DiffStat. A deleted file shows up in BOTH numstat (as a change)
 * and name-status; keep it ONLY in deletedFiles so assessBlastRadius's `[...changed, ...deleted]` never
 * double-counts it (which would inflate breadth and over-raise severity). changedFiles = added/modified.
 */
export function mergeDiffStat(numstatOut: string, nameStatusDOut: string): DiffStat {
  const { changedFiles, linesChanged } = parseNumstat(numstatOut);
  const deletedFiles = parseDeleted(nameStatusDOut);
  const deletedSet = new Set(deletedFiles);
  return { changedFiles: changedFiles.filter((f) => !deletedSet.has(f)), deletedFiles, linesChanged };
}

/** Combine a DiffStat + workspace into the CandidateFix the driver gates. produced = any change. */
export function toCandidateFix(diff: DiffStat, handle: WorkspaceHandle, buildReason?: string): CandidateFix {
  return {
    produced: diff.changedFiles.length > 0,
    changedFiles: diff.changedFiles,
    ...(diff.deletedFiles.length > 0 ? { deletedFiles: diff.deletedFiles } : {}),
    linesChanged: diff.linesChanged,
    branch: handle.scratchBranch,
    workspaceId: handle.id,
    ...(buildReason !== undefined ? { buildReason } : {}),
  };
}

/** Map the candidate + gate results into the deterministic judge's BuildCandidate. */
export function toBuildCandidate(
  candidate: CandidateFix,
  suite: SuiteResult & { readonly typecheckPass?: boolean },
  worker: WorkerResult,
  opts: SelfHealExecutorOptions = {},
): BuildCandidate {
  const total = suite.testCount ?? 0;
  return {
    workspaceId: candidate.workspaceId ?? worker.workspaceId ?? "self-heal",
    typecheckPass: suite.typecheckPass ?? suite.green,
    testsPass: suite.green,
    ...(suite.testCount !== undefined ? { testCount: { passed: suite.testCount, total } } : {}),
    testEvidence: suite.testCount !== undefined && suite.testCount > 0 ? "executed" : "unverified",
    toolRounds: countBuilderRounds(worker),
    maxToolRounds: opts.maxToolRounds ?? 60,
    rejectedToolCalls: 0,
    filesWritten: candidate.changedFiles.length,
    ...(candidate.linesChanged !== undefined ? { diffLines: candidate.linesChanged } : {}),
    stopReason: worker.outcome === "success" ? "stop" : worker.reason ?? "unknown",
  };
}

/** Best-effort tool-round count from the builder role's detail (0 when not recorded). */
function countBuilderRounds(worker: WorkerResult): number {
  const builder = worker.roles.find((r) => r.role === "builder");
  const rounds = (builder?.detail as { toolRounds?: unknown } | undefined)?.toolRounds;
  return typeof rounds === "number" && Number.isFinite(rounds) ? rounds : 0;
}

/** True when the judge kept OUR candidate as the (non-disqualified) winner. */
export function judgePassed(result: DetJudgeResult, workspaceId: string): boolean {
  return !result.rejectedAll && result.winner !== null && result.winner.workspaceId === workspaceId;
}

/** Adapt the deterministic verdict into self-heal's simple JudgeResult (pass + reason). */
export function toJudgeResult(result: DetJudgeResult, workspaceId: string): JudgeResult {
  const pass = judgePassed(result, workspaceId);
  return { pass, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
}

/** Build the messages for the one-shot advisory call (verified but high/max blast-radius). */
export function buildAdviceMessages(ctx: OpusAdviceContext): Array<{ role: "system" | "user"; content: string }> {
  const { failure, candidate, blastRadius } = ctx;
  const system =
    "You are Opus advising a human operator on whether to merge a self-generated fix to ikbi's own " +
    "build harness. The fix already PASSED the full test suite and the deterministic judge, but its " +
    "blast-radius is high/max (it touches a guard, frozen core, or a broad surface). You do NOT " +
    "decide — you advise. Be concise: state the specific risk, what to inspect, and a clear " +
    "recommendation (merge / merge-with-checks / do-not-merge).";
  const user =
    `Failure being healed: ${failure.classification.signal} — ${failure.classification.evidence}\n` +
    `Candidate branch: ${candidate.branch ?? "(unknown)"}\n` +
    `Changed files (${candidate.changedFiles.length}): ${candidate.changedFiles.slice(0, 20).join(", ")}\n` +
    (candidate.deletedFiles && candidate.deletedFiles.length > 0 ? `Deleted files: ${candidate.deletedFiles.join(", ")}\n` : "") +
    `Lines changed: ${candidate.linesChanged ?? "?"}\n` +
    `Blast-radius: ${blastRadius.severity} — ${blastRadius.reasons.join("; ")}\n` +
    `Should the operator merge this branch?`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ── EXECUTOR COMPOSITION ────────────────────────────────────────────────────────────────────────

/**
 * Compose a SelfHealExecutors from IO ports. This is the testable wiring: it sequences allocate →
 * build → readDiff into generateFix, feeds the suite + judge, and threads the receipt. The pure
 * disposition (policy) and the blast-radius live in the driver — this only produces the inputs.
 */
export function composeExecutors(io: SelfHealIo, opts: SelfHealExecutorOptions = {}): SelfHealExecutors {
  // Cache the workspace/worker/suite across the generateFix → runSuite → runJudge calls of one run.
  let lastHandle: WorkspaceHandle | undefined;
  let lastWorker: WorkerResult | undefined;
  let lastSuite: (SuiteResult & { readonly typecheckPass?: boolean }) | undefined;

  return {
    generateFix: async (failure: SelfHealFailure): Promise<CandidateFix> => {
      const handle = await io.allocate(failure.targetRepo);
      lastHandle = handle;
      const task = buildFixTask(failure, handle, opts);
      const worker = await io.build(task);
      lastWorker = worker;
      const diff = await io.readDiff(handle);
      return toCandidateFix(diff, handle, worker.reason);
    },
    runSuite: async (candidate: CandidateFix): Promise<SuiteResult> => {
      // The suite runs in the worktree the fix landed in.
      const handle = lastHandle;
      if (handle === undefined || (candidate.workspaceId !== undefined && handle.id !== candidate.workspaceId)) {
        return { green: false, summary: "internal: no workspace handle to run the suite in" };
      }
      const suite = await io.runSuite(handle);
      lastSuite = suite;
      return suite;
    },
    runJudge: async (candidate: CandidateFix): Promise<JudgeResult> => {
      const worker = lastWorker;
      const suite = lastSuite;
      if (worker === undefined || suite === undefined) {
        return { pass: false, reason: "internal: suite/build results unavailable for the judge" };
      }
      const bc = toBuildCandidate(candidate, suite, worker, opts);
      const verdict = io.judge([bc]);
      return toJudgeResult(verdict, bc.workspaceId);
    },
    opusAdvise: async (ctx: OpusAdviceContext): Promise<string> => io.advise(buildAdviceMessages(ctx)),
    receipt: async (result: SelfHealResult): Promise<void> => io.writeReceipt(result),
  };
}

// ── LIVE IO (real subsystems; integration-validate before unattended use) ────────────────────────

/** Dependencies for the live IO — every real subsystem is overridable for tests / alternate wiring. */
export interface LiveSelfHealDeps {
  /** The identity self-heal acts under (operator/trusted). Required — no ambient identity. */
  readonly identity: AgentIdentity;
  /** The operation context threaded into runWorker. Required. */
  readonly parentCtx: OperationContext;
  /** Allocate an isolated workspace (default: the core workspace manager). */
  readonly allocate: (targetRepo: string) => Promise<WorkspaceHandle>;
  /** Run the fix build (default: runWorker). */
  readonly runWorker: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult>;
  /** Run a git command in a worktree, returning stdout. */
  readonly execGit?: (cwd: string, args: readonly string[]) => Promise<string>;
  /** Run the ikbi suite (`pnpm build` + `pnpm test`) in a worktree, returning {code, output}. */
  readonly runSuiteProcess?: (cwd: string, targetRepo: string) => Promise<{ code: number; output: string }>;
  /** The deterministic judge (default: the singleton). */
  readonly judge: (candidates: readonly BuildCandidate[]) => DetJudgeResult;
  /** Invoke the advisory model (default: invokeModel with the configured advice model). */
  readonly invokeAdvice: (messages: ReadonlyArray<{ role: "system" | "user"; content: string }>) => Promise<string>;
  /** Append a receipt (default: the core receipt store). */
  readonly appendReceipt: (result: SelfHealResult, identity: AgentIdentity) => Promise<void>;
}

/** Assemble the live IO ports from the real subsystems. Pure of policy — just the plumbing. */
export function liveSelfHealIo(deps: LiveSelfHealDeps): SelfHealIo {
  const execGit = deps.execGit ?? defaultExecGit;
  const runSuiteProcess = deps.runSuiteProcess ?? defaultRunSuite;
  return {
    allocate: deps.allocate,
    build: (task) => deps.runWorker(task, deps.parentCtx),
    readDiff: async (handle) => {
      // Stage everything (including untracked new files) so the diff vs the isolation base is complete.
      // Validated: `git add -A && git diff --cached <baseRef>` captures added, modified, and deleted.
      await execGit(handle.path, ["add", "-A"]);
      const numstat = await execGit(handle.path, ["diff", "--cached", handle.baseRef, "--numstat"]);
      const nameStatus = await execGit(handle.path, ["diff", "--cached", handle.baseRef, "--name-status", "--diff-filter=D"]);
      return mergeDiffStat(numstat, nameStatus);
    },
    runSuite: async (handle) => {
      const { code, output } = await runSuiteProcess(handle.path, handle.targetRepo);
      const parsed = parseTestCountSafe(output);
      const green = code === 0;
      return {
        green,
        ...(parsed !== undefined ? { testCount: parsed.total } : {}),
        typecheckPass: green,
        ...(green ? {} : { summary: lastLines(output, 8) }),
      };
    },
    judge: deps.judge,
    advise: deps.invokeAdvice,
    writeReceipt: (result) => deps.appendReceipt(result, deps.identity),
  };
}

// Live default primitives (kept tiny; the interesting logic is in the pure helpers above).

function defaultExecGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`))));
  });
}

function defaultRunSuite(cwd: string, targetRepo: string): Promise<{ code: number; output: string }> {
  // A fresh git worktree has NO node_modules (deps are gitignored) — validated: `pnpm build` fails
  // "tsc not found". Self-heal targets ikbi against (near-)identical deps, so symlink the target repo's
  // node_modules into the worktree: `tsc`/`tsx` then resolve and the full build+test runs. (A fix that
  // changes deps/lockfile would want a real install; that is a rare harness-fix case — noted, not run.)
  try {
    const src = join(targetRepo, "node_modules");
    const dst = join(cwd, "node_modules");
    if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst, "dir");
  } catch { /* best-effort: if the link fails the suite fails loudly below, which is the safe outcome */ }
  return new Promise((resolve) => {
    // Build (typecheck) then test, sharing one shell so a build failure short-circuits the suite.
    const child = spawn("sh", ["-c", "pnpm build && pnpm test"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, IKBI_ALLOW_INSECURE_DEV_KEYS: "true" },
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    child.on("error", (e) => resolve({ code: 1, output: `${output}\nspawn error: ${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** parseTestCount, guarded so a parse throw never sinks the suite verdict. */
function parseTestCountSafe(output: string): { passed: number; total: number } | undefined {
  try {
    return parseTestCount(output);
  } catch {
    return undefined;
  }
}

function lastLines(text: string, n: number): string {
  return text.split("\n").filter((l) => l.trim().length > 0).slice(-n).join("\n");
}
