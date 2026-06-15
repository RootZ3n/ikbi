/**
 * Phase 4 — diff enhancements: promoted/verified status and receipt-based verification.
 * Tests additive to diff-cli.test.ts and diff-phase2.test.ts (neither is modified).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceRecord } from "../../core/workspace/contract.js";
import type { Receipt } from "../../core/receipt/index.js";
import { createDiffCli } from "./cli.js";

const SAMPLE_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function makeRec(id: string, state: WorkspaceRecord["state"], extra: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return { id, targetRepo: "/repo", baseBranch: "main", baseRef: "base", scratchBranch: `ikbi/ws/${id}`, path: `/wt/${id}`, identity: { agentId: "w" }, state, createdAt: 0, updatedAt: 0, ...extra };
}

function makeSummaryReceipt(workspaceId: string, verificationResult: string, promoted: boolean): Receipt {
  return {
    contractVersion: "1.0.0", id: `sum-${workspaceId}`, seq: 1, timestamp: 0,
    identity: { agentId: "builder", trustTier: "system" },
    operation: "worker.run.summary",
    outcome: { status: "success" },
    requestId: "task-1",
    metadata: { workspaceId, verificationResult, promoted, taskId: "task-1", targetRepo: "/repo", targetBranch: "main" },
  } as unknown as Receipt;
}

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

// ── Promoted field ────────────────────────────────────────────────────────────

test("`ikbi diff` shows Promoted: yes for a promoted workspace", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "promoted"), diff: async () => SAMPLE_DIFF };
  await createDiffCli({ workspaces, receipts: { query: async () => [] }, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-ok"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Promoted: yes/);
});

test("`ikbi diff` shows Promoted: no for an unpromoted workspace", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "failed"), diff: async () => SAMPLE_DIFF };
  await createDiffCli({ workspaces, receipts: { query: async () => [] }, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-fail"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Promoted: no/);
});

test("`ikbi diff` shows Promoted: no for the no-changes case", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "allocated"), diff: async () => "   \n" };
  await createDiffCli({ workspaces, receipts: { query: async () => [] }, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-empty"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Promoted: no/);
});

// ── Verified field via receipt ─────────────────────────────────────────────────

test("`ikbi diff` shows Verified: yes when verificationResult is success", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "promoted"), diff: async () => SAMPLE_DIFF };
  const receipts = { query: async () => [makeSummaryReceipt("ws-verified", "success", true)] };
  await createDiffCli({ workspaces, receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-verified"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Verified: yes/);
});

test("`ikbi diff` shows Verified: no when verificationResult is failed", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "failed"), diff: async () => SAMPLE_DIFF };
  const receipts = { query: async () => [makeSummaryReceipt("ws-fail-v", "failed", false)] };
  await createDiffCli({ workspaces, receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-fail-v"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Verified: no/);
});

test("`ikbi diff` shows Verified: not run when verificationResult is not_run", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "promoted"), diff: async () => SAMPLE_DIFF };
  const receipts = { query: async () => [makeSummaryReceipt("ws-norun", "not_run", true)] };
  await createDiffCli({ workspaces, receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-norun"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Verified: not run/);
});

test("`ikbi diff` omits Verified when no matching run summary receipt exists", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "promoted"), diff: async () => SAMPLE_DIFF };
  const receipts = { query: async () => [makeSummaryReceipt("other-ws", "success", true)] };
  await createDiffCli({ workspaces, receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-nomatch"]);
  assert.equal(cap.exit, undefined);
  assert.doesNotMatch(cap.out, /Verified:/);
});

test("`ikbi diff` handles receipt query errors gracefully (omits Verified)", async () => {
  const cap = capture();
  const workspaces = { get: async (id: string) => makeRec(id, "promoted"), diff: async () => SAMPLE_DIFF };
  const receipts = { query: async (): Promise<Receipt[]> => { throw new Error("store unavailable"); } };
  await createDiffCli({ workspaces, receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-ok"]);
  assert.equal(cap.exit, undefined, "diff still succeeds even if receipt store fails");
  assert.doesNotMatch(cap.out, /Verified:/);
  assert.match(cap.out, /Promoted:/);
});

// ── receiptStatus warning ─────────────────────────────────────────────────────

test("`ikbi diff` warns on PROMOTED_BUT_RECEIPT_FAILED", async () => {
  const cap = capture();
  const rec = makeRec("ws-noreceipt", "promoted", { receiptStatus: "failed" });
  const workspaces = { get: async () => rec, diff: async () => SAMPLE_DIFF };
  await createDiffCli({ workspaces, receipts: { query: async () => [] }, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, colorize: false }).diff(["ws-noreceipt"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /PROMOTED_BUT_RECEIPT_FAILED/);
});
