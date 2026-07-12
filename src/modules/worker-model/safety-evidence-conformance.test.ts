/**
 * SAFETY-EVIDENCE CONFORMANCE (Phase 8, IKBI-RT-005 — the SafetyLedger portion).
 *
 * THE THESIS: the runtime must never MANUFACTURE affirmative safety evidence merely because a schema
 * expects a value. Every safety value is exactly one of: an AUTHENTIC fact observed by a named runtime
 * component, a DERIVED assessment from authentic facts, an ADVISORY opinion that cannot authorize a
 * promotion, UNKNOWN (evidence not produced), or NOT-APPLICABLE under an explicit policy. The old
 * `SafetyLedger.gateWallAuthorized: true` was a manufactured affirmative fact — it CLAIMED the gate-wall
 * had authorized a promotion before the gate-wall ever ran. Phase 8 removes it: the renamed
 * `SafetyAssessment` carries ONLY authentic monotone vetoes, and the AUTHORITATIVE promotion boundary is
 * the real gate-wall + `promoteCandidate()`'s stale-tree/CAS — which run DOWNSTREAM of this projection.
 *
 * These tests prove the authority boundaries and act as MUTATION GUARDS: they fail if a future edit
 * re-introduces a synthesized affirmative safety fact, lets safety code authorize/perform a promotion,
 * breaks veto monotonicity, or makes the provenance receipt dishonest. Mutation guards are marked
 * `[MUTATION n]` and enumerated in HANDOFF-PHASE-8-SAFETY-EVIDENCE.md.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { pino } from "pino";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { EventBusSurface, EventInput, IkbiEvent } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext, ValidatedIdentity } from "../../core/identity/resolver.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { decidePromotability } from "./adjudication/core.js";
import type { CriticVerdict, Decision, SafetyAssessment, SafetyLedger, WorkAssessment, WorkProduct } from "./adjudication/contract.js";
import type { RoleFn, WorkerRole } from "./contract.js";

// ── source files under invariant ──────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const orchestratorSrc = readFileSync(join(HERE, "orchestrator.ts"), "utf8");
const coreSrc = readFileSync(join(HERE, "adjudication", "core.ts"), "utf8");
const contractSrc = readFileSync(join(HERE, "adjudication", "contract.ts"), "utf8");

/** The `const safety: SafetyAssessment = { ... };` object literal in the orchestrator — the sole
 *  construction site. All source assertions about "no manufactured affirmative fact" scope to THIS block
 *  so a comment elsewhere that merely NAMES the removed field cannot mask a real regression. */
function safetyConstructionBlock(): string {
  const start = orchestratorSrc.indexOf("const safety: SafetyAssessment = {");
  assert.notEqual(start, -1, "the SafetyAssessment is constructed in orchestrator.ts");
  const end = orchestratorSrc.indexOf("};", start);
  assert.notEqual(end, -1, "the construction block is closed");
  return orchestratorSrc.slice(start, end + 2);
}

// ── pure fixtures (the four adjudication facts) ─────────────────────────────────
const TREE = "tree-safety-abc";
const work = (over: Partial<WorkProduct> = {}): WorkProduct => ({ treeHash: TREE, diffStat: { filesChanged: 2, insertions: 10, deletions: 0 }, nonEmpty: true, ...over });
const green = (over: Partial<WorkAssessment> = {}): WorkAssessment => ({ verdict: "pass", testEvidence: "executed", treeHash: TREE, ...over });
const noVeto = (over: Partial<SafetyAssessment> = {}): SafetyAssessment => ({ externalInjection: false, effectiveBreach: false, refuted: false, killed: false, driftBlocked: false, ...over });
const criticPass: CriticVerdict = { pass: true };
const VETO_KEYS = ["externalInjection", "effectiveBreach", "refuted", "killed", "driftBlocked"] as const;

// ════════════════════════════════════════════════════════════════════════════════
// Part A — the SafetyAssessment carries NO manufactured affirmative fact
// ════════════════════════════════════════════════════════════════════════════════

test("A1 [MUTATION 1]: the orchestrator's safety construction NEVER fabricates `gateWallAuthorized` (the removed affirmative fact)", () => {
  assert.equal(/gateWallAuthorized\s*:/.test(safetyConstructionBlock()), false, "the manufactured `gateWallAuthorized: <bool>` fact must not reappear in the construction");
});

test("A2 [MUTATION 2]: the SafetyAssessment TYPE declares no `gateWallAuthorized` field — the schema cannot demand a synthesized value", () => {
  assert.equal(contractSrc.includes("gateWallAuthorized"), false, "the contract must not mention gateWallAuthorized at all — the affirmative fact is gone, not renamed");
});

test("A3 [MUTATION 3]: the adjudication core does NOT read `safety.gateWallAuthorized` — it never gates on a gate-wall determination it did not make", () => {
  assert.equal(/safety\.gateWallAuthorized/.test(coreSrc), false, "no branch may consume a gate-wall-authorization field from the safety projection");
});

test("A4: the SafetyAssessment has EXACTLY the five authentic monotone-veto fields — nothing more", () => {
  const s = noVeto();
  assert.deepEqual(Object.keys(s).sort(), [...VETO_KEYS].sort(), "exactly the five vetoes; no affirmative `safe`/`authorized` slot exists to be manufactured");
});

test("A5: `SafetyLedger` is a transitional alias of `SafetyAssessment` (external refs compile; deprecated)", () => {
  const s: SafetyLedger = noVeto(); // must type-check
  const a: SafetyAssessment = s;    // structurally identical
  assert.deepEqual(Object.keys(a).sort(), [...VETO_KEYS].sort());
  assert.match(contractSrc, /@deprecated Phase 8: use `SafetyAssessment`/);
});

// ════════════════════════════════════════════════════════════════════════════════
// Part B — the adjudication core RECOMMENDS; it never AUTHORIZES a promotion
// ════════════════════════════════════════════════════════════════════════════════

test("B1: green + unvetoed → a promote RECOMMENDATION bound to the tree — carrying NO authorization flag", () => {
  const d = decidePromotability(work(), green(), noVeto(), criticPass);
  assert.deepEqual(d, { action: "promote", treeHash: TREE, reason: "verified-green" });
  assert.equal("authorized" in d, false, "a promote decision is a recommendation; it never asserts an authorization it did not make");
});

test("B2: `decidePromotability` takes EXACTLY four fact inputs — there is no gate-wall parameter to gate on", () => {
  assert.equal(decidePromotability.length, 4, "work, assessment, safety, critic — the gate-wall is a downstream authority, not an input here");
});

test("B3 [MUTATION 4]: each of the five vetoes INDEPENDENTLY withholds green work — never promotes (monotone)", () => {
  for (const k of VETO_KEYS) {
    const d = decidePromotability(work(), green(), noVeto({ [k]: true }), criticPass);
    assert.notEqual(d.action, "promote", `veto ${k}=true still promoted green work`);
    assert.notEqual(d.action, "discard", `veto ${k}=true DISCARDED green work — vetoes withhold (retain), never destroy merit`);
  }
});

test("B4: a `false` veto is 'no veto raised' — it can NEVER manufacture greenness on non-green work", () => {
  // All-false safety (the maximally-'clean' projection) applied to a verifier-RED tree still discards.
  const d = decidePromotability(work(), green({ verdict: "fail" }), noVeto(), criticPass);
  assert.deepEqual(d, { action: "discard", reason: "verifier-red" }, "safety silence is not a green vote");
});

test("B5: an OBSERVED veto withholds regardless of how clean every other fact is (unknown is never fabricated safe)", () => {
  const d = decidePromotability(work(), green(), noVeto({ effectiveBreach: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "safety-forensics" }, "a landed breach withholds even a perfectly green tree");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part C — safety code performs NO promotion and manufactures NO facts
// ════════════════════════════════════════════════════════════════════════════════

test("C1 [MUTATION 5]: NO adjudication/safety module calls `workspaces.promote(` — promotion is not the safety layer's to perform", () => {
  // Strip line/block comments so a prose mention of the downstream authority is not mistaken for a call.
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const [name, src] of [["core.ts", coreSrc], ["contract.ts", contractSrc]] as const) {
    const code = stripComments(src);
    assert.equal(/workspaces\.promote\(/.test(code), false, `${name} must not perform a promotion`);
    assert.equal(/promoteCandidate\(/.test(code), false, `${name} must not INVOKE the promotion authority (a prose reference is fine)`);
  }
});

test("C2: `workspaces.promote(` is called from EXACTLY one place — the single canonical authority (Phase 3 preserved)", () => {
  assert.equal((orchestratorSrc.match(/workspaces\.promote\(/g) ?? []).length, 1, "one promotion authority; the safety projection is not on that path");
});

test("C3: each veto is bound to a NAMED runtime observation — not a literal — in the construction block", () => {
  const block = safetyConstructionBlock();
  assert.match(block, /externalInjection:\s*externalInjectionDetectedThisBuild/, "external injection ← neutralization chokepoint");
  assert.match(block, /refuted:\s*refuterDetail\.refuted === true/, "refuted ← the refuter role's detail");
  assert.match(block, /killed:\s*killedReason !== undefined/, "killed ← the kill-switch / budget");
});

test("C4 [MUTATION 6]: no veto is constructed as a bare affirmative `: true` literal — a manufactured 'safe/bad' fact", () => {
  const block = safetyConstructionBlock();
  assert.equal(/:\s*true\b/.test(block), false, "a field literally pinned to `true` would be a fabricated observation");
  // the two not-determined-here slots are honestly `false` = 'no such veto was raised', not affirmative claims.
  assert.match(block, /effectiveBreach:\s*false/);
  assert.match(block, /driftBlocked:\s*false/);
});

// ════════════════════════════════════════════════════════════════════════════════
// Part D — the TRUTHFUL provenance receipt (real orchestrator seam)
// ════════════════════════════════════════════════════════════════════════════════

const silent = () => pino({ level: "silent" });
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
const fakeBus: EventBusSurface = {
  publish: <P>(input: EventInput<P>): IkbiEvent<P> => ({ ...input, contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 } as IkbiEvent<P>),
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
};
function capturingReceipts() {
  const appended: Array<{ operation: string; metadata: Record<string, unknown>; outcome: unknown }> = [];
  const receipts = { append: async (input: unknown, _id: AgentIdentity): Promise<unknown> => { const r = input as { operation: string; metadata?: Record<string, unknown>; outcome?: unknown }; appended.push({ operation: r.operation, metadata: r.metadata ?? {}, outcome: r.outcome }); return {}; } };
  return { receipts, appended };
}
const stubTrust = {
  recordOutcome: async (input: { agentId: string; defaultTrustTier: string }, _s: ValidatedIdentity): Promise<TrustDecision> => {
    const tier = asTier(input.defaultTrustTier, TRUST_FLOOR);
    return { agentId: input.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
  },
};
const COST = 0.002;
function ok(content: string): ModelResponse {
  return { contractVersion: "1.1.0", model: "recording", provider: "recording", providerModelId: "recording", content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: COST, promptUsd: COST, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
function toolResp(name: string, args: unknown): ModelResponse { return { ...ok(""), finishReason: "tool_calls", toolCalls: [{ id: `${name}1`, name, arguments: JSON.stringify(args) }] }; }
function successProvider(): (r: ModelRequest) => Promise<ModelResponse> {
  let turn = 0;
  return async (req: ModelRequest): Promise<ModelResponse> => {
    if (typeof (req as { prompt?: unknown }).prompt === "string") return ok(JSON.stringify({ tier: "worker", rationale: "x" }));
    if (!(req.tools ?? []).some((t) => t.name === "done")) return ok(JSON.stringify({ verdict: "PASS", scores: { files_modified: 5, goal_correctness: 5, code_quality: 5, tests: 5, suspicious_patterns: 5 }, feedback: "correct and complete for the goal" }));
    turn += 1;
    if (turn === 1) return toolResp("read_file", { path: "a.ts" });
    if (turn === 2) return toolResp("write_file", { path: "a.ts", content: "export const a = 2;\n" });
    if (turn === 3) return toolResp("run_checks", {});
    return toolResp("done", { successCondition: "do the thing", filesReadBack: ["a.ts"], selfCheck: "ran checks green; goal met", satisfied: true });
  };
}
const stubRoles: Partial<Record<WorkerRole, RoleFn>> = {
  verifier: async () => ({ role: "verifier", outcome: "success", summary: "ok", detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } }),
  critic: async () => ({ role: "critic", outcome: "success", summary: "c", detail: { pass: true, semanticVerdict: { kind: "pass", summary: "ok", blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "structured" } } }),
  integrator: async () => ({ role: "integrator", outcome: "success", summary: "p", detail: { decision: "promote", rationale: "s", evaluation: { approved: true } } }),
};
function treeReader(seq: (string | undefined)[]) { let i = 0; return async (): Promise<string | undefined> => { const v = seq[Math.min(i, seq.length - 1)]; i += 1; return v; }; }
/** A real git repo so the adjudication core's `computeWorkProduct` (which shells out to git) succeeds and
 *  the `worker.safety_assessment` provenance receipt is actually emitted. Returns the base commit sha. */
function gitInitWorkspace(dir: string): string {
  const g = (...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  return g("rev-parse", "HEAD").trim();
}
function realOrchestrator(opts: { gateAllow?: boolean; treeSeq?: (string | undefined)[]; extra?: Partial<OrchestratorDeps> } = {}) {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p8-"));
  const baseRef = gitInitWorkspace(dir);
  const handle: WorkspaceHandle = { id: "wsp8", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const promoteCalls: Array<{ id: string }> = [];
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: true },
    workspaces: {
      allocate: async () => handle,
      promote: async (h): Promise<PromoteResult> => { promoteCalls.push({ id: h.id }); return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
      discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
      retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }),
      commit: async () => true,
    },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim, roles: stubRoles,
    invokeModel: successProvider(), governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }, builderModel: "deepseek-v4-flash",
    gateWall: { evaluate: async (): Promise<PromoteGovernance> => (opts.gateAllow === false ? { allow: false, reason: "denied by policy", gateId: "g1" } : { allow: true, reason: "ok" }) },
    ...(opts.treeSeq !== undefined ? { readTreeHash: treeReader(opts.treeSeq) } : {}),
    ...opts.extra,
  });
  return { orch, parentCtx, receipts: rc.appended, promoteCalls };
}
const run = (orch: ReturnType<typeof realOrchestrator>["orch"], parentCtx: OperationContext, taskId: string) =>
  orch.run({ taskId, targetRepo: "/unused", goal: "do the thing", moeExpertRental: true, moeVendorLane: "deepseek" }, parentCtx);

test("D1 [MUTATION 8]: a build emits `worker.safety_assessment` whose AUTHORITY string disclaims any promotion authority", async () => {
  const h = realOrchestrator({ treeSeq: ["T"] });
  await run(h.orch, h.parentCtx, "t-recpt");
  const rec = h.receipts.find((r) => r.operation === "worker.safety_assessment");
  assert.ok(rec !== undefined, "the safety assessment records its own provenance");
  assert.match(String(rec!.metadata.authority), /NOT a promotion authorizer/, "the projection explicitly disclaims promotion authority");
  assert.match(String(rec!.metadata.authority), /gate-wall \+ promoteCandidate are authoritative/);
});

test("D2 [MUTATION 7]: the receipt is HONEST about what it did NOT determine — `notDeterminedHere` names the removed gate-wall slot", async () => {
  const h = realOrchestrator({ treeSeq: ["T"] });
  await run(h.orch, h.parentCtx, "t-nd");
  const rec = h.receipts.find((r) => r.operation === "worker.safety_assessment")!;
  const nd = rec.metadata.notDeterminedHere as string[];
  assert.ok(Array.isArray(nd), "notDeterminedHere is an explicit list");
  assert.ok(nd.includes("gateWallAuthorized"), "gate-wall authorization is declared NOT-determined here — the honest counterpart of removing the fact");
  assert.ok(nd.includes("effectiveBreach") && nd.includes("driftBlocked"), "the not-tracked veto slots are disclosed too");
});

test("D3: the receipt records only OBSERVED vetoes + the adjudication outcome + mode — the authentic facts, nothing synthetic", async () => {
  // This test pins the SHADOW-telemetry receipt (the legacy default), so it forces the legacy mode
  // explicitly rather than inheriting the suite-wide IKBI_LEGACY_COMPLETION=off override — the receipt's
  // `mode` field must then read "shadow" (the run is NOT authoritative). The authoritative-mode receipt is
  // covered elsewhere; here we assert the shadow projection is truthful about being shadow.
  const h = realOrchestrator({ treeSeq: ["T"], extra: { env: { ...process.env, IKBI_LEGACY_COMPLETION: "on" } } });
  await run(h.orch, h.parentCtx, "t-obs");
  const rec = h.receipts.find((r) => r.operation === "worker.safety_assessment")!;
  const observed = rec.metadata.observedVetoes as Record<string, boolean>;
  assert.deepEqual(Object.keys(observed).sort(), ["externalInjection", "killed", "refuted"].sort(), "only the vetoes actually observed here are reported as observed");
  assert.equal(rec.metadata.mode, "shadow", "the default run is shadow — the receipt states the mode plainly");
  assert.ok(typeof rec.metadata.adjudicationAction === "string" && typeof rec.metadata.adjudicationReason === "string");
});

test("D4: on a clean green build every observed veto is false — an AUTHENTIC absence, and the run still promotes via the downstream authority", async () => {
  const h = realOrchestrator({ treeSeq: ["T"] });
  const result = await run(h.orch, h.parentCtx, "t-clean");
  const rec = h.receipts.find((r) => r.operation === "worker.safety_assessment")!;
  const observed = rec.metadata.observedVetoes as Record<string, boolean>;
  assert.deepEqual(observed, { externalInjection: false, refuted: false, killed: false }, "no veto was raised — reported as absence, not as an affirmative safety certificate");
  assert.equal(result.promoted, true, "the promote is granted by the gate-wall + authority, not by the safety projection");
  assert.equal(h.promoteCalls.length, 1);
});

// ════════════════════════════════════════════════════════════════════════════════
// Part E — the real GATE-WALL is the authoritative promotion boundary (downstream)
// ════════════════════════════════════════════════════════════════════════════════

test("E1: a DENYING gate-wall blocks promotion of green+unvetoed work — the safety projection cannot override a deny", async () => {
  const h = realOrchestrator({ gateAllow: false, treeSeq: ["T"] });
  const result = await run(h.orch, h.parentCtx, "t-deny");
  assert.equal(result.promoted, false, "green + no veto still does NOT promote when the authoritative gate-wall denies");
  assert.equal(h.promoteCalls.length, 0, "the low-level promote was never reached");
  assert.match(result.reason ?? "", /denied by policy/);
});

test("E2: an unwired gate-wall DENIES fail-closed — the safety projection's silence is not authorization", async () => {
  const { parentCtx, resolveIdentity, roleClaim } = makeIdentities();
  const rc = capturingReceipts();
  const dir = mkdtempSync(join(tmpdir(), "ikbi-p8u-"));
  const baseRef = gitInitWorkspace(dir);
  const handle: WorkspaceHandle = { id: "wsp8u", targetRepo: dir, baseBranch: "main", baseRef, scratchBranch: "s", path: dir, identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  let promoted = false;
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1, trustLadder: true },
    workspaces: { allocate: async () => handle, promote: async (h): Promise<PromoteResult> => { promoted = true; return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; }, discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }), retain: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: false }), commit: async () => true },
    events: fakeBus, receipts: rc.receipts, trust: stubTrust, resolveIdentity, roleClaim, roles: stubRoles,
    invokeModel: successProvider(), governedExec: { run: async () => ({ executed: true as const, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) }, builderModel: "deepseek-v4-flash",
    // gateWall deliberately omitted → the misconfigured / unwired path.
    readTreeHash: treeReader(["T"]),
  });
  const result = await run(orch, parentCtx, "t-unwired");
  assert.equal(promoted, false, "nothing promotes without the authoritative gate-wall — safety silence never fills that gap");
  assert.match(result.reason ?? "", /gate-wall not wired/);
});

test("E3: a PROMOTING build routes through the ONE authority and records `gateWallAllowed:true` — authorization comes from the gate-wall, not the safety projection", async () => {
  const h = realOrchestrator({ treeSeq: ["T"] });
  await run(h.orch, h.parentCtx, "t-auth");
  const promo = h.receipts.find((r) => r.operation === "worker.promotion");
  assert.ok(promo !== undefined, "the canonical promotion receipt exists");
  assert.equal(promo!.metadata.gateWallAllowed, true, "the promotion authorization is attributed to the gate-wall");
});

// ════════════════════════════════════════════════════════════════════════════════
// Part F — ADVISORY approvals cannot fabricate a safety fact
// ════════════════════════════════════════════════════════════════════════════════

test("F1: critic PASS only clears the critic gate — it can populate NO safety veto (a work opinion is not a safety observation)", () => {
  // With a veto observed, a passing critic cannot 'un-withhold' the work by supplying affirmative safety.
  const d = decidePromotability(work(), green(), noVeto({ refuted: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "safety-forensics" }, "a passing critic does not override an authentic safety veto");
});

test("F2: the safety construction reads NAMED observation sources only — never the integrator/critic role opinions", () => {
  const block = safetyConstructionBlock();
  assert.equal(/integrator/i.test(block), false, "no integrator opinion feeds a safety veto");
  assert.equal(/criticDetail|critic\b/i.test(block), false, "no critic opinion feeds a safety veto");
});

test("F3 [audit req 25 — the source boundary]: the construction block contains no synthetic affirmative safety token", () => {
  const block = safetyConstructionBlock();
  // A future synthetic constructor would smuggle in one of these affirmatives. Any hit fails the build.
  for (const forbidden of [/gateWallAuthorized/, /\bsafe\s*:\s*true/, /authorized\s*:/, /:\s*true\b/]) {
    assert.equal(forbidden.test(block), false, `synthetic affirmative safety token ${forbidden} appeared in the safety construction`);
  }
});

test("F4: an integrator 'promote' opinion does NOT promote when the tree is not verified-green (advisory ≠ safety evidence)", async () => {
  // The integrator role stub returns decision:'promote', but a stale/absent verified tree must still block.
  const h = realOrchestrator({ treeSeq: ["T-verified", "T-mutated"] });
  const result = await run(h.orch, h.parentCtx, "t-stale-adv");
  assert.notEqual(result.outcome, "success", "an advisory promote cannot ride a stale tree into promotion");
  assert.equal(h.promoteCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// Part G — failure / trust / runtime-truth / cost NON-interaction
// ════════════════════════════════════════════════════════════════════════════════

test("G1: a safety veto yields RETAIN (green-withheld) — a categorically non-failure outcome, never discard", () => {
  for (const k of VETO_KEYS) {
    const d = decidePromotability(work(), green(), noVeto({ [k]: true }), criticPass);
    assert.equal(d.action, "retain", `veto ${k} must RETAIN (not launder green work into a build failure)`);
  }
});

test("G2: the safety projection feeds ONLY `decidePromotability` + its provenance receipt — not trust, cost, or routing", () => {
  // The one consumer is the adjudication call; the receipt reports it. It is never threaded into trust/cost/routing.
  assert.match(orchestratorSrc, /decidePromotability\(wp, assessment, safety,/, "the sole decision consumer");
  assert.equal(/trust[\s\S]{0,40}safety\.|recordOutcome[\s\S]{0,60}safety\b/.test(orchestratorSrc), false, "safety is not an input to the trust ledger");
});

test("G3: `killed` (kill-switch / budget veto) → retain(adjudication-incomplete) — a halted run is never fabricated into a promote", () => {
  const d = decidePromotability(work(), green(), noVeto({ killed: true }), criticPass);
  assert.deepEqual(d, { action: "retain", reason: "adjudication-incomplete" });
});

// ════════════════════════════════════════════════════════════════════════════════
// Part H — determinism / totality of the safety half (pure)
// ════════════════════════════════════════════════════════════════════════════════

test("H1: identical safety facts ⇒ identical decision — the safety half is pure (no clock/model/I/O)", () => {
  const a = decidePromotability(work(), green(), noVeto({ refuted: true }), criticPass);
  const b = decidePromotability(work(), green(), noVeto({ refuted: true }), criticPass);
  assert.deepEqual(a, b);
});

test("H2: a promote binds the WORK's tree hash — a safety projection can never redirect the promoted tree", () => {
  const d = decidePromotability(work(), green(), noVeto(), criticPass);
  assert.equal(d.action === "promote" && d.treeHash, TREE);
});

test("H3: monotone lattice — across ALL 2^5 safety states on green work, a promote recommendation occurs IFF every veto is false", () => {
  let promoteCount = 0;
  const bools = [false, true];
  for (const externalInjection of bools) for (const effectiveBreach of bools) for (const refuted of bools) for (const killed of bools) for (const driftBlocked of bools) {
    const safety: SafetyAssessment = { externalInjection, effectiveBreach, refuted, killed, driftBlocked };
    const d: Decision = decidePromotability(work(), green(), safety, criticPass);
    const allClear = !externalInjection && !effectiveBreach && !refuted && !killed && !driftBlocked;
    assert.equal(d.action === "promote", allClear, `promote must occur IFF all vetoes are false — violated at ${JSON.stringify(safety)}`);
    if (d.action === "promote") promoteCount += 1;
  }
  assert.equal(promoteCount, 1, "exactly ONE of the 2^5 safety states (the all-clear one) yields a promote recommendation");
});

test("H4: every safety veto is honored on genuinely-green work — none is silently ignored (each true state withholds)", () => {
  for (const k of VETO_KEYS) {
    const d = decidePromotability(work(), green(), noVeto({ [k]: true }), criticPass);
    assert.notEqual(d.action, "promote", `veto ${k} was silently ignored — a dropped veto is a manufactured pass`);
  }
});
