/**
 * Tests for GET /api/receipts and GET /api/receipts/:id.
 * Routes are registered via the createReceiptsRouteRegistrar factory (injectable store).
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { buildServer } from "./index.js";
import { registerRoutes, routes } from "./registry.js";
import { createReceiptsRouteRegistrar } from "./receipts.js";

// createReceiptsRouteRegistrar is imported from receipts.ts, which fires registerRoutes("receipts", ...)
// at module scope. beforeEach clears the registry so each test registers a fresh mock-store version.
beforeEach(() => routes.reset());

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };

function rec(over: {
  seq: number;
  id?: string;
  operation: string;
  status: Receipt["outcome"]["status"];
  requestId?: string;
  metadata?: Record<string, unknown>;
}): Receipt {
  return {
    contractVersion: "1.0.0",
    id: over.id ?? `r${over.seq}`,
    seq: over.seq,
    timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: IDENTITY,
    operation: over.operation,
    outcome: { status: over.status },
    changes: [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  };
}

/** A task-t1 trail plus one unrelated receipt. */
const FIXTURES: Receipt[] = [
  rec({ seq: 1, operation: "worker.role.scout", status: "success", requestId: "t-1", metadata: { taskId: "t-1" } }),
  rec({ seq: 2, operation: "worker.role.builder", status: "success", requestId: "t-1", metadata: { taskId: "t-1" } }),
  rec({ seq: 3, operation: "workspace.promote", status: "success", requestId: "t-1" }),
  rec({ seq: 4, id: "fixed-id-for-lookup", operation: "worker.role.builder", status: "failure", requestId: "t-2", metadata: { taskId: "t-2" } }),
];

/** Mock store that records what filters it was called with. */
function mockStore(list: Receipt[]) {
  const calls: (ReceiptQuery | undefined)[] = [];
  return {
    calls,
    store: {
      query: async (filter?: ReceiptQuery): Promise<Receipt[]> => {
        calls.push(filter);
        // Mirror the real store: apply agentId and limit filters in-process.
        let result = [...list];
        if (filter?.agentId !== undefined) result = result.filter((r) => r.identity.agentId === filter.agentId);
        if (filter?.limit !== undefined && filter.limit >= 0 && result.length > filter.limit) {
          result = result.slice(result.length - filter.limit);
        }
        return result;
      },
    },
  };
}

function setup(list: Receipt[] = FIXTURES) {
  const { store, calls } = mockStore(list);
  registerRoutes("receipts", createReceiptsRouteRegistrar(store));
  return { calls };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

test("GET /api/receipts is registered via the createReceiptsRouteRegistrar seam", () => {
  routes.reset();
  registerRoutes("receipts", createReceiptsRouteRegistrar({ query: async () => [] }));
  assert.ok(routes.modules().includes("receipts"), "receipts module registered its routes");
});

// ---------------------------------------------------------------------------
// GET /api/receipts
// ---------------------------------------------------------------------------

test("GET /api/receipts returns all fixtures with default limit=50", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, FIXTURES.length);
    assert.equal(body.receipts.length, FIXTURES.length);
    // newest-last: seq order preserved
    assert.equal(body.receipts[0]!.seq, 1);
    assert.equal(body.receipts[body.receipts.length - 1]!.seq, 4);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?limit=2 caps the result", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?limit=2" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 2);
    assert.equal(body.receipts.length, 2);
    // most recent 2 (newest-last): seqs 3 and 4
    assert.equal(body.receipts[0]!.seq, 3);
    assert.equal(body.receipts[1]!.seq, 4);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?limit=0 returns empty list", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?limit=0" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 0);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?limit=abc returns 400", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?limit=abc" });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.match(body.error, /non-negative integer/);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?limit=-1 returns 400", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?limit=-1" });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?limit=1.5 returns 400", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?limit=1.5" });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?agent=builder-1 filters by agent id", async () => {
  const mixed: Receipt[] = [
    rec({ seq: 1, operation: "worker.role.scout", status: "success" }),
    { ...rec({ seq: 2, operation: "worker.role.builder", status: "success" }), identity: { agentId: "other-agent", trustTier: "trusted" } },
  ];
  const { store } = mockStore(mixed);
  registerRoutes("receipts", createReceiptsRouteRegistrar(store));
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?agent=builder-1" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 1);
    assert.equal(body.receipts[0]!.identity.agentId, "builder-1");
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?task=t-1 returns only t-1 receipts (via requestId)", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?task=t-1" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    // seqs 1, 2, 3 belong to t-1
    assert.equal(body.count, 3);
    for (const r of body.receipts) {
      assert.equal(r.requestId, "t-1");
    }
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?task=t-2 returns only t-2 receipts (via metadata.taskId)", async () => {
  // seq 4 only has metadata.taskId="t-2" and requestId="t-2"
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?task=t-2" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 1);
    assert.equal(body.receipts[0]!.seq, 4);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?task=unknown returns empty list", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?task=unknown" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 0);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts returns empty list when store is empty", async () => {
  const { store } = mockStore([]);
  registerRoutes("receipts", createReceiptsRouteRegistrar(store));
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 0);
    assert.deepEqual(body.receipts, []);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// GET /api/receipts/:id
// ---------------------------------------------------------------------------

test("GET /api/receipts/:id returns the matching receipt", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts/fixed-id-for-lookup" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Receipt;
    assert.equal(body.id, "fixed-id-for-lookup");
    assert.equal(body.seq, 4);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts/:id returns 404 for unknown id", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts/does-not-exist" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: string };
    assert.match(body.error, /not found/);
  } finally {
    await app.close();
  }
});
