/**
 * ikbi self-repair — versioned PUBLIC SURFACE (the module's contract).
 *
 * The self-repair module is ikbi watching ITSELF: a set of cheap, read-only health
 * checks (service reachability, test suite, workspace hygiene, service dependencies)
 * that, when one trips, emit a durable WORK ORDER to a shared queue. A separate
 * mechanic (Ptah's `ptah-self-repair` skill) drains that queue and dispatches `ikbi fix`.
 *
 * Everything here is data + interfaces only — no behavior, no I/O. The runner and the
 * live ports live in `monitor.ts`; this file is what other code (and tests) import.
 */

/** Bump on any breaking change to a type exported from this file. */
export const CONTRACT_VERSION = "1.1.0";

/** Work-order severity, lowest → highest. Drives the mechanic's triage order. */
export type Severity = "low" | "medium" | "high" | "critical";

/** What KIND of problem a work order describes (maps to a repair playbook). */
export type WorkOrderCategory = "bug" | "test-failure" | "service-down" | "maintenance";

/** A work order's lifecycle state. The monitor only ever WRITES `open`. */
export type WorkOrderStatus = "open" | "assigned" | "in-progress" | "blocked" | "done" | "wontfix";

/** A free-form, timestamped note appended to a work order as it is worked. */
export interface WorkOrderNote {
  readonly at: string;
  readonly text: string;
}

/**
 * The shared work-order document — the contract between ikbi's self-monitor (writer)
 * and the mechanic (reader/updater). The shape is intentionally the lab-wide schema
 * (`WO-NNNN.json`); ikbi owns the `open`-creation half only.
 */
export interface WorkOrder {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: Severity;
  readonly category: WorkOrderCategory;
  readonly status: WorkOrderStatus;
  readonly repos: readonly string[];
  readonly createdAt: string;
  readonly notes: readonly WorkOrderNote[];
  readonly resolution: unknown | null;
  /**
   * Stable de-dup key (`category:slug`). Two runs of the same failing check produce
   * the SAME key so the monitor never files a duplicate while one is still open.
   */
  readonly source: string;
}

/**
 * The structured result of ONE monitor check. A healthy check returns `{ ok: true }`;
 * a tripped check returns `ok: false` plus the fields needed to mint a work order.
 */
export interface CheckResult {
  readonly ok: boolean;
  /** Short headline for the work order's `title` (required when `ok` is false). */
  readonly title?: string;
  /** Detailed problem description for the work order's `description`. */
  readonly problem?: string;
  readonly severity?: Severity;
  readonly category?: WorkOrderCategory;
}

/** What a check receives: the injectable ports plus the resolved options. */
export interface MonitorContext {
  readonly ports: MonitorPorts;
  readonly opts: MonitorOptions;
}

/** A single named health check. Pure over its context — no module-level I/O. */
export interface MonitorCheck {
  /** Stable identifier (kebab-case) — also forms the work-order de-dup `source`. */
  readonly name: string;
  /** Human-readable one-liner shown in the report. */
  readonly description: string;
  run(ctx: MonitorContext): Promise<CheckResult>;
}

/** One check's outcome inside a full monitor pass. */
export interface CheckOutcome {
  readonly name: string;
  readonly result: CheckResult;
  /** The work-order id filed for this failure (absent when healthy or de-duped). */
  readonly workOrderId?: string;
  /** True when a failure matched an already-open work order, so none was filed. */
  readonly deduped?: boolean;
  /**
   * True when a failure was detected but the work order could NOT be filed (queue write
   * failed — disk full, permission denied). The failure is real but UNTRACKED.
   */
  readonly fileError?: boolean;
}

/**
 * The result of a full `runMonitor` pass.
 *
 * Three distinct truths — do not conflate them:
 *  - `healthy`: every check actually PASSED. The only true all-green state.
 *  - `handled`: every detected failure is covered by an open work order (freshly filed
 *    OR already open / de-duped). A de-duped failure is `handled` but NOT `healthy` — so a
 *    persistent problem is never mistaken for green.
 *  - `ok`: backward-compatible alias — true iff nothing new was filed and every outcome is
 *    ok-or-deduped (i.e. `healthy` OR fully de-duped with no new filings).
 */
export interface MonitorReport {
  readonly ok: boolean;
  /** True iff every check passed (no failures at all). */
  readonly healthy: boolean;
  /** True iff every detected failure is tracked by an open work order (filed or de-duped). */
  readonly handled: boolean;
  readonly outcomes: readonly CheckOutcome[];
  readonly filed: readonly string[];
  /** One line per check, for human/operator (`doctor --self-repair`) output. */
  readonly lines: readonly string[];
}

/** Outcome of probing the health endpoint. */
export interface HealthProbeResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly detail?: string;
}

/** Outcome of running the test suite. */
export interface TestRunResult {
  readonly ok: boolean;
  /** Last-lines / summary detail to surface in the work order. */
  readonly detail: string;
  /** Number of failing tests, when parseable. */
  readonly failures?: number;
}

/**
 * The side-effecting PORTS the monitor drives. Every external interaction (network,
 * child process, filesystem, clock) is funneled through here so checks are unit-
 * testable with zero real I/O. `liveMonitorPorts()` wires the production versions.
 */
export interface MonitorPorts {
  /** Probe the ikbi health endpoint. Never throws — a down service resolves `ok:false`. */
  healthProbe(url: string): Promise<HealthProbeResult>;
  /** Run the test command in `cwd`. Never throws — a failure resolves `ok:false`. */
  runTests(command: string, cwd: string): Promise<TestRunResult>;
  /** Count stale workspaces / temp files needing cleanup (non-destructive). */
  countStaleWorkspaces(): Promise<number>;
  /** Read an environment variable (so dependency checks are injectable). */
  envGet(name: string): string | undefined;
  /** True iff `dir` exists and is writable (used for the state-root check). */
  isWritable(dir: string): Promise<boolean>;
  /** List the ids of existing OPEN work orders (for de-dup), by `source` key. */
  openWorkOrderSources(): Promise<ReadonlySet<string>>;
  /** Allocate the next `WO-NNNN` id (scans the queue for the current max). */
  nextWorkOrderId(): Promise<string>;
  /** Persist a work order atomically to the queue. */
  writeWorkOrder(order: WorkOrder): Promise<void>;
  /** Current time as an ISO-8601 string (injectable for deterministic tests). */
  now(): string;
}

/** Tunable knobs for a monitor pass (resolved from config; injectable in tests). */
export interface MonitorOptions {
  /** Health endpoint URL to probe. */
  readonly healthUrl: string;
  /** Test command (e.g. `pnpm test`). */
  readonly testCommand: string;
  /** Working directory for the test command (the ikbi repo root). */
  readonly repoRoot: string;
  /** Required env vars whose absence is a service-dependency failure. */
  readonly requiredEnv: readonly string[];
  /** State root that must be writable. */
  readonly stateRoot: string;
  /** Stale-workspace count at/above which a maintenance work order is filed. */
  readonly staleThreshold: number;
  /** Repos the filed work orders target. */
  readonly repos: readonly string[];
  /** When false, the test-suite check is skipped (it is the slow one). */
  readonly runTestSuite: boolean;
}
