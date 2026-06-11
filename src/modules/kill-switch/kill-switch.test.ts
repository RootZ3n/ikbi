import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { EventInput } from "../../core/events/index.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { ValidatedIdentity } from "../../core/identity/resolver.js";
import type { KillSignal } from "../../core/kill-switch.js";
import { events as coreEvents } from "../../core/events/index.js";
import { publishKill as corePublishKill } from "../../core/kill-switch.js";
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

// ── AUTHORIZATION BY IMPACT (C3a — the gate is on IMPACT, not the reason string) ──

test("C3a: a NON-operator is REJECTED for a work-halting kill of ANY reason/scope (gate by impact)", async () => {
  // The bug was that only reason==="operator" was gated — a non-operator could engage a
  // policy/shutdown hard engine kill. Prove EVERY work-halting (reason, scope) is rejected.
  const reasons: Array<KillSignal["reason"]> = ["operator", "policy", "shutdown"];
  const scopes: Array<{ scope: KillSignal["scope"]; target?: string }> = [
    { scope: "engine" },
    { scope: "agent", target: "worker-7" },
    { scope: "run", target: "task-42" },
    { scope: "operation", target: "req-1" },
  ];
  for (const reason of reasons) {
    for (const { scope, target } of scopes) {
      const ms = memStore();
      const pk = publishKillSpy();
      const ev = captureEvents();
      const ks = mk({ store: ms.store, publishKill: pk.publishKill, publish: ev.publish });
      const signal: KillSignal = { reason, mode: "hard", scope, ...(target !== undefined ? { target } : {}) };
      const r = await ks.kill(signal, AGENT()); // a VALIDATED non-operator
      assert.equal(r.engaged, false, `non-operator ${reason}/${scope} must be rejected`);
      assert.match(r.reason ?? "", /operator-tier/);
      assert.equal(pk.calls.length, 0, "no seam publish on an unauthorized kill");
      assert.equal(ms.m.get("state")?.signals.length ?? 0, 0, "no latch set");
      assert.ok(ev.types().includes("killswitch.rejected"));
      assert.equal((await ks.isKilled({ agentId: "worker-7", runId: "task-42", requestId: "req-1" })).killed, false, "isKilled stays false");
    }
  }
});

test("C3a: an operator-tier identity CAN engage a work-halting kill of ANY reason", async () => {
  for (const reason of ["operator", "policy", "shutdown"] as Array<KillSignal["reason"]>) {
    const ks = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill });
    const r = await ks.kill({ reason, mode: "hard", scope: "engine" }, OPERATOR());
    assert.equal(r.engaged, true, `operator ${reason} engages`);
    assert.equal((await ks.isKilled({})).killed, true);
  }
});

// ── C3b — THE FORGE TEST: a raw seam publish cannot forge an OBEYED kill ──────

test("C3b forge: a direct core publishKill does NOT make isKilled killed — only an authorized engage does", async () => {
  const ms = memStore();
  // Default subscribe/seam wiring (the real core bus) — NOT injecting publishKill/onKill.
  const ks = createKillSwitch({ config: CFG, store: ms.store, now: () => 1 });
  // A direct, UNGATED core publishKill (bypassing the module authorization entirely).
  corePublishKill({ reason: "operator", mode: "hard", scope: "engine", note: "forged" });
  await coreEvents.flush();
  assert.equal((await ks.isKilled({})).killed, false, "a raw seam event cannot forge an obeyed kill");
  assert.equal(ms.m.get("state")?.signals.length ?? 0, 0, "a raw event is NOT a write path to the durable latch");
  // ONLY the authorized module path makes isKilled true.
  await ks.kill(engineKill, OPERATOR());
  assert.equal((await ks.isKilled({})).killed, true, "the authorized module engage is the sole writer of the obeyed latch");
});

// ── BLOCKER 4 — the durable latch read FAILS CLOSED ──────────────────────────

test("blocker 4: an unreadable latch (store throws on read) is treated as KILLED, not clear (fail-closed)", async () => {
  const ev = captureEvents();
  const throwingStore: LatchStore = {
    get: async () => { throw new Error("substrate read failed"); },
    put: async () => {},
  };
  const ks = mk({ store: throwingStore, publishKill: publishKillSpy().publishKill, publish: ev.publish });
  const check = await ks.isKilled({ agentId: "anyone" });
  assert.equal(check.killed, true, "a failed latch read must fail CLOSED (assume killed)");
  assert.equal(check.signal?.scope, "engine", "fail-closed kill is engine-scope (everyone)");
  assert.equal(check.signal?.mode, "soft", "fail-closed kill is a soft kill (prevent new work)");
  assert.ok(ev.types().includes("killswitch.unreadable"), "a LOUD unreadable-latch event was emitted");
});

// ── FIX 5 — degrade() is OPERATOR-GATED (a degraded kill halts work) ─────────

test("FIX 5: a non-operator degrade() is REJECTED; an operator degrade() engages a soft degraded kill", async () => {
  const nonOp = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill });
  const bad = await nonOp.degrade({ note: "circuit open" }, AGENT());
  assert.equal(bad.engaged, false, "a non-operator cannot degrade (engine-scope stop-new-work is a DoS surface)");
  assert.match(bad.reason ?? "", /operator-tier/);
  assert.equal((await nonOp.isKilled({})).killed, false, "no degraded kill engaged by a non-operator");

  const op = mk({ store: memStore().store, publishKill: publishKillSpy().publishKill });
  const ok = await op.degrade({ note: "circuit open" }, OPERATOR());
  assert.equal(ok.engaged, true, "an operator CAN manually degrade");
  const sig = (await op.status()).signals[0];
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

// ── L4: PERSIST before mutating the in-memory latch ──────────────────────────

test("L4: when persist FAILS, the in-memory latch is NOT mutated (no phantom kill; error surfaces)", async () => {
  // A store whose put() always throws — simulates a durable-write failure.
  const failing: LatchStore = {
    get: async () => undefined,
    put: async () => {
      throw new Error("disk full");
    },
  };
  const pk = publishKillSpy();
  const ev = captureEvents();
  const ks = mk({ store: failing, publishKill: pk.publishKill, publish: ev.publish });

  // The persist failure surfaces to the caller (fail loud), not swallowed.
  await assert.rejects(() => ks.kill(engineKill, OPERATOR()), /disk full/);

  // CRITICAL: in-memory state was NOT mutated — the engine is not phantom-killed. A kill that
  // could not be made durable must not appear engaged (it would vanish on restart otherwise).
  assert.equal((await ks.isKilled({})).killed, false, "no in-memory latch after a failed persist");
  assert.equal(pk.calls.length, 0, "the seam halt was NOT published — persist must land first");
});
