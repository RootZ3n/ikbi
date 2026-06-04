import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { EventBusSurface, EventHandler, EventInput, IkbiEvent, SubscribeOptions, Subscription } from "../../core/events/index.js";
import { createDocumentStore } from "../../core/substrate/index.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import { config as coreConfig } from "../../core/config.js";
import { createSelfObservation, type ReceiptReader } from "./observer.js";
import { DEFAULT_SNAPSHOT_DIR } from "./config.js";
import type { ObservationSnapshot } from "./contract.js";
import type { SelfObservationConfig } from "./config.js";

const cfg = (over: Partial<SelfObservationConfig> = {}): SelfObservationConfig => ({
  enabled: true, recentEventsMax: 200, snapshotDir: "/unused-fake-store", ...over,
});

/** A fake event bus: records subscriptions, delivers published events to matching handlers. */
function fakeBus() {
  interface Rec { opts: SubscribeOptions; handler: EventHandler; active: boolean; stats: { delivered: number; dropped: number; failures: number; queued: number } }
  const subs: Rec[] = [];
  let seq = 0;
  function matches(opts: SubscribeOptions, ev: IkbiEvent): boolean {
    if (opts.predicate && !opts.predicate(ev)) return false;
    if (opts.typePrefix !== undefined && !ev.type.startsWith(opts.typePrefix)) return false;
    if (opts.source !== undefined && ev.source !== opts.source) return false;
    if (opts.types !== undefined && !opts.types.includes(ev.type)) return false;
    return true;
  }
  const bus: EventBusSurface = {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => {
      seq += 1;
      const ev = { contractVersion: "1.0.0", id: `e${seq}`, seq, timestamp: seq, payload: input.payload, ...(input.source !== undefined ? { source: input.source } : {}), ...(input.attribution !== undefined ? { attribution: input.attribution } : {}), type: input.type } as IkbiEvent<P>;
      for (const s of subs) {
        if (s.active && matches(s.opts, ev as IkbiEvent)) {
          s.stats.delivered += 1;
          void s.handler(ev as IkbiEvent);
        }
      }
      return ev;
    },
    subscribe: <P>(opts: SubscribeOptions, handler: EventHandler<P>): Subscription => {
      const rec: Rec = { opts, handler: handler as EventHandler, active: true, stats: { delivered: 0, dropped: 0, failures: 0, queued: 0 } };
      subs.push(rec);
      return { id: `sub${subs.length}`, unsubscribe: () => void (rec.active = false), stats: () => ({ ...rec.stats }) };
    },
    flush: async () => {},
  };
  return { bus, subs, activeCount: () => subs.filter((s) => s.active).length };
}

function emit(bus: EventBusSurface, type: string, source: string, payload: unknown = {}, agentId?: string): void {
  bus.publish({ type, source, payload, ...(agentId !== undefined ? { attribution: { identity: { agentId } } } : {}) });
}

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    contractVersion: "1.0.0", id: "rcpt-1", seq: 1, timestamp: 1000,
    identity: { agentId: "agent-a", trustTier: "trusted" }, operation: "some.op",
    outcome: { status: "success" }, changes: [], metadata: { token: "RECEIPT-SECRET" }, project: "demo", ...over,
  };
}

/** A read-only receipts fake (with an append spy to prove the observer never writes). */
function fakeReceipts(list: Receipt[]) {
  const appendCalls: unknown[] = [];
  const receipts: ReceiptReader & { append: (...a: unknown[]) => Promise<unknown> } = {
    query: async (_f?: ReceiptQuery) => list,
    append: async (...a: unknown[]) => {
      appendCalls.push(a);
      return {};
    },
  };
  return { receipts, appendCalls };
}

function memStore() {
  const m = new Map<string, ObservationSnapshot>();
  const store = { get: async (id: string) => m.get(id), put: async (id: string, v: ObservationSnapshot) => void m.set(id, v) };
  return { store, m };
}

const clock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (by: number) => (t += by) };
};

// ── PASSIVE: no action-module imports ────────────────────────────────────────

test("self-observation source IMPORTS no action module (passive observer)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const importFrom = /(?:import|export)[^;]*from\s+["']([^"']+)["']/g;
  for (const f of files) {
    const src = readFileSync(`${dir}${f}`, "utf8");
    for (const m of src.matchAll(importFrom)) {
      const spec = m[1] ?? "";
      assert.ok(
        !/worker-model|governed-exec|gate-wall|subagent-spawning|dependency-install|mcp-model-loop|agent-router/.test(spec),
        `${f} must not import an action module (found "${spec}")`,
      );
    }
  }
});

// ── OBSERVES EVENTS ──────────────────────────────────────────────────────────

test("observes events: counts by type + by source, recent buffer reflects them", async () => {
  const { bus } = fakeBus();
  const rc = fakeReceipts([]);
  const obs = createSelfObservation({ config: cfg(), events: bus, receipts: rc.receipts, store: memStore().store, publish: () => {}, now: clock().now });

  obs.start();
  emit(bus, "gate.allowed", "gate-wall", {}, "agent-a");
  emit(bus, "gate.denied", "gate-wall");
  emit(bus, "govexec.executed", "governed-exec");

  const snap = await obs.snapshot();
  assert.equal(snap.eventCounts["gate.allowed"], 1);
  assert.equal(snap.eventCounts["gate.denied"], 1);
  assert.equal(snap.eventCounts["govexec.executed"], 1);
  assert.equal(snap.eventsBySource["gate-wall"], 2);
  assert.equal(snap.eventsBySource["governed-exec"], 1);
  assert.equal(snap.recentEvents.length, 3);
  assert.equal(snap.recentEvents[0]?.type, "gate.allowed");
  assert.equal(snap.recentEvents[0]?.agentId, "agent-a");
});

// ── NO PAYLOAD / RECEIPT LEAK (headline 2-eyes safety) ───────────────────────

test("a secret in an event payload OR receipt metadata never reaches a snapshot", async () => {
  const { bus } = fakeBus();
  const rc = fakeReceipts([receipt({ metadata: { token: "RECEIPT-SECRET" } })]);
  const ms = memStore();
  const evSpy: EventInput<unknown>[] = [];
  const obs = createSelfObservation({ config: cfg(), events: bus, receipts: rc.receipts, store: ms.store, publish: (e) => void evSpy.push(e), now: clock().now });

  obs.start();
  emit(bus, "govexec.denied", "governed-exec", { reason: "EVENT-PAYLOAD-SECRET", args: ["EVENT-PAYLOAD-SECRET"] }, "agent-a");
  const snap = await obs.snapshot();

  const haystacks = [JSON.stringify(snap), JSON.stringify(ms.m.get("latest")), JSON.stringify(evSpy)];
  for (const h of haystacks) {
    assert.ok(!h.includes("EVENT-PAYLOAD-SECRET"), "event payload value must NOT be in the snapshot/persisted doc/events");
    assert.ok(!h.includes("RECEIPT-SECRET"), "receipt metadata value must NOT be in the snapshot/persisted doc/events");
  }
  // ...but the structural metadata IS captured.
  assert.equal(snap.eventCounts["govexec.denied"], 1);
  assert.equal(snap.receiptSummary.total, 1);
  assert.equal(snap.receiptSummary.byStatus.success, 1);
});

// ── RING BUFFER BOUND ────────────────────────────────────────────────────────

test("recent-events ring buffer is bounded (oldest dropped, no unbounded growth)", async () => {
  const { bus } = fakeBus();
  const obs = createSelfObservation({ config: cfg({ recentEventsMax: 3 }), events: bus, receipts: fakeReceipts([]).receipts, store: memStore().store, publish: () => {}, now: clock().now });

  obs.start();
  for (let i = 0; i < 5; i += 1) emit(bus, `evt.${i}`, "src");
  const snap = await obs.snapshot();
  assert.equal(snap.recentEvents.length, 3, "capped at recentEventsMax");
  assert.deepEqual(snap.recentEvents.map((e) => e.type), ["evt.2", "evt.3", "evt.4"], "oldest dropped");
});

// ── RECEIPTS READ-ONLY ───────────────────────────────────────────────────────

test("the observer reads receipts for the summary but NEVER appends one", async () => {
  const { bus } = fakeBus();
  const rc = fakeReceipts([receipt({ outcome: { status: "success" } }), receipt({ id: "r2", outcome: { status: "failure" } })]);
  const obs = createSelfObservation({ config: cfg(), events: bus, receipts: rc.receipts, store: memStore().store, publish: () => {}, now: clock().now });

  obs.start();
  emit(bus, "x.y", "src");
  const snap = await obs.snapshot();
  assert.equal(snap.receiptSummary.total, 2);
  assert.equal(snap.receiptSummary.byStatus.success, 1);
  assert.equal(snap.receiptSummary.byStatus.failure, 1);
  assert.equal(rc.appendCalls.length, 0, "the observer never writes a receipt");
});

// ── PERSISTENCE UNDER STATE ROOT ─────────────────────────────────────────────

test("the snapshot dir lives UNDER the engine state root (covered by state/ gitignore)", () => {
  assert.equal(DEFAULT_SNAPSHOT_DIR, join(coreConfig.stateRoot, "self-observation"));
  assert.ok(DEFAULT_SNAPSHOT_DIR.startsWith(coreConfig.stateRoot), "under the state root, not a CWD/.ikbi path");
});

test("a snapshot round-trips through a real DocumentStore", async () => {
  const { bus } = fakeBus();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-selfobs-"));
  const store = createDocumentStore<ObservationSnapshot>({ dir });
  const obs = createSelfObservation({ config: cfg({ snapshotDir: dir }), events: bus, receipts: fakeReceipts([]).receipts, store, publish: () => {}, now: clock().now });

  obs.start();
  emit(bus, "a.b", "src");
  const snap = await obs.snapshot();
  const fetched = await store.get("latest");
  assert.ok(fetched, "persisted to disk");
  assert.equal(fetched?.eventCounts["a.b"], 1);
  assert.equal(fetched?.generatedAt, snap.generatedAt);
});

// ── start/stop lifecycle ─────────────────────────────────────────────────────

test("start subscribes (once, idempotent); stop unsubscribes", async () => {
  const fb = fakeBus();
  const obs = createSelfObservation({ config: cfg(), events: fb.bus, receipts: fakeReceipts([]).receipts, store: memStore().store, publish: () => {}, now: clock().now });

  obs.start();
  obs.start(); // idempotent
  assert.equal(fb.subs.length, 1, "only one subscription");
  assert.equal(fb.activeCount(), 1);
  obs.stop();
  assert.equal(fb.activeCount(), 0, "unsubscribed on stop");
});

// ── disabled ─────────────────────────────────────────────────────────────────

test("a disabled observer does not subscribe and returns a minimal snapshot", async () => {
  const fb = fakeBus();
  const rc = fakeReceipts([receipt()]);
  const obs = createSelfObservation({ config: cfg({ enabled: false }), events: fb.bus, receipts: rc.receipts, store: memStore().store, publish: () => {}, now: clock().now });

  obs.start();
  assert.equal(fb.subs.length, 0, "no subscription created when disabled");
  const snap = await obs.snapshot();
  assert.deepEqual(snap.eventCounts, {});
  assert.equal(snap.receiptSummary.total, 0, "disabled view does not read receipts");
});

// ── subscription health surfaced ─────────────────────────────────────────────

test("snapshot surfaces the subscription health (delivered/dropped/failures/queued)", async () => {
  const { bus } = fakeBus();
  const obs = createSelfObservation({ config: cfg(), events: bus, receipts: fakeReceipts([]).receipts, store: memStore().store, publish: () => {}, now: clock().now });

  obs.start();
  emit(bus, "a", "src");
  emit(bus, "b", "src");
  const snap = await obs.snapshot();
  assert.equal(snap.subscriptionHealth.delivered, 2, "delivered count surfaced from Subscription.stats()");
  assert.equal(snap.subscriptionHealth.dropped, 0);
});
