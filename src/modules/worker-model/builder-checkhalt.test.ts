import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, TrustTier } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver, type OperationContext } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createBuilder } from "./builder.js";
import type { RoleContext, RoleEngine, RoleResult } from "./contract.js";

const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
})();

const greenExec = () => ({ run: async (_req: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const writeResp = (): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("write_file", { path: "a.ts", content: "export const x=1;\n" })] });

function mockEngine(responses: ModelResponse[]): { engine: RoleEngine; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)] ?? writeResp(); i += 1; return r; },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  return { engine, requests };
}

function makeCtx(dir: string, engine: RoleEngine): RoleContext {
  const tier: TrustTier = "verified";
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: tier, spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity, state: "allocated", createdAt: 0 };
  return { task: { taskId: "t-1", targetRepo: dir, goal: "build the thing" }, role: "builder", identity, autonomy: autonomyForTier(tier), workspace, priorResults: [], engine };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-checkhalt-"));

test("checkHalt: a halt on the first iteration stops the builder BEFORE any model call", async () => {
  const { engine, requests } = mockEngine([writeResp()]);
  let calls = 0;
  const checkHalt = async (): Promise<{ halt: boolean; reason?: string }> => { calls += 1; return { halt: true, reason: "budget_exceeded" }; };
  const result = await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX, checkHalt })(makeCtx(tmp(), engine));
  assert.equal(requests.length, 0, "no model call — halted at the top of the loop");
  assert.equal(result.outcome, "failure");
  const detail = (result.detail ?? {}) as Record<string, unknown>;
  assert.equal(detail.stopReason, "budget_exceeded");
  assert.ok(calls >= 1, "checkHalt was polled");
});

test("checkHalt: when it never halts, the builder runs normally (transparent)", async () => {
  // Reuse the file-writing response: the builder should make model calls when not halted.
  const { engine, requests } = mockEngine([writeResp()]);
  const checkHalt = async (): Promise<{ halt: boolean; reason?: string }> => ({ halt: false });
  const result: RoleResult = await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX, checkHalt })(makeCtx(tmp(), engine));
  assert.ok(requests.length > 0, "model was invoked — the halt check is transparent when not halting");
  assert.ok(result.role === "builder");
});
