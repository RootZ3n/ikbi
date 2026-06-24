/**
 * ikbi batch-planner — the `ikbi batch` CLI command.
 *
 * Decomposes a large goal into dependency-ordered subtasks and runs each as a normal
 * governed worker build. Registers at module-import time (the modules barrel imports
 * batch-planner). No built-in collision (version/models/providers/help/build).
 *
 * Fail-closed + friendly: a missing operator token prints a clear, actionable message
 * and exits non-zero; a rejected decomposition / stopped batch is a clean reported
 * outcome, not a crash; never a raw stack.
 *
 * REAL SMOKE TEST (side-effecting — needs tokens + model key + a target git repo):
 *   IKBI_OPERATOR_TOKEN=<32+> IKBI_WORKER_TOKEN=<32+> IKBI_MIMO_API_KEY=<key> \
 *     pnpm build && node dist/cli/index.js batch "add a CLI and a config loader and tests" --repo /path/to/repo
 *   It makes one decomposition model call, then runs each subtask as a governed build
 *   (real worktrees, model calls, promotes). Without tokens/key/repo it fails closed.
 */

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, ValidatedIdentity } from "../../core/identity/index.js";
import { createProductionWorker } from "../worker-model/cli.js";
import { createBatchPlanner } from "./planner.js";
import type { BatchPlanner, BatchResult } from "./contract.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse `--repo <path>`/`--repo=<path>` and `--dry-run`; the rest is the goal prose. */
export function parseBatchArgs(argv: readonly string[]): { repo?: string; dryRun: boolean; rest: string[] } {
  const rest: string[] = [];
  let repo: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--repo") {
      repo = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
    } else if (a === "--dry-run") {
      dryRun = true;
    } else {
      rest.push(a);
    }
  }
  return { ...(repo !== undefined && repo.length > 0 ? { repo } : {}), dryRun, rest };
}

/** Human-readable plan preview for `--dry-run`: the dependency levels and their subtasks. */
function renderDryRunPlan(r: BatchResult): string {
  if (r.plan === undefined) return `(no plan — ${r.reason ?? "decomposition produced nothing"})\n`;
  const byId = new Map(r.plan.subtasks.map((s) => [s.subtaskId, s]));
  const lines: string[] = [];
  lines.push(`Dry run — ${r.plan.subtasks.length} subtask(s) across ${r.plan.levels.length} dependency level(s). Nothing was built.`);
  lines.push("");
  r.plan.levels.forEach((level, i) => {
    lines.push(`Level ${i} (${level.length === 1 ? "1 subtask" : `${level.length} subtasks, run in parallel`}):`);
    for (const id of level) {
      const st = byId.get(id);
      lines.push(`  • ${id}: ${st?.goal ?? "(unknown)"}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

/** A concise, non-leaky batch summary (plan shape + per-subtask outcomes + status). */
function summarize(r: BatchResult): string {
  return `${JSON.stringify(
    {
      batchId: r.batchId,
      status: r.status,
      promotedCount: r.promotedCount,
      ...(r.plan !== undefined ? { levels: r.plan.levels, subtaskCount: r.plan.subtasks.length } : {}),
      outcomes: r.outcomes.map((o) => ({ subtaskId: o.subtaskId, level: o.level, status: o.status, promoted: o.promoted })),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    },
    null,
    2,
  )}\n`;
}

/** Injectable surfaces so the command is testable without a live model/network. */
export interface BatchCliDeps {
  readonly planner?: BatchPlanner;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly workerToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
  readonly cwd?: () => string;
}

/** Build the `batch` command handler. Defaults wire the PRODUCTION governed worker + identity. */
export function createBatchCli(deps: BatchCliDeps = {}) {
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const workerToken = "workerToken" in deps ? deps.workerToken : config.identity.workerToken;
  // C2: each subtask runs through the SAME governed worker `ikbi build` uses — the shared
  // createProductionWorker (shared-worker roleClaim + REAL gate-wall), injected as the
  // planner's runWorker. NOT the bare coreRunWorker default (which throws on the unwired
  // worker). The gate-wall is wired INSIDE the helper, so batch-planner never imports it.
  const planner = deps.planner ?? createBatchPlanner({ runWorker: createProductionWorker({ workerToken }).run });
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? (() => process.cwd());

  async function batch(argv: readonly string[]): Promise<void> {
    const { repo, dryRun, rest } = parseBatchArgs(argv);
    const goal = rest.join(" ").trim();
    if (goal.length === 0) {
      err("ikbi: batch needs a goal — usage: ikbi batch <goal...> [--repo <path>] [--dry-run]\n");
      setExit(1);
      return;
    }
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return;
    }
    // C2: batch runs governed worker builds — the worker credential is required, same as
    // `ikbi build`. Fail closed before any decomposition/run. (A --dry-run plans only and
    // never runs a worker, so it does not require the worker credential.)
    if (!dryRun && (workerToken === undefined || workerToken.length === 0)) {
      err("ikbi: no worker credential — set IKBI_WORKER_TOKEN (see the worker-agent bootstrap)\n");
      setExit(1);
      return;
    }
    let who: ValidatedIdentity;
    try {
      who = resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)} — check IKBI_OPERATOR_TOKEN / the agents registry\n`);
      setExit(1);
      return;
    }

    const ctx = beginOperation(who, { requestId: `batch-${now()}` });
    try {
      const result = await planner.planAndRun({ parentCtx: ctx, goal, targetRepo: repo ?? cwd(), ...(dryRun ? { dryRun: true } : {}) });
      if (dryRun) {
        out(renderDryRunPlan(result));
        if (result.status === "completed") out("\nNext:\n  → Run the same command without --dry-run to build the plan.\n");
      } else {
        out(summarize(result));
      }
      // A rejected/stopped batch is a clean reported outcome — exit non-zero so a script can detect it.
      if (result.status !== "completed") setExit(1);
    } catch (e) {
      err(`ikbi: batch failed: ${errMsg(e)} — check IKBI_MIMO_API_KEY / providers.json / network\n`);
      setExit(1);
    }
  }

  return { batch };
}

// Register the LIVE command at import time (the modules barrel triggers this).
const live = createBatchCli();
registerCommand({
  name: "batch",
  summary: "Decompose a large goal into subtasks and build them in dependency order",
  usage: "ikbi batch <goal...> [--repo <path>] [--dry-run]",
  run: (argv) => live.batch(argv),
});
