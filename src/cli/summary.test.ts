/**
 * `ikbi summary` — compact build overview from the receipt log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createSummaryCli, parseSummaryArgs } from "./summary.js";

const ID: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };
const ID2: AgentIdentity = { agentId: "builder-2", trustTier: "trusted" };

function rec(
  over: Partial<Receipt> & {
    seq: number;
    operation: string;
    status: Receipt["outcome"]["status"];
    requestId?: string;
    detail?: string;
    error?: string;
    costUsd?: number;
    identity?: AgentIdentity;
    rootCause?: string;
  },
): Receipt {
  const meta: Record<string, unknown> = {};
  if (over.costUsd !== undefined) meta.costUsd = over.costUsd;
  if (over.rootCause !== undefined) meta.rootCause = over.rootCause;
  return {
    contractVersion: "1.0.0",
    id: `r${over.seq}`,
    seq: over.seq,
    timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: over.identity ?? ID,
    operation: over.operation,
    outcome: {
      status: over.status,
      ...(over.detail !== undefined ? { detail: over.detail } : {}),
      ...(over.error !== undefined ? { error: over.error } : {}),
    },
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

test("parseSummaryArgs: defaults to 1 day", () => {
  assert.deepEqual(parseSummaryArgs([]), { days: 1 });
});

test("parseSummaryArgs: --days N and --days=N", () => {
  assert.deepEqual(parseSummaryArgs(["--days", "7"]), { days: 7 });
  assert.deepEqual(parseSummaryArgs(["--days=3"]), { days: 3 });
});

test("parseSummaryArgs: invalid/negative --days falls back to 1", () => {
  assert.deepEqual(parseSummaryArgs(["--days", "0"]), { days: 1 });
  assert.deepEqual(parseSummaryArgs(["--days", "-5"]), { days: 1 });
  assert.deepEqual(parseSummaryArgs(["--days", "abc"]), { days: 1 });
});

test("summary: empty receipt store shows 0 builds", async () => {
  const s = store([]);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).summary([]);
  assert.equal(cap.exit, undefined);
  assert.match(cap.out, /Total builds:\s+0/);
  assert.match(cap.out, /Success rate:\s+n\/a/);
  assert.match(cap.out, /Total cost:\s+n\/a/);
  assert.match(cap.out, /Average cost:\s+n\/a/);
  assert.match(cap.out, /Top failure reason:\s+none/);
  assert.match(cap.out, /Most active agent:\s+none/);
});

test("summary: passes fromTime based on --days to the store", async () => {
  const s = store([]);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary(["--days", "3"]);
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0]?.fromTime, NOW - 3 * 24 * 60 * 60 * 1000);
});

test("summary: counts distinct requestIds as builds", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "workspace.promote", status: "success", requestId: "t-1" }),
    rec({ seq: 3, operation: "worker.role.builder", status: "failure", requestId: "t-2" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Total builds:\s+2/);
  assert.match(cap.out, /Success rate:\s+50\.0%/);
});

test("summary: 100% success rate when all builds have successful promote", async () => {
  const receipts = [
    rec({ seq: 1, operation: "workspace.promote", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "workspace.promote", status: "success", requestId: "t-2" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Total builds:\s+2/);
  assert.match(cap.out, /Success rate:\s+100\.0%/);
  assert.match(cap.out, /Top failure reason:\s+none/);
});

test("summary: aggregates cost from metadata.costUsd", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1", costUsd: 0.002 }),
    rec({ seq: 2, operation: "workspace.promote", status: "success", requestId: "t-1" }),
    rec({ seq: 3, operation: "worker.role.builder", status: "success", requestId: "t-2", costUsd: 0.004 }),
    rec({ seq: 4, operation: "workspace.promote", status: "success", requestId: "t-2" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Total cost:\s+\$0\.0060/);
  assert.match(cap.out, /Average cost:\s+\$0\.0030/);
});

test("summary: shows top failure reason from outcome.detail", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "failure", detail: "checks failed", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.role.builder", status: "failure", detail: "checks failed", requestId: "t-2" }),
    rec({ seq: 3, operation: "worker.role.builder", status: "failure", detail: "timeout", requestId: "t-3" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Top failure reason:\s+checks failed/);
});

test("summary: falls back to metadata.rootCause for failure reason", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.builder", status: "failure", rootCause: "missing import", requestId: "t-1" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Top failure reason:\s+missing import/);
});

test("summary: most active agent by receipt count", async () => {
  const receipts = [
    rec({ seq: 1, operation: "worker.role.scout", status: "success", requestId: "t-1", identity: ID }),
    rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "t-1", identity: ID }),
    rec({ seq: 3, operation: "worker.role.builder", status: "success", requestId: "t-2", identity: ID2 }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Most active agent:\s+builder-1 \(2\)/);
});

test("summary: receipts without requestId are ignored for build count", async () => {
  const receipts = [
    rec({ seq: 1, operation: "dependency.install", status: "success" }),
    rec({ seq: 2, operation: "workspace.promote", status: "success", requestId: "t-1" }),
  ];
  const s = store(receipts);
  const cap = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap.stdout }).summary([]);
  assert.match(cap.out, /Total builds:\s+1/);
});

test("summary: store error exits 1 with message to stderr", async () => {
  const broken = { query: async () => { throw new Error("disk failure"); } };
  const cap = capture();
  await createSummaryCli({ receipts: broken, now: () => NOW, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).summary([]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /disk failure/);
});

test("summary: window label says 'last 24 hours' for default, 'last N days' for N>1", async () => {
  const s = store([]);
  const cap1 = capture();
  const cap2 = capture();
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap1.stdout }).summary([]);
  await createSummaryCli({ receipts: s.receipts, now: () => NOW, stdout: cap2.stdout }).summary(["--days", "7"]);
  assert.match(cap1.out, /last 24 hours/);
  assert.match(cap2.out, /last 7 days/);
});
