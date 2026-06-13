/**
 * `ikbi cost` — per-task cost breakdowns and trends from the receipt log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createCostCli, parseCostArgs } from "./cost.js";

const ID: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };

function rec(
  over: Partial<Receipt> & {
    seq: number;
    operation: string;
    status: Receipt["outcome"]["status"];
    requestId?: string;
    costUsd?: number;
    model?: string;
    timestamp?: number;
    identity?: AgentIdentity;
  },
): Receipt {
  const meta: Record<string, unknown> = {};
  if (over.costUsd !== undefined) meta.costUsd = over.costUsd;
  if (over.model !== undefined) meta.model = over.model;
  return {
    contractVersion: "1.0.0",
    id: `r${over.seq}`,
    seq: over.seq,
    timestamp: over.timestamp ?? 1_700_000_000_000 + over.seq * 1000,
    identity: over.identity ?? ID,
    operation: over.operation,
    outcome: { status: over.status },
    changes: [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
  } as Receipt;
}

function store(list: Receipt[]) {
  const seen: ReceiptQuery[] = [];
  return {
    seen,
    receipts: {
      query: async (filter: ReceiptQuery = {}): Promise<Receipt[]> => {
        seen.push(filter);
        return [...list];
      },
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

const NOW = 1_700_100_000_000;

// ── parseCostArgs ─────────────────────────────────────────────────────────────

test("parseCostArgs: defaults to 7 days, no task", () => {
  assert.deepEqual(parseCostArgs([]), { days: 7 });
});

test("parseCostArgs: --days N and --days=N", () => {
  assert.deepEqual(parseCostArgs(["--days", "30"]), { days: 30 });
  assert.deepEqual(parseCostArgs(["--days=14"]), { days: 14 });
});

test("parseCostArgs: invalid/negative --days falls back to 7", () => {
  assert.deepEqual(parseCostArgs(["--days", "0"]), { days: 7 });
  assert.deepEqual(parseCostArgs(["--days", "-3"]), { days: 7 });
  assert.deepEqual(parseCostArgs(["--days", "abc"]), { days: 7 });
});

test("parseCostArgs: --task <id> and --task=<id>", () => {
  assert.deepEqual(parseCostArgs(["--task", "t-1"]), { days: 7, task: "t-1" });
  assert.deepEqual(parseCostArgs(["--task=t-2"]), { days: 7, task: "t-2" });
});

// ── empty store ───────────────────────────────────────────────────────────────

test("cost: no receipts shows zeros", async () => {
  const s = store([]);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).cost([]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Total cost:\s+\$0\.0000/);
  assert.match(cap.out, /Builds:\s+0/);
  assert.match(cap.out, /Average cost\/build:\s+\$0\.0000/);
  assert.match(cap.out, /Most expensive task:\s+none/);
});

// ── period (default / --days) ─────────────────────────────────────────────────

test("cost: aggregates total, builds, and average across receipts", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1", costUsd: 0.002, model: "mimo-v2.5" }),
    rec({ seq: 2, operation: "workspace.promote", status: "success", requestId: "t-1" }),
    rec({ seq: 3, operation: "worker.role.builder", status: "success", requestId: "t-2", costUsd: 0.006, model: "mimo-v2.5" }),
    rec({ seq: 4, operation: "workspace.promote", status: "success", requestId: "t-2" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost([]);
  assert.match(cap.out, /Total cost:\s+\$0\.0080/);
  assert.match(cap.out, /Builds:\s+2/);
  assert.match(cap.out, /Average cost\/build:\s+\$0\.0040/);
});

test("cost: per-model breakdown sums cost by model", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.scout", status: "success", requestId: "t-1", costUsd: 0.001, model: "mimo-v2.5" }),
    rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "t-1", costUsd: 0.003, model: "mimo-v2.5" }),
    rec({ seq: 3, operation: "worker.role.critic", status: "success", requestId: "t-1", costUsd: 0.005, model: "gpt-4o" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost([]);
  // mimo-v2.5 = 0.004, gpt-4o = 0.005; sorted by cost descending → gpt-4o first.
  assert.match(cap.out, /gpt-4o\s+\$0\.0050/);
  assert.match(cap.out, /mimo-v2\.5\s+\$0\.0040/);
  assert.ok(cap.out.indexOf("gpt-4o") < cap.out.indexOf("mimo-v2.5"), "higher-cost model listed first");
});

test("cost: receipts without a model are bucketed under 'unknown'", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1", costUsd: 0.002 }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost([]);
  assert.match(cap.out, /unknown\s+\$0\.0020/);
});

test("cost: identifies the most expensive task", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "cheap", costUsd: 0.001, model: "m" }),
    rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "pricey", costUsd: 0.009, model: "m" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost([]);
  assert.match(cap.out, /Most expensive task:\s+pricey \(\$0\.0090\)/);
});

test("cost: --days passes the right fromTime to the store", async () => {
  const s = store([]);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost(["--days", "14"]);
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0]?.fromTime, NOW - 14 * 24 * 60 * 60 * 1000);
});

test("cost: default window is 7 days", async () => {
  const s = store([]);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost([]);
  assert.equal(s.seen[0]?.fromTime, NOW - 7 * 24 * 60 * 60 * 1000);
  assert.match(cap.out, /last 7 days/);
});

test("cost: per-day buckets sum cost by UTC calendar day", async () => {
  const day1 = Date.UTC(2023, 10, 14, 9); // 2023-11-14
  const day2 = Date.UTC(2023, 10, 15, 3); // 2023-11-15
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1", costUsd: 0.002, model: "m", timestamp: day1 }),
    rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "t-2", costUsd: 0.004, model: "m", timestamp: day2 }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost([]);
  assert.match(cap.out, /2023-11-14\s+\$0\.0020/);
  assert.match(cap.out, /2023-11-15\s+\$0\.0040/);
});

// ── --task filter ─────────────────────────────────────────────────────────────

test("cost: --task shows per-model breakdown and total for one task", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1", costUsd: 0.002, model: "mimo-v2.5" }),
    rec({ seq: 2, operation: "worker.role.critic", status: "success", requestId: "t-1", costUsd: 0.003, model: "gpt-4o" }),
    rec({ seq: 3, operation: "worker.role.builder", status: "success", requestId: "t-2", costUsd: 0.999, model: "mimo-v2.5" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost(["--task", "t-1"]);
  assert.match(cap.out, /ikbi cost for task t-1/);
  assert.match(cap.out, /Total cost:\s+\$0\.0050/); // only t-1's 0.002 + 0.003
  assert.match(cap.out, /Receipts:\s+2/);
  assert.match(cap.out, /mimo-v2\.5\s+\$0\.0020/);
  assert.match(cap.out, /gpt-4o\s+\$0\.0030/);
  assert.ok(!cap.out.includes("0.9990"), "other task's cost is excluded");
});

test("cost: --task matches metadata.taskId when requestId is absent", async () => {
  const r = rec({ seq: 1, operation: "worker.fix_loop", status: "success", costUsd: 0.004, model: "m" });
  const withTaskMeta = { ...r, metadata: { ...(r.metadata as object), taskId: "t-9" } } as Receipt;
  const s = store([withTaskMeta]);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).cost(["--task", "t-9"]);
  assert.match(cap.out, /Total cost:\s+\$0\.0040/);
});

test("cost: --task with no matching receipts exits 1 with a message", async () => {
  const s = store([rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1", costUsd: 0.002, model: "m" })]);
  const cap = capture();
  await createCostCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).cost(["--task", "missing"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no receipts found for task "missing"/);
});

// ── error handling ────────────────────────────────────────────────────────────

test("cost: store error exits 1 with message to stderr", async () => {
  const broken = { query: async () => { throw new Error("disk failure"); } };
  const cap = capture();
  await createCostCli({ receipts: broken, now: () => NOW, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).cost([]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /disk failure/);
});
