/**
 * Receipt grouping — the SINGLE source of truth for "how many tasks/builds, how
 * many succeeded, how many promoted, what did they cost".
 *
 * WHY: `summary`, `timeline`, `receipts --task`, and `audit` all need to agree on
 * the same accounting. Before this module each computed its own grouping (summary
 * grouped by requestId and counted a standalone `workspace.promote`; timeline
 * counted raw receipts), so the operator could see different "truths" across
 * commands. This module centralizes the grouping so they cannot drift.
 *
 * A "task group" is the set of receipts sharing a task key (requestId, falling
 * back to metadata.taskId for role receipts). Promotion is detected from EITHER a
 * standalone successful `workspace.promote` receipt OR a `worker.run.summary`
 * receipt whose metadata says it promoted — so a successful promote is never
 * undercounted just because the standalone promote receipt is missing.
 */

import type { Receipt } from "./contract.js";

/** The task key a receipt belongs to: requestId, else metadata.taskId (role receipts carry both). */
export function taskKeyOf(r: Receipt): string | undefined {
  if (r.requestId !== undefined) return r.requestId;
  const t = (r.metadata as Record<string, unknown> | undefined)?.taskId;
  return typeof t === "string" ? t : undefined;
}

/** Cost recorded on a single receipt (metadata.costUsd), or 0. */
export function receiptCostUsd(r: Receipt): number {
  const c = (r.metadata as Record<string, unknown> | undefined)?.costUsd;
  return typeof c === "number" ? c : 0;
}

function metaString(r: Receipt, key: string): string | undefined {
  const v = (r.metadata as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v : undefined;
}

export type TaskStatus = "success" | "failure" | "pending";

/** One task/build: its receipts plus the reconciled promotion/verification/cost metadata. */
export interface TaskGroup {
  readonly taskId: string;
  readonly receipts: Receipt[];
  /** A successful promote happened (standalone promote receipt OR run-summary promoted flag). */
  readonly promoted: boolean;
  readonly status: TaskStatus;
  /** Promotion cost for this task — the run-summary cost if present, else the sum of role costs. */
  readonly costUsd: number;
  readonly originAgent?: string;
  readonly project?: string;
  readonly workspaceId?: string;
  /** Promoted commit SHA (from a workspace.promote change's `after.ref`), when available. */
  readonly promotedCommit?: string;
  readonly verificationResult?: string;
  readonly promotionResult?: string;
  /** Newest receipt timestamp in the group — used to time-bucket the task. */
  readonly latestTimestamp: number;
}

/** Did this group successfully promote? Standalone promote receipt OR run-summary promoted flag. */
function detectPromoted(receipts: Receipt[]): boolean {
  const standalone = receipts.some(
    (r) => r.operation === "workspace.promote" && r.outcome.status === "success",
  );
  if (standalone) return true;
  // Fallback: a run-summary receipt that recorded a successful promotion. This is what stops
  // `summary` undercounting promotes when the standalone promote receipt is absent.
  return receipts.some(
    (r) =>
      r.operation === "worker.run.summary" &&
      (r.metadata as Record<string, unknown> | undefined)?.promoted === true,
  );
}

function detectFailure(receipts: Receipt[]): boolean {
  return receipts.some((r) => r.outcome.status === "failure" || r.outcome.status === "rejected");
}

/** Promoted commit SHA from a successful promote receipt's recorded state change, if any. */
function promotedCommitOf(receipts: Receipt[]): string | undefined {
  for (const r of receipts) {
    if (r.operation !== "workspace.promote" || r.outcome.status !== "success") continue;
    for (const c of r.changes) {
      const after = (c as { after?: { ref?: unknown } }).after;
      if (after !== undefined && typeof after.ref === "string") return after.ref;
    }
  }
  return undefined;
}

/**
 * Group receipts into task/build groups. Receipts with NO task key (e.g. a bare
 * dependency.install with no requestId/taskId) are excluded from grouping — they
 * are not builds and must not inflate the build count (matches `summary`).
 */
export function groupReceiptsByTask(receipts: readonly Receipt[]): TaskGroup[] {
  const byTask = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const key = taskKeyOf(r);
    if (key === undefined) continue;
    const arr = byTask.get(key) ?? [];
    arr.push(r);
    byTask.set(key, arr);
  }

  const groups: TaskGroup[] = [];
  for (const [taskId, group] of byTask) {
    const promoted = detectPromoted(group);
    const failed = !promoted && detectFailure(group);
    const status: TaskStatus = promoted ? "success" : failed ? "failure" : "pending";

    const runSummary = group.find((r) => r.operation === "worker.run.summary");
    const runCost = runSummary !== undefined ? receiptCostUsd(runSummary) : 0;
    const costUsd = runCost > 0 ? runCost : group.reduce((sum, r) => sum + receiptCostUsd(r), 0);

    const meta = (r: string): string | undefined => {
      for (const rec of group) {
        const v = metaString(rec, r);
        if (v !== undefined) return v;
      }
      return undefined;
    };

    const latestTimestamp = group.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), 0);

    // Capture optional fields into narrowed consts (exactOptionalPropertyTypes).
    const originAgent = meta("originAgent");
    // Project: prefer explicit metadata.targetRepo, else any receipt's top-level `project`.
    const project = meta("targetRepo") ?? group.find((r) => r.project !== undefined)?.project;
    const workspaceId = meta("workspaceId");
    const promotedCommit = promotedCommitOf(group);
    const verificationResult = meta("verificationResult");
    const promotionResult = meta("promotionResult");

    groups.push({
      taskId,
      receipts: group,
      promoted,
      status,
      costUsd,
      ...(originAgent !== undefined ? { originAgent } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(promotedCommit !== undefined ? { promotedCommit } : {}),
      ...(verificationResult !== undefined ? { verificationResult } : {}),
      ...(promotionResult !== undefined ? { promotionResult } : {}),
      latestTimestamp,
    });
  }
  return groups;
}

/** Aggregate counts over task groups — what summary/timeline/audit all report. */
export interface GroupTotals {
  readonly totalTasks: number;
  readonly successes: number;
  readonly failures: number;
  readonly pending: number;
  readonly promotes: number;
  readonly totalCostUsd: number;
}

export function summarizeGroups(groups: readonly TaskGroup[]): GroupTotals {
  let successes = 0;
  let failures = 0;
  let pending = 0;
  let promotes = 0;
  let totalCostUsd = 0;
  for (const g of groups) {
    if (g.status === "success") successes += 1;
    else if (g.status === "failure") failures += 1;
    else pending += 1;
    if (g.promoted) promotes += 1;
    totalCostUsd += g.costUsd;
  }
  return { totalTasks: groups.length, successes, failures, pending, promotes, totalCostUsd };
}
