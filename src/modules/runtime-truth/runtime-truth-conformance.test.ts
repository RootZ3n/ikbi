/**
 * RUNTIME-TRUTH PRODUCTION CONFORMANCE (Phase 5).
 *
 * Proves the evidence layer is PRODUCTION-WIRED — not merely instantiated: with a reader present,
 * task/candidate-scoped evidence reaches the ACTUAL builder + critic provider request; without one it
 * is fully inert. Also proves scope filtering (cross-task/repo/candidate/stale rejected), freshness,
 * bounded context (whole low-priority items dropped, provenance never truncated), fail-safe advisory
 * behavior, config loading, and truthful receipts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import {
  filterAndBoundEvidence,
  renderEvidenceBlock,
  loadRuntimeTruthReader,
  runtimeTruthEvidenceEnabled,
  resolveEvidenceLimits,
  RUNTIME_TRUTH_EVIDENCE_ENV,
  RUNTIME_TRUTH_READER_MODULE_ENV,
  type RuntimeEvidence,
  type EvidenceRequestScope,
  type RuntimeTruthEvidenceReader,
} from "./index.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "../worker-model/orchestrator.js";
import type { RoleFn, WorkerRole } from "../worker-model/contract.js";

const silent = () => pino({ level: "silent" });
const NOW = 1_000_000_000;
function ev(over: Partial<RuntimeEvidence> & { id: string; scope: RuntimeEvidence["scope"] }): RuntimeEvidence {
  return { id: over.id, claim: over.claim ?? `claim-${over.id}`, source: over.source ?? "verifier:test", provenance: over.provenance ?? { kind: "verifier" }, observedAt: over.observedAt ?? NOW, scope: over.scope };
}
function scope(over: Partial<EvidenceRequestScope> = {}): EvidenceRequestScope {
  return { taskId: "t1", repo: "/repo", role: "builder", now: NOW, freshnessWindowMs: 60_000, ...over };
}

// ───────────────────────── Part 1: scope filter + bounds (pure) ─────────────────────────

test("filter: in-scope evidence is kept; cross-task / cross-repo / cross-candidate / stale-tree are omitted with reasons", () => {
  const s = scope({ candidateId: "cand-A", verifiedTree: "T-A" });
  const items = [
    ev({ id: "keep", scope: { taskId: "t1", repo: "/repo", candidateId: "cand-A", verifiedTree: "T-A" } }),
    ev({ id: "wrong-task", scope: { taskId: "t2", repo: "/repo" } }),
    ev({ id: "wrong-repo", scope: { taskId: "t1", repo: "/other" } }),
    ev({ id: "wrong-cand", scope: { taskId: "t1", repo: "/repo", candidateId: "cand-B" } }),
    ev({ id: "stale", scope: { taskId: "t1", repo: "/repo", verifiedTree: "T-OLD" } }),
  ];
  const r = filterAndBoundEvidence(items, s, { maxItems: 10, maxTotalBytes: 10_000, maxItemBytes: 2_000 });
  assert.deepEqual(r.kept.map((e) => e.id), ["keep"]);
  const reasons = Object.fromEntries(r.omitted.map((o) => [o.id, o.reason]));
  assert.equal(reasons["wrong-task"], "wrong-task");
  assert.equal(reasons["wrong-repo"], "wrong-repo");
  assert.equal(reasons["wrong-cand"], "wrong-candidate");
  assert.equal(reasons["stale"], "stale-tree");
});

test("filter: expired (outside freshness window) and malformed/missing-provenance are omitted; no fabrication", () => {
  const s = scope({ now: NOW, freshnessWindowMs: 1000 });
  const items = [
    ev({ id: "fresh", observedAt: NOW - 500, scope: { taskId: "t1", repo: "/repo" } }),
    ev({ id: "expired", observedAt: NOW - 5000, scope: { taskId: "t1", repo: "/repo" } }),
    { id: "noprov", claim: "x", source: "s", observedAt: NOW, scope: { taskId: "t1", repo: "/repo" } } as unknown as RuntimeEvidence, // missing provenance
    { id: "", claim: "", source: "", observedAt: NOW, scope: { taskId: "t1", repo: "/repo" }, provenance: { kind: "other" } } as RuntimeEvidence, // malformed (empty claim)
  ];
  const r = filterAndBoundEvidence(items, s, { maxItems: 10, maxTotalBytes: 10_000, maxItemBytes: 2_000 });
  assert.deepEqual(r.kept.map((e) => e.id), ["fresh"]);
  const reasons = Object.fromEntries(r.omitted.map((o) => [o.id, o.reason]));
  assert.equal(reasons["expired"], "expired");
  assert.equal(reasons["noprov"], "missing-provenance");
});

test("bounds: whole low-priority items are dropped (never provenance-truncated); higher provenance kept first", () => {
  const s = scope();
  const items = [
    ev({ id: "verifier", provenance: { kind: "verifier" }, scope: { taskId: "t1", repo: "/repo" } }),
    ev({ id: "other", provenance: { kind: "other" }, scope: { taskId: "t1", repo: "/repo" } }),
  ];
  const r = filterAndBoundEvidence(items, s, { maxItems: 1, maxTotalBytes: 10_000, maxItemBytes: 2_000 });
  assert.deepEqual(r.kept.map((e) => e.id), ["verifier"], "the higher-provenance item survives the bound");
  assert.equal(r.truncated, true);
  assert.equal(r.omitted.find((o) => o.id === "other")?.reason, "bounded-out");
  // The kept item is COMPLETE — provenance + claim intact (whole-item drop, not truncation).
  assert.equal(r.kept[0]!.provenance.kind, "verifier");
  assert.match(renderEvidenceBlock(r.kept, NOW), /claim-verifier/);
});

test("dedup + too-large: duplicate ids and oversized items are omitted", () => {
  const s = scope();
  const big = "x".repeat(3000);
  const items = [
    ev({ id: "a", scope: { taskId: "t1", repo: "/repo" } }),
    ev({ id: "a", scope: { taskId: "t1", repo: "/repo" } }),
    ev({ id: "huge", claim: big, scope: { taskId: "t1", repo: "/repo" } }),
  ];
  const r = filterAndBoundEvidence(items, s, { maxItems: 10, maxTotalBytes: 10_000, maxItemBytes: 1_500 });
  assert.deepEqual(r.kept.map((e) => e.id), ["a"]);
  const reasons = r.omitted.map((o) => o.reason);
  assert.ok(reasons.includes("duplicate"));
  assert.ok(reasons.includes("too-large"));
});

// ───────────────────────── Part 2: config loader ─────────────────────────

const testReader: RuntimeTruthEvidenceReader = { id: "test-reader", readEvidence: () => [] };

test("config: disabled + no dep ⇒ inert (undefined); an injected dep always wins", async () => {
  assert.equal(await loadRuntimeTruthReader(undefined, {}), undefined, "no dep + disabled ⇒ no reader");
  const r = await loadRuntimeTruthReader(testReader, {});
  assert.ok(r !== undefined && "reader" in r && r.reader.id === "test-reader", "an injected dep is used regardless of env");
});

test("config: enabled but no module ⇒ truthful error; a bad module path ⇒ truthful error (never fabricated)", async () => {
  const noModule = await loadRuntimeTruthReader(undefined, { [RUNTIME_TRUTH_EVIDENCE_ENV]: "on" });
  assert.ok(noModule !== undefined && "error" in noModule, "enabled + no module ⇒ error, not a fake reader");
  const badModule = await loadRuntimeTruthReader(undefined, { [RUNTIME_TRUTH_EVIDENCE_ENV]: "on", [RUNTIME_TRUTH_READER_MODULE_ENV]: "/no/such/module-xyz.js" });
  assert.ok(badModule !== undefined && "error" in badModule, "a load failure is a visible error, never a fabricated reader");
});

test("config: env values reach the resolver (enabled flag + limits)", () => {
  assert.equal(runtimeTruthEvidenceEnabled({ [RUNTIME_TRUTH_EVIDENCE_ENV]: "on" }), true);
  assert.equal(runtimeTruthEvidenceEnabled({}), false);
  assert.equal(resolveEvidenceLimits({ IKBI_RUNTIME_TRUTH_MAX_ITEMS: "3" }).maxItems, 3, "IKBI_RUNTIME_TRUTH_MAX_ITEMS reaches the limit");
});

// ───────────────────────── Part 3: real orchestrator → provider seam ─────────────────────────

function makeIdentities() {
  const agents = [
    { agentId: "parent-1", kind: "agent" as const, functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
    { agentId: "worker-1", kind: "agent" as const, functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
  ];
  const resolver = new IdentityResolver({ registry: new AgentRegistry({ agents }), logger: silent(), now: () => 1000 });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}
function fakeBus(): EventBusSurface {
  return {
    publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
    subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
    flush: async () => {},
  };
}
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown> }> = [];
  const receipts = { append: async (input: unknown, _id: AgentIdentity): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown> }; appended.push({ operation: r.operation, metadata: r.metadata ?? {} }); return {}; } };
  return { receipts, appended };
}
const greenGovernedExec = { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
const CRIT = JSON.stringify({ verdict: "PASS", scores: { goal_correctness: 5 }, feedback: "correct" });
function okr(content: string): ModelResponse {
  return { contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording", content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0.001, promptUsd: 0.001, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function tool(name: string, args: unknown): ModelResponse { return { ...okr(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }

/** Records the concatenated message text of every builder + critic request for inspection. */
function recordingProvider() {
  const builderMessages: string[] = [];
  const criticMessages: string[] = [];
  let turn = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return okr(JSON.stringify({ tier: "worker", rationale: "x" }));
    const text = (req.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const hasDone = (req.tools ?? []).some((t) => t.name === "done");
    if (!hasDone) { criticMessages.push(text); return okr(CRIT); } // scout + critic
    builderMessages.push(text);
    turn += 1;
    if (turn === 1) return tool("read_file", { path: "a.ts" });
    if (turn === 2) return tool("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return tool("run_checks", {});
    return tool("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "ran checks green; goal met", satisfied: true });
  };
  return { invokeModel, builderMessages, criticMessages };
}
const stubVI: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }], testEvidence: "executed" } }),
  integrator: async () => ({ role: "integrator", outcome: "success", summary: "i", detail: { decision: "promote", rationale: "ok", evaluation: { approved: true } } }),
};

function orchestratorWith(reader: RuntimeTruthEvidenceReader | undefined, treeHash = "T-cand") {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rp = recordingProvider();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-rt-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const handle: WorkspaceHandle = { id: "wsRT", targetRepo: "/repo", baseBranch: "main", baseRef: "H", scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const readerCalls: EvidenceRequestScope[] = [];
  const wrapped: RuntimeTruthEvidenceReader | undefined = reader === undefined ? undefined : { id: reader.id, readEvidence: (s) => { readerCalls.push(s); return reader.readEvidence(s); } };
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: false },
    workspaces: {
      allocate: async () => handle,
      promote: async (h): Promise<PromoteResult> => ({ promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }),
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      commit: async () => true,
      diff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-export const a = 1;\n+export const a = 2;\n",
    },
    events: fakeBus(), receipts: rc.receipts, resolveIdentity, roleClaim, roles: stubVI, invokeModel: rp.invokeModel,
    governedExec: greenGovernedExec, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => ({ allow: true }) },
    readTreeHash: async () => treeHash,
    ...(wrapped !== undefined ? { runtimeTruthReader: wrapped } : {}),
  });
  return { orch, parentCtx, rp, receipts: rc.appended, readerCalls, taskId: "rt-task" };
}
const runTask = { taskId: "rt-task", targetRepo: "/repo", goal: "do the thing" } as const;

test("DISABLED: no reader ⇒ builder/critic requests carry NO runtime evidence and NO runtime_truth receipt", async () => {
  const { orch, parentCtx, rp, receipts } = orchestratorWith(undefined);
  const r = await orch.run({ ...runTask }, parentCtx);
  assert.equal(r.outcome, "success");
  assert.ok(!rp.builderMessages.some((m) => m.includes("Runtime-truth evidence")), "no evidence in the builder request");
  assert.ok(!receipts.some((x) => x.operation === "worker.runtime_truth"), "no runtime_truth receipt when inert");
});

test("ENABLED: the reader is called task-scoped, and its evidence reaches the ACTUAL builder + critic provider request", async () => {
  const reader: RuntimeTruthEvidenceReader = {
    id: "prod-reader",
    readEvidence: (s) => [ev({ id: "e-verify", claim: `pnpm test: 42 passed (${s.role})`, observedAt: s.now, scope: { taskId: s.taskId, repo: s.repo, ...(s.verifiedTree !== undefined ? { verifiedTree: s.verifiedTree } : {}) } })],
  };
  const { orch, parentCtx, rp, receipts, readerCalls } = orchestratorWith(reader);
  const r = await orch.run({ ...runTask }, parentCtx);
  assert.equal(r.outcome, "success");
  assert.ok(readerCalls.some((s) => s.taskId === "rt-task" && s.role === "builder"), "a task-scoped builder request was made");
  assert.ok(rp.builderMessages.some((m) => m.includes("Runtime-truth evidence") && m.includes("pnpm test: 42 passed (builder)")), "the builder provider request carried the evidence");
  assert.ok(rp.criticMessages.some((m) => m.includes("pnpm test: 42 passed (critic)")), "the critic provider request carried the evidence");
  const rec = receipts.find((x) => x.operation === "worker.runtime_truth" && x.metadata.role === "builder");
  assert.equal(rec?.metadata.injected, true, "the receipt truthfully records injection");
  assert.equal(rec?.metadata.readerId, "prod-reader");
});

test("CANDIDATE BINDING: cross-task and stale-tree evidence is omitted; only candidate-bound evidence reaches the critic", async () => {
  const reader: RuntimeTruthEvidenceReader = {
    id: "prod-reader",
    readEvidence: (s) => [
      ev({ id: "good", claim: "GOOD candidate-bound fact", observedAt: s.now, scope: { taskId: s.taskId, repo: s.repo, verifiedTree: "T-cand" } }),
      ev({ id: "stale", claim: "STALE other-tree fact", observedAt: s.now, scope: { taskId: s.taskId, repo: s.repo, verifiedTree: "T-other" } }),
      ev({ id: "othertask", claim: "OTHER task fact", observedAt: s.now, scope: { taskId: "someone-else", repo: s.repo } }),
    ],
  };
  const { orch, parentCtx, rp, receipts } = orchestratorWith(reader, "T-cand");
  await orch.run({ ...runTask }, parentCtx);
  const critic = rp.criticMessages.find((m) => m.includes("Runtime-truth evidence"));
  assert.ok(critic !== undefined && critic.includes("GOOD candidate-bound fact"), "the candidate-bound fact reached the critic");
  assert.ok(!critic!.includes("STALE other-tree fact"), "a stale-tree fact never reaches the critic");
  assert.ok(!critic!.includes("OTHER task fact"), "another task's evidence never reaches the critic");
  const rec = receipts.find((x) => x.operation === "worker.runtime_truth" && x.metadata.role === "critic");
  assert.equal(rec?.metadata.keptCount, 1);
  assert.ok((rec?.metadata.omitted as { reason: string }[]).some((o) => o.reason === "stale-tree"), "omission recorded truthfully");
});

test("FAIL-SAFE: a reader that THROWS is advisory — the build still succeeds, no evidence, receipt records the failure", async () => {
  const reader: RuntimeTruthEvidenceReader = { id: "boom", readEvidence: () => { throw new Error("reader down"); } };
  const { orch, parentCtx, rp, receipts } = orchestratorWith(reader);
  const r = await orch.run({ ...runTask }, parentCtx);
  assert.equal(r.outcome, "success", "a reader failure never blocks the build (advisory)");
  assert.ok(!rp.builderMessages.some((m) => m.includes("Runtime-truth evidence")), "no evidence injected on reader failure");
  const rec = receipts.find((x) => x.operation === "worker.runtime_truth" && x.metadata.role === "builder");
  assert.equal(rec?.metadata.injected, false, "the receipt does NOT claim injection on failure");
  assert.match(String(rec?.metadata.error), /reader execution failed/);
});
