/**
 * Tests for the self-repair monitor — checks, the runner, work-order minting, de-dup.
 *
 * Everything runs against in-memory ports (no network, no child process, no filesystem,
 * no clock), so the suite is deterministic and fast.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CheckResult, MonitorOptions, MonitorPorts, WorkOrder } from "./contract.js";
import {
  defaultChecks,
  healthCheck,
  parseTestFailures,
  runMonitor,
  runTestCommand,
  serviceDependenciesCheck,
  sourceKey,
  testSuiteCheck,
  toWorkOrder,
  workspaceHealthCheck,
} from "./monitor.js";

// --- fixtures ---------------------------------------------------------------

const OPTS: MonitorOptions = Object.freeze({
  healthUrl: "http://127.0.0.1:18796/health",
  testCommand: "pnpm test",
  repoRoot: "/repo",
  requiredEnv: ["IKBI_OPERATOR_TOKEN", "IKBI_WORKER_TOKEN"],
  stateRoot: "/state",
  staleThreshold: 10,
  repos: ["ikbi"],
  runTestSuite: true,
});

/** A controllable in-memory ports object. Everything healthy by default. */
function memPorts(over: Partial<MonitorPorts> = {}): {
  ports: MonitorPorts;
  written: WorkOrder[];
} {
  const written: WorkOrder[] = [];
  let counter = 0;
  const base: MonitorPorts = {
    healthProbe: async () => ({ ok: true, status: 200 }),
    runTests: async () => ({ ok: true, detail: "" }),
    countStaleWorkspaces: async () => 0,
    envGet: (name) => (name === "IKBI_OPERATOR_TOKEN" || name === "IKBI_WORKER_TOKEN" ? "set" : undefined),
    isWritable: async () => true,
    openWorkOrderSources: async () => new Set<string>(),
    nextWorkOrderId: async () => `WO-${String(++counter).padStart(4, "0")}`,
    writeWorkOrder: async (o) => {
      written.push(o);
    },
    now: () => "2026-06-19T00:00:00.000Z",
  };
  return { ports: { ...base, ...over }, written };
}

// --- individual checks ------------------------------------------------------

test("healthCheck passes when the probe is ok", async () => {
  const { ports } = memPorts();
  const r = await healthCheck.run({ ports, opts: OPTS });
  assert.equal(r.ok, true);
});

test("healthCheck fails service-down/high when the probe is not ok", async () => {
  const { ports } = memPorts({ healthProbe: async () => ({ ok: false, status: 503, detail: "boom" }) });
  const r = await healthCheck.run({ ports, opts: OPTS });
  assert.equal(r.ok, false);
  assert.equal(r.category, "service-down");
  assert.equal(r.severity, "high");
  assert.match(r.problem ?? "", /503/);
  assert.match(r.problem ?? "", /boom/);
});

test("testSuiteCheck fails test-failure/high and surfaces the failing count", async () => {
  const { ports } = memPorts({ runTests: async () => ({ ok: false, detail: "# fail 3", failures: 3 }) });
  const r = await testSuiteCheck.run({ ports, opts: OPTS });
  assert.equal(r.ok, false);
  assert.equal(r.category, "test-failure");
  assert.equal(r.severity, "high");
  assert.match(r.title ?? "", /3 test/);
});

test("testSuiteCheck parses the failing count from the tail when not provided", async () => {
  const { ports } = memPorts({ runTests: async () => ({ ok: false, detail: "...\n# fail 7\n" }) });
  const r = await testSuiteCheck.run({ ports, opts: OPTS });
  assert.match(r.title ?? "", /7 test/);
});

test("workspaceHealthCheck passes below the threshold, fails (maintenance/low) at/above", async () => {
  const under = memPorts({ countStaleWorkspaces: async () => 9 });
  assert.equal((await workspaceHealthCheck.run({ ports: under.ports, opts: OPTS })).ok, true);

  const over = memPorts({ countStaleWorkspaces: async () => 12 });
  const r = await workspaceHealthCheck.run({ ports: over.ports, opts: OPTS });
  assert.equal(r.ok, false);
  assert.equal(r.category, "maintenance");
  assert.equal(r.severity, "low");
  assert.match(r.title ?? "", /12 stale/);
});

test("serviceDependenciesCheck flags missing env vars (high)", async () => {
  const { ports } = memPorts({ envGet: () => undefined });
  const r = await serviceDependenciesCheck.run({ ports, opts: OPTS });
  assert.equal(r.ok, false);
  assert.equal(r.severity, "high");
  assert.equal(r.category, "service-down");
  assert.match(r.problem ?? "", /IKBI_OPERATOR_TOKEN/);
  assert.match(r.problem ?? "", /IKBI_WORKER_TOKEN/);
});

test("serviceDependenciesCheck escalates to critical when the state root is not writable", async () => {
  const { ports } = memPorts({ isWritable: async () => false });
  const r = await serviceDependenciesCheck.run({ ports, opts: OPTS });
  assert.equal(r.ok, false);
  assert.equal(r.severity, "critical");
  assert.match(r.title ?? "", /not writable/);
});

test("serviceDependenciesCheck passes when everything is present and writable", async () => {
  const { ports } = memPorts();
  assert.equal((await serviceDependenciesCheck.run({ ports, opts: OPTS })).ok, true);
});

// --- parseTestFailures ------------------------------------------------------

test("parseTestFailures reads node:test and generic summaries", () => {
  assert.equal(parseTestFailures("# fail 5"), 5);
  assert.equal(parseTestFailures("3 failing"), 3);
  assert.equal(parseTestFailures("all good"), undefined);
});

// --- the runner -------------------------------------------------------------

test("runMonitor files nothing when every check is healthy", async () => {
  const { ports, written } = memPorts();
  const report = await runMonitor(OPTS, ports);
  assert.equal(report.ok, true);
  assert.equal(report.filed.length, 0);
  assert.equal(written.length, 0);
});

test("runMonitor files one work order per tripped check", async () => {
  const { ports, written } = memPorts({
    healthProbe: async () => ({ ok: false, status: 0, detail: "down" }),
    countStaleWorkspaces: async () => 50,
  });
  const report = await runMonitor(OPTS, ports);
  assert.equal(report.ok, false);
  assert.equal(written.length, 2);
  const categories = written.map((w) => w.category).sort();
  assert.deepEqual(categories, ["maintenance", "service-down"]);
  // Every filed order is open, targets ikbi, has a stamped time + de-dup source.
  for (const wo of written) {
    assert.equal(wo.status, "open");
    assert.deepEqual(wo.repos, ["ikbi"]);
    assert.equal(wo.createdAt, "2026-06-19T00:00:00.000Z");
    assert.ok(wo.source.includes(":"));
    assert.equal(wo.resolution, null);
    assert.deepEqual(wo.notes, []);
    assert.match(wo.id, /^WO-\d{4}$/);
  }
});

test("runMonitor de-dups against already-open work orders", async () => {
  const existing = new Set<string>([sourceKey("health", { ok: false, category: "service-down" } as CheckResult)]);
  const { ports, written } = memPorts({
    healthProbe: async () => ({ ok: false, status: 0 }),
    openWorkOrderSources: async () => existing,
  });
  const report = await runMonitor(OPTS, ports);
  assert.equal(written.length, 0, "no new work order — one is already open for this source");
  const health = report.outcomes.find((o) => o.name === "health");
  assert.equal(health?.deduped, true);
  // De-duped problems are not "ok", but the pass is still considered handled.
  assert.equal(report.ok, true);
});

test("runMonitor converts a throwing check into a bug work order (never aborts)", async () => {
  const throwing = {
    name: "boom",
    description: "always throws",
    run: async () => {
      throw new Error("kaboom");
    },
  };
  const { ports, written } = memPorts();
  const report = await runMonitor(OPTS, ports, [throwing]);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.category, "bug");
  assert.match(written[0]?.description ?? "", /kaboom/);
  assert.equal(report.filed.length, 1);
});

test("defaultChecks omits the test suite when runTestSuite is false", () => {
  const withTests = defaultChecks(OPTS).map((c) => c.name);
  assert.ok(withTests.includes("test-suite"));
  const without = defaultChecks({ ...OPTS, runTestSuite: false }).map((c) => c.name);
  assert.ok(!without.includes("test-suite"));
  // The other three checks are always present.
  for (const name of ["service-dependencies", "health", "workspace-health"]) {
    assert.ok(without.includes(name), `expected ${name} in the roster`);
  }
});

// --- toWorkOrder ------------------------------------------------------------

test("toWorkOrder maps a CheckResult into the lab work-order schema", () => {
  const result: CheckResult = {
    ok: false,
    title: "boom",
    problem: "it broke",
    severity: "critical",
    category: "bug",
  };
  const wo = toWorkOrder("WO-0042", "mycheck", result, OPTS, "2026-06-19T00:00:00.000Z");
  assert.equal(wo.id, "WO-0042");
  assert.equal(wo.title, "boom");
  assert.equal(wo.description, "it broke");
  assert.equal(wo.severity, "critical");
  assert.equal(wo.category, "bug");
  assert.equal(wo.status, "open");
  assert.equal(wo.source, "bug:mycheck");
});

test("toWorkOrder falls back to sane defaults when a check omits fields", () => {
  const wo = toWorkOrder("WO-0001", "bare", { ok: false }, OPTS, "2026-06-19T00:00:00.000Z");
  assert.equal(wo.severity, "medium");
  assert.equal(wo.category, "bug");
  assert.match(wo.title, /bare/);
});

// --- report health semantics (healthy vs handled) ---------------------------

test("runMonitor reports healthy:true/handled:true when every check passes", async () => {
  const { ports } = memPorts();
  const report = await runMonitor(OPTS, ports);
  assert.equal(report.healthy, true);
  assert.equal(report.handled, true);
});

test("runMonitor reports healthy:false but handled:true when a failure is de-duped", async () => {
  const existing = new Set<string>([sourceKey("health", { ok: false, category: "service-down" } as CheckResult)]);
  const { ports } = memPorts({
    healthProbe: async () => ({ ok: false, status: 0 }),
    openWorkOrderSources: async () => existing,
  });
  const report = await runMonitor(OPTS, ports);
  // A persistent, already-tracked failure must NOT read as all-green.
  assert.equal(report.healthy, false, "deduped failure means not healthy");
  assert.equal(report.handled, true, "the failure is still tracked by an open work order");
  // Back-compat: `ok` keeps its historical meaning (nothing new filed).
  assert.equal(report.ok, true);
});

test("runMonitor reports healthy:false when it files new work orders", async () => {
  const { ports } = memPorts({ healthProbe: async () => ({ ok: false, status: 0, detail: "down" }) });
  const report = await runMonitor(OPTS, ports);
  assert.equal(report.healthy, false);
  assert.equal(report.handled, true);
});

// --- Finding 3: queue-write resilience --------------------------------------

test("runMonitor records fileError and keeps going when a work-order write fails", async () => {
  const { ports } = memPorts({
    healthProbe: async () => ({ ok: false, status: 0, detail: "down" }),
    countStaleWorkspaces: async () => 50,
    writeWorkOrder: async () => {
      throw new Error("ENOSPC: no space left on device");
    },
  });
  const report = await runMonitor(OPTS, ports);
  // Both failing checks were attempted (the first write failure did not abort the pass).
  const failing = report.outcomes.filter((o) => !o.result.ok);
  assert.equal(failing.length, 2);
  assert.ok(failing.every((o) => o.fileError === true), "every un-fileable failure is flagged");
  assert.equal(report.filed.length, 0);
  assert.equal(report.healthy, false);
  assert.equal(report.handled, false, "un-filed failures are NOT handled");
});

test("runMonitor continues when reading open work orders throws", async () => {
  const { ports, written } = memPorts({
    healthProbe: async () => ({ ok: false, status: 0, detail: "down" }),
    openWorkOrderSources: async () => {
      throw new Error("EACCES: permission denied");
    },
  });
  const report = await runMonitor(OPTS, ports);
  // Without de-dup info we still file the failure rather than skipping the check.
  assert.equal(written.length, 1);
  assert.equal(report.healthy, false);
});

// --- Finding 1: test-command timeout ----------------------------------------

test("runTestCommand kills a hung command and reports it as a failure", async () => {
  // `sleep 30` would never finish within the test; the 250ms timeout must kill it.
  const r = await runTestCommand("sleep 30", process.cwd(), 250);
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not finish within 250ms/);
});

test("runTestCommand returns ok for a fast successful command", async () => {
  const r = await runTestCommand("true", process.cwd(), 5000);
  assert.equal(r.ok, true);
});
