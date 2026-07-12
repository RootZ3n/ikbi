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

import type { ModelRequest, ModelResponse, ProviderAttempt } from "../../core/provider/contract.js";
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
  | "unknown-terminal"
  // Phase 11B: an attempt-bound dispatch whose REQUESTED model is outside the attempt's lane — BLOCKED
  // before the provider ran (no executed invocation, no cost).
  | "lane-blocked"
  // Phase 11B: the provider SERVED a model/provider outside the attempt's lane — the response is NOT valid
  // candidate evidence, but any charged cost is preserved (a truthful terminal state).
  | "execution-identity-violation";

/** Thrown when an attempt-bound dispatch is (pre) blocked for or (post) resolved to an out-of-lane model. */
export class LaneViolationError extends Error {
  readonly code = "LANE_VIOLATION" as const;
  constructor(readonly phase: "pre-dispatch" | "post-dispatch", readonly requestedModel: string, readonly resolvedModel: string | undefined, readonly vendorLane: string) {
    super(
      phase === "pre-dispatch"
        ? `lane violation (pre-dispatch): requested model "${requestedModel}" is not in the attempt's vendor lane "${vendorLane}" — refusing to dispatch (no cross-lane borrow)`
        : `lane violation (post-dispatch): provider served "${resolvedModel}" for a "${vendorLane}"-lane attempt — the response is not valid candidate evidence`,
    );
  }
}

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

/**
 * Phase 14 (IKBI-REAUDIT2-003): whether the SERVED model/provider identity is authentically reported by the
 * provider. The requested alias/model is NEVER copied into the served fields; absence is `unavailable`, not a
 * fabricated confirmation. `conflicting` marks provider metadata that disagrees with itself.
 */
export type ServedIdentityStatus = "confirmed" | "unconfirmed" | "conflicting" | "unavailable";

/**
 * Phase 14 (IKBI-REAUDIT2-004): one ACTUAL provider dispatch attempt (a retry/fallback is a distinct attempt).
 * A logical `InvocationRecord` aggregates its child provider attempts; spend derives from unique attempts,
 * including charged FAILED attempts. Built from the lowest-seam `ModelResponse.attempts` / the thrown
 * `AllProvidersFailedError.attempts` — never synthesized after the call from configuration.
 */
export interface ProviderAttemptRecord {
  readonly providerAttemptId: string;
  readonly logicalInvocationId: string;
  readonly attemptOrdinal: number;
  /** The vendor/provider that actually served (or attempted) — the SERVED provider, not the requested one. */
  readonly servedProvider: string;
  /** The provider-specific model id that served (or attempted) — the SERVED concrete model. */
  readonly servedModel: string;
  readonly outcome: ProviderAttempt["outcome"];
  readonly usage?: ModelResponse["usage"];
  readonly costUsd?: number;
  readonly costStatus: InvocationCostStatus;
  /** True when this attempt FAILED but the provider charged tokens/cost (a charged failure — never dropped). */
  readonly chargedFailure: boolean;
  readonly error?: string;
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
  /** Phase 14: the SERVED identity (provider-reported), distinct from the requested alias/model, + its status. */
  readonly servedModel?: string;
  readonly servedProvider?: string;
  readonly servedIdentityStatus?: ServedIdentityStatus;
  readonly status: InvocationStatus;
  readonly usage?: ModelResponse["usage"];
  /** SUM of every provider attempt's charged cost (undefined when unknown). */
  readonly costUsd?: number;
  readonly costStatus: InvocationCostStatus;
  readonly failureClass?: string;
  /** True when the served model was OUTSIDE the attempt's declared vendor lane (a lane violation). */
  readonly laneViolation?: boolean;
  /** Phase 14: the child provider attempts (first + retries + fallbacks), individually attributable. */
  readonly providerAttempts?: readonly ProviderAttemptRecord[];
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

/** SUM the charged cost of a raw provider-attempt list (the thrown-failure path preserves charged failures). */
function chargedCostOfAttempts(attempts: readonly ProviderAttempt[]): { usd: number | undefined; status: InvocationCostStatus } {
  let sum = 0, anyKnown = false, anyUnknown = false;
  for (const a of attempts) {
    if (typeof a.costUsd === "number" && Number.isFinite(a.costUsd)) { sum += a.costUsd; anyKnown = true; }
    else anyUnknown = true;
  }
  if (attempts.length === 0) return { usd: undefined, status: "unavailable" };
  if (anyUnknown) return { usd: anyKnown ? sum : undefined, status: "unavailable" };
  return { usd: sum, status: sum > 0 ? "measured" : "measured-zero" };
}

/** Expand a lowest-seam provider-attempt list into distinct, individually-attributable attempt records. */
function expandProviderAttempts(attempts: readonly ProviderAttempt[], logicalInvocationId: string): ProviderAttemptRecord[] {
  return attempts.map((a, i): ProviderAttemptRecord => {
    const known = typeof a.costUsd === "number" && Number.isFinite(a.costUsd);
    const costStatus: InvocationCostStatus = known ? (a.costUsd! > 0 ? "measured" : "measured-zero") : "unavailable";
    const failed = a.outcome !== "success";
    return {
      providerAttemptId: `${logicalInvocationId}#pa${i + 1}`,
      logicalInvocationId, attemptOrdinal: i + 1,
      servedProvider: a.provider, servedModel: a.providerModelId, outcome: a.outcome,
      ...(a.usage !== undefined ? { usage: a.usage } : {}),
      ...(known ? { costUsd: a.costUsd } : {}), costStatus,
      chargedFailure: failed && (known ? a.costUsd! > 0 : a.usage !== undefined),
      ...(a.error !== undefined ? { error: a.error } : {}),
    };
  });
}

/**
 * Phase 14 (IKBI-REAUDIT2-003): derive the SERVED identity from provider-reported metadata ONLY. The requested
 * alias/model is never copied into served fields; absent metadata is `unavailable`, present + self-consistent is
 * `confirmed`, present-but-self-disagreeing is `conflicting`.
 */
function deriveServedIdentity(r: Pick<ModelResponse, "provider" | "providerModelId" | "attempts">): { servedModel?: string; servedProvider?: string; status: ServedIdentityStatus } {
  const model = typeof r.providerModelId === "string" && r.providerModelId.trim().length > 0 ? r.providerModelId.trim() : undefined;
  const provider = typeof r.provider === "string" && r.provider.trim().length > 0 ? r.provider.trim() : undefined;
  if (model === undefined && provider === undefined) return { status: "unavailable" };
  // If the serving attempt's provider/model disagrees with the top-level served fields, mark conflicting.
  const serving = (r.attempts ?? []).filter((a) => a.outcome === "success").slice(-1)[0];
  if (serving !== undefined && provider !== undefined && serving.provider.trim().length > 0 && serving.provider.trim() !== provider) {
    return { ...(model !== undefined ? { servedModel: model } : {}), ...(provider !== undefined ? { servedProvider: provider } : {}), status: "conflicting" };
  }
  return { ...(model !== undefined ? { servedModel: model } : {}), ...(provider !== undefined ? { servedProvider: provider } : {}), status: "confirmed" };
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
  /** Whether a REQUESTED model is eligible for a vendor lane — PRE-dispatch enforcement (block if false). */
  readonly laneMember?: (model: string, lane: string) => boolean;
  /**
   * Whether a SERVED model belongs to a KNOWN OTHER vendor lane — POST-dispatch execution-identity check.
   * A genuine cross-vendor mismatch (e.g. a mimo model served for a deepseek attempt) is a violation; an
   * unknown/generic model is NOT (so a stub or a novel model never false-positives). Distinct from
   * `laneMember` so the post-check only fires on a definite cross-lane crossing.
   */
  readonly servedOutOfLane?: (servedModel: string, lane: string) => boolean;
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
  private executionIdentityViolationCount = 0;
  private budgetExhausted = false;
  private ctxStack: InvocationContext[] = [];
  /** The dispatch seam every role invokes through (identical RoleEngine shape). */
  readonly engine: RoleEngine;

  constructor(private readonly deps: InvocationLedgerDeps) {
    this.now = deps.now ?? (() => 0);
    this.ctxStack = [{ runId: deps.runId, taskId: deps.taskId, role: "unknown", stage: "unknown" }];
    this.engine = {
      invokeModel: (request: ModelRequest, meta?: { stage?: string; retryKind?: string }): Promise<ModelResponse> =>
        this.invoke(request, meta !== undefined ? { ...(meta.stage !== undefined ? { stage: meta.stage } : {}), ...(meta.retryKind !== undefined ? { retryKind: meta.retryKind as RetryKind } : {}) } : undefined),
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
    // PRE-DISPATCH LANE ENFORCEMENT (Phase 11B): an attempt-bound call (vendorLane set) whose REQUESTED model
    // is out of lane is BLOCKED before the provider runs — no executed invocation, no cost. It is not enough
    // to record `laneViolation` and continue; the illegal dispatch never happens.
    if (ctx.vendorLane !== undefined && this.deps.laneMember !== undefined && !this.deps.laneMember(request.model, ctx.vendorLane)) {
      this.records.push({ ...base, completedAt: this.now(), status: "lane-blocked", costStatus: "measured-zero", laneViolation: true });
      throw new LaneViolationError("pre-dispatch", request.model, undefined, ctx.vendorLane);
    }
    // PRE-DISPATCH JOURNAL (Phase 14B): allocate + record the DISPATCHED state BEFORE calling the provider,
    // so a dispatched attempt has a durable record before the promise resolves. It is FINALIZED in place from
    // the real response/failure — never replaced by a record created after return. A call that hangs or ends
    // abnormally leaves this `dispatched` record (finalizable to `unknown-terminal`), never a deleted attempt.
    const pendingIndex = this.records.length;
    this.records.push({ ...base, status: "dispatched", costStatus: "unavailable", servedIdentityStatus: "unavailable" });
    try {
      const r = await this.deps.invokeModel(effReq);
      const { usd, status: costStatus } = chargedCostOf(r);
      // SERVED IDENTITY (Phase 14, IKBI-REAUDIT2-003): the served model/provider comes from provider-reported
      // metadata, NEVER the requested alias/model. Absent metadata ⇒ `unavailable` (unconfirmed), not fabricated.
      const served = deriveServedIdentity(r);
      const providerAttempts = expandProviderAttempts(r.attempts ?? [], invocationId);
      // POST-dispatch lane check runs ONLY on a CONFIRMED served identity — never flag cross-lane on absent
      // metadata (an unconfirmed serve is recorded unconfirmed, not falsely classified as a violation).
      const laneViolation = ctx.vendorLane !== undefined && this.deps.servedOutOfLane !== undefined && served.servedModel !== undefined
        ? this.deps.servedOutOfLane(served.servedModel, ctx.vendorLane) : undefined;
      const servedFields = { ...(served.servedModel !== undefined ? { servedModel: served.servedModel } : {}), ...(served.servedProvider !== undefined ? { servedProvider: served.servedProvider } : {}), servedIdentityStatus: served.status };
      // POST-DISPATCH EXECUTION-IDENTITY ENFORCEMENT: the provider SERVED an out-of-lane model. Record the
      // truthful terminal state + PRESERVE any charged cost, but the response is NOT valid candidate evidence
      // — throw so the caller fails closed (never silently accept a cross-lane result as valid work).
      if (laneViolation === true) {
        this.records[pendingIndex] = { // FINALIZE the pre-dispatch record in place (never a replacement record)
          ...base, completedAt: this.now(), resolvedModel: served.servedModel ?? r.providerModelId ?? r.model, provider: r.provider, providerModelId: r.providerModelId, ...servedFields,
          status: "execution-identity-violation", usage: r.usage, ...(usd !== undefined ? { costUsd: usd } : {}), costStatus, laneViolation: true, providerAttempts,
        };
        if (costStatus === "unavailable") this.unknownCostCount += 1; else this.total += usd ?? 0;
        this.executionIdentityViolationCount += 1;
        this.enforceBudget();
        throw new LaneViolationError("post-dispatch", request.model, served.servedModel ?? r.model, ctx.vendorLane!);
      }
      this.records[pendingIndex] = { // FINALIZE the pre-dispatch record in place from the real response
        ...base, completedAt: this.now(), resolvedModel: served.servedModel ?? r.providerModelId ?? r.model, provider: r.provider, providerModelId: r.providerModelId, ...servedFields,
        status: statusFromFinish(r.finishReason), usage: r.usage, ...(usd !== undefined ? { costUsd: usd } : {}), costStatus,
        ...(laneViolation !== undefined ? { laneViolation } : {}), providerAttempts,
      };
      if (costStatus === "unavailable") this.unknownCostCount += 1;
      else this.total += usd ?? 0;
      this.enforceBudget();
      return r;
    } catch (err) {
      if (err instanceof LaneViolationError) throw err; // already recorded above
      const { status, failureClass } = failureStatusOf(err);
      // CHARGED THROWN FAILURE (Phase 14, IKBI-REAUDIT2-004): a thrown dispatch may still have CHARGED provider
      // attempts (AllProvidersFailedError carries them). Preserve their usage/cost + record them as attempts —
      // a charged failure must never disappear. Missing cost stays UNKNOWN (never silently zero).
      const failedAttempts = (err as { attempts?: readonly ProviderAttempt[] } | undefined)?.attempts ?? [];
      const providerAttempts = expandProviderAttempts(failedAttempts, invocationId);
      const { usd, status: costStatus } = failedAttempts.length > 0 ? chargedCostOfAttempts(failedAttempts) : { usd: undefined, status: "unavailable" as InvocationCostStatus };
      const lastServing = [...failedAttempts].reverse().find((a) => a.providerModelId.trim().length > 0);
      this.records[pendingIndex] = { // FINALIZE the pre-dispatch record in place from the thrown failure
        ...base, completedAt: this.now(), status, failureClass, ...(usd !== undefined ? { costUsd: usd } : {}), costStatus,
        ...(lastServing !== undefined ? { servedModel: lastServing.providerModelId, servedProvider: lastServing.provider, servedIdentityStatus: "confirmed" as ServedIdentityStatus } : { servedIdentityStatus: "unavailable" as ServedIdentityStatus }),
        ...(providerAttempts.length > 0 ? { providerAttempts } : {}),
      };
      if (costStatus === "unavailable") this.unknownCostCount += 1; else this.total += usd ?? 0;
      this.enforceBudget();
      throw err;
    }
  }

  /**
   * Record an EXTERNAL invocation (a raw provider helper like the frontier consult) + fold its cost, and
   * RETURN its authoritative invocation id so a receipt can reference the exact record. Execution identity
   * (resolvedModel/provider/usage/status) is captured so `lastFor` finds it. `deferBudget` records + folds
   * the cost WITHOUT tripping the budget cap here — the caller enforces it AFTER writing a durable receipt.
   */
  recordExternal(ctx: Partial<InvocationContext> & { resolvedModel?: string; provider?: string; providerModelId?: string; usage?: ModelResponse["usage"]; costUsd?: number; status?: InvocationStatus; servedIdentityStatus?: ServedIdentityStatus; attempts?: readonly ProviderAttempt[] }, opts?: { deferBudget?: boolean }): string {
    const merged: InvocationContext = { ...this.context, ...ctx };
    const requestOrdinal = (this.ordinal += 1);
    const invocationId = `${this.deps.taskId}:${merged.role}:${merged.stage}:${requestOrdinal}`;
    const known = typeof ctx.costUsd === "number" && Number.isFinite(ctx.costUsd);
    const costStatus: InvocationCostStatus = known ? (ctx.costUsd! > 0 ? "measured" : "measured-zero") : "unavailable";
    // Phase 14: an external adapter (classifier/consult) may carry its real provider attempts + served identity.
    // The served identity is provider-reported (never the requested alias); absent ⇒ `unconfirmed`, not fabricated.
    const providerAttempts = ctx.attempts !== undefined ? expandProviderAttempts(ctx.attempts, invocationId) : undefined;
    const servedStatus: ServedIdentityStatus = ctx.servedIdentityStatus ?? (ctx.providerModelId !== undefined ? "confirmed" : "unconfirmed");
    this.records.push({
      ...merged, invocationId, requestOrdinal, dispatchedAt: this.now(), completedAt: this.now(),
      ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
      ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
      ...(ctx.providerModelId !== undefined ? { providerModelId: ctx.providerModelId, servedModel: ctx.providerModelId, ...(ctx.provider !== undefined ? { servedProvider: ctx.provider } : {}), servedIdentityStatus: servedStatus } : { servedIdentityStatus: servedStatus }),
      ...(ctx.usage !== undefined ? { usage: ctx.usage } : {}),
      status: ctx.status ?? "succeeded", ...(known ? { costUsd: ctx.costUsd } : {}), costStatus,
      ...(providerAttempts !== undefined ? { providerAttempts } : {}),
    });
    if (known) this.total += ctx.costUsd!; else this.unknownCostCount += 1;
    if (opts?.deferBudget !== true) this.enforceBudget();
    return invocationId;
  }

  /** Trip the budget cap NOW (used after a `deferBudget` record whose receipt is already durable). */
  applyBudget(): void { this.enforceBudget(); }

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
  /** Count of ACTUAL executed dispatches — a pre-dispatch `lane-blocked` record is NOT an executed invocation. */
  invocationCount(): number { return this.records.filter((r) => r.status !== "lane-blocked").length; }
  laneViolations(): number { return this.records.filter((r) => r.laneViolation === true).length; }
  /** Count of dispatches whose SERVED identity fell outside the attempt lane (invalid candidate evidence). */
  executionIdentityViolations(): number { return this.executionIdentityViolationCount; }
  all(): readonly InvocationRecord[] { return this.records; }
  /** Phase 14: every ACTUAL provider attempt (first + retries + fallbacks) across all executed invocations, ordered. */
  providerAttempts(): readonly ProviderAttemptRecord[] {
    const out: ProviderAttemptRecord[] = [];
    for (const r of this.records) if (r.providerAttempts !== undefined) out.push(...r.providerAttempts);
    return out;
  }
  /** Phase 14: authoritative spend derived from UNIQUE provider attempts (incl. charged failures); undefined-cost attempts make it partial. */
  providerAttemptCost(): { usd: number; status: "complete" | "partial" } {
    let usd = 0, partial = false;
    for (const a of this.providerAttempts()) {
      if (a.costStatus === "unavailable") partial = true;
      else usd += a.costUsd ?? 0;
    }
    // A record with a cost but no expanded attempts (e.g. a recordExternal without attempts) still counts.
    for (const r of this.records) {
      if ((r.providerAttempts?.length ?? 0) > 0) continue;
      if (r.status === "lane-blocked") continue;
      if (r.costStatus === "unavailable") partial = true;
      else usd += r.costUsd ?? 0;
    }
    return { usd, status: partial ? "partial" : "complete" };
  }
  /** Count of charged FAILED provider attempts preserved (Phase 14 — never dropped). */
  chargedFailureCount(): number { return this.providerAttempts().filter((a) => a.chargedFailure).length; }
  /** Phase 14B: dispatched invocations not yet finalized (a hung/in-flight provider call). A pre-dispatch record exists here BEFORE the promise resolves. */
  pendingAttempts(): readonly InvocationRecord[] { return this.records.filter((r) => r.status === "dispatched"); }
  /** Phase 14B: mark every still-dispatched record `unknown-terminal` (run teardown while a call was in flight) — the attempt is preserved, never deleted. */
  finalizeStalePending(): void {
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i]!.status === "dispatched") this.records[i] = { ...this.records[i]!, status: "unknown-terminal", completedAt: this.now() };
    }
  }
  /**
   * Ordered, de-duplicated invocationIds of every EXECUTED record — the aggregate linkage a strategy/summary
   * receipt uses to reference EVERY provider request it summarizes (each counted exactly once, dispatch order).
   * Excludes pre-dispatch `lane-blocked` records (no execution happened).
   */
  executedIds(): readonly string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const r of this.records) {
      if (r.resolvedModel !== undefined && !seen.has(r.invocationId)) { seen.add(r.invocationId); ids.push(r.invocationId); }
    }
    return ids;
  }
  /**
   * The most-recent EXECUTED record matching a role (and optionally a stage) — the authority a receipt uses to
   * derive execution model/provider/lane/cost/id. Skips non-executed records (`lane-blocked`, no resolvedModel).
   */
  lastFor(role: string, stage?: string): InvocationRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.role === role && r.resolvedModel !== undefined && (stage === undefined || r.stage === stage)) return r;
    }
    return undefined;
  }
}
