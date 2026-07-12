/**
 * ikbi worker-model — COMPOSITE OPERATION LEDGER (Phase 14B).
 *
 * A single worker `orchestrator.run` has its own `InvocationLedger` (Phase 11/14). But several USER-facing
 * operations span MULTIPLE runs — a conditional duel (primary run + a peer run), a multi-step build (a run
 * per step + a finalizer run), a tournament/competitive selection, and a CLI command that runs cognition/
 * planning + worker execution. The re-audit (IKBI-REAUDIT2-004) found these composite totals incomplete: the
 * CLI surfaced only the CHOSEN/FINAL child run's cost, dropping the losing peer, the intermediate steps, and
 * the planning spend.
 *
 * This module is the PARENT authority. It aggregates child runs by the UNION of UNIQUE provider-attempt IDs
 * (so overlapping/shared ledgers are never double-counted, and disjoint child runs are all included). Losing,
 * failed, and unknown-cost work is included; the final selected child never erases the cost history. It is
 * PURE — the CLI/orchestrator register child summaries; it never dispatches a provider.
 *
 *   > A composite operation's cost = the sum over UNIQUE provider-attempt ids across every child run
 *   > (winning, losing, failed, retried, planning), each counted exactly once; partial if any is unknown.
 */

/** The role a child run plays inside a composite operation (kept distinct — child identity is never merged). */
export type ChildRunRole =
  | "primary" | "peer" | "tournament-candidate" | "competitive-candidate" | "evaluator"
  | "step" | "finalizer" | "repair" | "cognition" | "planning" | "worker";

/** A compact projection of one provider attempt a child run exposes for composite aggregation. */
export interface CompositeProviderAttempt {
  readonly providerAttemptId: string;
  readonly costUsd?: number;
  readonly costStatus: "measured" | "measured-zero" | "unavailable";
}

export interface CompositeChildInput {
  readonly childId: string;
  readonly strategy: string;
  readonly role: ChildRunRole;
  readonly outcome: string;
  /** True for the final selected/winning child — but its selection NEVER removes other children's cost. */
  readonly selected?: boolean;
  readonly providerAttempts: readonly CompositeProviderAttempt[];
}

export interface CompositeChildRecord extends CompositeChildInput {
  readonly registeredOrdinal: number;
}

export interface CompositeCost {
  readonly usd: number;
  readonly status: "complete" | "partial";
  readonly uniqueProviderAttempts: number;
  readonly unknownCostAttempts: number;
}

/**
 * The parent composite operation. `compositeOperationId` + `sourceId` (CLI/session/task) + `strategy` identify
 * it; child runs register their provider-attempt projections; totals derive from the UNION of unique attempt
 * ids across all children (winning + losing + failed + planning).
 */
export class CompositeOperationLedger {
  private ordinal = 0;
  private readonly children: CompositeChildRecord[] = [];

  constructor(
    readonly compositeOperationId: string,
    readonly sourceId: string,
    readonly strategy: string,
  ) {}

  /** Register a child run's provider-attempt projection. A child is included regardless of win/lose/fail. */
  registerChild(input: CompositeChildInput): CompositeChildRecord {
    const rec: CompositeChildRecord = { ...input, registeredOrdinal: ++this.ordinal };
    this.children.push(rec);
    return rec;
  }

  childRuns(): readonly CompositeChildRecord[] { return this.children; }
  childRunsWithRole(role: ChildRunRole): readonly CompositeChildRecord[] { return this.children.filter((c) => c.role === role); }
  selectedChild(): CompositeChildRecord | undefined { return this.children.find((c) => c.selected === true); }

  /** The UNION of unique provider-attempt ids across every child (dispatch order, de-duplicated). */
  providerAttemptIds(): readonly string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const c of this.children) for (const a of c.providerAttempts) if (!seen.has(a.providerAttemptId)) { seen.add(a.providerAttemptId); ids.push(a.providerAttemptId); }
    return ids;
  }

  /**
   * Composite cost from UNIQUE provider attempts. A provider-attempt id seen in more than one child (a shared
   * ledger) is counted ONCE. An `unavailable`-cost attempt makes the composite status `partial` (never an exact
   * remaining-budget claim). Losing/failed children are always included; the selected child never replaces this.
   */
  compositeCost(): CompositeCost {
    const byId = new Map<string, CompositeProviderAttempt>();
    for (const c of this.children) for (const a of c.providerAttempts) if (!byId.has(a.providerAttemptId)) byId.set(a.providerAttemptId, a);
    let usd = 0, unknown = 0;
    for (const a of byId.values()) {
      if (a.costStatus === "unavailable") unknown += 1;
      else usd += a.costUsd ?? 0;
    }
    return { usd, status: unknown > 0 ? "partial" : "complete", uniqueProviderAttempts: byId.size, unknownCostAttempts: unknown };
  }

  /** A durable audit projection of the whole composite operation (for a receipt / CLI summary). */
  summary(): {
    compositeOperationId: string; sourceId: string; strategy: string;
    childRuns: readonly { childId: string; role: ChildRunRole; strategy: string; outcome: string; selected: boolean; providerAttemptCount: number }[];
    cost: CompositeCost;
    selectedChildId?: string;
  } {
    const cost = this.compositeCost();
    const selected = this.selectedChild();
    return {
      compositeOperationId: this.compositeOperationId, sourceId: this.sourceId, strategy: this.strategy,
      childRuns: this.children.map((c) => ({ childId: c.childId, role: c.role, strategy: c.strategy, outcome: c.outcome, selected: c.selected === true, providerAttemptCount: c.providerAttempts.length })),
      cost,
      ...(selected !== undefined ? { selectedChildId: selected.childId } : {}),
    };
  }
}
