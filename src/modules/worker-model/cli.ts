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

import { registerCommand } from "../../cli/registry.js";
import { writeStderr, writeStdout } from "../../cli/io.js";
import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, OperationContext, ValidatedIdentity } from "../../core/identity/index.js";
import { workspaces as coreWorkspaces } from "../../core/workspace/index.js";
import type { WorkspaceHandle, WorkspaceRecord } from "../../core/workspace/contract.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventBusSurface } from "../../core/events/index.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createOrchestrator } from "./orchestrator.js";
import { WorkerError, type WorkerResult, type WorkerRole, type WorkerTask } from "./contract.js";
import { preBuildRefinement, formatInterview } from "../../core/goal-refinement.js";
import { createCognitionLayer } from "../cognition-layer/cognition.js";
import { loadRepoRegistry } from "../../core/repo-registry.js";
import type { CognitionDecision, CognitionLayer } from "../cognition-layer/contract.js";

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

/** Injectable surfaces for the `ikbi diff` command (tests inject a fake workspace surface). */
export interface DiffCliDeps {
  readonly workspaces?: DiffWorkspaceSurface;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /** Colorize the diff for display. Default: on only when stdout is a TTY (never pollutes a pipe). */
  readonly colorize?: boolean;
}

/** Build the `ikbi diff <workspace-id>` handler — prints the workspace diff + a change summary. */
export function createDiffCli(deps: DiffCliDeps = {}) {
  const workspaces: DiffWorkspaceSurface = deps.workspaces ?? coreWorkspaces;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  // Only colorize for an interactive terminal — piped/redirected output stays clean ANSI-free.
  const colorize = deps.colorize ?? (process.stdout.isTTY === true);

  async function diff(argv: readonly string[]): Promise<void> {
    const id = argv[0];
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
      return;
    }
    // Colorize for terminal display only; summarizeDiff still parses the RAW text.
    const display = colorize ? colorizeDiff(text) : text;
    out(display.endsWith("\n") ? display : `${display}\n`);
    out(`\n${formatDiffSummary(summarizeDiff(text))}\n`);
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
  opts: { workerToken: string | undefined; gateWall?: GateWall; onExecOutput?: (chunk: string, stream: "stdout" | "stderr") => void; requestApproval?: (req: { taskId: string; workspaceId: string; goal: string }) => Promise<boolean> },
): { run: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult> } {
  // Explicitly thread the governed executor to BOTH roles (builder run_checks + verifier) via
  // the orchestrator. LAZY wrapper (not an eager import): importing the governed-exec singleton
  // at module scope would force the gate-wall/egress wiring order — the same reason the verifier
  // imports it lazily. (The builder also has the lazy fallback as defense-in-depth.)
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => (await import("../governed-exec/index.js")).governedExec.run(req) };
  // Explicitly thread the workspace manager (which provides commit) so the orchestrator can
  // COMMIT the verified-good work — without it the scratch branch never advances and promote
  // sees an empty diff ("no changes to promote"). coreWorkspaces is the same manager the
  // orchestrator would default to; passing it makes the commit dependency explicit.
  return createOrchestrator({ roleClaim: productionRoleClaim(opts.workerToken), gateWall: opts.gateWall ?? coreGateWall, governedExec, workspaces: coreWorkspaces, enforceProjectRoot: true, ...(opts.onExecOutput !== undefined ? { onExecOutput: opts.onExecOutput } : {}), ...(opts.requestApproval !== undefined ? { requestApproval: opts.requestApproval } : {}) });
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
 * Parse `--repo <path>` / `--repo=<path>`, `--verbose`/`-v`, `--cost`, and `--yes`/`-y`;
 * the rest is the goal prose. `--yes` skips the interactive Socratic interview prompt and
 * proceeds with the original goal (the cognition layer still runs — it is non-blocking).
 */
export function parseBuildArgs(argv: readonly string[]): { repo?: string; verbose?: boolean; cost?: boolean; yes?: boolean; rest: string[] } {
  const rest: string[] = [];
  let repo: string | undefined;
  let verbose = false;
  let cost = false;
  let yes = false;
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
    } else {
      rest.push(a);
    }
  }
  return { ...(repo !== undefined && repo.length > 0 ? { repo } : {}), ...(verbose ? { verbose } : {}), ...(cost ? { cost } : {}), ...(yes ? { yes } : {}), rest };
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
    case "worker.role.dispatched":
      return `  → ${String(p.role ?? "?")} …\n`;
    case "worker.role.completed":
      return `  ${p.outcome === "success" ? "✓" : "✗"} ${String(p.role ?? "?")}: ${String(p.outcome ?? "?")}\n`;
    case "worker.builder.activity": {
      // SG: surface context-window pressure alongside the tool-activity line when present.
      const ctxNote = typeof p.contextPercent === "number" ? `, context ${String(p.contextPercent)}%` : "";
      return `    builder: ${String(p.toolRounds ?? 0)} tool round(s), ${String(p.filesWritten ?? 0)} file(s) written${ctxNote}\n`;
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
  return `${JSON.stringify(
    {
      taskId: r.taskId,
      outcome: r.outcome,
      promoted: r.promoted,
      ...(r.workspaceId !== undefined ? { workspaceId: r.workspaceId } : {}),
      roles: r.roles.map((x) => ({ role: x.role, outcome: x.outcome })),
      // Observability (E): which hardened/legacy paths actually ran, so the operator never has
      // to inspect env/source to know the safety posture of THIS run.
      ...(r.verificationMode !== undefined ? { verification: r.verificationMode } : {}),
      ...(r.retrievalMode !== undefined ? { retrieval: r.retrievalMode } : {}),
      // Cost visibility: sum of every model invocation this run made.
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

/** Injectable surfaces so the construction + roleClaim + spawn/clamp + gate chain is testable. */
export interface WorkerCliDeps {
  /** The run surface. Default: a live orchestrator wired with the production roleClaim + real gate-wall. */
  readonly orchestrator?: { run: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult> };
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
  const eventBus: EventBusSurface = deps.events ?? coreEvents;
  // The live orchestrator via the SHARED production-worker construction (the same wiring
  // `ikbi batch` uses, so build + batch are governed identically). Construction is
  // side-effect-free; roleClaim only throws when CALLED with no worker token (the handler
  // refuses before that). SG-1: stream the governed check output live to the operator's stdout.
  // SG-10: wire the human-approval gate when explicitly provided or when IKBI_REQUIRE_APPROVAL is set.
  const requestApproval = deps.approvalPrompt ?? (approvalRequiredFromEnv() ? stdinApprovalPrompt : undefined);
  const orchestrator = deps.orchestrator ?? createProductionWorker({ workerToken, gateWall, onExecOutput: (chunk) => out(chunk), ...(requestApproval !== undefined ? { requestApproval } : {}) });
  const prompt = deps.prompt ?? promptUser;
  // Default to interactive ONLY when stdin is a real terminal — a piped/redirected/CI stdin
  // never blocks the build waiting for an answer that can't come.
  const interactive = deps.interactive ?? (process.stdin.isTTY === true);

  async function build(argv: readonly string[]): Promise<void> {
    const { repo, verbose, cost, yes, rest } = parseBuildArgs(argv);
    const goal = rest.join(" ").trim();
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

    // H1: resolve the target repo BEFORE any work. Only fall back to cwd when --repo was NOT given.
    // An explicit --repo that does not resolve (a typo'd alias) must FAIL LOUDLY — never silently
    // run the build against the wrong directory (cwd).
    let targetRepo: string;
    if (repo === undefined || repo.length === 0) {
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

    const refinement = preBuildRefinement(goal, cognitionResult);
    // `--yes` (or a non-interactive session) skips the BLOCKING interview prompt entirely and
    // proceeds with the original goal. The cognition layer above still ran (non-blocking).
    const skipInterview = yes === true || !interactive;
    if (skipInterview) {
      // M4: a cognition `reject` is ADVISORY at this layer — `--yes` (or a non-interactive
      // session) deliberately proceeds rather than aborting. Design choice: `--yes` means
      // "don't prompt me", and deliberation can be wrong, so we warn-and-proceed instead of
      // blocking. But silently discarding a reject hides a real signal, so surface it on
      // STDERR (not stdout — it must not pollute machine-readable output) before proceeding.
      if (cognitionResult?.decision === "reject") {
        err(`ikbi: warning: deliberation REJECTED this goal but --yes/non-interactive proceeds anyway: ${cognitionResult.rationale ?? "(no rationale)"}\n`);
      }
      // Nothing interactive to do — proceed with the original goal.
    } else if (!refinement.proceed && refinement.interview !== undefined) {
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

    const task: WorkerTask = { taskId: id, targetRepo, goal: finalGoal, writeScope: detectWriteScope(finalGoal) };

    // STEP-PLANNER: decompose complex goals into atomic steps for cheap models.
    const { decompose } = await import("../step-planner/index.js");
    const stepPlan = decompose(finalGoal);

    // SG-5: with --verbose, stream the build's structured progress events (per-role start/end,
    // builder tool activity, verification status) live as they fire.
    const sub = verbose === true ? eventBus.subscribe({ typePrefix: "worker." }, (e) => out(formatProgressEvent(e))) : undefined;
    try {
      let result: WorkerResult;

      if (stepPlan.decomposed && stepPlan.steps.length > 1) {
        // MULTI-STEP: run each step sequentially through the orchestrator.
        // Changes accumulate in the same workspace across steps.
        out(`  ↳ decomposed into ${stepPlan.steps.length} steps\n`);
        let lastResult: WorkerResult | undefined;
        for (const step of stepPlan.steps) {
          out(`  → step ${step.index}/${stepPlan.steps.length}: ${step.goal}\n`);
          const stepTask: WorkerTask = {
            taskId: `${id}:step${step.index}`,
            targetRepo,
            goal: step.goal,
            writeScope: detectWriteScope(step.goal),
          };
          lastResult = await orchestrator.run(stepTask, ctx);
          if (lastResult.outcome !== "success") {
            out(`  ✗ step ${step.index} failed: ${lastResult.reason ?? lastResult.outcome}\n`);
            result = lastResult;
            break;
          }
          out(`  ✓ step ${step.index} passed\n`);
        }
        // If all steps passed, use the last result.
        result = lastResult!;
      } else {
        // SINGLE-STEP: run directly.
        result = await orchestrator.run(task, ctx);
      }
      if (sub !== undefined) await eventBus.flush(); // drain the progress lines before the summary
      // A gate denial / non-promote is a CLEAN outcome (printed), not an error.
      out(summarize(result));
      // ISSUE 3: surface the repair report (root cause / files / rationale / tests) when present.
      out(formatRepairNarrative(result));
      // --cost: print the run's total model cost as a human one-liner after the build.
      if (cost === true) out(`${formatCost(result.costUsd)}\n`);
      // SG-2: after the run, show a one-line diff summary of what changed (best-effort).
      if (result.workspaceId !== undefined) await printDiffSummary(result.workspaceId);
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
  usage: "ikbi build <goal...> [--repo <path>] [--verbose] [--cost] [--yes]",
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
