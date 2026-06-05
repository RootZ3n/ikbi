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

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, OperationContext, ValidatedIdentity } from "../../core/identity/index.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import { createOrchestrator } from "./orchestrator.js";
import { WorkerError, type WorkerResult, type WorkerRole, type WorkerTask } from "./contract.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
export function createProductionWorker(
  opts: { workerToken: string | undefined; gateWall?: GateWall },
): { run: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult> } {
  return createOrchestrator({ roleClaim: productionRoleClaim(opts.workerToken), gateWall: opts.gateWall ?? coreGateWall });
}

/** Parse a `--repo <path>` / `--repo=<path>` flag out of argv; the rest is the goal prose. */
export function parseBuildArgs(argv: readonly string[]): { repo?: string; rest: string[] } {
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

/** A concise, non-leaky result summary for the operator. */
function summarize(r: WorkerResult): string {
  return `${JSON.stringify(
    {
      taskId: r.taskId,
      outcome: r.outcome,
      promoted: r.promoted,
      ...(r.workspaceId !== undefined ? { workspaceId: r.workspaceId } : {}),
      roles: r.roles.map((x) => ({ role: x.role, outcome: x.outcome })),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    },
    null,
    2,
  )}\n`;
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
}

/** Build the `build` command handler. Defaults wire the live singletons + REAL gate-wall. */
export function createWorkerCli(deps: WorkerCliDeps = {}) {
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const workerToken = "workerToken" in deps ? deps.workerToken : config.identity.workerToken;
  const gateWall = deps.gateWall ?? coreGateWall;
  // The live orchestrator via the SHARED production-worker construction (the same wiring
  // `ikbi batch` uses, so build + batch are governed identically). Construction is
  // side-effect-free; roleClaim only throws when CALLED with no worker token (the handler
  // refuses before that).
  const orchestrator = deps.orchestrator ?? createProductionWorker({ workerToken, gateWall });
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? (() => process.cwd());

  async function build(argv: readonly string[]): Promise<void> {
    const { repo, rest } = parseBuildArgs(argv);
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
    const task: WorkerTask = { taskId: id, targetRepo: repo ?? cwd(), goal };

    try {
      const result = await orchestrator.run(task, ctx);
      // A gate denial / non-promote is a CLEAN outcome (printed), not an error.
      out(summarize(result));
    } catch (e) {
      err(`ikbi: build failed: ${errMsg(e)}\n`);
      setExit(1);
    }
  }

  return { build };
}

// Register the LIVE command at import time (the modules barrel triggers this).
const live = createWorkerCli();
registerCommand({
  name: "build",
  summary: "Run a worker build pipeline toward a goal",
  usage: "ikbi build <goal...> [--repo <path>]",
  run: (argv) => live.build(argv),
});
