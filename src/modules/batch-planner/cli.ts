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
import { batchPlanner as coreBatchPlanner } from "./planner.js";
import type { BatchPlanner, BatchResult } from "./contract.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse a `--repo <path>` / `--repo=<path>` flag; the rest is the goal prose. */
export function parseBatchArgs(argv: readonly string[]): { repo?: string; rest: string[] } {
  const rest: string[] = [];
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--repo") {
      repo = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
    } else {
      rest.push(a);
    }
  }
  return { ...(repo !== undefined && repo.length > 0 ? { repo } : {}), rest };
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
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
  readonly cwd?: () => string;
}

/** Build the `batch` command handler. Defaults wire the live planner + identity. */
export function createBatchCli(deps: BatchCliDeps = {}) {
  const planner = deps.planner ?? coreBatchPlanner;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? (() => process.cwd());

  async function batch(argv: readonly string[]): Promise<void> {
    const { repo, rest } = parseBatchArgs(argv);
    const goal = rest.join(" ").trim();
    if (goal.length === 0) {
      err("ikbi: batch needs a goal — usage: ikbi batch <goal...> [--repo <path>]\n");
      setExit(1);
      return;
    }
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
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
      const result = await planner.planAndRun({ parentCtx: ctx, goal, targetRepo: repo ?? cwd() });
      out(summarize(result));
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
  usage: "ikbi batch <goal...> [--repo <path>]",
  run: (argv) => live.batch(argv),
});
