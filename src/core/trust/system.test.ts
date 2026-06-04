import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { TrustTierInput } from "../identity/contract.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import { autonomyForTier, type RecordOutcomeInput, TrustError } from "./contract.js";
import type { PersistedTrustState } from "./mac.js";
import { TrustSystem } from "./system.js";

const silent: Logger = pino({ level: "silent" });
const KEY = "test-trust-mac-key";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-trust-"));
}

function makeTrust(dir: string, opts?: { promoteStreak?: number; demoteStreak?: number; minDistinctOps?: number; now?: () => number }) {
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<PersistedTrustState>({ dir, locks, logger: silent, fsync: false });
  const trust = new TrustSystem({
    store,
    logger: silent,
    promoteStreak: opts?.promoteStreak ?? 3,
    demoteStreak: opts?.demoteStreak ?? 2,
    minDistinctOps: opts?.minDistinctOps ?? 1,
    hmacKey: KEY,
    ...(opts?.now ? { now: opts.now } : {}),
  });
  return { trust, store, dir };
}

const AGENT: TrustTierInput = { agentId: "builder-3", kind: "agent", defaultTrustTier: "probation" };
const rec = (status: RecordOutcomeInput["status"], op = "build", signals?: { injection?: boolean }): RecordOutcomeInput => ({
  agentId: "builder-3",
  kind: "agent",
  defaultTrustTier: "probation",
  operation: op,
  status,
  ...(signals ? { signals } : {}),
});

test("resolve returns the EARNED tier after preload", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir, { promoteStreak: 3 });
    await trust.preload();
    // Fail-closed: a never-seen agent resolves to the floor until its (absent) state is confirmed.
    assert.equal(trust.resolve(AGENT), "untrusted");
    await trust.loadState("builder-3"); // confirms no durable state => genuinely new
    assert.equal(trust.resolve(AGENT), "probation", "confirmed-new agent gets its registry default");
    for (let i = 0; i < 3; i += 1) await trust.recordOutcome(rec("success"));
    assert.equal(trust.resolve(AGENT), "verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FAIL-CLOSED: cold cache miss resolves to the FLOOR, never the optimistic default", async () => {
  const dir = await tmp();
  try {
    // First run: a 'verified'-default agent is demoted to probation (below its default).
    const first = makeTrust(dir, { demoteStreak: 2 });
    const vrec = (status: RecordOutcomeInput["status"]): RecordOutcomeInput => ({ agentId: "v", kind: "agent", defaultTrustTier: "verified", operation: "build", status });
    await first.trust.recordOutcome(vrec("failure"));
    await first.trust.recordOutcome(vrec("failure")); // demote verified -> probation
    assert.equal(first.trust.resolve({ agentId: "v", kind: "agent", defaultTrustTier: "verified" }), "probation");

    // Restart: COLD cache. Resolving before load must NOT grant the 'verified' default.
    const restarted = makeTrust(dir, { demoteStreak: 2 });
    const cold = restarted.trust.resolve({ agentId: "v", kind: "agent", defaultTrustTier: "verified" });
    assert.equal(cold, "untrusted", "cold miss fails closed to the floor (no escalation window)");
    // After load, the earned (demoted) tier shows.
    await restarted.trust.loadState("v");
    assert.equal(restarted.trust.resolve({ agentId: "v", kind: "agent", defaultTrustTier: "verified" }), "probation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FAIL-CLOSED: a corrupt trust-state file resolves to the floor", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir);
    const docId = createHash("sha256").update("builder-3").digest("hex");
    await writeFile(join(dir, `${docId}.json`), "{ corrupt not json");
    await trust.loadState("builder-3"); // triggers the read error -> fail closed
    assert.equal(trust.resolve(AGENT), "untrusted", "unreadable state fails closed, not treated as new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FAIL-CLOSED: a forged/hand-edited trust doc (bad MAC) is rejected -> floor", async () => {
  const dir = await tmp();
  try {
    const { trust, store } = makeTrust(dir);
    const docId = createHash("sha256").update("builder-3").digest("hex");
    // Forge a doc claiming 'trusted' with an invalid MAC (the attacker lacks the key).
    await store.put(docId, {
      contractVersion: "1.0.0",
      agentId: "builder-3",
      kind: "agent",
      defaultTrustTier: "probation",
      tier: "trusted",
      successCount: 0,
      failureCount: 0,
      partialCount: 0,
      rejectedCount: 0,
      injectionFlags: 0,
      injectionFlagged: false,
      promotableStreak: 0,
      streakOperations: [],
      consecutiveFailures: 0,
      operations: {},
      transitions: [],
      createdAt: 0,
      updatedAt: 0,
      mac: "deadbeef".repeat(8),
    });
    await trust.loadState("builder-3");
    assert.equal(trust.resolve(AGENT), "untrusted", "forged doc is rejected (fail closed), not clamped-and-accepted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable trust survives a restart (independent of receipts/pruning)", async () => {
  const dir = await tmp();
  try {
    const first = makeTrust(dir, { promoteStreak: 3 });
    for (let i = 0; i < 3; i += 1) await first.trust.recordOutcome(rec("success"));
    assert.equal(first.trust.resolve(AGENT), "verified");

    const restarted = makeTrust(dir, { promoteStreak: 3 });
    assert.deepEqual(await restarted.trust.preload(), { loaded: 1, rejected: 0 });
    assert.equal(restarted.trust.resolve(AGENT), "verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OPERATOR coupling: operator always resolves to operator; outcomes don't change it", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir);
    const op: TrustTierInput = { agentId: "operator", kind: "operator", defaultTrustTier: "operator" };
    assert.equal(trust.resolve(op), "operator");
    const d = await trust.recordOutcome({ agentId: "operator", kind: "operator", defaultTrustTier: "operator", operation: "x", status: "failure" });
    assert.equal(d.tier, "operator");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ANTI-ESCALATION: agents never exceed 'trusted' no matter how many successes", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir, { promoteStreak: 2 });
    for (let i = 0; i < 60; i += 1) await trust.recordOutcome(rec("success"));
    assert.equal(trust.resolve(AGENT), "trusted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("VALIDATED intake: recordFromReceipt derives signals from an attributed receipt", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir, { promoteStreak: 2 });
    const ctx = { kind: "agent" as const, defaultTrustTier: "probation" };
    await trust.recordFromReceipt({ identity: { agentId: "builder-3" }, operation: "build.run", outcome: { status: "success" } }, ctx);
    const d = await trust.recordFromReceipt({ identity: { agentId: "builder-3" }, operation: "test.run", outcome: { status: "success" } }, ctx);
    assert.equal(d.tier, "verified");

    // Injection signal read from receipt metadata -> demote + flag.
    const inj = await trust.recordFromReceipt(
      { identity: { agentId: "builder-3" }, operation: "build", outcome: { status: "success" }, metadata: { injectionDetected: true } },
      ctx,
    );
    assert.equal(inj.transition?.reason, "injection_attempt");

    // Malformed receipts are rejected.
    await assert.rejects(trust.recordFromReceipt({ identity: { agentId: "" }, operation: "x", outcome: { status: "success" } }, ctx), TrustError);
    await assert.rejects(
      trust.recordFromReceipt({ identity: { agentId: "y" }, operation: "x", outcome: { status: "weird" as never } }, ctx),
      TrustError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INJECTION non-recoverable: flagged agent cannot auto-recover until operator reset", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir, { promoteStreak: 2 });
    await trust.recordOutcome(rec("success", "build"));
    await trust.recordOutcome(rec("success", "test")); // -> verified
    await trust.recordOutcome(rec("success", "edit", { injection: true })); // demote + flag
    assert.equal(trust.getState("builder-3")?.injectionFlagged, true);

    // Clean successes do NOT auto-promote while flagged.
    for (let i = 0; i < 6; i += 1) await trust.recordOutcome(rec("success", i % 2 === 0 ? "build" : "test"));
    assert.equal(trust.getState("builder-3")?.injectionFlagged, true);
    assert.equal(trust.resolve(AGENT), "probation", "no auto-recovery while injection-flagged");

    // Operator reset clears the flag; promotion resumes.
    await trust.operatorReset({ agentId: "builder-3", kind: "agent", defaultTrustTier: "probation" });
    assert.equal(trust.getState("builder-3")?.injectionFlagged, false);
    await trust.recordOutcome(rec("success", "build"));
    const d = await trust.recordOutcome(rec("success", "test"));
    assert.equal(d.tier, "verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ANTI-FARMING via the system: read-only successes never promote", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir, { promoteStreak: 3 });
    for (let i = 0; i < 10; i += 1) await trust.recordOutcome(rec("success", "file.read"));
    assert.equal(trust.resolve(AGENT), "probation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CONCURRENCY: concurrent recordOutcome on one agent loses no updates", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir, { promoteStreak: 100 });
    await Promise.all(Array.from({ length: 30 }, () => trust.recordOutcome(rec("success"))));
    const state = await trust.loadState("builder-3");
    assert.equal(state?.successCount, 30);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the tier -> autonomy mapping returns correct grants per tier", () => {
  assert.deepEqual(autonomyForTier("probation"), { tier: "probation", sandboxed: true, gateLevel: "all", requiresApproval: true, autoCommit: false });
  assert.deepEqual(autonomyForTier("verified"), { tier: "verified", sandboxed: false, gateLevel: "standard", requiresApproval: false, autoCommit: false });
  assert.deepEqual(autonomyForTier("trusted"), { tier: "trusted", sandboxed: false, gateLevel: "reduced", requiresApproval: false, autoCommit: true });
  assert.deepEqual(autonomyForTier("untrusted"), { tier: "untrusted", sandboxed: true, gateLevel: "all", requiresApproval: true, autoCommit: false });
});
