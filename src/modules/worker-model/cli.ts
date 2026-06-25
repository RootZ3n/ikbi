/**
 * ikbi worker-model — the `ikbi build` CLI command + production activation.
 *
 * Activates real worker runs: resolves the operator identity (IKBI_OPERATOR_TOKEN),
 * wires a PRODUCTION roleClaim (returns IKBI_WORKER_TOKEN for ALL five roles — the
 * shared-worker model; the orchestrator's #10 clamp caps each spawned role at the
 * dispatching parent's tier, so a single shared credential cannot escalate), wires
 * the REAL gate-wall at promote (not advisory-allow), and runs the 5-role pipeline.
 *
 * Registers at module-import time (the modules barrel imports worker-model, which
 * imports this file). No built-in collision (version/models/providers/help).
 *
 * Fail-closed + friendly: a missing operator or worker token prints a clear,
 * actionable message and exits non-zero BEFORE any run; a gate denial at promote is a
 * clean discarded outcome (surfaced), not a crash; never a raw stack.
 *
 * REAL SMOKE TEST (side-effecting — needs tokens + model key + a target git repo):
 *   IKBI_OPERATOR_TOKEN=<32+> IKBI_WORKER_TOKEN=<32+> IKBI_MIMO_API_KEY=<key> \
 *     pnpm build && node dist/cli/index.js build "fix the failing test" --repo /path/to/repo
 *   It allocates a real git worktree under the state root, makes real model calls
 *   (cost), the builder writes files, the verifier runs `pnpm test` as a subprocess,
 *   and the workspace is promoted or discarded. Without tokens/key/repo it fails closed.
 */

import { createInterface } from "node:readline";
import { fstatSync } from "node:fs";

import { registerCommand } from "../../cli/registry.js";
import { writeStderr, writeStdout } from "../../cli/io.js";
import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, OperationContext, ValidatedIdentity } from "../../core/identity/index.js";
import { workspaces as coreWorkspaces } from "../../core/workspace/index.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { Receipt } from "../../core/receipt/index.js";
import type { AllocateOptions, DiscardResult, WorkspaceHandle, WorkspaceRecord } from "../../core/workspace/contract.js";
import type { AutonomyGrant } from "../../core/trust/contract.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventBusSurface } from "../../core/events/index.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createOrchestrator } from "./orchestrator.js";
import { WorkerError, validateDelegationEnvelope, type DelegationEnvelope, type WorkerResult, type WorkerRole, type WorkerTask } from "./contract.js";
import { preBuildRefinement, formatInterview } from "../../core/goal-refinement.js";
import { createCognitionLayer } from "../cognition-layer/cognition.js";
import { loadRepoRegistry } from "../../core/repo-registry.js";
import type { CognitionDecision, CognitionLayer } from "../cognition-layer/contract.js";
import { loadProjectMemory, type ProjectMemoryResult } from "./project-memory.js";
import { isBuildTier, resolveTierPreset, BUILD_TIERS, type BuildTier } from "./tier-presets.js";
import { unresolvableMessage } from "./checks.js";
import { createProductionGovernor } from "../memory-governor/create.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Prompt the user for input via stdin. Returns the trimmed answer.
 *
 * EOF-safe: if stdin is closed (piped `/dev/null`, EOF, a non-interactive runner)
 * the `question` callback never fires, so we also resolve on `close` with an empty
 * answer rather than hanging the process forever.
 */
function promptUser(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(prompt, (ans) => {
      answered = true;
      rl.close();
      resolve(ans.trim());
    });
    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

/**
 * Read piped stdin to completion (CC parity: `cat file | ikbi build "…"`). Returns "" — never hangs —
 * unless stdin is a PIPE or a redirected FILE, so an interactive TTY (or a test runner's non-piped
 * descriptor) is left untouched. The fstat(0) gate is what makes this safe to call unconditionally:
 * only a FIFO/regular-file descriptor is drained, both of which reach EOF on their own.
 */
export function readPipedStdin(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  return new Promise<string>((resolve) => {
    try {
      if (stdin.isTTY) return resolve("");
      const st = fstatSync(0);
      if (!st.isFIFO() && !st.isFile()) return resolve("");
    } catch {
      return resolve("");
    }
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c) => (data += c));
    stdin.on("end", () => resolve(data));
    stdin.on("error", () => resolve(data));
  });
}

// ── SG-2: diff surfacing ──────────────────────────────────────────────────────

/** A one-line change summary parsed from a unified diff (file count + +/- line counts). */
export interface DiffSummary {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

/** Parse a unified `git diff` into a change summary (PURE — for the post-build one-liner). */
export function summarizeDiff(diffText: string): DiffSummary {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers, not content
    else if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { files, insertions, deletions };
}

/** Format a DiffSummary as a single human line. */
export function formatDiffSummary(s: DiffSummary): string {
  return `Δ ${s.files} file${s.files === 1 ? "" : "s"} changed, +${s.insertions}/-${s.deletions}`;
}

/** Per-file change counts extracted from a unified diff. */
export interface FileDiffEntry {
  readonly file: string;
  readonly insertions: number;
  readonly deletions: number;
}

/** Extract per-file change counts from a unified diff. PURE. */
export function parseFileDiff(diffText: string): FileDiffEntry[] {
  const files: FileDiffEntry[] = [];
  let file = "";
  let ins = 0;
  let del = 0;
  let active = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (active) files.push({ file, insertions: ins, deletions: del });
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      file = m !== null && m[1] !== undefined ? m[1] : line.slice(11);
      ins = 0;
      del = 0;
      active = true;
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      // file headers — not content lines
    } else if (line.startsWith("+") && active) {
      ins += 1;
    } else if (line.startsWith("-") && active) {
      del += 1;
    }
  }
  if (active) files.push({ file, insertions: ins, deletions: del });
  return files;
}

/** Workspace state → human-readable description. */
const WS_STATE_LABEL: Record<string, string> = {
  promoted: "promoted (changes are live on the target branch)",
  discarded: "discarded (changes were not promoted)",
  failed: "failed (workspace retained for inspection)",
  allocated: "in-progress (build may still be running or was interrupted)",
  promoting: "promoting (merge in progress)",
  allocating: "allocating (workspace being set up)",
};

/** Human-readable failure details for a failed or rejected build. PURE. */
export function formatFailureDetail(r: WorkerResult): string {
  if (r.outcome === "success") return "";
  const failedRole = r.roles.find((x) => x.outcome !== "success");
  const lines: string[] = [];

  const label = r.outcome === "rejected" ? "REJECTED" : r.outcome === "partial" ? "PARTIAL" : "FAILED";
  lines.push(`Build ${label} — ${failedRole?.role ?? "unknown"}`);
  // Show which roles were skipped (Bubbles FIX 15): the result only lists roles that ran.
  const ALL_ROLES: WorkerRole[] = ["scout", "builder", "critic", "verifier", "integrator"];
  const ranRoles = new Set(r.roles.map((x) => x.role));
  const skipped = ALL_ROLES.filter((role) => !ranRoles.has(role));
  if (skipped.length > 0) lines.push(`  Skipped: ${skipped.join(", ")} (not run)`);

  // UNVERIFIABLE TARGET: a fail-closed terminal because ikbi could not DERIVE any checks (no
  // manifest, unsupported project, no IKBI_CHECKS) — NOT a model/code failure. Render the actionable
  // diagnostic FIRST and skip the generic role reason: the operator needs the "how to fix" steps,
  // not a confusing "the builder failed". (Model escalation was deliberately suppressed on this run.)
  if (r.verification !== undefined && (r.verification.kind === "checks_unresolvable" || r.verification.kind === "unsupported_project")) {
    // The shared diagnostic: WHY (no runnable checks), that this is NOT a model failure (escalation
    // suppressed because a stronger model cannot fix a missing verification contract), and HOW to fix.
    for (const l of unresolvableMessage(r.verification.kind, r.verification.reason).split("\n")) {
      lines.push(l.length > 0 ? `  ${l}` : "");
    }
    if (r.workspaceId !== undefined) lines.push(`  Workspace: ${r.workspaceId}`);
    lines.push(`  Undo available: no (build was not promoted)`);
    return `\n${lines.join("\n")}\n`;
  }

  const reason = failedRole?.summary ?? r.reason;
  if (reason !== undefined && reason.trim().length > 0) {
    lines.push(`  Reason: ${reason}`);
  }

  if (failedRole?.role === "verifier") {
    const vd = (failedRole.detail ?? {}) as Record<string, unknown>;
    const checks = Array.isArray(vd.checks) ? (vd.checks as Array<{ name?: unknown; passed?: unknown }>) : [];
    const failed = checks.filter((c) => c.passed === false || c.passed === undefined);
    if (failed.length > 0) lines.push(`  Checks failed: ${failed.map((c) => String(c.name ?? "?")).join(", ")}`);
    const blocked = Array.isArray(vd.blockReasons) ? (vd.blockReasons as unknown[]).map(String) : [];
    if (blocked.length > 0) lines.push(`  Blocked: ${blocked.join("; ")}`);
  } else if (failedRole?.role === "builder") {
    const bd = (failedRole.detail ?? {}) as Record<string, unknown>;
    const written = Array.isArray(bd.filesWritten) ? (bd.filesWritten as unknown[]).map(String) : [];
    if (written.length > 0) lines.push(`  Files touched: ${written.join(", ")}`);
  } else if (failedRole?.role === "critic") {
    const cd = (failedRole.detail ?? {}) as Record<string, unknown>;
    const fb = typeof cd.feedback === "string" ? cd.feedback.trim() : "";
    if (fb.length > 0) lines.push(`  Critic: ${fb.slice(0, 120)}${fb.length > 120 ? "…" : ""}`);
  }

  if (r.workspaceId !== undefined) {
    lines.push(`  Workspace: ${r.workspaceId}`);
    lines.push(`  Changes: run \`ikbi diff ${r.workspaceId}\` to inspect`);
  } else {
    lines.push(`  Changes: none (build did not reach the workspace stage)`);
  }

  lines.push(`  Undo available: ${r.promoted ? "yes" : "no (build was not promoted)"}`);

  return `\n${lines.join("\n")}\n`;
}

/** "Next command" hints for the operator after any build. PURE. */
export function formatNextHints(r: WorkerResult): string {
  const cmds: Array<[string, string]> = [];

  if (r.promoted) {
    cmds.push([`ikbi undo ${r.taskId}`, "revert this promotion"]);
  }
  if (r.workspaceId !== undefined) {
    const ws = r.workspaceId;
    if (!r.promoted) {
      cmds.push([`ikbi diff ${ws}`, "inspect what changed"]);
      cmds.push([`ikbi workspace discard ${ws}`, "reclaim this workspace"]);
    } else {
      cmds.push([`ikbi diff ${ws}`, "inspect the promoted changes"]);
    }
  }
  if (r.outcome !== "success") {
    cmds.push([`ikbi receipts --task ${r.taskId}`, "full audit trail for this run"]);
  }

  if (cmds.length === 0) return "";
  const maxLen = Math.max(...cmds.map(([c]) => c.length));
  const lines = ["\nNext:"];
  for (const [cmd, hint] of cmds) {
    lines.push(`  ${cmd.padEnd(maxLen + 2)}— ${hint}`);
  }
  return lines.join("\n") + "\n";
}

// ── colored diff display (HUMAN-facing only) ──────────────────────────────────
// Raw ANSI (no chalk dependency in the CLI context). Models never see this — the diff
// TEXT handed to a model is unchanged; only the terminal display is colorized.
const ANSI = { green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" } as const;

/**
 * Colorize a unified diff for terminal display: green for added (`+`) lines, red for
 * removed (`-`) lines, dim for `@@` hunk headers. File headers (`+++`/`---`) and context
 * lines are left plain. PURE — the input diff text is never mutated for the model. */
export function colorizeDiff(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return line; // file headers — plain
      if (line.startsWith("@@")) return `${ANSI.dim}${line}${ANSI.reset}`;
      if (line.startsWith("+")) return `${ANSI.green}${line}${ANSI.reset}`;
      if (line.startsWith("-")) return `${ANSI.red}${line}${ANSI.reset}`;
      return line;
    })
    .join("\n");
}

/** The minimal workspace surface the diff command + post-build summary read (get + diff). */
export interface DiffWorkspaceSurface {
  get(id: string): Promise<WorkspaceRecord | undefined>;
  diff(handle: WorkspaceHandle): Promise<string>;
}

/** The receipt reader surface the diff command uses to look up verification status. */
export interface DiffReceiptReader {
  query(): Promise<Receipt[]>;
}

/** Injectable surfaces for the `ikbi diff` command (tests inject a fake workspace surface). */
export interface DiffCliDeps {
  readonly workspaces?: DiffWorkspaceSurface;
  /** Optional receipt reader — used to show verification status from the run summary receipt. */
  readonly receipts?: DiffReceiptReader;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /** Colorize the diff for display. Default: on only when stdout is a TTY (never pollutes a pipe). */
  readonly colorize?: boolean;
}

/** Build the `ikbi diff <workspace-id>` handler — prints the workspace diff + a change summary. */
export function createDiffCli(deps: DiffCliDeps = {}) {
  const workspaces: DiffWorkspaceSurface = deps.workspaces ?? coreWorkspaces;
  const receiptReader: DiffReceiptReader = deps.receipts ?? coreReceipts;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  // Only colorize for an interactive terminal — piped/redirected output stays clean ANSI-free.
  const colorize = deps.colorize ?? (process.stdout.isTTY === true);

  /** Look up a run summary receipt for the given workspace id to find verification + promotion status. */
  async function findRunSummary(id: string): Promise<Receipt | undefined> {
    try {
      const all = await receiptReader.query();
      return all.find((r) => r.operation === "worker.run.summary" && (r.metadata as Record<string, unknown>)?.workspaceId === id);
    } catch {
      return undefined;
    }
  }

  /** Format the verification result from a run summary receipt into a human-readable label. */
  function verifiedLabel(vr: unknown): string {
    if (vr === "success") return "yes";
    if (vr === "not_run") return "not run";
    if (typeof vr === "string") return `no (${vr})`;
    return "unknown";
  }

  /** Print extra workspace status lines (promoted, verified, receipt warnings) after the header line. */
  async function printWorkspaceExtras(id: string, rec: WorkspaceRecord): Promise<void> {
    out(`  Promoted: ${rec.state === "promoted" ? "yes" : "no"}\n`);
    if (rec.receiptStatus === "failed") {
      out(`  Warning:  promote landed but receipt was not recorded (PROMOTED_BUT_RECEIPT_FAILED)\n`);
    }
    const summary = await findRunSummary(id);
    if (summary !== undefined) {
      const meta = summary.metadata as Record<string, unknown>;
      out(`  Verified: ${verifiedLabel(meta.verificationResult)}\n`);
    }
  }

  async function diff(argv: readonly string[]): Promise<void> {
    const id = argv[0];
    // --help is NOT a workspace id: print usage and exit 0 without touching workspace state.
    if (id === "--help" || id === "-h") {
      out(
        "Usage: ikbi diff <workspace-id>\n\n" +
          "Print a workspace's git diff (base..scratch) plus a change summary and per-file line counts.\n" +
          "List workspace ids with `ikbi workspaces list`.\n",
      );
      return;
    }
    if (id === undefined || id.length === 0) {
      err("ikbi diff: a workspace id is required — usage: ikbi diff <workspace-id>\n");
      setExit(1);
      return;
    }
    let rec: WorkspaceRecord | undefined;
    try {
      rec = await workspaces.get(id);
    } catch (e) {
      err(`ikbi diff: could not read workspace "${id}": ${errMsg(e)}\n`);
      setExit(1);
      return;
    }
    if (rec === undefined) {
      err(`ikbi diff: no workspace "${id}" found\n`);
      setExit(1);
      return;
    }
    let text: string;
    try {
      text = await workspaces.diff(rec);
    } catch (e) {
      err(`ikbi diff: could not compute the diff for "${id}": ${errMsg(e)}\n`);
      setExit(1);
      return;
    }
    if (text.trim().length === 0) {
      out(`workspace ${id}: no changes\n`);
      out(`State: ${WS_STATE_LABEL[rec.state] ?? rec.state}\n`);
      await printWorkspaceExtras(id, rec);
      return;
    }
    // Colorize for terminal display only; summarizeDiff still parses the RAW text.
    const display = colorize ? colorizeDiff(text) : text;
    out(display.endsWith("\n") ? display : `${display}\n`);
    out(`\n${formatDiffSummary(summarizeDiff(text))}\n`);
    // Per-file breakdown — each file's +/- line counts at a glance.
    const fileChanges = parseFileDiff(text);
    if (fileChanges.length > 0) {
      const maxFile = Math.max(...fileChanges.map((f) => f.file.length));
      out("\n");
      for (const fc of fileChanges) {
        out(`  ${fc.file.padEnd(maxFile + 2)}+${fc.insertions}/-${fc.deletions}\n`);
      }
    }
    // Workspace state — promoted/discarded/retained so the operator knows the fate of these changes.
    out(`\nWorkspace ${id}: ${WS_STATE_LABEL[rec.state] ?? rec.state}\n`);
    await printWorkspaceExtras(id, rec);
  }

  return { diff };
}

/**
 * The PRODUCTION roleClaim: the shared-worker model — every role resolves the same
 * worker credential. Tier escalation is impossible: the orchestrator's spawnRole
 * clamps each role's effective tier to ≤ the dispatching parent's tier (#10). Throws
 * WorkerError("config") when no worker token is configured (fail-closed).
 */
export function productionRoleClaim(workerToken: string | undefined): (role: WorkerRole) => IdentityClaim {
  return (_role: WorkerRole): IdentityClaim => {
    if (workerToken === undefined || workerToken.length === 0) {
      throw new WorkerError("config", "no worker credential — set IKBI_WORKER_TOKEN (see the worker-agent bootstrap)");
    }
    return { token: workerToken };
  };
}

/**
 * THE shared production-worker construction (C2): a worker orchestrator wired with the
 * shared-worker roleClaim (`productionRoleClaim`) + the REAL gate-wall at promote
 * (deny-on-absent, H5). This is the governance-load-bearing wiring that BOTH `ikbi build`
 * and `ikbi batch` run through — extracted ONCE so the two cannot drift apart (a future
 * hardening of the production path can't fix build and silently miss batch's per-subtask
 * runs). Construction is side-effect-free; `productionRoleClaim` only throws when CALLED
 * with no worker token, and the CLI handlers fail closed before that. The gate-wall
 * defaults to the live one so a caller that must NOT import gate-wall (the batch-planner
 * module boundary) can wire the governed worker without reaching for it.
 */
/** True iff a y/N answer is affirmative (only an explicit yes approves — default is No). */
export function isAffirmative(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** SG-10: a stdin y/N prompt asking the operator to approve a verified build's promotion. */
function stdinApprovalPrompt(req: { taskId: string; workspaceId: string; goal: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\nBuild ${req.taskId} verified. Approve promotion? [y/N] `, (ans) => {
      rl.close();
      resolve(isAffirmative(ans));
    });
  });
}

/** True iff IKBI_REQUIRE_APPROVAL opts into the human-approval gate. */
function approvalRequiredFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.IKBI_REQUIRE_APPROVAL ?? "");
}

export function createProductionWorker(
  opts: { workerToken: string | undefined; gateWall?: GateWall; onExecOutput?: (chunk: string, stream: "stdout" | "stderr") => void; requestApproval?: (req: { taskId: string; workspaceId: string; goal: string }) => Promise<boolean>; memoryGovernor?: import("../memory-governor/contract.js").MemoryGovernor; killCheck?: (target: { agentId?: string; runId?: string; requestId?: string }) => Promise<{ killed: boolean; signal?: { mode?: string; reason?: string } }> },
): { run: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult>; spawnRole: (role: WorkerRole, ctx: OperationContext) => { readonly autonomy: AutonomyGrant } } {
  // Explicitly thread the governed executor to BOTH roles (builder run_checks + verifier) via
  // the orchestrator. LAZY wrapper (not an eager import): importing the governed-exec singleton
  // at module scope would force the gate-wall/egress wiring order — the same reason the verifier
  // imports it lazily. (The builder also has the lazy fallback as defense-in-depth.)
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => (await import("../governed-exec/index.js")).governedExec.run(req) };
  // Explicitly thread the workspace manager (which provides commit) so the orchestrator can
  // COMMIT the verified-good work — without it the scratch branch never advances and promote
  // sees an empty diff ("no changes to promote"). coreWorkspaces is the same manager the
  // orchestrator would default to; passing it makes the commit dependency explicit.
  // The optional killCheck lets an embedding caller (e.g. the HTTP task service) wire a
  // COOPERATIVE per-run cancellation seam: the orchestrator already checks killCheck before
  // start + at each role boundary (target.runId === task.taskId), so a cancelled task stops
  // cleanly (discard, no half-promote). Absent ⇒ the live kill-switch default (unchanged).
  return createOrchestrator({ roleClaim: productionRoleClaim(opts.workerToken), gateWall: opts.gateWall ?? coreGateWall, governedExec, workspaces: coreWorkspaces, enforceProjectRoot: true, ...(opts.onExecOutput !== undefined ? { onExecOutput: opts.onExecOutput } : {}), ...(opts.requestApproval !== undefined ? { requestApproval: opts.requestApproval } : {}), ...(opts.memoryGovernor !== undefined ? { memoryGovernor: opts.memoryGovernor } : {}), ...(opts.killCheck !== undefined ? { killCheck: opts.killCheck } : {}) });
}

/**
 * Detect the write scope from the goal text. Doc/audit/analysis tasks should be
 * "new_only" to prevent the builder from over-writing existing files.
 * This is a heuristic — the goal text is the only signal available at dispatch time.
 */
function detectWriteScope(goal: string): "all" | "new_only" | "none" {
  const lower = goal.toLowerCase();
  // Pure read/audit/analysis patterns → new_only (create docs/reports, don't modify code)
  const docPatterns = [
    /\baudit\b/, /\breview\b/, /\banalyze\b/, /\bfind\s+dead\s+code\b/,
    /\bdetect\s+drift\b/, /\bgenerate\s+(?:architecture|docs?|documentation)\b/,
    /\bcreate\s+(?:a\s+)?(?:report|documentation|docs?|architecture)\b/,
    /\bwrite\s+(?:a\s+)?(?:report|documentation|docs?)\b/,
    /\bdo\s+not\s+modify\b/, /\bdon'?t\s+modify\b/,
    /\bread[- ]only\b/, /\breport\b.*\bonly\b/,
  ];
  // If the goal is explicitly about creating something new (not docs), allow all writes
  const createPatterns = [
    /\bfix\b/, /\badd\b/, /\bimplement\b/, /\brefactor\b/, /\bupdate\b/,
    /\brebuild\b/, /\bcreate\s+(?:a\s+)?(?:skill|module|feature|utility|endpoint|component)\b/,
  ];
  // If explicitly told not to modify, honor it
  if (/\bdo\s+not\s+modify\b/i.test(goal) || /\bdon'?t\s+modify\b/i.test(goal)) return "new_only";
  // If it's clearly a create/fix task, allow all
  if (createPatterns.some((p) => p.test(lower))) return "all";
  // If it matches doc/audit patterns, restrict to new files only
  if (docPatterns.some((p) => p.test(lower))) return "new_only";
  return "all";
}

/**
 * Parse `--repo <path>` / `--repo=<path>`, `--verbose`/`-v`, `--cost`, `--yes`/`-y`,
 * `--json`, and `--delegation <json>`; the rest is the goal prose. `--yes` skips the
 * interactive Socratic interview prompt and proceeds with the original goal. `--json`
 * forces a CLEAN machine-readable contract: ONLY the JSON result is written to STDOUT —
 * every progress/diagnostic/hint/repair/cost line is routed to STDERR so a caller can pipe
 * stdout straight into a JSON parser without log noise interleaved (FIX 3).
 */
export function parseBuildArgs(argv: readonly string[]): { repo?: string; verbose?: boolean; cost?: boolean; yes?: boolean; json?: boolean; delegation?: string; noMemory?: boolean; memoryDiff?: boolean; check?: string; maxBudgetUsd?: number; fallbackModel?: string; complexity?: "small" | "medium" | "large"; tier?: BuildTier; bare?: boolean; effort?: "low" | "medium" | "high" | "max"; fromPr?: number; rest: string[] } {
  const rest: string[] = [];
  let repo: string | undefined;
  let verbose = false;
  let cost = false;
  let yes = false;
  let json = false;
  let delegation: string | undefined;
  let noMemory = false;
  let memoryDiff = false;
  let check: string | undefined;
  let maxBudgetUsd: number | undefined;
  let fallbackModel: string | undefined;
  let complexity: "small" | "medium" | "large" | undefined;
  let tier: BuildTier | undefined;
  let bare = false;
  let effort: "low" | "medium" | "high" | "max" | undefined;
  let fromPr: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--repo") {
      repo = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
    } else if (a === "--verbose" || a === "-v") {
      verbose = true;
    } else if (a === "--cost") {
      cost = true;
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--delegation") {
      delegation = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--delegation=")) {
      delegation = a.slice("--delegation=".length);
    } else if (a === "--no-memory") {
      noMemory = true;
    } else if (a === "--memory-diff") {
      memoryDiff = true;
    } else if (a === "--check") {
      check = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--check=")) {
      check = a.slice("--check=".length);
    } else if (a === "--max-budget-usd") {
      const val = argv[i + 1];
      const n = typeof val === "string" ? Number.parseFloat(val) : Number.NaN;
      if (Number.isFinite(n) && n > 0) maxBudgetUsd = n;
      i += 1;
    } else if (a.startsWith("--max-budget-usd=")) {
      const n = Number.parseFloat(a.slice("--max-budget-usd=".length));
      if (Number.isFinite(n) && n > 0) maxBudgetUsd = n;
    } else if (a === "--fallback-model") {
      fallbackModel = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--fallback-model=")) {
      fallbackModel = a.slice("--fallback-model=".length);
    } else if (a === "--complexity") {
      const val = argv[i + 1];
      if (val === "small" || val === "medium" || val === "large") complexity = val;
      i += 1;
    } else if (a.startsWith("--complexity=")) {
      const val = a.slice("--complexity=".length);
      if (val === "small" || val === "medium" || val === "large") complexity = val;
    } else if (a === "--tier") {
      const val = argv[i + 1];
      if (typeof val === "string" && isBuildTier(val)) tier = val;
      i += 1;
    } else if (a.startsWith("--tier=")) {
      const val = a.slice("--tier=".length);
      if (isBuildTier(val)) tier = val;
    } else if (a === "--bare") {
      bare = true;
    } else if (a === "--effort") {
      const val = argv[i + 1];
      if (val === "low" || val === "medium" || val === "high" || val === "max") effort = val;
      i += 1;
    } else if (a.startsWith("--effort=")) {
      const val = a.slice("--effort=".length);
      if (val === "low" || val === "medium" || val === "high" || val === "max") effort = val;
    } else if (a === "--from-pr") {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isInteger(n) && n > 0) fromPr = n;
      i += 1;
    } else if (a.startsWith("--from-pr=")) {
      const n = Number.parseInt(a.slice("--from-pr=".length), 10);
      if (Number.isInteger(n) && n > 0) fromPr = n;
    } else {
      rest.push(a);
    }
  }
  return { ...(repo !== undefined && repo.length > 0 ? { repo } : {}), ...(verbose ? { verbose } : {}), ...(cost ? { cost } : {}), ...(yes ? { yes } : {}), ...(json ? { json } : {}), ...(delegation !== undefined ? { delegation } : {}), ...(noMemory ? { noMemory } : {}), ...(memoryDiff ? { memoryDiff } : {}), ...(check !== undefined && check.trim().length > 0 ? { check } : {}), ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}), ...(fallbackModel !== undefined ? { fallbackModel } : {}), ...(complexity !== undefined ? { complexity } : {}), ...(tier !== undefined ? { tier } : {}), ...(bare ? { bare } : {}), ...(effort !== undefined ? { effort } : {}), ...(fromPr !== undefined ? { fromPr } : {}), rest };
}

/**
 * Convert a `--check "<cmd> <args...>"` string into the IKBI_CHECKS JSON the verifier reads — a
 * single operator-declared check, whitespace-tokenized into command + args. Returns undefined when
 * the string is empty. This is the `ikbi build` analogue of `ikbi fix --check`: it lets the operator
 * verify a repo that has no recognizable manifest (e.g. a bare loose-source repo), overriding the
 * fast-fail manifest detection with an explicit command. NEVER model-chosen.
 */
export function checkToIkbiChecksJson(raw: string): string | undefined {
  const toks = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  if (toks.length === 0) return undefined;
  return JSON.stringify([{ name: "check", command: toks[0], args: toks.slice(1) }]);
}

/** Render a worker `worker.*` progress event into a concise human line (for `--verbose`). PURE. */
export function formatProgressEvent(e: { type: string; payload?: unknown }): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "worker.started": {
      // Surface the resolved hardened/legacy paths up-front so the operator sees what will run.
      const modes = p.verificationMode !== undefined || p.retrievalMode !== undefined ? ` [verify: ${String(p.verificationMode ?? "?")}, retrieval: ${String(p.retrievalMode ?? "?")}]` : "";
      return `  → run started (workspace ${String(p.workspaceId ?? "?")})${modes}\n`;
    }
    case "worker.role.dispatched": {
      const dispatchLabel: Record<string, string> = { scout: "reading", builder: "editing", verifier: "verifying", critic: "reviewing", integrator: "promoting" };
      const role = String(p.role ?? "?");
      const label = dispatchLabel[role] !== undefined ? ` (${dispatchLabel[role]})` : "";
      return `  → ${role} …${label}\n`;
    }
    case "worker.role.completed": {
      const completeLabel: Record<string, string> = { scout: "planning", builder: "editing", verifier: "verifying", critic: "reviewing", integrator: "promoting" };
      const icon = p.outcome === "success" ? "✓" : "✗";
      const costNote = typeof p.costUsd === "number" && p.costUsd > 0 ? ` ($${p.costUsd.toFixed(4)})` : "";
      const role = String(p.role ?? "?");
      const label = completeLabel[role] !== undefined ? ` (${completeLabel[role]})` : "";
      return `  ${icon} ${role}: ${String(p.outcome ?? "?")}${costNote}${label}\n`;
    }
    case "worker.builder.activity": {
      // SG: surface context-window pressure alongside the tool-activity line when present.
      const ctxNote = typeof p.contextPercent === "number" ? `, context ${String(p.contextPercent)}%` : "";
      // WO5: surface the TRUST TIER the builder ran under so the governance posture of the work is
      // visible in the builder's own output line, not buried in internal state.
      const tierNote = typeof p.tier === "string" && p.tier.length > 0 ? ` [tier: ${p.tier}]` : "";
      return `    builder: ${String(p.toolRounds ?? 0)} tool round(s), ${String(p.filesWritten ?? 0)} file(s) written${ctxNote}${tierNote}\n`;
    }
    case "worker.verification": {
      // ISSUE 4: show the ACTUAL per-check results (correct for custom IKBI_CHECKS — no phantom
      // "typecheck ✗" when only `test`/`build` ran). Fall back to the legacy typecheck/tests axes
      // only when the per-check list isn't present (older event shape).
      const checks = Array.isArray(p.checks) ? (p.checks as Array<{ name?: unknown; passed?: unknown }>) : undefined;
      const detail =
        checks !== undefined && checks.length > 0
          ? checks.map((c) => `${String(c.name)} ${c.passed ? "✓" : "✗"}`).join(", ")
          : `typecheck ${p.typecheckPassed ? "✓" : "✗"}, tests ${p.testsPassed ? "✓" : "✗"}`;
      // Scope-stamp the verify line in ladder mode so operators see impact vs full at a glance.
      const scope = p.verificationScope === "impact" || p.verificationScope === "full" ? ` [${p.verificationScope}]` : "";
      return `    verify: ${String(p.verdict ?? "?")}${scope} (${detail})\n`;
    }
    case "worker.trust.established": {
      // WO5: the verified-bootstrap moment — say plainly which trust tier the landed work runs under
      // and the autonomy that tier grants, so the operator never has to infer the posture.
      const grantNotes: string[] = [];
      if (p.sandboxed === true) grantNotes.push("sandboxed");
      if (p.requiresApproval === true) grantNotes.push("approval-gated");
      if (p.autoCommit === true) grantNotes.push("auto-commit");
      if (typeof p.gateLevel === "string") grantNotes.push(`gates: ${p.gateLevel}`);
      const grant = grantNotes.length > 0 ? ` — ${grantNotes.join(", ")}` : "";
      return `  ⛨ trust tier: ${String(p.tier ?? "?")}${grant}\n`;
    }
    case "worker.completed":
      return `  ✓ run complete (promoted=${String(p.promoted ?? false)})\n`;
    case "worker.failed":
      return `  ✗ run failed: ${String(p.reason ?? "unknown")}\n`;
    default:
      return ""; // other worker.* events (competitive) — not surfaced in the verbose line stream
  }
}

/** A concise, non-leaky result summary for the operator. Includes the run's total cost (USD). */
function summarize(r: WorkerResult): string {
  // CC parity: surface model, tool iterations, and files written in the JSON output.
  const builder = r.roles.find((x) => x.role === "builder");
  const bd = (builder?.detail ?? {}) as Record<string, unknown>;
  const numTurns = typeof bd.toolRounds === "number" ? bd.toolRounds : undefined;
  const model = typeof bd.model === "string" ? bd.model : undefined;
  const filesWritten = Array.isArray(bd.filesWritten) ? bd.filesWritten : undefined;
  return `${JSON.stringify(
    {
      taskId: r.taskId,
      outcome: r.outcome,
      promoted: r.promoted,
      ...(r.workspaceId !== undefined ? { workspaceId: r.workspaceId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(numTurns !== undefined ? { num_turns: numTurns } : {}),
      ...(filesWritten !== undefined ? { files_written: filesWritten } : {}),
      roles: r.roles.map((x) => ({ role: x.role, outcome: x.outcome })),
      ...(r.verificationMode !== undefined ? { verification: r.verificationMode } : {}),
      ...(r.retrievalMode !== undefined ? { retrieval: r.retrievalMode } : {}),
      // Structural fail-closed classification (no derivable checks). Distinct from `verification`
      // (the MODE) — these say WHY the run failed closed and that escalation was suppressed.
      ...(r.verification !== undefined ? { verification_kind: r.verification.kind, verification_reason: r.verification.reason, escalation_suppressed: true } : {}),
      cost_usd: r.costUsd ?? 0,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * ISSUE 3: a human-facing REPAIR REPORT — suspected root cause, files changed, why the change
 * fixes it, and the tests run — sourced from the builder role's `done` claim + the verifier's
 * checks. Returns "" when the run carries no narrative (a non-repair build, or a model that
 * supplied none), so callers can print it unconditionally.
 */
export function formatRepairNarrative(r: WorkerResult): string {
  const builder = r.roles.find((x) => x.role === "builder");
  const bd = (builder?.detail ?? {}) as Record<string, unknown>;
  const claim = (bd.doneClaim ?? {}) as { rootCause?: string; fixRationale?: string };
  if (claim.rootCause === undefined && claim.fixRationale === undefined) return "";

  const files = Array.isArray(bd.filesWritten) ? (bd.filesWritten as unknown[]).map(String) : [];
  const verifier = r.roles.find((x) => x.role === "verifier");
  const vd = (verifier?.detail ?? {}) as Record<string, unknown>;
  const checks = Array.isArray(vd.checks) ? (vd.checks as Array<{ name?: unknown; exitCode?: unknown }>) : [];

  const lines: string[] = ["", "Repair report:"];
  if (claim.rootCause !== undefined) lines.push(`  • Root cause: ${claim.rootCause}`);
  if (files.length > 0) lines.push(`  • Files changed: ${files.join(", ")}`);
  if (claim.fixRationale !== undefined) lines.push(`  • Why this fixes it: ${claim.fixRationale}`);
  if (checks.length > 0) lines.push(`  • Tests run: ${checks.map((c) => `${String(c.name)} ${c.exitCode === 0 ? "✓" : "✗"}`).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/** Format a run's total cost as a human one-line ($USD, 4 decimals). */
export function formatCost(costUsd: number | undefined): string {
  return `Cost: $${(costUsd ?? 0).toFixed(4)}`;
}

/** Format a byte count as a human-readable string (B / KB). PURE. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/**
 * Format the project memory context block for verbose pre-build display. PURE.
 * Shows which files were loaded, their sizes, and (on --memory-diff) the missing list.
 */
export function formatProjectMemoryContext(mem: ProjectMemoryResult | undefined, showMissing = false): string {
  const lines: string[] = [];
  if (mem === undefined) {
    lines.push("  → project context: none (no CLAUDE.md, AGENTS.md, or .ikbi/ files found)");
  } else {
    const fileList = mem.files
      .map((f) => `${f.path} (${formatBytes(f.bytes)}${f.truncated ? ", truncated" : ""})`)
      .join(", ");
    lines.push(`  → project context: ${fileList}`);
    if (showMissing && mem.missing.length > 0) {
      lines.push(`    missing ikbi config: ${mem.missing.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Format a per-role cost breakdown table for the --cost flag. */
export function formatCostBreakdown(r: WorkerResult): string {
  const lines: string[] = ["Cost breakdown:"];
  for (const roleResult of r.roles) {
    const detail = (roleResult.detail ?? {}) as Record<string, unknown>;
    const roleCost = typeof detail.costUsd === "number" ? detail.costUsd : 0;
    lines.push(`  ${roleResult.role.padEnd(10)}  $${roleCost.toFixed(4)}`);
  }
  lines.push(`  ${"─".repeat(22)}`);
  lines.push(`  ${"total".padEnd(10)}  $${(r.costUsd ?? 0).toFixed(4)}`);
  const builderDetail = (r.roles.find((x) => x.role === "builder")?.detail ?? {}) as Record<string, unknown>;
  if (typeof builderDetail.model === "string" && builderDetail.model.length > 0) {
    lines.push(`  Model: ${builderDetail.model}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Injectable surfaces so the construction + roleClaim + spawn/clamp + gate chain is testable. */
export interface WorkerCliDeps {
  /** The run surface. Default: a live orchestrator wired with the production roleClaim + real gate-wall. */
  readonly orchestrator?: {
    run: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult>;
    /**
     * H5: optionally inspect a role's CLAMPED autonomy without running it, so the multi-step
     * path can refuse a plan the worker tier could never land (no autoCommit). Absent on a
     * run-only orchestrator — the caller then proceeds (preserves the legacy single-step path).
     */
    readonly spawnRole?: (role: WorkerRole, ctx: OperationContext) => { readonly autonomy: AutonomyGrant };
  };
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  /** Gate-wall evaluator wired into the default orchestrator. Default: the live gate-wall (REAL, not advisory). */
  readonly gateWall?: GateWall;
  readonly operatorToken?: string | undefined;
  readonly workerToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
  readonly cwd?: () => string;
  /** Workspace surface for the post-build diff summary (SG-2). Default: the live manager. */
  readonly workspaces?: DiffWorkspaceSurface;
  /**
   * Workspace lifecycle surface for the MULTI-STEP (step-planner) path: allocate the shared
   * workspace the steps accumulate into, and discard it when a step fails (H3 — a failed
   * multi-step build must not leak the worktree). Default: the live workspace manager.
   */
  readonly stepWorkspaces?: {
    allocate: (opts: AllocateOptions) => Promise<WorkspaceHandle>;
    discard: (handle: WorkspaceHandle) => Promise<DiscardResult>;
  };
  /** Event bus the `--verbose` progress stream subscribes to (SG-5). Default: the live bus. */
  readonly events?: EventBusSurface;
  /**
   * Human-approval prompt (SG-10). When provided OR when IKBI_REQUIRE_APPROVAL is set, a
   * verified build pauses for this decision before promoting. Default: a stdin y/N prompt.
   */
  readonly approvalPrompt?: (req: { taskId: string; workspaceId: string; goal: string }) => Promise<boolean>;
  /** The Socratic-interview stdin prompt. Default: a readline question (EOF-safe). Injectable for tests. */
  readonly prompt?: (question: string) => Promise<string>;
  /**
   * Whether the session is interactive (a human is at the keyboard). When false, the
   * interactive Socratic-interview prompt is skipped (proceed with the original goal) —
   * the same effect as `--yes`. Default: `process.stdin.isTTY === true`.
   */
  readonly interactive?: boolean;
  /** Pre-build deliberation surface. Default: a fresh `createCognitionLayer()`. Injectable for tests. */
  readonly cognition?: Pick<CognitionLayer, "deliberate">;
  /** Memory governor for the build pipeline. Default: a production governor (lazy import). Injectable for tests. */
  readonly memoryGovernor?: import("../memory-governor/contract.js").MemoryGovernor;
}

/** Resolve a repo name or path through the repo registry. Returns undefined if not provided. */
function resolveRepo(repo: string | undefined): string | undefined {
  if (repo === undefined || repo.length === 0) return undefined;
  const registry = loadRepoRegistry();
  return registry.resolve(repo);
}

/** Build the `build` command handler. Defaults wire the live singletons + REAL gate-wall. */
export function createWorkerCli(deps: WorkerCliDeps = {}) {
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const workerToken = "workerToken" in deps ? deps.workerToken : config.identity.workerToken;
  const gateWall = deps.gateWall ?? coreGateWall;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? (() => process.cwd());
  const summaryWorkspaces: DiffWorkspaceSurface = deps.workspaces ?? coreWorkspaces;
  const stepWorkspaces = deps.stepWorkspaces ?? coreWorkspaces;
  const eventBus: EventBusSurface = deps.events ?? coreEvents;
  // The live orchestrator via the SHARED production-worker construction (the same wiring
  // `ikbi batch` uses, so build + batch are governed identically). Construction is
  // side-effect-free; roleClaim only throws when CALLED with no worker token (the handler
  // refuses before that). SG-1: stream the governed check output live to the operator's stdout.
  // SG-10: wire the human-approval gate when explicitly provided or when IKBI_REQUIRE_APPROVAL is set.
  const requestApproval = deps.approvalPrompt ?? (approvalRequiredFromEnv() ? stdinApprovalPrompt : undefined);
  // MEMORY GOVERNOR: intercepts governed writes (CLAUDE.md, .ikbi/*, brain pages) into
  // operator-reviewed proposals. Constructed once per build, shared across the pipeline.
  const memoryGovernor = deps.memoryGovernor ?? createProductionGovernor({});
  const orchestrator = deps.orchestrator ?? createProductionWorker({ workerToken, gateWall, onExecOutput: (chunk) => out(chunk), ...(requestApproval !== undefined ? { requestApproval } : {}), memoryGovernor });
  const prompt = deps.prompt ?? promptUser;
  // Default to interactive ONLY when stdin is a real terminal — a piped/redirected/CI stdin
  // never blocks the build waiting for an answer that can't come.
  const interactive = deps.interactive ?? (process.stdin.isTTY === true);

  async function build(argv: readonly string[]): Promise<void> {
    // `--help`/`-h` prints usage and exits 0 BEFORE any credential check, identity
    // resolution, or cognition deliberation (a model call). Without this, `--help` falls
    // through as a goal and the build path makes a model call — hanging on a missing/slow
    // model config. Help must be answerable offline.
    if (argv.includes("--help") || argv.includes("-h")) {
      out(
        "Usage: ikbi build <goal...> [--repo <path>] [options]\n\n" +
          "Run the 5-role worker pipeline (scout→builder→critic→verifier→integrator) in an\n" +
          "isolated worktree, promoting only on a ladder-verified pass.\n\n" +
          "Options:\n" +
          "  --repo <path>     Target repo (name from state/repos.json or absolute path; default: cwd)\n" +
          "  --verbose, -v     Stream per-role progress events as they fire\n" +
          "  --cost            Print a per-role cost breakdown after the build\n" +
          "  --yes, -y         Skip the interactive goal-refinement interview\n" +
          "  --json            Emit only the JSON result on stdout (logs/hints go to stderr)\n" +
          "  --no-memory       Do not load project memory (CLAUDE.md / AGENTS.md / .ikbi/)\n" +
          "  --memory-diff     Show which project memory would be used, then exit (no build)\n" +
          "  --check \"<cmd>\"   Explicit verification command for a repo with no manifest\n" +
          "  --delegation <json>  Run from a delegation envelope (overrides goal + repo)\n" +
                    "  --fallback-model <m> Override the escalation mid-tier model (default from IKBI_ESCALATION_MID_MODEL)\n" +
          "  --complexity <level>  small | medium | large — large skips flash entirely (uses pro)\n" +
          "  --tier <name>     cheap | mid | frontier — preset builder+critic models per tier.\n" +
          "                        cheap (flash+pro, auto-escalation ON); mid (glm-5.2+minimax-m3)\n" +
          "                        and frontier (sonnet-4.6+gpt-5.5) run one builder, escalation OFF.\n" +
          "  --max-budget-usd <n>  Cap total API spend at $n (e.g. 0.50 = 50 cents). Budget exhausted = clean abort.\n" +
          "                        Also settable via IKBI_MAX_BUDGET_USD env var.\n",
      );
      return;
    }

    const { repo, verbose, cost, yes, delegation: delegationJson, noMemory, memoryDiff, check, maxBudgetUsd, fallbackModel, complexity, tier, bare, effort, fromPr, rest } = parseBuildArgs(argv);

    // `--tier` given a value parseBuildArgs couldn't match (e.g. `--tier turbo`) silently drops to
    // undefined. Catch that here and fail closed with the valid set, rather than running an
    // unintended default tier — an operator who typed --tier meant to pin the models.
    const tierFlagIdx = argv.findIndex((a) => a === "--tier" || a.startsWith("--tier="));
    if (tierFlagIdx >= 0 && tier === undefined) {
      err(`ikbi: --tier: unknown tier — valid tiers are: ${BUILD_TIERS.join(", ")}\n`);
      setExit(1);
      return;
    }
    const tierPreset = tier !== undefined ? resolveTierPreset(tier) : undefined;

    // `--check "<cmd>"` declares an explicit verification command for a repo with no
    // recognizable manifest: convert it to the IKBI_CHECKS JSON the verifier reads and the
    // orchestrator's bare-repo fast-fail honors (hasExplicitChecks). Operator-declared, NEVER
    // model-chosen. Only set when non-empty; the override applies to this single CLI run.
    if (check !== undefined) {
      const checksJson = checkToIkbiChecksJson(check);
      if (checksJson !== undefined) process.env.IKBI_CHECKS = checksJson;
    }

    // Parse and validate a --delegation envelope when present. The envelope overrides goal +
    // targetRepo and stamps originAgent into the task for receipt attribution.
    let envelope: DelegationEnvelope | undefined;
    if (delegationJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(delegationJson);
      } catch {
        err("ikbi: --delegation: invalid JSON\n");
        setExit(1);
        return;
      }
      envelope = parsed as DelegationEnvelope;
      const validation = validateDelegationEnvelope(envelope);
      if (!validation.valid) {
        err(`ikbi: --delegation: invalid envelope: ${validation.reason}\n`);
        setExit(1);
        return;
      }
    }

    // Goal: delegation envelope objective takes precedence; fall back to argv goal.
    const rawGoal = envelope !== undefined ? envelope.objective : rest.join(" ").trim();
    // PIPED INPUT (CC parity): `cat file | ikbi build "analyze this"` prepends the piped text to the
    // goal as context. When the goal is empty, the piped text becomes the goal. No-op for a TTY.
    const pipedContext = (await readPipedStdin()).trim();
    const goal = pipedContext.length > 0 ? `${pipedContext}\n\n${rawGoal}`.trim() : rawGoal;
    if (goal.length === 0) {
      err("ikbi: build needs a goal — usage: ikbi build <goal...> [--repo <path>]\n");
      setExit(1);
      return;
    }
    // Fail-closed credential checks BEFORE any run.
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return;
    }
    if (workerToken === undefined || workerToken.length === 0) {
      err("ikbi: no worker credential — set IKBI_WORKER_TOKEN (see the worker-agent bootstrap)\n");
      setExit(1);
      return;
    }

    // H1: resolve the target repo BEFORE any work. Delegation envelope repoPath takes precedence
    // over --repo. Only fall back to cwd when neither is given.
    let targetRepo: string;
    if (envelope !== undefined) {
      // Delegation: repoPath is already validated as non-empty.
      targetRepo = envelope.repoPath;
    } else if (repo === undefined || repo.length === 0) {
      targetRepo = cwd();
    } else {
      const resolved = resolveRepo(repo);
      if (resolved === undefined) {
        const known = loadRepoRegistry().list().map((r) => r.name);
        const hint = known.length > 0 ? `known repos: ${known.join(", ")}` : "no repos registered in state/repos.json";
        err(`ikbi: --repo "${repo}" did not resolve to a known repo or absolute path (${hint})\n`);
        setExit(1);
        return;
      }
      targetRepo = resolved;
    }

    let who: ValidatedIdentity;
    try {
      who = resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)} — check IKBI_OPERATOR_TOKEN / the agents registry\n`);
      setExit(1);
      return;
    }

    const id = `build-${now()}`;
    const ctx = beginOperation(who, { requestId: id });

    // ── LAYER 1: Pre-build deliberation ─────────────────────────────────────
    // Run the cognition layer on the goal BEFORE creating the task. If the goal
    // is ambiguous, print the Socratic interview and wait for user input.
    let finalGoal = goal;
    let cognitionResult: CognitionDecision | undefined;
    try {
      const cognition = deps.cognition ?? createCognitionLayer();
      cognitionResult = await cognition.deliberate({ parentCtx: ctx, goal, ...(repo !== undefined ? { project: repo } : {}) });
    } catch {
      // Cognition failure is non-fatal — proceed with the original goal
    }

    // `--yes` (or a non-interactive session) skips the BLOCKING interview prompt entirely and
    // proceeds with the original goal. The cognition layer above still ran (non-blocking).
    const skipInterview = yes === true || !interactive;
    if (skipInterview) {
      // M4: goal refinement is INTERACTIVE-ONLY. `preBuildRefinement` (the Socratic interview)
      // exists solely to DRIVE the blocking prompt in the else-branch below — its `interview`
      // output is consumed nowhere else. Under `--yes`/non-interactive there is no prompt to
      // drive, so we deliberately DO NOT run it here: its result would be computed and then
      // discarded, which previously made "refinement" a no-op in automated/CI runs. Skipping it
      // is the honest behavior (and saves the work). The cognition layer's advisory signal still
      // flows through below.
      //
      // A cognition `reject` is ADVISORY at this layer — `--yes` (or a non-interactive session)
      // deliberately proceeds rather than aborting. Design choice: `--yes` means "don't prompt
      // me", and deliberation can be wrong, so we warn-and-proceed instead of blocking. But
      // silently discarding a reject hides a real signal, so surface it on STDERR (not stdout —
      // it must not pollute machine-readable output) before proceeding.
      if (cognitionResult?.decision === "reject") {
        err(`ikbi: warning: deliberation REJECTED this goal but --yes/non-interactive proceeds anyway: ${cognitionResult.rationale ?? "(no rationale)"}\n`);
      }
      // Nothing interactive to do — proceed with the original goal.
    } else {
      // INTERACTIVE: run the Socratic-interview refinement and act on it.
      const refinement = preBuildRefinement(goal, cognitionResult);
      if (!refinement.proceed && refinement.interview !== undefined) {
        out(formatInterview(refinement.interview));
        // Wait for user input — they can refine the goal or press Enter to skip
        const answer = await prompt("\n  Your answer (or press Enter to skip): ");
        if (answer.trim().length > 0) {
          finalGoal = `${goal} — ${answer.trim()}`;
          out(`\n  Refined goal: "${finalGoal}"\n\n`);
        } else {
          out("\n  Proceeding with original goal.\n\n");
        }
      } else if (refinement.interview !== undefined && refinement.interview.summary.startsWith("Warning:")) {
        // Surface warnings but proceed
        out(`\n  ⚠ ${refinement.interview.summary}\n\n`);
      }
    }

    // ── CONTEXT DISPLAY (verbose / --memory-diff) ────────────────────────────
    // Load project memory once here so we can (a) display it in verbose mode and
    // (b) pass it directly to the task (avoids a second disk read in the builder).
    // --bare implies --no-memory (skip project memory loading entirely).
    const projectMem: ProjectMemoryResult | undefined = noMemory === true || bare === true ? undefined : loadProjectMemory(targetRepo);
    if (memoryDiff === true) {
      // --memory-diff: show what project memory would be used and exit without building.
      out(formatProjectMemoryContext(projectMem, true));
      return;
    }
    if (verbose === true) {
      out(formatProjectMemoryContext(projectMem, false));
    }

    const task: WorkerTask = {
      taskId: id,
      targetRepo,
      goal: finalGoal,
      writeScope: detectWriteScope(finalGoal),
      ...(envelope !== undefined ? { originAgent: envelope.originAgent } : {}),
      ...(complexity !== undefined ? { complexity } : {}),
      // Pass pre-loaded memory content so the builder doesn't re-read the disk.
      // When --no-memory is set, projectMem is undefined; skipProjectMemory tells
      // the builder not to fall back to its own file load.
      ...(projectMem !== undefined ? { projectInstructions: projectMem.content } : {}),
      ...(noMemory === true ? { skipProjectMemory: true } : {}),
      // Gap 5 (--bare): skip non-essential loading. Implies skipping project memory too.
      ...(bare === true ? { bare: true, skipProjectMemory: true } : {}),
      // Gap 6 (--effort): reasoning level forwarded to every role model call.
      ...(effort !== undefined ? { effort } : {}),
      // Gap 9 (--from-pr): check out a PR and run the pipeline against it.
      ...(fromPr !== undefined ? { fromPr } : {}),
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      // Also check IKBI_MAX_BUDGET_USD env var
      ...(maxBudgetUsd === undefined && process.env.IKBI_MAX_BUDGET_USD ? (() => { const n = Number.parseFloat(process.env.IKBI_MAX_BUDGET_USD!); return Number.isFinite(n) && n > 0 ? { maxBudgetUsd: n } : {}; })() : {}),
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
      // Also check IKBI_FALLBACK_MODEL env var
      ...(fallbackModel === undefined && process.env.IKBI_FALLBACK_MODEL ? (() => { const m = process.env.IKBI_FALLBACK_MODEL!.trim(); return m.length > 0 ? { fallbackModel: m } : {}; })() : {}),
      // --tier preset: pin builder + critic models, and decide whether auto-escalation may fire.
      // The cheap tier escalates ON to its fallback (deepseek-v4-pro); mid/frontier set
      // escalationDisabled so a single capable builder fails closed instead of silently swapping
      // models. An explicit --fallback-model / IKBI_FALLBACK_MODEL (handled above) wins over the
      // tier's escalation target — so the tier fallback is only applied when none was set.
      ...(tierPreset !== undefined
        ? {
            builderModelOverride: tierPreset.builderModel,
            criticModelOverride: tierPreset.criticModel,
            ...(tierPreset.escalation ? {} : { escalationDisabled: true }),
            ...(tierPreset.fallbackModel !== undefined && fallbackModel === undefined && !process.env.IKBI_FALLBACK_MODEL
              ? { fallbackModel: tierPreset.fallbackModel }
              : {}),
          }
        : {}),
    };

    // Surface the resolved tier so the operator sees which models will run and whether a failed
    // builder will escalate (cheap) or fail closed (mid/frontier). Diagnostic → stderr, so it
    // never pollutes a --json stdout contract.
    if (tierPreset !== undefined) {
      err(
        `ikbi: tier=${tierPreset.tier} — builder=${tierPreset.builderModel}, critic=${tierPreset.criticModel}, ` +
          `escalation=${tierPreset.escalation ? `ON → ${task.fallbackModel ?? tierPreset.fallbackModel ?? "mid"}` : "OFF (fail-closed)"}\n`,
      );
    }

    // STEP-PLANNER: decompose complex goals into atomic steps for cheap models. Production uses ONLY
    // the deterministic, zero-cost heuristic `decompose` — the model-based `decomposeWithModel`
    // strategy is intentionally DORMANT (not wired here) so the planner never spends a model call;
    // see step-planner/implementation.ts for the rationale and how to opt in later.
    const { decompose } = await import("../step-planner/index.js");
    const stepPlan = decompose(finalGoal);

    // SG-5: with --verbose, stream the build's structured progress events (per-role start/end,
    // builder tool activity, verification status) live as they fire.
    const sub = verbose === true ? eventBus.subscribe({ typePrefix: "worker." }, (e) => out(formatProgressEvent(e))) : undefined;
    try {
      let result: WorkerResult;

      if (stepPlan.decomposed && stepPlan.steps.length > 1) {
        // H5: a multi-step plan only LANDS on a tier with autoCommit autonomy. Intermediate
        // steps set skipPromote (they never commit), and the final step's commit is gated on
        // autoCommit — so on a non-autoCommit tier (verified/probation/untrusted) every green
        // step would still evaporate to "partial" with nothing landed. Refuse the plan up front
        // with an actionable message instead of burning N model calls on work that can't land.
        // (A run-only orchestrator exposes no spawnRole ⇒ proceed, preserving the legacy path.)
        const canLand = orchestrator.spawnRole?.("builder", ctx).autonomy.autoCommit ?? true;
        if (!canLand) {
          err(
            `ikbi: this goal decomposes into ${stepPlan.steps.length} steps, but the worker tier lacks autoCommit autonomy — ` +
              `intermediate steps never commit and the accumulated work would evaporate to "partial" (nothing lands). ` +
              `Grant the worker the "trusted" tier and re-run, or restate the goal so it runs as a single step.\n`,
          );
          setExit(1);
          return;
        }
        // MULTI-STEP: allocate ONE workspace, run all steps in it, final verify + promote.
        // This is the shared-workspace step planner — changes accumulate across steps.
        out(`  ↳ decomposed into ${stepPlan.steps.length} steps\n`);
        const sharedWorkspace = await stepWorkspaces.allocate({
          targetRepo,
          identity: who.identity,
          label: `worker:${id}:steps`,
        });
        let stepsOk = true;
        let lastResult: WorkerResult | undefined;
        for (const step of stepPlan.steps) {
          out(`  → step ${step.index}/${stepPlan.steps.length}: ${step.goal}\n`);
          const stepTask: WorkerTask = {
            taskId: `${id}:step${step.index}`,
            targetRepo,
            goal: step.goal,
            writeScope: detectWriteScope(step.goal),
            reuseWorkspace: sharedWorkspace,
            skipPromote: true,
            // Skip verifier on ALL intermediate steps — the project is incomplete
            // until the last step runs. The final verify pass handles verification.
            skipVerifier: true,
            // Skip the critic too: on an intermediate (skipPromote) step its verdict is
            // discarded, so the paid model call buys nothing. The final pass critiques the
            // accumulated work against the full goal.
            skipCritic: true,
          };
          lastResult = await orchestrator.run(stepTask, ctx);
          if (lastResult.outcome !== "success") {
            out(`  ✗ step ${step.index} failed: ${lastResult.reason ?? lastResult.outcome}\n`);
            stepsOk = false;
            result = lastResult;
            break;
          }
          out(`  ✓ step ${step.index} passed\n`);
        }
        if (stepsOk) {
          // All steps passed — run full verification + promote on the accumulated workspace.
          out(`  → final verification + promote\n`);
          const finalTask: WorkerTask = {
            taskId: `${id}:verify`,
            targetRepo,
            goal: `Verify all changes from the multi-step plan: ${finalGoal}`,
            reuseWorkspace: sharedWorkspace,
            // H4: the final pass VERIFIES the accumulated work — it must not MODIFY it. writeScope
            // "none" blocks the builder from writing/patching/shell-writing any file, so a cheap
            // builder model cannot revert or corrupt the prior steps' work. The verifier still runs
            // its objective checks against the accumulated tree.
            writeScope: "none",
          };
          result = await orchestrator.run(finalTask, ctx);
        } else {
          // H3: a failing step left the shared workspace ALIVE (intermediate steps set
          // skipPromote, so the orchestrator neither promotes nor discards it). Discard it here
          // so a failed multi-step build never leaks the worktree. Best-effort: a discard error
          // must not mask the original step failure — the leak is reclaimable via `ikbi clean`.
          try {
            await stepWorkspaces.discard(sharedWorkspace);
          } catch {
            /* discard failure must not mask the step failure; the workspace is reclaimable later */
          }
          result = lastResult!;
        }
      } else {
        // SINGLE-STEP: run directly.
        result = await orchestrator.run(task, ctx);
      }
      if (sub !== undefined) await eventBus.flush(); // drain the progress lines before the summary
      // A gate denial / non-promote is a CLEAN outcome (printed), not an error.
      out(summarize(result));
      // ISSUE 3: surface the repair report (root cause / files / rationale / tests) when present.
      out(formatRepairNarrative(result));
      // --cost: print a per-role cost breakdown after the build.
      if (cost === true) out(formatCostBreakdown(result));
      // SG-2: after the run, show a one-line diff summary of what changed (best-effort).
      if (result.workspaceId !== undefined) await printDiffSummary(result.workspaceId);
      // Operator experience: failure details + next-command hints on STDERR (not stdout, which
      // stays machine-readable JSON). All non-success outcomes get failure detail; all outcomes
      // get next-command hints.
      if (result.outcome !== "success") err(formatFailureDetail(result));
      err(formatNextHints(result));
    } catch (e) {
      err(`ikbi: build failed: ${errMsg(e)}\n`);
      setExit(1);
    } finally {
      sub?.unsubscribe();
    }
  }

  /** Print a one-line diff summary for the run's workspace. Best-effort — never fails the build. */
  async function printDiffSummary(workspaceId: string): Promise<void> {
    try {
      const rec = await summaryWorkspaces.get(workspaceId);
      if (rec === undefined) return;
      const d = await summaryWorkspaces.diff(rec);
      if (d.trim().length === 0) return;
      out(`${formatDiffSummary(summarizeDiff(d))}\n`);
    } catch {
      /* a missing/cleaned workspace or git error is not a build failure — skip the summary */
    }
  }

  return { build };
}

// Register the LIVE command at import time (the modules barrel triggers this).
const live = createWorkerCli();
registerCommand({
  name: "build",
  summary: "Run a worker build pipeline toward a goal",
  usage: "ikbi build <goal...> [--repo <path>] [--verbose] [--cost] [--yes] [--no-memory] [--memory-diff]",
  run: (argv) => live.build(argv),
});

// SG-2: `ikbi diff <workspace-id>` prints a workspace's git diff + a one-line change summary.
const liveDiff = createDiffCli();
registerCommand({
  name: "diff",
  summary: "Print a workspace's git diff (base..scratch) + a change summary",
  usage: "ikbi diff <workspace-id>",
  run: (argv) => liveDiff.diff(argv),
});


// `ikbi repos` lists all registered repos from the repo registry.
registerCommand({
  name: "repos",
  summary: "List registered Pehverse repos (from state/repos.json)",
  usage: "ikbi repos",
  run: () => {
    const registry = loadRepoRegistry();
    const repos = registry.list();
    if (repos.length === 0) {
      writeStdout("No repos registered. Add entries to state/repos.json.\n");
      return;
    }
    const maxName = Math.max(...repos.map((r) => r.name.length));
    for (const r of repos) {
      const pad = " ".repeat(maxName - r.name.length);
      const port = r.port !== undefined ? ` (port ${r.port})` : "";
      writeStdout(`  ${r.name}${pad}  ${r.path}${port}\n`);
      if (r.description.length > 0) {
        const indent = " ".repeat(maxName + 4);
        writeStdout(`${indent}${r.description}\n`);
      }
    }
  },
});
