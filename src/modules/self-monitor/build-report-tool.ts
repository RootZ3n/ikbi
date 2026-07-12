/**
 * build_report — Peh's window into the build watch. A read-only chat tool that returns the
 * self-monitor digest (recent builds, promoted vs failed, and which failures look like the HARNESS
 * vs the model), so the guide can tell the user how things are going and flag harness-suspect
 * failures without anyone tailing logs. Read-only: it only queries the receipt log.
 */

import type { ModelTool } from "../../core/provider/contract.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { ReceiptStore } from "../../core/receipt/index.js";
import { buildDigest, formatMonitorDigest, type ReceiptLike } from "./monitor.js";

export const buildReportTool: ModelTool = {
  name: "build_report",
  description:
    "Report on recent ikbi builds — how many ran, promoted, and failed, and which failures look " +
    "like a HARNESS/config issue (a gate, trust, or verification problem) versus the model itself. " +
    "Read-only. Use when the user asks how builds are going, what failed, or why a build didn't land.",
  parameters: {
    type: "object",
    properties: { days: { type: "number", description: "How many days back to look (default 7)." } },
    required: [],
  },
};

export async function runBuildReport(
  args: { readonly days?: unknown },
  deps: { readonly receipts?: Pick<ReceiptStore, "query"> } = {},
): Promise<string> {
  const store = deps.receipts ?? coreReceipts;
  const days = typeof args.days === "number" && Number.isFinite(args.days) && args.days > 0 ? args.days : 7;
  try {
    const all = (await store.query({ fromTime: Date.now() - days * 24 * 60 * 60 * 1000 })) as unknown as ReceiptLike[];
    return formatMonitorDigest(buildDigest(all, { limit: 15 }));
  } catch (e) {
    return `Could not read the build history: ${e instanceof Error ? e.message : String(e)}`;
  }
}
