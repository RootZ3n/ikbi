import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { EventInput } from "../../core/events/index.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { ValidatedIdentity } from "../../core/identity/resolver.js";
import type { KillSignal } from "../../core/kill-switch.js";
import { createKillSwitch, type LatchStore } from "./killswitch.js";
import type { KillState } from "./contract.js";
import type { KillSwitchConfig } from "./config.js";

const silent = () => pino({ level: "silent" });
const CFG: KillSwitchConfig = { enabled: true, latchDir: "/unused" };

/** A validated identity at a chosen tier (operator vs agent). */
function identity(agentId: string, tier: string): ValidatedIdentity {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId, kind: tier === "operator" ? "operator" : "agent", defaultTrustTier: tier, tokenHashes: [hashToken(`${agentId}-secret`)] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return resolver.resolve({ token: `${agentId}-secret` });
}
const OPERATOR = () => identity("operator", "operator");
const AGENT = () => identity("worker", "trusted");

/** A shared in-memory latch store (simulates the durable substrate). */
function memStore() {
  const m = new Map<string, KillState>();
  const store: LatchStore = { get: async (id) => m.get(id), put: async (id, v) => void m.set(id, v) };
  return { store, m };
}

function captureEvents() {
  const sent: Array<EventInput<unknown>> = [];
  return { publish: (e: EventInput<unknown>) => void sent.push(e), sent, types: () => sent.map((e) => (e as { type: string }).type) };
}

function publishKillSpy() {
  const calls: KillSignal[] = [];
  return { publishKill: (s: KillSignal) => void calls.push(s), calls };
}

const mk = (over: Record<string, unknown>) => createKillSwitch({ config: CFG, subscribe: false, now: () => 1, ...over });
const engineKill: KillSignal = { reason: "operator", mode: "hard", scope: "engine" };

// ── AUTHORIZATION (Decision 2 — the 3-eyes safety gate) ──────────────────────

test("an operator-tier identity CAN engage an operator kill (latch set, seam published)", async () => {
  const ms = memStore();
  const pk = publishKillSpy();
  const ev = captureEvents();
  const ks = mk({ store: ms.store, publishKill: pk.publishKill, publish: ev.publish });
  const r = await ks.kill(engineKill, OPERATOR());
  assert.equal(r.engaged, true);
  assert.equal(pk.calls.length, 1, "the seam engine.kill was published (now a real halt)");
  assert.ok(ms.m.get("state")?.signals.length === 1, "the durable latch was set");
  assert.ok(ev.types().includes("killswitch.engaged"));
  assert.equal((await ks.isKilled({})).killed, true);
});

test("a NON-operator attempting an operator kill is REJECTED — not published, not latched", async () => {
  const ms = memStore();
  const pk = publishKillSpy();
  const ev = captureEvents();
  const ks = mk({ store: ms.store, publishKill: pk.publishKill, publish: ev.publish });
  const r = await ks.kill(engineKill, AGENT());
  assert.equal(r.engaged, false);
  assert.match(r.reason ?? "", /operator-tier/);
  assert.equal(pk.calls.length, 0, "no seam publish on an unauthorized kill");
  assert.equal(ms.m.get("state")?.signals.length ?? 0, 0, "no latch set");
  assert.ok(ev.types().includes("killswitch.rejected"));
  assert.equal((await ks.isKilled({})).killed, false, "the engine is NOT killed by an unauthorized request");
});

test("engine reasons (degraded/shutdown) engage from a validated identity (not operator-gated)", async () => {
  const ks = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill });
  const r = await ks.degrade({ note: "circuit open" }, AGENT()); // non-operator, but reason=degraded
  assert.equal(r.engaged, true);
  const sig = (await ks.status()).signals[0];
  assert.equal(sig?.reason, "degraded");
  assert.equal(sig?.mode, "soft", "degrade is a soft kill (stop new work, finish in-flight)");
});

// ── DURABLE LATCH (survives restart) ─────────────────────────────────────────

test("a kill persists to the store and a FRESH instance (restart) reads it as killed", async () => {
  const ms = memStore();
  await mk({ store: ms.store, publishKill: publishKillSpy().publishKill }).kill(engineKill, OPERATOR());
  // Fresh instance over the SAME store — simulates a restart.
  const fresh = mk({ store: ms.store, publishKill: publishKillSpy().publishKill });
  assert.equal((await fresh.isKilled({})).killed, true, "the persisted kill survives restart");
  // clear (operator) un-kills durably.
  const cleared = await fresh.clear(OPERATOR());
  assert.equal(cleared.cleared, true);
  const afterClear = mk({ store: ms.store, publishKill: publishKillSpy().publishKill });
  assert.equal((await afterClear.isKilled({})).killed, false, "clear() removed the latch durably");
});

// ── isKilled SCOPING ─────────────────────────────────────────────────────────

test("engine-scope kills everything; agent/run/operation scopes target only the subject", async () => {
  const engine = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill });
  await engine.kill({ reason: "operator", mode: "hard", scope: "engine" }, OPERATOR());
  assert.equal((await engine.isKilled({ agentId: "anyone", runId: "r1" })).killed, true, "engine scope ⇒ everyone");

  const agent = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill });
  await agent.kill({ reason: "operator", mode: "soft", scope: "agent", target: "worker-7" }, OPERATOR());
  assert.equal((await agent.isKilled({ agentId: "worker-7" })).killed, true, "matching agent killed");
  assert.equal((await agent.isKilled({ agentId: "worker-8" })).killed, false, "other agents NOT killed");

  const run = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill });
  await run.kill({ reason: "operator", mode: "soft", scope: "run", target: "task-42" }, OPERATOR());
  assert.equal((await run.isKilled({ runId: "task-42" })).killed, true);
  assert.equal((await run.isKilled({ runId: "task-99" })).killed, false);
});

// ── clear AUTHORIZATION ──────────────────────────────────────────────────────

test("clear is OPERATOR-ONLY — a non-operator cannot un-kill", async () => {
  const ms = memStore();
  const ks = mk({ store: ms.store, publishKill: publishKillSpy().publishKill });
  await ks.kill(engineKill, OPERATOR());
  const bad = await ks.clear(AGENT());
  assert.equal(bad.cleared, false);
  assert.match(bad.reason ?? "", /operator-tier/);
  assert.equal((await ks.isKilled({})).killed, true, "still killed — a non-operator cannot un-kill");
});

// ── disabled ─────────────────────────────────────────────────────────────────

test("a disabled kill-switch reports not-killed at checkpoints (operator off-switch)", async () => {
  const ms = memStore();
  const ks = createKillSwitch({ config: { enabled: false, latchDir: "/unused" }, subscribe: false, store: ms.store, publishKill: publishKillSpy().publishKill, now: () => 1 });
  await ks.kill(engineKill, OPERATOR());
  assert.equal((await ks.isKilled({})).killed, false, "disabled ⇒ checkpoints see no kill");
});

// ── NO LEAK ──────────────────────────────────────────────────────────────────

test("killswitch.* events carry reason/mode/scope/target — no identity tokens", async () => {
  const ev = captureEvents();
  const ks = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill, publish: ev.publish });
  await ks.kill({ reason: "operator", mode: "hard", scope: "agent", target: "worker-7", note: "manual halt" }, OPERATOR());
  const serialized = JSON.stringify(ev.sent);
  assert.ok(!serialized.includes("operator-secret"), "no identity token in events");
  const engaged = ev.sent.find((e) => (e as { type: string }).type === "killswitch.engaged");
  assert.equal((engaged?.payload as { scope: string }).scope, "agent");
  assert.equal((engaged?.payload as { target: string }).target, "worker-7");
});
