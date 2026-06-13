/**
 * Tests for GET /api/timeline.
 * Routes are registered via the createTimelineRouteRegistrar factory (injectable store).
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { buildServer } from "./index.js";
import { registerRoutes, routes } from "./registry.js";
import { createTimelineRouteRegistrar } from "./timeline.js";

// createTimelineRouteRegistrar is imported from timeline.ts, which fires registerRoutes("timeline", ...)
// at module scope. beforeEach clears the registry so each test registers a fresh mock-store version.
beforeEach(() => routes.reset());

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };

// 2024-01-01 UTC — three consecutive hours
const HOUR_0 = 1704067200000; // 2024-01-01T00:00:00.000Z
const HOUR_1 = 1704070800000; // 2024-01-01T01:00:00.000Z
const HOUR_2 = 1704074400000; // 2024-01-01T02:00:00.000Z

function rec(seq: number, timestamp: number, status: Receipt["outcome"]["status"], costUsd?: number): Receipt {
  return {
    contractVersion: "1.0.0",
    id: `r${seq}`,
    seq,
    timestamp,
    identity: IDENTITY,
    operation: "build.run",
    outcome: { status },
    changes: [],
    ...(costUsd !== undefined ? { metadata: { costUsd } } : {}),
  };
}

// HOUR_0: 1 success + 1 failure
// HOUR_1: 2 successes (with costs)
// HOUR_2: 1 rejected
const FIXTURES: Receipt[] = [
  rec(1, HOUR_0 + 100, "success"),
  rec(2, HOUR_0 + 200, "failure"),
  rec(3, HOUR_1 + 100, "success", 0.01),
  rec(4, HOUR_1 + 200, "success", 0.02),
  rec(5, HOUR_2 + 100, "rejected"),
];

function mockStore(list: Receipt[]) {
  const calls: (ReceiptQuery | undefined)[] = [];
  return {
    calls,
    store: {
      query: async (filter?: ReceiptQuery): Promise<Receipt[]> => {
        calls.push(filter);
        let result = [...list];
        if (filter?.fromTime !== undefined) result = result.filter((r) => r.timestamp >= filter.fromTime!);
        if (filter?.toTime !== undefined) result = result.filter((r) => r.timestamp <= filter.toTime!);
        return result;
      },
    },
  };
}

function setup(list: Receipt[] = FIXTURES) {
  const { store, calls } = mockStore(list);
  registerRoutes("timeline", createTimelineRouteRegistrar(store));
  return { calls };
}

interface Bucket {
  timestamp: string;
  builds: number;
  successes: number;
  failures: number;
  totalCostUsd: number;
}
interface TimelineBody {
  buckets: Bucket[];
  period: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

test("GET /api/timeline is registered via the createTimelineRouteRegistrar seam", () => {
  routes.reset();
  registerRoutes("timeline", createTimelineRouteRegistrar({ query: async () => [] }));
  assert.ok(routes.modules().includes("timeline"), "timeline module registered its routes");
});

// ---------------------------------------------------------------------------
// Grouping by hour (default)
// ---------------------------------------------------------------------------

test("GET /api/timeline groups receipts into hourly buckets by default", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as TimelineBody;
    assert.equal(body.period, "hour");
    assert.equal(body.buckets.length, 3);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline?period=hour is the same as default", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline?period=hour" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as TimelineBody;
    assert.equal(body.period, "hour");
    assert.equal(body.buckets.length, 3);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline bucket 0 has correct counts", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as TimelineBody;
    const b = body.buckets[0]!;
    assert.equal(b.builds, 2);
    assert.equal(b.successes, 1);
    assert.equal(b.failures, 1);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline bucket 1 has correct counts", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as TimelineBody;
    const b = body.buckets[1]!;
    assert.equal(b.builds, 2);
    assert.equal(b.successes, 2);
    assert.equal(b.failures, 0);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline rejected status counts as failure", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as TimelineBody;
    const b = body.buckets[2]!;
    assert.equal(b.builds, 1);
    assert.equal(b.successes, 0);
    assert.equal(b.failures, 1);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline partial status counts only in builds (not success or failure)", async () => {
  const list: Receipt[] = [rec(1, HOUR_0 + 100, "partial")];
  const { store } = mockStore(list);
  registerRoutes("timeline", createTimelineRouteRegistrar(store));
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as TimelineBody;
    assert.equal(body.buckets[0]!.builds, 1);
    assert.equal(body.buckets[0]!.successes, 0);
    assert.equal(body.buckets[0]!.failures, 0);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Grouping by day
// ---------------------------------------------------------------------------

test("GET /api/timeline?period=day groups all fixtures into one day bucket", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline?period=day" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as TimelineBody;
    assert.equal(body.period, "day");
    assert.equal(body.buckets.length, 1);
    assert.equal(body.buckets[0]!.builds, 5);
    assert.equal(body.buckets[0]!.successes, 3);
    assert.equal(body.buckets[0]!.failures, 2);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Cost accumulation
// ---------------------------------------------------------------------------

test("GET /api/timeline sums metadata.costUsd per bucket", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as TimelineBody;
    assert.equal(body.buckets[0]!.totalCostUsd, 0);
    assert.ok(Math.abs(body.buckets[1]!.totalCostUsd - 0.03) < 1e-10);
    assert.equal(body.buckets[2]!.totalCostUsd, 0);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Chronological order
// ---------------------------------------------------------------------------

test("GET /api/timeline returns buckets in chronological order", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as TimelineBody;
    const times = body.buckets.map((b) => new Date(b.timestamp).getTime());
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i]! > times[i - 1]!, `bucket ${i} should be after bucket ${i - 1}`);
    }
  } finally {
    await app.close();
  }
});

test("GET /api/timeline bucket timestamps are ISO strings at bucket-start boundaries", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    const body = res.json() as TimelineBody;
    assert.equal(body.buckets[0]!.timestamp, new Date(HOUR_0).toISOString());
    assert.equal(body.buckets[1]!.timestamp, new Date(HOUR_1).toISOString());
    assert.equal(body.buckets[2]!.timestamp, new Date(HOUR_2).toISOString());
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Date range filtering
// ---------------------------------------------------------------------------

test("GET /api/timeline?from= passes fromTime to store and filters to later buckets", async () => {
  const { calls } = setup();
  const app = buildServer();
  await app.ready();
  try {
    const fromIso = new Date(HOUR_1).toISOString();
    const res = await app.inject({ method: "GET", url: `/api/timeline?from=${encodeURIComponent(fromIso)}` });
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0]?.fromTime, HOUR_1);
    const body = res.json() as TimelineBody;
    const totalBuilds = body.buckets.reduce((s, b) => s + b.builds, 0);
    assert.equal(totalBuilds, 3);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline?to= passes toTime to store and filters to earlier buckets", async () => {
  const { calls } = setup();
  const app = buildServer();
  await app.ready();
  try {
    const toIso = new Date(HOUR_1 - 1).toISOString();
    const res = await app.inject({ method: "GET", url: `/api/timeline?to=${encodeURIComponent(toIso)}` });
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0]?.toTime, HOUR_1 - 1);
    const body = res.json() as TimelineBody;
    const totalBuilds = body.buckets.reduce((s, b) => s + b.builds, 0);
    assert.equal(totalBuilds, 2);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline?from=&to= combined narrows to a single bucket", async () => {
  const { calls } = setup();
  const app = buildServer();
  await app.ready();
  try {
    const fromIso = new Date(HOUR_1).toISOString();
    const toIso = new Date(HOUR_1 + 999).toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/timeline?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0]?.fromTime, HOUR_1);
    assert.equal(calls[0]?.toTime, HOUR_1 + 999);
    const body = res.json() as TimelineBody;
    assert.equal(body.buckets.length, 1);
    assert.equal(body.buckets[0]!.builds, 2);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Empty store
// ---------------------------------------------------------------------------

test("GET /api/timeline returns empty buckets when store is empty", async () => {
  const { store } = mockStore([]);
  registerRoutes("timeline", createTimelineRouteRegistrar(store));
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as TimelineBody;
    assert.deepEqual(body.buckets, []);
    assert.equal(body.period, "hour");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

test("GET /api/timeline?period=week returns 400", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline?period=week" });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.match(body.error, /period/);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline?from=notadate returns 400", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline?from=notadate" });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.match(body.error, /from/);
  } finally {
    await app.close();
  }
});

test("GET /api/timeline?to=notadate returns 400", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/timeline?to=notadate" });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.match(body.error, /to/);
  } finally {
    await app.close();
  }
});
