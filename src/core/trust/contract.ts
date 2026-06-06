/**
 * ikbi trust system — THE FROZEN CORE governance decision layer (contract).
 *
 * Every agent has a trust TIER that governs its autonomy (how many gates, whether
 * work is sandboxed, whether actions need approval). Tier is EARNED through
 * behavior over time and can be LOST. Decisions are made by the engine,
 * DETERMINISTIC + rule-based (never a model's judgment — governed, predictable,
 * cheap-model-safe), persisted durably by the trust system itself, and an agent
 * CANNOT self-escalate.
 *
 * This plugs into the Phase-3 `TrustTierResolver` seam (imported, never
 * redefined), reads receipts (Phase-5 read-seam, window-scoped) for recent
 * signals, and persists its own durable state on the substrate `DocumentStore`.
 *
 * Security posture (the threat is an agent escalating its own trust):
 *   - Tier comes from trust's DURABLE state keyed by the ATTRIBUTED agentId
 *     (which the agent cannot forge — Phase 3 identity is runtime-unforgeable).
 *   - The behavior signal (`recordOutcome`) is an ENGINE-internal call after a
 *     real operation completes — agents have no API to it and cannot inflate it.
 *   - The resolver re-clamps within the identity bounds: an agent can never reach
 *     `operator`; operator tier stays coupled to `kind: "operator"`. Even a forged
 *     durable state claiming `operator` is clamped down.
 *
 * IMPORTANT — earned trust survives receipt pruning: trust persists its OWN
 * accumulated assessment (NOT re-derived from ephemeral, retention-bounded
 * receipts). Receipts inform recent signals; the durable state is authoritative.
 */

import type { IdentityKind } from "../identity/contract.js";
import { isTrustTier, type TrustTier } from "../identity/contract.js";

/** Semantic version of the trust contract. Bump on breaking change. */
export const TRUST_CONTRACT_VERSION = "1.0.0";

/** The most trust an `agent`-kind caller can ever hold (operator is reserved for the operator). */
export const AGENT_CEILING: TrustTier = "trusted";
/** The least trust (demotion floor). An agent can fall to here and recover via good behavior. */
export const TRUST_FLOOR: TrustTier = "untrusted";
/** Cap on retained transition history per agent (keeps the durable doc bounded). */
export const MAX_TRANSITIONS = 100;

// Tier ordering: lower rank = MORE trust.
const BY_RANK: readonly TrustTier[] = ["operator", "trusted", "verified", "probation", "untrusted"];
const RANK: Readonly<Record<TrustTier, number>> = {
  operator: 0,
  trusted: 1,
  verified: 2,
  probation: 3,
  untrusted: 4,
};

function tierAt(rank: number): TrustTier {
  return BY_RANK[Math.max(0, Math.min(BY_RANK.length - 1, rank))] ?? "untrusted";
}

/** Numeric rank of a tier (lower = more trust). */
export function tierRank(t: TrustTier): number {
  return RANK[t];
}

/** Coerce a string to a tier, falling back when it is not a valid tier. */
export function asTier(s: string, fallback: TrustTier): TrustTier {
  return isTrustTier(s) ? s : fallback;
}

/**
 * Clamp a tier into [floor, ceiling] where `ceiling` is the MOST trust allowed
 * (lowest rank) and `floor` is the LEAST trust allowed (highest rank). This is the
 * security backstop: e.g. clamping an agent to ceiling `trusted` means even a
 * forged `operator` state resolves to `trusted`.
 */
export function clampTier(t: TrustTier, floor: TrustTier, ceiling: TrustTier): TrustTier {
  let r = RANK[t];
  if (r < RANK[ceiling]) r = RANK[ceiling]; // too much trust -> down to ceiling
  if (r > RANK[floor]) r = RANK[floor]; // too little -> up to floor
  return tierAt(r);
}

/** One tier MORE trust, not exceeding `ceiling`. */
export function promoteTier(t: TrustTier, ceiling: TrustTier): TrustTier {
  return tierAt(Math.max(RANK[ceiling], RANK[t] - 1));
}

/** One tier LESS trust, not below `floor`. */
export function demoteTier(t: TrustTier, floor: TrustTier): TrustTier {
  return tierAt(Math.min(RANK[floor], RANK[t] + 1));
}

// ---------------------------------------------------------------------------
// Durable trust state
// ---------------------------------------------------------------------------

export type TransitionDirection = "promote" | "demote";

/** A recorded tier change (promotion/demotion) with its deterministic reason. */
export interface TrustTransition {
  readonly at: number;
  readonly direction: TransitionDirection;
  readonly from: TrustTier;
  readonly to: TrustTier;
  /** Deterministic, rule-based reason (e.g. "consecutive_successes>=20", "injection_attempt"). */
  readonly reason: string;
}

/** Per-agent durable trust state. Persisted by the trust system (survives receipt pruning). */
export interface TrustState {
  readonly contractVersion: string;
  readonly agentId: string;
  readonly kind: IdentityKind;
  /** The registry-assigned starting tier (reference point). */
  readonly defaultTrustTier: TrustTier;
  /** The current EARNED tier. */
  readonly tier: TrustTier;
  readonly successCount: number;
  readonly failureCount: number;
  readonly partialCount: number;
  readonly rejectedCount: number;
  /** Count of attributed injection-attempt signals (a demotion trigger). */
  readonly injectionFlags: number;
  /**
   * NON-RECOVERABLE injection flag: set when an injection attempt is attributed.
   * While set, the agent CANNOT auto-recover (promotion is blocked) — an operator
   * reset is required. Stops probe-demote-recover-repeat.
   */
  readonly injectionFlagged: boolean;
  readonly flaggedAt?: number;
  readonly flagReason?: string;
  /** Consecutive PROMOTABLE (substantive) successes toward the next promotion. */
  readonly promotableStreak: number;
  /** Distinct substantive operations seen in the current promotion streak (anti-farming diversity). */
  readonly streakOperations: readonly string[];
  readonly consecutiveFailures: number;
  /** Per-operation tally summary. */
  readonly operations: Readonly<Record<string, number>>;
  /** Bounded promotion/demotion history. */
  readonly transitions: readonly TrustTransition[];
  /** The most recent transition (fast governance/operator-review lookup; avoids scanning the array). */
  readonly lastTransition?: TrustTransition;
  readonly createdAt: number;
  readonly lastOutcomeAt?: number;
  readonly updatedAt: number;
}

/** Read-only / no-op operation verbs that do NOT earn promotion credit (anti-farming). */
const NON_PROMOTABLE_VERBS: ReadonlySet<string> = new Set([
  "read", "get", "list", "query", "status", "health", "ping", "noop", "inspect", "view", "stat", "exists", "head",
]);

/**
 * Whether a successful operation earns promotion credit. Read-only / no-op
 * operations (by their `domain.action` verb) are excluded so an agent cannot farm
 * a streak of trivial self-triggerable successes to climb tiers.
 */
export function isPromotableOperation(operation: string): boolean {
  const parts = operation.toLowerCase().split(/[._:/\s-]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  const action = parts[parts.length - 1] ?? "";
  const head = parts[0] ?? "";
  return !NON_PROMOTABLE_VERBS.has(action) && !NON_PROMOTABLE_VERBS.has(head);
}

// ---------------------------------------------------------------------------
// recordOutcome input + decision output
// ---------------------------------------------------------------------------

/** The outcome status the engine reports (mirrors the receipt outcome status). */
export type OutcomeStatus = "success" | "failure" | "partial" | "rejected";

/**
 * Engine-internal input to record a behavior signal. `recordOutcome` requires a
 * genuine ValidatedIdentity SUBJECT alongside this input: the authoritative agentId
 * and kind are derived from that subject (the `agentId` here must MATCH it), and the
 * never-seen-agent starting tier is sourced from the registry — so `defaultTrustTier`
 * here is NO LONGER the tier source (retained for the frozen shape; ignored for the
 * starting tier). A model/content-influenced path cannot forge a subject or mint a tier.
 */
export interface RecordOutcomeInput {
  /** The ATTRIBUTED agent id. MUST match the ValidatedIdentity subject passed to recordOutcome. */
  readonly agentId: string;
  readonly kind: IdentityKind;
  /** @deprecated IGNORED for the starting tier — the registry is authoritative. Retained for the frozen shape. */
  readonly defaultTrustTier: string;
  readonly operation: string;
  readonly status: OutcomeStatus;
  /** Behavior signals derived from the receipt (e.g. injection detected by the chokepoint). */
  readonly signals?: { readonly injection?: boolean };
}

/**
 * @deprecated UNUSED — retained only to avoid a frozen-contract removal. The
 * receipt-shaped intake (`recordFromReceipt`) was removed: it carried a plain
 * `{ agentId }` with NO identity binding, so it could not be made provenance-safe.
 * The PRIMARY trust-write path (`recordOutcome`) now requires a genuine
 * ValidatedIdentity subject. Do not reintroduce a receipt-string intake.
 */
export interface TrustSignalReceipt {
  readonly identity: { readonly agentId: string };
  readonly operation: string;
  readonly outcome: { readonly status: OutcomeStatus };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** @deprecated UNUSED — see {@link TrustSignalReceipt}. */
export interface TrustSignalContext {
  readonly kind: IdentityKind;
  readonly defaultTrustTier: string;
}

/** The result of recording an outcome / resolving autonomy. */
export interface TrustDecision {
  readonly agentId: string;
  readonly tier: TrustTier;
  readonly previousTier: TrustTier;
  /** Present when this outcome caused a tier change. */
  readonly transition?: TrustTransition;
  readonly autonomy: AutonomyGrant;
}

// ---------------------------------------------------------------------------
// The tier -> autonomy mapping (the governance seam gates/shadow-workspace read)
// ---------------------------------------------------------------------------

/** How much friction a tier's gating applies. */
export type GateLevel = "all" | "standard" | "reduced";

/**
 * What a tier GRANTS — the named autonomy properties the (later) gate modules and
 * the shadow-workspace consume. THIS PHASE defines the mapping (the contract);
 * the gate behavior and the shadow-workspace are later modules that read it.
 */
export interface AutonomyGrant {
  readonly tier: TrustTier;
  /** Run the agent's work in a disposable shadow-workspace (probation/untrusted). */
  readonly sandboxed: boolean;
  /** How many gates apply. */
  readonly gateLevel: GateLevel;
  /** Do actions require an operator-approval pause? */
  readonly requiresApproval: boolean;
  /** May the agent auto-commit (trusted)? */
  readonly autoCommit: boolean;
}

/** The deterministic tier -> autonomy mapping. */
export function autonomyForTier(tier: TrustTier): AutonomyGrant {
  switch (tier) {
    case "operator":
    case "trusted":
      return { tier, sandboxed: false, gateLevel: "reduced", requiresApproval: false, autoCommit: true };
    case "verified":
      return { tier, sandboxed: false, gateLevel: "standard", requiresApproval: false, autoCommit: false };
    case "probation":
    case "untrusted":
      return { tier, sandboxed: true, gateLevel: "all", requiresApproval: true, autoCommit: false };
  }
}

/** Minimal read-seam into receipts (the Phase-5 surface) — injected, optional. */
export interface TrustReceiptReader {
  summarizeAgent(agentId: string): Promise<{
    total: number;
    byStatus: Readonly<Record<string, number>>;
  }>;
}

/** Sink for trust transitions (the engine wires this to the receipt store). */
export type TrustTransitionSink = (event: {
  readonly agentId: string;
  readonly kind: IdentityKind;
  readonly transition: TrustTransition;
}) => void;

/** A typed trust failure. */
export class TrustError extends Error {
  readonly kind: "invalid_agent" | "state" | "config";
  constructor(kind: TrustError["kind"], message: string) {
    super(message);
    this.name = "TrustError";
    this.kind = kind;
  }
}
