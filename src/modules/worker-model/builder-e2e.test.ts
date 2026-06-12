/**
 * REAL-PIPELINE E2E (Issue 3): real scout + real builder + real verifier + real integrator
 * run against ONE real workspace. The provider is mocked (deterministic tool calls, no API),
 * but every ROLE is the genuine implementation and governed checks run through the same
 * injected governed-exec seam the orchestrator/verifier use. This is the test that was missing
 * when the `done`-protocol bug shipped: the prior orchestrator test stubs the verifier, so a
 * builder that produced green work but mis-emitted `done` was never exercised end-to-end.
 *
 * Two scenarios:
 *   (A) HAPPY PATH — builder writes a file, run_checks green, emits a valid done → verifier
 *       passes → integrator promotes.
 *   (B) ISSUE-1 FAILURE CASE — builder writes correct, green work but NEVER calls done (loops
 *       to termination). The auto-accept on green-checks termination kicks in, the builder
 *       reports success, and the SAME pipeline still verifies and promotes — proving correct
 *       work is no longer discarded over a `done` protocol formality.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, TrustTier } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createBuilder } from "./builder.js";
import { createScout } from "./scout.js";
import { createVerifier } from "./verifier.js";
import { integrator } from "./integrator.js";
import type { RoleContext, RoleEngine, RoleFn, RoleResult, WorkerRole } from "./contract.js";

// --- shared identity / governed-exec wiring (mirrors builder.test / verifier.test) ---
const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-e2e" });
})();

/** A GREEN governed exec — every governed check exits 0 (the deterministic infra seam). */
const greenExec = () => ({ run: async (_req: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });

// --- mock provider: scripts model responses, runs the REAL neutralizer ---
function mockEngine(responses: ModelResponse[]): RoleEngine {
  let i = 0;
  return {
    invokeModel: async () => {
      const r = responses[Math.min(i, responses.length - 1)] ?? stopResp();
      i += 1;
      return r;
    },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
}
/** An engine that must NEVER be asked for a completion (verifier legacy mode / integrator). */
const inertEngine: RoleEngine = {
  invokeModel: async () => { throw new Error("the model must not be invoked by this role in this test"); },
  neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
};

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stopResp = (content = "done"): ModelResponse => ({ ...base(), content, finishReason: "stop" });
const textResp = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

function makeCtx(dir: string, role: WorkerRole, engine: RoleEngine, priorResults: RoleResult[] = [], goal = "Add a sum() helper in src/sum.ts"): RoleContext {
  const tier: TrustTier = "verified";
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: role, trustTier: tier, spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = {
    id: "ws-e2e", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws-e2e",
    path: dir, identity, state: "allocated", createdAt: 0,
  };
  return { task: { taskId: "t-e2e", targetRepo: dir, goal }, role, identity, autonomy: autonomyForTier(tier), workspace, priorResults, engine };
}

/** A real-ish small TypeScript project the scout reads and the builder extends. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-e2e-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", scripts: { typecheck: "tsc --noEmit", test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "nodenext" } }, null, 2) + "\n");
  writeFileSync(join(dir, "src", "math.ts"), "export function mul(a: number, b: number): number {\n  return a * b;\n}\n");
  return dir;
}

/** A workspace diff for the verifier's script-integrity guard — shows the new src file, NOT a
 *  package.json script mutation, so the guard passes (and is genuinely exercised). */
const cleanDiff = async (): Promise<string> =>
  "diff --git a/src/sum.ts b/src/sum.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/sum.ts\n@@ -0,0 +1,3 @@\n+export function sum(a: number, b: number): number {\n+  return a + b;\n+}\n";

const SUM_CONTENT = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";

/** Build the real verifier (legacy mode: governed checks + script-integrity + quality). */
function realVerifier(): RoleFn {
  return createVerifier({ governedExec: greenExec(), parentCtx: PARENT_CTX, diff: cleanDiff });
}

/** A passing critic stub (the integrator gates on critic.pass; the critic role itself is not
 *  under test here — Issue 3 targets the scout→builder→verifier path the done-bug slipped through). */
const passingCritic: RoleResult = { role: "critic", outcome: "success", summary: "looks good", detail: { pass: true } };

test("E2E (happy path): real scout → real builder (valid done) → real verifier → integrator PROMOTES", async () => {
  const dir = makeProject();

  // 1) REAL SCOUT — reads the repo, the mock model returns one concrete finding.
  const scout = createScout();
  const scoutResult = await scout(makeCtx(dir, "scout", mockEngine([textResp("- src/math.ts:1 has mul(); the goal needs a sibling sum() in src/sum.ts")])));
  assert.equal(scoutResult.outcome, "success", "scout produced a result");
  assert.ok(Array.isArray((scoutResult.detail as { findings?: unknown[] }).findings), "scout produced structured findings");

  // 2) REAL BUILDER (agent mode) — writes a NEW file, run_checks green, emits a valid done.
  const builder = createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX });
  const builderResult = await builder(makeCtx(dir, "builder", mockEngine([
    toolResp([call("write_file", { path: "src/sum.ts", content: SUM_CONTENT })]),
    toolResp([call("run_checks", {})]),
    toolResp([call("done", { successCondition: "sum() exists in src/sum.ts", filesReadBack: ["src/sum.ts"], selfCheck: "re-read src/sum.ts; sum() is present", satisfied: true })]),
  ]), [scoutResult]));
  assert.equal(builderResult.outcome, "success", "builder converged with a valid done");
  assert.deepEqual((builderResult.detail as { filesWritten: string[] }).filesWritten, ["src/sum.ts"]);

  // 3) REAL VERIFIER — script-integrity guard + governed checks + quality, all on the real worktree.
  const verifierResult = await realVerifier()(makeCtx(dir, "verifier", inertEngine, [scoutResult, builderResult]));
  assert.equal(verifierResult.outcome, "success", "verifier passed");
  assert.equal((verifierResult.detail as { verdict: string }).verdict, "pass", "verdict is pass (quality + checks green)");

  // 4) REAL INTEGRATOR — weighs the chain and issues the PROMOTE decision.
  const integ = await integrator(makeCtx(dir, "integrator", inertEngine, [scoutResult, builderResult, passingCritic, verifierResult]));
  assert.equal((integ.detail as { decision: string }).decision, "promote", "the full pipeline produces a PROMOTED result");
});

test("E2E (Issue-1 failure case): builder writes green work but NEVER calls done → auto-accept → verifier passes → PROMOTE", async () => {
  const dir = makeProject();

  const scout = createScout();
  const scoutResult = await scout(makeCtx(dir, "scout", mockEngine([textResp("- src/math.ts:1 mul() present; add sum() to src/sum.ts")])));

  // The builder writes the file and runs GREEN checks, then keeps listing the dir forever —
  // it never emits a schema-valid `done`. Pre-Issue-1 this was discarded as a failure.
  const builder = createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX });
  const builderResult = await builder(makeCtx(dir, "builder", mockEngine([
    toolResp([call("write_file", { path: "src/sum.ts", content: SUM_CONTENT })]),
    toolResp([call("run_checks", {})]),
    toolResp([call("list_dir", { path: "." })]), // repeats → loops to termination, no valid done
  ]), [scoutResult]));

  // ISSUE 1: the green, current, non-empty work is auto-accepted as SUCCESS, not failure.
  assert.equal(builderResult.outcome, "success", "auto-accept rescued green work that lacked a `done`");
  const bdetail = builderResult.detail as { stopReason: string; doneClaim?: { selfCheck: string } };
  assert.equal(bdetail.stopReason, "done", "termination was reclassified via the synthesized done claim");
  assert.match(bdetail.doneClaim?.selfCheck ?? "", /auto: checks green at termination/);

  // The REST of the real pipeline accepts it exactly like a normally-completed build.
  const verifierResult = await realVerifier()(makeCtx(dir, "verifier", inertEngine, [scoutResult, builderResult]));
  assert.equal(verifierResult.outcome, "success", "verifier passes the auto-accepted work");
  assert.equal((verifierResult.detail as { verdict: string }).verdict, "pass");

  const integ = await integrator(makeCtx(dir, "integrator", inertEngine, [scoutResult, builderResult, passingCritic, verifierResult]));
  assert.equal((integ.detail as { decision: string }).decision, "promote", "auto-accepted green work is promoted (the bug this guards against)");
});
