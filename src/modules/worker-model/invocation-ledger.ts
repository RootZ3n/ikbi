/**
 * ikbi worker-model — ATTEMPT-SCOPED INVOCATION LEDGER (Phase 11, IKBI-REAUDIT-002 / -004).
 *
 * ONE execution source of truth for every actual dispatched provider request inside `orchestrator.run`.
 * Execution identity — which model/provider actually ran, in which vendor lane, for which role/stage, and
 * what it cost — comes from the ACTUAL dispatched invocation (the provider RESPONSE), never from an earlier
 * selection, a role's configured default, a fallback intention, or a later receipt constructor.
 *
 * The ledger is the universal dispatch seam: `engine.invokeModel` (used by every role) records one
 * immutable `InvocationRecord` per call; the classifier and frontier-consult record through the same ledger
 * instead of a raw provider call. Cost, budget, and the run summary DERIVE from the unique records:
 *   - a dispatched call = exactly one record; a pre-dispatch failure = NO executed record;
 *   - charged cost SUMS every provider ATTEMPT's cost (a failed attempt that charged tokens still counts —
 *     `ModelResponse.cost` is only the serving attempt); missing/unknown cost is `unavailable`, NEVER zero;
 *   - the run aggregate is `partial` when ANY accounted invocation's cost is unknown (not only the classifier).
 *
 * Context (role/stage/attempt/lane) is set ambiently by the orchestrator around each sequential dispatch
 * (`withContext`); competitive/tournament candidates dispatch sequentially, so there is no interleaving.
 */

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { UntrustedContext, NeutralizedContent } from "../../core/injection/contract.js";
import type { RoleEngine } from "./contract.js";

/** Lifecycle of an actual dispatch — a SELECTION or intent is never an executed invocation. */
export type InvocationStatus =
  | "dispatched"
  | "succeeded"
  | "provider-rejected"
  | "transport-failure"
  | "timeout"
  | "content-filtered"
  | "context-window"
  | "interrupted"
  | "cancelled"
  | "partial"
  | "unknown-terminal";

/** Cost knowledge for an invocation — a failed response is NOT automatically zero; missing price ≠ zero. */
export type InvocationCostStatus = "measured" | "measured-zero" | "unavailable";

/** The relationship of one invocation to another (retries/recovery build parent chains). */
export type RetryKind = "primary" | "provider-retry" | "context-window-retry" | "escalation" | "cheap-retry" | "structured-recovery" | "fixer" | "iterative-repair" | "critic-repair" | "consult";

/** The context the orchestrator threads so a record binds to its attempt/role/stage/lane. */
export interface InvocationContext {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly candidateId?: string;
  readonly candidateTree?: string;
  readonly role: string;
  readonly stage: string;
  readonly strategy?: string;
  /** The alias the caller REQUESTED (before provider fallback). */
  readonly requestedAlias?: string;
  /** The attempt's vendor lane. Undefined = a lane-NEUTRAL task/pre-attempt call (e.g. the classifier). */
  readonly vendorLane?: string;
  readonly modelDecisionSource?: string;
  readonly parentInvocationId?: string;
  readonly retryKind?: RetryKind;
  readonly semanticEvaluationId?: string;
}

/** One immutable record of an actual dispatched provider request. */
export interface InvocationRecord extends InvocationContext {
  readonly invocationId: string;
  readonly requestOrdinal: number;
  readonly dispatchedAt: number;
  readonly completedAt?: number;
  /** The model/provider the provider ACTUALLY served (from the response) — the execution truth. */
  readonly resolvedModel?: string;
  readonly provider?: string;
  readonly providerModelId?: string;
  readonly status: InvocationStatus;
  readonly usage?: ModelResponse["usage"];
  /** SUM of every provider attempt's charged cost (undefined when unknown). */
  readonly costUsd?: number;
  readonly costStatus: InvocationCostStatus;
  readonly failureClass?: string;
  /** True when the served model was OUTSIDE the attempt's declared vendor lane (a lane violation). */
  readonly laneViolation?: boolean;
}

/** SUM every provider attempt's charged cost — a failed attempt that charged tokens still counts. */
export function chargedCostOf(r: ModelResponse): { usd: number | undefined; status: InvocationCostStatus } {
  const attempts = r.attempts ?? [];
  let sum = 0;
  let anyKnown = false;
  let anyUnknown = false;
  if (attempts.length > 0) {
    for (const a of attempts) {
      if (typeof a.costUsd === "number" && Number.isFinite(a.costUsd)) { sum += a.costUsd; anyKnown = true; }
      else { anyUnknown = true; }
    }
  } else {
    const usd = r.cost?.usd;
    if (typeof usd === "number" && Number.isFinite(usd)) { sum = usd; anyKnown = true; }
    else { anyUnknown = true; }
  }
  if (anyUnknown) return { usd: anyKnown ? sum : undefined, status: "unavailable" };
  return { usd: sum, status: sum > 0 ? "measured" : "measured-zero" };
}

/** Map the provider finish reason to a lifecycle status. */
function statusFromFinish(finishReason: ModelResponse["finishReason"]): InvocationStatus {
  if (finishReason === "content_filter") return "content-filtered";
  if (finishReason === "length") return "context-window";
  return "succeeded";
}

/** Classify a thrown dispatch error (post-dispatch: the provider was called and failed). */
function failureStatusOf(err: unknown): { status: InvocationStatus; failureClass: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === "BUDGET_EXHAUSTED") return { status: "cancelled", failureClass: "budget-exhausted" };
  if (/timeout|timed out/i.test(msg)) return { status: "timeout", failureClass: "timeout" };
  if (/content[_ -]?filter/i.test(msg)) return { status: "content-filtered", failureClass: "content-filter" };
  if (/permanent|invalid|rejected|4\d\d/i.test(msg)) return { status: "provider-rejected", failureClass: "provider-rejected" };
  return { status: "transport-failure", failureClass: "transport-failure" };
}

export interface InvocationLedgerDeps {
  readonly invokeModel: (request: ModelRequest) => Promise<ModelResponse>;
  readonly neutralizeUntrusted: (content: string, context: UntrustedContext) => NeutralizedContent;
  readonly runId: string;
  readonly taskId: string;
  readonly now?: () => number;
  readonly maxBudgetUsd?: number;
  /** Effort params applied to every request (temperature/maxTokens), Phase-existing. */
  readonly effortParams?: { temperature: number; maxTokens: number };
  /** Resolve whether a served model belongs to a vendor lane (for lane-violation detection). */
  readonly laneMember?: (model: string, lane: string) => boolean;
}

/**
 * The attempt-scoped invocation ledger. `engine` is the universal dispatch seam every role uses; the
 * classifier/consult use `recordExternal`. Cost/budget/status derive from the unique records.
 */
export class InvocationLedger {
  private readonly records: InvocationRecord[] = [];
  private readonly now: () => number;
  private ordinal = 0;
  private total = 0;
  private unknownCostCount = 0;
  private budgetExhausted = false;
  private ctxStack: InvocationContext[] = [];
  /** The dispatch seam every role invokes through (identical RoleEngine shape). */
  readonly engine: RoleEngine;

  constructor(private readonly deps: InvocationLedgerDeps) {
    this.now = deps.now ?? (() => 0);
    this.ctxStack = [{ runId: deps.runId, taskId: deps.taskId, role: "unknown", stage: "unknown" }];
    this.engine = {
      invokeModel: (request: ModelRequest): Promise<ModelResponse> => this.invoke(request),
      neutralizeUntrusted: deps.neutralizeUntrusted,
    };
  }

  private get context(): InvocationContext { return this.ctxStack[this.ctxStack.length - 1]!; }

  /** Run `fn` with `ctx` as the ambient invocation context (save/restore; nesting-safe). */
  async withContext<T>(ctx: Partial<InvocationContext>, fn: () => Promise<T>): Promise<T> {
    this.ctxStack.push({ ...this.context, ...ctx });
    try { return await fn(); }
    finally { this.ctxStack.pop(); }
  }

  /** THE dispatch seam: budget-check → provider → one immutable record → return. */
  private async invoke(request: ModelRequest, override?: Partial<InvocationContext>): Promise<ModelResponse> {
    if (this.budgetExhausted) {
      throw Object.assign(new Error(`budget exhausted: cumulative cost exceeded $${this.deps.maxBudgetUsd?.toFixed(4)} cap`), { code: "BUDGET_EXHAUSTED" });
    }
    const ctx: InvocationContext = { ...this.context, ...override };
    const effReq = this.deps.effortParams !== undefined ? { ...request, temperature: this.deps.effortParams.temperature, maxTokens: this.deps.effortParams.maxTokens } : request;
    const requestOrdinal = (this.ordinal += 1);
    const invocationId = `${this.deps.taskId}:${ctx.role}:${ctx.stage}:${requestOrdinal}`;
    const dispatchedAt = this.now();
    const base = { ...ctx, invocationId, requestOrdinal, dispatchedAt, requestedAlias: ctx.requestedAlias ?? request.model };
    try {
      const r = await this.deps.invokeModel(effReq);
      const { usd, status: costStatus } = chargedCostOf(r);
      const laneViolation = ctx.vendorLane !== undefined && this.deps.laneMember !== undefined ? !this.deps.laneMember(r.model, ctx.vendorLane) : undefined;
      this.records.push({
        ...base, completedAt: this.now(), resolvedModel: r.model, provider: r.provider, providerModelId: r.providerModelId,
        status: statusFromFinish(r.finishReason), usage: r.usage, ...(usd !== undefined ? { costUsd: usd } : {}), costStatus,
        ...(laneViolation !== undefined ? { laneViolation } : {}),
      });
      if (costStatus === "unavailable") this.unknownCostCount += 1;
      else this.total += usd ?? 0;
      this.enforceBudget();
      return r;
    } catch (err) {
      const { status, failureClass } = failureStatusOf(err);
      // A thrown dispatch is a POST-dispatch failure with UNKNOWN cost — never counted as zero.
      this.records.push({ ...base, completedAt: this.now(), status, failureClass, costStatus: "unavailable" });
      this.unknownCostCount += 1;
      throw err;
    }
  }

  /** Record an EXTERNAL invocation (a raw provider helper like the frontier consult) + fold its cost. */
  recordExternal(ctx: Partial<InvocationContext> & { resolvedModel?: string; provider?: string; costUsd?: number; status?: InvocationStatus }): string {
    const merged: InvocationContext = { ...this.context, ...ctx };
    const requestOrdinal = (this.ordinal += 1);
    const invocationId = `${this.deps.taskId}:${merged.role}:${merged.stage}:${requestOrdinal}`;
    const known = typeof ctx.costUsd === "number" && Number.isFinite(ctx.costUsd);
    const costStatus: InvocationCostStatus = known ? (ctx.costUsd! > 0 ? "measured" : "measured-zero") : "unavailable";
    this.records.push({
      ...merged, invocationId, requestOrdinal, dispatchedAt: this.now(), completedAt: this.now(),
      ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
      ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
      status: ctx.status ?? "succeeded", ...(known ? { costUsd: ctx.costUsd } : {}), costStatus,
    });
    if (known) this.total += ctx.costUsd!; else this.unknownCostCount += 1;
    this.enforceBudget();
    return invocationId;
  }

  private enforceBudget(): void {
    const budget = this.deps.maxBudgetUsd;
    if (budget !== undefined && budget > 0 && this.total > budget) {
      this.budgetExhausted = true;
      throw Object.assign(new Error(`budget exhausted: cumulative cost $${this.total.toFixed(4)} exceeds $${budget.toFixed(4)} cap`), { code: "BUDGET_EXHAUSTED", costUsd: this.total, budgetUsd: budget });
    }
  }

  /** Total measured cost across unique invocation records (each counted exactly once). */
  cost(): number { return this.total; }
  /** "partial" when ANY accounted invocation's cost is unknown; else "complete". */
  costStatus(): "complete" | "partial" { return this.unknownCostCount > 0 ? "partial" : "complete"; }
  unknownCosts(): number { return this.unknownCostCount; }
  invocationCount(): number { return this.records.length; }
  laneViolations(): number { return this.records.filter((r) => r.laneViolation === true).length; }
  all(): readonly InvocationRecord[] { return this.records; }
  /** The most-recent record matching a role (for deriving a receipt's executed model from the ledger). */
  lastFor(role: string): InvocationRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i]!.role === role && this.records[i]!.resolvedModel !== undefined) return this.records[i];
    return undefined;
  }
}
