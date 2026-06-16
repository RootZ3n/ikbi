/**
 * `ikbi summary` — task-grouping reconciliation (lab-trust sprint, Phase 3).
 *
 * Proves the promote FALLBACK: a successful promote recorded only in a
 * worker.run.summary receipt (no standalone workspace.promote) is still counted
 * as a successful build — so summary no longer undercounts promotes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createSummaryCli } from "./summary.js";

const ID: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };

function rec(over: {
  seq: number;
  operation: string;
  status: Receipt["outcome"]["status"];
  requestId?: string;
  metadata?: Record<string, unknown>;
}): Receipt {
  return {
    contractVersion: "1.0.0",
    id: `r${over.seq}`,
    seq: over.seq,
    timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: ID,
    operation: over.operation,
    outcome: { status: over.status },
    changes: [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  } as Receipt;
}

function store(list: Receipt[]) {
  return { query: async (_f: ReceiptQuery = {}): Promise<Receipt[]> => [...list] };
}

function capture() {
  let out = "";
  return { stdout: (s: string) => void (out += s), get out() { return out; } };
}

const NOW = 1_700_100_000_000;

test("summary counts a run-summary promote with NO standalone promote receipt as a success", async () => {
  const receipts = [
    // Task t-1 promoted, but the only evidence is the run-summary receipt.
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.run.summary", status: "success", requestId: "t-1", metadata: { promoted: true } }),
    // Task t-2 genuinely failed.
    rec({ seq: 3, operation: "worker.role.builder", status: "failure", requestId: "t-2" }),
  ];
  const cap = capture();
  await createSummaryCli({ receipts: store(receipts), now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Total builds:\s+2/);
  assert.match(cap.out, /Success rate:\s+50\.0%/);
});

test("summary does NOT undercount: one task with both run-summary and standalone promote is a single success", async () => {
  const receipts = [
    rec({ seq: 1, operation: "workspace.promote", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.run.summary", status: "success", requestId: "t-1", metadata: { promoted: true } }),
  ];
  const cap = capture();
  await createSummaryCli({ receipts: store(receipts), now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Total builds:\s+1/);
  assert.match(cap.out, /Success rate:\s+100\.0%/);
});

test("summary: a green build that did not promote is counted but not a success (pending)", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.run.summary", status: "success", requestId: "t-1", metadata: { promoted: false } }),
  ];
  const cap = capture();
  await createSummaryCli({ receipts: store(receipts), now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Total builds:\s+1/);
  assert.match(cap.out, /Success rate:\s+0\.0%/);
});
