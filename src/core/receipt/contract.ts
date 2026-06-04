/**
 * ikbi receipt store — lean OPERATIONAL log (contract).
 *
 * Receipts are attributed, ordered, durably-written operational records: what
 * happened, by which identity, with what outcome and what changed. They exist for
 * troubleshooting and for trust/memory to project over — they are retention-
 * bounded, disposable operational data, NOT a permanent cryptographic ledger.
 *
 * Properties:
 *   - ATTRIBUTED: every receipt snapshots the calling `AgentIdentity` (imported
 *     from the frozen provider contract — never redefined).
 *   - ORDERED: a monotonic `seq` plus the append-only log give a stable order.
 *   - DURABLE: written via the substrate `AtomicAppendLog` (no torn/lost lines).
 *     Durability follows `IKBI_FSYNC`: with fsync ENABLED, an appended receipt
 *     survives a hard crash; with fsync DISABLED (operator's call for a faster
 *     operational log), the most recent receipts may not survive a crash. This is
 *     a deliberate operator-controlled tradeoff — receipts are operational data,
 *     so fsync is not forced.
 *   - APPEND-ONLY in normal operation: no mutate/update API. The ONLY deletion
 *     path is time-based retention (`prune`), which wholesale hard-deletes aged
 *     receipts. Corrections are new receipts (`corrects`).
 *
 * DELIBERATE OMISSION — tamper-evidence. ikbi is a single-operator local engine
 * and receipts are retention-bounded operational data, so there is intentionally
 * NO hash chain / keyed MAC / head anchor / verify(). An on-host actor that can
 * write the log can edit it; that is acceptable for this trust model.
 *   Re-attach point (if ikbi ever becomes multi-tenant / network-exposed / a
 *   compliance ledger): make each receipt carry prevHash + a keyed-MAC `hash`
 *   (HMAC with a key kept OUT of the log dir), store a separate head anchor to
 *   catch end-truncation, add `verify()` for chain integrity, and FAIL-CLOSED on
 *   a missing key. That is a deliberate future upgrade, not a default here.
 *
 * Receipts ARE the durable operational record (on disk via the append log).
 * `log.ts` is ephemeral telemetry — kept distinct.
 */

import type { AgentIdentity } from "../provider/contract.js";

/** Semantic version of the receipt contract. Bump on breaking change. */
export const RECEIPT_CONTRACT_VERSION = "1.0.0";

/** Outcome of the recorded operation. */
export interface ReceiptOutcome {
  readonly status: "success" | "failure" | "partial" | "rejected";
  /** Human-readable detail. */
  readonly detail?: string;
  /** Error message, when status is failure/rejected. */
  readonly error?: string;
  /** Stable error/result code for querying. */
  readonly code?: string;
}

/**
 * A reference to a piece of state before/after a change — the data UNDO needs.
 * `ref` points at a snapshot/blob the undo mechanism can restore; `hash` lets undo
 * verify it is restoring the expected prior state.
 */
export interface StateRef {
  /** Did the target exist beforehand? (distinguishes "create" from "modify".) */
  readonly existed?: boolean;
  /** Content hash of the state at this point (integrity for undo). */
  readonly hash?: string;
  /** Opaque snapshot/blob reference the undo mechanism can restore. */
  readonly ref?: string;
  /** Optional size in bytes. */
  readonly bytes?: number;
}

/** The inverse operation that would undo a change (info only; undo is a later module). */
export interface InverseOp {
  readonly operation: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * THE REVERSIBILITY HOOK. One change a receipt records, in enough detail for the
 * (later) undo module to reverse it without forcing a contract change. Multi-file
 * operations record one entry per affected target in `Receipt.changes`; a
 * partial failure records ONLY the changes that were actually applied. This phase
 * SHAPES the hook and records the data; undo is a later module.
 *
 * Deferred optional additions (documented, non-breaking when added): a
 * `rollbackOrder` hint and an `atomic` group flag.
 */
export interface ReceiptChange {
  /** What kind of thing changed. */
  readonly kind: "file" | "state" | "exec" | "network" | "config" | "other";
  /** The resource that changed (path / store key / resource id). */
  readonly target: string;
  /** Short human summary of the change. */
  readonly summary?: string;
  /** Prior state (for restore + integrity check). */
  readonly before?: StateRef;
  /** Resulting state. */
  readonly after?: StateRef;
  /** Inverse-operation info undo can use. */
  readonly inverse?: InverseOp;
}

/** What a caller provides to record a receipt. The store assigns id/seq/timestamp. */
export interface ReceiptInput {
  /** The kind of action (e.g. "model.invoke", "file.write", "build.run"). */
  readonly operation: string;
  /** A bounded summary of the request/inputs (NOT secrets/raw untrusted blobs). */
  readonly requestSummary?: Readonly<Record<string, unknown>>;
  readonly outcome: ReceiptOutcome;
  /** What changed — the reversibility hook. Empty for read-only operations. */
  readonly changes?: readonly ReceiptChange[];
  /** Free-form correlation metadata (never secrets). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Correlation id tying this to a request/operation context. */
  readonly requestId?: string;
  /**
   * Project/workspace this operation belongs to. The canonical field learned
   * memory + trust filter by (same pattern as AgentIdentity.spawnedFrom).
   */
  readonly project?: string;
  /** If this receipt corrects an earlier one, its receipt id (append-only correction). */
  readonly corrects?: string;
}

/** An immutable, attributed, ordered operational record. */
export interface Receipt {
  readonly contractVersion: string;
  /** Globally unique receipt id. */
  readonly id: string;
  /** Monotonic sequence number (0-based) — stable ordering for troubleshooting. */
  readonly seq: number;
  /** Creation time (ms epoch). */
  readonly timestamp: number;
  /** WHO did this — snapshot of the validated calling identity. */
  readonly identity: AgentIdentity;
  readonly operation: string;
  readonly requestSummary?: Readonly<Record<string, unknown>>;
  readonly outcome: ReceiptOutcome;
  /** The reversibility hook (always present; empty for read-only ops). */
  readonly changes: readonly ReceiptChange[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
  readonly project?: string;
  readonly corrects?: string;
}

// ---------------------------------------------------------------------------
// Query (the read surface; the trust + memory read-seam)
// ---------------------------------------------------------------------------

/** Filter for querying receipts. All clauses AND together. */
export interface ReceiptQuery {
  /** Only receipts attributed to this agent id. */
  readonly agentId?: string;
  /** Only receipts tagged with this project. */
  readonly project?: string;
  /** Only this operation kind. */
  readonly operation?: string;
  /** Only this outcome status. */
  readonly status?: ReceiptOutcome["status"];
  /** Inclusive lower/upper time bounds (ms epoch). */
  readonly fromTime?: number;
  readonly toTime?: number;
  /** Inclusive lower/upper sequence bounds. */
  readonly fromSeq?: number;
  readonly toSeq?: number;
  /** Cap the number of results (most-recent-last ordering preserved). */
  readonly limit?: number;
}

/**
 * Summary of an agent's receipt history — the seam the TRUST + MEMORY systems
 * read. The trust LOGIC is a later phase; this is the read surface it uses.
 * Deferred (non-breaking) future additions: per-operation outcome breakdown and
 * time-windowed summaries.
 */
export interface AgentReceiptSummary {
  readonly agentId: string;
  readonly total: number;
  readonly byStatus: Readonly<Record<ReceiptOutcome["status"], number>>;
  readonly operations: Readonly<Record<string, number>>;
  readonly firstSeq?: number;
  readonly lastSeq?: number;
  readonly firstTimestamp?: number;
  readonly lastTimestamp?: number;
}

/** Result of a retention prune (wholesale hard-delete of aged receipts). */
export interface PruneResult {
  readonly removed: number;
  readonly kept: number;
}

/** A typed receipt-store failure. */
export class ReceiptError extends Error {
  readonly kind: "append_failed" | "read_failed" | "config" | "invalid_input";
  constructor(kind: ReceiptError["kind"], message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ReceiptError";
    this.kind = kind;
  }
}
