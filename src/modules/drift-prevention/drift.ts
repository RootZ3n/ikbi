/**
 * ikbi drift-prevention — the success-rate drift detector (detect-and-report only).
 *
 * READS the durable baseline (lab-context-memory "pattern" entries) + the recent rate
 * (a receipts window) and computes drift with PURE math — no model call, deterministic.
 * It WRITES nothing and ACTS on nothing: no trust demotion, no agent pause, no gate.
 * Intervention is the `DriftPolicy` seam (default `reportOnly` — advisory, acts on
 * nothing in v1).
 */

import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import { labMemory as coreLabMemory } from "../lab-context-memory/index.js";
import type { MemoryEntry, MemoryKind } from "../lab-context-memory/index.js";
import { driftPreventionConfig, type DriftPreventionConfig } from "./config.js";
import { driftChecked, driftDetected } from "./events.js";
import type { DriftCheckOptions, DriftPolicy, DriftPrevention, DriftReport, DriftSeverity } from "./contract.js";

const EVENT_SOURCE = "drift-prevention";

/** The v1 default policy: report only — never act. The seam's no-op upgrade point. */
export const reportOnly: DriftPolicy = () => ({ act: false });

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * PURE drift math (reproducible — no clock, no randomness). Below the min sample size
 * it never flags (anti-noise). `drop` = baseline − recent; flag when drop ≥ threshold.
 */
export function computeDrift(
  config: DriftPreventionConfig,
  agent: string,
  operation: string,
  project: string | undefined,
  baselineRate: number,
  recentSuccesses: number,
  recentTotal: number,
): DriftReport {
  const recentRate = recentTotal > 0 ? recentSuccesses / recentTotal : 0;
  const drop = baselineRate - recentRate;
  const base = { agent, operation, ...(project !== undefined ? { project } : {}), baselineRate, recentRate, drop, sampleSize: recentTotal };

  if (recentTotal < config.minSampleSize) {
    return { ...base, drifted: false, reason: `insufficient recent samples (${recentTotal} < ${config.minSampleSize}) — not flagging on noise` };
  }
  if (drop < config.driftThreshold) {
    return { ...base, drifted: false, reason: "recent rate within tolerance of the baseline" };
  }
  const severity: DriftSeverity = drop >= config.driftThreshold * 2 ? "major" : "minor";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return { ...base, drifted: true, severity, reason: `recent ${pct(recentRate)} dropped ${Math.round(drop * 100)}pts below baseline ${pct(baselineRate)} (${severity})` };
}

/** Read-only lab-memory surface (pattern baselines). */
export interface LabMemoryReader {
  byAgent(agent: string, opts?: { project?: string; kind?: MemoryKind }): Promise<MemoryEntry[]>;
}
/** Read-only receipt surface (recent outcomes). */
export interface ReceiptReader {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

/** Injectable dependencies. ALL read-only — drift writes/acts on nothing. */
export interface DriftPreventionDeps {
  readonly config?: DriftPreventionConfig;
  readonly labMemory?: LabMemoryReader;
  readonly receipts?: ReceiptReader;
  /** The intervention seam. Default: reportOnly (v1 acts on nothing). */
  readonly policy?: DriftPolicy;
  readonly publish?: (input: EventInput<unknown>) => void;
}

/** Build a drift detector. Defaults wire the live read singletons + reportOnly policy. */
export function createDriftPrevention(deps: DriftPreventionDeps = {}): DriftPrevention {
  const config = deps.config ?? driftPreventionConfig;
  const labMemory: LabMemoryReader = deps.labMemory ?? coreLabMemory;
  const receipts: ReceiptReader = deps.receipts ?? (coreReceipts as ReceiptReader);
  const policy = deps.policy ?? reportOnly;
  const publish = deps.publish ?? ((input: EventInput<unknown>) => void coreEvents.publish(input));

  function emit<P>(event: { create: (p: P, o?: { source?: string }) => EventInput<P> }, payload: P): void {
    publish(event.create(payload, { source: EVENT_SOURCE }));
  }

  async function check(opts: DriftCheckOptions): Promise<DriftReport[]> {
    if (!config.enabled) return [];

    // BASELINE: the agent's durable "pattern" entries (success/failure per operation).
    const patterns = await labMemory.byAgent(opts.agent, { kind: "pattern", ...(opts.project !== undefined ? { project: opts.project } : {}) });
    const reports: DriftReport[] = [];

    for (const entry of patterns) {
      const v = entry.value as Record<string, unknown>;
      const operation = typeof v.operation === "string" && v.operation.length > 0 ? v.operation : entry.key.replace(/^op-/, "");
      if (opts.operation !== undefined && operation !== opts.operation) continue;
      const total = num(v.total);
      if (total <= 0) continue; // no baseline to compare against
      const baselineRate = num(v.successes) / total;

      // RECENT: the most-recent outcomes for this (agent, operation) from receipts.
      const recent = await receipts.query({ agentId: opts.agent, operation, ...(opts.project !== undefined ? { project: opts.project } : {}) });
      const windowed = recent.slice(-config.recentWindow);
      const recentTotal = windowed.length;
      const recentSuccesses = windowed.filter((r) => r.outcome.status === "success").length;

      const report = computeDrift(config, opts.agent, operation, opts.project, baselineRate, recentSuccesses, recentTotal);
      reports.push(report);

      if (report.drifted) {
        emit(driftDetected, {
          agent: report.agent,
          operation: report.operation,
          ...(report.project !== undefined ? { project: report.project } : {}),
          baselineRate: report.baselineRate,
          recentRate: report.recentRate,
          drop: report.drop,
          sampleSize: report.sampleSize,
          severity: report.severity ?? "minor",
        });
        // INTERVENTION SEAM (v1 reportOnly → act:false). Consulted, but drift-prevention
        // has NO action surface — even act:true triggers nothing until a future layer wires it.
        policy(report);
      }
    }

    emit(driftChecked, { agent: opts.agent, operationCount: reports.length });
    return reports;
  }

  return { check };
}

/** The default process-wide drift detector (read singletons + reportOnly). */
export const driftPrevention: DriftPrevention = createDriftPrevention();
