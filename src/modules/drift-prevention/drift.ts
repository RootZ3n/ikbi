/**
 * ikbi drift-prevention — the success-rate drift detector WITH a graduated intervention.
 *
 * READS the durable baseline (lab-context-memory "pattern" entries) + the recent rate
 * (a receipts window) and computes drift with PURE math — no model call, deterministic.
 * It still WRITES nothing (no trust demotion, no agent pause, no gate). What it now DOES
 * on a detected drift is governed by the `DriftPolicy` seam, selected by config:
 *   - reportOnly (DEFAULT) — emit the event + return the report; take no action ("none").
 *   - warn                 — additionally log the drift via the structured logger, then continue ("warned").
 *   - block                — throw a DriftBlockedError carrying the drifted reports ("blocked").
 * The default is reportOnly, so existing read-only callers are unaffected; warn/block are
 * the operator's deliberate opt-in via IKBI_DRIFT_PREVENTION_POLICY.
 */

import { log } from "../../core/log.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import { labMemory as coreLabMemory } from "../lab-context-memory/index.js";
import type { MemoryEntry, MemoryKind } from "../lab-context-memory/index.js";
import { driftPreventionConfig, type DriftPolicyName, type DriftPreventionConfig } from "./config.js";
import { driftChecked, driftDetected } from "./events.js";
import { DriftBlockedError, type DriftActionTaken, type DriftCheckOptions, type DriftPolicy, type DriftPrevention, type DriftReport, type DriftSeverity } from "./contract.js";

const EVENT_SOURCE = "drift-prevention";

/** The default policy: report only — never act (emit + return; action "none"). */
export const reportOnly: DriftPolicy = () => ({ act: false });

/** WARN policy: log a warning and continue (action "warned"). */
export const warnPolicy: DriftPolicy = (report) => ({ act: true, kind: "warn", note: `drift on ${report.agent}/${report.operation}` });

/** BLOCK policy: signal that check() must throw a DriftBlockedError (action "blocked"). */
export const blockPolicy: DriftPolicy = (report) => ({ act: true, kind: "block", note: `drift on ${report.agent}/${report.operation}` });

/** Resolve the built-in policy function for a config policy name (default reportOnly). */
export function policyForName(name: DriftPolicyName | undefined): DriftPolicy {
  switch (name) {
    case "warn":
      return warnPolicy;
    case "block":
      return blockPolicy;
    default:
      return reportOnly;
  }
}

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
  // An explicitly injected policy wins (the test/advanced seam); otherwise the policy is
  // selected by the config name (default reportOnly).
  const policy = deps.policy ?? policyForName(config.policy);
  const publish = deps.publish ?? ((input: EventInput<unknown>) => void coreEvents.publish(input));

  function emit<P>(event: { create: (p: P, o?: { source?: string }) => EventInput<P> }, payload: P): void {
    publish(event.create(payload, { source: EVENT_SOURCE }));
  }

  async function check(opts: DriftCheckOptions): Promise<DriftReport[]> {
    if (!config.enabled) return [];

    // BASELINE: the agent's durable "pattern" entries (success/failure per operation).
    const patterns = await labMemory.byAgent(opts.agent, { kind: "pattern", ...(opts.project !== undefined ? { project: opts.project } : {}) });
    const reports: DriftReport[] = [];
    const blocked: DriftReport[] = []; // drifted reports the "block" policy wants to halt on

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

      let action: DriftActionTaken = "none";
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
        // INTERVENTION SEAM: ask the policy what to do, then ACT on its decision.
        //  - act:false (reportOnly)         → "none" (advisory).
        //  - act:true, kind "warn"          → log a warning, continue → "warned".
        //  - act:true, kind "block"         → mark for the post-loop throw → "blocked".
        //  - act:true, no kind (legacy)     → advisory only ("none"); never writes/throws.
        const decision = policy(report);
        if (decision.act && decision.kind === "warn") {
          log.warn(
            { agent: report.agent, operation: report.operation, reason: report.reason, ...(decision.note !== undefined ? { note: decision.note } : {}) },
            "drift: warned",
          );
          action = "warned";
        } else if (decision.act && decision.kind === "block") {
          action = "blocked";
        }
      }

      const finalReport: DriftReport = { ...report, action };
      reports.push(finalReport);
      if (action === "blocked") blocked.push(finalReport);
    }

    emit(driftChecked, { agent: opts.agent, operationCount: reports.length });
    // BLOCK intervention: a detected drift under the "block" policy HALTS the caller with a
    // typed error carrying the offending reports (after the event is emitted, so it is audited).
    if (blocked.length > 0) throw new DriftBlockedError(blocked);
    return reports;
  }

  return { check };
}

/** The default process-wide drift detector (read singletons + reportOnly). */
export const driftPrevention: DriftPrevention = createDriftPrevention();
