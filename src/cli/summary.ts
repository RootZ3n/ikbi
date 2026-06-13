/**
 * ikbi `summary` — compact build overview from the receipt log.
 *
 *   ikbi summary              last 24 hours
 *   ikbi summary --days 7     last 7 days
 *
 * Groups receipts by requestId to count distinct builds, derives success rate,
 * aggregates cost from metadata.costUsd, and surfaces the top failure reason and
 * most active agent. Read-only: only queries the receipt store.
 */

import { registerCommand } from "./registry.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";

export interface ReceiptReader {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

export interface SummaryCliDeps {
  readonly receipts?: ReceiptReader;
  readonly now?: () => number;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

/** Parse `--days <n>` / `--days=<n>`. Defaults to 1. */
export function parseSummaryArgs(argv: readonly string[]): { days: number } {
  let days = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--days") { days = Number(argv[i + 1]); i += 1; }
    else if (a.startsWith("--days=")) days = Number(a.slice("--days=".length));
  }
  return { days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 1 };
}

function costOf(r: Receipt): number {
  const c = (r.metadata as Record<string, unknown> | undefined)?.costUsd;
  return typeof c === "number" ? c : 0;
}

function failureReasonOf(r: Receipt): string {
  if (r.outcome.detail !== undefined) return r.outcome.detail;
  if (r.outcome.error !== undefined) return r.outcome.error;
  const rootCause = (r.metadata as Record<string, unknown> | undefined)?.rootCause;
  if (typeof rootCause === "string") return rootCause;
  return r.operation;
}

/** Build the `summary` handler. Default reads the live receipt store. */
export function createSummaryCli(deps: SummaryCliDeps = {}) {
  const store = deps.receipts ?? coreReceipts;
  const nowMs = deps.now ?? (() => Date.now());
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  async function summary(argv: readonly string[]): Promise<void> {
    const { days } = parseSummaryArgs(argv);
    const fromTime = nowMs() - days * 24 * 60 * 60 * 1000;

    let all: Receipt[];
    try {
      all = await store.query({ fromTime });
    } catch (e) {
      err(`ikbi summary: could not read the receipt log: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }

    // Group by requestId — each distinct requestId is one "build".
    const buildMap = new Map<string, Receipt[]>();
    const agentCounts = new Map<string, number>();
    let totalCostUsd = 0;

    for (const r of all) {
      agentCounts.set(r.identity.agentId, (agentCounts.get(r.identity.agentId) ?? 0) + 1);
      totalCostUsd += costOf(r);
      if (r.requestId !== undefined) {
        const group = buildMap.get(r.requestId) ?? [];
        group.push(r);
        buildMap.set(r.requestId, group);
      }
    }

    // Classify each build: success = has a successful workspace.promote.
    let successCount = 0;
    const failureReasons: string[] = [];

    for (const [, group] of buildMap) {
      const promote = group.find((r) => r.operation === "workspace.promote");
      if (promote?.outcome.status === "success") {
        successCount += 1;
      } else {
        const failed = group.find((r) => r.outcome.status === "failure" || r.outcome.status === "rejected");
        if (failed !== undefined) failureReasons.push(failureReasonOf(failed));
      }
    }

    const totalBuilds = buildMap.size;
    const successRate = totalBuilds > 0 ? (successCount / totalBuilds) * 100 : 0;
    const avgCostUsd = totalBuilds > 0 ? totalCostUsd / totalBuilds : 0;

    // Most common failure reason.
    const reasonCounts = new Map<string, number>();
    for (const r of failureReasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    // Most active agent by receipt count.
    const topAgent = [...agentCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    const windowLabel = days === 1 ? "last 24 hours" : `last ${days} days`;
    const hasCost = totalCostUsd > 0;

    out(`ikbi build summary (${windowLabel})\n`);
    out(`${"─".repeat(40)}\n`);
    out(`  Total builds:        ${totalBuilds}\n`);
    out(`  Success rate:        ${totalBuilds > 0 ? `${successRate.toFixed(1)}%` : "n/a"}\n`);
    out(`  Total cost:          ${hasCost ? `$${totalCostUsd.toFixed(4)}` : "n/a"}\n`);
    out(`  Average cost:        ${hasCost && totalBuilds > 0 ? `$${avgCostUsd.toFixed(4)}` : "n/a"}\n`);
    out(`  Top failure reason:  ${topReason !== undefined ? topReason[0] : "none"}\n`);
    out(`  Most active agent:   ${topAgent !== undefined ? `${topAgent[0]} (${topAgent[1]})` : "none"}\n`);
  }

  return { summary };
}

registerCommand({
  name: "summary",
  summary: "Compact build overview (last 24 hours, or --days N)",
  usage: "ikbi summary [--days <n>]",
  run: (argv) => createSummaryCli().summary(argv),
});
