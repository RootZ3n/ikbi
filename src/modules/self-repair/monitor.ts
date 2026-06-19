/**
 * ikbi self-repair — the monitor: cheap, read-only health checks that file WORK ORDERS.
 *
 * ikbi watches ITSELF. Each check (`MonitorCheck`) is pure over an injected context
 * (`{ ports, opts }`) and returns a structured `CheckResult`. The runner (`runMonitor`)
 * executes the checks, and for every TRIPPED check mints exactly one `open` work order
 * into the shared queue — de-duped by a stable `source` key so a persistent failure
 * never floods the queue across repeated passes.
 *
 * Live I/O (network probe, child process, filesystem, clock) lives ONLY in
 * `liveMonitorPorts()`. The health probe uses node:http (NOT global fetch) so it does
 * not traverse the egress SSRF guard — a localhost loopback check is not egress.
 */

import { spawn } from "node:child_process";
import { constants as FS } from "node:fs";
import { access, mkdir, readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { childLogger } from "../../core/log.js";
import { atomicWriteJson, locks } from "../../core/substrate/index.js";
import { workspaces as coreWorkspaces } from "../../core/workspace/index.js";
import { monitorOptions, selfRepairConfig } from "./config.js";
import type {
  CheckOutcome,
  CheckResult,
  HealthProbeResult,
  MonitorCheck,
  MonitorContext,
  MonitorOptions,
  MonitorPorts,
  MonitorReport,
  TestRunResult,
  WorkOrder,
} from "./contract.js";

const log = childLogger("self-repair");

const OK = "✓";
const BAD = "✗";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ═══════════════════════════════════════════════════════════════════════════
// THE CHECKS — each pure over its context; each `ok:false` carries everything a
// work order needs (title / problem / severity / category).
// ═══════════════════════════════════════════════════════════════════════════

/** 1. Health — can ikbi reach its OWN /health endpoint and is the service responsive? */
export const healthCheck: MonitorCheck = {
  name: "health",
  description: "ikbi can reach its own /health endpoint",
  async run({ ports, opts }: MonitorContext): Promise<CheckResult> {
    const probe = await ports.healthProbe(opts.healthUrl);
    if (probe.ok) return { ok: true };
    return {
      ok: false,
      title: "ikbi service unreachable",
      problem:
        `Health probe to ${opts.healthUrl} did not return a healthy response` +
        `${probe.status !== undefined ? ` (HTTP ${probe.status})` : ""}` +
        `${probe.detail ? `: ${probe.detail}` : ""}. ` +
        "The long-running service is down or unresponsive; restart it and check the logs.",
      severity: "high",
      category: "service-down",
    };
  },
};

/** Parse a node:test / pnpm-test tail for a failing-test count (best effort). */
export function parseTestFailures(detail: string): number | undefined {
  // node:test summary line, e.g. "# fail 3"
  const nodeFail = /# fail (\d+)/.exec(detail);
  if (nodeFail) return Number(nodeFail[1]);
  // generic "N failing"
  const generic = /(\d+)\s+failing/.exec(detail);
  if (generic) return Number(generic[1]);
  return undefined;
}

/** 2. Test suite — do all tests pass? (The slow check; gated by `opts.runTestSuite`.) */
export const testSuiteCheck: MonitorCheck = {
  name: "test-suite",
  description: "the test suite passes",
  async run({ ports, opts }: MonitorContext): Promise<CheckResult> {
    const r = await ports.runTests(opts.testCommand, opts.repoRoot);
    if (r.ok) return { ok: true };
    const count = r.failures ?? parseTestFailures(r.detail);
    return {
      ok: false,
      title: count !== undefined ? `${count} test(s) failing` : "test suite is failing",
      problem:
        `\`${opts.testCommand}\` (in ${opts.repoRoot}) did not pass` +
        `${count !== undefined ? ` — ${count} failing` : ""}. ` +
        `Tail:\n${r.detail || "(no output captured)"}`,
      severity: "high",
      category: "test-failure",
    };
  },
};

/** 3. Disk/workspace health — are stale workspaces / temp files piling up? */
export const workspaceHealthCheck: MonitorCheck = {
  name: "workspace-health",
  description: "no excess of stale workspaces / temp files",
  async run({ ports, opts }: MonitorContext): Promise<CheckResult> {
    const stale = await ports.countStaleWorkspaces();
    if (stale < opts.staleThreshold) return { ok: true };
    return {
      ok: false,
      title: `${stale} stale workspace(s) need reclaiming`,
      problem:
        `${stale} terminal-but-unreclaimed workspaces are on disk (threshold ${opts.staleThreshold}). ` +
        "Reclaim them with `ikbi doctor --fix --force` or `ikbi clean`.",
      severity: "low",
      category: "maintenance",
    };
  },
};

/** 4. Service dependencies — required env vars set, and the state root writable? */
export const serviceDependenciesCheck: MonitorCheck = {
  name: "service-dependencies",
  description: "required env vars are set and the state root is writable",
  async run({ ports, opts }: MonitorContext): Promise<CheckResult> {
    const missing = opts.requiredEnv.filter((name) => {
      const v = ports.envGet(name);
      return v === undefined || v.trim().length === 0;
    });
    const writable = await ports.isWritable(opts.stateRoot);
    if (missing.length === 0 && writable) return { ok: true };

    const problems: string[] = [];
    if (missing.length > 0) problems.push(`missing required env var(s): ${missing.join(", ")}`);
    if (!writable) problems.push(`state root is not writable: ${opts.stateRoot}`);
    // A non-writable state root is fatal (nothing can persist); missing identity tokens
    // block builds but the service can still report. Pick the worse severity.
    const severity = !writable ? "critical" : "high";
    return {
      ok: false,
      title: !writable ? "ikbi state root is not writable" : "ikbi service dependencies missing",
      problem:
        `ikbi cannot operate normally: ${problems.join("; ")}. ` +
        "Set the missing variables (secrets belong in ~/.ikbi/env) and ensure the state root exists and is writable.",
      severity,
      category: "service-down",
    };
  },
};

/** The default monitor check roster, in report order (cheap → expensive). */
export function defaultChecks(opts: MonitorOptions): MonitorCheck[] {
  const checks: MonitorCheck[] = [serviceDependenciesCheck, healthCheck, workspaceHealthCheck];
  // The test suite is the slow check — included only when enabled.
  if (opts.runTestSuite) checks.splice(1, 0, testSuiteCheck);
  return checks;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE RUNNER — execute the checks; file one de-duped work order per failure.
// ═══════════════════════════════════════════════════════════════════════════

/** The de-dup key for a failure: `category:check-name`. Stable across passes. */
export function sourceKey(checkName: string, result: CheckResult): string {
  return `${result.category ?? "bug"}:${checkName}`;
}

/** Build a work order from a tripped check (pure — id/time supplied by the runner). */
export function toWorkOrder(
  id: string,
  checkName: string,
  result: CheckResult,
  opts: MonitorOptions,
  createdAt: string,
): WorkOrder {
  return {
    id,
    title: result.title ?? `ikbi self-check failed: ${checkName}`,
    description: result.problem ?? `The ${checkName} self-check failed.`,
    severity: result.severity ?? "medium",
    category: result.category ?? "bug",
    status: "open",
    repos: [...opts.repos],
    createdAt,
    notes: [],
    resolution: null,
    source: sourceKey(checkName, result),
  };
}

/**
 * Run a full monitor pass. For each tripped check it files exactly one `open` work
 * order — UNLESS an open work order with the same `source` already exists (de-dup),
 * in which case it records the outcome but files nothing. Never throws: a check that
 * itself errors is converted to a `bug` failure so the pass always completes.
 */
export async function runMonitor(
  opts: MonitorOptions,
  ports: MonitorPorts,
  checks: readonly MonitorCheck[] = defaultChecks(opts),
): Promise<MonitorReport> {
  const ctx: MonitorContext = { ports, opts };
  // Reading the existing queue must never abort the pass — a failure here just means we
  // can't de-dup (we may re-file), which is strictly safer than skipping checks entirely.
  let openSources: ReadonlySet<string>;
  try {
    openSources = await ports.openWorkOrderSources();
  } catch (err) {
    openSources = new Set<string>();
    log.error({ err: errMsg(err) }, "self-repair: could not read open work orders; continuing without de-dup");
  }
  const seenThisPass = new Set<string>();
  const outcomes: CheckOutcome[] = [];
  const filed: string[] = [];
  const lines: string[] = [];

  for (const check of checks) {
    let result: CheckResult;
    try {
      result = await check.run(ctx);
    } catch (err) {
      // A check should never throw (ports are total), but if it does, treat the
      // checker itself as the bug rather than aborting the whole pass.
      result = {
        ok: false,
        title: `self-check "${check.name}" errored`,
        problem: `The ${check.name} check threw: ${errMsg(err)}`,
        severity: "medium",
        category: "bug",
      };
    }

    if (result.ok) {
      outcomes.push({ name: check.name, result });
      lines.push(`  ${OK} ${check.name} — ${check.description}`);
      continue;
    }

    const source = sourceKey(check.name, result);
    if (openSources.has(source) || seenThisPass.has(source)) {
      outcomes.push({ name: check.name, result, deduped: true });
      lines.push(`  ${BAD} ${check.name} — ${result.title} (open work order exists; not re-filed)`);
      continue;
    }

    seenThisPass.add(source);
    // Filing must never abort the pass: a queue write that fails (disk full, permission
    // denied) is logged and the failure recorded as UNTRACKED (`fileError`) so we move on
    // to the remaining checks instead of losing them.
    try {
      const id = await ports.nextWorkOrderId();
      const order = toWorkOrder(id, check.name, result, opts, ports.now());
      await ports.writeWorkOrder(order);
      filed.push(id);
      outcomes.push({ name: check.name, result, workOrderId: id });
      lines.push(`  ${BAD} ${check.name} — ${result.title} → filed ${id} [${result.severity}]`);
    } catch (err) {
      // The failure is real but we could not persist a work order for it.
      seenThisPass.delete(source);
      outcomes.push({ name: check.name, result, fileError: true });
      log.error(
        { check: check.name, err: errMsg(err) },
        "self-repair: failed to file work order; continuing",
      );
      lines.push(`  ${BAD} ${check.name} — ${result.title} (could NOT file work order: ${errMsg(err)})`);
    }
  }

  // healthy = every check passed. handled = every failure is covered by a work order
  // (freshly filed or already-open/de-duped) — a `fileError` outcome is NOT handled.
  const healthy = outcomes.every((o) => o.result.ok);
  const handled = outcomes.every((o) => o.result.ok || o.deduped || o.workOrderId !== undefined);
  // `ok` keeps its historical meaning: nothing new filed and nothing slipped through.
  const ok = filed.length === 0 && outcomes.every((o) => o.result.ok || o.deduped);
  return { ok, healthy, handled, outcomes, filed, lines };
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE PORTS — the production wiring. The ONLY place real I/O happens.
// ═══════════════════════════════════════════════════════════════════════════

const WO_FILE_RE = /^WO-(\d+)\.json$/;

/** Probe a health endpoint over node:http (loopback — deliberately NOT global fetch). */
function probeHealth(url: string, timeoutMs = 3000): Promise<HealthProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: HealthProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const req = httpRequest(url, { method: "GET", timeout: timeoutMs }, (res) => {
        const status = res.statusCode ?? 0;
        // Drain the body so the socket frees (we only care about the status).
        res.resume();
        done({ ok: status >= 200 && status < 300, status });
      });
      req.on("timeout", () => {
        req.destroy();
        done({ ok: false, detail: `timed out after ${timeoutMs}ms` });
      });
      req.on("error", (e) => done({ ok: false, detail: e.message }));
      req.end();
    } catch (err) {
      done({ ok: false, detail: errMsg(err) });
    }
  });
}

/**
 * Spawn the test command, resolving ok + a short (last-lines) detail. Never rejects.
 *
 * A stuck or hung test command must not hang the whole self-repair pass, so the child is
 * killed after `timeoutMs` (SIGTERM, then SIGKILL) and the result is reported as a
 * test-failure with a timeout note — the caller (`testSuiteCheck`) files a `test-failure`
 * work order from any `ok:false`, so a timeout becomes a tracked failure like any other.
 */
export function runTestCommand(command: string, cwd: string, timeoutMs: number): Promise<TestRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: TestRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Run through a shell so `pnpm test` (with args) works as configured.
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    let timedOut = false;
    const onData = (d: Buffer): void => {
      tail = (tail + d.toString()).slice(-4000);
    };
    // Kill a wedged test command rather than waiting on it forever.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate to SIGKILL if it ignores SIGTERM (e.g. a shell that traps it).
      setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => done({ ok: false, detail: e.message }));
    child.on("close", (code) => {
      if (timedOut) {
        const recent = tail.trim().split("\n").slice(-10).join("\n");
        done({
          ok: false,
          detail:
            `\`${command}\` did not finish within ${timeoutMs}ms and was killed ` +
            `(possible hang / wedged test). Last output:\n${recent || "(no output captured)"}`,
        });
        return;
      }
      const detail = tail.trim().split("\n").slice(-12).join("\n");
      const failures = parseTestFailures(tail);
      done(failures !== undefined ? { ok: code === 0, detail, failures } : { ok: code === 0, detail });
    });
  });
}

/** Count stale (terminal, on-disk, not-yet-reclaimed) workspaces. */
async function countStale(): Promise<number> {
  const records = await coreWorkspaces.list();
  return records.filter(
    (r) =>
      (r.state === "promoted" || r.state === "discarded" || r.state === "failed") &&
      r.cleanedAt === undefined,
  ).length;
}

/** Scan the queue dir for `WO-NNNN.json`; return the highest N (0 if none/missing). */
async function maxWorkOrderNumber(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // dir does not exist yet
  }
  let max = 0;
  for (const name of names) {
    const m = WO_FILE_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Read the `source` keys of every OPEN work order in the queue (for de-dup). */
async function readOpenSources(dir: string): Promise<ReadonlySet<string>> {
  const sources = new Set<string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return sources;
  }
  const { readFile } = await import("node:fs/promises");
  for (const name of names) {
    if (!WO_FILE_RE.test(name)) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const wo = JSON.parse(raw) as Partial<WorkOrder>;
      if (wo.status === "open") {
        // Prefer the explicit source key; fall back to category:title for legacy orders.
        sources.add(wo.source ?? `${wo.category ?? "bug"}:${wo.title ?? name}`);
      }
    } catch {
      // A malformed work order is skipped (it cannot match a de-dup key anyway).
    }
  }
  return sources;
}

/** Wire the production monitor ports (real network / process / filesystem / clock). */
export function liveMonitorPorts(workOrderDir: string = selfRepairConfig.workOrderDir): MonitorPorts {
  return {
    healthProbe: (url) => probeHealth(url),
    runTests: (command, cwd) => runTestCommand(command, cwd, selfRepairConfig.testTimeoutMs),
    countStaleWorkspaces: () => countStale(),
    envGet: (name) => process.env[name],
    isWritable: async (dir) => {
      try {
        await access(dir, FS.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    openWorkOrderSources: () => readOpenSources(workOrderDir),
    nextWorkOrderId: async () => {
      // Serialize id allocation + write across processes so two passes never collide.
      const next = (await maxWorkOrderNumber(workOrderDir)) + 1;
      return `WO-${String(next).padStart(4, "0")}`;
    },
    writeWorkOrder: async (order) => {
      await mkdir(workOrderDir, { recursive: true });
      await atomicWriteJson(join(workOrderDir, `${order.id}.json`), order);
    },
    now: () => new Date().toISOString(),
  };
}

/**
 * The operator entry point behind `ikbi doctor --self-repair`: run a full pass with
 * the live ports and return human-readable report lines + the report. Cross-process
 * locked so concurrent invocations can't race on `WO-NNNN` id allocation.
 */
export async function runSelfRepair(
  out: (s: string) => void = (s) => process.stdout.write(s),
): Promise<MonitorReport> {
  if (!selfRepairConfig.enabled) {
    out("self-repair is DISABLED (IKBI_SELF_REPAIR_ENABLED=false)\n");
    return { ok: true, healthy: true, handled: true, outcomes: [], filed: [], lines: [] };
  }
  const opts = monitorOptions();
  const ports = liveMonitorPorts(selfRepairConfig.workOrderDir);
  // The lock file lives in the queue dir — ensure it exists before acquiring the lock.
  // A failure to set up the queue dir must not crash `doctor`; degrade to an unlocked
  // pass (the live ports' writes will surface their own errors per-check via Finding 3).
  let report: MonitorReport;
  try {
    await mkdir(selfRepairConfig.workOrderDir, { recursive: true });
    report = await locks.withLock(
      "self-repair-work-orders",
      () => runMonitor(opts, ports),
      { file: join(selfRepairConfig.workOrderDir, ".self-repair.lock") },
    );
  } catch (err) {
    log.error(
      { dir: selfRepairConfig.workOrderDir, err: errMsg(err) },
      "self-repair: could not prepare the work-order queue / lock",
    );
    out(
      `self-repair could not prepare the work-order queue at ${selfRepairConfig.workOrderDir}: ` +
        `${errMsg(err)}\n` +
        "running an unlocked pass (concurrent passes may race on id allocation)\n\n",
    );
    report = await runMonitor(opts, ports);
  }
  out("ikbi self-repair — monitoring pass\n\n");
  out(`${report.lines.join("\n")}\n\n`);
  if (report.filed.length > 0) {
    out(`filed ${report.filed.length} work order(s): ${report.filed.join(", ")}\n`);
    out(`queue: ${selfRepairConfig.workOrderDir}\n`);
    log.warn({ filed: report.filed }, "self-repair filed work orders");
  }
  if (report.healthy) {
    out("all checks healthy — no work orders filed\n");
  } else if (report.handled) {
    out("problems found and tracked (open work orders exist) — NOT healthy\n");
  } else {
    out("problems found but some could NOT be filed (see log) — NOT healthy, NOT fully tracked\n");
  }
  return report;
}
