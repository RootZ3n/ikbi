/**
 * ikbi v2 — THE CANONICAL BUILD LIFECYCLE.
 *
 * There is exactly ONE lifecycle. Every future v2 build mode (single builder,
 * shadow workspace, tournament, competitive, repair/fix, server, REPL) enters it.
 * Modes may differ in HOW they generate candidates; they may NOT own verification,
 * disposition, or promotion. That is the whole point of this file: the authority
 * lives here, once, and a mode that wanted its own would have to add a second
 * lifecycle — which is now a visible, reviewable act rather than an accident.
 *
 *   pending
 *     -> preflight            can this run legally start at all?
 *     -> model_resolution     which exact model/provider route is authorized?
 *     -> context              what does the run get to know?
 *     -> invocation           can that exact route actually be invoked, and what served it?
 *     -> candidate_strategy   single / shadow / tournament — chosen ONCE, here
 *     -> candidate_generation zero or more Candidates are produced
 *     -> verification         every candidate is judged by the SAME authority
 *     -> disposition          the adjudication decision (promote / withhold / discard)
 *     -> promotion            the decision is enacted
 *     -> terminal             exactly one authoritative outcome
 *
 * TWO transition kinds, and only two:
 *   `enter(stage)`      — strictly the IMMEDIATE successor. No skipping, no going back.
 *   `terminalize(out)`  — from any live state, exactly ONCE. A run always ends here.
 *
 * WHY NO `receipt` STAGE: a receipt is not a place a run can be — it is what
 * terminalization PRODUCES. Making it a stage would force every early-exit run to
 * "skip forward" to it, which is precisely the hole that lets a run end without a
 * truthful record. Here, terminalization IS the receipt-emitting act, so a run
 * cannot end without one. (See result.ts.)
 *
 * WHY A LEDGER LIVES IN THE MACHINE: the terminal outcome may only cite evidence
 * that was actually RECORDED while the corresponding stage was live. `accepted`
 * demands a promotion id that a real promotion stage recorded; `verification` cannot
 * be entered before a candidate exists; `promotion` cannot be entered before a
 * verification exists. "No fake success" is therefore a TYPE-AND-STATE invariant of
 * the spine, not a convention downstream code is trusted to honor.
 *
 * Deliberately NOT built: event sourcing, persistence, replay, a plugin bus. The
 * journal is an in-memory array. Small enough to read in one sitting is a feature.
 */

import type { RunFailure } from "./failure.js";
import type {
  V2CandidateId,
  V2ContextDigest,
  V2DecisionDigest,
  V2MutationDigest,
  V2ObservationDigest,
  V2InvocationId,
  V2PolicyDigest,
  V2PromotionId,
  V2RunId,
  V2VerificationId,
  V2WorkspaceId,
} from "./identity.js";
import type { RunTerminalOutcome } from "./result.js";

/** The ordered, non-terminal stages of the canonical lifecycle. Order is authority. */
/**
 * ORDERING NOTE (V2-003). `model_resolution` precedes `context`, correcting the
 * placeholder order V2-001 sketched.
 *
 * The dependency runs one way only. Deterministic role resolution needs nothing but the
 * runtime policy and a role name. CONTEXT ASSEMBLY, by contrast, cannot be sized without
 * knowing the model: v1 budgets the packet from the resolved model's window
 * (`worker-model/context-manager.ts:161,193` compute the budget from
 * `caps.context_window`) and `worker-model/context-preflight.ts` exists precisely to
 * estimate "how much of the BUILDER MODEL's context window the assembled base context
 * occupies". Assembling context before knowing the model would mean sizing it against a
 * guess and re-cutting it afterwards.
 *
 * The correction is a single swap; the lifecycle's transition rules are untouched.
 */
export const LIFECYCLE_STAGES = [
  "preflight",
  "model_resolution",
  "context",
  "invocation",
  "candidate_strategy",
  "candidate_generation",
  "verification",
  "disposition",
  "promotion",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** Runtime guard: is `s` a known lifecycle stage? */
export function isLifecycleStage(s: string): s is LifecycleStage {
  return (LIFECYCLE_STAGES as readonly string[]).includes(s);
}

/** Position of a stage in the canonical order (-1 if unknown). */
export function stageIndex(stage: LifecycleStage): number {
  return LIFECYCLE_STAGES.indexOf(stage);
}

/** The stage that legally follows `stage`, or undefined when `stage` is the last one. */
export function successorStage(stage: LifecycleStage): LifecycleStage | undefined {
  return LIFECYCLE_STAGES[stageIndex(stage) + 1];
}

/** Every state a run can be in: before the lifecycle, inside it, or finished. */
export type LifecycleState =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly stage: LifecycleStage }
  | { readonly kind: "terminal"; readonly outcome: RunTerminalOutcome };

/** A state's name, for the journal and receipts. */
export type LifecycleStateName = "pending" | LifecycleStage | "terminal";

/** The name of a state (what the journal records). */
export function stateName(state: LifecycleState): LifecycleStateName {
  return state.kind === "running" ? state.stage : state.kind;
}

/** One recorded move. The journal is the run's own account of where it actually went. */
export interface LifecycleTransition {
  readonly runId: V2RunId;
  readonly from: LifecycleStateName;
  readonly to: LifecycleStateName;
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Evidence ledger — what the run ACTUALLY produced
// ---------------------------------------------------------------------------

/**
 * A fact the run produced, recorded by the stage that produced it. Each variant
 * carries the bindings a later authority needs, so nothing is correlated by
 * coincidence: a verification names the candidate it judged, a promotion names both
 * the candidate and the verification it rests on.
 */
export type LifecycleEvidence =
  | { readonly kind: "configuration"; readonly policyId: V2PolicyDigest }
  | { readonly kind: "resolution"; readonly decisionId: V2DecisionDigest; readonly role: string }
  | { readonly kind: "context"; readonly packageId: V2ContextDigest; readonly artifacts: number }
  | { readonly kind: "invocation"; readonly id: V2InvocationId; readonly role: string }
  | { readonly kind: "workspace"; readonly id: V2WorkspaceId; readonly baseTree: string }
  | { readonly kind: "observation"; readonly id: V2ObservationDigest; readonly workspaceId: V2WorkspaceId; readonly path: string }
  | { readonly kind: "mutation"; readonly id: V2MutationDigest; readonly workspaceId: V2WorkspaceId; readonly path: string }
  | { readonly kind: "candidate"; readonly id: V2CandidateId; readonly workspaceId: V2WorkspaceId }
  | { readonly kind: "verification"; readonly id: V2VerificationId; readonly candidateId: V2CandidateId }
  | {
      readonly kind: "promotion";
      readonly id: V2PromotionId;
      readonly candidateId: V2CandidateId;
      readonly verificationId: V2VerificationId;
    };

/** Which stage is allowed to record which evidence. A stage cannot vouch for another's work. */
const EVIDENCE_STAGE: Record<LifecycleEvidence["kind"], readonly LifecycleStage[]> = {
  // Configuration truth is established ONCE, by preflight. No later stage may
  // re-resolve it, which is what makes the policy the single input to model choice.
  configuration: ["preflight"],
  // A model-resolution decision may only be minted by the stage that owns resolution.
  // No later stage gets to re-decide which model serves a role.
  resolution: ["model_resolution"],
  // The authorized context package is minted by the stage that owns context, once.
  context: ["context"],
  // An INVOCATION is recorded only where one actually happens. Today that is the
  // qualification stage; when the builder loop arrives, `candidate_generation` will
  // legitimately invoke too and joins this list — deliberately, not by default.
  invocation: ["invocation"],
  // A workspace is allocated by the stage that decides WHERE a candidate would be
  // produced. Observations may be taken there and, later, while a candidate is built.
  workspace: ["candidate_strategy"],
  observation: ["candidate_strategy", "candidate_generation"],
  // A MUTATION can only happen where a candidate is actually produced. No earlier stage
  // may write, which is why the qualification path cannot claim a repository change.
  mutation: ["candidate_generation"],
  candidate: ["candidate_generation"],
  verification: ["verification"],
  promotion: ["promotion"],
};

/** Stage-entry preconditions expressed as evidence that must already exist. */
const STAGE_REQUIRES: Partial<Record<LifecycleStage, LifecycleEvidence["kind"]>> = {
  // No model may be resolved before configuration has been established and recorded.
  // This is the structural half of "every model decision has exactly one normalized
  // configuration input" — a resolver cannot run in a world where none was built.
  model_resolution: "configuration",
  // Context cannot be assembled before the model is known — its budget is a function of
  // the resolved model's window. See the ORDERING NOTE above.
  context: "resolution",
  // Nothing may be invoked without an authorized context package to invoke it with.
  invocation: "context",
  // A candidate is produced BY a model, so a route must have been proven invocable
  // before any strategy starts producing them.
  candidate_strategy: "invocation",
  // Nothing may be built without an isolated workspace to build it in.
  candidate_generation: "workspace",
  // Nothing to verify without at least one candidate. (One OR MANY — see contract.ts.)
  verification: "candidate",
  // Nothing to promote without a verdict from the canonical verification authority.
  promotion: "verification",
};

/** The read-only view of what a run produced. */
export interface RunLedgerView {
  readonly configurations: readonly V2PolicyDigest[];
  readonly resolutions: readonly V2DecisionDigest[];
  readonly contexts: readonly V2ContextDigest[];
  readonly workspaces: readonly V2WorkspaceId[];
  readonly observations: readonly V2ObservationDigest[];
  readonly mutations: readonly V2MutationDigest[];
  readonly invocations: readonly V2InvocationId[];
  readonly candidates: readonly V2CandidateId[];
  readonly verifications: readonly V2VerificationId[];
  readonly promotions: readonly V2PromotionId[];
  readonly entries: readonly LifecycleEvidence[];
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

/** Closed set of ways a caller can misuse the lifecycle. No free-text reasons. */
export type LifecycleViolationCode =
  | "run_identity_mismatch"
  | "illegal_stage_order"
  | "already_terminal"
  | "stage_not_permitted_for_evidence"
  | "missing_required_evidence"
  | "unrecorded_evidence"
  | "evidence_mismatch"
  | "duplicate_role_resolution"
  | "outcome_stage_not_reached";

/**
 * An AUTHORITY violation — a caller tried to do something the lifecycle forbids.
 *
 * This is deliberately a THROW, not a `RunFailure`. A `RunFailure` describes a
 * legitimate way a build can fail and is reportable to the operator; a violation is
 * a defect in the engine (or an attempt to bypass the spine) and must be impossible
 * to swallow into a result. The two are never conflated.
 */
export class LifecycleViolationError extends Error {
  readonly code: LifecycleViolationCode;
  readonly runId: V2RunId;
  readonly detail: string;
  constructor(code: LifecycleViolationCode, runId: V2RunId, detail: string) {
    super(`v2 lifecycle violation [${code}] on ${runId}: ${detail}`);
    this.name = "LifecycleViolationError";
    this.code = code;
    this.runId = runId;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface RunLifecycleOptions {
  readonly runId: V2RunId;
  /** Injectable clock so a run's journal is deterministic under test. */
  readonly now?: () => number;
}

/**
 * The canonical lifecycle instance for ONE run.
 *
 * Every mutating method takes the `runId` explicitly and rejects a mismatch. That
 * looks redundant inside a single object — it is not: it is what stops a later
 * orchestrator from holding two runs and advancing the wrong one, which is the
 * multi-candidate/parallel-mode failure this spine exists to prevent.
 */
export class RunLifecycle {
  readonly runId: V2RunId;
  private readonly clock: () => number;
  private current: LifecycleState = { kind: "pending" };
  private readonly transitions: LifecycleTransition[] = [];
  private readonly evidence: LifecycleEvidence[] = [];

  constructor(opts: RunLifecycleOptions) {
    this.runId = opts.runId;
    this.clock = opts.now ?? Date.now;
  }

  /** The run's current state. */
  get state(): LifecycleState {
    return this.current;
  }

  /** The stage the run is in, or undefined when pending/terminal. */
  get stage(): LifecycleStage | undefined {
    return this.current.kind === "running" ? this.current.stage : undefined;
  }

  /** Has this run been terminalized? */
  get isTerminal(): boolean {
    return this.current.kind === "terminal";
  }

  /** The ordered record of every transition this run made. */
  get journal(): readonly LifecycleTransition[] {
    return this.transitions;
  }

  /** The stages this run actually entered, in order. */
  get stagesEntered(): readonly LifecycleStage[] {
    return this.transitions.map((t) => t.to).filter(isLifecycleStage);
  }

  /** What the run actually produced. Empty until a stage records something. */
  get ledger(): RunLedgerView {
    return {
      configurations: this.evidence.filter((e) => e.kind === "configuration").map((e) => e.policyId),
      resolutions: this.evidence.filter((e) => e.kind === "resolution").map((e) => e.decisionId),
      contexts: this.evidence.filter((e) => e.kind === "context").map((e) => e.packageId),
      workspaces: this.evidence.filter((e) => e.kind === "workspace").map((e) => e.id),
      observations: this.evidence.filter((e) => e.kind === "observation").map((e) => e.id),
      mutations: this.evidence.filter((e) => e.kind === "mutation").map((e) => e.id),
      invocations: this.evidence.filter((e) => e.kind === "invocation").map((e) => e.id),
      candidates: this.evidence.filter((e) => e.kind === "candidate").map((e) => e.id),
      verifications: this.evidence.filter((e) => e.kind === "verification").map((e) => e.id),
      promotions: this.evidence.filter((e) => e.kind === "promotion").map((e) => e.id),
      entries: this.evidence,
    };
  }

  /** The terminal outcome, or undefined while the run is still live. */
  get outcome(): RunTerminalOutcome | undefined {
    return this.current.kind === "terminal" ? this.current.outcome : undefined;
  }

  /**
   * Enter the next stage. Legal ONLY for the immediate successor of the current
   * stage (or `preflight` from pending), only while live, and only when the stage's
   * required evidence already exists.
   */
  enter(runId: V2RunId, stage: LifecycleStage): void {
    this.assertRun(runId);
    this.assertLive("enter");
    const expected: LifecycleStage | undefined =
      this.current.kind === "pending" ? LIFECYCLE_STAGES[0] : successorStage((this.current as { stage: LifecycleStage }).stage);
    if (expected === undefined || stage !== expected) {
      throw new LifecycleViolationError(
        "illegal_stage_order",
        this.runId,
        `cannot enter "${stage}" from "${stateName(this.current)}" (only "${expected ?? "<none>"}" is legal)`,
      );
    }
    const required = STAGE_REQUIRES[stage];
    if (required !== undefined && !this.evidence.some((e) => e.kind === required)) {
      throw new LifecycleViolationError(
        "missing_required_evidence",
        this.runId,
        `stage "${stage}" requires at least one recorded ${required}`,
      );
    }
    this.transitionTo({ kind: "running", stage });
  }

  /**
   * Record a fact the CURRENT stage produced. The stage must be permitted to record
   * this kind of evidence, and any evidence the entry references must already exist
   * and agree — so a promotion can never cite a verification of some other candidate.
   */
  record(runId: V2RunId, entry: LifecycleEvidence): void {
    this.assertRun(runId);
    this.assertLive("record");
    const stage = this.stage;
    const allowed = EVIDENCE_STAGE[entry.kind];
    if (stage === undefined || !allowed.includes(stage)) {
      throw new LifecycleViolationError(
        "stage_not_permitted_for_evidence",
        this.runId,
        `stage "${stateName(this.current)}" may not record ${entry.kind} evidence`,
      );
    }
    if (entry.kind === "resolution") {
      // AT MOST ONE resolution per role. Without this, two builder decisions could
      // coexist and a downstream consumer — context assembly, first — would have to pick
      // one arbitrarily. Refusing the ambiguity is the whole fix; per-candidate
      // resolution, when it arrives, will need its own identity rather than a second
      // decision for the same role.
      const existing = this.evidence.find((e) => e.kind === "resolution" && e.role === entry.role);
      if (existing !== undefined) {
        throw new LifecycleViolationError(
          "duplicate_role_resolution",
          this.runId,
          `role "${entry.role}" already has an authorized route; a second decision would make downstream binding ambiguous`,
        );
      }
    }
    if (entry.kind === "verification") this.assertCandidateRecorded(entry.candidateId);
    if (entry.kind === "promotion") {
      this.assertCandidateRecorded(entry.candidateId);
      const verification = this.evidence.find((e) => e.kind === "verification" && e.id === entry.verificationId);
      if (verification === undefined) {
        throw new LifecycleViolationError("unrecorded_evidence", this.runId, `verification ${entry.verificationId} was never recorded`);
      }
      if (verification.kind === "verification" && verification.candidateId !== entry.candidateId) {
        throw new LifecycleViolationError(
          "evidence_mismatch",
          this.runId,
          `verification ${entry.verificationId} judged candidate ${verification.candidateId}, not ${entry.candidateId}`,
        );
      }
    }
    this.evidence.push(entry);
  }

  /**
   * End the run with its ONE authoritative outcome. Every positive claim in the
   * outcome is checked against the ledger first: `accepted` must cite a promotion
   * that a real promotion stage recorded, `withheld` must cite a real verification.
   * A negative outcome (rejected/quarantined/failed) needs no positive evidence —
   * it is not claiming anything happened.
   */
  terminalize(runId: V2RunId, outcome: RunTerminalOutcome): void {
    this.assertRun(runId);
    this.assertLive("terminalize");
    switch (outcome.kind) {
      case "accepted": {
        if (!this.stagesEntered.includes("promotion")) {
          throw new LifecycleViolationError("outcome_stage_not_reached", this.runId, "accepted requires the promotion stage to have been entered");
        }
        const promotion = this.evidence.find((e) => e.kind === "promotion" && e.id === outcome.promotionId);
        if (promotion === undefined || promotion.kind !== "promotion") {
          throw new LifecycleViolationError("unrecorded_evidence", this.runId, `promotion ${outcome.promotionId} was never recorded`);
        }
        if (promotion.candidateId !== outcome.candidateId || promotion.verificationId !== outcome.verificationId) {
          throw new LifecycleViolationError(
            "evidence_mismatch",
            this.runId,
            `accepted cites candidate/verification that do not match promotion ${outcome.promotionId}`,
          );
        }
        break;
      }
      case "withheld": {
        const verification = this.evidence.find((e) => e.kind === "verification" && e.id === outcome.verificationId);
        if (verification === undefined || verification.kind !== "verification") {
          throw new LifecycleViolationError("unrecorded_evidence", this.runId, `verification ${outcome.verificationId} was never recorded`);
        }
        if (verification.candidateId !== outcome.candidateId) {
          throw new LifecycleViolationError(
            "evidence_mismatch",
            this.runId,
            `withheld cites candidate ${outcome.candidateId}, but verification ${outcome.verificationId} judged ${verification.candidateId}`,
          );
        }
        break;
      }
      case "rejected": {
        if (outcome.candidateId !== undefined) this.assertCandidateRecorded(outcome.candidateId);
        break;
      }
      case "quarantined":
      case "failed":
        break;
    }
    this.transitionTo({ kind: "terminal", outcome });
  }

  private assertCandidateRecorded(id: V2CandidateId): void {
    if (!this.evidence.some((e) => e.kind === "candidate" && e.id === id)) {
      throw new LifecycleViolationError("unrecorded_evidence", this.runId, `candidate ${id} was never recorded`);
    }
  }

  private assertRun(runId: V2RunId): void {
    if (runId !== this.runId) {
      throw new LifecycleViolationError("run_identity_mismatch", this.runId, `caller presented run id ${runId}`);
    }
  }

  private assertLive(action: string): void {
    if (this.current.kind === "terminal") {
      throw new LifecycleViolationError("already_terminal", this.runId, `cannot ${action} after the run terminalized`);
    }
  }

  private transitionTo(next: LifecycleState): void {
    this.transitions.push({ runId: this.runId, from: stateName(this.current), to: stateName(next), at: this.clock() });
    this.current = next;
  }
}

/**
 * Pure predicate twin of `enter` — "would this move be legal?" — for callers that
 * want to ask before acting, and for tests that assert the ordering rules without
 * constructing a machine. Kept in lockstep with `enter` by the lifecycle tests.
 */
export function canEnter(from: LifecycleState, stage: LifecycleStage): boolean {
  if (from.kind === "terminal") return false;
  const expected = from.kind === "pending" ? LIFECYCLE_STAGES[0] : successorStage(from.stage);
  return expected !== undefined && expected === stage;
}

/** A run's failure, as it appears on a terminal `failed` outcome. Re-exported for callers. */
export type { RunFailure };
