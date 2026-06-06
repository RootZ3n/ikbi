import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { TrustTierInput } from "../identity/contract.js";
import { AgentRegistry, hashToken } from "../identity/registry.js";
import { IdentityResolver } from "../identity/resolver.js";
import type { ValidatedIdentity } from "../identity/resolver.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import { autonomyForTier, type RecordOutcomeInput } from "./contract.js";
import type { PersistedTrustState } from "./mac.js";
import { TrustSystem } from "./system.js";

const silent: Logger = pino({ level: "silent" });
const KEY = "test-trust-mac-key";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-trust-"));
}

type TestAgent = { agentId: string; kind: "agent" | "operator"; defaultTrustTier: string; tokenHashes: string[] };
const DEFAULT_AGENTS: TestAgent[] = [
  { agentId: "builder-3", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken("builder-3-secret")] },
];

function makeTrust(
  dir: string,
  opts?: { promoteStreak?: number; demoteStreak?: number; minDistinctOps?: number; now?: () => number; agents?: TestAgent[] },
) {
  const agents = opts?.agents ?? DEFAULT_AGENTS;
  // The registry is the AUTHORITATIVE starting-tier source AND the source of genuine
  // subject identities — they must agree, so both are built from the same agent list.
  const registry = new AgentRegistry({ agents });
  const resolver = new IdentityResolver({ registry, logger: silent, now: () => 1000 });
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<PersistedTrustState>({ dir, locks, logger: silent, fsync: false });
  const trust = new TrustSystem({
    store,
    logger: silent,
    promoteStreak: opts?.promoteStreak ?? 3,
    demoteStreak: opts?.demoteStreak ?? 2,
    minDistinctOps: opts?.minDistinctOps ?? 1,
    hmacKey: KEY,
    registry,
    ...(opts?.now ? { now: opts.now } : {}),
  });
  /** A GENUINE ValidatedIdentity for a registered agent (the recordOutcome subject). */
  const subject = (id: string): ValidatedIdentity => resolver.resolve({ token: `${id}-secret` });
  return { trust, store, dir, registry, resolver, subject };
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
    const { trust, subject } = makeTrust(dir, { promoteStreak: 3 });
    await trust.preload();
    // Fail-closed: a never-seen agent resolves to the floor until its (absent) state is confirmed.
    assert.equal(trust.resolve(AGENT), "untrusted");
    await trust.loadState("builder-3"); // confirms no durable state => genuinely new
    assert.equal(trust.resolve(AGENT), "probation", "confirmed-new agent gets its registry default");
    for (let i = 0; i < 3; i += 1) await trust.recordOutcome(rec("success"), subject("builder-3"));
    assert.equal(trust.resolve(AGENT), "verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FAIL-CLOSED: cold cache miss resolves to the FLOOR, never the optimistic default", async () => {
  const dir = await tmp();
  try {
    // First run: a 'verified'-default agent is demoted to probation (below its default).
    const vAgents: TestAgent[] = [{ agentId: "v", kind: "agent", defaultTrustTier: "verified", tokenHashes: [hashToken("v-secret")] }];
    const first = makeTrust(dir, { demoteStreak: 2, agents: vAgents });
    const vrec = (status: RecordOutcomeInput["status"]): RecordOutcomeInput => ({ agentId: "v", kind: "agent", defaultTrustTier: "verified", operation: "build", status });
    await first.trust.recordOutcome(vrec("failure"), first.subject("v"));
    await first.trust.recordOutcome(vrec("failure"), first.subject("v")); // demote verified -> probation
    assert.equal(first.trust.resolve({ agentId: "v", kind: "agent", defaultTrustTier: "verified" }), "probation");

    // Restart: COLD cache. Resolving before load must NOT grant the 'verified' default.
    const restarted = makeTrust(dir, { demoteStreak: 2, agents: vAgents });
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
    for (let i = 0; i < 3; i += 1) await first.trust.recordOutcome(rec("success"), first.subject("builder-3"));
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
    const d = await trust.recordOutcome({ agentId: "operator", kind: "operator", defaultTrustTier: "operator", operation: "x", status: "failure" }, operatorId());
    assert.equal(d.tier, "operator");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ANTI-ESCALATION: agents never exceed 'trusted' no matter how many successes", async () => {
  const dir = await tmp();
  try {
    const { trust, subject } = makeTrust(dir, { promoteStreak: 2 });
    for (let i = 0; i < 60; i += 1) await trust.recordOutcome(rec("success"), subject("builder-3"));
    assert.equal(trust.resolve(AGENT), "trusted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INJECTION non-recoverable: flagged agent cannot auto-recover until operator reset", async () => {
  const dir = await tmp();
  try {
    const { trust, subject } = makeTrust(dir, { promoteStreak: 2 });
    await trust.recordOutcome(rec("success", "build"), subject("builder-3"));
    await trust.recordOutcome(rec("success", "test"), subject("builder-3")); // -> verified
    await trust.recordOutcome(rec("success", "edit", { injection: true }), subject("builder-3")); // demote + flag
    assert.equal(trust.getState("builder-3")?.injectionFlagged, true);

    // Clean successes do NOT auto-promote while flagged.
    for (let i = 0; i < 6; i += 1) await trust.recordOutcome(rec("success", i % 2 === 0 ? "build" : "test"), subject("builder-3"));
    assert.equal(trust.getState("builder-3")?.injectionFlagged, true);
    assert.equal(trust.resolve(AGENT), "probation", "no auto-recovery while injection-flagged");

    // Operator reset clears the flag; promotion resumes.
    await trust.operatorReset({ agentId: "builder-3", kind: "agent", defaultTrustTier: "probation" }, operatorId());
    assert.equal(trust.getState("builder-3")?.injectionFlagged, false);
    await trust.recordOutcome(rec("success", "build"), subject("builder-3"));
    const d = await trust.recordOutcome(rec("success", "test"), subject("builder-3"));
    assert.equal(d.tier, "verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ANTI-FARMING via the system: read-only successes never promote", async () => {
  const dir = await tmp();
  try {
    const { trust, subject } = makeTrust(dir, { promoteStreak: 3 });
    for (let i = 0; i < 10; i += 1) await trust.recordOutcome(rec("success", "file.read"), subject("builder-3"));
    assert.equal(trust.resolve(AGENT), "probation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CONCURRENCY: concurrent recordOutcome on one agent loses no updates", async () => {
  const dir = await tmp();
  try {
    const { trust, subject } = makeTrust(dir, { promoteStreak: 100 });
    await Promise.all(Array.from({ length: 30 }, () => trust.recordOutcome(rec("success"), subject("builder-3"))));
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

// ── grantTier — the operator cold-start on-ramp (Blocker 1) ──────────────────

/** A validated identity at a chosen tier (operator vs agent), for the grant gate. */
function identity(agentId: string, tier: string): ValidatedIdentity {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId, kind: tier === "operator" ? "operator" : "agent", defaultTrustTier: tier, tokenHashes: [hashToken(`${agentId}-secret`)] }] }),
    logger: silent,
    now: () => 1000,
  });
  return resolver.resolve({ token: `${agentId}-secret` });
}
const operatorId = () => identity("operator", "operator");
const agentId = () => identity("rogue", "trusted");

test("grantTier: an OPERATOR grants a worker trusted — durable, MAC-protected, transition logged, survives restart", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir);
    const state = await trust.grantTier({ agentId: "builder-3", kind: "agent", tier: "trusted", defaultTrustTier: "probation" }, operatorId());
    assert.equal(state.tier, "trusted", "the worker's tier is now the granted tier");
    // The grant is logged as a transition (granted, NOT earned) from the cold floor.
    assert.equal(state.lastTransition?.reason, "operator_grant");
    assert.equal(state.lastTransition?.from, "untrusted");
    assert.equal(state.lastTransition?.to, "trusted");
    // Live in-process immediately (cache + checked updated) — no restart needed.
    assert.equal(trust.resolve(AGENT), "trusted", "the grant is live in this process");
    // Survives restart: a fresh TrustSystem over the same store reads trusted.
    const restarted = makeTrust(dir);
    await restarted.trust.preload();
    assert.equal(restarted.trust.resolve(AGENT), "trusted", "the granted state is durable across restart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grantTier: a NON-operator is REJECTED — no write, the worker stays at the floor", async () => {
  const dir = await tmp();
  try {
    const { trust, store } = makeTrust(dir);
    await assert.rejects(
      trust.grantTier({ agentId: "builder-3", kind: "agent", tier: "trusted", defaultTrustTier: "probation" }, agentId()),
      /only an operator/,
    );
    assert.equal((await store.list()).length, 0, "no durable state was written by the rejected grant");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grantTier: CEILING CAP — granting the operator apex is REJECTED; granting the ceiling (trusted) is OK", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir);
    await assert.rejects(
      trust.grantTier({ agentId: "builder-3", kind: "agent", tier: "operator" as never, defaultTrustTier: "probation" }, operatorId()),
      /above the agent ceiling/,
    );
    const ok = await trust.grantTier({ agentId: "builder-3", kind: "agent", tier: "trusted", defaultTrustTier: "probation" }, operatorId());
    assert.equal(ok.tier, "trusted", "granting the ceiling tier is allowed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grantTier: MAC PROTECTION — a hand-edited granted doc fails verifyUnwrap (fail-closed)", async () => {
  const dir = await tmp();
  try {
    const { trust, store } = makeTrust(dir);
    await trust.grantTier({ agentId: "builder-3", kind: "agent", tier: "trusted", defaultTrustTier: "probation" }, operatorId());
    // Tamper with the persisted (MAC-protected) doc — flip the tier without re-MACing.
    const key = createHash("sha256").update("builder-3", "utf8").digest("hex");
    const persisted = await store.get(key);
    assert.ok(persisted !== undefined);
    const forged = { ...persisted, tier: "operator" } as PersistedTrustState;
    await store.put(key, forged);
    // A fresh system fails the granted doc closed to the floor (not the forged tier).
    const restarted = makeTrust(dir);
    const { rejected } = await restarted.trust.preload();
    assert.equal(rejected, 1, "the tampered grant doc is rejected at preload");
    assert.equal(restarted.trust.resolve(AGENT), "untrusted", "fail-closed to the floor, not the forged operator tier");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grantTier: COLD→WORKING — granted + preloaded, a fresh process resolves trusted (requiresApproval false)", async () => {
  const dir = await tmp();
  try {
    // Operator grants on one process.
    const first = makeTrust(dir);
    await first.trust.grantTier({ agentId: "builder-3", kind: "agent", tier: "trusted", defaultTrustTier: "probation" }, operatorId());

    // A FRESH process: cold cache. Preload loads the granted durable state.
    const fresh = makeTrust(dir);
    const { loaded } = await fresh.trust.preload();
    assert.equal(loaded, 1);
    // The cold→working path: resolve returns trusted (not the floor), so the gate-wall allows.
    assert.equal(fresh.trust.resolve(AGENT), "trusted");
    assert.equal(autonomyForTier("trusted").requiresApproval, false, "trusted does not require approval — the builder is not rejected at the trust gate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grantTier: the CODEX FORGE is BLOCKED — a cast {kind:'operator'} object cannot grant (provenance, not claim)", async () => {
  const dir = await tmp();
  try {
    const { trust, store } = makeTrust(dir);
    // Codex's exact NO-SHIP repro: a forged plain object that STRUCTURALLY looks like
    // an operator identity but was never minted by the resolver.
    const forged = { kind: "operator", identity: { agentId: "forged-op" }, authMethod: "operator_token", resolvedAt: 1 } as unknown as ValidatedIdentity;
    await assert.rejects(
      trust.grantTier({ agentId: "victim", kind: "agent", tier: "trusted", defaultTrustTier: "probation" }, forged),
      /validated identity/,
      "a forged granter is rejected on provenance before the operator check",
    );
    assert.equal((await store.list()).length, 0, "no operator_grant was written by the forged caller");
    assert.equal(trust.getState("victim"), undefined, "the target did not become trusted");
    assert.equal(trust.resolve({ agentId: "victim", kind: "agent", defaultTrustTier: "probation" }), "untrusted", "the target still resolves to the cold floor");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operatorReset: the CODEX REPRO is BLOCKED — a forged/non-operator caller cannot reset (no unauthenticated trust write)", async () => {
  const dir = await tmp();
  try {
    const { trust, store } = makeTrust(dir);
    // Codex's exact repro: a forged granter trying to mint durable trusted state.
    const forged = { kind: "operator", identity: { agentId: "forged-op" }, authMethod: "operator_token", resolvedAt: 1 } as unknown as ValidatedIdentity;
    await assert.rejects(
      trust.operatorReset({ agentId: "builder-3", kind: "agent", defaultTrustTier: "trusted" }, forged),
      /validated identity/,
      "a forged caller is rejected on provenance",
    );
    // A genuine but NON-operator identity is rejected on authorization.
    await assert.rejects(
      trust.operatorReset({ agentId: "builder-3", kind: "agent", defaultTrustTier: "trusted" }, agentId()),
      /only an operator/,
      "a genuine non-operator is rejected on authorization",
    );
    assert.equal((await store.list()).length, 0, "no durable write by an unauthorized caller");
    assert.equal(trust.resolve(AGENT), "untrusted", "the target stays at the floor");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operatorReset: NO BACKDOOR TIER GRANT — a fresh-agent reset does not mint a caller-supplied tier", async () => {
  const dir = await tmp();
  try {
    const { trust } = makeTrust(dir);
    // A genuine operator resets a NO-PRIOR-STATE agent with defaultTrustTier="trusted".
    // operatorReset is flag-clearing, NOT a tier grant: the result must be the FLOOR,
    // not the caller-supplied "trusted" (that backdoor was Codex's escalation).
    const state = await trust.operatorReset({ agentId: "fresh", kind: "agent", defaultTrustTier: "trusted" }, operatorId());
    assert.equal(state.tier, "untrusted", "a fresh reset creates at the floor, not the caller's tier");
    assert.equal(state.injectionFlagged, false);
    assert.equal(trust.resolve({ agentId: "fresh", kind: "agent", defaultTrustTier: "trusted" }), "untrusted", "no trust was minted via operatorReset");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operatorReset: a GENUINE OPERATOR still clears the injection flag (regression — purpose intact, tier unchanged)", async () => {
  const dir = await tmp();
  try {
    const { trust, subject } = makeTrust(dir, { promoteStreak: 2, demoteStreak: 2 });
    await trust.recordOutcome(rec("success", "build"), subject("builder-3"));
    await trust.recordOutcome(rec("success", "test"), subject("builder-3")); // -> verified
    await trust.recordOutcome(rec("success", "edit", { injection: true }), subject("builder-3")); // demote + flag
    assert.equal(trust.getState("builder-3")?.injectionFlagged, true);
    const tierBefore = trust.getState("builder-3")?.tier;

    const state = await trust.operatorReset({ agentId: "builder-3", kind: "agent", defaultTrustTier: "probation" }, operatorId());
    assert.equal(state.injectionFlagged, false, "the flag is cleared (operatorReset's actual purpose)");
    assert.equal(state.tier, tierBefore, "the earned tier is unchanged — reset clears the flag, it does not re-tier");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── recordOutcome — the PRIMARY trust-write path requires a genuine subject (4th forge) ──

test("recordOutcome: the CODEX FORGE is BLOCKED — a forged subject cannot mint trusted state", async () => {
  const dir = await tmp();
  try {
    const { trust, store } = makeTrust(dir);
    // Codex's exact repro: caller-supplied agentId/kind/defaultTrustTier with a forged subject.
    const forged = { kind: "agent", identity: { agentId: "builder-3" }, authMethod: "agent_token", resolvedAt: 1 } as unknown as ValidatedIdentity;
    await assert.rejects(
      trust.recordOutcome({ agentId: "builder-3", kind: "agent", defaultTrustTier: "trusted", operation: "forge", status: "success" }, forged),
      /validated subject identity/,
      "a forged subject is rejected on provenance",
    );
    assert.equal((await store.list()).length, 0, "no durable trust state written by the forged caller");
    assert.equal(trust.resolve(AGENT), "untrusted", "the target stays at the cold floor (no minted trust)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordOutcome: NO TIER-MINT — a fresh agent's starting tier comes from the REGISTRY, not input.defaultTrustTier", async () => {
  const dir = await tmp();
  try {
    // The agent is REGISTERED at "verified". A caller passing defaultTrustTier:"trusted"
    // must NOT mint trusted — the registry (verified) is authoritative.
    const agents: TestAgent[] = [{ agentId: "reg", kind: "agent", defaultTrustTier: "verified", tokenHashes: [hashToken("reg-secret")] }];
    const { trust, subject } = makeTrust(dir, { agents });
    const d = await trust.recordOutcome(
      { agentId: "reg", kind: "agent", defaultTrustTier: "trusted", operation: "build.run", status: "success" },
      subject("reg"),
    );
    assert.equal(d.previousTier, "verified", "the starting tier is the REGISTRY value (verified), not the caller's 'trusted'");
    assert.equal(trust.resolve({ agentId: "reg", kind: "agent", defaultTrustTier: "trusted" }), "verified", "no mint to trusted via the caller's field");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordOutcome: an UNREGISTERED agent starts at the FLOOR (fail-closed), not the caller's tier", async () => {
  const dir = await tmp();
  try {
    // The subject is genuine but the agent is NOT in the trust registry → floor.
    const agents: TestAgent[] = [{ agentId: "ghost", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken("ghost-secret")] }];
    const registry = new AgentRegistry({ agents });
    const resolver = new IdentityResolver({ registry, logger: silent, now: () => 1000 });
    const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
    const store = new DocumentStore<PersistedTrustState>({ dir, locks, logger: silent, fsync: false });
    // The TrustSystem is given an EMPTY registry — "ghost" is unregistered to IT.
    const trust = new TrustSystem({ store, logger: silent, promoteStreak: 3, demoteStreak: 2, minDistinctOps: 1, hmacKey: KEY, registry: new AgentRegistry({ agents: [] }) });
    const d = await trust.recordOutcome(
      { agentId: "ghost", kind: "agent", defaultTrustTier: "trusted", operation: "build.run", status: "success" },
      resolver.resolve({ token: "ghost-secret" }),
    );
    assert.equal(d.previousTier, "untrusted", "an agent unknown to the registry starts at the floor");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordOutcome: an agentId MISMATCH (input != subject) is REJECTED", async () => {
  const dir = await tmp();
  try {
    const agents: TestAgent[] = [
      { agentId: "builder-3", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken("builder-3-secret")] },
      { agentId: "other", kind: "agent", defaultTrustTier: "probation", tokenHashes: [hashToken("other-secret")] },
    ];
    const { trust, store, subject } = makeTrust(dir, { agents });
    // A genuine subject for "other", but the input claims "builder-3" — reject.
    await assert.rejects(
      trust.recordOutcome({ agentId: "builder-3", kind: "agent", defaultTrustTier: "probation", operation: "build.run", status: "success" }, subject("other")),
      /does not match the subject identity/,
    );
    assert.equal((await store.list()).length, 0, "no write on an agentId mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordOutcome: a GENUINE subject still EARNS trust through the rules (the primary path, unbroken)", async () => {
  const dir = await tmp();
  try {
    // builder-3 registered at probation; promoteStreak 3 over distinct ops -> verified.
    const { trust, subject } = makeTrust(dir, { promoteStreak: 3, minDistinctOps: 3 });
    await trust.recordOutcome(rec("success", "build"), subject("builder-3"));
    await trust.recordOutcome(rec("success", "test"), subject("builder-3"));
    const d = await trust.recordOutcome(rec("success", "edit"), subject("builder-3"));
    assert.equal(d.transition?.direction, "promote", "earned promotion fires on a genuine streak");
    assert.equal(d.tier, "verified", "the worker earns verified exactly as before");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
