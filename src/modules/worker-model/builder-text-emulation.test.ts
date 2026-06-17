import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, TrustTier } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver, type OperationContext } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createBuilder } from "./builder.js";
import type { RoleContext, RoleEngine } from "./contract.js";

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
    contractVersion: "1.1.0", model: "deepseek-reasoner", provider: "deepseek", providerModelId: "deepseek-reasoner",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
// A TEXT response (finishReason "stop", no structured toolCalls) carrying a fenced tool call.
const textResp = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

function mockEngine(responses: ModelResponse[]): { engine: RoleEngine; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)] ?? textResp("done"); i += 1; return r; },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  return { engine, requests };
}

function makeCtx(dir: string, engine: RoleEngine): RoleContext {
  const tier: TrustTier = "verified";
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: tier, spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity, state: "allocated", createdAt: 0 };
  return { task: { taskId: "t-1", targetRepo: dir, goal: "create a.ts" }, role: "builder", identity, autonomy: autonomyForTier(tier), workspace, priorResults: [], engine };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-emul-"));

test("text emulation: a no-tool-API model drives a write_file via a fenced JSON tool call", async () => {
  const dir = tmp();
  const write = textResp('I will create the file.\n```json\n{"tool": "write_file", "args": {"path": "a.ts", "content": "export const x = 1;\\n"}}\n```');
  const { engine, requests } = mockEngine([write]);
  // modelOverride "deepseek-reasoner" ⇒ getCapabilities → supports_tools:false ⇒ emulation on.
  await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX, modelOverride: "deepseek-reasoner" })(makeCtx(dir, engine));

  assert.ok(existsSync(join(dir, "a.ts")), "the text-emitted write_file actually wrote the file");
  // Emulated mode sends NO native tools array (the model can't use one).
  assert.deepEqual(requests[0]?.tools, [], "no native tools sent to a no-tool-API model");
  // The system prompt carries the text-protocol instructions.
  const sys = requests[0]?.messages?.[0];
  assert.equal(sys?.role, "system");
  assert.match(String(sys?.content ?? ""), /no native tool API/);
});
