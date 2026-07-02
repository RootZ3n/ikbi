/**
 * `ikbi monitor` — the build watch. Reads the receipt log ikbi already writes, classifies every
 * build failure as HARNESS-suspect (a gate/config issue) vs the model, and prints a digest. This is
 * the observability layer of the self-monitor: no more watching builds to know what happened and
 * whose fault it was. Read-only — it only queries receipts.
 */

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { ReceiptStore } from "../core/receipt/index.js";
import { buildDigest, formatMonitorDigest, type ReceiptLike } from "../modules/self-monitor/monitor.js";

export interface MonitorCliDeps {
  readonly receipts?: Pick<ReceiptStore, "query">;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
}

export function createMonitorCli(deps: MonitorCliDeps = {}) {
  const store = deps.receipts ?? coreReceipts;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const nowMs = deps.now ?? (() => Date.now());

  async function run(argv: readonly string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) {
      out("Usage: ikbi monitor [--days <n>] [--limit <n>]\n\nClassify recent build failures as harness-suspect vs model, so you don't have to watch builds.\n");
      return;
    }
    const daysIdx = argv.indexOf("--days");
    const days = daysIdx >= 0 ? Number.parseInt(argv[daysIdx + 1] ?? "", 10) : 7;
    const limitIdx = argv.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number.parseInt(argv[limitIdx + 1] ?? "", 10) : 20;
    try {
      const fromTime = Number.isFinite(days) && days > 0 ? nowMs() - days * 24 * 60 * 60 * 1000 : undefined;
      const all = (await store.query(fromTime !== undefined ? { fromTime } : {})) as unknown as ReceiptLike[];
      const digest = buildDigest(all, Number.isFinite(limit) && limit > 0 ? { limit } : {});
      out(`${formatMonitorDigest(digest)}\n`);
    } catch (e) {
      err(`ikbi monitor: could not read the receipt log: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  return { run };
}

registerCommand({
  name: "monitor",
  summary: "Watch builds: classify recent failures as harness-suspect vs model (no babysitting)",
  usage: "ikbi monitor [--days <n>] [--limit <n>]",
  run: (argv) => createMonitorCli().run(argv),
});
