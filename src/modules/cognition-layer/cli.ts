/**
 * ikbi cognition-layer — the DEFAULT CLI router (`ikbi <goal>`).
 *
 * When `ikbi` is given input that is not a known command, the CLI treats the whole
 * input as a GOAL and routes it here: resolve the operator identity, `deliberate()`,
 * and REPORT the structured decision + the recommended next command. It does NOT
 * auto-execute the recommendation — cognition recommends, never invokes; the operator
 * runs the suggested command. (An opt-in `--run` auto-dispatch is a future addition.)
 *
 * This is NOT a registered command — it is the dispatch fallback, wired in
 * `src/cli/index.ts`'s default case. Fail-closed + friendly: a missing operator token
 * or a model error prints a clear message and exits non-zero; never a raw stack.
 */

import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, ValidatedIdentity } from "../../core/identity/index.js";
import { cognitionLayer as coreCognition } from "./cognition.js";
import type { CognitionDecision, CognitionLayer } from "./contract.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse a `--project <name>` / `--project=<name>` flag; the rest is the goal prose. */
export function parseRouterArgs(argv: readonly string[]): { project?: string; rest: string[] } {
  const rest: string[] = [];
  let project: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--project") {
      project = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--project=")) {
      project = a.slice("--project=".length);
    } else {
      rest.push(a);
    }
  }
  return { ...(project !== undefined && project.length > 0 ? { project } : {}), rest };
}

/** Map the decision's recommendedNext to a concrete `ikbi` command the operator can run. */
export function suggestedCommand(d: CognitionDecision, goal: string): string {
  const q = JSON.stringify(goal);
  const r = d.recommendedNext;
  if (r !== undefined) {
    switch (r.module) {
      case "batch-planner":
        return `ikbi batch ${q}`;
      case "worker-model":
        return `ikbi build ${q}`;
      case "agent-router":
        return r.action === "classify" ? `ikbi classify ${q}` : `ikbi ask ${q}`;
      case "drift-prevention":
        return "(reliability check — no direct command)";
    }
  }
  if (d.decision === "ask" || d.decision === "reject") return `clarify: ${(d.missingInfo ?? []).join("; ") || "more detail needed"}`;
  if (d.decision === "warn") return `caution: ${(d.risks ?? []).join("; ") || "review the risk before proceeding"}`;
  return "(no further action recommended)";
}

/** Injectable surfaces so the router is testable without a live model/network. */
export interface CognitionRouterDeps {
  readonly cognition?: CognitionLayer;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
}

/** Build the default-router handler. Defaults wire the live cognition layer + identity. */
export function createCognitionRouter(deps: CognitionRouterDeps = {}) {
  const cognition = deps.cognition ?? coreCognition;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;

  async function route(argv: readonly string[]): Promise<void> {
    const { project, rest } = parseRouterArgs(argv);
    const goal = rest.join(" ").trim();
    if (goal.length === 0) {
      err("ikbi: nothing to deliberate — usage: ikbi <goal...> [--project <name>]\n");
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

    const ctx = beginOperation(who, { requestId: `route-${now()}` });
    try {
      const d = await cognition.deliberate({ parentCtx: ctx, goal, ...(project !== undefined ? { project } : {}) });
      out(
        [
          `decision: ${d.decision} (confidence ${Math.round(d.confidence * 100)}%)`,
          `rationale: ${d.rationale}`,
          ...(d.memoryUsed.length > 0 ? [`memory used: ${d.memoryUsed.length} entr${d.memoryUsed.length === 1 ? "y" : "ies"}`] : []),
          `next: ${suggestedCommand(d, goal)}`,
          "",
        ].join("\n"),
      );
    } catch (e) {
      err(`ikbi: deliberation failed: ${errMsg(e)} — check IKBI_MIMO_API_KEY / providers.json / network\n`);
      setExit(1);
    }
  }

  return { route };
}

/** The default process-wide router (the CLI dispatch fallback calls this). */
export const cognitionRouter = createCognitionRouter();
