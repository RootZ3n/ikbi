/**
 * Receipt grouping — the single source of truth that keeps summary/timeline/
 * receipts/audit agreeing. (lab-trust sprint, Phase 3)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../identity/contract.js";
import type { Receipt } from "./contract.js";
import { groupReceiptsByTask, summarizeGroups, taskKeyOf } from "./grouping.js";

const ID: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };

function rec(over: {
  seq: number;
  operation: string;
  status: Receipt["outcome"]["status"];
  requestId?: string;
  metadata?: Record<string, unknown>;
  changes?: Receipt["changes"];
}): Receipt {
  return {
    contractVersion: "1.0.0",
    id: `r${over.seq}`,
    seq: over.seq,
    timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: ID,
    operation: over.operation,
    outcome: { status: over.status },
    changes: over.changes ?? [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  } as Receipt;
}

test("taskKeyOf prefers requestId, falls back to metadata.taskId", () => {
  assert.equal(taskKeyOf(rec({ seq: 1, operation: "x", status: "success", requestId: "t-1" })), "t-1");
  assert.equal(taskKeyOf(rec({ seq: 2, operation: "x", status: "success", metadata: { taskId: "t-2" } })), "t-2");
  assert.equal(taskKeyOf(rec({ seq: 3, operation: "x", status: "success" })), undefined);
});

test("multiple receipts from one task collapse into a single task group", () => {
  const groups = groupReceiptsByTask([
    rec({ seq: 1, operation: "worker.role.scout", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "t-1" }),
    rec({ seq: 3, operation: "workspace.promote", status: "success", requestId: "t-1" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.taskId, "t-1");
  assert.equal(groups[0]!.receipts.length, 3);
  assert.equal(groups[0]!.status, "success");
  assert.equal(groups[0]!.promoted, true);
});

test("a failed task with many receipts is ONE failed task group", () => {
  const groups = groupReceiptsByTask([
    rec({ seq: 1, operation: "worker.role.builder", status: "failure", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.role.critic", status: "failure", requestId: "t-1" }),
    rec({ seq: 3, operation: "worker.run.summary", status: "failure", requestId: "t-1", metadata: { promoted: false } }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.status, "failure");
  assert.equal(groups[0]!.promoted, false);
});

test("promote FALLBACK: run-summary promoted:true counts as a promote even with no standalone promote receipt", () => {
  const groups = groupReceiptsByTask([
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1" }),
    rec({
      seq: 2,
      operation: "worker.run.summary",
      status: "success",
      requestId: "t-1",
      metadata: { promoted: true, workspaceId: "ws-9", targetRepo: "ikbi", originAgent: "hermes", costUsd: 0.01 },
    }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.promoted, true, "successful promote must not be undercounted");
  assert.equal(groups[0]!.status, "success");
  assert.equal(groups[0]!.workspaceId, "ws-9");
  assert.equal(groups[0]!.project, "ikbi");
  assert.equal(groups[0]!.originAgent, "hermes");
  assert.equal(groups[0]!.costUsd, 0.01);
});

test("promotedCommit comes from a successful promote receipt's after.ref", () => {
  const groups = groupReceiptsByTask([
    rec({
      seq: 1,
      operation: "workspace.promote",
      status: "success",
      requestId: "t-1",
      changes: [{ kind: "state", target: "ikbi#main", summary: "promote", after: { ref: "abc123" } }] as Receipt["changes"],
    }),
  ]);
  assert.equal(groups[0]!.promotedCommit, "abc123");
});

test("receipts with no task key are excluded from grouping (not builds)", () => {
  const groups = groupReceiptsByTask([
    rec({ seq: 1, operation: "dependency.install", status: "success" }),
    rec({ seq: 2, operation: "workspace.promote", status: "success", requestId: "t-1" }),
  ]);
  assert.equal(groups.length, 1);
});

test("summarizeGroups totals agree with the per-group classification", () => {
  const groups = groupReceiptsByTask([
    rec({ seq: 1, operation: "workspace.promote", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.run.summary", status: "success", requestId: "t-2", metadata: { promoted: true, costUsd: 0.02 } }),
    rec({ seq: 3, operation: "worker.role.builder", status: "failure", requestId: "t-3" }),
    rec({ seq: 4, operation: "worker.role.builder", status: "success", requestId: "t-4" }), // pending: green but not promoted
  ]);
  const totals = summarizeGroups(groups);
  assert.equal(totals.totalTasks, 4);
  assert.equal(totals.successes, 2);
  assert.equal(totals.failures, 1);
  assert.equal(totals.pending, 1);
  assert.equal(totals.promotes, 2);
  assert.equal(totals.totalCostUsd, 0.02);
});
