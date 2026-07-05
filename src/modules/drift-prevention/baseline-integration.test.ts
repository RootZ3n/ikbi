/**
 * VALUE proof for the persisted-baseline rework.
 *
 * The value-ablation finding was that drift-prevention is structurally inert because its
 * baseline is never written — `check()` finds no `pattern` entry, so it never fires. This test
 * exercises the WHOLE repaired chain end-to-end over real `createLabMemory` +
 * `createDriftPrevention` sharing one receipt store:
 *
 *   1. BEFORE the baseline is projected → drift is silent (the old, inert behavior).
 *   2. `projectFromReceipts` folds a good history into a durable cumulative baseline.
 *   3. Reliability then collapses → drift READS that baseline and DETECTS the decline.
 *
 * That is the value the rework delivers: drift now has a real reference to drift against.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { pino } from "pino";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import { createLabMemory, type MemoryStore } from "../lab-context-memory/memory.js";
import type { MemoryEntry } from "../lab-context-memory/contract.js";
import type { LabContextMemoryConfig } from "../lab-context-memory/config.js";
import { createDriftPrevention } from "./drift.js";
import type { DriftPreventionConfig } from "./config.js";

const AGENT = "worker";
const OP = "worker.role.builder";
const PROJECT = "P";

function identity() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: AGENT, kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return resolver.resolve({ token: "worker-secret" });
}

function memStore() {
  const m = new Map<string, MemoryEntry>();
  const store: MemoryStore = { get: async (id) => m.get(id), put: async (id, v) => void m.set(id, v), list: async () => [...m.keys()] };
  return store;
}

/** A shared receipt store with a faithful query (filters by agent/operation/project/fromSeq, seq-ordered). */
function receiptStore() {
  const list: Receipt[] = [];
  let seq = 0;
  const append = (status: "success" | "failure", count = 1) => {
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      list.push({
        contractVersion: "1.0.0", id: `r-${seq}`, seq, timestamp: 1000,
        identity: { agentId: AGENT, trustTier: "trusted" }, operation: OP,
        outcome: { status }, changes: [], metadata: {}, project: PROJECT,
      } as Receipt);
    }
  };
  const receipts = {
    query: async (f?: ReceiptQuery): Promise<Receipt[]> =>
      list
        .filter((r) => (f?.agentId === undefined || r.identity.agentId === f.agentId)
          && (f?.operation === undefined || r.operation === f.operation)
          && (f?.project === undefined || r.project === f.project)
          && (f?.fromSeq === undefined || r.seq >= f.fromSeq))
        .sort((a, b) => a.seq - b.seq),
  };
  return { receipts, append };
}

const memCfg: LabContextMemoryConfig = { enabled: true, memoryDir: "/unused", maxReceiptsPerProjection: 1000, maxValueBytes: 16_384 };
const driftCfg: DriftPreventionConfig = { enabled: true, driftThreshold: 0.2, minSampleSize: 5, recentWindow: 20, policy: "reportOnly" };

test("persisted-baseline rework: projection builds a baseline that drift reads to detect a decline", async () => {
  const rc = receiptStore();
  const mem = createLabMemory({ config: memCfg, store: memStore(), receipts: rc.receipts, publish: () => {}, now: () => 1000 });
  const drift = createDriftPrevention({ config: driftCfg, labMemory: mem, receipts: rc.receipts, publish: () => {} });
  const who = identity();

  // A long run of reliable builds.
  rc.append("success", 20);

  // (1) BEFORE projection — no baseline exists → drift is SILENT (the old inert behavior).
  const before = await drift.check({ agent: AGENT, project: PROJECT });
  assert.equal(before.filter((r) => r.drifted).length, 0, "with no persisted baseline, drift cannot fire");

  // (2) Project the good history into the durable cumulative baseline (what the build hook now does).
  await mem.projectFromReceipts({ identity: who, project: PROJECT, patternsOnly: true });
  const pattern = (await mem.byAgent(AGENT, { kind: "pattern", project: PROJECT }))[0];
  assert.ok(pattern, "a baseline pattern now exists");
  assert.equal(pattern?.value.total, 20);
  assert.equal(pattern?.value.successes, 20);

  // (3) Reliability collapses — the next window is all failures.
  rc.append("failure", 20);
  const after = await drift.check({ agent: AGENT, project: PROJECT });
  const drifted = after.filter((r) => r.drifted);
  assert.equal(drifted.length, 1, "drift now DETECTS the decline against the persisted baseline");
  assert.equal(drifted[0]?.operation, OP);
  assert.equal(drifted[0]?.baselineRate, 1, "baseline reflects the reliable history");
  assert.equal(drifted[0]?.recentRate, 0, "recent window is all failures");
  assert.equal(drifted[0]?.severity, "major", "a full collapse is a major drop");
});
