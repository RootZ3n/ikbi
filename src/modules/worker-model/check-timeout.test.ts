/**
 * BLOCKER 1 (audit): the builder's in-loop run_checks must use the SAME per-check wall-clock
 * budget the verifier uses (IKBI_CHECK_TIMEOUT_MS, default 600s) — NOT governed-exec's 30s
 * read-only-tool default. Any repo whose tests exceed 30s would otherwise get SIGKILL'd in the
 * builder loop while the verifier (which DOES pass the larger budget) would have passed it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createBuilder } from "./builder.js";
import { createVerifier } from "./verifier.js";
import { DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS, resolveCheckTimeoutMs, type ChecksResolution } from "./checks.js";
import type { RoleContext, RoleEngine } from "./contract.js";

const silent = () => pino({ level: "silent" });
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const ID: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: "verified", spawnedFrom: "parent-1" };
const NPM_CHECKS: ChecksResolution = { ok: true, checks: [{ name: "test", command: "npm", args: ["test"] }], source: "env" };

function makeParentCtx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: silent(), now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
}

function recordingExec() {
  const calls: ExecRequest[] = [];
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } };
  return { governedExec, calls };
}

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
function call(name: string, args: unknown, id = "c1"): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

// ── resolveCheckTimeoutMs (pure) ──────────────────────────────────────────────

test("resolveCheckTimeoutMs: default, override, clamp, invalid", () => {
  assert.equal(resolveCheckTimeoutMs({} as NodeJS.ProcessEnv), DEFAULT_CHECK_TIMEOUT_MS, "unset → default 600s");
  assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 600_000, "default is the large budget, not governed-exec's 30s");
  assert.equal(resolveCheckTimeoutMs({ IKBI_CHECK_TIMEOUT_MS: "120000" } as unknown as NodeJS.ProcessEnv), 120_000, "valid → honored");
  assert.equal(resolveCheckTimeoutMs({ IKBI_CHECK_TIMEOUT_MS: "999999999999" } as unknown as NodeJS.ProcessEnv), MAX_CHECK_TIMEOUT_MS, "huge → clamped below setTimeout overflow");
  assert.equal(resolveCheckTimeoutMs({ IKBI_CHECK_TIMEOUT_MS: "nonsense" } as unknown as NodeJS.ProcessEnv), DEFAULT_CHECK_TIMEOUT_MS, "invalid → default");
  assert.equal(resolveCheckTimeoutMs({ IKBI_CHECK_TIMEOUT_MS: "-5" } as unknown as NodeJS.ProcessEnv), DEFAULT_CHECK_TIMEOUT_MS, "non-positive → default");
});

// ── the builder's run_checks and the verifier pass the SAME timeoutMs ─────────

test("builder run_checks passes the large check timeout (NOT governed-exec's 30s default)", async () => {
  const wt = tmp("ikbi-build-timeout-");
  const exec = recordingExec();
  let i = 0;
  const responses: ModelResponse[] = [
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("run_checks", {})] },
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("done", { successCondition: "met", filesReadBack: [], selfCheck: "ran the checks green", satisfied: true })] },
  ];
  const engine: RoleEngine = {
    invokeModel: async () => { const r = responses[Math.min(i, responses.length - 1)]!; i += 1; return r; },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  const ws: WorkspaceHandle = { id: "ws1", targetRepo: wt, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: wt, identity: ID, state: "allocated", createdAt: 0 };
  const ctx: RoleContext = {
    task: { taskId: "t", targetRepo: wt, goal: "g" }, role: "builder", identity: ID, autonomy: autonomyForTier("verified"), workspace: ws, priorResults: [], engine,
  };
  await createBuilder({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), resolveChecks: () => NPM_CHECKS })(ctx);
  assert.ok(exec.calls.length >= 1, "run_checks executed");
  for (const c of exec.calls) {
    assert.equal(c.timeoutMs, DEFAULT_CHECK_TIMEOUT_MS, "run_checks used the large check budget, not the 30s default");
  }
});

test("verifier (legacy loop) passes the SAME check timeout the builder uses", async () => {
  const wt = tmp("ikbi-verify-timeout-");
  const exec = recordingExec();
  const ws: WorkspaceHandle = { id: "ws1", targetRepo: wt, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: wt, identity: ID, state: "allocated", createdAt: 0 };
  const ctx: RoleContext = {
    task: { taskId: "t", targetRepo: wt, goal: "g" }, role: "verifier", identity: ID, autonomy: autonomyForTier("verified"),
    workspace: ws, priorResults: [], engine: { invokeModel: async () => { throw new Error("no"); }, neutralizeUntrusted: () => { throw new Error("no"); } },
  };
  await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: async () => "diff --git a/x b/x\n+y\n", resolveChecks: () => NPM_CHECKS })(ctx);
  assert.ok(exec.calls.length >= 1, "verifier checks ran");
  for (const c of exec.calls) {
    assert.equal(c.timeoutMs, DEFAULT_CHECK_TIMEOUT_MS, "verifier legacy loop uses the same large check budget");
  }
});
