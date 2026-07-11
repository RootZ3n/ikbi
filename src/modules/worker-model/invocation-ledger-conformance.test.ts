/**
 * INVOCATION-LEDGER CONFORMANCE (Phase 11, IKBI-REAUDIT-002 / -004).
 *
 * The invocation ledger is the execution source of truth for every dispatched provider request inside
 * `orchestrator.run`. These tests prove — at the pure ledger, the lane roster, and the real orchestrator
 * seam — the central invariant: execution identity (model/provider/lane/status/usage/cost) comes from the
 * ACTUAL dispatched invocation, never from a selection, role default, fallback intent, or receipt constructor.
 *
 * They double as RETAINED mutation guards (permanent, not throwaway) for: missing usage → unavailable (not
 * zero), failed-attempt cost counted, one-invocation-counted-once, empty-lane never borrows another lane,
 * and receipts/summary deriving the EXECUTED model. Enumerated in HANDOFF-PHASE-11-INVOCATION-LEDGER.md.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import type { ModelRequest, ModelResponse, ProviderAttempt } from "../../core/provider/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { InvocationLedger, chargedCostOf } from "./invocation-ledger.js";
import { laneRoster, laneHasModels } from "./expert-rental.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { RoleFn } from "./contract.js";

// ── fake provider responses (control cost/attempts/finishReason/model) ──────────────────────────
function resp(opts: { model?: string; provider?: string; costUsd?: number; attempts?: ProviderAttempt[]; finishReason?: ModelResponse["finishReason"]; content?: string }): ModelResponse {
  return {
    contractVersion: "1.1.0", model: opts.model ?? "deepseek-v4-flash", provider: opts.provider ?? "deepseek", providerModelId: opts.model ?? "deepseek-v4-flash",
    content: opts.content ?? "", finishReason: opts.finishReason ?? "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: (opts.costUsd ?? 0) as number, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: opts.attempts ?? [],
  };
}
const neutral = ((c: string) => coreNeutralize(c, { source: "external", identity: { agentId: "t" }, origin: "t" })) as unknown as InvocationLedger["engine"]["neutralizeUntrusted"];
function makeLedger(invoke: (r: ModelRequest) => Promise<ModelResponse>, opts: { maxBudgetUsd?: number } = {}) {
  return new InvocationLedger({ invokeModel: invoke, neutralizeUntrusted: neutral, runId: "run-1", taskId: "t-1", now: () => 100, ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}), laneMember: (m, l) => m.startsWith(l) });
}

// ════════════════════════════════════════════════════════════════════════════════
// Part A — charged-cost truth (IKBI-REAUDIT-004)
// ════════════════════════════════════════════════════════════════════════════════

test("A1 [MUTATION: failed-usage omitted] (req 5): charged cost SUMS every attempt — a failed attempt that charged tokens counts", () => {
  // A failed first attempt ($1) + a successful fallback ($2): response.cost is only the serving $2, but the
  // ledger must count $3 (the total actually charged).
  const r = resp({ model: "b", costUsd: 2, attempts: [
    { provider: "p", providerModelId: "a", outcome: "error", latencyMs: 1, costUsd: 1 },
    { provider: "p", providerModelId: "b", outcome: "success", latencyMs: 1, costUsd: 2 },
  ] });
  const c = chargedCostOf(r);
  assert.equal(c.usd, 3, "sum of every charged attempt, not just the serving one");
  assert.equal(c.status, "measured");
});

test("A2 [MUTATION: missing→zero] (req 6): missing cost is UNAVAILABLE, never silently zero", () => {
  const noAttempts = resp({ costUsd: NaN as unknown as number });
  const c = chargedCostOf({ ...noAttempts, cost: { ...noAttempts.cost, usd: undefined as unknown as number } });
  assert.equal(c.usd, undefined);
  assert.equal(c.status, "unavailable", "unknown price is not zero");
});

test("A3 (req 29): a real known-ZERO local call is `measured-zero` — distinct from no-call", () => {
  assert.equal(chargedCostOf(resp({ costUsd: 0 })).status, "measured-zero");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part B — the ledger: one record per dispatch, execution identity, budget
// ════════════════════════════════════════════════════════════════════════════════

test("B1 [MUTATION: double-count] (req 1,26,27): every dispatched call = exactly ONE record; cost = sum of unique records", async () => {
  const led = makeLedger(async () => resp({ model: "deepseek-v4-flash", costUsd: 0.5 }));
  await led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest);
  await led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest);
  assert.equal(led.invocationCount(), 2, "two dispatches → two records");
  assert.equal(led.cost(), 1.0, "cost is the sum of the two unique records (no double-count)");
});

test("B2 [MUTATION: selected-identity] (req 31): the record's resolvedModel/provider come from the RESPONSE, not the request", async () => {
  const led = makeLedger(async () => resp({ model: "deepseek-v4-pro", provider: "deepseek" })); // provider served a DIFFERENT model
  await led.engine.invokeModel({ model: "requested-alias", messages: [] } as unknown as ModelRequest);
  const rec = led.all()[0]!;
  assert.equal(rec.resolvedModel, "deepseek-v4-pro", "execution truth = what the provider served");
  assert.equal(rec.requestedAlias, "requested-alias", "the requested alias is recorded separately");
  assert.equal(rec.status, "succeeded");
});

test("B3 (req 3): a PRE-dispatch failure (thrown before/at the provider) records a failure, never a succeeded invocation", async () => {
  const led = makeLedger(async () => { throw new Error("transport down"); });
  await assert.rejects(() => led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest));
  const rec = led.all()[0]!;
  assert.equal(rec.status, "transport-failure");
  assert.notEqual(rec.status, "succeeded");
  assert.equal(rec.costStatus, "unavailable", "a failed dispatch never claims a measured cost");
});

test("B4 (req 28): any unknown-cost invocation makes the aggregate PARTIAL", async () => {
  const led = makeLedger(async () => resp({ costUsd: undefined as unknown as number, attempts: [{ provider: "p", providerModelId: "m", outcome: "success", latencyMs: 1 }] }));
  await led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest);
  assert.equal(led.costStatus(), "partial");
  assert.equal(led.unknownCosts(), 1);
});

test("B5 (req 30): a retry records its own unique id + a parent relationship via withContext", async () => {
  const led = makeLedger(async () => resp({ costUsd: 0.1 }));
  await led.withContext({ role: "builder", stage: "role", attemptId: "t-1" }, async () => {
    await led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest);
    await led.withContext({ role: "builder", stage: "cheap-retry", retryKind: "cheap-retry" }, async () => {
      await led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest);
    });
  });
  const ids = led.all().map((r) => r.invocationId);
  assert.equal(new Set(ids).size, 2, "each invocation has a unique id");
  assert.equal(led.all()[0]!.stage, "role");
  assert.equal(led.all()[1]!.stage, "cheap-retry");
  assert.equal(led.all()[1]!.retryKind, "cheap-retry");
});

test("B6 [MUTATION: cross-lane hidden] (req 19): a served model OUTSIDE the attempt lane is FLAGGED as a lane violation", async () => {
  const led = makeLedger(async () => resp({ model: "mimo-v2.5", provider: "mimo" }));
  await led.withContext({ role: "builder", stage: "role", vendorLane: "deepseek" }, async () => {
    await led.engine.invokeModel({ model: "deepseek-v4-flash", messages: [] } as unknown as ModelRequest);
  });
  assert.equal(led.laneViolations(), 1, "a mimo model served inside a deepseek-lane attempt is a recorded violation");
  assert.equal(led.all()[0]!.laneViolation, true);
});

test("B7 (req 2): budget is enforced from the ledger's cumulative charged cost", async () => {
  const led = makeLedger(async () => resp({ costUsd: 0.6 }), { maxBudgetUsd: 1.0 });
  await led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest);
  await assert.rejects(() => led.engine.invokeModel({ model: "x", messages: [] } as unknown as ModelRequest), (e: unknown) => (e as { code?: string }).code === "BUDGET_EXHAUSTED");
});

test("B8 (req 8): recordExternal (classifier/consult) folds a raw-provider call as ONE record with its cost status", () => {
  const led = makeLedger(async () => resp({}));
  led.recordExternal({ role: "classifier", stage: "classify", resolvedModel: "deepseek-v4-flash", provider: "deepseek", costUsd: 0.02 });
  led.recordExternal({ role: "classifier", stage: "classify", resolvedModel: "deepseek-v4-flash" }); // unknown cost
  assert.equal(led.invocationCount(), 2);
  assert.equal(led.cost(), 0.02);
  assert.equal(led.costStatus(), "partial", "the second (unknown-cost) external call makes the aggregate partial");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part C — lane roster fail-closed (IKBI-REAUDIT-002)
// ════════════════════════════════════════════════════════════════════════════════

test("C1 [MUTATION: empty-lane borrows] (req 17,18): laneRoster returns EMPTY for an unmatched lane — never the full roster", () => {
  const roster = ["deepseek-v4-flash", "mimo-v2.5"];
  assert.deepEqual(laneRoster(roster, "deepseek"), ["deepseek-v4-flash"]);
  assert.deepEqual(laneRoster(roster, "nonexistent"), [], "an empty lane never silently falls back to the full roster (no cross-lane borrow)");
  assert.deepEqual(laneRoster(roster, undefined), roster, "a lane-neutral roster is unchanged");
  assert.equal(laneHasModels(roster, "nonexistent"), false);
  assert.equal(laneHasModels(roster, "mimo"), true);
});

// ════════════════════════════════════════════════════════════════════════════════
// Part D — the real orchestrator seam: summary + empty-lane fail-closed
// ════════════════════════════════════════════════════════════════════════════════

const silent = () => pino({ level: "silent" });
function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, c) => resolver.resolve(claim, c);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}
const fakeBus: EventBusSurface = {
  publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
};
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = { append: async (input: unknown): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } };
  return { receipts, appended };
}
const stubTrust = { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }, _s: ValidatedIdentity): Promise<TrustDecision> => { const tier = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) }; } };
function ok(content: string, model = "recording", costUsd = 0.001): ModelResponse {
  return { contractVersion: "1.1.0", model, provider: "recording", providerModelId: model, content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: costUsd, promptUsd: costUsd, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown): ModelResponse { return { ...ok(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
function builderProvider(): (r: ModelRequest) => Promise<ModelResponse> {
  let turn = 0;
  return async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return ok(JSON.stringify({ tier: "worker", rationale: "x" }));
    if (!(req.tools ?? []).some((t) => t.name === "done")) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "ok" }));
    turn += 1;
    if (turn === 1) return toolResp("read_file", { path: "a.ts" });
    if (turn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "green", satisfied: true });
  };
}
const passCritic: RoleFn = async () => ({ role: "critic", outcome: "success", summary: "PASS", detail: { pass: true, semanticVerdict: { kind: "pass", summary: "ok", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "structured" } } });
const promoteIntegrator: RoleFn = async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } });
const execVerifier: RoleFn = async () => ({ role: "verifier", outcome: "success", summary: "green", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } });
function gitInit(dir: string): void {
  const g = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); writeFileSync(join(dir, "a.ts"), "export const a = 1;"); g("add", "-A"); g("commit", "-q", "-m", "base");
}
function realRun(opts: { taskExtra?: Record<string, unknown> } = {}) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p11-"));
  gitInit(dir);
  const handle: WorkspaceHandle = { id: "wsp11", targetRepo: dir, baseBranch: "main", baseRef: "HEAD", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: true },
    workspaces: {
      allocate: async () => handle,
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim,
    roles: { verifier: execVerifier, critic: passCritic, integrator: promoteIntegrator },
    invokeModel: builderProvider(), governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }, builderModel: "deepseek-v4-flash",
    escalationTierModels: { worker: ["deepseek-v4-flash"], mid: ["deepseek-v4-pro"], frontier: ["deepseek-v4-pro"] },
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true, reason: "ok" }) },
  });
  const task = { taskId: "build:deepseek", targetRepo: "/unused", goal: "do the thing", ...(opts.taskExtra ?? {}) };
  return { run: () => orch.run(task, parentCtx), receipts: rc.appended };
}

test("D1 [MUTATION: summary uses selected model] (req 26,31): the run summary derives cost/costStatus/invocationCount + the EXECUTED builder model from the ledger", async () => {
  const h = realRun();
  const result = await h.run();
  assert.equal(result.promoted, true);
  const summary = h.receipts.find((r) => r.operation === "worker.run.summary");
  assert.ok(summary !== undefined, "a run summary was emitted");
  assert.equal(typeof summary!.metadata.costUsd, "number");
  assert.equal(summary!.metadata.costStatus, "complete", "all recording-provider costs are measured");
  assert.ok((summary!.metadata.invocationCount as number) >= 1, "the summary reports the ledger's dispatched-invocation count");
  assert.equal(summary!.metadata.model, "recording", "the summary names the model the provider ACTUALLY served (from the ledger), not a selected default");
});

test("D2 (req 17): an EMPTY-LANE config fails the attempt CLOSED with a worker.lane_config_error — no promotion, not a candidate defect", async () => {
  // A duel task pinned to a vendor lane the roster has no model for → configuration error, fail closed.
  const h = realRun({ taskExtra: { moeExpertRental: true, moeVendorLane: "nonexistent-vendor", builderModelOverride: "someothervendor-x" } });
  const result = await h.run();
  assert.equal(result.promoted, false, "an empty-lane config never promotes");
  assert.equal(result.outcome, "rejected");
  assert.match(result.reason ?? "", /lane-config/);
  assert.ok(h.receipts.some((r) => r.operation === "worker.lane_config_error"), "an operational config-error receipt is emitted (not a candidate defect)");
});
