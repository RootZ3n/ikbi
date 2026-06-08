/**
 * HB-3 acceptance: a target repo's CLAUDE.md rule reaches the builder's model context (via the
 * neutralization chokepoint). A missing CLAUDE.md injects nothing and does not crash.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { neutralizeUntrusted as coreNeutralize } from "../core/injection/index.js";
import type { AgentIdentity } from "../core/identity/contract.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../core/provider/contract.js";
import { autonomyForTier } from "../core/trust/index.js";
import type { WorkspaceHandle } from "../core/workspace/contract.js";
import { createBuilder } from "../modules/worker-model/builder.js";
import type { RoleContext, RoleEngine } from "../modules/worker-model/contract.js";
import { makeIdentities } from "./harness.js";

const RULE = "PROJECT RULE: never edit config.yaml — it is generated.";
const ID: AgentIdentity = { agentId: "worker", functionalRole: "builder", trustTier: "trusted", spawnedFrom: "lead" };
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return { contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [] };
}
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const greenExec = () => ({ run: async (): Promise<import("../modules/governed-exec/index.js").ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });

function captureEngine(): { engine: RoleEngine; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  const responses: ModelResponse[] = [
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("run_checks", {})] },
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("done", { successCondition: "met", filesReadBack: [], selfCheck: "ran checks", satisfied: true })] },
  ];
  return {
    requests,
    engine: {
      invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)]!; i += 1; return r; },
      neutralizeUntrusted: (content, ctx) => coreNeutralize(content, ctx),
    },
  };
}

function ctxFor(dir: string, engine: RoleEngine): RoleContext {
  const ws: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity: ID, state: "allocated", createdAt: 0 };
  return { task: { taskId: "t", targetRepo: dir, goal: "do the thing" }, role: "builder", identity: ID, autonomy: autonomyForTier("trusted"), workspace: ws, priorResults: [], engine };
}

test("HB-3: the target's CLAUDE.md rule appears in the builder's context (carried untrusted)", async () => {
  const dir = tmp("ikbi-accept-claude-");
  writeFileSync(join(dir, "CLAUDE.md"), `# Project conventions\n\n- ${RULE}\n`);
  const { engine, requests } = captureEngine();
  const { parentCtx } = makeIdentities();

  await createBuilder({ governedExec: greenExec(), parentCtx })(ctxFor(dir, engine));

  const msgs = requests[0]?.messages ?? [];
  const proj = msgs.find((m) => typeof m.content === "string" && m.content.includes(RULE));
  assert.ok(proj, "the CLAUDE.md rule is present in the builder's first model request");
  assert.equal(proj?.untrusted, true, "carried as isolated UNTRUSTED project context, not trusted system text");
  assert.match(proj!.content, /Project instructions from the target repo/);
});

test("HB-3: a missing CLAUDE.md injects no project memory and does not crash", async () => {
  const dir = tmp("ikbi-accept-noclaude-");
  const { engine, requests } = captureEngine();
  const { parentCtx } = makeIdentities();

  const result = await createBuilder({ governedExec: greenExec(), parentCtx })(ctxFor(dir, engine));
  assert.equal(result.role, "builder", "the builder produced a result (no crash)");
  const msgs = requests[0]?.messages ?? [];
  assert.ok(!msgs.some((m) => typeof m.content === "string" && m.content.includes("Project instructions from the target repo")), "no project-memory message when there is no CLAUDE.md");
});
