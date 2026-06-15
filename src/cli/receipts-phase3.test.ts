/**
 * Phase 3 — receipts: tests for `ikbi receipts verify` and task-trail enhancements.
 * (Additive — does not modify receipts.test.ts or receipts-phase2.test.ts.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createReceiptsCli, verifyReceiptIntegrity } from "./receipts.js";

const ID: AgentIdentity = { agentId: "worker-1", trustTier: "trusted" };
const PARENT_ID: AgentIdentity = { agentId: "parent-1", trustTier: "trusted" };

function rec(over: Partial<Receipt> & { seq: number; operation: string; status: Receipt["outcome"]["status"]; detail?: string }): Receipt {
  return {
    contractVersion: "1.0.0", id: `r${over.seq}`, seq: over.seq,
    timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: over.identity ?? ID, operation: over.operation,
    outcome: { status: over.status, ...(over.detail !== undefined ? { detail: over.detail } : {}) },
    changes: over.changes ?? [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  } as Receipt;
}

function store(list: Receipt[]) {
  return {
    receipts: {
      query: async (_filter: ReceiptQuery = {}): Promise<Receipt[]> => [...list],
    },
  };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

// ── verifyReceiptIntegrity (pure) ─────────────────────────────────────────────

test("verifyReceiptIntegrity: empty store is OK", () => {
  const r = verifyReceiptIntegrity([]);
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.deepEqual(r.gaps, []);
});

test("verifyReceiptIntegrity: sequential receipts (0,1,2,3) are OK", () => {
  const receipts = [
    rec({ seq: 0, operation: "worker.role.scout", status: "success" }),
    rec({ seq: 1, operation: "worker.role.builder", status: "success" }),
    rec({ seq: 2, operation: "worker.role.verifier", status: "success" }),
    rec({ seq: 3, operation: "workspace.promote", status: "success" }),
  ];
  const r = verifyReceiptIntegrity(receipts);
  assert.equal(r.ok, true);
  assert.equal(r.total, 4);
  assert.deepEqual(r.gaps, []);
});

test("verifyReceiptIntegrity: a single gap is detected", () => {
  const receipts = [
    rec({ seq: 0, operation: "worker.role.scout", status: "success" }),
    rec({ seq: 1, operation: "worker.role.builder", status: "success" }),
    // seq 2 is missing
    rec({ seq: 3, operation: "workspace.promote", status: "success" }),
  ];
  const r = verifyReceiptIntegrity(receipts);
  assert.equal(r.ok, false);
  assert.equal(r.gaps.length, 1);
  assert.deepEqual(r.gaps[0], { afterSeq: 1, beforeSeq: 3 });
});

test("verifyReceiptIntegrity: multiple gaps are all reported", () => {
  const receipts = [
    rec({ seq: 0, operation: "op.a", status: "success" }),
    // gap: seq 1, 2 missing
    rec({ seq: 3, operation: "op.b", status: "success" }),
    // gap: seq 4 missing
    rec({ seq: 5, operation: "op.c", status: "success" }),
    rec({ seq: 6, operation: "op.d", status: "success" }),
  ];
  const r = verifyReceiptIntegrity(receipts);
  assert.equal(r.ok, false);
  assert.equal(r.gaps.length, 2);
  assert.deepEqual(r.gaps[0], { afterSeq: 0, beforeSeq: 3 });
  assert.deepEqual(r.gaps[1], { afterSeq: 3, beforeSeq: 5 });
});

test("verifyReceiptIntegrity: out-of-order receipts are sorted before checking", () => {
  // Receipts stored out of seq order (unusual but should still work).
  const receipts = [
    rec({ seq: 2, operation: "op.c", status: "success" }),
    rec({ seq: 0, operation: "op.a", status: "success" }),
    rec({ seq: 1, operation: "op.b", status: "success" }),
  ];
  const r = verifyReceiptIntegrity(receipts);
  assert.equal(r.ok, true, "0,1,2 are sequential even when stored out of order");
});

// ── `receipts verify` integration (through createReceiptsCli) ─────────────────

test("`receipts verify` exits 0 and reports OK for sequential receipts", async () => {
  const sequential = [
    rec({ seq: 0, operation: "worker.role.scout", status: "success" }),
    rec({ seq: 1, operation: "worker.role.builder", status: "success" }),
    rec({ seq: 2, operation: "workspace.promote", status: "success" }),
  ];
  const s = store(sequential);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["verify"]);
  assert.equal(cap.exit, undefined, "exit 0 on no gaps");
  assert.match(cap.out, /3 total/);
  assert.match(cap.out, /OK/);
});

test("`receipts verify` exits 1 and reports gap details when gaps are present", async () => {
  const gapped = [
    rec({ seq: 0, operation: "op.a", status: "success" }),
    rec({ seq: 1, operation: "op.b", status: "success" }),
    // seq 2 missing
    rec({ seq: 3, operation: "op.d", status: "success" }),
  ];
  const s = store(gapped);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["verify"]);
  assert.equal(cap.exit, 1, "exit 1 when gaps exist");
  assert.match(cap.out, /GAPS DETECTED/);
  assert.match(cap.out, /seq 1 → 3/);
});

test("`receipts verify` on an empty store reports OK", async () => {
  const s = store([]);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["verify"]);
  assert.equal(cap.exit, undefined, "empty store is OK — exit 0");
  assert.match(cap.out, /0 total/);
  assert.match(cap.out, /OK/);
});

// ── `receipts --task` shows standardized run summary metadata ─────────────────

test("`receipts --task` includes repo, branch, model, cost from worker.run.summary receipt", async () => {
  const taskReceipts = [
    rec({ seq: 0, operation: "worker.role.scout", status: "success", requestId: "t-42",
          metadata: { role: "scout", taskId: "t-42", workspaceId: "ws1" } }),
    rec({ seq: 1, operation: "worker.role.verifier", status: "success", requestId: "t-42",
          metadata: { role: "verifier", taskId: "t-42", workspaceId: "ws1" } }),
    rec({ seq: 2, operation: "worker.run.summary", status: "success", requestId: "t-42",
          identity: PARENT_ID,
          metadata: {
            taskId: "t-42", workspaceId: "ws1",
            targetRepo: "/home/user/myrepo",
            targetBranch: "main",
            model: "claude-haiku-4-5",
            costUsd: 0.001234,
            promoted: true,
            verificationResult: "success",
          } }),
  ];
  const s = store(taskReceipts);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--task", "t-42"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Task t-42/);
  assert.match(cap.out, /repo: \/home\/user\/myrepo/);
  assert.match(cap.out, /branch: main/);
  assert.match(cap.out, /model: claude-haiku-4-5/);
  assert.match(cap.out, /cost: \$0\.001234/);
});
