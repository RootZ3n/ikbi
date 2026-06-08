/**
 * Fix 4 (audit): project memory (CLAUDE.md / AGENTS.md) reaches the builder + chat model
 * context, routed through the neutralization chokepoint (honored but bounded). A missing
 * file does not crash.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { pino } from "pino";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { loadProjectInstructions, MAX_PROJECT_INSTRUCTION_BYTES } from "./project-memory.js";
import { createBuilder } from "./builder.js";
import type { RoleContext, RoleEngine } from "./contract.js";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const RULE = "PROJECT_RULE: always use 4-space indentation and never edit dist/.";
const ID: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: "verified", spawnedFrom: "parent-1" };

function makeParentCtx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }), now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
}

// ── loader (pure) ─────────────────────────────────────────────────────────────

test("loadProjectInstructions reads CLAUDE.md; missing ⇒ undefined; AGENTS.md is the fallback", () => {
  const a = tmp("ikbi-pm-claude-");
  writeFileSync(join(a, "CLAUDE.md"), RULE);
  assert.equal(loadProjectInstructions(a)?.content, RULE);
  assert.equal(loadProjectInstructions(a)?.source, "CLAUDE.md");

  const b = tmp("ikbi-pm-none-");
  assert.equal(loadProjectInstructions(b), undefined, "no file ⇒ undefined (no crash)");

  const c = tmp("ikbi-pm-agents-");
  writeFileSync(join(c, "AGENTS.md"), "use AGENTS rules");
  assert.equal(loadProjectInstructions(c)?.source, "AGENTS.md");
});

test("loadProjectInstructions bounds a huge file", () => {
  const d = tmp("ikbi-pm-big-");
  writeFileSync(join(d, "CLAUDE.md"), "x".repeat(MAX_PROJECT_INSTRUCTION_BYTES + 5_000));
  const r = loadProjectInstructions(d);
  assert.ok(r);
  assert.ok((r?.content.length ?? 0) <= MAX_PROJECT_INSTRUCTION_BYTES + 32, "content is bounded (+ truncation marker)");
  assert.match(r!.content, /truncated/);
});

// ── builder: project memory reaches the model context ────────────────────────

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const greenExec = () => ({ run: async (_r: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });

function builderCtx(dir: string, engine: RoleEngine): RoleContext {
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity: ID, state: "allocated", createdAt: 0 };
  return { task: { taskId: "t", targetRepo: dir, goal: "do the thing" }, role: "builder", identity: ID, autonomy: autonomyForTier("verified"), workspace, priorResults: [], engine };
}

test("builder context INCLUDES the target's CLAUDE.md rules (routed through neutralize)", async () => {
  const dir = tmp("ikbi-pm-builder-");
  writeFileSync(join(dir, "CLAUDE.md"), RULE);
  const requests: ModelRequest[] = [];
  let i = 0;
  const responses: ModelResponse[] = [
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("run_checks", {})] },
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("done", { successCondition: "met", filesReadBack: [], selfCheck: "ran checks", satisfied: true })] },
  ];
  const neutralizeOrigins: string[] = [];
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)]!; i += 1; return r; },
    neutralizeUntrusted: (content, ctx) => { neutralizeOrigins.push(ctx.origin ?? ""); return coreNeutralize(content, ctx); },
  };
  await createBuilder({ governedExec: greenExec(), parentCtx: makeParentCtx() })(builderCtx(dir, engine));

  const firstMsgs = requests[0]?.messages ?? [];
  const hasRule = firstMsgs.some((m) => typeof m.content === "string" && m.content.includes(RULE));
  assert.ok(hasRule, "the builder prompt carries the CLAUDE.md rule");
  assert.ok(neutralizeOrigins.includes("project_instructions"), "project memory went through the neutralize chokepoint");
  const projMsg = firstMsgs.find((m) => typeof m.content === "string" && m.content.includes(RULE));
  assert.equal(projMsg?.untrusted, true, "carried as an isolated UNTRUSTED data message, not trusted system text");
});

test("builder does NOT crash when the target has no CLAUDE.md (project memory simply absent)", async () => {
  const dir = tmp("ikbi-pm-builder-none-");
  const requests: ModelRequest[] = [];
  let i = 0;
  const responses: ModelResponse[] = [
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("run_checks", {})] },
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("done", { successCondition: "met", filesReadBack: [], selfCheck: "ran checks", satisfied: true })] },
  ];
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)]!; i += 1; return r; },
    neutralizeUntrusted: (content, ctx) => coreNeutralize(content, ctx),
  };
  const result = await createBuilder({ governedExec: greenExec(), parentCtx: makeParentCtx() })(builderCtx(dir, engine));
  assert.equal(result.role, "builder", "the builder produced a result (did not crash) with no project memory");
  assert.ok(requests.length >= 1, "the builder still ran its model loop");
  // No project_instructions message present.
  const noneMsgs = requests[0]?.messages ?? [];
  assert.ok(!noneMsgs.some((m) => typeof m.content === "string" && m.content.includes("Project instructions from the target repo")), "no project-memory message when there is no file");
});
