/**
 * Phase 2 — receipts: tests for the new --latest and --failures flags.
 * (The original receipts.test.ts tests are NOT modified — only additive here.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createReceiptsCli, parseReceiptsArgs } from "./receipts.js";

const ID: AgentIdentity = { agentId: "worker-1", trustTier: "trusted" };

function rec(over: Partial<Receipt> & { seq: number; operation: string; status: Receipt["outcome"]["status"]; detail?: string }): Receipt {
  return {
    contractVersion: "1.0.0", id: `r${over.seq}`, seq: over.seq,
    timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: ID, operation: over.operation,
    outcome: { status: over.status, ...(over.detail !== undefined ? { detail: over.detail } : {}) },
    changes: over.changes ?? [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  } as Receipt;
}

const MIXED: Receipt[] = [
  rec({ seq: 1, operation: "worker.role.scout", status: "success", requestId: "t-1" }),
  rec({ seq: 2, operation: "worker.role.builder", status: "failure", requestId: "t-1", detail: "builder failed" }),
  rec({ seq: 3, operation: "workspace.promote", status: "success", requestId: "t-2" }),
  rec({ seq: 4, operation: "worker.role.verifier", status: "rejected", requestId: "t-3" }),
  rec({ seq: 5, operation: "worker.role.critic", status: "success", requestId: "t-3" }),
];

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

// ── parseReceiptsArgs — new flags ─────────────────────────────────────────────

test("parseReceiptsArgs: --latest sets the latest flag", () => {
  assert.deepEqual(parseReceiptsArgs(["--latest"]), { latest: true });
});

test("parseReceiptsArgs: --failures sets the failures flag", () => {
  assert.deepEqual(parseReceiptsArgs(["--failures"]), { failures: true });
});

test("parseReceiptsArgs: flags compose with --limit", () => {
  assert.deepEqual(parseReceiptsArgs(["--failures", "--limit", "10"]), { failures: true, limit: 10 });
  assert.deepEqual(parseReceiptsArgs(["--latest", "--limit=5"]), { latest: true, limit: 5 });
});

test("parseReceiptsArgs: unknown flags are ignored (backward compat)", () => {
  // Existing flags still parse correctly alongside new ones.
  assert.deepEqual(parseReceiptsArgs(["--task", "t-1", "--latest"]), { task: "t-1", latest: true });
});

// ── --latest ──────────────────────────────────────────────────────────────────

test("`receipts --latest` shows only the single most-recent receipt", async () => {
  const s = store(MIXED);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--latest"]);
  assert.equal(cap.exit, undefined);
  // Should show 1 receipt(s) — the last one in the list (seq 5)
  assert.match(cap.out, /1 receipt\(s\)/);
  assert.match(cap.out, /#5/, "the most-recent receipt (seq 5) is shown");
  assert.doesNotMatch(cap.out, /#1/, "older receipts are not shown");
});

test("`receipts --latest` on an empty store outputs 'no receipts yet'", async () => {
  const s = store([]);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--latest"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /no receipts yet/);
});

// ── --failures ────────────────────────────────────────────────────────────────

test("`receipts --failures` shows only non-success receipts", async () => {
  const s = store(MIXED);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--failures"]);
  assert.equal(cap.exit, undefined);
  // MIXED has seq 2 (failure) and seq 4 (rejected) as non-success
  assert.match(cap.out, /2 failed receipt\(s\)/);
  assert.match(cap.out, /#2/, "seq 2 (failure) is shown");
  assert.match(cap.out, /#4/, "seq 4 (rejected) is shown");
  assert.doesNotMatch(cap.out, /#1/, "seq 1 (success) is not shown");
  assert.doesNotMatch(cap.out, /#3/, "seq 3 (success promote) is not shown");
  assert.doesNotMatch(cap.out, /#5/, "seq 5 (success) is not shown");
});

test("`receipts --failures` shows the detail column when available", async () => {
  const s = store(MIXED);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--failures"]);
  // seq 2 has detail: "builder failed"
  assert.match(cap.out, /builder failed/);
});

test("`receipts --failures` on a store with no failures outputs 'no failed receipts'", async () => {
  const allSuccess: Receipt[] = [
    rec({ seq: 1, operation: "workspace.promote", status: "success" }),
    rec({ seq: 2, operation: "worker.role.scout", status: "success" }),
  ];
  const s = store(allSuccess);
  const cap = capture();
  await createReceiptsCli({ receipts: s.receipts, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).receipts(["--failures"]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /no failed receipts/);
});
