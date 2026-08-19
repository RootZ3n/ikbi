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
import { CANDIDATE_STRATEGIES } from "../core/contract.js";
import { exitCodeForOutcome, formatOutcome, type V2RunResult } from "../core/result.js";
import { runV2BuildSessionProduction, type ProductionRunDeps } from "../runtime/index.js";
import type { V2BuildSessionResult } from "../core/session.js";
import { formatMicroUsd } from "../core/cost.js";

export const V2_USAGE = `Usage: ikbi v2 build "<goal>" [--repo <path>] [--strategy ${CANDIDATE_STRATEGIES.join("|")}] [--profile <name>] [--json]`;

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
    readonly contextSources?: readonly ContextSource[];
    readonly transport?: InvocationTransport;
    readonly workspaces?: WorkspaceAuthority;
    readonly mutations?: StateBoundMutationAuthority;
    readonly sources?: SourceSnapshotAuthority;
    /** Builder seams, for the hermetic reachability suite. Production passes none. */
    readonly buildTools?: ProductionRunDeps["buildTools"];
    readonly captureTree?: ProductionRunDeps["captureTree"];
    readonly checksSource?: ProductionRunDeps["checksSource"];
    readonly checkRunner?: ProductionRunDeps["checkRunner"];
    readonly treeProbe?: ProductionRunDeps["treeProbe"];
    readonly candidateDiff?: ProductionRunDeps["candidateDiff"];
    readonly recoveryPolicy?: ProductionRunDeps["recoveryPolicy"];
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
  const session = await runV2BuildSessionProduction(
    {
      goal: args.goal,
      repoPath: args.repo,
      ...(args.strategy !== undefined ? { candidateStrategy: args.strategy } : {}),
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
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
    },
  );
  // `--json` exposes the full session (every attempt + recovery decision). The human render
  // shows the recovery trail (when there was one) then the final attempt in full.
  out(args.json ? `${JSON.stringify(session, null, 2)}\n` : renderSession(session));
  return exitCodeForOutcome(session.outcome);
}

registerCommand({
  name: "v2",
  category: "advanced",
  summary: "EXPERIMENTAL: run the v2 canonical lifecycle (build in isolation, verify, review, and PUBLISH an eligible candidate to the target branch)",
  usage: V2_USAGE,
  run: async (argv) => {
    const code = await runV2Cli(argv);
    if (code !== 0) process.exitCode = code;
  },
});
