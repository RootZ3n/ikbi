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
  // FIRST PASS: index the checks_unresolvable receipts (they cross-reference the run summary's
  // verificationKind) AND record which taskIds already have a run summary. A build that reaches the
  // verifier writes a run.summary and — if the target was unverifiable — also a checks_unresolvable
  // receipt; those are surfaced via the summary. But the WO2 preflight/kill-switch fast-fails RETURN
  // before any run.summary is written (orchestrator.ts) — their ONLY receipt is checks_unresolvable.
  // Counting only run.summary would silently drop exactly those harness-suspect builds — the ones the
  // monitor exists to catch. So a checks_unresolvable receipt with NO matching summary is surfaced too.
  const vkByTask = new Map<string, string>();
  const summaryTaskIds = new Set<string>();
  for (const r of receipts) {
    if (r.operation === "worker.checks_unresolvable") {
      const t = str(r.requestId) ?? str(r.metadata?.taskId);
      const vk = str(r.metadata?.verificationKind);
      if (t !== undefined && vk !== undefined) vkByTask.set(t, vk);
    } else if (r.operation === "worker.run.summary") {
      const t = str(r.requestId) ?? str(r.metadata?.taskId);
      if (t !== undefined) summaryTaskIds.add(t);
    }
  }

  const records: BuildRecord[] = [];
  const bySignal: Record<string, number> = {};
  let total = 0;
  let promoted = 0;
  let harnessSuspect = 0;

  const account = (record: BuildRecord): void => {
    if (record.classification.category === "none") { promoted += 1; return; }
    if (record.classification.harnessSuspect) harnessSuspect += 1;
    bySignal[record.classification.signal] = (bySignal[record.classification.signal] ?? 0) + 1;
    records.push(record);
  };

  // SECOND PASS: chronological, so `records` is already in append order (reversed once at the end for
  // most-recent-first). Both surfaces — the run summary and the standalone fast-fail — are handled here.
  for (const r of receipts) {
    const m = r.metadata ?? {};
    if (r.operation === "worker.run.summary") {
      total += 1;
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
      const targetRepo = str(m.targetRepo);
      const model = str(m.model);
      const costUsd = num(m.costUsd);
      account({
        taskId,
        ...(targetRepo !== undefined ? { targetRepo } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(r.time !== undefined ? { time: r.time } : {}),
        outcome,
        classification: classifyBuildFailure(outcome),
      });
    } else if (r.operation === "worker.checks_unresolvable") {
      const taskId = str(r.requestId) ?? str(m.taskId) ?? "?";
      // Skip when the build also wrote a run summary — it is already surfaced (and richer) via that.
      if (summaryTaskIds.has(taskId)) continue;
      // A standalone fast-fail: no run summary was ever written. Reconstruct the outcome as a rejected
      // build with its classification kind so it is counted AND classified (harness-suspect).
      total += 1;
      const vk = str(m.verificationKind);
      const reason = str(m.reason) ?? str(r.outcome?.detail);
      const outcome: BuildOutcome = {
        outcome: "rejected",
        ...(vk !== undefined ? { verificationKind: vk } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
      const targetRepo = str(m.targetRepo);
      account({
        taskId,
        ...(targetRepo !== undefined ? { targetRepo } : {}),
        ...(r.time !== undefined ? { time: r.time } : {}),
        outcome,
        classification: classifyBuildFailure(outcome),
      });
    }
  }

  records.reverse(); // receipts append in order → most-recent failure first
  const failures = opts.limit !== undefined ? records.slice(0, opts.limit) : records;
  return { total, promoted, failed: records.length, harnessSuspect, bySignal, failures };
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
