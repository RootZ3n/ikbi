/**
 * ikbi self-monitor — build digest.
 *
 * Reads the `worker.run.summary` receipts ikbi already writes for every build, classifies each
 * failure (classify.ts), and aggregates a digest: how many builds ran, how many promoted, and — the
 * point — which failures are HARNESS-suspect (a gate/config issue) versus the model. This is the
 * observability layer: no more watching builds to know what happened and whose fault it was. PURE
 * over the receipts it is handed (the CLI/tool supplies them), so it is fully testable.
 */

import { classifyBuildFailure, type BuildOutcome, type FailureClassification } from "./classify.js";

/** The subset of a receipt this module reads (structurally typed — works on the real Receipt). */
export interface ReceiptLike {
  readonly operation?: string;
  readonly outcome?: { readonly status?: string; readonly detail?: string };
  readonly metadata?: Record<string, unknown>;
  readonly requestId?: string;
  readonly time?: string | number;
}

export interface BuildRecord {
  readonly taskId: string;
  readonly targetRepo?: string;
  readonly model?: string;
  readonly costUsd?: number;
  readonly time?: string | number;
  readonly outcome: BuildOutcome;
  readonly classification: FailureClassification;
}

export interface MonitorDigest {
  readonly total: number;
  readonly promoted: number;
  readonly failed: number;
  readonly harnessSuspect: number;
  readonly bySignal: Readonly<Record<string, number>>;
  /** Failures, most-recent-first, each with its classification. */
  readonly failures: readonly BuildRecord[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Aggregate a digest from receipts. `limit` bounds the failures list (default: all). */
export function buildDigest(receipts: readonly ReceiptLike[], opts: { readonly limit?: number } = {}): MonitorDigest {
  // Cross-reference the verificationKind recorded on the separate checks_unresolvable receipt.
  const vkByTask = new Map<string, string>();
  for (const r of receipts) {
    if (r.operation === "worker.checks_unresolvable") {
      const t = str(r.requestId) ?? str(r.metadata?.taskId);
      const vk = str(r.metadata?.verificationKind);
      if (t !== undefined && vk !== undefined) vkByTask.set(t, vk);
    }
  }

  const summaries = receipts.filter((r) => r.operation === "worker.run.summary");
  const records: BuildRecord[] = [];
  const bySignal: Record<string, number> = {};
  let promoted = 0;
  let harnessSuspect = 0;

  for (const r of summaries) {
    const m = r.metadata ?? {};
    const taskId = str(r.requestId) ?? str(m.taskId) ?? "?";
    const verificationResult = str(m.verificationResult);
    const reason = str(r.outcome?.detail);
    const promotedVal = bool(m.promoted);
    const vk = vkByTask.get(taskId);
    const outcome: BuildOutcome = {
      outcome: str(m.outcome) ?? str(r.outcome?.status) ?? "unknown",
      ...(promotedVal !== undefined ? { promoted: promotedVal } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(vk !== undefined ? { verificationKind: vk } : {}),
      // The run summary records the verifier's outcome; the classifier uses it (e.g. policy_taint).
      ...(verificationResult !== undefined ? { roles: [{ role: "verifier", outcome: verificationResult }] } : {}),
    };
    const classification = classifyBuildFailure(outcome);
    if (classification.category === "none") { promoted += 1; continue; }
    if (classification.harnessSuspect) harnessSuspect += 1;
    bySignal[classification.signal] = (bySignal[classification.signal] ?? 0) + 1;
    const targetRepo = str(m.targetRepo);
    const model = str(m.model);
    const costUsd = num(m.costUsd);
    records.push({
      taskId,
      ...(targetRepo !== undefined ? { targetRepo } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(r.time !== undefined ? { time: r.time } : {}),
      outcome,
      classification,
    });
  }

  records.reverse(); // receipts append in order → most-recent failure first
  const failures = opts.limit !== undefined ? records.slice(0, opts.limit) : records;
  return { total: summaries.length, promoted, failed: records.length, harnessSuspect, bySignal, failures };
}

/** Render a digest as a plain-language report (for `ikbi monitor` and for Peh to relay). */
export function formatMonitorDigest(d: MonitorDigest): string {
  const lines: string[] = [];
  lines.push(`Builds: ${d.total} total · ${d.promoted} promoted · ${d.failed} failed · ${d.harnessSuspect} harness-suspect`);
  if (d.failed === 0) {
    lines.push(d.total === 0 ? "No builds recorded yet." : "All recorded builds promoted — nothing to look at.");
    return lines.join("\n");
  }
  if (Object.keys(d.bySignal).length > 0) {
    const byS = Object.entries(d.bySignal).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}×${n}`).join(", ");
    lines.push(`Signals: ${byS}`);
  }
  lines.push("");
  for (const f of d.failures) {
    const tag = f.classification.harnessSuspect ? "HARNESS-SUSPECT" : f.classification.category.toUpperCase();
    lines.push(`• [${tag}] ${f.classification.signal} — ${f.taskId}${f.targetRepo !== undefined ? ` (${f.targetRepo})` : ""}`);
    lines.push(`    ${f.classification.evidence}`);
    if (f.classification.suggestedAction !== undefined) lines.push(`    → ${f.classification.suggestedAction}`);
  }
  const harness = d.failures.filter((f) => f.classification.harnessSuspect).length;
  if (harness > 0) lines.push(`\n${harness} of ${d.failures.length} shown look like the HARNESS, not the model — candidates for self-heal.`);
  return lines.join("\n");
}
