/**
 * ikbi consult — summon a FRONTIER model for one bounded, evidence-dense decision, cheaply.
 *
 * This is the explicit-trigger surface for "call in the expensive model only when needed, the
 * cheapest way possible": a deterministic, model-free retrieval pre-pass curates the relevant
 * files, buildConsultPacket packs verbatim slices + the exact failing checks + the failure
 * trail, and ONE tool-free frontier call returns a root-cause plan (`--advise`) or a surgical
 * diff (`--patch`). The frontier model never scans the repo and never enters a tool loop.
 *
 * Never promotes, never writes: `consult` prints the plan/diff. Running it is the authorization
 * to spend at the frontier (it is operator-gated, like every other write-capable surface).
 */

import { registerCommand } from "./registry.js";
import { writeStderr, writeStdout } from "./io.js";
import { config } from "../core/config.js";
import { resolveIdentity as coreResolveIdentity } from "../core/identity/index.js";
import type { ValidatedIdentity } from "../core/identity/index.js";
import { runConsult } from "../modules/consult/index.js";
import type { ConsultRequest, ConsultResult } from "../modules/consult/index.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ConsultArgs {
  question?: string;
  repo?: string;
  mode: "advise" | "patch";
  model?: string;
  goal?: string;
  budgetBytes?: number;
  maxFiles?: number;
  json: boolean;
  badMode?: string;
}

/** Parse `ikbi consult "<question>" [flags]`. First non-flag token is the question. */
export function parseConsultArgs(argv: readonly string[]): ConsultArgs {
  const args: ConsultArgs = { mode: "advise", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--json") args.json = true;
    else if (a === "--repo") {
      const v = argv[++i];
      if (v !== undefined) args.repo = v;
    } else if (a === "--model") {
      const v = argv[++i];
      if (v !== undefined) args.model = v;
    } else if (a === "--goal") {
      const v = argv[++i];
      if (v !== undefined) args.goal = v;
    } else if (a === "--budget") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.budgetBytes = Math.floor(n);
    } else if (a === "--max-files") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.maxFiles = Math.floor(n);
    } else if (a === "--mode") {
      const m = argv[++i];
      if (m === "advise" || m === "patch") args.mode = m;
      else args.badMode = m ?? "(missing)";
    } else if (!a.startsWith("-") && args.question === undefined) {
      args.question = a;
    }
  }
  return args;
}

function formatHeader(r: ConsultResult): string {
  const tokens = r.usage.totalTokens ?? (r.usage.promptTokens ?? 0) + (r.usage.completionTokens ?? 0);
  const lowConf = r.retrieval.lowConfidence ? " (low-confidence retrieval — evidence may be incomplete)" : "";
  return (
    `ikbi consult — ${r.mode}\n` +
    `  model:     ${r.modelId} (${r.tier})\n` +
    `  evidence:  ${r.retrieval.files} file(s)${lowConf}, ${r.packet.evidence.slices.length} slice(s)` +
    `${r.packet.truncation.packetTruncated ? " [budget-trimmed]" : ""}\n` +
    `  spend:     ~${tokens} tokens\n` +
    `${"─".repeat(60)}\n`
  );
}

export interface ConsultCliDeps {
  readonly resolveIdentity?: (claim: { token: string }) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly runConsult?: (req: ConsultRequest) => Promise<ConsultResult>;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly cwd?: () => string;
}

export function createConsultCli(deps: ConsultCliDeps = {}) {
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const cwd = deps.cwd ?? (() => process.cwd());
  const consult = deps.runConsult ?? runConsult;

  async function run(argv: readonly string[]): Promise<void> {
    if (argv[0] === "--help" || argv[0] === "-h") {
      out(
        "Usage: ikbi consult \"<question>\" [--repo <path>] [options]\n\n" +
          "Summon a frontier model for ONE bounded, evidence-dense decision — cheaply. A model-free\n" +
          "retrieval pre-pass curates the relevant files; the frontier model gets verbatim code slices\n" +
          "and returns a plan or a diff. Never promotes, never writes.\n\n" +
          "Options:\n" +
          "  --repo <path>     Repo to consult over (default: cwd)\n" +
          "  --mode <m>        advise (root-cause + plan, default) | patch (a surgical diff)\n" +
          "  --goal <text>     The originating build/repair goal, for context\n" +
          "  --model <id>      Force a specific frontier model (default: cheapest-sufficient frontier)\n" +
          "  --budget <bytes>  Evidence byte budget for the packet (default ~64KB)\n" +
          "  --max-files N     Cap files pulled into the packet (default 12)\n" +
          "  --json            Emit the full result as JSON\n",
      );
      return;
    }

    const args = parseConsultArgs(argv);
    if (args.badMode !== undefined) {
      err(`ikbi: invalid --mode "${args.badMode}" (expected: advise | patch)\n`);
      setExit(1);
      return;
    }
    if (args.question === undefined || args.question.length === 0) {
      err("ikbi: a question is required — `ikbi consult \"<question>\" [--repo <path>]`\n");
      setExit(1);
      return;
    }
    const repoRoot = args.repo ?? cwd();

    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return;
    }
    let who: ValidatedIdentity;
    try {
      who = resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)} — check IKBI_OPERATOR_TOKEN\n`);
      setExit(1);
      return;
    }

    let result: ConsultResult;
    try {
      result = await consult({
        repoRoot,
        question: args.question,
        mode: args.mode,
        identity: who.identity,
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.model !== undefined ? { modelOverride: args.model } : {}),
        ...(args.budgetBytes !== undefined ? { budgetBytes: args.budgetBytes } : {}),
        ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
      });
    } catch (e) {
      err(`ikbi: consult failed: ${errMsg(e)}\n`);
      setExit(1);
      return;
    }

    if (args.json) {
      out(`${JSON.stringify({ modelId: result.modelId, tier: result.tier, mode: result.mode, retrieval: result.retrieval, usage: result.usage, cost: result.cost, answer: result.answer }, null, 2)}\n`);
    } else {
      out(`${formatHeader(result)}${result.answer}\n`);
    }
  }

  return { run };
}

// Register the LIVE command at import time (imported by cli/index.js).
const live = createConsultCli();
registerCommand({
  name: "consult",
  summary: "Summon a frontier model for one bounded, evidence-dense decision (advise/patch) — never promotes",
  usage: "ikbi consult \"<question>\" [--repo <path>] [--mode advise|patch] [--model <id>] [--json]",
  run: (argv) => live.run(argv),
});
