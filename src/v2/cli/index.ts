/**
 * ikbi v2 — THE CANONICAL (EXPERIMENTAL) ENTRYPOINT: `ikbi v2 build "<goal>"`.
 *
 *   ikbi v2 build "<goal>" [--repo <path>] [--strategy single|shadow|tournament] [--json]
 *
 * It registers through the ordinary v1 command-registrar seam, so `ikbi build` and
 * every other existing command are byte-unchanged. It is marked `advanced` so it does
 * not appear in the default help, and it announces itself as experimental on stderr.
 *
 * WHAT IT DOES TODAY: runs the COMPLETE canonical v2 lifecycle — resolve one authorized route,
 * assemble one bounded context package, run the governed builder loop in an ISOLATED candidate
 * workspace, deterministically verify the exact candidate tree, semantically review it, adjudicate
 * a lawful disposition, and — when the candidate is ELIGIBLE and the source was clean — PUBLISH it
 * to the target branch via a clean-ref CAS (which can sync a clean checked-out worktree, preserving
 * late local work in a stash). A dirty source checkout is never silently committed. Every truth
 * claim in the printed receipt is COUNTED from the lifecycle's evidence ledger, so it cannot
 * overstate OR understate what actually happened.
 *
 * This file is intentionally thin: argv parsing plus rendering. All authority lives in
 * `src/v2/core/run.ts`, which is what makes the production-reachability test meaningful.
 */

import { registerCommand } from "../../cli/registry.js";
import { writeStdout, writeStderr } from "../../cli/io.js";
import type { ConfigurationSource } from "../core/config.js";
import type { ContextSource } from "../core/context.js";
import type { InvocationTransport } from "../core/invocation.js";
import type { StateBoundMutationAuthority, WorkspaceAuthority } from "../core/workspace.js";
import type { SourceSnapshotAuthority } from "../core/source.js";
import { buildMutationScope } from "../core/mutation-scope.js";
import { CANDIDATE_STRATEGIES } from "../core/contract.js";
import { LOCAL_MODES, isLocalMode } from "../core/local-work.js";
import {
  canonicalGoalDigest,
  composedPromptBinding,
  markSuppliedToPrimary,
  ineligibleAdvisory,
  runBuildLocalHook,
  shouldStopBuild,
  toAdvisoryContextBlock,
  type BuildLocalDeps,
  type LocalAdvisoryRecord,
} from "../runtime/build-local.js";
import { createUntrustedBoundary } from "../runtime/untrusted-boundary.js";
import { createCandidateDiffSource } from "../runtime/candidate-diff.js";
import type { AdvisoryContextBlock } from "../core/prompt.js";
import { productionTransport, type LocalExecutionPolicy } from "../runtime/index.js";
import { exitCodeForOutcome, formatOutcome, type V2RunResult } from "../core/result.js";
import { runV2BuildSessionProduction, type ProductionRunDeps } from "../runtime/index.js";
import { recordBuildSessionReceipts, type RunReceiptSink } from "../runtime/run-receipt.js";
import type { V2BuildSessionResult } from "../core/session.js";
import { formatMicroUsd } from "../core/cost.js";
// SIDE-EFFECT REGISTRATION: `ikbi local` registers itself from its own file, per the CLI
// convention. Imported here because this module is the one the v1 dispatcher already loads.
import "./local.js";

const LOCAL_MODE_HINT = "[--local-mode off|assist|auto] [--require-local-success]";
export const V2_USAGE = `Usage: ikbi v2 build "<goal>" [--repo <path>] [--strategy ${CANDIDATE_STRATEGIES.join("|")}] [--profile <name>] ${LOCAL_MODE_HINT} [--json]`;
/**
 * The scope options are listed FIRST and without brackets: they are required, and a usage line
 * that showed them as optional would be lying about the only flag a build cannot start without.
 */
export const SCOPE_USAGE_HINT =
  "(--allow-path <file> | --allow-tree <dir>)... | --allow-repo-wide";

export const BUILD_USAGE = `Usage: ikbi build "<goal>" ${SCOPE_USAGE_HINT} [--repo <path>] [--strategy ${CANDIDATE_STRATEGIES.join("|")}] [--profile <name>] ${LOCAL_MODE_HINT} [--json]

Mutation scope (REQUIRED — a build states what it may change, and nothing else):
  --allow-path <file>   an exact repository-relative file this build may create/modify/delete
  --allow-tree <dir>    a repository-relative directory, and everything beneath it
  --allow-repo-wide     the whole repository; cannot be combined with the narrower options

There is no default. A build with no scope is refused before any model is called.`;

/**
 * The experimental banner. On stderr so `--json` stdout stays machine-clean.
 *
 * IT TELLS THE TRUTH ABOUT PUBLICATION (V2-016A/B1): a build runs in an isolated candidate
 * workspace, is deterministically verified and semantically reviewed, and — when the candidate is
 * adjudicated ELIGIBLE — MAY be published to the target branch (a clean-ref CAS that can also
 * synchronize a clean checked-out worktree, preserving late local work in a git stash). A DIRTY
 * source checkout is never silently committed. The banner must not under-claim what an accepted
 * run does; `render`/`buildProduction` below is the reachable path that actually publishes.
 */
export const V2_BANNER =
  "ikbi v2: EXPERIMENTAL — builds in an ISOLATED candidate workspace, then deterministically verifies and semantically reviews it. An ELIGIBLE candidate MAY BE PUBLISHED to your target branch (ref CAS; a clean checked-out worktree is synced, late local work preserved in a stash). A dirty source checkout is never silently committed.\n";

/**
 * The CANONICAL `ikbi build` banner (V2-018 cutover). This is the governed daily-driver engine —
 * NOT experimental language — and it tells the operator the truth about publication: a build runs
 * in an ISOLATED candidate workspace, is deterministically verified and semantically reviewed, and
 * an ELIGIBLE candidate MAY be published to the target branch by a clean-ref CAS (a clean checked-out
 * worktree is synced; late local work is preserved in a git stash). A dirty source checkout is never
 * silently committed. On stderr so `--json` stdout stays machine-clean.
 */
export const BUILD_BANNER =
  "ikbi build — governed v2 build engine. Builds in an ISOLATED candidate workspace, deterministically verifies and semantically reviews it; an ELIGIBLE candidate is published to your target branch by a clean-ref CAS (a clean checked-out worktree is synced, late local work preserved in a stash). A dirty source checkout is never silently committed.\n";

interface V2Args {
  readonly subcommand: string | undefined;
  readonly goal: string;
  readonly repo: string;
  readonly strategy: string | undefined;
  /** Per-run profile override. Absent means "use the operator's standing selection". */
  readonly profile: string | undefined;
  readonly json: boolean;
  /** The local advisory mode. `off` by default — a build asks Bokahli nothing unless told to. */
  readonly localMode: string;
  /** True when the operator wants a local advisory FAILURE to stop the build. Off by default. */
  readonly requireLocalSuccess: boolean;
  /** `--allow-path` — exact repository-relative files this run may change. */
  readonly allowPaths: readonly string[];
  /** `--allow-tree` — repository-relative directories this run may change, recursively. */
  readonly allowTrees: readonly string[];
  /** `--allow-repo-wide` — the whole repository, stated explicitly and never inferred. */
  readonly allowRepoWide: boolean;
  /**
   * A USAGE REFUSAL. Present when the invocation could not be understood — an unrecognized
   * option, or a known option missing its value. The caller MUST refuse the run and print this
   * instead of building. Absent means the invocation parsed cleanly.
   */
  readonly rejection?: string;
}

/**
 * Parse `v2 build <goal…> [flags]`. Unflagged words after the subcommand form the goal.
 *
 * UNRECOGNIZED OPTIONS ARE REFUSED, NEVER IGNORED. The first version of this parser dropped any
 * token it did not know and kept walking, which made two silent, dangerous things possible:
 *
 *   1. `ikbi build "…" --dry-run` — a flag that does not exist — was DISCARDED, and the build
 *      published to the operator's branch. An operator asking for a preview got a real
 *      publication. A safety flag that silently does nothing is worse than no flag at all.
 *   2. `ikbi build "set widget to 2" --strategyy shadow` — one typo'd character — dropped the
 *      option and folded its VALUE into the goal, so the engine silently built toward
 *      "set widget to 2 shadow". The operator's task was rewritten without a word said.
 *
 * Both are fail-open defaults in a system whose design rule is fail-closed, so an option this
 * parser does not recognize is a REFUSAL (`rejection`), and so is a known option whose value is
 * missing or is itself another option. `--` ends option parsing: every token after it is a goal
 * word, which is how a goal that legitimately starts with a dash gets through.
 */
export function parseV2Args(argv: readonly string[], cwd: string): V2Args {
  const subcommand = argv[0];
  const words: string[] = [];
  let repo = cwd;
  let strategy: string | undefined;
  let profile: string | undefined;
  let json = false;
  // DEFAULT OFF. A build with no --local-mode makes zero Bokahli requests and behaves exactly as
  // it did before this flag existed.
  let localMode: string = "off";
  let requireLocalSuccess = false;
  const allowPaths: string[] = [];
  const allowTrees: string[] = [];
  let allowRepoWide = false;
  let rejection: string | undefined;
  let endOfOptions = false;

  /**
   * Take the value for a value-taking option. A missing value, or a value that is itself an
   * option, is a refusal — `--repo --json` must not silently consume `--json` as a path.
   */
  const takeValue = (flag: string, next: string | undefined): string | undefined => {
    if (next === undefined || next.startsWith("-")) {
      rejection ??= `option "${flag}" requires a value`;
      return undefined;
    }
    return next;
  };

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (endOfOptions) { words.push(a); continue; }
    if (a === "--") { endOfOptions = true; continue; }
    if (a === "--json") json = true;
    else if (a === "--repo") { const v = takeValue(a, argv[i + 1]); if (v !== undefined) repo = v; i += 1; }
    else if (a === "--strategy") { const v = takeValue(a, argv[i + 1]); if (v !== undefined) strategy = v; i += 1; }
    else if (a === "--profile") { const v = takeValue(a, argv[i + 1]); if (v !== undefined) profile = v; i += 1; }
    else if (a === "--local-mode") {
      const v = takeValue(a, argv[i + 1]);
      i += 1;
      // FAIL CLOSED ON A MALFORMED VALUE. `--local-mode OFF` must not become a Bokahli call, and
      // it must not silently become `off` either — an operator who typed something ikbi cannot
      // read is owed a refusal, not a guess about which way they meant it.
      if (v !== undefined) {
        if (!isLocalMode(v)) rejection ??= `option "--local-mode" must be one of ${LOCAL_MODES.join("|")} (got ${JSON.stringify(v)})`;
        else localMode = v;
      }
    }
    else if (a === "--require-local-success") requireLocalSuccess = true;
    // THE MUTATION SCOPE. Repeatable, accumulated verbatim: this parser does not normalize,
    // deduplicate or judge the paths, so there is exactly ONE place that decides what a scope
    // means (`buildMutationScope`) and the CLI cannot drift from it.
    else if (a === "--allow-path") { const v = takeValue(a, argv[i + 1]); if (v !== undefined) allowPaths.push(v); i += 1; }
    else if (a === "--allow-tree") { const v = takeValue(a, argv[i + 1]); if (v !== undefined) allowTrees.push(v); i += 1; }
    else if (a === "--allow-repo-wide") allowRepoWide = true;
    else if (a.startsWith("-") && a !== "-") rejection ??= `unknown option "${a}"`;
    else words.push(a);
  }

  // A REJECTED PARSE YIELDS NOTHING USABLE. The goal is blanked so a caller that forgets to check
  // `rejection` cannot build toward the half-understood task — `--strategyy shadow` left "shadow"
  // sitting in the goal words, and an empty goal fails loudly where a corrupted one would not.
  return {
    subcommand,
    goal: rejection === undefined ? words.join(" ") : "",
    repo,
    strategy,
    profile,
    json,
    localMode,
    requireLocalSuccess,
    allowPaths,
    allowTrees,
    allowRepoWide,
    ...(rejection !== undefined ? { rejection } : {}),
  };
}

/**
 * Refuse an unparseable invocation: the reason, then the usage line, on stderr, exit 2.
 * Nothing is constructed, no provider is reached, and no repository is touched.
 */
function refuseUsage(command: string, rejection: string, usage: string, err: (s: string) => void): number {
  err(`${command}: ${rejection}\n${usage}\n`);
  return 2;
}

/**
 * Refuse an unusable mutation scope as a USAGE error, before anything is constructed.
 *
 * It calls the SAME `buildMutationScope` preflight uses rather than re-deciding what a scope
 * means — two implementations of an authority is how the CLI and the engine come to disagree.
 * This one only chooses the PRESENTATION: an operator who mistyped a flag gets the usage line
 * and exit 2, not a failed run with a receipt. Preflight still validates independently, which
 * is what protects the callers that never come through this parser.
 */
function refuseUnusableScope(command: string, args: V2Args, usage: string, err: (s: string) => void): number | undefined {
  const result = buildMutationScope({ allowPaths: args.allowPaths, allowTrees: args.allowTrees, repoWide: args.allowRepoWide });
  if (result.ok) return undefined;
  return refuseUsage(command, result.detail, usage, err);
}


/**
 * The isolated workspace. Rendered as the exact source state it was cut from, what was
 * observed there, and how it ended — including a cleanup that did not finish.
 */
function workspaceLines(result: V2RunResult): string[] {
  const lines: string[] = [];
  const snap = result.receipt.sourceSnapshot;
  if (snap !== undefined) {
    const c = snap.counts;
    lines.push(
      `snapshot    ${snap.snapshotId} · ${snap.clean ? "clean" : "dirty"} @ ${snap.headCommit.slice(0, 12)}` +
        (snap.clean ? "" : ` · +${c.modified} modified, ${c.deleted} deleted, ${c.untrackedIncluded} untracked, ${c.excluded} excluded`),
    );
  }
  const w = result.receipt.workspace;
  if (w !== undefined) {
    lines.push(
      `workspace   ${w.workspaceId} (donor ${w.donorWorkspaceId}) · ${w.observations} observation(s) · ${w.disposition}` +
        (w.dispositionDetail !== undefined ? ` — ${w.dispositionDetail}` : ""),
      `materialized ${w.materializedEntries} source entr${w.materializedEntries === 1 ? "y" : "ies"} from the snapshot · base ${w.baseBranch} @ ${w.baseCommit.slice(0, 12)}`,
    );
  }
  return lines;
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
    ...resolutionLines(result),
    ...contextLines(result),
    ...invocationLines(result),
    ...commandLines(result),
    ...strategyLines(result),
    ...workspaceLines(result),
    ...candidateLines(result),
    ...verificationLines(result),
    ...criticLines(result),
    ...dispositionLines(result),
    ...promotionLines(result),
    `outcome     ${formatOutcome(result.outcome)}`,
    "evidence    " +
      `provider_invoked=${e.providerInvoked} invocations=${e.invocations} commands=${e.commandsRun} mutations=${e.mutationsApplied} ` +
      `candidates=${e.candidatesCreated} verifications=${e.verificationsPerformed} promoted=${e.promoted} ` +
      `candidate_mutated=${e.candidateMutated} source_repo_mutated=${e.sourceRepositoryMutated}`,
    `receipt     ${result.receipt.receiptId}`,
  ];
  // The outcome line already carries the failure sentence; what it lacks is the stable
  // machine code an operator can grep for or quote in a bug report.
  if (result.outcome.kind === "failed") lines.push(`code        ${result.outcome.failure.code}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Render a BUILD SESSION: the recovery trail (only when there was more than one attempt or a
 * recovery decision worth stating), then the final attempt in full. A single clean attempt looks
 * exactly like the old one-attempt render, prefixed with the session id.
 */
export function renderSession(session: V2BuildSessionResult): string {
  const lines: string[] = [`session     ${session.buildSessionId} · ${session.receipt.totalAttempts} attempt(s)`];
  if (session.receipt.totalAttempts > 1 || session.recoveryDecisions.some((d) => d.authorizesNewAttempt || d.kind === "reconciliation_required")) {
    for (let i = 0; i < session.ledger.length; i += 1) {
      const a = session.ledger[i]!;
      const d = session.recoveryDecisions[i];
      const tail = d === undefined ? "" : ` — ${d.kind}${d.reason ? ` (${d.reason})` : ""}`;
      lines.push(`  attempt ${a.attemptNumber}  ${a.outcomeKind} [${a.trigger}]${tail}`);
    }
    if (session.receipt.reconciliationRequired) {
      lines.push("  NOTE      a publication landed but its post-CAS bookkeeping did not finish — RECONCILIATION REQUIRED (the ref moved; do NOT re-publish)");
    }
    lines.push("");
  }
  // The final attempt, in full — this is the authoritative outcome.
  lines.push(renderRun(session.attempts[session.attempts.length - 1]!).trimEnd());
  lines.push(...costLines(session));
  // The one id that resolves. A human render that showed a session id and several attempt run
  // ids without saying which `ikbi inspect` takes was inviting the wrong guess.
  lines.push(`inspect     ikbi inspect ${session.receipt.finalAttemptRunId}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The session cost block (V2-014). Compact and HONEST: it reports the cost the session KNOWS,
 * flags any cost it cannot know (never implying exactness), and — on a multi-attempt session —
 * attributes spend per attempt. `+ unknown usage` means the true cost is AT LEAST the figure shown.
 */
function costLines(session: V2BuildSessionResult): string[] {
  const c = session.receipt.cost;
  const unknown = c.hasUnknownCost ? " + unknown usage" : "";
  const lines = [
    "",
    `attempts    ${session.receipt.totalAttempts}`,
    `model calls ${c.totalInvocations}` + (c.failedInvocationsWithoutUsage > 0 ? ` (${c.failedInvocationsWithoutUsage} failed, cost unknown)` : ""),
    `known cost  ${c.formattedKnownCostUsd}${unknown}`,
  ];
  if (c.attempts.length > 1) {
    for (const a of c.attempts) {
      lines.push(`  attempt ${a.attemptNumber}  ${formatMicroUsd(a.knownCostMicroUsd)}${a.hasUnknownCost ? " + unknown" : ""} · ${a.invocationCount} call(s)`);
    }
  }
  if (c.roles.length > 0) {
    lines.push(`  by role   ${c.roles.map((r) => `${r.role}=${formatMicroUsd(r.knownCostMicroUsd)}${r.hasUnknownCost ? "+?" : ""}`).join(" · ")}`);
  }
  return lines;
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
 * The authorized route. Rendered only when the resolver really produced one, and worded
 * as an authorization: nothing has been invoked at this point in the lifecycle.
 */
function resolutionLines(result: V2RunResult): string[] {
  const r = result.receipt.resolution;
  if (r === undefined) return [];
  return [
    `resolved    ${r.role} -> ${r.modelId} via ${r.providerId} (wire id: ${r.providerModelId})`,
    `route       ${r.basis}, ordinal ${r.routeOrdinal + 1}/${r.routeCount}, provider ${r.providerReadiness}, preference ${r.preferenceSource}`,
    `decision    ${r.decisionId}  (authorized, NOT invoked)`,
  ];
}

/**
 * The assembled context. Rendered as an account of what a future builder would see —
 * paths, sizes and reasons — never the file bodies themselves.
 */
function contextLines(result: V2RunResult): string[] {
  const c = result.receipt.context;
  if (c === undefined) return [];
  const lines = [
    `context     ${c.artifacts} artifact(s), ~${c.estimatedInputTokens} of ${c.availableInputTokens} estimated tokens ` +
      `(window ${c.contextWindowTokens}); sources: ${c.sourcesConsulted.join(", ")}`,
    `package     ${c.packageId}`,
  ];
  const r = result.receipt.retrieval;
  if (r !== undefined) {
    // Stated as an ACCOUNT, not a boast: how much source was searched, how much matched,
    // and how much of that actually survived admission into the package.
    lines.push(
      `retrieval   ${r.algorithm} · examined ${r.examined} source file(s), ${r.matched} matched, ${r.offered} admitted` +
        `${r.duplicatesSuppressed > 0 ? `, ${r.duplicatesSuppressed} already present` : ""}`,
    );
  }
  for (const a of result.context?.artifacts ?? []) {
    lines.push(`  + ${a.category.padEnd(29)} ${a.path ?? "(task)"} · ${a.bytes}B${a.truncated ? " (truncated)" : ""} · ~${a.estimatedTokens}t`);
  }
  for (const o of result.context?.omissions ?? []) {
    lines.push(`  - ${o.category.padEnd(29)} ${o.path ?? ""} · omitted: ${o.reason}`);
  }
  return lines;
}

/**
 * The builder's model turns. The route is stated once — it is the same authorized route
 * for every turn, by design — and then each turn's served identity and usage, because
 * "what we asked for", "what we sent" and "what actually served it" are different facts
 * and a provider can answer differently on any turn.
 */
function invocationLines(result: V2RunResult): string[] {
  const calls = result.receipt.invocations;
  const first = calls[0];
  if (first === undefined) return [];
  const lines = [
    `invoked     ${first.role} -> ${first.sentProviderId}/${first.sentProviderModelId} (authorized model ${first.authorizedModelId}) · ${calls.length} turn(s)`,
  ];
  for (const [index, i] of calls.entries()) {
    lines.push(
      `  turn ${String(index + 1).padStart(2)}   served ${i.servedModelId ?? "(not reported)"} [${i.identityStatus}] · ${i.attempts} attempt · finish ${i.finishReason}` +
        (i.usage !== undefined
          ? ` · ${Object.entries(i.usage).map(([k, v]) => `${k}=${String(v)}`).join(" ") || "(no usage reported)"}`
          : ""),
    );
  }
  return lines;
}

/**
 * The READ-ONLY commands the builder ran (V2-015), when any. Program, exit and the load-bearing
 * read-only proof (workspace unchanged) — never the untrusted output body, only its hash/size.
 */
function commandLines(result: V2RunResult): string[] {
  const cmds = result.receipt.commands;
  if (cmds.length === 0) return [];
  const lines = [`commands    ${cmds.length} read-only command(s) · candidate unchanged by all`];
  for (const [index, c] of cmds.entries()) {
    lines.push(
      `  cmd ${String(index + 1).padStart(2)}    ${[c.program, ...c.args].join(" ")} · ${c.launched ? `exit ${c.exitCode ?? "?"}` : "refused"}` +
        `${c.timedOut ? " TIMED OUT" : ""} · workspace_unchanged=${c.workspaceUnchanged} · ${c.outputByteLength}B${c.outputTruncated ? " (truncated)" : ""}`,
    );
  }
  return lines;
}

/**
 * The candidate STRATEGY (V2-017): the count, every candidate's canonical evaluation, and the ONE
 * deterministic selection. Only shown for a multi-candidate strategy (shadow/tournament) — a single
 * run adds no noise. Losers stay visible even after their workspaces are reclaimed.
 */
function strategyLines(result: V2RunResult): string[] {
  const s = result.receipt.strategy;
  const cands = result.receipt.candidates;
  if (s === undefined || cands === undefined || s.candidateCount <= 1) return [];
  const lines = [`strategy    ${s.kind} · ${s.candidateCount} candidates · rule ${s.selectionRule}`];
  for (const c of cands) {
    const evalStr = c.status === "evaluated"
      ? `verification=${c.verificationVerdict ?? "?"} critic=${c.criticVerdict ?? "?"} disposition=${c.decision ?? "quarantined"}`
      : `INCOMPLETE (${c.failureCode ?? "failed"})`;
    lines.push(
      `  cand ${c.slot}   ${evalStr}${c.selected ? " · SELECTED" : ""} · cost=${c.knownCostMicroUsd}µ${c.hasUnknownCost ? "+?" : ""} · workspace=${c.workspaceCleanup}`,
    );
  }
  const sel = result.receipt.selection;
  if (sel !== undefined) {
    lines.push(sel.selectedCandidateId !== null
      ? `selected    ${sel.selectedCandidateId.slice(0, 16)} · ${sel.reason}`
      : `selected    NONE · ${sel.reason}`);
  }
  return lines;
}

/**
 * The candidate, when one exists. Ids, paths and counts — never a file body and never the
 * conversation. The claim is labelled as the builder's own words, because it is.
 */
function candidateLines(result: V2RunResult): string[] {
  const c = result.receipt.candidate;
  if (c === undefined) return [];
  return [
    `candidate   ${c.candidateId}`,
    `  tree      ${c.treeId} (from ${c.baseTreeId.slice(0, 12)}) · ${c.changed ? "CHANGED" : "unchanged"}`,
    `  work      ${c.turns} turn(s), ${c.toolCalls} tool call(s), ${c.toolFailures} refused/rejected, ${c.mutations} mutation(s)`,
    ...(c.changedPaths.length > 0 ? [`  paths     ${c.changedPaths.join(", ")}`] : []),
    `  claim     ${c.claimBelievesComplete ? "believes complete" : "does NOT believe complete"} — ${c.claimSummary.split("\n")[0] ?? ""}`,
  ];
}

/**
 * The verification, when one ran. States the verdict, the exact tree it applies to, and
 * each check's status — never a raw log. Refuses to imply a critic verdict or a promotion.
 */
function verificationLines(result: V2RunResult): string[] {
  const v = result.receipt.verification;
  if (v === undefined) return [];
  const lines = [
    `verified    ${v.verdict.toUpperCase()} · ${v.checks.length} check(s) · plan ${v.planId.slice(0, 12)}`,
    `  subject   candidate ${v.candidateId.slice(0, 16)} @ tree ${v.candidateTreeId.slice(0, 12)}`,
    `  tree      before ${v.treeBeforeChecks.slice(0, 12)} → after ${v.treeAfterChecks.slice(0, 12)} · ${v.treeUnchanged ? "unchanged" : "CHANGED BY CHECKS"}`,
  ];
  for (const c of v.checks) {
    lines.push(`  ${c.status.padEnd(22)} ${c.name} (${c.command})${c.exitCode !== null ? ` · exit ${c.exitCode}` : ""} · ${c.durationMs}ms`);
  }
  lines.push(`  id        ${v.verificationId}`);
  lines.push(`  status    ${v.verdict === "pass" ? "VERIFIED — deterministic evidence for adjudication" : "NOT VERIFIED-GOOD"} · workspace ${v.workspaceDisposition}`);
  return lines;
}

/**
 * The critic judgment, when one ran. A MODEL JUDGMENT — semantic evidence, not proof — so
 * the render says "critic thinks", names each concrete defect, and refuses to imply a
 * disposition or a promotion.
 */
function criticLines(result: V2RunResult): string[] {
  const c = result.receipt.critic;
  if (c === undefined) return [];
  const label = c.verdict === "satisfied" ? "SATISFIED" : c.verdict === "defects_found" ? "DEFECTS_FOUND" : "INDETERMINATE";
  const lines = [
    `critic      ${label} (model judgment) · ${c.defects.length} defect(s) · review ${c.reviewPackageId.slice(0, 12)}`,
    `  route     ${c.criticDecisionId.slice(0, 12)} · invocation ${c.invocationId}`,
    `  summary   ${c.summary.split("\n")[0] ?? ""}`,
  ];
  for (const d of c.defects) {
    lines.push(`  ${d.severity.padEnd(9)} ${d.category}${d.paths.length > 0 ? ` [${d.paths.join(", ")}]` : ""}: ${d.description}`);
  }
  lines.push(`  id        ${c.criticId}`);
  lines.push(`  status    SEMANTIC EVIDENCE ONLY — NOT a disposition, NOT a promotion`);
  return lines;
}

/**
 * The lawful disposition, when adjudication ran. It states the ONE decision and its reasons,
 * and — critically — refuses to imply that anything was PROMOTED. `acceptable_for_promotion`
 * is an ELIGIBILITY fact; the source is unchanged and nothing was published.
 */
function dispositionLines(result: V2RunResult): string[] {
  const d = result.receipt.disposition;
  if (d === undefined) return [];
  const label =
    d.decision === "acceptable_for_promotion" ? "ELIGIBLE FOR PROMOTION"
      : d.decision === "withhold" ? "WITHHELD"
        : d.decision === "reject" ? "REJECTED"
          : "QUARANTINED";
  const reasons = [d.primaryReason, ...d.supportingReasons].join(", ");
  // Whether a landed publication followed decides how the eligibility line reads.
  const landed = result.receipt.promotion !== undefined;
  const lines = [
    `disposition ${label} · ${reasons} · policy ${d.policyId.slice(0, 12)}`,
    `  weighs    verification ${d.verificationVerdict.toUpperCase()} + critic ${d.criticVerdict.toUpperCase()}`,
    `  flags     eligible=${d.eligibleForPromotion} requires_recovery=${d.requiresRecovery} requires_operator=${d.requiresOperator}`,
    `  id        ${d.dispositionId}`,
    `  status    ${d.eligibleForPromotion ? (landed ? "AUTHORIZED — publication landed (see promotion)" : "AUTHORIZED — but NOT promoted") : "NOT PROMOTED"}`,
  ];
  return lines;
}

/**
 * The publication, when one landed. It states the target, the exact tree that became
 * authoritative (== the candidate tree), and — for a degraded landing — that the ref moved
 * even though post-CAS bookkeeping did not fully complete.
 */
function promotionLines(result: V2RunResult): string[] {
  const p = result.receipt.promotion;
  if (p === undefined) return [];
  const label = p.degraded ? "PUBLISHED (DEGRADED)" : p.idempotent ? "ALREADY PUBLISHED" : "PUBLISHED";
  const lines = [
    `promotion   ${label} · ${p.targetBranch} · ${p.strategy}`,
    `  landed    ${p.beforeRef.slice(0, 12)} -> ${p.afterRef.slice(0, 12)} · tree ${p.publishedTree.slice(0, 12)}`,
    `  worktree  ${p.worktreeSynced ? "synced" : "not synced"}`,
  ];
  // V2-016A/M6: late local work preserved in a stash — the operator must be told explicitly.
  if (p.stashed) lines.push("  STASH     your late local changes at the target were PRESERVED in a git stash (not popped) — run `git stash list` / `git stash pop` to recover them");
  lines.push(
    `  post-CAS  reprobe ${p.postCasVerified ? "verified" : "NOT verified — reconciliation required"} · journal intent=${p.journalIntentStatus}/landed=${p.journalLandedStatus}`,
    `  id        ${p.promotionId}`,
    `  status    ${p.degraded ? "THE REF MOVED — post-CAS bookkeeping incomplete; recover/audit via this record" : "the exact candidate tree is now authoritative"}`,
  );
  return lines;
}


/**
 * The injectable seams. The REGISTERED commands pass none of these, so production always runs the
 * real wiring; the subprocess + qualification suites are what prove that. Hermetic suites inject
 * fake providers/workspaces/etc. to drive the whole matrix through the REAL command handler.
 */
export interface BuildCliIo {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly cwd?: string;
  readonly configuration?: ConfigurationSource;
  readonly contextSources?: readonly ContextSource[];
  readonly transport?: InvocationTransport;
  readonly workspaces?: WorkspaceAuthority;
  readonly mutations?: StateBoundMutationAuthority;
  readonly sources?: SourceSnapshotAuthority;
  /** Builder seams, for the hermetic reachability/qualification suites. Production passes none. */
  readonly buildTools?: ProductionRunDeps["buildTools"];
  readonly captureTree?: ProductionRunDeps["captureTree"];
  readonly checksSource?: ProductionRunDeps["checksSource"];
  readonly checkRunner?: ProductionRunDeps["checkRunner"];
  readonly treeProbe?: ProductionRunDeps["treeProbe"];
  readonly candidateDiff?: ProductionRunDeps["candidateDiff"];
  readonly recoveryPolicy?: ProductionRunDeps["recoveryPolicy"];
  /** The receipt store the run is recorded in. Production passes none (the live core store). */
  readonly receipts?: RunReceiptSink;
  /** The recorder itself, so a suite can assert what a run WOULD write without a real store. */
  readonly recordReceipts?: typeof recordBuildSessionReceipts;
  /** The advisory hook runner, so a suite can drive a hostile local worker without one. */
  readonly runHook?: typeof runBuildLocalHook;
  /** The transport the ADVISORY hooks use. Production resolves Bokahli lazily; suites inject. */
  readonly localTransport?: (policy: LocalExecutionPolicy) => ReturnType<typeof productionTransport> | undefined;
  /** Reads a file for the recon packet. Injected so a suite needs no repository on disk. */
  readonly readRepoFile?: (path: string) => string;
  /** The candidate diff source. Production uses the real git-backed one. */
  readonly candidateDiffSource?: ReturnType<typeof createCandidateDiffSource>;
  /**
   * The build session runner. Production passes none.
   *
   * Injected so the advisory-wiring suite can prove what happens AROUND a build without rebuilding
   * a repository — the wiring is what those tests are about, and an ESM export cannot be replaced
   * in place.
   */
  readonly runSession?: typeof runV2BuildSessionProduction;
}

/** The parsed, subcommand-free build request that BOTH `ikbi build` and `ikbi v2 build` converge on. */
interface BuildRequest {
  readonly goal: string;
  readonly repo: string;
  readonly localMode: string;
  readonly requireLocalSuccess: boolean;
  readonly strategy: string | undefined;
  readonly profile: string | undefined;
  readonly json: boolean;
  /** The operator's mutation scope, forwarded VERBATIM for preflight to validate. */
  readonly allowPaths: readonly string[];
  readonly allowTrees: readonly string[];
  readonly allowRepoWide: boolean;
}

/**
 * THE ONE PRODUCTION BUILD CALL SITE (V2-018). Both the canonical `ikbi build` handler and the
 * transitional `ikbi v2 build` alias funnel here — there is exactly one call to
 * `runV2BuildSessionProduction` from CLI build handling, so the two commands CANNOT fork behavior.
 * The `banner` differs only in wording; the engine is identical.
 */
/** The recon packet size ceiling. A local worker receives a PACKET, never a repository. */
const RECON_PACKET_MAX_FILES = 6;
const RECON_PACKET_MAX_BYTES = 48 * 1024;

/**
 * Assemble the bounded reconnaissance packet.
 *
 * BOUNDED BY CONSTRUCTION, twice over: at most a handful of files, and a hard byte ceiling that
 * truncates rather than grows. It reads the repository's own top-level conventions and manifest —
 * the things a builder would want oriented on — and never walks the tree. A packet that grew with
 * the repository would be the thing the eligibility rule exists to forbid.
 */
async function reconPacket(repo: string, io: BuildCliIo): Promise<{ id: string; content: string; source: "repo" }[]> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const read = io.readRepoFile ?? ((p: string) => readFileSync(p, "utf8"));
  const wanted = ["AGENTS.md", "CLAUDE.md", "README.md", "package.json", "Cargo.toml", "go.mod"];
  const packet: { id: string; content: string; source: "repo" }[] = [];
  let bytes = 0;
  for (const name of wanted) {
    if (packet.length >= RECON_PACKET_MAX_FILES) break;
    let content: string;
    try {
      content = read(join(repo, name));
    } catch {
      continue; // absent is ordinary, not an error
    }
    const remaining = RECON_PACKET_MAX_BYTES - bytes;
    if (remaining <= 0) break;
    const clipped = Buffer.byteLength(content, "utf8") > remaining ? `${content.slice(0, remaining)}\n[TRUNCATED]\n` : content;
    bytes += Buffer.byteLength(clipped, "utf8");
    packet.push({ id: name, content: clipped, source: "repo" });
  }
  return packet;
}

/**
 * The bounded VERIFICATION-FAILURE packet: the failed checks' own commands, exit codes and output.
 *
 * Only FAILING checks, and only their excerpts. A packet containing the green checks would be
 * larger and less useful, and the hook is being asked why something broke, not what worked.
 */
function verificationPacket(
  verification: { readonly checks?: readonly { name: string; command: string; status: string; exitCode?: number | null; outputExcerpt?: string }[] } | undefined,
): { id: string; content: string; source: "tool_result" }[] {
  const failing = (verification?.checks ?? []).filter((c) => c.status !== "pass");
  const packet: { id: string; content: string; source: "tool_result" }[] = [];
  let bytes = 0;
  for (const c of failing) {
    if (bytes >= 32 * 1024) break;
    const content = [
      `check: ${c.name}`,
      `command: ${c.command}`,
      `status: ${c.status}`,
      `exit: ${c.exitCode ?? "(did not launch)"}`,
      "output:",
      (c.outputExcerpt ?? "").slice(0, 8 * 1024),
    ].join("\n");
    bytes += Buffer.byteLength(content, "utf8");
    packet.push({ id: `check:${c.name}`, content, source: "tool_result" });
  }
  return packet;
}

/**
 * The bounded CANDIDATE-CHANGE packet: a REAL unified diff, or a typed refusal.
 *
 * WHY IT IS A REAL DIFF NOW. The first version handed the summary hook a synthetic listing of
 * changed paths and called it a diff. That was dishonest twice over — the hook's name promised
 * something the packet did not contain, and a model asked to summarize a diff it was never shown
 * has nothing to do but invent one. It also made the citation rule nearly unsatisfiable: the
 * listing's lines are trivially reorderable, so a faithful quote of it often failed to resolve.
 *
 * The diff is recomputed deterministically from the candidate's own trees — `git diff <baseTree>
 * <candidateTree>` inside the retained workspace, a pure read of the object database that checks
 * out nothing and cannot alter the candidate. Bound to the base tree and the candidate tree, so
 * the packet is re-derivable from the receipt.
 *
 * IT NEVER SILENTLY TRUNCATES. Over the file or byte ceiling, or missing a workspace to read from,
 * or carrying a file whose hunk the diff source omitted, the hook is reported INELIGIBLE with a
 * typed reason. A summary of a quietly-clipped diff is a summary of something the operator was
 * never told they were reading.
 */
const DIFF_PACKET_MAX_FILES = 20;
const DIFF_PACKET_MAX_BYTES = 48 * 1024;

type DiffPacketResult =
  | { readonly ok: true; readonly content: string; readonly fromTree: string; readonly toTree: string; readonly files: number }
  | { readonly ok: false; readonly reason: string };

async function candidateDiffPacket(
  attempt: { receipt?: { candidate?: { candidateId?: string; treeId?: string; baseTreeId?: string; sourceSnapshotId?: string; changedPaths?: readonly string[] } }; workspace?: { path?: string } } | undefined,
  io: BuildCliIo,
): Promise<DiffPacketResult> {
  const candidate = attempt?.receipt?.candidate;
  const fromTree = candidate?.baseTreeId;
  const toTree = candidate?.treeId;
  if (candidate?.candidateId === undefined || fromTree === undefined || toTree === undefined) {
    return { ok: false, reason: "no candidate tree pair to diff" };
  }
  if (fromTree === toTree) return { ok: false, reason: "the candidate changed nothing" };

  const workspacePath = attempt?.workspace?.path;
  if (workspacePath === undefined) {
    // The worktree is where the two tree objects live. Without it there is nothing to read.
    return { ok: false, reason: "the candidate workspace is no longer available to diff" };
  }
  if ((candidate.changedPaths?.length ?? 0) > DIFF_PACKET_MAX_FILES) {
    return { ok: false, reason: `${candidate.changedPaths!.length} changed files exceeds the ${DIFF_PACKET_MAX_FILES}-file packet ceiling` };
  }

  let diff;
  try {
    diff = await (io.candidateDiffSource ?? createCandidateDiffSource()).diff({
      workspacePath,
      candidateId: candidate.candidateId as never,
      sourceSnapshotId: (candidate.sourceSnapshotId ?? "") as never,
      fromTree,
      toTree,
      budget: { maxFilesWithHunks: DIFF_PACKET_MAX_FILES, maxHunkChars: 8_000 },
    });
  } catch (e) {
    return { ok: false, reason: `the diff could not be computed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const parts: string[] = [];
  for (const f of diff.files) {
    // A file whose hunk the diff source omitted or clipped is a file this packet cannot represent
    // faithfully, and a citation validator comparing against a clipped body would be checking the
    // wrong bytes. Binary content arrives with no hunk and lands here too — a typed refusal rather
    // than a silent gap.
    if (f.truncated || f.hunk === undefined) {
      return { ok: false, reason: `the diff for ${f.path} is truncated or non-text; refusing to summarize a partial diff` };
    }
    parts.push(f.hunk);
  }
  if (parts.length === 0) return { ok: false, reason: "the diff carried no readable hunks" };

  const content = parts.join("\n");
  if (Buffer.byteLength(content, "utf8") > DIFF_PACKET_MAX_BYTES) {
    return { ok: false, reason: `the diff is ${Buffer.byteLength(content, "utf8")} bytes, over the ${DIFF_PACKET_MAX_BYTES}-byte packet ceiling` };
  }
  return { ok: true, content, fromTree, toTree, files: diff.files.length };
}

/** Render the advisory block an operator sees without `--json`. *//** Render the advisory block an operator sees without `--json`. */
export function renderAdvisories(advisories: readonly LocalAdvisoryRecord[]): string {
  if (advisories.length === 0) return "";
  const lines = ["", "local advisories (UNTRUSTED, supervised — none of these decided anything):"];
  for (const a of advisories) {
    lines.push(`  ${a.hook}  ${a.disposition.toUpperCase()}  ${a.eligibilityReason}`);
    if (a.servedModelId !== undefined) {
      lines.push(`    served by ${a.servedModelId} (${a.qualificationStatus ?? "UNKNOWN"}) ${a.artifactDigest ?? ""}`);
    }
    if (a.attempts > 0) {
      lines.push(`    ${a.attempts} attempt(s), ${a.retryCount} retry/retries, ${a.localLatencyMs}ms local + ${a.backoffLatencyMs}ms backoff, ${a.promptTokens + a.completionTokens} local token(s)`);
    }
    if (a.injectionSuspected) lines.push(`    WARNING: evidence contained injection-shaped content (${a.injectionSignals.join(", ")})`);
    lines.push(`    supplied to the primary provider: ${a.suppliedToPrimaryProvider ? "YES" : "no"}`);
    if (a.disposition !== "accepted") lines.push(`    ${a.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

async function executeProductionBuild(req: BuildRequest, banner: string, io: BuildCliIo): Promise<number> {
  const out = io.stdout ?? writeStdout;
  const err = io.stderr ?? writeStderr;
  err(banner);

  /*
    PRE_BUILD_RECON — the only hook that runs BEFORE the build, because it is the only one whose
    output could inform it.

    THE CANONICAL GOAL IS IMMUTABLE. An earlier version appended the advisory to it, which was
    wrong well past style: the goal is hashed into task identity, into the context package digest,
    into the critic's goal hash, and it seeds the retrieval query. Appending changed what ikbi
    believed the operator had ASKED FOR, so an unqualified local model could move the task's own
    identity and two builds of one request stopped being the same request.

    The advice now travels on its own typed channel — a distinct, fenced, untrusted message the
    provider can tell apart STRUCTURALLY rather than by trusting a sentence inside it. The goal is
    hashed here, before any hook runs, and that digest is bound into every advisory block.
  */
  const advisories: LocalAdvisoryRecord[] = [];
  const advisoryBlocks: AdvisoryContextBlock[] = [];
  const canonicalGoal = req.goal;
  const canonicalGoalSha256 = canonicalGoalDigest(canonicalGoal);
  const buildSessionId = `pending-${Date.now().toString(36)}`;

  /*
    THE ADVISORY TRANSPORT, resolved once and lazily.

    Selecting `--local-mode assist|auto` IS the authorization for supervised-local work; there is
    no second opt-in. It is derived from the MODE and from nothing observed — a configured or
    reachable endpoint grants nothing. On a machine with no Bokahli this returns undefined, every
    hook records `not_attempted`, and the build proceeds exactly as it would have.
  */
  const localPolicy: LocalExecutionPolicy = { supervisedLocal: req.localMode !== "off", requireQualified: false };
  const localTransport = ((): ReturnType<typeof productionTransport> | undefined => {
    if (req.localMode === "off") return undefined;
    const make = io.localTransport ?? ((p: LocalExecutionPolicy) => {
      try { return productionTransport(p); } catch { return undefined; }
    });
    return make(localPolicy);
  })();

  const localDeps = (): BuildLocalDeps => ({
    mode: req.localMode,
    buildSessionId,
    ...(localTransport !== undefined ? { transport: localTransport } : {}),
    boundary: createUntrustedBoundary(),
    requireLocalSuccess: req.requireLocalSuccess,
  });

  if (req.localMode !== "off") {
    const recon = await (io.runHook ?? runBuildLocalHook)(
      {
        hook: "PRE_BUILD_RECON",
        instruction:
          "Summarize what this repository packet shows about the code the task will touch. " +
          'Reply with ONE fenced JSON object: {"summary":"<two sentences>","citations":[{"sourceId":"<id>","quote":"<exact text>"}]}',
        packet: await reconPacket(req.repo, io),
      },
      localDeps(),
    );
    const block = toAdvisoryContextBlock(recon, canonicalGoalSha256);
    if (block !== undefined) {
      advisoryBlocks.push(block);
      advisories.push(markSuppliedToPrimary(recon));
    } else {
      advisories.push(recon);
      if (shouldStopBuild(recon, { requireLocalSuccess: req.requireLocalSuccess })) {
        err(`ikbi build: refusing — --require-local-success was set and PRE_BUILD_RECON did not succeed (${recon.detail})\n`);
        return 1;
      }
      // NOT SILENT. The operator asked for local assistance and did not get it; the build
      // continues because Bokahli is the optional half, but they are told which half went missing.
      err(`ikbi build: local PRE_BUILD_RECON unavailable (${recon.eligibilityReason}: ${recon.detail}) — continuing with the primary provider alone\n`);
    }
  }

  const session = await (io.runSession ?? runV2BuildSessionProduction)(
    {
      // THE CANONICAL GOAL, BYTE-IDENTICAL. Nothing local reaches this field, in any mode.
      goal: canonicalGoal,
      repoPath: req.repo,
      // Handed over UNVALIDATED, exactly as typed. The CLI is a transport for the operator's
      // intent, not a second interpreter of it — preflight owns what a scope means.
      mutationScope: { allowPaths: req.allowPaths, allowTrees: req.allowTrees, repoWide: req.allowRepoWide },
      ...(req.strategy !== undefined ? { candidateStrategy: req.strategy } : {}),
      ...(req.profile !== undefined ? { profile: req.profile } : {}),
    },
    {
      ...(io.configuration !== undefined ? { configuration: io.configuration } : {}),
      ...(io.contextSources !== undefined ? { contextSources: io.contextSources } : {}),
      ...(io.transport !== undefined ? { transport: io.transport } : {}),
      ...(io.workspaces !== undefined ? { workspaces: io.workspaces } : {}),
      ...(io.mutations !== undefined ? { mutations: io.mutations } : {}),
      ...(io.sources !== undefined ? { sources: io.sources } : {}),
      ...(io.buildTools !== undefined ? { buildTools: io.buildTools } : {}),
      ...(io.captureTree !== undefined ? { captureTree: io.captureTree } : {}),
      ...(io.checksSource !== undefined ? { checksSource: io.checksSource } : {}),
      ...(io.checkRunner !== undefined ? { checkRunner: io.checkRunner } : {}),
      ...(io.treeProbe !== undefined ? { treeProbe: io.treeProbe } : {}),
      ...(io.candidateDiff !== undefined ? { candidateDiff: io.candidateDiff } : {}),
      ...(io.recoveryPolicy !== undefined ? { recoveryPolicy: io.recoveryPolicy } : {}),
      // The typed advisory channel. Empty in OFF, so the composed prompt is byte-identical.
      ...(advisoryBlocks.length > 0 ? { advisoryContext: advisoryBlocks } : {}),
    },
  );
  /*
    THE TWO POST-BUILD HOOKS. Both are strictly after the fact.

    VERIFICATION_FAILURE_TRIAGE reads a FAILED verification's own output and classifies it. It runs
    only when verification already failed, and it cannot turn that failure into a pass — the verdict
    was decided by the deterministic verifier before this hook existed, and nothing here is wired to
    anything that could revise it.

    POST_CANDIDATE_DIFF_SUMMARY summarizes what the candidate changed, for the operator and the
    receipt. It runs after adjudication and cannot approve a publication: by the time it speaks, the
    disposition has already been made and either enacted or withheld.
  */
  if (req.localMode !== "off") {
    const finalAttempt = session.attempts[session.attempts.length - 1];
    const verification = finalAttempt?.receipt?.verification;
    const verdictBefore = verification?.verdict;

    if (verdictBefore !== undefined && verdictBefore !== "pass") {
      const packet = verificationPacket(verification);
      if (packet.length > 0) {
        const triage = await (io.runHook ?? runBuildLocalHook)(
          {
            hook: "VERIFICATION_FAILURE_TRIAGE",
            instruction:
              "Classify why this verification failed. Reply with ONE fenced JSON object: " +
              '{"category":"assertion_failure|compile_error|timeout|missing_dependency|flaky|environment|unknown","summary":"<one sentence>","citations":[{"sourceId":"<id>","quote":"<exact text>"}]}',
            packet,
          },
          { ...localDeps(), ...(finalAttempt?.runId !== undefined ? { runId: finalAttempt.runId } : {}) },
        );
        advisories.push(triage);
      }
    }

    const diff = await candidateDiffPacket(finalAttempt as never, io);
    if (diff.ok) {
      const summary = await (io.runHook ?? runBuildLocalHook)(
        {
          hook: "POST_CANDIDATE_DIFF_SUMMARY",
          instruction:
            "Summarize what this unified diff changes, for an operator deciding whether to keep it. Reply with " +
            'ONE fenced JSON object: {"summary":"<two sentences>","citations":[{"sourceId":"candidate.diff","quote":"<a line copied exactly from the diff>"}]}',
          packet: [{ id: "candidate.diff", content: diff.content, source: "repo" as const }],
        },
        { ...localDeps(), ...(finalAttempt?.runId !== undefined ? { runId: finalAttempt.runId } : {}) },
      );
      advisories.push(summary);
    } else if (finalAttempt?.receipt?.candidate !== undefined) {
      // TYPED INELIGIBILITY, recorded. A hook that could not run honestly is a fact about the
      // build, not an absence to be inferred from a missing entry.
      advisories.push(ineligibleAdvisory("POST_CANDIDATE_DIFF_SUMMARY", buildSessionId, req.localMode, diff.reason, finalAttempt.runId));
    }

    // THE VERDICT IS RE-READ AND MUST BE UNCHANGED. Advisory means advisory; if a hook could move
    // this, the whole arrangement would be a lie, so it is asserted rather than assumed.
    const verdictAfter = session.attempts[session.attempts.length - 1]?.receipt?.verification?.verdict;
    if (verdictAfter !== verdictBefore) {
      err(`ikbi build: FATAL — a local advisory changed the verification verdict (${String(verdictBefore)} -> ${String(verdictAfter)}). Refusing to report this run.\n`);
      return 70;
    }
  }

  // RECORD THE RUN IN THE OPERATOR RECEIPT LOG, before anything is printed.
  //
  // v2 publishes by direct clean-ref CAS rather than through `WorkspaceManager.promote`, so nothing
  // on the publication path writes the log that `ikbi undo` and `ikbi inspect` read. Without this a
  // build could land a commit on `main` that `ikbi undo --latest` then reported it could not find.
  // Best-effort by contract: the git ref is the authoritative landing proof, and a receipt that
  // could not be written is REPORTED rather than allowed to fail a publication that already
  // happened.
  // THE PROMPT BINDING. What the composed provider prompt was derived from, recorded so an auditor
  // can re-derive it rather than take a narrative for it.
  const promptBinding = composedPromptBinding(canonicalGoalSha256, advisoryBlocks);
  const recorded = await (io.recordReceipts ?? recordBuildSessionReceipts)(session, req.repo, io.receipts, undefined, advisories, promptBinding);
  if (recorded.runSummary === "failed" || recorded.promotion === "failed") {
    err(
      "ikbi build: WARNING — the run completed but its receipt could not be written " +
        `(run.summary=${recorded.runSummary}, promotion=${recorded.promotion}). ` +
        "`ikbi undo` and `ikbi inspect` will not find this run.\n",
    );
  }

  // `--json` exposes the full session (every attempt + recovery decision). The human render
  // shows the recovery trail (when there was one) then the final attempt in full.
  /*
    WHICH ID DOES `ikbi inspect` TAKE?

    A session has a buildSessionId and one run id PER ATTEMPT, and the JSON showed all of them
    with nothing saying which one the receipt log is keyed by. The buildSessionId is the most
    prominent — it is the first field — and it is the one `ikbi inspect` does NOT resolve, so the
    obvious guess was the wrong guess. The receipt log is keyed by the FINAL attempt's run id.

    So the JSON now says so explicitly, and labels the attempt ids as the separate thing they are.
    Nothing is renamed or removed; a consumer reading `attempts[]` is unaffected.
  */
  const inspection = {
    canonicalRunId: session.receipt.finalAttemptRunId,
    buildSessionId: session.buildSessionId,
    attemptRunIds: session.attempts.map((attempt) => attempt.receipt.runId),
    inspectCommand: `ikbi inspect ${session.receipt.finalAttemptRunId}`,
  };
  out(
    req.json
      ? `${JSON.stringify({ ...session, inspection, canonicalGoalSha256, promptBinding, localAdvisories: advisories }, null, 2)}\n`
      : `${renderSession(session)}${renderAdvisories(advisories)}`,
  );
  return exitCodeForOutcome(session.outcome);
}

/**
 * THE CANONICAL PRODUCTION HANDLER for `ikbi build "<goal>"` (V2-018). No leading subcommand: every
 * unflagged word is part of the goal. This is the daily-driver entry — the governed v2 engine.
 */
export async function runBuildCli(argv: readonly string[], io: BuildCliIo = {}): Promise<number> {
  const args = parseV2Args(["build", ...argv], io.cwd ?? process.cwd());
  // REFUSE BEFORE ANYTHING IS CONSTRUCTED. An invocation we cannot read is never "close enough".
  if (args.rejection !== undefined) return refuseUsage("ikbi build", args.rejection, BUILD_USAGE, io.stderr ?? writeStderr);
  const scopeRefusal = refuseUnusableScope("ikbi build", args, BUILD_USAGE, io.stderr ?? writeStderr);
  if (scopeRefusal !== undefined) return scopeRefusal;
  return executeProductionBuild(
    { goal: args.goal, repo: args.repo, strategy: args.strategy, profile: args.profile, json: args.json, localMode: args.localMode, requireLocalSuccess: args.requireLocalSuccess, allowPaths: args.allowPaths, allowTrees: args.allowTrees, allowRepoWide: args.allowRepoWide },
    BUILD_BANNER,
    io,
  );
}

/**
 * The transitional `ikbi v2 build …` ALIAS. It reaches the SAME `executeProductionBuild` as
 * `ikbi build` — no separate engine, no separate parsing beyond stripping the `build` subcommand
 * token. Kept so existing muscle-memory / scripts keep working during the qualification window.
 */
export async function runV2Cli(argv: readonly string[], io: BuildCliIo = {}): Promise<number> {
  const err = io.stderr ?? writeStderr;
  const args = parseV2Args(argv, io.cwd ?? process.cwd());
  if (args.rejection !== undefined) return refuseUsage("ikbi v2", args.rejection, V2_USAGE, err);
  if (args.subcommand !== "build") {
    err(`${V2_USAGE}\n`);
    err(`ikbi v2: unknown subcommand ${args.subcommand === undefined ? "<none>" : `"${args.subcommand}"`} (only "build" exists; \`ikbi v2 build\` is an alias for \`ikbi build\`)\n`);
    return 2;
  }
  const scopeRefusal = refuseUnusableScope("ikbi v2", args, V2_USAGE, err);
  if (scopeRefusal !== undefined) return scopeRefusal;
  return executeProductionBuild(
    { goal: args.goal, repo: args.repo, strategy: args.strategy, profile: args.profile, json: args.json, localMode: args.localMode, requireLocalSuccess: args.requireLocalSuccess, allowPaths: args.allowPaths, allowTrees: args.allowTrees, allowRepoWide: args.allowRepoWide },
    V2_BANNER,
    io,
  );
}

// THE CANONICAL DAILY DRIVER: `ikbi build "<goal>"` → the governed v2 BuildSession.
registerCommand({
  name: "build",
  summary: "Build toward a goal with the governed v2 engine (isolated workspace, verify, review, promote an eligible candidate)",
  usage: BUILD_USAGE,
  run: async (argv) => {
    const code = await runBuildCli(argv);
    if (code !== 0) process.exitCode = code;
  },
});

// TRANSITIONAL ALIAS: `ikbi v2 build …` reaches the SAME handler as `ikbi build`. Advanced so it
// stays out of the golden-path help; retained during the qualification window, not a second engine.
registerCommand({
  name: "v2",
  category: "advanced",
  summary: "Alias for `ikbi build` (the governed v2 engine); `ikbi v2 build …` reaches the same production path",
  usage: V2_USAGE,
  run: async (argv) => {
    const code = await runV2Cli(argv);
    if (code !== 0) process.exitCode = code;
  },
});
