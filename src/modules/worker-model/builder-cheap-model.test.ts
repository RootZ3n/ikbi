/**
 * ikbi builder — CHEAP-MODEL ERGONOMICS (Principle 3: ACTIONABLE error messages).
 *
 * deepseek-v4-flash / mimo-v2.5 cannot recover from a paragraph that explains WHY a guard
 * fired — they need the single NEXT MOVE. These tests pin that every guard the builder can
 * trip now answers the model with an imperative "do X next", not an explanation. The guards
 * themselves are UNCHANGED (the security behavior + the internal rejectedToolCalls.error are
 * still exactly as the hardening tests assert) — only the MODEL-FACING string is actionable.
 *
 * Additive: no existing test or behavior is modified; this file only adds coverage.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, TrustTier } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createBuilder, type ToolCallError } from "./builder.js";
import type { RoleContext, RoleEngine, RoleResult, WorkerTask } from "./contract.js";

// --- harness (mirrors builder-hardening.test) ------------------------------
const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
})();
const greenExec = () => ({ run: async (_req: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });
const run = (ctx: RoleContext, exec: { run: (req: ExecRequest) => Promise<ExecResult> } = greenExec()) =>
  createBuilder({ governedExec: exec, parentCtx: PARENT_CTX })(ctx);

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const lengthResp = (): ModelResponse => ({ ...base(), content: "", finishReason: "length" });
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

function mockEngine(responses: ModelResponse[]) {
  const requests: ModelRequest[] = [];
  let i = 0;
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)] ?? lengthResp(); i += 1; return r; },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  return { engine, requests };
}

function makeCtx(dir: string, tier: TrustTier, engine: RoleEngine, goal = "build the thing", writeScope?: WorkerTask["writeScope"]): RoleContext {
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: tier, spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity, state: "allocated", createdAt: 0 };
  const task: WorkerTask = { taskId: "t-1", targetRepo: dir, goal, ...(writeScope !== undefined ? { writeScope } : {}) };
  return { task, role: "builder", identity, autonomy: autonomyForTier(tier), workspace, priorResults: [] as RoleResult[], engine };
}
const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-builder-cheap-"));

/** All tool-result/feedback messages the builder fed back to the model, as plain strings. */
function toolMessages(requests: ModelRequest[]): string[] {
  return requests.flatMap((r) => r.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
}

// ── ACTIONABLE ERRORS — the guard fires with a NEXT MOVE, not a lecture ──────

test("read-before-write: the model is told to call read_file('path') NEXT (not why it was wrong)", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "routes.ts"), "export const original = 1;\n");
  const { engine, requests } = mockEngine([
    toolResp([call("write_file", { path: "routes.ts", content: "export const clobbered = 2;\n" })]),
    lengthResp(),
  ]);
  const result = await run(makeCtx(dir, "verified", engine));
  // GUARD UNCHANGED: still rejected, still with the same internal reason the hardening test pins.
  const rej = (result.detail as { rejectedToolCalls: ToolCallError[] }).rejectedToolCalls.find((r) => r.tool === "write_file");
  assert.match(rej?.error ?? "", /write before read/i, "internal reason unchanged (hardening contract holds)");
  // MODEL-FACING: actionable — the exact next call, with the path.
  const msg = toolMessages(requests).find((c) => c.includes("read_file('routes.ts')"));
  assert.ok(msg, "the model is handed the exact next call: read_file('routes.ts')");
  assert.match(msg!, /First call read_file\('routes\.ts'\)/, "leads with the action, not an explanation");
});

test("write_scope new_only on an existing file: told to CREATE a new file next", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "exists.ts"), "export const a = 1;\n");
  const { engine, requests } = mockEngine([
    toolResp([call("write_file", { path: "exists.ts", content: "export const a = 2;\n" })]),
    lengthResp(),
  ]);
  await run(makeCtx(dir, "verified", engine, "build the thing", "new_only"));
  const msg = toolMessages(requests).find((c) => c.includes("only allows NEW files"));
  assert.ok(msg, "the model is told the allowed move: pick a new path");
  assert.match(msg!, /Pick a new path and call write_file again/);
});

test("dependency-guard: told to write to src/ instead (the allowed location, first)", async () => {
  const dir = tmp();
  const { engine, requests } = mockEngine([
    toolResp([call("write_file", { path: "node_modules/x.ts", content: "export const a = 1;\n" })]),
    lengthResp(),
  ]);
  await run(makeCtx(dir, "verified", engine));
  const msg = toolMessages(requests).find((c) => c.includes("Write to src/"));
  assert.ok(msg, "the model is pointed at src/ as the place to write");
});

test("done before run_checks: told to call run_checks next (one move)", async () => {
  const dir = tmp();
  const { engine, requests } = mockEngine([
    toolResp([call("write_file", { path: "fresh.ts", content: "export const x = 1;\n" })]),
    toolResp([call("done", { successCondition: "x", filesReadBack: ["fresh.ts"], selfCheck: "y", satisfied: true })]),
    lengthResp(),
  ]);
  await run(makeCtx(dir, "verified", engine));
  const msg = toolMessages(requests).find((c) => c.includes("call run_checks") && c.includes("Do this next"));
  assert.ok(msg, "a done before run_checks gets the single next move");
});

// ── PRINCIPLE 8 — the read-before-write guard is INVISIBLE for NEW files ─────

test("creating a NEW file never trips the read-before-write guard (no rejection, file written)", async () => {
  const dir = tmp();
  const { engine } = mockEngine([
    toolResp([call("write_file", { path: "src/brand-new.ts", content: "export const x = 1;\n" })]),
    toolResp([call("run_checks", {})]),
    toolResp([call("done", { successCondition: "x", filesReadBack: ["src/brand-new.ts"], selfCheck: "y", satisfied: true })]),
  ]);
  const result = await run(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "success", "new-file creation flows straight through — the guard is invisible here");
  const detail = result.detail as { rejectedToolCalls: ToolCallError[]; filesWritten: string[] };
  assert.equal(detail.rejectedToolCalls.length, 0, "no guard fired on the brand-new file");
  assert.deepEqual(detail.filesWritten, ["src/brand-new.ts"]);
});
