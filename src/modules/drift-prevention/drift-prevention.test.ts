import assert from "node:assert/strict";
import { test } from "node:test";

import type { EventInput } from "../../core/events/index.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import type { MemoryEntry } from "../lab-context-memory/index.js";
import { createDriftPrevention, computeDrift, reportOnly, warnPolicy, blockPolicy, policyForName } from "./drift.js";
import { parseDriftPolicy, type DriftPreventionConfig } from "./config.js";
import { DriftBlockedError, type DriftPolicy, type DriftReport } from "./contract.js";

const CFG: DriftPreventionConfig = { enabled: true, driftThreshold: 0.2, minSampleSize: 5, recentWindow: 20 };

/** A "pattern" memory entry for (agent, operation) with the projected counts. */
function pattern(agent: string, operation: string, successes: number, total: number): MemoryEntry {
  return {
    id: `demo:${agent}:pattern:op-${operation}`, project: "demo", agent, kind: "pattern", key: `op-${operation}`,
    value: { operation, successes, failures: total - successes, total, lastOutcome: "success" }, createdAt: 1000, updatedAt: 1000,
  };
}

/** N receipts for (agent, operation): `passed` of them success, the rest failure. */
function receiptsFor(agent: string, operation: string, passed: number, total: number): Receipt[] {
  return Array.from({ length: total }, (_, i) => ({
    contractVersion: "1.0.0", id: `r${i}`, seq: i + 1, timestamp: 1000 + i,
    identity: { agentId: agent, trustTier: "trusted" }, operation,
    outcome: { status: i < passed ? "success" : "failure" } as Receipt["outcome"], changes: [], project: "demo",
  }));
}

/** Fake read surfaces with WRITE spies (record/append must never be called). */
function fakes(patterns: MemoryEntry[], recent: Receipt[]) {
  const recordCalls: unknown[] = [];
  const appendCalls: unknown[] = [];
  const labMemory = {
    byAgent: async (agent: string, opts?: { project?: string; kind?: string }) =>
      patterns.filter((p) => p.agent === agent && (opts?.kind === undefined || p.kind === opts.kind) && (opts?.project === undefined || p.project === opts.project)),
    record: async (...a: unknown[]) => { recordCalls.push(a); return {}; },
  };
  const receipts = {
    query: async (f?: ReceiptQuery) => recent.filter((r) => (f?.agentId === undefined || r.identity.agentId === f.agentId) && (f?.operation === undefined || r.operation === f.operation)),
    append: async (...a: unknown[]) => { appendCalls.push(a); return {}; },
  };
  return { labMemory, receipts, recordCalls, appendCalls };
}

function captureEvents() {
  const sent: Array<EventInput<unknown>> = [];
  return { publish: (e: EventInput<unknown>) => void sent.push(e), sent, types: () => sent.map((e) => (e as { type: string }).type) };
}

const mk = (over: Record<string, unknown>) => createDriftPrevention({ config: CFG, publish: () => {}, ...over });

// ── DRIFT DETECTED (headline) ────────────────────────────────────────────────

test("a reliable agent that degrades is FLAGGED (baseline 0.9, recent 0.2 ⇒ major drift)", async () => {
  const f = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 2, 10));
  const ev = captureEvents();
  const reports = await mk({ labMemory: f.labMemory, receipts: f.receipts, publish: ev.publish }).check({ agent: "a" });

  assert.equal(reports.length, 1);
  const r = reports[0]!;
  assert.equal(r.drifted, true);
  assert.equal(r.severity, "major", "a 0.7 drop is major");
  assert.ok(Math.abs(r.baselineRate - 0.9) < 1e-9);
  assert.ok(Math.abs(r.recentRate - 0.2) < 1e-9);
  assert.ok(Math.abs(r.drop - 0.7) < 1e-9);
  // drift.detected emitted with rates (no raw outcomes).
  const detected = ev.sent.find((e) => (e as { type: string }).type === "drift.detected");
  assert.ok(detected, "drift.detected emitted");
  assert.equal((detected?.payload as { recentRate: number }).recentRate, 0.2);
});

// ── NO DRIFT (stable) ────────────────────────────────────────────────────────

test("a stable agent is NOT flagged (baseline 0.9, recent 0.85 ⇒ drop 0.05 < threshold)", async () => {
  const f = fakes([pattern("a", "op.x", 90, 100)], receiptsFor("a", "op.x", 17, 20));
  const ev = captureEvents();
  const reports = await mk({ labMemory: f.labMemory, receipts: f.receipts, publish: ev.publish }).check({ agent: "a" });
  assert.equal(reports[0]?.drifted, false);
  assert.ok(!ev.types().includes("drift.detected"), "no drift.detected for a stable agent");
  assert.ok(ev.types().includes("drift.checked"));
});

// ── MIN SAMPLE SIZE (anti-noise) ─────────────────────────────────────────────

test("too few recent samples ⇒ NOT flagged even with a big nominal drop", async () => {
  // baseline 0.95; recent 0/2 = 0.0 (drop 0.95) BUT only 2 samples < minSampleSize 5.
  const f = fakes([pattern("a", "op.x", 19, 20)], receiptsFor("a", "op.x", 0, 2));
  const reports = await mk({ labMemory: f.labMemory, receipts: f.receipts }).check({ agent: "a" });
  assert.equal(reports[0]?.drifted, false);
  assert.match(reports[0]?.reason ?? "", /insufficient recent samples/);
});

// ── DETERMINISM ──────────────────────────────────────────────────────────────

test("the same baseline + recent inputs yield the same DriftReport, every time", async () => {
  const f1 = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 3, 10));
  const f2 = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 3, 10));
  const r1 = await mk({ labMemory: f1.labMemory, receipts: f1.receipts }).check({ agent: "a" });
  const r2 = await mk({ labMemory: f2.labMemory, receipts: f2.receipts }).check({ agent: "a" });
  assert.deepEqual(r1, r2, "pure math ⇒ reproducible verdict");
});

test("computeDrift is pure (unit): drop math + severity bands", () => {
  assert.equal(computeDrift(CFG, "a", "o", undefined, 0.9, 1, 10).drifted, true); // recent 0.1, drop 0.8 → major
  assert.equal(computeDrift(CFG, "a", "o", undefined, 0.9, 1, 10).severity, "major");
  assert.equal(computeDrift(CFG, "a", "o", undefined, 0.9, 7, 10).severity, "minor"); // drop 0.2 → minor
  assert.equal(computeDrift(CFG, "a", "o", undefined, 0.9, 8, 10).drifted, false); // drop 0.1 < 0.2
  assert.equal(computeDrift(CFG, "a", "o", undefined, 0.9, 1, 3).drifted, false); // < min samples
});

// ── NO ACTION (v1 posture) ───────────────────────────────────────────────────

test("on a MAJOR drift, drift-prevention writes/acts NOTHING (no memory/receipt write)", async () => {
  const f = fakes([pattern("a", "op.x", 20, 20)], receiptsFor("a", "op.x", 0, 10));
  const reports = await mk({ labMemory: f.labMemory, receipts: f.receipts }).check({ agent: "a" });
  assert.equal(reports[0]?.drifted, true);
  assert.equal(reports[0]?.severity, "major");
  assert.equal(f.recordCalls.length, 0, "no lab-memory write");
  assert.equal(f.appendCalls.length, 0, "no receipt write");
});

test("the default policy is reportOnly (act:false) — even act:true triggers nothing in v1", () => {
  assert.deepEqual(reportOnly({ agent: "a", operation: "o", baselineRate: 0.9, recentRate: 0.1, drop: 0.8, sampleSize: 10, drifted: true, severity: "major", reason: "x" }), { act: false });
});

// ── INTERVENTION SEAM ────────────────────────────────────────────────────────

test("a custom DriftPolicy is consulted on each drifted report (the upgrade seam)", async () => {
  const seen: DriftReport[] = [];
  const demotePolicy: DriftPolicy = (report) => { seen.push(report); return { act: report.severity === "major", note: "would demote" }; };
  const f = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 1, 10));
  await mk({ labMemory: f.labMemory, receipts: f.receipts, policy: demotePolicy }).check({ agent: "a" });
  assert.equal(seen.length, 1, "the custom policy received the drifted report");
  assert.equal(seen[0]?.drifted, true);
  // ...but drift-prevention still took no action (no memory/receipt write) — policy is advisory in v1.
  assert.equal(f.recordCalls.length + f.appendCalls.length, 0);
});

// ── READ-ONLY (no action surface) — import scan ──────────────────────────────

test("drift-prevention source imports NO trust/gate-wall/execution/model module (read-only, no action)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const importFrom = /(?:import|export)[^;]*from\s+["']([^"']+)["']/g;
  for (const f of files) {
    const src = readFileSync(`${dir}${f}`, "utf8");
    for (const m of src.matchAll(importFrom)) {
      const spec = m[1] ?? "";
      assert.ok(!/gate-wall|governed-exec|core\/trust|provider\/index/.test(spec), `${f} must not import ${spec} (drift is read-only, acts on nothing)`);
    }
  }
});

// ── NO LEAK ──────────────────────────────────────────────────────────────────

test("drift.* events carry rates/counts only — no raw receipt content or secrets", async () => {
  const recent = receiptsFor("a", "op.x", 1, 10).map((r, i) => (i === 0 ? { ...r, metadata: { token: "RECEIPT-SECRET" }, requestSummary: { note: "REQ-SECRET" } } : r));
  const f = fakes([pattern("a", "op.x", 19, 20)], recent);
  const ev = captureEvents();
  await mk({ labMemory: f.labMemory, receipts: f.receipts, publish: ev.publish }).check({ agent: "a" });
  const serialized = JSON.stringify(ev.sent);
  assert.ok(!serialized.includes("RECEIPT-SECRET"), "no receipt metadata in events");
  assert.ok(!serialized.includes("REQ-SECRET"), "no request summary in events");
  for (const e of ev.sent) assert.equal((e as { source: string }).source, "drift-prevention");
});

// ── INTERVENTION POLICIES (1.1.0) ────────────────────────────────────────────

const drifted = (over: Partial<DriftReport> = {}): DriftReport =>
  ({ agent: "a", operation: "op.x", baselineRate: 0.9, recentRate: 0.1, drop: 0.8, sampleSize: 10, drifted: true, severity: "major", reason: "x", ...over });

test("policy functions: reportOnly=no act, warn=act+kind warn, block=act+kind block", () => {
  assert.deepEqual(reportOnly(drifted()), { act: false });
  const w = warnPolicy(drifted());
  assert.equal(w.act, true);
  assert.equal(w.kind, "warn");
  const b = blockPolicy(drifted());
  assert.equal(b.act, true);
  assert.equal(b.kind, "block");
});

test("policyForName maps config names to policies (default reportOnly)", () => {
  assert.equal(policyForName("warn"), warnPolicy);
  assert.equal(policyForName("block"), blockPolicy);
  assert.equal(policyForName("reportOnly"), reportOnly);
  assert.equal(policyForName(undefined), reportOnly);
});

test("parseDriftPolicy validates the env value (fail-loud on garbage)", () => {
  assert.equal(parseDriftPolicy(undefined), "reportOnly");
  assert.equal(parseDriftPolicy("block"), "block");
  assert.throws(() => parseDriftPolicy("halt-everything"), /invalid IKBI_DRIFT_PREVENTION_POLICY/);
});

test("reportOnly: a drifted report is stamped action 'none' (advisory, no throw)", async () => {
  const f = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 2, 10));
  const reports = await mk({ labMemory: f.labMemory, receipts: f.receipts, config: { ...CFG, policy: "reportOnly" } }).check({ agent: "a" });
  assert.equal(reports[0]?.drifted, true);
  assert.equal(reports[0]?.action, "none");
});

test("warn policy: a drifted report is stamped action 'warned' and check() still returns", async () => {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const f = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 2, 10));
    const reports = await mk({ labMemory: f.labMemory, receipts: f.receipts, config: { ...CFG, policy: "warn" } }).check({ agent: "a" });
    assert.equal(reports[0]?.action, "warned");
    assert.equal(warned.length, 1, "a warning was logged");
    assert.match(warned[0] ?? "", /\[drift\] a\/op\.x/);
  } finally {
    console.warn = orig;
  }
});

test("block policy: a detected drift THROWS DriftBlockedError carrying the reports", async () => {
  const f = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 2, 10));
  const d = mk({ labMemory: f.labMemory, receipts: f.receipts, config: { ...CFG, policy: "block" } });
  await assert.rejects(
    () => d.check({ agent: "a" }),
    (e: unknown) => {
      assert.ok(e instanceof DriftBlockedError, "throws the typed error");
      assert.equal(e.reports.length, 1);
      assert.equal(e.reports[0]?.action, "blocked");
      assert.match(e.message, /drift blocked/);
      return true;
    },
  );
});

test("block policy: NO drift ⇒ no throw (a stable agent passes through)", async () => {
  const f = fakes([pattern("a", "op.x", 90, 100)], receiptsFor("a", "op.x", 17, 20));
  const reports = await mk({ labMemory: f.labMemory, receipts: f.receipts, config: { ...CFG, policy: "block" } }).check({ agent: "a" });
  assert.equal(reports[0]?.drifted, false);
  assert.equal(reports[0]?.action, "none", "no drift ⇒ no intervention");
});

// ── disabled ─────────────────────────────────────────────────────────────────

test("disabled ⇒ check() returns no reports (inert)", async () => {
  const f = fakes([pattern("a", "op.x", 18, 20)], receiptsFor("a", "op.x", 0, 10));
  const reports = await createDriftPrevention({ config: { ...CFG, enabled: false }, labMemory: f.labMemory, receipts: f.receipts, publish: () => {} }).check({ agent: "a" });
  assert.deepEqual(reports, []);
});
