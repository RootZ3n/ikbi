/**
 * GET /api/receipts — limit=0 must return ZERO results (explicit "show nothing"),
 * in both the unfiltered and task-filtered paths. (lab-trust sprint, Phase 3)
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { buildServer } from "./index.js";
import { registerRoutes, routes } from "./registry.js";
import { createReceiptsRouteRegistrar } from "./receipts.js";

beforeEach(() => routes.reset());

const IDENTITY: AgentIdentity = { agentId: "builder-1", trustTier: "trusted" };

function rec(seq: number, requestId?: string): Receipt {
  return {
    contractVersion: "1.0.0",
    id: `r${seq}`,
    seq,
    timestamp: 1_700_000_000_000 + seq * 1000,
    identity: IDENTITY,
    operation: "worker.role.builder",
    outcome: { status: "success" },
    changes: [],
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

const FIXTURES: Receipt[] = [rec(1, "t-1"), rec(2, "t-1"), rec(3, "t-2")];

function mockStore(list: Receipt[]) {
  return {
    query: async (filter?: ReceiptQuery): Promise<Receipt[]> => {
      let result = [...list];
      if (filter?.limit !== undefined && filter.limit >= 0 && result.length > filter.limit) {
        result = result.slice(result.length - filter.limit);
      }
      return result;
    },
  };
}

function setup(list: Receipt[] = FIXTURES) {
  registerRoutes("receipts", createReceiptsRouteRegistrar(mockStore(list)));
}

test("GET /api/receipts?limit=0 returns zero receipts (unfiltered)", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?limit=0" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 0);
    assert.equal(body.receipts.length, 0);
  } finally {
    await app.close();
  }
});

test("GET /api/receipts?limit=0&task=t-1 returns zero receipts (task-filtered)", async () => {
  setup();
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/receipts?limit=0&task=t-1" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { receipts: Receipt[]; count: number };
    assert.equal(body.count, 0);
  } finally {
    await app.close();
  }
});
