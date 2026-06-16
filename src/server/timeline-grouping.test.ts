/**
 * GET /api/timeline — task-grouped accounting (lab-trust sprint, Phase 3).
 *
 * The legacy `builds` field stays a raw-receipt count (backward compatible). The
 * added task-grouped fields count one build per task and AGREE with `summary`.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { buildServer } from "./index.js";
import { registerRoutes, routes } from "./registry.js";
import { createTimelineRouteRegistrar } from "./timeline.js";

beforeEach(() => routes.reset());

const IDENTITY: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };
const HOUR_0 = 1704067200000; // 2024-01-01T00:00:00.000Z

function rec(over: {
  seq: number;
  operation: string;
  status: Receipt["outcome"]["status"];
  requestId?: string;
  metadata?: Record<string, unknown>;
  offset?: number;
}): Receipt {
  return {
    contractVersion: "1.0.0",
    id: `r${over.seq}`,
    seq: over.seq,
    timestamp: HOUR_0 + (over.offset ?? over.seq * 100),
    identity: IDENTITY,
    operation: over.operation,
    outcome: { status: over.status },
    changes: [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  } as Receipt;
}

function setup(list: Receipt[]) {
  registerRoutes("timeline", createTimelineRouteRegistrar({ query: async (_f?: ReceiptQuery) => [...list] }));
}

interface Bucket {
  builds: number;
  taskGroups: number;
  taskSuccesses: number;
  taskFailures: number;
  taskPromotes: number;
}

test("timeline task-grouped counts collapse a multi-receipt task into one build", async () => {
  // Task t-1: 3 receipts, promoted. Task t-2: 2 receipts, failed. 5 raw receipts, 2 tasks.
  setup([
    rec({ seq: 1, operation: "worker.role.scout", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "t-1" }),
    rec({ seq: 3, operation: "workspace.promote", status: "success", requestId: "t-1" }),
    rec({ seq: 4, operation: "worker.role.builder", status: "failure", requestId: "t-2" }),
    rec({ seq: 5, operation: "worker.run.summary", status: "failure", requestId: "t-2", metadata: { promoted: false } }),
  ]);
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { buckets: Bucket[] };
    const b = body.buckets[0]!;
    assert.equal(b.builds, 5, "legacy builds = raw receipt count (unchanged)");
    assert.equal(b.taskGroups, 2, "two distinct task groups");
    assert.equal(b.taskSuccesses, 1);
    assert.equal(b.taskFailures, 1);
    assert.equal(b.taskPromotes, 1);
  } finally {
    await app.close();
  }
});

test("timeline counts a run-summary promote with no standalone promote as a task success", async () => {
  setup([
    rec({ seq: 1, operation: "worker.role.builder", status: "success", requestId: "t-1" }),
    rec({ seq: 2, operation: "worker.run.summary", status: "success", requestId: "t-1", metadata: { promoted: true } }),
  ]);
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as { buckets: Bucket[] };
    const b = body.buckets[0]!;
    assert.equal(b.taskGroups, 1);
    assert.equal(b.taskSuccesses, 1);
    assert.equal(b.taskPromotes, 1);
  } finally {
    await app.close();
  }
});
