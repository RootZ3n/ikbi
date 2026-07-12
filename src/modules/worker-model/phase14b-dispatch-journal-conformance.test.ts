/**
 * PHASE 14B — DISPATCH JOURNAL + COMPOSITE EXECUTION AUTHORITY.
 *
 * Closes IKBI-REAUDIT2 "final closure": (Part A) a provider-attempt record is ALLOCATED + marked `dispatched`
 * BEFORE the provider is called, then FINALIZED IN PLACE from the real response / thrown failure — never a
 * replacement record created after return. A call that hangs leaves a visible `dispatched` record that can be
 * finalized to `unknown-terminal`; an attempt is never deleted. (Part B) a PARENT composite operation spans
 * multiple worker runs (a conditional duel, a multi-step build, a tournament/competitive selection, a CLI
 * cognition+worker command) and aggregates the UNION of unique provider-attempt ids across every child —
 * winning, losing, and failed — each counted exactly once; partial when any cost is unknown.
 *
 * The authority invariant under test: "Every provider dispatch is recorded before the provider is called,
 * finalized from the response or failure, and included exactly once in its logical invocation, run, and parent
 * composite operation."
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelRequest, ModelResponse, ProviderAttempt } from "../../core/provider/contract.js";
import { AllProvidersFailedError } from "../../core/provider/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { InvocationLedger } from "./invocation-ledger.js";
import { CompositeOperationLedger, type CompositeProviderAttempt, type ChildRunRole } from "./composite-ledger.js";
import { formatCompositeCost } from "./cli.js";

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

/** A deferred promise whose resolution/rejection the test controls — models an in-flight provider call. */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — PRE-DISPATCH JOURNAL (the record exists before the provider promise resolves)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("A1 [MUT: attempt created only after return] (req 1): a DISPATCHED record exists BEFORE the provider promise resolves", async () => {
  const d = deferred<ModelResponse>();
  const led = ledgerWith(() => d.promise);
  const inflight = led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  // The provider promise has NOT resolved yet — but a durable dispatched record must already exist.
  await Promise.resolve(); // let invoke() run up to the awaited provider call
  const pending = led.pendingAttempts();
  assert.equal(pending.length, 1, "a dispatched record exists before the provider returns");
  assert.equal(pending[0]!.status, "dispatched");
  d.resolve(resp());
  await inflight;
});

test("A2 [MUT: attempt created only after return] (req 2,7): SUCCESS finalizes the SAME record in place — no duplicate", async () => {
  const led = ledgerWith(async () => resp());
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  assert.equal(led.all().length, 1, "one dispatched record finalized in place = exactly one record (no replacement)");
  assert.equal(led.all()[0]!.status, "succeeded");
  assert.equal(led.pendingAttempts().length, 0, "no lingering dispatched record after finalize");
});

test("A3 [MUT: attempt created only after return] (req 3): a THROWN failure finalizes the SAME record (not a new one)", async () => {
  const led = ledgerWith(async () => { throw new AllProvidersFailedError("deepseek-v4-flash", [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "timeout", latencyMs: 1 }]); });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ)));
  assert.equal(led.all().length, 1, "the pre-dispatch record was finalized in place by the failure");
  assert.equal(led.all()[0]!.status, "timeout");
});

test("A4 [MUT: timeout deletes dispatched record] (req 4,5): a HUNG provider leaves a visible dispatched record before any timeout", async () => {
  const d = deferred<ModelResponse>();
  const led = ledgerWith(() => d.promise);
  void led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  await Promise.resolve();
  assert.equal(led.pendingAttempts().length, 1, "the hung call has a durable dispatched record");
  // The attempt is NEVER deleted — teardown finalizes it to unknown-terminal, preserving it.
  led.finalizeStalePending();
  assert.equal(led.pendingAttempts().length, 0);
  assert.equal(led.all().length, 1, "the record survives — not deleted");
  assert.equal(led.all()[0]!.status, "unknown-terminal", "the hung dispatch is preserved as unknown-terminal");
  d.resolve(resp());
});

test("A5 [MUT: timeout deletes dispatched record] (req 6): finalizeStalePending preserves the attempt id + dispatch identity", async () => {
  const d = deferred<ModelResponse>();
  const led = ledgerWith(() => d.promise);
  void led.withContext({ role: "critic", stage: "role" }, () => led.engine.invokeModel(REQ));
  await Promise.resolve();
  const before = led.pendingAttempts()[0]!;
  led.finalizeStalePending();
  const after = led.all()[0]!;
  assert.equal(after.invocationId, before.invocationId, "the same invocation id survives finalization");
  assert.equal(after.role, "critic");
  assert.notEqual(after.completedAt, undefined, "an unknown-terminal record is completed");
  d.resolve(resp());
});

test("A6 [MUT: blocked call still billable] (req 4): a BLOCKED-before-dispatch call yields no dispatched attempt", async () => {
  const led = ledgerWith(async () => resp(), { laneMember: (m, l) => m.startsWith(l) });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role", vendorLane: "deepseek" }, () => led.engine.invokeModel({ model: "mimo-v2.5", messages: [] } as unknown as ModelRequest)));
  assert.equal(led.pendingAttempts().length, 0, "a blocked call never entered the dispatched state");
  assert.equal(led.providerAttempts().length, 0, "no billable provider attempt");
  assert.equal(led.all()[0]!.status, "lane-blocked");
  assert.equal(led.invocationCount(), 0, "a pre-dispatch block is not a counted execution");
});

test("A7 [MUT: attempts[] duplicated] (req 8): attempts[] ENRICH the pre-existing record — one logical record, N attempts", async () => {
  const attempts: ProviderAttempt[] = [
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "error", latencyMs: 1, costUsd: 0.001 },
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "success", latencyMs: 1, costUsd: 0.004 },
  ];
  const led = ledgerWith(async () => resp({ attempts, fellBack: true }));
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  assert.equal(led.all().length, 1, "the returned attempts ENRICH one logical record — they do not create extra logical records");
  assert.equal(led.all()[0]!.providerAttempts?.length, 2, "both provider attempts attributed to the one record");
});

test("A8 (req 12): SERVED identity is EMPTY on the in-flight dispatched record (filled only from the response)", async () => {
  const d = deferred<ModelResponse>();
  const led = ledgerWith(() => d.promise);
  void led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  await Promise.resolve();
  const pending = led.pendingAttempts()[0]!;
  assert.equal(pending.servedModel, undefined, "no served model before the provider responds");
  assert.equal(pending.servedIdentityStatus, "unavailable", "served identity is unavailable pre-response, never the requested alias");
  d.resolve(resp());
});

test("A9 [MUT: requested copied to confirmed served] (req 11,14): the REQUESTED alias is never promoted to a confirmed served identity", async () => {
  const led = ledgerWith(async () => resp({ providerModelId: "deepseek-chat-v4", provider: "deepseek" }));
  await led.withContext({ role: "builder", stage: "role", requestedAlias: "deepseek-v4-flash" }, () => led.engine.invokeModel(REQ));
  const rec = led.all()[0]!;
  assert.equal(rec.requestedAlias, "deepseek-v4-flash");
  assert.notEqual(rec.servedModel, "deepseek-v4-flash", "the requested alias is not the served model");
  assert.equal(rec.servedModel, "deepseek-chat-v4");
});

test("A10 (req 8): the finalized SUCCESS record carries the response's served identity + cost (enrichment, not fabrication)", async () => {
  const led = ledgerWith(async () => resp());
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  const rec = led.all()[0]!;
  assert.equal(rec.status, "succeeded");
  assert.equal(rec.servedIdentityStatus, "confirmed");
  assert.equal(rec.costUsd, 0.003);
  assert.equal(rec.costStatus, "measured");
});

test("A11 [MUT: failed charged disappears] (req 18,19): a CHARGED thrown failure survives finalization in place", async () => {
  const charged: ProviderAttempt[] = [
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "error", latencyMs: 1, costUsd: 0.0008 },
    { provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "permanent_error", latencyMs: 1, costUsd: 0.0002 },
  ];
  const led = ledgerWith(async () => { throw new AllProvidersFailedError("deepseek-v4-flash", charged); });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ)));
  assert.equal(led.all().length, 1);
  assert.equal(led.all()[0]!.costUsd, 0.001, "the charged failure's cost is preserved on the finalized record");
  assert.equal(led.chargedFailureCount(), 2);
});

test("A12 (req 20): a thrown failure WITHOUT cost finalizes to UNKNOWN cost, never zero", async () => {
  const led = ledgerWith(async () => { throw new AllProvidersFailedError("deepseek-v4-flash", [{ provider: "deepseek", providerModelId: "deepseek-chat-v4", outcome: "timeout", latencyMs: 1 }]); });
  await assert.rejects(() => led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ)));
  assert.equal(led.all()[0]!.costStatus, "unavailable");
  assert.equal(led.costStatus(), "partial");
});

test("A13 [MUT: classifier synthetic afterward] (req 9,10): the classifier records THROUGH the ledger before it needs a synthetic id", async () => {
  const led = ledgerWith(async () => resp());
  const id = led.recordExternal({ role: "classifier", stage: "classify", resolvedModel: "deepseek-chat-v4", provider: "deepseek", providerModelId: "deepseek-chat-v4", costUsd: 0.0001, status: "succeeded" });
  assert.match(id, /:classifier:classify:/, "the classifier attempt has a real ledger-derived id (not a post-facto synthetic)");
  assert.equal(led.all().length, 1);
  assert.equal(led.all()[0]!.role, "classifier");
});

test("A14 (req 10): a classifier that makes NO provider call creates NO attempt", async () => {
  const led = ledgerWith(async () => resp());
  // No recordExternal, no engine.invokeModel — a no-call classifier.
  assert.equal(led.all().length, 0, "no dispatch ⇒ no attempt record");
  assert.equal(led.providerAttempts().length, 0);
});

test("A15 (req 6): every dispatch is finalized — no record is left dispatched after a completed run", async () => {
  const led = ledgerWith(async () => resp());
  await led.withContext({ role: "builder", stage: "role" }, () => led.engine.invokeModel(REQ));
  await led.withContext({ role: "critic", stage: "role" }, () => led.engine.invokeModel(REQ));
  assert.equal(led.pendingAttempts().length, 0, "no dangling dispatched records after a normal run");
  assert.equal(led.all().every((r) => r.status !== "dispatched"), true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — COMPOSITE OPERATION LEDGER (parent authority across multiple runs)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Build a compact provider-attempt projection for a child run. */
function pa(id: string, costUsd?: number, costStatus: CompositeProviderAttempt["costStatus"] = costUsd === undefined ? "unavailable" : (costUsd > 0 ? "measured" : "measured-zero")): CompositeProviderAttempt {
  return { providerAttemptId: id, ...(costUsd !== undefined ? { costUsd } : {}), costStatus };
}
function child(childId: string, role: ChildRunRole, attempts: CompositeProviderAttempt[], opts: { outcome?: string; selected?: boolean; strategy?: string } = {}) {
  return { childId, strategy: opts.strategy ?? "moe-expert-rental", role, outcome: opts.outcome ?? "success", ...(opts.selected !== undefined ? { selected: opts.selected } : {}), providerAttempts: attempts };
}

test("B1 (req 26): a PRIMARY-only success composite has no peer attempts", () => {
  const c = new CompositeOperationLedger("composite:t1", "t1", "conditional-duel");
  c.registerChild(child("t1", "primary", [pa("t1#pa1", 0.005)], { selected: true }));
  assert.equal(c.childRunsWithRole("peer").length, 0, "no peer child when the primary succeeded first");
  assert.equal(c.compositeCost().usd, 0.005);
  assert.equal(c.providerAttemptIds().length, 1);
});

test("B2 [MUT: duel aggregate winner-only] (req 27,28): a DUEL composite includes primary AND peer cost — the losing peer is never dropped", () => {
  const c = new CompositeOperationLedger("composite:t1", "t1", "conditional-duel");
  c.registerChild(child("t1-primary", "primary", [pa("t1-primary#pa1", 0.004)], { outcome: "non_promotable" }));
  c.registerChild(child("t1-peer", "peer", [pa("t1-peer#pa1", 0.006)], { selected: true }));
  assert.equal(c.compositeCost().usd, 0.01, "primary (0.004) + peer (0.006) = full duel cost");
  assert.equal(c.childRuns().length, 2);
});

test("B3 [MUT: duel aggregate winner-only] (req 28): a LOSING primary's cost stays included when the peer wins", () => {
  const c = new CompositeOperationLedger("composite:t1", "t1", "conditional-duel");
  c.registerChild(child("t1-primary", "primary", [pa("t1-primary#pa1", 0.004)], { outcome: "non_promotable", selected: false }));
  c.registerChild(child("t1-peer", "peer", [pa("t1-peer#pa1", 0.006)], { selected: true }));
  const selected = c.selectedChild();
  assert.equal(selected?.childId, "t1-peer", "the peer is the selected child");
  assert.equal(c.compositeCost().usd, 0.01, "selecting the peer does NOT erase the primary's spend");
});

test("B4 [MUT: tournament omits losers] (req 29,30): a TOURNAMENT composite includes ALL candidates + evaluators", () => {
  const c = new CompositeOperationLedger("composite:t2", "t2", "tournament");
  c.registerChild(child("cand-a", "tournament-candidate", [pa("t2:cand-a#pa1", 0.003)]));
  c.registerChild(child("cand-b", "tournament-candidate", [pa("t2:cand-b#pa1", 0.004)], { selected: true }));
  c.registerChild(child("cand-c", "tournament-candidate", [pa("t2:cand-c#pa1", 0.002)], { outcome: "eliminated" }));
  c.registerChild(child("eval", "evaluator", [pa("t2:eval#pa1", 0.001)]));
  assert.equal(c.childRunsWithRole("tournament-candidate").length, 3, "all 3 candidates included");
  assert.equal(c.childRunsWithRole("evaluator").length, 1, "the evaluator is included");
  assert.ok(Math.abs(c.compositeCost().usd - 0.01) < 1e-9, "0.003+0.004+0.002+0.001 — losers + evaluator all counted");
});

test("B5 [MUT: tournament omits losers] (req 31): a COMPETITIVE composite includes all candidates + the evaluator", () => {
  const c = new CompositeOperationLedger("composite:t3", "t3", "competitive");
  c.registerChild(child("cc-a", "competitive-candidate", [pa("t3:cc-a#pa1", 0.005)], { selected: true }));
  c.registerChild(child("cc-b", "competitive-candidate", [pa("t3:cc-b#pa1", 0.005)], { outcome: "lost" }));
  c.registerChild(child("cc-eval", "evaluator", [pa("t3:cc-eval#pa1", 0.002)]));
  assert.equal(c.compositeCost().usd, 0.012);
  assert.equal(c.childRunsWithRole("competitive-candidate").length, 2);
});

test("B6 [MUT: multi-step final-only] (req 32,33): a MULTI-STEP composite includes ALL steps + the finalizer, not only the last child", () => {
  const c = new CompositeOperationLedger("composite:t4", "t4", "multi-step");
  c.registerChild(child("step-1", "step", [pa("t4-s1#pa1", 0.003)]));
  c.registerChild(child("step-2", "step", [pa("t4-s2#pa1", 0.004)]));
  c.registerChild(child("step-3", "step", [pa("t4-s3#pa1", 0.003)]));
  c.registerChild(child("finalizer", "finalizer", [pa("t4-fin#pa1", 0.002)], { selected: true }));
  assert.equal(c.compositeCost().usd, 0.012, "the multi-step total is the FULL build op (all steps + finalizer), not only the finalizer");
  assert.equal(c.childRunsWithRole("step").length, 3);
});

test("B7 (req 34): composite cost DEDUPES a provider-attempt id shared across children (a shared ledger counted once)", () => {
  const c = new CompositeOperationLedger("composite:t5", "t5", "tournament");
  // Two children projecting from a SHARED ledger expose overlapping ids — the shared one must count ONCE.
  c.registerChild(child("cand-a", "tournament-candidate", [pa("shared#pa1", 0.003), pa("t5:a#pa2", 0.002)]));
  c.registerChild(child("cand-b", "tournament-candidate", [pa("shared#pa1", 0.003), pa("t5:b#pa2", 0.004)]));
  assert.equal(c.providerAttemptIds().length, 3, "shared#pa1 counted once + two distinct = 3 unique attempts");
  assert.ok(Math.abs(c.compositeCost().usd - 0.009) < 1e-9, "0.003 (shared, once) + 0.002 + 0.004 — no double-count");
});

test("B8 (req 35): a composite with ANY unknown-cost attempt is PARTIAL (never an exact remaining-budget claim)", () => {
  const c = new CompositeOperationLedger("composite:t6", "t6", "conditional-duel");
  c.registerChild(child("t6-primary", "primary", [pa("t6-p#pa1", 0.004)], { outcome: "non_promotable" }));
  c.registerChild(child("t6-peer", "peer", [pa("t6-peer#pa1", undefined, "unavailable")], { selected: true }));
  const cost = c.compositeCost();
  assert.equal(cost.status, "partial", "an unknown-cost peer attempt makes the composite partial");
  assert.equal(cost.unknownCostAttempts, 1);
  assert.equal(cost.usd, 0.004, "the known portion is still summed");
});

test("B9 [MUT: CLI omits planner/cognition] (req 36): a CLI composite includes BOTH cognition/planning AND worker spend", () => {
  const c = new CompositeOperationLedger("composite:t7", "t7", "cli-command");
  c.registerChild(child("cognition", "cognition", [pa("t7:cog#pa1", 0.001)]));
  c.registerChild(child("planning", "planning", [pa("t7:plan#pa1", 0.001)]));
  c.registerChild(child("worker", "worker", [pa("t7:work#pa1", 0.008)], { selected: true }));
  assert.equal(c.compositeCost().usd, 0.01, "the CLI total includes cognition + planning + worker (planner/cognition not dropped)");
  assert.equal(c.childRunsWithRole("cognition").length, 1);
  assert.equal(c.childRunsWithRole("planning").length, 1);
});

test("B10 (req 37): a worker-run child's OWN scoped cost stays honest (the composite adds a parent view, it does not mutate children)", () => {
  const c = new CompositeOperationLedger("composite:t8", "t8", "conditional-duel");
  const primary = c.registerChild(child("t8-primary", "primary", [pa("t8-p#pa1", 0.004)], { outcome: "non_promotable" }));
  const peer = c.registerChild(child("t8-peer", "peer", [pa("t8-peer#pa1", 0.006)], { selected: true }));
  // Each child's own attempt projection is unchanged — the parent total is a DERIVED union, not a rewrite.
  assert.equal(primary.providerAttempts.reduce((s, a) => s + (a.costUsd ?? 0), 0), 0.004, "primary's scoped cost is preserved");
  assert.equal(peer.providerAttempts.reduce((s, a) => s + (a.costUsd ?? 0), 0), 0.006, "peer's scoped cost is preserved");
  assert.equal(c.compositeCost().usd, 0.01, "the composite is their union");
});

test("B11 (req 28): the final selected child does NOT erase the losing history from the summary", () => {
  const c = new CompositeOperationLedger("composite:t9", "t9", "conditional-duel");
  c.registerChild(child("t9-primary", "primary", [pa("t9-p#pa1", 0.004)], { outcome: "non_promotable" }));
  c.registerChild(child("t9-peer", "peer", [pa("t9-peer#pa1", 0.006)], { selected: true }));
  const s = c.summary();
  assert.equal(s.childRuns.length, 2, "both the losing primary and the winning peer appear in the summary");
  assert.equal(s.selectedChildId, "t9-peer");
  assert.equal(s.childRuns.find((r) => r.role === "primary")?.selected, false, "the losing primary is still listed (not erased)");
});

test("B12 (req 39): a FAILED child (no promote, still charged) is included in the composite", () => {
  const c = new CompositeOperationLedger("composite:t10", "t10", "conditional-duel");
  c.registerChild(child("t10-primary", "primary", [pa("t10-p#pa1", 0.004)], { outcome: "failed" }));
  c.registerChild(child("t10-peer", "peer", [pa("t10-peer#pa1", 0.005)], { outcome: "failed" }));
  // Neither promoted — but both charged; the composite still surfaces the full spend.
  assert.equal(c.selectedChild(), undefined, "no child was selected");
  assert.ok(Math.abs(c.compositeCost().usd - 0.009) < 1e-9, "both failed-but-charged children are counted");
});

test("B13 (req 34): union of DISJOINT child ids equals the plain sum (duel/multi-step separate ledgers)", () => {
  const c = new CompositeOperationLedger("composite:t11", "t11", "multi-step");
  c.registerChild(child("s1", "step", [pa("t11-s1#pa1", 0.002), pa("t11-s1#pa2", 0.001)]));
  c.registerChild(child("s2", "step", [pa("t11-s2#pa1", 0.003)]));
  assert.equal(c.providerAttemptIds().length, 3, "3 disjoint attempt ids");
  assert.equal(c.compositeCost().usd, 0.006, "disjoint union = sum");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part C — CLI composite rendering (the surfaced total spans both children)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("C1 (req 27,28): formatCompositeCost renders BOTH children + the union total, marking the winner", () => {
  const c = new CompositeOperationLedger("composite:tc1", "tc1", "conditional-duel");
  c.registerChild(child("tc1-primary", "primary", [pa("tc1-p#pa1", 0.004)], { outcome: "non_promotable" }));
  c.registerChild(child("tc1-peer", "peer", [pa("tc1-peer#pa1", 0.006)], { selected: true }));
  const out = formatCompositeCost(c);
  assert.match(out, /Composite operation \(conditional-duel\)/);
  assert.match(out, /primary/);
  assert.match(out, /peer/);
  assert.match(out, /\$0\.0100/, "the surfaced composite total is the union (0.004 + 0.006)");
  assert.match(out, /2 unique attempts/);
});

test("C2 (req 35): formatCompositeCost marks a partial composite (unknown-cost attempt) explicitly", () => {
  const c = new CompositeOperationLedger("composite:tc2", "tc2", "conditional-duel");
  c.registerChild(child("tc2-primary", "primary", [pa("tc2-p#pa1", 0.004)], { outcome: "non_promotable" }));
  c.registerChild(child("tc2-peer", "peer", [pa("tc2-peer#pa1", undefined, "unavailable")], { selected: true }));
  const out = formatCompositeCost(c);
  assert.match(out, /partial/, "the rendered composite flags the unknown-cost attempt");
});
