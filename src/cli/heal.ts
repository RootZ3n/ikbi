/**
 * `ikbi heal` — the self-heal front door.
 *
 * Read-only by DEFAULT: it reads the receipt log, classifies recent failures (the same digest as
 * `ikbi monitor`), and lists the HARNESS-suspect ones — the only failures self-heal will act on.
 *
 * `--task <id> --run` attempts a real self-heal: it builds a candidate fix for that failure on the
 * ikbi repo in an ISOLATED branch, runs the full suite + the deterministic judge, assesses the
 * blast-radius, and lands a DISPOSITION — never a merge. Because a real run spends model tokens and
 * runs a full build+suite, and the live path is not yet integration-validated, `--run` is FAIL-CLOSED:
 * it requires the explicit opt-in `IKBI_SELFHEAL_ENABLE=true` AND `--yes`. Without them it refuses and
 * explains — trust/capability is granted, never assumed.
 */

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { config } from "../core/config.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { ReceiptStore } from "../core/receipt/index.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../core/identity/index.js";
import type { ValidatedIdentity } from "../core/identity/index.js";
import { buildDigest, type ReceiptLike } from "../modules/self-monitor/monitor.js";
import type { BuildRecord } from "../modules/self-monitor/monitor.js";
import type { BuildTier } from "../modules/worker-model/tier-presets.js";
import type { SelfHealFailure, SelfHealResult } from "../modules/self-heal/index.js";

export interface HealCliDeps {
  readonly receipts?: Pick<ReceiptStore, "query">;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
  /** Runs the real self-heal loop. Injected so tests never spawn a build; default builds the live loop. */
  readonly runHeal?: (failure: SelfHealFailure, opts: { tier: BuildTier; testCountBefore?: number }) => Promise<SelfHealResult>;
  readonly resolveIdentity?: (claim: { token: string }) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  /** The `IKBI_SELFHEAL_ENABLE` opt-in value (default: the process env). */
  readonly enabled?: string | undefined;
}

const USAGE =
  "Usage: ikbi heal [--days <n>] [--limit <n>]                 (preview harness-suspect failures)\n" +
  "       ikbi heal --task <id> --run [--tier mid|frontier] --yes   (attempt a real self-heal)\n";

export function createHealCli(deps: HealCliDeps = {}) {
  const store = deps.receipts ?? coreReceipts;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const nowMs = deps.now ?? (() => Date.now());
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const enabled = "enabled" in deps ? deps.enabled : process.env.IKBI_SELFHEAL_ENABLE;

  async function harnessFailures(days: number, limit: number): Promise<BuildRecord[]> {
    const fromTime = Number.isFinite(days) && days > 0 ? nowMs() - days * 24 * 60 * 60 * 1000 : undefined;
    const all = (await store.query(fromTime !== undefined ? { fromTime } : {})) as unknown as ReceiptLike[];
    const digest = buildDigest(all, Number.isFinite(limit) && limit > 0 ? { limit } : {});
    return digest.failures.filter((f) => f.classification.harnessSuspect);
  }

  function preview(records: readonly BuildRecord[]): void {
    if (records.length === 0) {
      out("No harness-suspect failures in the window — nothing for self-heal to do.\n");
      return;
    }
    out(`${records.length} harness-suspect failure(s) — candidates for self-heal:\n\n`);
    for (const r of records) {
      out(`• ${r.taskId} [${r.classification.signal}]${r.targetRepo !== undefined ? ` (${r.targetRepo})` : " (no repo — cannot heal)"}\n`);
      out(`    ${r.classification.evidence}\n`);
    }
    out(`\nTo attempt a fix:  ikbi heal --task <id> --run --yes\n`);
    out(`(Requires IKBI_SELFHEAL_ENABLE=true. The fix lands on a BRANCH for you to review — never on main.)\n`);
  }

  async function attempt(taskId: string, tier: BuildTier, testCountBefore: number | undefined, yes: boolean): Promise<void> {
    const records = await harnessFailures(365, 200);
    const record = records.find((r) => r.taskId === taskId);
    if (record === undefined) {
      err(`ikbi heal: no harness-suspect failure with task id "${taskId}" (run \`ikbi heal\` to list candidates).\n`);
      setExit(1);
      return;
    }
    if (record.targetRepo === undefined) {
      err(`ikbi heal: failure "${taskId}" has no target repo recorded — cannot heal it.\n`);
      setExit(1);
      return;
    }
    // FAIL-CLOSED: a real run spends tokens + runs a full build/suite. Require the explicit opt-in.
    if (enabled !== "true") {
      err(
        `ikbi heal: self-heal is NOT enabled. A real run builds a candidate fix (spends model tokens) and\n` +
        `runs the full suite. It lands on a branch, never main. To enable: set IKBI_SELFHEAL_ENABLE=true.\n`,
      );
      setExit(1);
      return;
    }
    if (!yes) {
      err(`ikbi heal: refusing to run without --yes (self-heal spends tokens + runs a full build/suite).\n`);
      setExit(1);
      return;
    }
    const runHeal = deps.runHeal ?? defaultRunHeal(resolveIdentity, operatorToken);
    const failure: SelfHealFailure = {
      taskId: record.taskId,
      classification: record.classification,
      targetRepo: record.targetRepo,
      ...(record.outcome.reason !== undefined ? { reason: record.outcome.reason } : {}),
    };
    out(`Healing ${taskId} [${record.classification.signal}] on ${record.targetRepo} (tier: ${tier})…\n`);
    try {
      const result = await runHeal(failure, { tier, ...(testCountBefore !== undefined ? { testCountBefore } : {}) });
      out(`\n${formatHealResult(result)}\n`);
      // A diagnosed-proposal / awaiting-authorization is a SAFE outcome, not an error exit.
    } catch (e) {
      err(`ikbi heal: self-heal failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  async function run(argv: readonly string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) { out(`${USAGE}\nList harness-suspect failures, or attempt a governed self-heal that lands a fix on a branch.\n`); return; }
    const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const days = Number.parseInt(flag("--days") ?? "7", 10);
    const limit = Number.parseInt(flag("--limit") ?? "20", 10);
    const task = flag("--task");
    const tierRaw = flag("--tier") ?? "mid";
    const tier: BuildTier = tierRaw === "frontier" ? "frontier" : tierRaw === "cheap" ? "cheap" : "mid";
    const tcbRaw = flag("--test-count-before");
    const testCountBefore = tcbRaw !== undefined && Number.isFinite(Number(tcbRaw)) ? Number(tcbRaw) : undefined;

    try {
      if (argv.includes("--run")) {
        if (task === undefined || task.length === 0) { err(`ikbi heal: --run requires --task <id>.\n${USAGE}`); setExit(1); return; }
        await attempt(task, tier, testCountBefore, argv.includes("--yes"));
        return;
      }
      preview(await harnessFailures(days, limit));
    } catch (e) {
      err(`ikbi heal: could not read the receipt log: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  return { run };
}

/** Render a self-heal result for the operator. */
export function formatHealResult(r: SelfHealResult): string {
  const lines: string[] = [];
  const d = r.verdict.disposition;
  const head = {
    applied: "✔ APPLIED to a branch (verified, low-risk) — review and merge",
    "awaiting-authorization": "⏸ AWAITING YOUR DECISION — verified, but the blast-radius needs a human",
    "diagnosed-proposal": "✗ NOT APPLIED — surfaced as a diagnosis (a correctness gate failed)",
    rejected: "— NO ACTION",
  }[d];
  lines.push(head);
  for (const reason of r.verdict.reasons) lines.push(`  · ${reason}`);
  if (r.candidate?.branch !== undefined && (d === "applied" || d === "awaiting-authorization")) {
    lines.push(`  branch: ${r.candidate.branch}`);
  }
  if (r.blastRadius !== undefined) lines.push(`  blast-radius: ${r.blastRadius.severity}`);
  if (r.suite !== undefined && !r.suite.green && r.suite.summary !== undefined) lines.push(`  suite: ${r.suite.summary}`);
  if (r.advice !== undefined) lines.push(`\n  Opus advises:\n  ${r.advice.split("\n").join("\n  ")}`);
  return lines.join("\n");
}

/**
 * Build the live self-heal runner (lazy — only constructed when a gated --run actually fires, so the
 * heavy subsystem imports never load for a preview). Resolves the operator identity, then composes the
 * live IO over the real subsystems. Kept out of the tested path (tests inject deps.runHeal).
 */
function defaultRunHeal(
  resolveIdentity: (claim: { token: string }) => ValidatedIdentity,
  operatorToken: string | undefined,
): (failure: SelfHealFailure, opts: { tier: BuildTier; testCountBefore?: number }) => Promise<SelfHealResult> {
  return async (failure, opts) => {
    if (operatorToken === undefined || operatorToken.length === 0) {
      throw new Error("no operator token — self-heal needs an operator identity to run a governed build");
    }
    const who = resolveIdentity({ token: operatorToken });
    const ctx = beginOperation(who, { requestId: `heal-${failure.taskId}-${nowRequestSuffix()}` });
    const [{ composeExecutors, liveSelfHealIo, runSelfHeal }, { runWorker }, { workspaces }, { deterministicJudge }, { invokeModel }, { receipts }] = await Promise.all([
      import("../modules/self-heal/index.js"),
      import("../modules/worker-model/index.js"),
      import("../core/workspace/index.js"),
      import("../modules/deterministic-judge/judge.js"),
      import("../core/provider/index.js"),
      import("../core/receipt/index.js"),
    ]);
    const adviceModel = process.env.IKBI_SELFHEAL_ADVICE_MODEL ?? process.env.IKBI_PEH_MODEL ?? "opus-4.8";
    const io = liveSelfHealIo({
      identity: who.identity,
      parentCtx: ctx,
      allocate: (targetRepo) => workspaces.allocate({ targetRepo, identity: who.identity, label: `self-heal:${failure.taskId}` }),
      runWorker,
      judge: (candidates) => deterministicJudge.judge(candidates),
      invokeAdvice: async (messages) => (await invokeModel({ model: adviceModel, identity: who.identity, messages: [...messages] })).content,
      appendReceipt: async (result, identity) => {
        await receipts.append({
          operation: "self_heal.attempt",
          outcome: { status: result.verdict.disposition === "applied" ? "success" : "partial", detail: result.reason },
          requestId: failure.taskId,
          project: failure.targetRepo,
          metadata: {
            disposition: result.verdict.disposition,
            verified: result.verdict.verified,
            signal: failure.classification.signal,
            ...(result.blastRadius !== undefined ? { blastRadius: result.blastRadius.severity } : {}),
            ...(result.candidate?.branch !== undefined ? { branch: result.candidate.branch } : {}),
          },
        }, identity);
      },
    });
    return runSelfHeal({ failure, ...(opts.testCountBefore !== undefined ? { testCountBefore: opts.testCountBefore } : {}) }, composeExecutors(io, { tier: opts.tier }));
  };
}

/** A monotonic-ish suffix for the request id without a bare Date in the hot path signature. */
function nowRequestSuffix(): number {
  return Date.now();
}

const live = createHealCli();
registerCommand({
  name: "heal",
  summary: "Self-heal: list harness-suspect failures, or attempt a governed fix that lands on a branch",
  usage: USAGE.trim(),
  run: (argv) => live.run(argv),
});
