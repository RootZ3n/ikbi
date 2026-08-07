import assert from "node:assert/strict";
import { test } from "node:test";

import type { Receipt } from "../core/receipt/contract.js";
import { inspectRun } from "./inspect.js";

function receipt(id: string, operation: string, opts: { requestId?: string; metadata?: Record<string, unknown>; changes?: Receipt["changes"] } = {}): Receipt {
  return {
    contractVersion: "1.0.0",
    id,
    seq: 1,
    timestamp: 1,
    identity: { agentId: "test", functionalRole: "test", trustTier: "trusted" },
    operation,
    outcome: { status: "success" },
    changes: opts.changes ?? [],
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
}

test("inspect locates completed run evidence without a parallel event store", async () => {
  const runId = "run-inspect-complete";
  const taskId = "task-inspect";
  const all = [
    receipt("invoke-1", "model.invoke", { requestId: taskId, metadata: { taskId, invocationId: "provider-attempt-1" } }),
    receipt("verify-1", "worker.verification", { requestId: taskId, metadata: { taskId, verificationResult: "passed" } }),
    receipt("summary-1", "run.summary", {
      requestId: runId,
      metadata: {
        runId,
        taskId,
        repository: "/tmp/target",
        status: "completed",
        phase: "completed",
        workspaceId: "workspace-1",
        candidateId: "candidate-1",
        verification: "passed",
        promotion: "promoted",
        paidInvocationStarted: true,
        mutationApplied: true,
        partialMutation: false,
        retryable: false,
        diagnosticBundle: "/tmp/run-inspect.stderr.log",
        recovery: [],
      },
    }),
  ];
  const result = await inspectRun(runId, {
    readReceipts: async () => all,
    receiptPath: "/tmp/receipts.ndjson",
    getWorkspace: async () => ({ id: "workspace-1", path: "/tmp/workspace-1", state: "promoted", targetRepo: "/tmp/target" } as never),
  });
  assert.equal(result.status, "found");
  assert.equal(result.run?.status, "completed");
  assert.equal(result.workspace.path, "/tmp/workspace-1");
  assert.equal(result.candidate.id, "candidate-1");
  assert.equal(result.verification.status, "passed");
  assert.equal(result.promotion.status, "promoted");
  assert.deepEqual(result.evidence.invocationLedger, ["receipt:invoke-1"]);
  assert.deepEqual(result.evidence.verification, ["receipt:verify-1"]);
  assert.deepEqual(result.evidence.logs, ["/tmp/run-inspect.stderr.log"]);
  assert.equal(result.run?.retryable, false);
});

test("inspect locates failed run evidence and gives a stable not-found result", async () => {
  const failed = receipt("summary-2", "run.summary", {
    requestId: "run-inspect-failed",
    metadata: {
      runId: "run-inspect-failed",
      taskId: "task-failed",
      status: "failed",
      phase: "verification",
      paidInvocationStarted: true,
      mutationApplied: true,
      partialMutation: true,
      retryable: true,
      recovery: ["Inspect the retained workspace before retrying."],
    },
  });
  const found = await inspectRun("run-inspect-failed", { readReceipts: async () => [failed], receiptPath: "/tmp/receipts.ndjson" });
  assert.equal(found.status, "found");
  assert.equal(found.run?.status, "failed");
  assert.equal(found.run?.retryable, true);
  assert.deepEqual(found.recovery, ["Inspect the retained workspace before retrying."]);

  const missing = await inspectRun("run-does-not-exist", { readReceipts: async () => [failed] });
  assert.equal(missing.code, "INSPECT_NOT_FOUND");
  assert.equal(missing.exitCode, 20);
});
