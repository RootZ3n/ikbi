/**
 * buildDigest — reads worker.run.summary receipts and aggregates a classified digest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDigest, formatMonitorDigest, type ReceiptLike } from "./monitor.js";

const summary = (taskId: string, meta: Record<string, unknown>, detail?: string): ReceiptLike => ({
  operation: "worker.run.summary",
  requestId: taskId,
  outcome: { status: "x", ...(detail !== undefined ? { detail } : {}) },
  metadata: { taskId, ...meta },
});

test("aggregates promoted vs failed and flags harness-suspect", () => {
  const receipts: ReceiptLike[] = [
    summary("t1", { outcome: "success", promoted: true }),
    summary("t2", { outcome: "rejected", targetRepo: "/r" }, "No project manifest or verifier detected."),
    summary("t3", { outcome: "partial", promoted: false }, 'the worker tier "verified" lacks autoCommit autonomy; run ikbi trust grant worker trusted'),
    summary("t4", { outcome: "failure" }, "run ended with role outcome \"failure\""),
    // a non-build receipt is ignored
    { operation: "govexec.run", metadata: {} },
  ];
  const d = buildDigest(receipts);
  assert.equal(d.total, 4);
  assert.equal(d.promoted, 1);
  assert.equal(d.failed, 3);
  assert.equal(d.harnessSuspect, 2, "checks_unresolvable + trust_gate are harness-suspect; the plain failure is not");
  assert.equal(d.bySignal["checks_unresolvable"], 1);
  assert.equal(d.bySignal["trust_gate"], 1);
});

test("cross-references verificationKind from a checks_unresolvable receipt", () => {
  const receipts: ReceiptLike[] = [
    { operation: "worker.checks_unresolvable", requestId: "t9", metadata: { taskId: "t9", verificationKind: "checks_unresolvable" } },
    summary("t9", { outcome: "rejected" }, "target could not be verified"),
  ];
  const d = buildDigest(receipts);
  assert.equal(d.failures[0]?.classification.signal, "checks_unresolvable");
  assert.ok(d.failures[0]?.classification.harnessSuspect);
});

test("failures list is most-recent-first and limit-bounded", () => {
  const receipts: ReceiptLike[] = [
    summary("old", { outcome: "failure" }, "x"),
    summary("new", { outcome: "failure" }, "y"),
  ];
  const d = buildDigest(receipts, { limit: 1 });
  assert.equal(d.failures.length, 1);
  assert.equal(d.failures[0]?.taskId, "new");
});

test("formatMonitorDigest renders a readable report with the harness callout", () => {
  const d = buildDigest([summary("t2", { outcome: "rejected" }, "No project manifest or verifier detected.")]);
  const s = formatMonitorDigest(d);
  assert.match(s, /HARNESS-SUSPECT/);
  assert.match(s, /candidates for self-heal/);
});

test("all-clear digest says so", () => {
  const s = formatMonitorDigest(buildDigest([summary("t1", { outcome: "success", promoted: true })]));
  assert.match(s, /All recorded builds promoted|nothing to look at/);
});
