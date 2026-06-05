/**
 * ikbi drift-prevention — THE MODULE CONTRACT (versioned).
 *
 * The cheap-model-reliability watchdog OVER TIME. The competitive build proves a model
 * is good ENOUGH right now (a test suite picks the winner); drift-prevention is the
 * longer-horizon companion — it watches success rates and catches when a model/agent
 * that WAS reliable starts degrading. Judge = trust now; drift = trust over time.
 *
 * For an (agent, operation[, project]) it reads the durable BASELINE pass-rate
 * (lab-context-memory "pattern" entries) and the RECENT rate (a receipts window) and
 * FLAGS drift when the recent rate drops past a threshold with enough samples. The
 * detection is PURE deterministic math — no model call, reproducible.
 *
 * v1 IS DETECT-AND-REPORT ONLY: it emits a drift signal/event and returns reports. It
 * takes NO action — no trust demotion, no agent pause, no gate, no promote block. It
 * READS lab-memory + receipts and writes/mutates NEITHER. Intervention is a
 * replaceable `DriftPolicy` SEAM (default `reportOnly`) so "demote on major drift" can
 * layer on later WITHOUT restructuring — mirroring batch-planner's conflict-policy seam.
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial drift-prevention contract: DriftReport (baseline vs recent pass
 *           rate, drop, severity) + the report-only DriftPolicy seam. Detect-and-report.
 */

/** Semantic version of the drift-prevention contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** Drift severity bands (by the size of the drop). */
export type DriftSeverity = "minor" | "major";

/** A baseline-vs-recent success-rate comparison for one (agent, operation[, project]). */
export interface DriftReport {
  readonly agent: string;
  readonly operation: string;
  readonly project?: string;
  /** Established historical pass rate (from the durable pattern entry), in [0,1]. */
  readonly baselineRate: number;
  /** Recent pass rate (from the receipts window), in [0,1]. */
  readonly recentRate: number;
  /** baselineRate − recentRate (a DROP; negative means recent improved). */
  readonly drop: number;
  /** How many recent outcomes the recent rate is over (the window's actual size). */
  readonly sampleSize: number;
  /** True when the drop exceeds the threshold AND there are enough samples. */
  readonly drifted: boolean;
  /** Severity (only when drifted). */
  readonly severity?: DriftSeverity;
  /** Human/audit reason. */
  readonly reason: string;
}

/** What an intervention policy decides for a drifted report. v1 acts on nothing. */
export interface DriftAction {
  /** Whether a (future) intervention layer should act. v1 reportOnly ⇒ false. */
  readonly act: boolean;
  readonly note?: string;
}

/**
 * The intervention SEAM. Given a drift report, decide whether to act. v1's default
 * is report-only (never act); a future policy (e.g. demote-on-major) swaps in here
 * without restructuring. The policy is ADVISORY in v1 — drift-prevention has no action
 * surface, so even `act:true` triggers nothing until an intervention layer is wired.
 */
export type DriftPolicy = (report: DriftReport) => DriftAction;

/** Options for a drift check: an agent, optionally narrowed to one operation/project. */
export interface DriftCheckOptions {
  readonly agent: string;
  readonly operation?: string;
  readonly project?: string;
}

/** The drift-prevention surface (detect-and-report; reads only). */
export interface DriftPrevention {
  /** Compute baseline-vs-recent drift for the agent's operations. Returns one report each. */
  check(opts: DriftCheckOptions): Promise<DriftReport[]>;
}
