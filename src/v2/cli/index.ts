/**
 * ikbi v2 — THE CANONICAL (EXPERIMENTAL) ENTRYPOINT: `ikbi v2 build "<goal>"`.
 *
 *   ikbi v2 build "<goal>" [--repo <path>] [--strategy single|shadow|tournament] [--json]
 *
 * It registers through the ordinary v1 command-registrar seam, so `ikbi build` and
 * every other existing command are byte-unchanged. It is marked `advanced` so it does
 * not appear in the default help, and it announces itself as experimental on stderr.
 *
 * WHAT IT DOES TODAY: enters the canonical v2 lifecycle and reports, truthfully, that
 * the run stopped after preflight because the next stage is not implemented in this
 * build. It makes no model call, allocates no workspace, mutates no file, and promotes
 * nothing — and the receipt it prints is COUNTED from the lifecycle's evidence ledger,
 * so it cannot claim otherwise.
 *
 * This file is intentionally thin: argv parsing plus rendering. All authority lives in
 * `src/v2/core/run.ts`, which is what makes the production-reachability test meaningful.
 */

import { registerCommand } from "../../cli/registry.js";
import { writeStdout, writeStderr } from "../../cli/io.js";
import type { ConfigurationSource } from "../core/config.js";
import { CANDIDATE_STRATEGIES } from "../core/contract.js";
import { exitCodeForOutcome, formatOutcome, type V2RunResult } from "../core/result.js";
import { runV2BuildProduction } from "../runtime/index.js";

export const V2_USAGE = `Usage: ikbi v2 build "<goal>" [--repo <path>] [--strategy ${CANDIDATE_STRATEGIES.join("|")}] [--profile <name>] [--json]`;

/** The experimental banner. On stderr so `--json` stdout stays machine-clean. */
export const V2_BANNER =
  "ikbi v2: EXPERIMENTAL architecture probe — the v2 lifecycle skeleton. No model call, no mutation, no promotion.\n";

interface V2Args {
  readonly subcommand: string | undefined;
  readonly goal: string;
  readonly repo: string;
  readonly strategy: string | undefined;
  /** Per-run profile override. Absent means "use the operator's standing selection". */
  readonly profile: string | undefined;
  readonly json: boolean;
}

/** Parse `v2 build <goal…> [flags]`. Unflagged words after the subcommand form the goal. */
export function parseV2Args(argv: readonly string[], cwd: string): V2Args {
  const subcommand = argv[0];
  const words: string[] = [];
  let repo = cwd;
  let strategy: string | undefined;
  let profile: string | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") json = true;
    else if (a === "--repo") {
      const v = argv[i + 1];
      if (v !== undefined) repo = v;
      i += 1;
    } else if (a === "--strategy") {
      const v = argv[i + 1];
      if (v !== undefined) strategy = v;
      i += 1;
    } else if (a === "--profile") {
      const v = argv[i + 1];
      if (v !== undefined) profile = v;
      i += 1;
    } else if (!a.startsWith("-")) words.push(a);
  }
  return {
    subcommand,
    goal: words.join(" "),
    repo,
    strategy,
    profile,
    json,
  };
}

/** Human rendering of a run. Every line is derived from the result — nothing is asserted. */
export function renderRun(result: V2RunResult): string {
  const e = result.receipt.evidence;
  const lines = [
    `task        ${result.taskId}`,
    `run         ${result.runId}`,
    `repo        ${result.repoPath}`,
    `stages      ${result.receipt.stagesEntered.join(" -> ") || "<none>"}`,
    ...configurationLines(result),
    `outcome     ${formatOutcome(result.outcome)}`,
    "evidence    " +
      `provider_invoked=${e.providerInvoked} candidates=${e.candidatesCreated} ` +
      `verifications=${e.verificationsPerformed} promoted=${e.promoted} repo_mutated=${e.repositoryMutated}`,
    `receipt     ${result.receipt.receiptId}`,
  ];
  // The outcome line already carries the failure sentence; what it lacks is the stable
  // machine code an operator can grep for or quote in a bug report.
  if (result.outcome.kind === "failed") lines.push(`code        ${result.outcome.failure.code}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The configuration block — the answer to "what strategy did this run actually see?".
 * Rendered from the resolved policy, so it is silent when no policy was built and
 * never speculates about one that was not.
 */
function configurationLines(result: V2RunResult): string[] {
  const summary = result.receipt.configuration;
  if (summary === undefined) return [];
  const policy = result.policy;
  const roles = (policy?.rolePreferences ?? [])
    .map((p) => `${p.role}=${p.modelId}${p.satisfiable ? "" : " (unsatisfiable)"} [${p.source}]`)
    .join(", ");
  const lines = [
    `profile     ${summary.profile ?? "(none)"} [${summary.profileSource}]`,
    `policy      ${summary.policyId}`,
    `providers   ${summary.providersConfigured} configured / ${policy?.inventory.providers.length ?? 0} registered` +
      ` · ${summary.modelsInvocable} invocable model(s)`,
  ];
  if (roles.length > 0) lines.push(`roles       ${roles}`);
  if (summary.unsatisfiableRequiredRoles.length > 0) {
    lines.push(`warning     required role(s) not currently invocable: ${summary.unsatisfiableRequiredRoles.join(", ")}`);
  }
  return lines;
}

/**
 * Test seam: the command body, with injectable output sinks and — for hermetic tests —
 * an injectable configuration source. The REGISTERED command passes none of these, so
 * production always runs the real wiring; the subprocess suite is what proves that.
 */
export async function runV2Cli(
  argv: readonly string[],
  io: {
    readonly stdout?: (s: string) => void;
    readonly stderr?: (s: string) => void;
    readonly cwd?: string;
    readonly configuration?: ConfigurationSource;
  } = {},
): Promise<number> {
  const out = io.stdout ?? writeStdout;
  const err = io.stderr ?? writeStderr;
  const args = parseV2Args(argv, io.cwd ?? process.cwd());

  if (args.subcommand !== "build") {
    err(`${V2_USAGE}\n`);
    err(`ikbi v2: unknown subcommand ${args.subcommand === undefined ? "<none>" : `"${args.subcommand}"`} (only "build" exists in this slice)\n`);
    return 2;
  }

  err(V2_BANNER);
  const result = await runV2BuildProduction(
    {
      goal: args.goal,
      repoPath: args.repo,
      ...(args.strategy !== undefined ? { candidateStrategy: args.strategy } : {}),
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
    },
    io.configuration !== undefined ? { configuration: io.configuration } : {},
  );
  out(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderRun(result));
  return exitCodeForOutcome(result.outcome);
}

registerCommand({
  name: "v2",
  category: "advanced",
  summary: "EXPERIMENTAL: enter the v2 canonical lifecycle (skeleton — builds nothing yet)",
  usage: V2_USAGE,
  run: async (argv) => {
    const code = await runV2Cli(argv);
    if (code !== 0) process.exitCode = code;
  },
});
