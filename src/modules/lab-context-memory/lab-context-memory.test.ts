import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { EventInput } from "../../core/events/index.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { ValidatedIdentity } from "../../core/identity/resolver.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import { createLabMemory, type MemoryStore } from "./memory.js";
import { LabMemoryError, type MemoryEntry } from "./contract.js";
import type { LabContextMemoryConfig } from "./config.js";
import type { LabMemEventPayload } from "./events.js";

const silent = () => pino({ level: "silent" });

/** Validated identities for two distinct lab agents (ikbi + ptah). */
function identities() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "ikbi", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken("ikbi-secret")] },
        { agentId: "ptah", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken("ptah-secret")] },
      ],
    }),
    logger: silent(),
    now: () => 1000,
  });
  return { ikbi: resolver.resolve({ token: "ikbi-secret" }), ptah: resolver.resolve({ token: "ptah-secret" }) };
}

function cfg(over: Partial<LabContextMemoryConfig> = {}): LabContextMemoryConfig {
  return { enabled: true, memoryDir: "/unused-in-fake-store", maxReceiptsPerProjection: 1000, ...over };
}

/** An in-memory MemoryStore (the API proof; a real DocumentStore round-trip is tested separately). */
function memStore() {
  const m = new Map<string, MemoryEntry>();
  const store: MemoryStore = {
    get: async (id) => m.get(id),
    put: async (id, v) => void m.set(id, v),
    list: async () => [...m.keys()],
  };
  return { store, m };
}

function fakeReceipts(list: Receipt[]) {
  const queries: ReceiptQuery[] = [];
  const receipts = {
    query: async (f?: ReceiptQuery): Promise<Receipt[]> => {
      queries.push(f ?? {});
      return list;
    },
  };
  return { receipts, queries };
}

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    contractVersion: "1.0.0",
    id: "rcpt-1",
    seq: 1,
    timestamp: 1000,
    identity: { agentId: "ikbi", trustTier: "trusted" },
    operation: "worker.role.builder",
    requestSummary: { note: "SECRET-REQ-TOKEN" },
    outcome: { status: "success" },
    changes: [{ kind: "file", target: "src/a.ts", summary: "wrote SECRET-CHANGE-TOKEN" }],
    metadata: { apiKey: "SECRET-META-TOKEN" },
    project: "Luak",
    ...over,
  };
}

function captureEvents() {
  const sent: Array<EventInput<LabMemEventPayload>> = [];
  return { publish: (e: EventInput<LabMemEventPayload>) => void sent.push(e), sent, types: () => sent.map((e) => e.type) };
}

const clock = (start = 1000) => {
  let t = start;
  const now = () => t;
  return { now, advance: (by: number) => (t += by) };
};

// ── THE HEADLINE: cross-agent byProject ──────────────────────────────────────

test("byProject returns EVERY agent's contributions to a project (lab memory, not ikbi memory)", async () => {
  const { ikbi, ptah } = identities();
  const ms = memStore();
  const mem = createLabMemory({ config: cfg(), store: ms.store, publish: () => {}, now: () => 1000 });

  await mem.record({ project: "Luak", kind: "activity", key: "fix-1", value: { summary: "ikbi fixed the parser" } }, ikbi);
  await mem.record({ project: "Luak", kind: "capability", key: "module-y", value: { name: "module Y" } }, ptah);
  await mem.record({ project: "Other", kind: "activity", key: "x", value: { summary: "elsewhere" } }, ikbi);

  const luak = await mem.byProject("Luak");
  const agents = luak.map((e) => e.agent).sort();
  assert.deepEqual(agents, ["ikbi", "ptah"], "both agents' Luak entries are visible to a single project query");
  assert.equal(luak.length, 2);
  assert.ok(!luak.some((e) => e.project === "Other"), "scoped to the project");
});

// ── record upsert semantics ──────────────────────────────────────────────────

test("record upserts by id: updatedAt advances, createdAt is preserved", async () => {
  const { ikbi } = identities();
  const ms = memStore();
  const ck = clock(1000);
  const mem = createLabMemory({ config: cfg(), store: ms.store, publish: () => {}, now: ck.now });

  const first = await mem.record({ project: "Luak", kind: "activity", key: "fix-1", value: { v: 1 } }, ikbi);
  ck.advance(500);
  const second = await mem.record({ project: "Luak", kind: "activity", key: "fix-1", value: { v: 2 } }, ikbi);

  assert.equal(first.id, second.id, "same (project,agent,kind,key) ⇒ same id (upsert)");
  assert.equal(second.createdAt, first.createdAt, "createdAt preserved");
  assert.equal(second.updatedAt, 1500, "updatedAt advanced");
  assert.equal(second.value.v, 2, "value replaced");
  assert.equal(ms.m.size, 1, "one stored doc (upsert, not insert)");
});

// ── STRUCTURAL REDACTION (safety headline) ───────────────────────────────────

test("projectFromReceipts persists ONLY structural fields — freeform metadata/requestSummary NEVER leak", async () => {
  const { ikbi } = identities();
  const ms = memStore();
  const ev = captureEvents();
  const rc = fakeReceipts([receipt({ seq: 1 })]);
  const mem = createLabMemory({ config: cfg(), store: ms.store, receipts: rc.receipts, publish: ev.publish, now: () => 1000 });

  const { projected } = await mem.projectFromReceipts({ identity: ikbi, project: "Luak" });
  assert.ok(projected >= 1);

  const stored = [...ms.m.values()];
  const activity = stored.find((e) => e.kind === "activity");
  assert.ok(activity, "an activity entry was projected");
  // Structural fields ARE present.
  assert.equal(activity?.value.operation, "worker.role.builder");
  assert.equal(activity?.value.outcomeStatus, "success");
  assert.deepEqual(activity?.value.changeKinds, ["file"]);
  assert.deepEqual(activity?.value.changeTargets, ["src/a.ts"]);

  // The freeform receipt fields NEVER reach a persisted entry OR an event.
  const persisted = JSON.stringify(stored);
  const events = JSON.stringify(ev.sent);
  for (const secret of ["SECRET-REQ-TOKEN", "SECRET-META-TOKEN", "SECRET-CHANGE-TOKEN"]) {
    assert.ok(!persisted.includes(secret), `"${secret}" must NOT be persisted`);
    assert.ok(!events.includes(secret), `"${secret}" must NOT be in events`);
  }
});

// ── pattern projection ───────────────────────────────────────────────────────

test("pattern projection aggregates success/failure per (agent, project, operation)", async () => {
  const { ikbi } = identities();
  const ms = memStore();
  const rc = fakeReceipts([
    receipt({ seq: 1, operation: "build.run", outcome: { status: "success" } }),
    receipt({ seq: 2, operation: "build.run", outcome: { status: "failure" } }),
    receipt({ seq: 3, operation: "build.run", outcome: { status: "success" } }),
  ]);
  const mem = createLabMemory({ config: cfg(), store: ms.store, receipts: rc.receipts, publish: () => {}, now: () => 1000 });

  await mem.projectFromReceipts({ identity: ikbi });
  const pattern = [...ms.m.values()].find((e) => e.kind === "pattern" && e.key === "op-build.run");
  assert.ok(pattern, "a pattern entry for build.run");
  assert.equal(pattern?.value.total, 3);
  assert.equal(pattern?.value.successes, 2);
  assert.equal(pattern?.value.failures, 1);
  assert.equal(pattern?.value.lastOutcome, "success");
});

// ── query scoping ────────────────────────────────────────────────────────────

test("byAgent scopes to one agent; query filters by project/agent/kind/key", async () => {
  const { ikbi, ptah } = identities();
  const ms = memStore();
  const mem = createLabMemory({ config: cfg(), store: ms.store, publish: () => {}, now: () => 1000 });

  await mem.record({ project: "Luak", kind: "activity", key: "a", value: {} }, ikbi);
  await mem.record({ project: "Luak", kind: "pattern", key: "op-x", value: {} }, ikbi);
  await mem.record({ project: "Luak", kind: "activity", key: "b", value: {} }, ptah);

  const ikbiOnly = await mem.byAgent("ikbi");
  assert.equal(ikbiOnly.length, 2);
  assert.ok(ikbiOnly.every((e) => e.agent === "ikbi"));

  const ikbiActivities = await mem.byAgent("ikbi", { kind: "activity" });
  assert.equal(ikbiActivities.length, 1);

  const byKey = await mem.query({ project: "Luak", agent: "ptah", kind: "activity", key: "b" });
  assert.equal(byKey.length, 1);
  assert.equal(byKey[0]?.agent, "ptah");
});

// ── DocumentStore round-trip (durability) ────────────────────────────────────

test("an entry recorded through a real DocumentStore round-trips via get(id)", async () => {
  const { ikbi } = identities();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-labmem-"));
  const mem = createLabMemory({ config: cfg({ memoryDir: dir }), publish: () => {}, now: () => 1000 });

  const entry = await mem.record({ project: "Luak", kind: "capability", key: "module-y", value: { name: "module Y" } }, ikbi);
  const fetched = await mem.get(entry.id);
  assert.ok(fetched, "round-tripped from disk");
  assert.equal(fetched?.id, entry.id);
  assert.equal(fetched?.value.name, "module Y");
  assert.equal(fetched?.agent, "ikbi");
});

// ── fail-closed writes ───────────────────────────────────────────────────────

test("a disabled store refuses writes (record + project), reads stay open", async () => {
  const { ikbi } = identities();
  const ms = memStore();
  const mem = createLabMemory({ config: cfg({ enabled: false }), store: ms.store, receipts: fakeReceipts([]).receipts, publish: () => {}, now: () => 1000 });

  await assert.rejects(() => mem.record({ project: "Luak", kind: "activity", key: "a", value: {} }, ikbi), (e: unknown) => e instanceof LabMemoryError && e.kind === "disabled");
  await assert.rejects(() => mem.projectFromReceipts({ identity: ikbi }), (e: unknown) => e instanceof LabMemoryError && e.kind === "disabled");
  // reads do not throw.
  assert.deepEqual(await mem.byProject("Luak"), []);
});

test("record refuses a non-validated identity", async () => {
  const ms = memStore();
  const mem = createLabMemory({ config: cfg(), store: ms.store, publish: () => {}, now: () => 1000 });
  const spoof = { kind: "agent", identity: { agentId: "spoof", trustTier: "operator" }, authMethod: "agent_token", resolvedAt: 0 } as unknown as ValidatedIdentity;
  await assert.rejects(() => mem.record({ project: "Luak", kind: "activity", key: "a", value: {} }, spoof), (e: unknown) => e instanceof LabMemoryError && e.kind === "identity");
});

// ── events ───────────────────────────────────────────────────────────────────

test("labmem.* events emit on record/project/query without leaking entry values", async () => {
  const { ikbi } = identities();
  const ms = memStore();
  const ev = captureEvents();
  const rc = fakeReceipts([receipt({ seq: 1 })]);
  const mem = createLabMemory({ config: cfg(), store: ms.store, receipts: rc.receipts, publish: ev.publish, now: () => 1000 });

  await mem.record({ project: "Luak", kind: "activity", key: "a", value: { secretValue: "ENTRY-SECRET" } }, ikbi);
  await mem.projectFromReceipts({ identity: ikbi, project: "Luak" });
  await mem.byProject("Luak");

  const types = ev.types();
  assert.ok(types.includes("labmem.recorded"));
  assert.ok(types.includes("labmem.projected"));
  assert.ok(types.includes("labmem.queried"));
  for (const e of ev.sent) assert.equal(e.source, "lab-context-memory");
  assert.ok(!JSON.stringify(ev.sent).includes("ENTRY-SECRET"), "entry values are NOT in events");
});
