/**
 * PHASE 14 — PROVIDER-ATTEMPT AUTHORITY at the lowest dispatch seam.
 *
 * Closes IKBI-REAUDIT2-003 (the ledger presented the logical REQUESTED model as the SERVED identity, and the
 * lane check ran on the requested model) and -004 (thrown CHARGED provider failures + per-retry/fallback
 * identity disappeared; run totals did not derive from unique provider attempts).
 *
 * The invariant: every actual provider attempt has one durable record created from the REAL response / thrown
 * failure — never synthesized from configuration. Served identity is provider-reported, never the requested
 * alias; charged failures are preserved; spend derives from unique provider attempts.
 *
 * Part A unit-tests the InvocationLedger (the execution authority) against a low-seam invoker that returns
 * `ModelResponse.attempts` / throws `AllProvidersFailedError.attempts`. Part B drives the classifier seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";


import type { ModelRequest, ModelResponse, ProviderAttempt } from "../../core/provider/contract.js";
import { AllProvidersFailedError } from "../../core/provider/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { InvocationLedger } from "./invocation-ledger.js";


/** A ModelResponse with explicit served identity + provider attempts. */
function resp(over: Partial<ModelResponse> & { attempts?: readonly ProviderAttempt[] } = {}): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "deepseek-v4-flash", provider: "deepseek", providerModelId: "deepseek-chat-v4",
    content: "ok", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    cost: { usd: 0.003, promptUsd: 0.001, cachedUsd: 0, completionUsd: 0.002, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: over.attempts ?? [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "success", latencyMs: 1, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, costUsd: 0.003 }],
    ...over,
  };
}
function ledgerWith(invokeModel: (r: ModelRequest) => Promise<ModelResponse>, opts: { laneMember?: (m: string, l: string) => boolean; servedOutOfLane?: (m: string, l: string) => boolean } = {}) {
  return new InvocationLedger({ invokeModel, neutralizeUntrusted: (c, x) => coreNeutralize(c, x), runId: "r", taskId: "t", now: () => 0, ...opts });
}
const REQ = { model: "deepseek-v4-flash", messages: [] } as unknown as ModelRequest;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — served identity (REAUDIT2-003)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("A1 [MUTATION 7,8] (req 25,26,27): the SERVED identity is provider-reported — the requested alias is never copied into servedModel", async () => {
  const led = ledgerWith(async () => resp({ model: "deepseek-v4-flash", providerModelId: "deepseek-chat-v4", provider: "deepseek" }));
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  const rec = led.all()[0]!;
  assert.equal(rec.servedModel, "deepseek-chat-v4", "servedModel is the provider-reported concrete model, not the requested alias");
  assert.equal(rec.servedProvider, "deepseek");
  assert.equal(rec.servedIdentityStatus, "confirmed", "provider metadata present ⇒ confirmed");
  assert.notEqual(rec.servedModel, "deepseek-v4-flash", "the requested alias is NOT the served model");
});

test("A2 [MUTATION 8] (req 27): ABSENT provider metadata ⇒ servedIdentityStatus 'unavailable' (never fabricated confirmed)", async () => {
  const led = ledgerWith(async () => resp({ provider: "", providerModelId: "", attempts: [{ provider: "", providerModelId: "", outcome: "success", latencyMs: 1 }] }));
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  const rec = led.all()[0]!;
  assert.equal(rec.servedIdentityStatus, "unavailable", "no provider metadata ⇒ unavailable, not confirmed");
  assert.equal(rec.servedModel, undefined, "no fabricated served model");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — provider-attempt records + retries/fallbacks (reqs 13-16, 36, 45)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("B1 [MUTATION 1] (req 1,2,13,16): each ACTUAL attempt (retry + fallback) is a DISTINCT provider-attempt record", async () => {
  const attempts: ProviderAttempt[] = [
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "error", latencyMs: 1, error: "rate_limited", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 }, costUsd: 0.0005 },
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "success", latencyMs: 1, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, costUsd: 0.003 },
  ];
  const led = ledgerWith(async () => resp({ attempts, fellBack: true }));
  await led.withContext({ role: "critic", stage: "role" }, () => led.engine.invokeModel(REQ));
  const pa = led.providerAttempts();
  assert.equal(pa.length, 2, "one first attempt + one retry = two distinct provider attempts");
  assert.notEqual(pa[0]!.providerAttemptId, pa[1]!.providerAttemptId, "distinct attempt ids");
  assert.equal(pa[0]!.outcome, "error");
  assert.equal(pa[1]!.outcome, "success");
});

test("B2 [MUTATION 5,9] (req 18,19,39): a THROWN failure with CHARGED attempts preserves their cost (never dropped)", async () => {
  const charged: ProviderAttempt[] = [
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "error", latencyMs: 1, error: "500", usage: { promptTokens: 8, completionTokens: 0, totalTokens: 8 }, costUsd: 0.0008 },
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "permanent_error", latencyMs: 1, error: "content_filter", costUsd: 0.0002 },
  ];
  const led = ledgerWith(async () => { throw new AllProvidersFailedError("deepseek-v4-flash", charged); });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ)));
  const rec = led.all()[0]!;
  assert.equal(rec.costUsd, 0.001, "the charged failed attempts' cost is preserved (0.0008 + 0.0002)");
  assert.equal(rec.costStatus, "measured");
  assert.equal(rec.providerAttempts?.length, 2, "both failed attempts are recorded");
  assert.equal(led.chargedFailureCount(), 2, "both charged failures are counted (never dropped)");
  assert.equal(led.cost(), 0.001, "the run total includes the charged thrown failure");
});

test("B3 [MUTATION 5] (req 20): a thrown failure WITHOUT usage/cost is UNKNOWN, not zero", async () => {
  const led = ledgerWith(async () => { throw new AllProvidersFailedError("deepseek-v4-flash", [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "timeout", latencyMs: 1 }]); });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ)));
  assert.equal(led.costStatus(), "partial", "an unknown-cost thrown attempt makes the aggregate partial");
  assert.equal(led.all()[0]!.costStatus, "unavailable");
});

test("B4 (req 4): a PRE-DISPATCH lane block is NOT a billable provider attempt", async () => {
  const led = ledgerWith(async () => resp(), { laneMember: (m, l) => m.startsWith(l) });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role", vendorLane: "deepseek" }, () => led.engine.invokeModel({ model: "mimo-v2.5", messages: [] } as unknown as ModelRequest)));
  assert.equal(led.providerAttempts().length, 0, "a blocked-before-dispatch call created no provider attempt");
  assert.equal(led.all()[0]!.status, "lane-blocked");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part C — cost derivation from unique provider attempts (reqs 37,38,44)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("C1 [MUTATION 9] (req 37,38): run/logical spend DERIVES from unique provider attempts (incl. charged failures + retries)", async () => {
  let call = 0;
  const led = ledgerWith(async () => {
    call += 1;
    if (call === 1) return resp({ attempts: [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "error", latencyMs: 1, costUsd: 0.001 }, { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "success", latencyMs: 1, costUsd: 0.004 }] });
    return resp({ attempts: [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "success", latencyMs: 1, costUsd: 0.002 }] });
  });
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  await led.withContext({ role: "critic", stage: "role" }, () => led.engine.invokeModel(REQ));
  const pac = led.providerAttemptCost();
  assert.equal(pac.usd, 0.007, "0.001 (failed retry) + 0.004 (success) + 0.002 (2nd invocation) — every unique attempt");
  assert.equal(pac.status, "complete");
  assert.equal(led.providerAttempts().length, 3);
});

test("C2 (req 44): an unknown-cost provider attempt marks the aggregate PARTIAL", async () => {
  const led = ledgerWith(async () => resp({ attempts: [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "success", latencyMs: 1 /* no cost */ }] }));
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  assert.equal(led.providerAttemptCost().status, "partial", "an attempt with no cost ⇒ partial aggregate");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part D — served-identity lane enforcement (reqs 28,29)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("D1 (req 28): a CONFIRMED cross-lane SERVED identity fails closed (execution-identity violation)", async () => {
  // Requested deepseek lane; the provider SERVED a mimo model (providerModelId reports it) ⇒ violation.
  const led = ledgerWith(async () => resp({ provider: "mimo", providerModelId: "mimo-v2.5-pro", attempts: [{ provider: "mimo", providerModelId: "mimo-v2.5-pro", outcome: "success", latencyMs: 1, costUsd: 0.003 }] }), { servedOutOfLane: (m, l) => (l === "deepseek" ? m.startsWith("mimo") : false) });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role", vendorLane: "deepseek" }, () => led.engine.invokeModel(REQ)), /lane violation/);
  assert.equal(led.executionIdentityViolations(), 1, "the cross-lane SERVED identity is a violation");
  assert.equal(led.all()[0]!.servedModel, "mimo-v2.5-pro", "the violation records the truthful served identity");
});

test("D2 (req 29): an UNCONFIRMED served identity is NOT falsely classified cross-lane", async () => {
  // The provider does not report served identity (empty metadata); the lane check must NOT fire on absence.
  const led = ledgerWith(async () => resp({ provider: "", providerModelId: "", attempts: [{ provider: "", providerModelId: "", outcome: "success", latencyMs: 1, costUsd: 0.003 }] }), { servedOutOfLane: () => true /* would flag everything */ });
  const r = await led.withContext({ role: "builder", stage: "role", vendorLane: "deepseek" }, () => led.engine.invokeModel(REQ));
  assert.equal(r.content, "ok", "the call succeeds — absent metadata is not a violation");
  assert.equal(led.executionIdentityViolations(), 0, "no violation on unconfirmed served identity");
  assert.equal(led.all()[0]!.servedIdentityStatus, "unavailable");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part E — external adapters (classifier/consult) carry served identity + attempts (reqs 5,30)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("E1 [MUTATION 2] (req 5,30): recordExternal (classifier/consult seam) carries provider attempts + served status, never fabricated confirmation", () => {
  const led = ledgerWith(async () => resp());
  const id = led.recordExternal({ role: "classifier", stage: "classify", requestedAlias: "deepseek-flash", resolvedModel: "deepseek-chat-v4", provider: "deepseek", providerModelId: "deepseek-chat-v4", costUsd: 0.0004, attempts: [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "success", latencyMs: 1, costUsd: 0.0004 }] });
  const rec = led.all().find((r) => r.invocationId === id)!;
  assert.equal(rec.servedIdentityStatus, "confirmed", "provider-reported ⇒ confirmed");
  assert.equal(rec.servedModel, "deepseek-chat-v4");
  assert.equal(rec.providerAttempts?.length, 1, "the classifier's real provider attempt is recorded");
  assert.equal(rec.providerAttempts?.[0]!.providerAttemptId.includes(":classifier:"), true, "the attempt id references the classifier logical invocation");
});

test("E2 (req 31): a consult-style external WITHOUT provider metadata is recorded UNCONFIRMED (not fabricated served)", () => {
  const led = ledgerWith(async () => resp());
  const id = led.recordExternal({ role: "consult", stage: "frontier-consult", requestedAlias: "opus-4.8", resolvedModel: "opus-4.8", provider: "anthropic", costUsd: 0.05 });
  const rec = led.all().find((r) => r.invocationId === id)!;
  assert.equal(rec.servedIdentityStatus, "unconfirmed", "no provider-reported concrete model ⇒ unconfirmed served identity");
  assert.equal(rec.servedModel, undefined, "the requested model is not copied into servedModel");
});
