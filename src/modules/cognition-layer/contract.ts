/**
 * ikbi cognition-layer — THE MODULE CONTRACT (versioned).
 *
 * The pre-action DELIBERATION seam. agent-router answers/renders; batch-planner
 * decomposes/executes; drift-prevention watches reliability; worker-model builds.
 * cognition-layer DECIDES — given a goal + project + shared cross-agent lab memory +
 * capability registry + optional drift signals, it judges which mental path is
 * appropriate (answer | plan | ask | route | warn | reject) and RECOMMENDS the next
 * module. It synthesizes the whole picture into ONE structured judgment BEFORE any
 * action module runs.
 *
 * NON-EXECUTING (the boundary that keeps it 2-eyes and distinct): it RECOMMENDS, it
 * never INVOKES. It does NOT call orchestrator.run/runWorker, batch-planner.planAndRun,
 * or agent-router.classify/ask; it does NOT mutate trust, call gate-wall, write
 * lab-memory, or execute anything. It imports NONE of the action modules — the
 * import-surface absence is the proof. Its only outputs are a returned
 * `CognitionDecision` + a `cognition.*` event. `recommendedNext` is a SUGGESTION, not
 * a dispatch.
 *
 * It READS to decide: lab-context-memory (cross-agent, read-only), the capability
 * registry (the "capability" memory kind), and (optionally) drift-prevention's
 * read-only `check()`. The goal AND retrieved memory are UNTRUSTED → neutralized
 * before the deliberation model call.
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial cognition-layer contract: CognitionInput/CognitionDecision and the
 *           six-way decision enum + recommendedNext routing recommendation. Reasons
 *           over shared lab memory + capabilities + drift; recommends-not-invokes.
 */

import type { OperationContext } from "../../core/identity/index.js";

/** Semantic version of the cognition-layer contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** The six mental paths cognition can choose. */
export type Decision = "answer" | "plan" | "ask" | "route" | "warn" | "reject";

/** Modules cognition may RECOMMEND routing to (a suggestion — never invoked here). */
export type RecommendableModule = "agent-router" | "batch-planner" | "drift-prevention" | "worker-model";

/** A routing RECOMMENDATION (data, not a dispatch). */
export interface RecommendedNext {
  readonly module: RecommendableModule;
  readonly action: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Input to a deliberation. */
export interface CognitionInput {
  /** The caller's operation context (must carry a ValidatedIdentity). */
  readonly parentCtx: OperationContext;
  /** The goal/request to deliberate on (UNTRUSTED — neutralized before the model). */
  readonly goal: string;
  /** The lab project in scope (for cross-agent memory lookup). */
  readonly project?: string;
  /** Who is deliberating (memory scoping + attribution). Defaults to the caller's agentId. */
  readonly agentId?: string;
  /** Optional extra context (never trusted as instructions). */
  readonly context?: Readonly<Record<string, unknown>>;
}

/** The structured judgment cognition produces — what Ikbi SHOULD DO, before any action. */
export interface CognitionDecision {
  readonly decision: Decision;
  /** Confidence in [0,1]. */
  readonly confidence: number;
  /** Why this decision. */
  readonly rationale: string;
  /** Which memory entry ids informed the decision (transparency). */
  readonly memoryUsed: readonly string[];
  /** The routing RECOMMENDATION (not an invocation), when the decision routes/plans. */
  readonly recommendedNext?: RecommendedNext;
  /** For "ask"/"reject" — what is underspecified. */
  readonly missingInfo?: readonly string[];
  /** For "warn" — flagged risks (e.g. a drifting capability). */
  readonly risks?: readonly string[];
}

/** Failure kinds for the deliberation layer. */
export type CognitionErrorKind = "disabled" | "identity";

/** A typed cognition failure (thrown only on a fail-closed refusal). */
export class CognitionError extends Error {
  readonly kind: CognitionErrorKind;
  constructor(kind: CognitionErrorKind, message: string) {
    super(message);
    this.name = "CognitionError";
    this.kind = kind;
  }
}

/** The cognition-layer surface (deliberate; reads to decide, executes nothing). */
export interface CognitionLayer {
  deliberate(input: CognitionInput): Promise<CognitionDecision>;
}
