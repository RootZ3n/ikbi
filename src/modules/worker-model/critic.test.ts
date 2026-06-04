import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { critic } from "./critic.js";
import type { RoleContext, RoleResult } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "critic", trustTier: "verified", spawnedFrom: "parent-1" };

function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5-pro", provider: "mimo", providerModelId: "mimo-v2.5-pro",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

const WS: WorkspaceHandle = {
  id: "ws1", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
  path: "/repo", identity: IDENTITY, state: "allocated", createdAt: 0,
};

function makeCtx(priorResults: RoleResult[], impl: (req: ModelRequest) => Promise<ModelResponse>) {
  const calls: ModelRequest[] = [];
  const ctx: RoleContext = {
    task: { taskId: "t-1", targetRepo: "/repo", goal: "add a health endpoint" },
    role: "critic",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: WS,
    priorResults,
    engine: {
      invokeModel: async (req) => {
        calls.push(req);
        return impl(req);
      },
      neutralizeUntrusted: () => {
        throw new Error("critic must not neutralize untrusted content (Pass-A constraint)");
      },
    },
  };
  return { ctx, calls };
}

const builderResult: RoleResult = { role: "builder", outcome: "success", summary: "added /health", detail: { files: ["server.ts"] } };

test("critic reads builder output and produces a PASS verdict (outcome success)", async () => {
  const { ctx, calls } = makeCtx([builderResult], async () => modelResponse("PASS\nlooks good, endpoint added"));
  const result = await critic(ctx);
  assert.equal(result.outcome, "success");
  const detail = result.detail as { pass: boolean; feedback: string };
  assert.equal(detail.pass, true);
  assert.match(detail.feedback, /looks good/);
  assert.equal(calls[0]?.identity, ctx.identity, "ctx.identity rides the request");
});

test("pass=false is still outcome:success (a successful critique that found problems)", async () => {
  const { ctx } = makeCtx([builderResult], async () => modelResponse("FAIL\nthe endpoint returns 500"));
  const result = await critic(ctx);
  assert.equal(result.outcome, "success", "the critique RAN — that is success regardless of the verdict");
  const detail = result.detail as { pass: boolean; feedback: string };
  assert.equal(detail.pass, false);
  assert.match(detail.feedback, /500/);
});

test("absent builder output → outcome:rejected (nothing to critique)", async () => {
  const { ctx, calls } = makeCtx([], async () => modelResponse("PASS"));
  const result = await critic(ctx);
  assert.equal(result.outcome, "rejected");
  assert.equal(calls.length, 0, "no model call when there is nothing to judge");
  const detail = result.detail as { pass: boolean };
  assert.equal(detail.pass, false);
});

test("an infrastructure (model) failure → outcome:failure", async () => {
  const { ctx } = makeCtx([builderResult], async () => {
    throw new Error("provider down");
  });
  const result = await critic(ctx);
  assert.equal(result.outcome, "failure");
  assert.match(result.summary ?? "", /provider down/);
});
