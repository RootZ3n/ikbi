/**
 * ikbi escalation — THE MODULE CONTRACT (versioned).
 *
 * A DETERMINISTIC model-escalation engine. It sits between the worker-model
 * orchestrator and the provider layer: it reads HARD signals off a role attempt
 * (schema failures, retries, critic/verifier verdicts, context pressure, …),
 * computes a weighted score, and decides whether to retry the task on a
 * higher-tier model. It NEVER uses vibes — only the signals in `EscalationSignals`.
 *
 * THE THREE TIERS (cheap → expensive):
 *   worker   (flash)    — the default. Auto-escalates to `mid`.
 *   mid      (pro)      — auto-escalates to `frontier` ONLY with human approval.
 *   frontier (break-glass) — top tier; never auto-reached. Human must approve.
 *
 * INVARIANTS encoded here (not left to convention):
 *   • worker→mid is automatic + deterministic (no human).
 *   • mid→frontier ALWAYS sets `requiresApproval: true` — zero silent escalation.
 *   • Same `(signals, weights)` ⇒ same score (the scorer is pure).
 *   • `maxEscalations` bounds the per-task escalation count (no infinite loops).
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial escalation contract: tiers / signals / score / decision /
 *           handoff / config + weights / the engine dispatch shape. The
 *           human-approval gate for frontier is in the TYPES (requiresApproval),
 *           not a runtime afterthought.
 *
 * This contract lives in the module (it is NOT part of the frozen-core registry),
 * but is versioned like one: bump CONTRACT_VERSION on a breaking change.
 */

/** Semantic version of the escalation contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** The three model tiers, cheapest first, in canonical escalation order. */
export const MODEL_TIERS = ["worker", "mid", "frontier"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Runtime guard: is `s` a known model tier? */
export function isModelTier(s: string): s is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(s);
}

/** Deterministic signals that feed the escalation score. */
export interface EscalationSignals {
  /** Number of schema/validation failures in this task attempt. */
  readonly schemaFailures: number;
  /** Number of times the model was re-prompted (retries). */
  readonly retryCount: number;
  /** Scout validation score (0-1, where 1 is perfect). Absent ⇒ no signal. */
  readonly scoutScore?: number;
  /** Fraction of context window consumed (0-1). */
  readonly contextPressure: number;
  /** Whether the model's output was rejected by the critic. */
  readonly criticRejected: boolean;
  /** Whether verification (tests/typecheck) failed. */
  readonly verificationFailed: boolean;
  /** The stop reason from the model response (carried into the handoff; not scored). */
  readonly stopReason?: string;
  /** Number of rejected/invalid tool calls. */
  readonly rejectedToolCalls: number;
  /** Historical pass rate for this task category on this model (from Luak). Absent ⇒ no signal. */
  readonly benchmarkPassRate?: number;
  /** Whether the builder role failed (e.g. no_progress, policy violation). Binary signal. */
  readonly builderFailed: boolean;
}

/** The computed escalation score with per-signal breakdown. */
export interface EscalationScore {
  /** Total score (0-100, clamped). Higher = more likely needs escalation. */
  readonly total: number;
  /** Per-signal contribution to the total (keyed by signal name). */
  readonly breakdown: Readonly<Record<string, number>>;
  /**
   * Whether this score crosses the escalation threshold. The SCORER never sets
   * this true (it has no tier context); the POLICY/engine fills it in.
   */
  readonly shouldEscalate: boolean;
  /** The tier to escalate to, if applicable (filled by the policy). */
  readonly targetTier?: ModelTier;
}

/** Summary of a previous attempt for the handoff context. */
export interface AttemptSummary {
  readonly model: string;
  readonly tier: ModelTier;
  readonly outcome: string;
  readonly score: number;
  readonly failureReasons: readonly string[];
}

/** Context package preserved across tier transitions — the new model gets EVERYTHING. */
export interface EscalationHandoff {
  /** The original task. */
  readonly goal: string;
  /** What was attempted and failed (most recent last). */
  readonly previousAttempts: readonly AttemptSummary[];
  /** The scout's findings. */
  readonly scoutFindings?: string;
  /** The critic's feedback. */
  readonly criticFeedback?: string;
  /** The verifier's failure details. */
  readonly verificationDetails?: string;
  /** The full conversation history (opaque — the orchestrator threads it). */
  readonly conversationHistory?: readonly unknown[];
  /** Why escalation was triggered (human-readable score breakdown). */
  readonly escalationReason: string;
}

/** The escalation decision returned by `engine.evaluate`. */
export interface EscalationDecision {
  readonly contractVersion: string;
  /** Whether to escalate. */
  readonly escalate: boolean;
  /** The current tier. */
  readonly currentTier: ModelTier;
  /** The target tier (only present when `escalate === true`). */
  readonly targetTier?: ModelTier;
  /** The computed score (with `shouldEscalate`/`targetTier` resolved by the policy). */
  readonly score: EscalationScore;
  /** Whether human approval is required (ALWAYS true for a frontier target). */
  readonly requiresApproval: boolean;
  /** The model to switch to for the retry (first model of the target tier). */
  readonly targetModel?: string;
  /** Full context package for the handoff (only present when `escalate === true`). */
  readonly handoffContext?: EscalationHandoff;
  /**
   * Why escalation was DECLINED, when `escalate === false` for a reason other than
   * "score below threshold" (e.g. the per-task cap was hit, or already at frontier).
   */
  readonly declineReason?: string;
}

/** Everything the engine needs to evaluate one role attempt. */
export interface EscalationContext {
  /** Correlation id (ties escalation history + events together; the worker taskId). */
  readonly taskId: string;
  /** The tier the attempt ran on. */
  readonly currentTier: ModelTier;
  /** The hard signals extracted from the attempt. */
  readonly signals: EscalationSignals;
  /** The original goal (rides into the handoff). */
  readonly goal: string;
  /** The model the attempt used (rides into the handoff / AttemptSummary). */
  readonly currentModel?: string;
  /** Scout findings, for the handoff. */
  readonly scoutFindings?: string;
  /** Critic feedback, for the handoff. */
  readonly criticFeedback?: string;
  /** Verifier failure details, for the handoff. */
  readonly verificationDetails?: string;
  /** Opaque conversation history, threaded into the handoff. */
  readonly conversationHistory?: readonly unknown[];
  /** A short outcome label for the failing attempt's AttemptSummary (e.g. "verification failed"). */
  readonly outcomeSummary?: string;
  /** Failure reasons for the failing attempt's AttemptSummary. */
  readonly failureReasons?: readonly string[];
}

/** A recorded escalation (one tier transition) — the per-task history the cap reads. */
export interface EscalationRecord {
  readonly taskId: string;
  readonly from: ModelTier;
  readonly to: ModelTier;
  /** Whether that transition required human approval (true ⇒ to === "frontier"). */
  readonly requiresApproval: boolean;
}

/** Per-signal weights for the score computation. */
export interface EscalationWeights {
  readonly schemaFailures: number; // default 15
  readonly retryCount: number; // default 10
  readonly scoutScore: number; // default 10
  readonly contextPressure: number; // default 5
  readonly criticRejected: number; // default 20
  readonly verificationFailed: number; // default 25
  readonly rejectedToolCalls: number; // default 10
  readonly benchmarkPassRate: number; // default 5
  readonly builderFailed: number; // default 40
}

/** Configuration for the escalation engine. */
export interface EscalationConfig {
  /** Master switch for the orchestrator observability hook (the engine itself is always usable). */
  readonly enabled: boolean;
  /** Score threshold for worker → mid escalation (0-100, default 50). */
  readonly workerToMidThreshold: number;
  /** Score threshold for mid → frontier escalation (0-100, default 70). */
  readonly midToFrontierThreshold: number;
  /** Maximum escalation transitions per task (default 2: worker→mid→frontier). */
  readonly maxEscalations: number;
  /** Per-signal weights. */
  readonly weights: EscalationWeights;
  /** The model roster for each tier (the retry picks the first entry). */
  readonly tierModels: Readonly<Record<ModelTier, readonly string[]>>;
}

/** The escalation engine surface. Stateful only in the per-task history it tracks. */
export interface EscalationEngine {
  /** Evaluate whether to escalate after a role attempt. PURE given the current history. */
  evaluate(context: EscalationContext): EscalationDecision;
  /** Record that an escalation happened (drives the per-task cap). */
  recordEscalation(taskId: string, from: ModelTier, to: ModelTier): void;
  /** Get escalation history for a task (in record order). */
  getHistory(taskId: string): readonly EscalationRecord[];
  /** Drop a task's history (call when a run terminates, to bound memory). */
  forget(taskId: string): void;
}

/** A typed escalation failure (infrastructure-level; a "no-escalate" decision is NOT an error). */
export class EscalationError extends Error {
  readonly kind: "config" | "tier" | "state";
  constructor(kind: EscalationError["kind"], message: string) {
    super(message);
    this.name = "EscalationError";
    this.kind = kind;
  }
}
