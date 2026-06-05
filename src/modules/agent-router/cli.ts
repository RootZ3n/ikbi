/**
 * ikbi agent-router — CLI commands (`ikbi classify` / `ikbi ask`).
 *
 * The first REAL engine entrypoint: these commands resolve the operator identity
 * (IKBI_OPERATOR_TOKEN), begin an operation, and invoke the live agent-router — the
 * full chain barrel → identity → neutralize → model → result. They register at
 * module-import time (the modules barrel imports agent-router, which imports this
 * file), so they are live once ikbi starts. No built-in collision (version/models/
 * providers/help).
 *
 * Fail-closed + friendly: a missing operator token or a model/auth/network error
 * prints a clear, actionable message to stderr and exits non-zero — never a raw stack.
 *
 * REAL SMOKE TEST (needs a live model endpoint + key):
 *   IKBI_OPERATOR_TOKEN=<32+ char token> IKBI_MIMO_API_KEY=<key> pnpm build && \
 *     node dist/cli/index.js classify "build the demo project"
 *   node dist/cli/index.js ask "what happened in demo?" --project demo
 * Without those it fails closed with a clear error (no token / model call failed).
 */

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, OperationContext, ValidatedIdentity } from "../../core/identity/index.js";
import { agentRouter as coreAgentRouter } from "./router.js";
import type { AgentRouter } from "./contract.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse a `--project <name>` / `--project=<name>` flag out of argv; rest is the prose. */
export function parseProject(argv: readonly string[]): { project?: string; rest: string[] } {
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

/** Injectable surfaces so the command chain is testable without a live model/network. */
export interface RouterCliDeps {
  readonly router?: AgentRouter;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  /** Operator token (default: the core config's IKBI_OPERATOR_TOKEN). */
  readonly operatorToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
}

/** Build the classify/ask command handlers. Defaults wire the LIVE singletons. */
export function createRouterCli(deps: RouterCliDeps = {}) {
  const router = deps.router ?? coreAgentRouter;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;

  /** Resolve the operator into an OperationContext, or print a friendly error + return undefined. */
  function operatorCtx(reqPrefix: string): OperationContext | undefined {
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return undefined;
    }
    let who: ValidatedIdentity;
    try {
      who = resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)} — check IKBI_OPERATOR_TOKEN / the agents registry\n`);
      setExit(1);
      return undefined;
    }
    return beginOperation(who, { requestId: `${reqPrefix}-${now()}` });
  }

  async function classify(argv: readonly string[]): Promise<void> {
    const message = argv.join(" ").trim();
    if (message.length === 0) {
      err("ikbi: classify needs a message — usage: ikbi classify <message...>\n");
      setExit(1);
      return;
    }
    const ctx = operatorCtx("classify");
    if (ctx === undefined) return;
    try {
      const result = await router.classify({ parentCtx: ctx, message });
      out(`${JSON.stringify(result, null, 2)}\n`);
    } catch (e) {
      err(`ikbi: model call failed: ${errMsg(e)} — check IKBI_MIMO_API_KEY / providers.json / network\n`);
      setExit(1);
    }
  }

  async function ask(argv: readonly string[]): Promise<void> {
    const { project, rest } = parseProject(argv);
    const question = rest.join(" ").trim();
    if (question.length === 0) {
      err("ikbi: ask needs a question — usage: ikbi ask <question...> [--project <name>]\n");
      setExit(1);
      return;
    }
    const ctx = operatorCtx("ask");
    if (ctx === undefined) return;
    try {
      const result = await router.ask({ parentCtx: ctx, question, ...(project !== undefined ? { project } : {}) });
      out(`${JSON.stringify(result, null, 2)}\n`);
    } catch (e) {
      err(`ikbi: model call failed: ${errMsg(e)} — check IKBI_MIMO_API_KEY / providers.json / network\n`);
      setExit(1);
    }
  }

  return { classify, ask };
}

// Register the LIVE commands at import time (the modules barrel triggers this).
const live = createRouterCli();
registerCommand({
  name: "classify",
  summary: "Classify the intent of a message",
  usage: "ikbi classify <message...>",
  run: (argv) => live.classify(argv),
});
registerCommand({
  name: "ask",
  summary: "Ask a question over lab memory",
  usage: "ikbi ask <question...> [--project <name>]",
  run: (argv) => live.ask(argv),
});
