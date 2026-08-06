import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { OperationContext } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult, GovernedExec } from "../governed-exec/index.js";
import { createBuilder } from "./builder.js";
import type { RoleContext, RoleEngine } from "./contract.js";

const parentCtx: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "phase2-parent", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("phase2-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1,
  });
  return beginOperation(resolver.resolve({ token: "phase2-secret" }), { requestId: "phase2-request" });
})();

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `builder-${name}`, name, arguments: JSON.stringify(args) };
}

function toolCall(...calls: ToolCall[]): ModelResponse {
  return { ...base(), content: "", finishReason: "tool_calls", toolCalls: calls };
}

function engine(responses: ModelResponse[]): RoleEngine {
  let index = 0;
  return {
    invokeModel: async (_request: ModelRequest) => responses[Math.min(index++, responses.length - 1)]!,
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
}

function greenExec(): Pick<GovernedExec, "run"> {
  return { run: async (_request: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) };
}

test("builder full read followed by replace uses the state-bound mutation core", async () => {
  const root = mkdtempSync(join(tmpdir(), "ikbi-builder-bound-"));
  const target = mkdtempSync(join(tmpdir(), "ikbi-builder-target-"));
  const identity = { agentId: "phase2-builder", functionalRole: "builder", trustTier: "verified" } as const;
  const workspace: WorkspaceHandle = {
    id: "phase2-builder-ws",
    targetRepo: target,
    baseBranch: "main",
    baseRef: "base",
    scratchBranch: "ikbi/ws/phase2-builder-ws",
    path: root,
    identity,
    state: "allocated",
    createdAt: 1,
  };
  writeFileSync(join(root, "existing.ts"), "before\n", "utf8");
  const responses = [
    toolCall(call("read_file", { path: "existing.ts" })),
    toolCall(call("write_file", { path: "existing.ts", content: "after\n" })),
    toolCall(call("run_checks", {})),
    toolCall(call("done", { successCondition: "replace existing.ts", filesReadBack: ["existing.ts"], selfCheck: "the exact replacement is present", satisfied: true })),
  ];
  const context: RoleContext = {
    task: { taskId: "phase2-builder-task", candidateId: "phase2-candidate", targetRepo: target, goal: "replace existing.ts" },
    role: "builder",
    identity,
    autonomy: autonomyForTier("verified"),
    workspace,
    mutationBinding: {
      sessionId: "phase2-builder-session",
      workspaceId: workspace.id,
      candidateId: "phase2-candidate",
      generationId: "phase2-generation",
      actor: "model",
      cause: "model",
      ...(parentCtx.requestId !== undefined ? { requestId: parentCtx.requestId } : {}),
      attemptId: "phase2-attempt",
      role: "builder",
      validatedIdentity: identity.agentId,
    },
    priorResults: [],
    engine: engine(responses),
  };
  const result = await createBuilder({ governedExec: greenExec(), parentCtx })(context);
  assert.equal(readFileSync(join(root, "existing.ts"), "utf8"), "after\n");
  const detail = result.detail as { filesRead: string[]; filesWritten: string[] };
  assert.deepEqual(detail.filesRead, ["existing.ts"]);
  assert.deepEqual(detail.filesWritten, ["existing.ts"]);
});

test("builder stale patch is surfaced without relocation or a direct-write fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "ikbi-builder-stale-"));
  const target = mkdtempSync(join(tmpdir(), "ikbi-builder-stale-target-"));
  const identity = { agentId: "phase2-builder-stale", functionalRole: "builder", trustTier: "verified" } as const;
  const workspace: WorkspaceHandle = {
    id: "phase2-builder-stale-ws",
    targetRepo: target,
    baseBranch: "main",
    baseRef: "base",
    scratchBranch: "ikbi/ws/phase2-builder-stale-ws",
    path: root,
    identity,
    state: "allocated",
    createdAt: 1,
  };
  writeFileSync(join(root, "existing.ts"), "anchor\noriginal\n", "utf8");
  const responses = [
    toolCall(call("read_file", { path: "existing.ts" })),
    toolCall(call("patch", { path: "existing.ts", old_string: "anchor", new_string: "changed" })),
    { ...base(), content: "stop", finishReason: "stop" as const },
  ];
  let index = 0;
  const staleEngine: RoleEngine = {
    invokeModel: async () => {
      if (index === 1) writeFileSync(join(root, "existing.ts"), "anchor\nexternal\n", "utf8");
      return responses[Math.min(index++, responses.length - 1)]!;
    },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  const context: RoleContext = {
    task: { taskId: "phase2-builder-stale-task", candidateId: "phase2-builder-stale-candidate", targetRepo: target, goal: "patch existing.ts" },
    role: "builder",
    identity,
    autonomy: autonomyForTier("verified"),
    workspace,
    mutationBinding: {
      sessionId: "phase2-builder-stale-session",
      workspaceId: workspace.id,
      candidateId: "phase2-builder-stale-candidate",
      generationId: "phase2-builder-stale-generation",
      actor: "model",
      cause: "model",
      attemptId: "phase2-builder-stale-attempt",
      role: "builder",
      validatedIdentity: identity.agentId,
    },
    priorResults: [],
    engine: staleEngine,
  };
  const result = await createBuilder({ governedExec: greenExec(), parentCtx })(context);
  assert.equal(readFileSync(join(root, "existing.ts"), "utf8"), "anchor\nexternal\n");
  const detail = result.detail as { rejectedToolCalls: readonly { error: string }[]; filesWritten: readonly string[] };
  assert.ok(detail.rejectedToolCalls.some((entry) => entry.error.includes("STALE_MUTATION")));
  assert.deepEqual(detail.filesWritten, []);
});
