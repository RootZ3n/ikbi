/**
 * V2-014 — THE CANONICAL COST / ACCOUNTING AUTHORITY.
 *
 * These suites pin the non-negotiables: integer money that never drifts, unknown usage and
 * unknown price kept explicitly unknown (never $0), served-model pricing precedence, cache
 * tokens never double-counted, EXACTLY-once invocation accounting, provable attempt→session
 * reduction, and a pre-call budget that stops BEFORE the money is spent and never resets
 * across recovery/repair attempts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { V2InvocationRecord, ObservedUsage, ServedIdentityStatus } from "./invocation.js";
import type { V2ModelRole } from "./config.js";
import {
  MICRO_USD_PER_USD,
  formatMicroUsd,
  classifyObservedUsage,
  resolvePriceModel,
  calculateInvocationCost,
  buildInvocationCostRecord,
  pricingCatalogId,
  estimateMaxNextCallCost,
  admitNextInvocation,
  buildCostBudgetPolicy,
  DEFAULT_COST_BUDGET_POLICY,
  V2_SHIPPED_PRICING,
  SessionCostController,
  CostAccountingError,
  type PricingCatalog,
} from "./cost.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG = V2_SHIPPED_PRICING;
const CATALOG_ID = pricingCatalogId(CATALOG);

let seq = 0;
function rec(overrides: {
  usage?: ObservedUsage;
  role?: V2ModelRole;
  authorizedModelId?: string;
  sentProviderId?: string;
  sentProviderModelId?: string;
  servedModelId?: string;
  identityStatus?: ServedIdentityStatus;
  invocationId?: string;
  runId?: string;
} = {}): V2InvocationRecord {
  seq += 1;
  const authorizedModelId = overrides.authorizedModelId ?? "deepseek-chat";
  const sentProviderId = overrides.sentProviderId ?? "deepseek";
  const sentProviderModelId = overrides.sentProviderModelId ?? "deepseek-chat";
  return {
    invocationId: (overrides.invocationId ?? `inv_seed-${String(seq).padStart(8, "0")}`) as V2InvocationRecord["invocationId"],
    runId: (overrides.runId ?? "run_seed-00000001") as V2InvocationRecord["runId"],
    taskId: "task_seed-00000001" as V2InvocationRecord["taskId"],
    resolutionDecisionId: "d".repeat(64) as V2InvocationRecord["resolutionDecisionId"],
    contextPackageId: "ctx",
    promptId: "p".repeat(64) as V2InvocationRecord["promptId"],
    identity: {
      requestedRole: overrides.role ?? "builder",
      requestedModelId: authorizedModelId,
      authorizedModelId,
      authorizedProviderId: sentProviderId,
      authorizedProviderModelId: sentProviderModelId,
      sentProviderId,
      sentProviderModelId,
      ...(overrides.servedModelId !== undefined ? { servedModelId: overrides.servedModelId } : {}),
      identityStatus: overrides.identityStatus ?? "not_reported",
    },
    parameters: { maxOutputTokens: 1000, timeoutMs: 1000 },
    attempts: 1,
    finishReason: "stop",
    responseCharacters: 10,
    ...(overrides.usage !== undefined ? { usage: overrides.usage } : {}),
    startedAt: 1,
    endedAt: 2,
  };
}

// ---------------------------------------------------------------------------
// Money precision
// ---------------------------------------------------------------------------

test("money: rates are integer microdollars and sums never drift", () => {
  // deepseek-chat: input 270000/M, output 1100000/M. 1000 prompt = 270µ, 500 completion = 550µ.
  const outcome = calculateInvocationCost({
    usage: { promptTokens: 1000, completionTokens: 500 },
    pricing: resolvePriceModel(rec({ authorizedModelId: "deepseek-chat" }).identity, CATALOG),
  });
  assert.equal(outcome.status, "priced");
  assert.equal(outcome.amountMicroUsd, 820);
  assert.ok(Number.isInteger(outcome.amountMicroUsd!), "money is an integer");
  assert.equal(MICRO_USD_PER_USD, 1_000_000);
  assert.equal(formatMicroUsd(820), "$0.000820");
});

test("money: a sub-microdollar single-token call rounds to zero and is still priced (honest, not unknown)", () => {
  // llama input 50000/M → 1 token = 0.05µ → rounds to 0.
  const outcome = calculateInvocationCost({
    usage: { promptTokens: 1, completionTokens: 0 },
    pricing: resolvePriceModel(rec({ authorizedModelId: "llama-3.3-70b", sentProviderId: "groq", sentProviderModelId: "llama-3.3-70b-versatile" }).identity, CATALOG),
  });
  assert.equal(outcome.status, "priced");
  assert.equal(outcome.amountMicroUsd, 0);
  assert.equal(outcome.hasUnknown, false);
});

// ---------------------------------------------------------------------------
// Pricing catalog identity + freeze
// ---------------------------------------------------------------------------

test("pricing catalog: id is stable and route-order independent", () => {
  assert.equal(pricingCatalogId(CATALOG), CATALOG_ID);
  const reordered: PricingCatalog = {
    version: CATALOG.version,
    entries: CATALOG.entries.map((e) => (e.routes.length > 1 ? { ...e, routes: [...e.routes].reverse() } : e)),
  };
  assert.equal(pricingCatalogId(reordered), CATALOG_ID, "route order is not identity");
});

test("pricing catalog: a rate change moves the id", () => {
  const bumped: PricingCatalog = { version: CATALOG.version, entries: CATALOG.entries.map((e, i) => (i === 0 ? { ...e, inputPerMillionMicroUsd: e.inputPerMillionMicroUsd + 1 } : e)) };
  assert.notEqual(pricingCatalogId(bumped), CATALOG_ID);
});

test("pricing DRIFT: each shipped rate matches the v1 donor's per-MTok cost, and v1 still declares it", () => {
  // The shipped catalog is DERIVED from v1's real wired rates (src/core/provider/index.ts). If a
  // rate moves in v1, this guard fails until the catalog (and its frozen id) moves with it.
  const v1 = readFileSync(fileURLToPath(new URL("../../core/provider/index.ts", import.meta.url)), "utf8");
  // canonicalModelId -> [v1 promptPerMTok, v1 completionPerMTok] (USD per million tokens).
  const expected: Record<string, [number, number]> = {
    "mimo-v2.5": [0.3, 0.9],
    "mimo-v2.5-pro": [0.435, 0.87],
    "deepseek-chat": [0.27, 1.1],
    "deepseek-reasoner": [0.55, 2.19],
    "deepseek-v4-flash": [0.14, 0.55],
    "minimax-m3": [0.3, 1.2],
    "gpt-4o": [2.5, 10.0],
    "claude-sonnet-4-5": [3.0, 15.0],
    "gemini-2.5-flash": [0.15, 0.6],
    "llama-3.3-70b": [0.05, 0.08],
  };
  for (const entry of CATALOG.entries) {
    const rates = expected[entry.canonicalModelId];
    assert.ok(rates !== undefined, `unexpected catalog entry ${entry.canonicalModelId} — add its v1 rate to this guard`);
    const [prompt, completion] = rates!;
    assert.equal(entry.inputPerMillionMicroUsd, Math.round(prompt * MICRO_USD_PER_USD), `${entry.canonicalModelId} input rate`);
    assert.equal(entry.outputPerMillionMicroUsd, Math.round(completion * MICRO_USD_PER_USD), `${entry.canonicalModelId} output rate`);
    // The v1 donor still declares these literal rates (a tripwire if v1 changes them).
    assert.ok(v1.includes(`promptPerMTok: ${prompt}`), `v1 no longer declares promptPerMTok: ${prompt} for ${entry.canonicalModelId}`);
    assert.ok(v1.includes(`completionPerMTok: ${completion}`), `v1 no longer declares completionPerMTok: ${completion} for ${entry.canonicalModelId}`);
  }
  // opus-4.8 is deliberately OMITTED (v1 declares it 0/0 as a stub — a fake zero we refuse to ship).
  assert.equal(CATALOG.entries.find((e) => e.canonicalModelId === "opus-4.8"), undefined);
});

// ---------------------------------------------------------------------------
// Observed usage status
// ---------------------------------------------------------------------------

test("observed usage status: observed / partial / not_reported", () => {
  assert.equal(classifyObservedUsage({ promptTokens: 10, completionTokens: 5 }), "observed");
  assert.equal(classifyObservedUsage({ promptTokens: 10 }), "partial");
  assert.equal(classifyObservedUsage({ totalTokens: 10 }), "partial");
  assert.equal(classifyObservedUsage(undefined), "not_reported");
  assert.equal(classifyObservedUsage({}), "not_reported");
});

// ---------------------------------------------------------------------------
// STRICT — missing price / missing usage / partial usage / invalid usage
// ---------------------------------------------------------------------------

test("STRICT missing price: known usage + unknown model → unpriced_model, NOT zero", () => {
  const outcome = calculateInvocationCost({
    usage: { promptTokens: 100, completionTokens: 50 },
    pricing: resolvePriceModel(rec({ authorizedModelId: "opus-4.8", sentProviderId: "stub", sentProviderModelId: "opus-4.8" }).identity, CATALOG),
  });
  assert.equal(outcome.status, "unpriced_model");
  assert.equal(outcome.amountMicroUsd, undefined);
  assert.equal(outcome.hasUnknown, true);
});

test("STRICT missing usage: priced model + no usage → usage_not_reported, NOT zero", () => {
  const outcome = calculateInvocationCost({ usage: undefined, pricing: resolvePriceModel(rec().identity, CATALOG) });
  assert.equal(outcome.status, "usage_not_reported");
  assert.equal(outcome.amountMicroUsd, undefined);
  assert.equal(outcome.hasUnknown, true);
});

test("STRICT partial usage: input but no output → usage_partial floor, output NOT manufactured as 0", () => {
  const outcome = calculateInvocationCost({ usage: { promptTokens: 1000 }, pricing: resolvePriceModel(rec().identity, CATALOG) });
  assert.equal(outcome.status, "usage_partial");
  assert.equal(outcome.amountMicroUsd, 270, "the KNOWN input floor is priced");
  assert.equal(outcome.hasUnknown, true, "output cost stays unknown");
  assert.equal(outcome.breakdown?.outputMicroUsd, undefined, "no fabricated output=0 line");
});

test("STRICT invalid usage: negative / non-integer → invalid_usage, unknown", () => {
  assert.equal(calculateInvocationCost({ usage: { promptTokens: -5, completionTokens: 10 }, pricing: resolvePriceModel(rec().identity, CATALOG) }).status, "invalid_usage");
  assert.equal(calculateInvocationCost({ usage: { promptTokens: 1.5, completionTokens: 10 }, pricing: resolvePriceModel(rec().identity, CATALOG) }).status, "invalid_usage");
});

// ---------------------------------------------------------------------------
// Served-model pricing precedence
// ---------------------------------------------------------------------------

test("served model controls price: a reported+accepted served id prices by served, basis=served", () => {
  const r = resolvePriceModel(rec({ authorizedModelId: "deepseek-chat", servedModelId: "deepseek-chat", identityStatus: "match" }).identity, CATALOG);
  assert.equal(r.basis, "served");
  assert.equal(r.priceModelId, "deepseek-chat");
});

test("served model controls price: no served id falls to authorized, basis=authorized", () => {
  const r = resolvePriceModel(rec({ authorizedModelId: "deepseek-chat", identityStatus: "not_reported" }).identity, CATALOG);
  assert.equal(r.basis, "authorized");
});

test("served model controls price: a trusted served id NOT in the catalog does NOT fall back to authorized's rate", () => {
  // The provider served something the catalog cannot price. We must NOT price the (different)
  // authorized model — that would price a model that did not serve the request.
  const r = resolvePriceModel(rec({ authorizedModelId: "deepseek-chat", servedModelId: "deepseek-chat-0711", identityStatus: "match" }).identity, CATALOG);
  assert.equal(r.basis, "unresolved");
  const outcome = calculateInvocationCost({ usage: { promptTokens: 100, completionTokens: 50 }, pricing: r });
  assert.equal(outcome.status, "unpriced_model");
});

// ---------------------------------------------------------------------------
// Cache / special token semantics
// ---------------------------------------------------------------------------

test("cache tokens: a cached subset of prompt is NOT double-counted", () => {
  // deepseek-chat has no cache rate → cached tokens priced at the input rate (v1 fallback), but
  // the cached tokens are subtracted from the non-cached input, never charged twice.
  const full = calculateInvocationCost({ usage: { promptTokens: 1000, completionTokens: 0 }, pricing: resolvePriceModel(rec().identity, CATALOG) });
  const cached = calculateInvocationCost({ usage: { promptTokens: 1000, cachedPromptTokens: 400, completionTokens: 0 }, pricing: resolvePriceModel(rec().identity, CATALOG) });
  // With no distinct cache rate, cached==input rate, so totals match (no double count, no over-charge).
  assert.equal(full.amountMicroUsd, 270);
  assert.equal(cached.amountMicroUsd, 270);
  assert.equal((cached.breakdown?.inputMicroUsd ?? 0) + (cached.breakdown?.cacheReadMicroUsd ?? 0), 270);
});

test("cache tokens: a distinct cache rate is applied to the cached subset only", () => {
  const catalog: PricingCatalog = {
    version: "test",
    entries: [{ canonicalModelId: "m", routes: [{ providerId: "p", providerModelId: "m" }], inputPerMillionMicroUsd: 1_000_000, outputPerMillionMicroUsd: 2_000_000, cacheReadPerMillionMicroUsd: 100_000 }],
  };
  const identity = rec({ authorizedModelId: "m", sentProviderId: "p", sentProviderModelId: "m" }).identity;
  const outcome = calculateInvocationCost({ usage: { promptTokens: 1000, cachedPromptTokens: 600, completionTokens: 0 }, pricing: resolvePriceModel(identity, catalog) });
  // 400 non-cached @ 1.0/M = 400µ ; 600 cached @ 0.1/M = 60µ ; total 460µ.
  assert.equal(outcome.amountMicroUsd, 460);
  assert.equal(outcome.breakdown?.inputMicroUsd, 400);
  assert.equal(outcome.breakdown?.cacheReadMicroUsd, 60);
});

test("reasoning tokens: NOT charged unless the catalog bills them separately (no double count with completion)", () => {
  const outcome = calculateInvocationCost({ usage: { promptTokens: 0, completionTokens: 100, reasoningTokens: 5000 }, pricing: resolvePriceModel(rec({ authorizedModelId: "deepseek-reasoner", sentProviderModelId: "deepseek-reasoner" }).identity, CATALOG) });
  // reasoner output 2190000/M → 100 completion = 219µ. Reasoning tokens are ignored (assumed in completion).
  assert.equal(outcome.amountMicroUsd, 219);
  assert.equal(outcome.breakdown?.reasoningMicroUsd, undefined);
});

// ---------------------------------------------------------------------------
// InvocationCostRecord + dedup
// ---------------------------------------------------------------------------

test("invocation cost record: content-addressed, timings excluded from identity", () => {
  const a = buildInvocationCostRecord({ record: rec({ invocationId: "inv_x0000000", usage: { promptTokens: 10, completionTokens: 10 } }), catalog: CATALOG, catalogId: CATALOG_ID });
  const b = buildInvocationCostRecord({ record: { ...rec({ invocationId: "inv_x0000000", usage: { promptTokens: 10, completionTokens: 10 } }), startedAt: 999, endedAt: 1500 }, catalog: CATALOG, catalogId: CATALOG_ID });
  assert.equal(a.costId, b.costId, "clock is provenance, not identity");
});

test("STRICT double count: the same InvocationId charged twice with different content is a hard error", () => {
  const ctl = new SessionCostController({ buildSessionId: "sess_a", catalog: CATALOG, policy: DEFAULT_COST_BUDGET_POLICY });
  ctl.charge(rec({ invocationId: "inv_dupe0001", usage: { promptTokens: 100, completionTokens: 100 } }));
  assert.throws(
    () => ctl.charge(rec({ invocationId: "inv_dupe0001", usage: { promptTokens: 999, completionTokens: 1 } })),
    (e: unknown) => e instanceof CostAccountingError,
  );
});

test("dedup: charging the identical record twice contributes exactly once (idempotent)", () => {
  const ctl = new SessionCostController({ buildSessionId: "sess_a", catalog: CATALOG, policy: DEFAULT_COST_BUDGET_POLICY });
  const record = rec({ invocationId: "inv_idem0001", usage: { promptTokens: 1000, completionTokens: 0 } });
  ctl.charge(record);
  ctl.charge(record);
  ctl.reconcileAttempt({ runId: record.runId, attemptNumber: 1, records: [record], totalInvocationCount: 1 });
  const s = ctl.sessionSummary();
  assert.equal(s.totalInvocations, 1);
  assert.equal(s.totalKnownCostMicroUsd, 270);
});

// ---------------------------------------------------------------------------
// Attempt + session aggregation, role attribution, no-double-count proof
// ---------------------------------------------------------------------------

test("aggregation: session known cost == sum of attempt known costs, with per-role attribution", () => {
  const ctl = new SessionCostController({ buildSessionId: "sess_agg", catalog: CATALOG, policy: DEFAULT_COST_BUDGET_POLICY });
  // Attempt 1: builder (2 turns) + critic.
  const b1 = rec({ invocationId: "inv_a1b1", runId: "run_a1", role: "builder", usage: { promptTokens: 1000, completionTokens: 500 } }); // 820
  const b2 = rec({ invocationId: "inv_a1b2", runId: "run_a1", role: "builder", usage: { promptTokens: 2000, completionTokens: 0 } }); // 540
  const c1 = rec({ invocationId: "inv_a1c1", runId: "run_a1", role: "critic", authorizedModelId: "mimo-v2.5-pro", sentProviderId: "mimo", sentProviderModelId: "mimo-v2.5-pro", usage: { promptTokens: 1000, completionTokens: 100 } }); // 435 + 87 = 522
  for (const r of [b1, b2, c1]) ctl.charge(r);
  const a1 = ctl.reconcileAttempt({ runId: "run_a1", attemptNumber: 1, records: [b1, b2, c1], totalInvocationCount: 3 });
  assert.equal(a1.knownCostMicroUsd, 820 + 540 + 522);
  assert.equal(a1.invocationCount, 3);

  const s = ctl.sessionSummary();
  const sumAttempts = s.attempts.reduce((n, a) => n + a.knownCostMicroUsd, 0);
  assert.equal(s.totalKnownCostMicroUsd, sumAttempts, "sum(attempt known) == session known");
  const builder = s.roles.find((r) => r.role === "builder")!;
  const critic = s.roles.find((r) => r.role === "critic")!;
  assert.equal(builder.knownCostMicroUsd, 820 + 540);
  assert.equal(critic.knownCostMicroUsd, 522);
  assert.equal(builder.observedInputTokens, 3000);
});

test("failed-without-usage: a call that reached the wire but left no record is counted, cost unknown", () => {
  const ctl = new SessionCostController({ buildSessionId: "sess_fail", catalog: CATALOG, policy: DEFAULT_COST_BUDGET_POLICY });
  const ok = rec({ invocationId: "inv_ok01", usage: { promptTokens: 100, completionTokens: 100 } });
  ctl.charge(ok);
  // The run recorded 2 invocations on the ledger (evidence.invocations) but only 1 produced a record.
  const a = ctl.reconcileAttempt({ runId: ok.runId, attemptNumber: 1, records: [ok], totalInvocationCount: 2 });
  assert.equal(a.failedInvocationsWithoutUsage, 1);
  assert.equal(a.invocationCount, 2);
  assert.equal(a.hasUnknownCost, true, "a recordless failed call makes the total a floor");
  const s = ctl.sessionSummary();
  assert.equal(s.hasUnknownCost, true);
  assert.equal(s.totalInvocations, 2);
});

// ---------------------------------------------------------------------------
// Budget — pre-call admission
// ---------------------------------------------------------------------------

test("budget: no ceiling admits everything", () => {
  const d = admitNextInvocation({ policy: DEFAULT_COST_BUDGET_POLICY, state: { priorKnownSpendMicroUsd: 999_999_999, priorHasUnknownCost: false, invocationsSoFar: 999, attemptKnownSpendMicroUsd: 0 }, next: { unpriced: false, maxCostMicroUsd: 1000 } });
  assert.equal(d.admit, true);
});

test("budget: a next call whose max would breach the session ceiling is refused BEFORE the call", () => {
  const policy = buildCostBudgetPolicy({ maxSessionCostMicroUsd: 1000 });
  const d = admitNextInvocation({ policy, state: { priorKnownSpendMicroUsd: 600, priorHasUnknownCost: false, invocationsSoFar: 1, attemptKnownSpendMicroUsd: 600 }, next: { unpriced: false, maxCostMicroUsd: 500 } });
  assert.equal(d.admit, false);
  if (!d.admit) {
    assert.equal(d.failure.code, "policy.cost_next_call_exceeds_budget");
    assert.equal(d.failure.category, "policy");
    assert.equal(d.failure.retryable, false);
  }
});

test("budget: exhausted session ceiling refuses (require operator)", () => {
  const policy = buildCostBudgetPolicy({ maxSessionCostMicroUsd: 1000 });
  const d = admitNextInvocation({ policy, state: { priorKnownSpendMicroUsd: 1000, priorHasUnknownCost: false, invocationsSoFar: 3, attemptKnownSpendMicroUsd: 0 }, next: { unpriced: false, maxCostMicroUsd: 1 } });
  assert.equal(d.admit, false);
  if (!d.admit) assert.equal(d.failure.code, "policy.cost_session_budget_exhausted");
});

test("budget: an invocation cap stops the next call regardless of money", () => {
  const policy = buildCostBudgetPolicy({ maxInvocations: 4 });
  const d = admitNextInvocation({ policy, state: { priorKnownSpendMicroUsd: 0, priorHasUnknownCost: false, invocationsSoFar: 4, attemptKnownSpendMicroUsd: 0 }, next: { unpriced: false, maxCostMicroUsd: 0 } });
  assert.equal(d.admit, false);
  if (!d.admit) assert.equal(d.failure.code, "policy.cost_invocation_cap_exhausted");
});

test("unknown-cost policy: default (operator_required) stops on unknown prior spend under a ceiling", () => {
  const policy = buildCostBudgetPolicy({ maxSessionCostMicroUsd: 10_000 });
  const d = admitNextInvocation({ policy, state: { priorKnownSpendMicroUsd: 100, priorHasUnknownCost: true, invocationsSoFar: 1, attemptKnownSpendMicroUsd: 100 }, next: { unpriced: false, maxCostMicroUsd: 1 } });
  assert.equal(d.admit, false);
  if (!d.admit) {
    assert.equal(d.requiresOperator, true);
    assert.equal(d.failure.code, "policy.cost_unknown_requires_operator");
  }
});

test("unknown-cost policy: allow_unknown proceeds despite unknown prior spend", () => {
  const policy = buildCostBudgetPolicy({ maxSessionCostMicroUsd: 10_000, behaviorWhenCostUnknown: "allow_unknown" });
  const d = admitNextInvocation({ policy, state: { priorKnownSpendMicroUsd: 100, priorHasUnknownCost: true, invocationsSoFar: 1, attemptKnownSpendMicroUsd: 100 }, next: { unpriced: false, maxCostMicroUsd: 1 } });
  assert.equal(d.admit, true);
});

test("unknown-cost policy: an unpriced NEXT model under a ceiling stops (cannot bound the call)", () => {
  const policy = buildCostBudgetPolicy({ maxSessionCostMicroUsd: 10_000 });
  const d = admitNextInvocation({ policy, state: { priorKnownSpendMicroUsd: 0, priorHasUnknownCost: false, invocationsSoFar: 0, attemptKnownSpendMicroUsd: 0 }, next: { unpriced: true } });
  assert.equal(d.admit, false);
  if (!d.admit) assert.equal(d.failure.code, "policy.cost_unpriced_model_under_budget");
});

test("next-call max: a conservative bound uses input estimate + maxOutputTokens at catalog rates", () => {
  const pricing = resolvePriceModel(rec({ authorizedModelId: "deepseek-chat" }).identity, CATALOG);
  const next = estimateMaxNextCallCost({ pricing, estimatedInputTokens: 1000, maxOutputTokens: 500 });
  // 1000 input @ 270000/M = 270µ ; 500 output @ 1100000/M = 550µ ; max = 820µ.
  assert.equal(next.unpriced, false);
  assert.equal(next.maxCostMicroUsd, 820);
});

// ---------------------------------------------------------------------------
// Recovery / repair budget span — the SAME wallet across attempts
// ---------------------------------------------------------------------------

test("recovery budget: attempt 2 sees remaining budget = ceiling - attempt-1 spend (no reset)", () => {
  const policy = buildCostBudgetPolicy({ maxSessionCostMicroUsd: 2000 });
  const ctl = new SessionCostController({ buildSessionId: "sess_rec", catalog: CATALOG, policy });

  // Attempt 1 spends 820µ.
  const a1 = rec({ invocationId: "inv_r1", runId: "run_r1", usage: { promptTokens: 1000, completionTokens: 500 } });
  ctl.charge(a1);
  ctl.reconcileAttempt({ runId: "run_r1", attemptNumber: 1, records: [a1], totalInvocationCount: 1 });

  // Attempt 2 (a semantic-repair / environmental retry) admits against the REMAINING budget.
  // A call whose max is 1300µ would exceed 2000-820=1180 remaining → refused.
  const overBudget = ctl.admitNext({ identity: { authorizedModelId: "deepseek-chat", sentProviderId: "deepseek", sentProviderModelId: "deepseek-chat" }, estimatedInputTokens: 1000, maxOutputTokens: 1000 });
  // max = 270 (input) + 1100 (1000 output) = 1370 > 1180 remaining → refused.
  assert.equal(overBudget.admit, false);

  // A cheaper call within the remaining budget is admitted.
  const withinBudget = ctl.admitNext({ identity: { authorizedModelId: "deepseek-chat", sentProviderId: "deepseek", sentProviderModelId: "deepseek-chat" }, estimatedInputTokens: 100, maxOutputTokens: 100 });
  assert.equal(withinBudget.admit, true);

  // Charge attempt 2 and prove the session total spans BOTH attempts.
  const a2 = rec({ invocationId: "inv_r2", runId: "run_r2", usage: { promptTokens: 100, completionTokens: 100 } }); // 27 + 110 = 137
  ctl.charge(a2);
  ctl.reconcileAttempt({ runId: "run_r2", attemptNumber: 2, records: [a2], totalInvocationCount: 1 });
  const s = ctl.sessionSummary();
  assert.equal(s.attempts.length, 2);
  assert.equal(s.totalKnownCostMicroUsd, 820 + 137, "both attempts counted; attempt 2 did NOT reset the wallet");
  assert.equal(s.budgetRemainingMicroUsd, 2000 - (820 + 137));
});

test("session summary: freezes the pricing catalog id + version + budget policy id", () => {
  const policy = buildCostBudgetPolicy({ maxSessionCostMicroUsd: 5000 });
  const ctl = new SessionCostController({ buildSessionId: "sess_meta", catalog: CATALOG, policy });
  ctl.reconcileAttempt({ runId: "run_m", attemptNumber: 1, records: [], totalInvocationCount: 0 });
  const s = ctl.sessionSummary();
  assert.equal(s.pricingCatalogId, CATALOG_ID);
  assert.equal(s.pricingCatalogVersion, CATALOG.version);
  assert.equal(s.budgetPolicyId, policy.policyId);
  assert.equal(s.totalKnownCostMicroUsd, 0);
  assert.equal(s.hasUnknownCost, false);
});
