/**
 * ikbi v2 — THE CANONICAL COST / ACCOUNTING AUTHORITY (V2-014).
 *
 * ONE authority answers, for a whole BuildSession:
 *
 *   "What did this session actually CONSUME, which exact invocation consumed it, which
 *    attempt/role it belonged to, what cost can be PROVEN from observed provider usage,
 *    and did the session remain inside its explicit budget?"
 *
 * THREE THINGS ARE KEPT APART, on purpose, because they are three different kinds of fact:
 *
 *   USAGE IS OBSERVED FACT.   — only what a provider actually reported. Unknown ≠ zero.
 *   COST IS DERIVED ACCOUNTING.— usage × a frozen pricing catalog. Unpriced ≠ zero.
 *   BUDGET IS POLICY.         — an explicit ceiling the session may not silently exceed.
 *
 * THE ONE ACCOUNTING PATH:
 *
 *   ObservedUsage (from InvocationAuthority's V2InvocationRecord)
 *        ↓  calculateInvocationCost  (pure — no I/O, no env, no provider, no mutation)
 *   InvocationCostRecord            (content-addressed, one per InvocationId)
 *        ↓  a SessionCostController that charges each InvocationId EXACTLY ONCE
 *   AttemptCostSummary              (per RunId — preserves per-role attribution)
 *        ↓
 *   BuildSessionCostSummary         (sum of attempts == session, provably)
 *        ↓  admitNextInvocation      (pure — pre-call admission against the frozen budget)
 *   BudgetDecision
 *
 * NON-NEGOTIABLES this module makes structural:
 *   - Money is INTEGER microdollars. No floating-point canonical total, no accumulation drift.
 *   - Every InvocationId contributes to accounting AT MOST ONCE (a duplicate is a hard error).
 *   - A missing price is `unpriced_model`, a missing usage is `usage_not_reported` — never $0.
 *   - The pricing catalog is a FROZEN local constant; nothing fetches a rate at runtime.
 *   - The budget authority NEVER selects a model, resolves a route, or downgrades to cheaper.
 *     It only answers "is another call authorized?" — model selection stays the resolver's.
 *   - Recovery and semantic repair spend the SAME session wallet; no attempt resets it.
 */

import { contentDigest, type V2Digest } from "./identity.js";
import type { V2InvocationRecord, ObservedUsage, InvocationIdentityRecord, ServedIdentityStatus } from "./invocation.js";
import type { V2ModelRole } from "./config.js";
import { runFailure, type RunFailure } from "./failure.js";

// ---------------------------------------------------------------------------
// Money — INTEGER microdollars
// ---------------------------------------------------------------------------

/**
 * The canonical accounting unit: one MICRODOLLAR = 1e-6 USD. Every monetary field in this
 * module is an integer count of these. Integer accounting is the whole reason cost identity
 * is trustworthy — a hash of a float that drifted by 1e-15 is not a stable identity, and a
 * sum of many small floats is not a total anyone can reproduce.
 *
 * WHY microdollars and not nanodollars: a per-million-token rate of $0.05 prices a single
 * token at 0.05 microdollars, which rounds to zero — a call of one token IS essentially free
 * and reporting it as 0 is honest. Real builder turns move hundreds to hundreds-of-thousands
 * of tokens, which microdollars represent exactly. The largest total a session could reach
 * (Number.MAX_SAFE_INTEGER microdollars ≈ $9,007,199,254) is far beyond any real budget.
 */
export const MICRO_USD_PER_USD = 1_000_000;

/**
 * Cost in microdollars for `tokens` at `perMillionMicroUsd` microdollars-per-million-tokens.
 * Rounded ONCE, here, to an integer — so the only rounding in the whole pipeline is per
 * token-category-per-invocation, and the subsequent integer sums never drift.
 */
function tokenCostMicroUsd(tokens: number, perMillionMicroUsd: number): number {
  return Math.round((tokens * perMillionMicroUsd) / 1_000_000);
}

/** Format microdollars as a human dollar string. Presentation only — never re-parsed for accounting. */
export function formatMicroUsd(microUsd: number): string {
  const usd = microUsd / MICRO_USD_PER_USD;
  // 6 dp shows sub-cent builder turns; trailing precision is fine for an operator line.
  return `$${usd.toFixed(6)}`;
}

// ---------------------------------------------------------------------------
// Observed usage status — OBSERVED FACT about what the provider reported
// ---------------------------------------------------------------------------

/**
 * How complete the provider's usage report was. This is a statement about OBSERVATION, kept
 * distinct from cost status (which is about pricing). Unknown is never silently zero.
 *
 *   observed                    both core token counts (prompt + completion) were reported.
 *   partial                     some usage fields were reported but not both core counts.
 *   not_reported                the call succeeded but the provider reported no usage at all.
 *   unavailable_due_to_failure  the call did not succeed, so no usage record exists to read.
 */
export type ObservedUsageStatus = "observed" | "partial" | "not_reported" | "unavailable_due_to_failure";

/**
 * Classify the observed usage on a SUCCESSFUL invocation record. (A failed invocation produces
 * no V2InvocationRecord in v2, so `unavailable_due_to_failure` is attributed at the attempt
 * level, from the count of attempted-but-recordless calls — never invented here.)
 */
export function classifyObservedUsage(usage: ObservedUsage | undefined): ObservedUsageStatus {
  if (usage === undefined) return "not_reported";
  const hasPrompt = typeof usage.promptTokens === "number";
  const hasCompletion = typeof usage.completionTokens === "number";
  if (hasPrompt && hasCompletion) return "observed";
  // Some field present (e.g. only totalTokens, or only one side) — real but incomplete.
  const anyField =
    hasPrompt ||
    hasCompletion ||
    typeof usage.totalTokens === "number" ||
    typeof usage.cachedPromptTokens === "number" ||
    typeof usage.reasoningTokens === "number";
  return anyField ? "partial" : "not_reported";
}

// ---------------------------------------------------------------------------
// Cost status — DERIVED ACCOUNTING vocabulary (closed set)
// ---------------------------------------------------------------------------

/**
 * The lawful outcomes of pricing ONE invocation. Deliberately not flattened into one
 * "unknown" — an operator resolves a missing price very differently from a missing usage.
 *
 *   priced           usage AND a matching catalog price were both present; amount is exact.
 *   usage_partial    a price exists but usage was incomplete; amount is a proven LOWER BOUND.
 *   unpriced_model   usage exists but no catalog price covers the served/authorized model.
 *   usage_not_reported the model is priced but the provider reported no usage — cost unknown.
 *   pricing_ambiguous a special token category was reported that the catalog cannot price.
 *   invalid_usage    the reported usage was malformed (negative / non-integer / non-finite).
 */
export type CostStatus = "priced" | "usage_partial" | "unpriced_model" | "usage_not_reported" | "pricing_ambiguous" | "invalid_usage";

/** Cost statuses whose `amountMicroUsd` is a KNOWN quantity (exact or a proven floor). */
const KNOWN_COST_STATUSES: ReadonlySet<CostStatus> = new Set<CostStatus>(["priced", "usage_partial"]);

// ---------------------------------------------------------------------------
// Pricing catalog — ONE frozen, local, versioned source of rates
// ---------------------------------------------------------------------------

/**
 * A wire identity a price covers: sending `providerModelId` to `providerId` is priced by
 * this entry. Multiple routes may share one entry (a model reachable through two providers).
 */
export interface PricingRoute {
  readonly providerId: string;
  readonly providerModelId: string;
}

/**
 * One immutable pricing entry. Rates are INTEGER microdollars-per-million-tokens, so the
 * catalog itself is integer and its content digest is stable. Optional categories are
 * ABSENT (never zero) when the model has no distinct rate for them.
 */
export interface PricingEntry {
  /** The logical model id this prices — matched when the provider reported no served identity. */
  readonly canonicalModelId: string;
  /** The wire identities this price covers — matched when a served identity IS reported. */
  readonly routes: readonly PricingRoute[];
  readonly inputPerMillionMicroUsd: number;
  readonly outputPerMillionMicroUsd: number;
  /**
   * Rate for cache-READ prompt tokens (a subset of prompt tokens). ABSENT means cache reads
   * are priced at the ordinary input rate — v1's documented fallback, carried forward as an
   * explicit policy rather than a silent guess.
   */
  readonly cacheReadPerMillionMicroUsd?: number;
  /**
   * Rate for reasoning tokens billed SEPARATELY from completion. ABSENT is the common case:
   * providers that surface a reasoning count almost always already include it in the
   * completion count, so pricing it again would double-count. Only a model that bills
   * reasoning as a distinct line gets this field.
   */
  readonly reasoningPerMillionMicroUsd?: number;
}

/** A whole pricing catalog, frozen for a BuildSession and identified by its content. */
export interface PricingCatalog {
  /** Human-legible version tag, part of the identity — a rate change MUST change this. */
  readonly version: string;
  readonly entries: readonly PricingEntry[];
}

export type V2PricingCatalogId = V2Digest<"pricing_catalog">;

/**
 * THE shipped pricing catalog. Rates mirror v1's real, wired provider rates
 * (`src/core/provider/index.ts` — the AUTO_DISCOVER table and the built-in roster) converted
 * to integer microdollars-per-million. `catalog-drift`-style guards pin these to their v1
 * source, so a rate cannot move here without moving there and vice-versa.
 *
 * DELIBERATELY OMITTED: `opus-4.8`. v1 declares it at 0/0 because it is a STUB with no real
 * endpoint. Pricing a model $0 is exactly the fake-zero this authority forbids; if a real
 * route is ever wired and it somehow serves a request, `unpriced_model` is the honest result
 * until a real rate is observed and added here.
 */
export const V2_SHIPPED_PRICING: PricingCatalog = Object.freeze({
  version: "ikbi-v2-shipped-2026-08",
  entries: Object.freeze([
    // --- Built-in roster (v1 buildDefaultRegistry) ---
    {
      canonicalModelId: "mimo-v2.5",
      routes: [
        { providerId: "mimo", providerModelId: "mimo-v2.5" },
        { providerId: "openrouter", providerModelId: "mimo-v2.5" },
      ],
      inputPerMillionMicroUsd: 300_000,
      outputPerMillionMicroUsd: 900_000,
    },
    {
      canonicalModelId: "mimo-v2.5-pro",
      routes: [
        { providerId: "mimo", providerModelId: "mimo-v2.5-pro" },
        { providerId: "deepseek", providerModelId: "mimo-v2.5-pro" },
      ],
      inputPerMillionMicroUsd: 435_000,
      outputPerMillionMicroUsd: 870_000,
    },
    {
      canonicalModelId: "deepseek-chat",
      routes: [{ providerId: "deepseek", providerModelId: "deepseek-chat" }],
      inputPerMillionMicroUsd: 270_000,
      outputPerMillionMicroUsd: 1_100_000,
    },
    {
      canonicalModelId: "deepseek-reasoner",
      routes: [{ providerId: "deepseek", providerModelId: "deepseek-reasoner" }],
      inputPerMillionMicroUsd: 550_000,
      outputPerMillionMicroUsd: 2_190_000,
    },
    {
      canonicalModelId: "deepseek-v4-flash",
      routes: [{ providerId: "deepseek", providerModelId: "deepseek-v4-flash" }],
      inputPerMillionMicroUsd: 140_000,
      outputPerMillionMicroUsd: 550_000,
    },
    // --- Auto-discovery routes (v1 AUTO_DISCOVER) ---
    {
      canonicalModelId: "minimax-m3",
      routes: [{ providerId: "minimax", providerModelId: "MiniMax-M3" }],
      inputPerMillionMicroUsd: 300_000,
      outputPerMillionMicroUsd: 1_200_000,
    },
    {
      canonicalModelId: "gpt-4o",
      routes: [{ providerId: "openai", providerModelId: "gpt-4o" }],
      inputPerMillionMicroUsd: 2_500_000,
      outputPerMillionMicroUsd: 10_000_000,
    },
    {
      canonicalModelId: "claude-sonnet-4-5",
      routes: [{ providerId: "anthropic", providerModelId: "claude-sonnet-4-5" }],
      inputPerMillionMicroUsd: 3_000_000,
      outputPerMillionMicroUsd: 15_000_000,
    },
    {
      canonicalModelId: "gemini-2.5-flash",
      routes: [{ providerId: "google", providerModelId: "gemini-2.5-flash" }],
      inputPerMillionMicroUsd: 150_000,
      outputPerMillionMicroUsd: 600_000,
    },
    {
      canonicalModelId: "llama-3.3-70b",
      routes: [{ providerId: "groq", providerModelId: "llama-3.3-70b-versatile" }],
      inputPerMillionMicroUsd: 50_000,
      outputPerMillionMicroUsd: 80_000,
    },
  ]),
});

/** Content address of a pricing catalog — moves iff its version or any rate/route moves. */
export function pricingCatalogId(catalog: PricingCatalog): V2PricingCatalogId {
  return contentDigest("pricing_catalog", {
    version: catalog.version,
    entries: catalog.entries.map((e) => ({
      canonicalModelId: e.canonicalModelId,
      routes: [...e.routes].map((r) => ({ providerId: r.providerId, providerModelId: r.providerModelId })).sort((a, b) => `${a.providerId} ${a.providerModelId}`.localeCompare(`${b.providerId} ${b.providerModelId}`)),
      inputPerMillionMicroUsd: e.inputPerMillionMicroUsd,
      outputPerMillionMicroUsd: e.outputPerMillionMicroUsd,
      ...(e.cacheReadPerMillionMicroUsd !== undefined ? { cacheReadPerMillionMicroUsd: e.cacheReadPerMillionMicroUsd } : {}),
      ...(e.reasoningPerMillionMicroUsd !== undefined ? { reasoningPerMillionMicroUsd: e.reasoningPerMillionMicroUsd } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// Price-model resolution — SERVED identity controls the price
// ---------------------------------------------------------------------------

/** How the priced model was chosen. Recorded so an audit can see WHY a rate applied. */
export type PriceModelBasis = "served" | "authorized" | "unresolved";

export interface PriceModelResolution {
  readonly basis: PriceModelBasis;
  /** The model id whose rate applies (a wire id when served, a logical id when authorized). */
  readonly priceModelId?: string;
  readonly entry?: PricingEntry;
}

/**
 * Resolve which model's rate prices this invocation, honouring served-model precedence:
 *
 *   1. the SERVED identity, when the provider reported one AND it was accepted
 *      (match / aliased_match) — price what actually served the request;
 *   2. otherwise the AUTHORIZED logical model — when the provider reported no served id,
 *      the authorized id is the only trustworthy identity we have.
 *
 * A `mismatch` served identity never reaches here: the invocation authority fails such a
 * call, so it produces no record to price. `not_reported` falls through to authorized.
 */
export function resolvePriceModel(identity: InvocationIdentityRecord, catalog: PricingCatalog): PriceModelResolution {
  const servedTrusted = identity.servedModelId !== undefined && (identity.identityStatus === "match" || identity.identityStatus === "aliased_match");
  if (servedTrusted) {
    const served = identity.servedModelId!;
    const entry = catalog.entries.find((e) => e.routes.some((r) => r.providerId === identity.sentProviderId && r.providerModelId === served));
    if (entry !== undefined) return { basis: "served", priceModelId: served, entry };
    // Served identity is trustworthy but the catalog does not cover it — do NOT silently fall
    // back to the authorized model's rate, which could price a different model.
    return { basis: "unresolved", priceModelId: served };
  }
  const entry = catalog.entries.find((e) => e.canonicalModelId === identity.authorizedModelId);
  if (entry !== undefined) return { basis: "authorized", priceModelId: identity.authorizedModelId, entry };
  return { basis: "unresolved", priceModelId: identity.authorizedModelId };
}

// ---------------------------------------------------------------------------
// The pure cost calculator
// ---------------------------------------------------------------------------

/** A per-category cost breakdown, in microdollars. Only computed categories are present. */
export interface CostBreakdown {
  readonly inputMicroUsd?: number;
  readonly cacheReadMicroUsd?: number;
  readonly outputMicroUsd?: number;
  readonly reasoningMicroUsd?: number;
}

/** The result of pricing ONE invocation's observed usage. Pure data — no ids, no clock. */
export interface InvocationCostOutcome {
  readonly status: CostStatus;
  /** Present for `priced` (exact) and `usage_partial` (a proven lower bound). Absent otherwise. */
  readonly amountMicroUsd?: number;
  /** True when any part of this invocation's cost could not be determined. */
  readonly hasUnknown: boolean;
  readonly priceBasis: PriceModelBasis;
  readonly priceModelId?: string;
  readonly breakdown?: CostBreakdown;
}

function isNonNegInt(n: number | undefined): boolean {
  return n === undefined || (Number.isFinite(n) && Number.isInteger(n) && n >= 0);
}

/**
 * PURE. Convert one observed usage record + a resolved pricing entry into a cost outcome.
 *
 * No I/O, no environment, no provider call, no mutation, no clock, no session state. Given the
 * same inputs it returns the same outcome — which is what makes an InvocationCostRecord
 * content-addressable and a session total reproducible.
 *
 * SEMANTICS THAT MATTER:
 *   - cache-read tokens are a SUBSET of prompt tokens (v1 convention): they are subtracted from
 *     the input-rate portion and priced at the cache rate, never counted twice.
 *   - reasoning tokens are priced ONLY when the catalog declares a separate reasoning rate;
 *     otherwise they are assumed already inside the completion count and are not re-charged.
 *   - a partial usage produces a proven LOWER BOUND (the categories we could price), flagged
 *     `usage_partial` with `hasUnknown` — never an invented output=0.
 */
export function calculateInvocationCost(input: {
  readonly usage: ObservedUsage | undefined;
  readonly pricing: PriceModelResolution;
}): InvocationCostOutcome {
  const { usage, pricing } = input;
  const base = { priceBasis: pricing.basis, ...(pricing.priceModelId !== undefined ? { priceModelId: pricing.priceModelId } : {}) };

  if (pricing.entry === undefined) {
    // No usable price. Whether usage exists or not, the MONEY is unknown — not zero.
    return { status: "unpriced_model", hasUnknown: true, ...base };
  }
  if (usage === undefined) {
    return { status: "usage_not_reported", hasUnknown: true, ...base };
  }
  if (!isNonNegInt(usage.promptTokens) || !isNonNegInt(usage.completionTokens) || !isNonNegInt(usage.totalTokens) || !isNonNegInt(usage.cachedPromptTokens) || !isNonNegInt(usage.reasoningTokens)) {
    return { status: "invalid_usage", hasUnknown: true, ...base };
  }

  const entry = pricing.entry;
  const breakdown: { inputMicroUsd?: number; cacheReadMicroUsd?: number; outputMicroUsd?: number; reasoningMicroUsd?: number } = {};
  let amount = 0;
  let hasUnknown = false;

  // INPUT (+ cache-read subset).
  if (typeof usage.promptTokens === "number") {
    const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens);
    const nonCached = usage.promptTokens - cached;
    const inputMicroUsd = tokenCostMicroUsd(nonCached, entry.inputPerMillionMicroUsd);
    breakdown.inputMicroUsd = inputMicroUsd;
    amount += inputMicroUsd;
    if (cached > 0) {
      const cacheRate = entry.cacheReadPerMillionMicroUsd ?? entry.inputPerMillionMicroUsd;
      const cacheMicroUsd = tokenCostMicroUsd(cached, cacheRate);
      breakdown.cacheReadMicroUsd = cacheMicroUsd;
      amount += cacheMicroUsd;
    }
  } else {
    hasUnknown = true; // no prompt count → input cost unknown
  }

  // OUTPUT.
  if (typeof usage.completionTokens === "number") {
    const outputMicroUsd = tokenCostMicroUsd(usage.completionTokens, entry.outputPerMillionMicroUsd);
    breakdown.outputMicroUsd = outputMicroUsd;
    amount += outputMicroUsd;
  } else {
    hasUnknown = true; // no completion count → output cost unknown
  }

  // REASONING — only if the catalog bills it separately.
  if (typeof usage.reasoningTokens === "number" && entry.reasoningPerMillionMicroUsd !== undefined) {
    const reasoningMicroUsd = tokenCostMicroUsd(usage.reasoningTokens, entry.reasoningPerMillionMicroUsd);
    breakdown.reasoningMicroUsd = reasoningMicroUsd;
    amount += reasoningMicroUsd;
  }

  const hasBreakdown = Object.keys(breakdown).length > 0;
  const status: CostStatus = hasUnknown ? "usage_partial" : "priced";
  return {
    status,
    amountMicroUsd: amount,
    hasUnknown,
    ...base,
    ...(hasBreakdown ? { breakdown } : {}),
  };
}

// ---------------------------------------------------------------------------
// InvocationCostRecord — content-addressed, one per InvocationId
// ---------------------------------------------------------------------------

export type V2InvocationCostId = V2Digest<"invocation_cost">;

/**
 * The durable cost account of ONE invocation. Binds the invocation, its attempt/role
 * provenance, the served/priced identity, the observed usage semantics and the catalog that
 * priced them. Timestamps are excluded from the identity — two identical priced invocations
 * have the same cost identity even though they happened at different times.
 */
export interface InvocationCostRecord {
  readonly costId: V2InvocationCostId;
  readonly invocationId: string;
  readonly runId: string;
  readonly role: V2ModelRole;
  readonly sentProviderId: string;
  readonly authorizedModelId: string;
  readonly servedModelId?: string;
  readonly identityStatus: ServedIdentityStatus;
  readonly priceBasis: PriceModelBasis;
  readonly priceModelId?: string;
  readonly pricingCatalogId: V2PricingCatalogId;
  readonly observedUsageStatus: ObservedUsageStatus;
  readonly usage?: ObservedUsage;
  readonly costStatus: CostStatus;
  /** Present only when a KNOWN amount (exact or lower-bound) was computed. Absent = unknown. */
  readonly amountMicroUsd?: number;
  readonly hasUnknownCost: boolean;
  readonly breakdown?: CostBreakdown;
}

/** Build the immutable, content-addressed cost record for one invocation. */
export function buildInvocationCostRecord(input: {
  readonly record: V2InvocationRecord;
  readonly catalog: PricingCatalog;
  readonly catalogId: V2PricingCatalogId;
}): InvocationCostRecord {
  const { record, catalog, catalogId } = input;
  const pricing = resolvePriceModel(record.identity, catalog);
  const outcome = calculateInvocationCost({ usage: record.usage, pricing });
  const observedUsageStatus = classifyObservedUsage(record.usage);

  const semantic = {
    invocationId: record.invocationId,
    runId: record.runId,
    role: record.identity.requestedRole,
    sentProviderId: record.identity.sentProviderId,
    authorizedModelId: record.identity.authorizedModelId,
    ...(record.identity.servedModelId !== undefined ? { servedModelId: record.identity.servedModelId } : {}),
    identityStatus: record.identity.identityStatus,
    priceBasis: outcome.priceBasis,
    ...(outcome.priceModelId !== undefined ? { priceModelId: outcome.priceModelId } : {}),
    pricingCatalogId: catalogId,
    observedUsageStatus,
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
    costStatus: outcome.status,
    ...(outcome.amountMicroUsd !== undefined ? { amountMicroUsd: outcome.amountMicroUsd } : {}),
    hasUnknownCost: outcome.hasUnknown,
    ...(outcome.breakdown !== undefined ? { breakdown: outcome.breakdown } : {}),
  };
  return Object.freeze({ costId: contentDigest("invocation_cost", semantic), ...semantic });
}

// ---------------------------------------------------------------------------
// Attempt & session cost summaries
// ---------------------------------------------------------------------------

/** Cost totals for ONE role within an attempt or session. Attribution, never inference. */
export interface RoleCostSummary {
  readonly role: V2ModelRole;
  readonly invocationCount: number;
  readonly knownCostMicroUsd: number;
  readonly hasUnknownCost: boolean;
  readonly observedInputTokens: number;
  readonly observedOutputTokens: number;
}

/** The derived cost account of ONE attempt (RunId). */
export interface AttemptCostSummary {
  readonly runId: string;
  readonly attemptNumber: number;
  /** Total invocations attributed to this attempt — RECORDED calls plus failed-recordless calls. */
  readonly invocationCount: number;
  readonly pricedInvocationCount: number;
  readonly unpricedInvocationCount: number;
  /** Calls that reached the wire, failed, and left no usage — real, cost unknown. */
  readonly failedInvocationsWithoutUsage: number;
  readonly observedInputTokens: number;
  readonly observedOutputTokens: number;
  readonly observedCacheReadTokens: number;
  /** The cost we can PROVE for this attempt — a floor when `hasUnknownCost` is true. */
  readonly knownCostMicroUsd: number;
  readonly hasUnknownCost: boolean;
  readonly roles: readonly RoleCostSummary[];
  /** Every invocation cost record for this attempt, in order. */
  readonly invocations: readonly InvocationCostRecord[];
}

/** The derived cost account of a whole BuildSession. Reducible EXACTLY to its attempts. */
export interface BuildSessionCostSummary {
  readonly buildSessionId: string;
  readonly pricingCatalogId: V2PricingCatalogId;
  readonly pricingCatalogVersion: string;
  readonly budgetPolicyId: V2CostBudgetPolicyId;
  readonly attempts: readonly AttemptCostSummary[];
  readonly totalInvocations: number;
  readonly pricedInvocationCount: number;
  readonly unpricedInvocationCount: number;
  readonly failedInvocationsWithoutUsage: number;
  readonly observedInputTokens: number;
  readonly observedOutputTokens: number;
  readonly observedCacheReadTokens: number;
  /** The cost the session KNOWS — a floor when `hasUnknownCost` is true. */
  readonly totalKnownCostMicroUsd: number;
  readonly formattedKnownCostUsd: string;
  readonly hasUnknownCost: boolean;
  readonly roles: readonly RoleCostSummary[];
  /** Remaining session budget in microdollars, when a ceiling is set AND cost is fully known. */
  readonly budgetRemainingMicroUsd?: number;
}

// ---------------------------------------------------------------------------
// Budget policy — POLICY, not accounting and not selection
// ---------------------------------------------------------------------------

export type V2CostBudgetPolicyId = V2Digest<"cost_budget_policy">;

/**
 * What to do when the system CANNOT prove the next call stays within a cost ceiling — because
 * prior spend has an unknown component, or the next call's maximum cost cannot be bounded.
 *
 *   allow_unknown              proceed; the operator accepts un-bounded spend.
 *   stop_on_unknown            stop the session (fail-closed); do not gamble the budget.
 *   operator_required_on_unknown  stop and require an operator decision. THE SAFE DEFAULT:
 *                              work may be valid, but the session may not silently overrun.
 */
export type UnknownCostBehavior = "allow_unknown" | "stop_on_unknown" | "operator_required_on_unknown";

/** An explicit, immutable session budget. Small on purpose. All ceilings are OPTIONAL. */
export interface CostBudgetPolicy {
  readonly policyId: V2CostBudgetPolicyId;
  readonly maxSessionCostMicroUsd?: number;
  readonly maxAttemptCostMicroUsd?: number;
  readonly maxInvocations?: number;
  readonly behaviorWhenCostUnknown: UnknownCostBehavior;
}

/** Build a budget policy, computing its content id. */
export function buildCostBudgetPolicy(input: {
  readonly maxSessionCostMicroUsd?: number;
  readonly maxAttemptCostMicroUsd?: number;
  readonly maxInvocations?: number;
  readonly behaviorWhenCostUnknown?: UnknownCostBehavior;
}): CostBudgetPolicy {
  const behaviorWhenCostUnknown = input.behaviorWhenCostUnknown ?? "operator_required_on_unknown";
  const semantic = {
    ...(input.maxSessionCostMicroUsd !== undefined ? { maxSessionCostMicroUsd: input.maxSessionCostMicroUsd } : {}),
    ...(input.maxAttemptCostMicroUsd !== undefined ? { maxAttemptCostMicroUsd: input.maxAttemptCostMicroUsd } : {}),
    ...(input.maxInvocations !== undefined ? { maxInvocations: input.maxInvocations } : {}),
    behaviorWhenCostUnknown,
  };
  return Object.freeze({ policyId: contentDigest("cost_budget_policy", semantic), ...semantic });
}

/**
 * The DEFAULT budget policy: NO cost ceiling, NO invocation cap. A default that silently
 * capped spend would be a hidden authority; the operator opts INTO a ceiling. The
 * unknown-cost behavior is the safe one, so the moment a ceiling IS set, unknown cost stops
 * for an operator rather than gambling.
 */
export const DEFAULT_COST_BUDGET_POLICY: CostBudgetPolicy = buildCostBudgetPolicy({});

// ---------------------------------------------------------------------------
// Budget failure codes + pre-call admission
// ---------------------------------------------------------------------------

/**
 * Structured, NON-RETRYABLE cost-budget outcomes. Category is `policy` (an authority said no).
 * These must never trigger an environmental retry: recovery classifies a `policy` failure as
 * operator-required, so the session stops for a human instead of spinning on an exhausted wallet.
 */
export const V2_COST_BUDGET_FAILURE_CODES = {
  sessionExhausted: "policy.cost_session_budget_exhausted",
  attemptExhausted: "policy.cost_attempt_budget_exhausted",
  nextCallExceeds: "policy.cost_next_call_exceeds_budget",
  invocationCap: "policy.cost_invocation_cap_exhausted",
  unknownRequiresOperator: "policy.cost_unknown_requires_operator",
  unknownStop: "policy.cost_unknown_stop",
  unpricedModel: "policy.cost_unpriced_model_under_budget",
} as const;

/** A pre-call admission decision. A denial carries a structured, non-retryable RunFailure. */
export type CostAdmissionDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly requiresOperator: boolean; readonly failure: RunFailure };

function budgetFailure(code: string, message: string, detail: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({ category: "policy", code, message, stage: "candidate_generation", retryable: false, detail });
}

/** The cumulative session state a pre-call admission reads. Provided by the controller. */
export interface CostAdmissionState {
  readonly priorKnownSpendMicroUsd: number;
  readonly priorHasUnknownCost: boolean;
  readonly invocationsSoFar: number;
  /** Known spend charged to the CURRENT attempt only (for a per-attempt ceiling). */
  readonly attemptKnownSpendMicroUsd: number;
}

/** A conservative bound on the NEXT call's cost — an admission input, never observed usage. */
export interface NextCallMaxCost {
  /** The proven maximum this call could cost, in microdollars. Absent = could not be bounded. */
  readonly maxCostMicroUsd?: number;
  /** True when the next call's model has no catalog price (so its max cost is unknown). */
  readonly unpriced: boolean;
}

/**
 * PURE PRE-CALL ADMISSION. Decide whether ANOTHER model call is authorized BEFORE it is made —
 * never after the money is already spent.
 *
 * It NEVER selects or downgrades a model. Its only answers are "proceed" or a structured,
 * non-retryable "stop / require operator". Model selection remains the resolver's authority.
 */
export function admitNextInvocation(input: {
  readonly policy: CostBudgetPolicy;
  readonly state: CostAdmissionState;
  readonly next: NextCallMaxCost;
}): CostAdmissionDecision {
  const { policy, state, next } = input;

  // 1. INVOCATION CAP — a hard count ceiling, independent of money.
  if (policy.maxInvocations !== undefined && state.invocationsSoFar >= policy.maxInvocations) {
    return {
      admit: false,
      requiresOperator: true,
      failure: budgetFailure(V2_COST_BUDGET_FAILURE_CODES.invocationCap, `refusing another model call: the session invocation cap (${policy.maxInvocations}) is reached`, {
        invocationsSoFar: state.invocationsSoFar,
        maxInvocations: policy.maxInvocations,
      }),
    };
  }

  const ceilings: Array<{ ceiling: number; spent: number; code: string; label: string }> = [];
  if (policy.maxSessionCostMicroUsd !== undefined) ceilings.push({ ceiling: policy.maxSessionCostMicroUsd, spent: state.priorKnownSpendMicroUsd, code: V2_COST_BUDGET_FAILURE_CODES.sessionExhausted, label: "session" });
  if (policy.maxAttemptCostMicroUsd !== undefined) ceilings.push({ ceiling: policy.maxAttemptCostMicroUsd, spent: state.attemptKnownSpendMicroUsd, code: V2_COST_BUDGET_FAILURE_CODES.attemptExhausted, label: "attempt" });

  // No cost ceiling at all → money never blocks; the cap check above is the only gate.
  if (ceilings.length === 0) return { admit: true };

  // 2. ALREADY EXHAUSTED — known spend has met or passed a ceiling.
  for (const c of ceilings) {
    if (c.spent >= c.ceiling) {
      return {
        admit: false,
        requiresOperator: true,
        failure: budgetFailure(c.code, `refusing another model call: the ${c.label} cost budget (${formatMicroUsd(c.ceiling)}) is already spent (known ${formatMicroUsd(c.spent)})`, {
          budgetMicroUsd: c.ceiling,
          knownSpentMicroUsd: c.spent,
          scope: c.label,
        }),
      };
    }
  }

  // 3. UNKNOWN PRIOR SPEND — a ceiling exists but we cannot prove where we stand.
  if (state.priorHasUnknownCost) {
    return unknownCostDecision(policy, "prior session spend includes an unknown-cost invocation");
  }

  // 4. UNPRICED NEXT MODEL — a ceiling exists but the next call cannot be bounded at all.
  if (next.unpriced) {
    if (policy.behaviorWhenCostUnknown === "allow_unknown") return { admit: true };
    return {
      admit: false,
      requiresOperator: policy.behaviorWhenCostUnknown === "operator_required_on_unknown",
      failure: budgetFailure(V2_COST_BUDGET_FAILURE_CODES.unpricedModel, "refusing another model call: a cost ceiling is set but the next call's model has no catalog price, so its cost cannot be bounded", {
        behavior: policy.behaviorWhenCostUnknown,
      }),
    };
  }

  // 5. NEXT-CALL MAXIMUM UNKNOWN — priced model but no bound could be computed.
  if (next.maxCostMicroUsd === undefined) {
    return unknownCostDecision(policy, "the next call's maximum cost could not be bounded");
  }

  // 6. WOULD-EXCEED — the conservative maximum of the next call would breach a ceiling.
  for (const c of ceilings) {
    if (c.spent + next.maxCostMicroUsd > c.ceiling) {
      return {
        admit: false,
        requiresOperator: true,
        failure: budgetFailure(V2_COST_BUDGET_FAILURE_CODES.nextCallExceeds, `refusing another model call: its maximum cost (${formatMicroUsd(next.maxCostMicroUsd)}) could exceed the remaining ${c.label} budget (${formatMicroUsd(c.ceiling - c.spent)})`, {
          nextCallMaxMicroUsd: next.maxCostMicroUsd,
          remainingMicroUsd: c.ceiling - c.spent,
          scope: c.label,
        }),
      };
    }
  }

  return { admit: true };
}

function unknownCostDecision(policy: CostBudgetPolicy, why: string): CostAdmissionDecision {
  if (policy.behaviorWhenCostUnknown === "allow_unknown") return { admit: true };
  const requiresOperator = policy.behaviorWhenCostUnknown === "operator_required_on_unknown";
  const code = requiresOperator ? V2_COST_BUDGET_FAILURE_CODES.unknownRequiresOperator : V2_COST_BUDGET_FAILURE_CODES.unknownStop;
  return {
    admit: false,
    requiresOperator,
    failure: budgetFailure(code, `refusing another model call under a cost ceiling: ${why}`, { behavior: policy.behaviorWhenCostUnknown }),
  };
}

// ---------------------------------------------------------------------------
// Conservative next-call maximum cost
// ---------------------------------------------------------------------------

/**
 * Compute a conservative maximum microdollar cost for a NEXT call, from a priced model, a
 * (labelled ESTIMATE) input-token bound, and the hard `maxOutputTokens`. This is admission
 * input — it uses estimated input tokens and never becomes observed usage.
 *
 * The maximum is deliberately conservative: cache-read (which is only ever cheaper than input)
 * is priced at the full input rate, so the bound can never UNDER-state the true cost.
 */
export function estimateMaxNextCallCost(input: {
  readonly pricing: PriceModelResolution;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
}): NextCallMaxCost {
  if (input.pricing.entry === undefined) return { unpriced: true };
  const entry = input.pricing.entry;
  const inputMax = tokenCostMicroUsd(Math.max(0, input.estimatedInputTokens), entry.inputPerMillionMicroUsd);
  const outputMax = tokenCostMicroUsd(Math.max(0, input.maxOutputTokens), entry.outputPerMillionMicroUsd);
  return { unpriced: false, maxCostMicroUsd: inputMax + outputMax };
}

// ---------------------------------------------------------------------------
// The session cost controller — the ONE stateful accumulator + admission guard
// ---------------------------------------------------------------------------

/** Thrown on a double-count: the same InvocationId charged twice with conflicting content. */
export class CostAccountingError extends Error {
  readonly invocationId: string;
  constructor(invocationId: string, message: string) {
    super(message);
    this.name = "CostAccountingError";
    this.invocationId = invocationId;
  }
}

/**
 * What the builder/critic call before and after each model turn. The controller implements it;
 * a caller with no budget uses none and every existing call path is unaffected.
 */
export interface InvocationAdmission {
  /** Decide whether the NEXT call is authorized, from a priced/estimate view of it. */
  admitNext(input: { readonly identity: PriceModelInput; readonly estimatedInputTokens: number; readonly maxOutputTokens: number }): CostAdmissionDecision;
  /** Charge a SUCCESSFUL invocation record. Idempotent per InvocationId; a conflict throws. */
  charge(record: V2InvocationRecord): InvocationCostRecord;
}

/** The minimal identity a pre-call admission needs to resolve a would-be price. */
export interface PriceModelInput {
  readonly authorizedModelId: string;
  readonly sentProviderId: string;
  readonly sentProviderModelId: string;
}

interface AttemptAccumulator {
  runId: string;
  attemptNumber: number;
  records: InvocationCostRecord[];
  failedInvocationsWithoutUsage: number;
  sealed: boolean;
}

/**
 * THE session cost controller. ONE instance spans the whole BuildSession — every attempt,
 * including recovery and semantic-repair attempts, charges the SAME wallet, so no attempt
 * resets the budget. It is the single owner of: the frozen pricing catalog id, cumulative
 * known spend, the per-invocation dedup ledger, and the pre-call admission guard.
 */
export class SessionCostController implements InvocationAdmission {
  private readonly catalog: PricingCatalog;
  readonly catalogId: V2PricingCatalogId;
  private readonly policy: CostBudgetPolicy;
  private readonly buildSessionId: string;
  /** GLOBAL dedup: an InvocationId may be charged at most once across the whole session. */
  private readonly ledger = new Map<string, InvocationCostRecord>();
  private readonly attempts: AttemptAccumulator[] = [];
  private current: AttemptAccumulator | undefined;

  constructor(input: { readonly buildSessionId: string; readonly catalog: PricingCatalog; readonly policy: CostBudgetPolicy }) {
    this.buildSessionId = input.buildSessionId;
    this.catalog = input.catalog;
    this.catalogId = pricingCatalogId(input.catalog);
    this.policy = input.policy;
  }

  /** Open a new attempt's accounting scope. Subsequent live charges attribute here. */
  beginAttempt(runId: string, attemptNumber: number): void {
    const acc: AttemptAccumulator = { runId, attemptNumber, records: [], failedInvocationsWithoutUsage: 0, sealed: false };
    this.attempts.push(acc);
    this.current = acc;
  }

  private knownSpendOf(records: readonly InvocationCostRecord[]): number {
    let sum = 0;
    for (const r of records) if (r.amountMicroUsd !== undefined && KNOWN_COST_STATUSES.has(r.costStatus)) sum += r.amountMicroUsd;
    return sum;
  }

  private hasUnknownIn(records: readonly InvocationCostRecord[]): boolean {
    return records.some((r) => r.hasUnknownCost);
  }

  /** Current cumulative admission state across ALL charged invocations + the current attempt. */
  private admissionState(): CostAdmissionState {
    const all = [...this.ledger.values()];
    const attemptRecords = this.current?.records ?? [];
    const attemptFailed = this.current?.failedInvocationsWithoutUsage ?? 0;
    return {
      priorKnownSpendMicroUsd: this.knownSpendOf(all),
      priorHasUnknownCost: this.hasUnknownIn(all),
      invocationsSoFar: this.ledger.size,
      attemptKnownSpendMicroUsd: this.knownSpendOf(attemptRecords) + 0 * attemptFailed,
    };
  }

  admitNext(input: { readonly identity: PriceModelInput; readonly estimatedInputTokens: number; readonly maxOutputTokens: number }): CostAdmissionDecision {
    // Resolve the would-be price with the SAME served-model precedence used post-call. Pre-call
    // there is no served identity yet, so this prices the AUTHORIZED model — the honest bound.
    const pricing = resolvePriceModel(
      {
        requestedRole: "builder",
        requestedModelId: input.identity.authorizedModelId,
        authorizedModelId: input.identity.authorizedModelId,
        authorizedProviderId: input.identity.sentProviderId,
        authorizedProviderModelId: input.identity.sentProviderModelId,
        sentProviderId: input.identity.sentProviderId,
        sentProviderModelId: input.identity.sentProviderModelId,
        identityStatus: "not_reported",
      },
      this.catalog,
    );
    const next = estimateMaxNextCallCost({ pricing, estimatedInputTokens: input.estimatedInputTokens, maxOutputTokens: input.maxOutputTokens });
    return admitNextInvocation({ policy: this.policy, state: this.admissionState(), next });
  }

  /** Charge a successful invocation. Dedup per InvocationId: identical re-charge is idempotent. */
  charge(record: V2InvocationRecord): InvocationCostRecord {
    const cost = buildInvocationCostRecord({ record, catalog: this.catalog, catalogId: this.catalogId });
    const existing = this.ledger.get(record.invocationId);
    if (existing !== undefined) {
      if (existing.costId !== cost.costId) {
        throw new CostAccountingError(record.invocationId, `double-count refused: invocation ${record.invocationId} was already charged with different content`);
      }
      return existing; // idempotent — the same record charged twice contributes once.
    }
    this.ledger.set(record.invocationId, cost);
    (this.current ?? this.ensureAttemptFor(record.runId)).records.push(cost);
    return cost;
  }

  private ensureAttemptFor(runId: string): AttemptAccumulator {
    // Defensive: a charge with no open attempt (should not happen in the session flow) still
    // lands in a correctly-attributed accumulator rather than being lost.
    const existing = this.attempts.find((a) => a.runId === runId && !a.sealed);
    if (existing !== undefined) return existing;
    const acc: AttemptAccumulator = { runId, attemptNumber: this.attempts.length + 1, records: [], failedInvocationsWithoutUsage: 0, sealed: false };
    this.attempts.push(acc);
    this.current = acc;
    return acc;
  }

  /**
   * Reconcile an attempt after its run completed: charge any records the live path did not
   * (e.g. when no admission was wired, or the critic), and record how many calls reached the
   * wire, failed, and left no usage — real invocations whose cost is unknown.
   */
  reconcileAttempt(input: { readonly runId: string; readonly attemptNumber: number; readonly records: readonly V2InvocationRecord[]; readonly totalInvocationCount: number }): AttemptCostSummary {
    let acc = this.attempts.find((a) => a.runId === input.runId);
    if (acc === undefined) {
      this.beginAttempt(input.runId, input.attemptNumber);
      acc = this.current!;
    }
    // The session assigns the authoritative attempt ordinal; a live-charge accumulator may have
    // been created with a provisional number before the session reconciled it.
    acc.attemptNumber = input.attemptNumber;
    for (const rec of input.records) this.charge(rec); // idempotent for any already charged live.
    // Calls that reached the wire but produced no record = total ledgered invocations for this
    // run minus the records we could price. Never negative.
    acc.failedInvocationsWithoutUsage = Math.max(0, input.totalInvocationCount - acc.records.length);
    acc.sealed = true;
    if (this.current === acc) this.current = undefined;
    return this.attemptSummaryOf(acc);
  }

  private attemptSummaryOf(acc: AttemptAccumulator): AttemptCostSummary {
    const roleAgg = aggregateRoles(acc.records);
    const knownCost = this.knownSpendOf(acc.records);
    const hasUnknown = this.hasUnknownIn(acc.records) || acc.failedInvocationsWithoutUsage > 0;
    return {
      runId: acc.runId,
      attemptNumber: acc.attemptNumber,
      invocationCount: acc.records.length + acc.failedInvocationsWithoutUsage,
      pricedInvocationCount: acc.records.filter((r) => r.costStatus === "priced").length,
      unpricedInvocationCount: acc.records.filter((r) => r.costStatus === "unpriced_model").length,
      failedInvocationsWithoutUsage: acc.failedInvocationsWithoutUsage,
      observedInputTokens: sumUsage(acc.records, "promptTokens"),
      observedOutputTokens: sumUsage(acc.records, "completionTokens"),
      observedCacheReadTokens: sumUsage(acc.records, "cachedPromptTokens"),
      knownCostMicroUsd: knownCost,
      hasUnknownCost: hasUnknown,
      roles: roleAgg,
      invocations: acc.records,
    };
  }

  /** The whole-session summary. `sum(attempt known) == session known`, provably. */
  sessionSummary(): BuildSessionCostSummary {
    const attempts = this.attempts.map((a) => this.attemptSummaryOf(a));
    const allRecords = this.attempts.flatMap((a) => a.records);
    const totalFailed = this.attempts.reduce((n, a) => n + a.failedInvocationsWithoutUsage, 0);
    const totalKnown = attempts.reduce((n, a) => n + a.knownCostMicroUsd, 0);
    const hasUnknown = attempts.some((a) => a.hasUnknownCost);
    const summary: BuildSessionCostSummary = {
      buildSessionId: this.buildSessionId,
      pricingCatalogId: this.catalogId,
      pricingCatalogVersion: this.catalog.version,
      budgetPolicyId: this.policy.policyId,
      attempts,
      totalInvocations: this.ledger.size + totalFailed,
      pricedInvocationCount: allRecords.filter((r) => r.costStatus === "priced").length,
      unpricedInvocationCount: allRecords.filter((r) => r.costStatus === "unpriced_model").length,
      failedInvocationsWithoutUsage: totalFailed,
      observedInputTokens: sumUsage(allRecords, "promptTokens"),
      observedOutputTokens: sumUsage(allRecords, "completionTokens"),
      observedCacheReadTokens: sumUsage(allRecords, "cachedPromptTokens"),
      totalKnownCostMicroUsd: totalKnown,
      formattedKnownCostUsd: formatMicroUsd(totalKnown),
      hasUnknownCost: hasUnknown,
      roles: aggregateRoles(allRecords),
      ...(this.policy.maxSessionCostMicroUsd !== undefined && !hasUnknown ? { budgetRemainingMicroUsd: Math.max(0, this.policy.maxSessionCostMicroUsd - totalKnown) } : {}),
    };
    return summary;
  }
}

function sumUsage(records: readonly InvocationCostRecord[], field: keyof ObservedUsage): number {
  let sum = 0;
  for (const r of records) {
    const v = r.usage?.[field];
    if (typeof v === "number") sum += v;
  }
  return sum;
}

function aggregateRoles(records: readonly InvocationCostRecord[]): RoleCostSummary[] {
  const byRole = new Map<V2ModelRole, { count: number; known: number; unknown: boolean; input: number; output: number }>();
  for (const r of records) {
    const agg = byRole.get(r.role) ?? { count: 0, known: 0, unknown: false, input: 0, output: 0 };
    agg.count += 1;
    if (r.amountMicroUsd !== undefined && KNOWN_COST_STATUSES.has(r.costStatus)) agg.known += r.amountMicroUsd;
    if (r.hasUnknownCost) agg.unknown = true;
    if (typeof r.usage?.promptTokens === "number") agg.input += r.usage.promptTokens;
    if (typeof r.usage?.completionTokens === "number") agg.output += r.usage.completionTokens;
    byRole.set(r.role, agg);
  }
  return [...byRole.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([role, agg]) => ({ role, invocationCount: agg.count, knownCostMicroUsd: agg.known, hasUnknownCost: agg.unknown, observedInputTokens: agg.input, observedOutputTokens: agg.output }));
}
