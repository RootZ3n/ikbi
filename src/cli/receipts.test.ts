/**
 * SG-4 (audit): `ikbi receipts` shows history; `--task <id>` prints one run's trail
 * (roles attempted, verification result, promote) from the receipt store.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createReceiptsCli, parseReceiptsArgs } from "./receipts.js";

const ID: AgentIdentity = { agentId: "worker-1", trustTier: "trusted" };
function rec(over: Partial<Receipt> & { seq: number; operation: string; status: Receipt["outcome"]["status"]; detail?: string }): Receipt {
  return {
    contractVersion: "1.0.0", id: `r${over.seq}`, seq: over.seq, timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: ID, operation: over.operation, outcome: { status: over.status, ...(over.detail !== undefined ? { detail: over.detail } : {}) },
    changes: over.changes ?? [], ...(over.requestId !== undefined ? { requestId: over.requestId } : {}), ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  } as Receipt;
}

/** A run "t-1" trail: five role receipts + a promote, plus an unrelated receipt for "t-2". */
const RUN: Receipt[] = [
  rec({ seq: 1, operation: "worker.role.scout", status: "success", requestId: "t-1", metadata: { role: "scout", taskId: "t-1" } }),
  rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "t-1", metadata: { role: "builder", taskId: "t-1" } }),
  rec({ seq: 3, operation: "worker.role.critic", status: "success", requestId: "t-1", metadata: { role: "critic", taskId: "t-1" } }),
  rec({ seq: 4, operation: "worker.role.verifier", status: "success", requestId: "t-1", metadata: { role: "verifier", taskId: "t-1" } }),
  rec({ seq: 5, operation: "worker.role.integrator", status: "success", requestId: "t-1", metadata: { role: "integrator", taskId: "t-1" } }),
  rec({ seq: 6, operation: "workspace.promote", status: "success", detail: "fast_forward", requestId: "t-1", metadata: { workspaceId: "ws1", strategy: "fast_forward" } }),
  rec({ seq: 7, operation: "worker.role.builder", status: "failure", requestId: "t-2", metadata: { role: "builder", taskId: "t-2" } }),
];

function store(list: Receipt[]) {
  const seen: ReceiptQuery[] = [];
  return {
    seen,
    receipts: { query: async (filter: ReceiptQuery = {}): Promise<Receipt[]> => { seen.push(filter); return [...list]; } },
  };
}
function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

test("parseReceiptsArgs extracts --task and --limit", () => {
  assert.deepEqual(parseReceiptsArgs(["--task", "t-1"]), { task: "t-1" });
  assert.deepEqual(parseReceiptsArgs(["--task=abc", "--limit=5"]), { task: "abc", limit: 5 });
  assert.deepEqual(parseReceiptsArgs([]), {});
});

test("`receipts --task <id>` prints the run's trail with roles, verification, and promote", async () => {
  const s = store(RUN);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--task", "t-1"]);

  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Task t-1/);
  assert.match(cap.out, /roles: scout=success, builder=success, critic=success, verifier=success, integrator=success/);
  assert.match(cap.out, /verification: success/);
  assert.match(cap.out, /promote: success \(fast_forward\)/);
  assert.match(cap.out, /receipts: 6/, "the 6 t-1 receipts (NOT the t-2 one) form the trail");
  assert.ok(!cap.out.includes("t-2"), "an unrelated run is not mixed in");
});

test("`receipts --task` on an unknown task fails closed with a clear message", async () => {
  const s = store(RUN);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--task", "nope"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no receipts found for task "nope"/);
});

test("`receipts` (no args) lists recent receipts with seq/op/outcome/agent", async () => {
  const s = store(RUN);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--limit", "10"]);
  assert.match(cap.out, /7 receipt\(s\)/);
  assert.match(cap.out, /#6 .* workspace\.promote → success {2}by worker-1/);
  assert.deepEqual(s.seen.at(-1), { limit: 10 }, "the limit was passed to the store query");
});
