/**
 * launch_build — Pehlichi's bridge from teaching to doing.
 *
 * After Peh and the user have shaped a clear goal AND the user has confirmed, Peh calls this to run
 * the REAL, fully-governed `ikbi build` pipeline (plan → build → verify → promote) on the selected
 * repo. It shells out to the SAME `ikbi build` CLI so it inherits every existing guard — worker
 * roles, verification ladder, promote gate, receipts — with no re-implementation and no governance
 * hole. The goal is passed as a single argv element (never shell-interpolated), so it cannot inject.
 * The tool is confirm-gated in the session (see session.ts): a build never launches without approval.
 */

import { spawn } from "node:child_process";

import type { ModelTool } from "../../core/provider/contract.js";

export const launchBuildTool: ModelTool = {
  name: "launch_build",
  description:
    "Launch a REAL ikbi build with an agreed goal. Runs the full governed pipeline (plan → build → " +
    "verify → promote) on the selected repo and returns the outcome. Use ONLY after you and the user " +
    "have shaped a clear, specific, verifiable goal AND the user has said they want to run it — the " +
    "user is asked to confirm before it runs. Keep goals small and well-scoped.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The concrete, verifiable goal — what to build or fix (a single well-scoped task)." },
    },
    required: ["goal"],
  },
};

export interface LaunchBuildResult {
  readonly ok: boolean;
  /** The (untrusted) build output — re-enters the conversation via the neutralization chokepoint. */
  readonly output: string;
  /** A one-line activity summary for the REPL. */
  readonly summary: string;
}

/** Max wall-clock for a Peh-launched build before we give up on the subprocess (10 min). */
const LAUNCH_BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * Run `ikbi build "<goal>" --repo <repo>` as a governed subprocess. `cliEntry` is the running ikbi
 * CLI script (process.argv[1]); `execPath` is the node binary (process.execPath). Both injected for
 * testability. The cheap tier keeps Peh's builds on the cheap roster by default.
 */
export async function runLaunchBuild(
  args: { readonly goal?: unknown; readonly repo?: unknown },
  ctx: {
    readonly sessionRepo: string | undefined;
    readonly cliEntry: string;
    readonly execPath: string;
    readonly spawnFn?: typeof spawn;
    readonly timeoutMs?: number;
    readonly warn?: (message: string) => void;
    /** The operator's standing instructions (~/.ikbi/instructions.md), threaded to the build so a
     *  Peh-launched build honors the same baseline preferences the chat session does. */
    readonly standingInstructions?: string;
  },
): Promise<LaunchBuildResult> {
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  if (goal.length === 0) {
    return { ok: false, output: "ERROR: launch_build needs a non-empty 'goal' (what to build or fix).", summary: "no goal" };
  }
  if (Object.prototype.hasOwnProperty.call(args, "repo")) {
    (ctx.warn ?? console.warn)("launch_build: ignoring model-supplied repo; using the session repo");
  }
  const repo = ctx.sessionRepo;
  if (repo === undefined || repo.length === 0) {
    return {
      ok: false,
      output: "ERROR: no target repo. Reopen with `ikbi peh --repo <path>`, or tell me the repo path to build in.",
      summary: "no repo",
    };
  }
  const spawnFn = ctx.spawnFn ?? spawn;
  const cmdArgs = [ctx.cliEntry, "build", goal, "--repo", repo, "--yes", "--tier", "cheap", "--cost"];
  // Standing instructions travel to the build via the environment (never argv/goal — no injection,
  // no pollution of the goal string the step-planner decomposes). `ikbi build` folds a non-empty
  // IKBI_BUILD_EXTRA_INSTRUCTIONS into the build's project instructions for every role.
  const instructions = typeof ctx.standingInstructions === "string" ? ctx.standingInstructions.trim() : "";
  const childEnv = instructions.length > 0 ? { ...process.env, IKBI_BUILD_EXTRA_INSTRUCTIONS: instructions } : process.env;

  let out = "";
  const code = await new Promise<number>((resolvePromise) => {
    let settled = false;
    const finish = (c: number): void => { if (!settled) { settled = true; resolvePromise(c); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(ctx.execPath, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    } catch (e) {
      out += `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
      finish(1);
      return;
    }
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* best-effort */ } out += "\n[launch_build: timed out]"; finish(124); }, ctx.timeoutMs ?? LAUNCH_BUILD_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", (e) => { out += `\nspawn error: ${e.message}`; clearTimeout(timer); finish(1); });
    child.on("close", (c) => { clearTimeout(timer); finish(c ?? 1); });
  });

  const promoted = /"promoted":\s*true|Undo available:\s*(?!no)|ikbi undo build-/.test(out);
  // Keep the reply bounded: the tail carries the build's own outcome summary + next steps.
  const tail = out.split("\n").slice(-45).join("\n").trim();
  const verdict = promoted ? "PROMOTED" : code === 0 ? "completed (not promoted)" : `did not complete (exit ${code})`;
  return {
    ok: code === 0,
    output: `ikbi build on ${repo} — ${verdict}.\nGoal: ${goal}\n\n--- build output (tail) ---\n${tail}`,
    summary: promoted ? "build promoted" : verdict,
  };
}
