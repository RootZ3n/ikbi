import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity } from "../../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../../core/identity/registry.js";
import type { OperationContext } from "../../../core/identity/index.js";
import type { ModelResponse, ToolCall } from "../../../core/provider/contract.js";
import { autonomyForTier } from "../../../core/trust/index.js";
import type { WorkspaceHandle } from "../../../core/workspace/contract.js";
import { createBuilder } from "../builder.js";
import type { RoleContext, RoleEngine } from "../contract.js";
import type { ExecRequest, ExecResult } from "../../governed-exec/index.js";
import { GIT_TOOL_NAMES, runGitTool } from "./git-tools.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-git-"));
const FAKE_CTX = { requestId: "r" } as unknown as OperationContext;

function execSpy(result: ExecResult = { executed: true, exitCode: 0, stdoutTail: "OK-OUTPUT", stderrTail: "" }) {
  const calls: ExecRequest[] = [];
  return { calls, exec: { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return result; } } };
}

test("GIT_TOOL_NAMES covers the three read-only inspectors", () => {
  assert.deepEqual([...GIT_TOOL_NAMES].sort(), ["git_diff", "git_log", "git_status"]);
});

test("git_status runs `git status --short --branch` through governed-exec in the worktree", async () => {
  const dir = tmp();
  const spy = execSpy();
  const out = await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_status", {});
  assert.equal(spy.calls[0]?.command, "git");
  assert.deepEqual(spy.calls[0]?.args, ["status", "--short", "--branch"]);
  assert.equal(spy.calls[0]?.cwd, dir);
  assert.match(out, /OK-OUTPUT/);
});

test("git_diff defaults to unstaged; staged:true adds --staged", async () => {
  const dir = tmp();
  const spy = execSpy();
  await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_diff", {});
  assert.deepEqual(spy.calls[0]?.args, ["diff"]);
  await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_diff", { staged: true });
  assert.deepEqual(spy.calls[1]?.args, ["diff", "--staged"]);
});

test("git_diff confines a path argument; an escape is rejected before exec", async () => {
  const dir = tmp();
  const spy = execSpy();
  await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_diff", { path: "src/a.ts" });
  assert.deepEqual(spy.calls[0]?.args, ["diff", "--", "src/a.ts"]);
  const escaped = await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_diff", { path: "../../etc/passwd" });
  assert.match(escaped, /escapes the worktree/);
  assert.equal(spy.calls.length, 1, "the escaping diff never reached governed-exec");
});

test("git_log clamps the commit count to the max", async () => {
  const dir = tmp();
  const spy = execSpy();
  await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_log", { count: 5 });
  assert.deepEqual(spy.calls[0]?.args, ["log", "--oneline", "-n", "5"]);
  await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_log", { count: 9999 });
  assert.deepEqual(spy.calls[1]?.args, ["log", "--oneline", "-n", "100"], "clamped to 100");
});

test("git tools NEVER run a mutating subcommand — the verb is template-built, not model-supplied", async () => {
  const dir = tmp();
  const spy = execSpy();
  // Even if the model tries to smuggle a verb, only the fixed status/diff/log argv is built.
  await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_status", { subcommand: "push", args: ["origin", "main"] });
  assert.deepEqual(spy.calls[0]?.args, ["status", "--short", "--branch"], "ignores smuggled verb/args");
});

test("git tools fail closed without a parent identity (no governed authorization)", async () => {
  const dir = tmp();
  const spy = execSpy();
  const out = await runGitTool({ governedExec: spy.exec }, dir, "git_status", {});
  assert.match(out, /no parent identity/);
  assert.equal(spy.calls.length, 0);
});

test("git tools surface a governed-exec DENIED verdict", async () => {
  const dir = tmp();
  const spy = execSpy({ executed: false, denied: true, reason: "git not on allowlist" });
  const out = await runGitTool({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, "git_log", {});
  assert.match(out, /DENIED/);
});

// ── builder integration: git tool flows through the loop + governed exec + chokepoint ──

const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }), now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
})();

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
const lengthResp = (): ModelResponse => ({ ...base(), content: "", finishReason: "length" });
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

test("builder: git_status routes through the governed exec and is neutralized like any tool result", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "g.ts"), "x\n");
  const gitCalls: ExecRequest[] = [];
  const engine: RoleEngine = {
    invokeModel: (() => {
      const responses = [toolResp([call("git_status", {})]), lengthResp()];
      let i = 0;
      return async () => responses[Math.min(i++, responses.length - 1)]!;
    })(),
    neutralizeUntrusted: (content, ctx) => coreNeutralize(content, ctx),
  };
  const exec = { run: async (req: ExecRequest): Promise<ExecResult> => {
    if (req.command === "git") { gitCalls.push(req); return { executed: true, exitCode: 0, stdoutTail: "## main\n M g.ts", stderrTail: "" }; }
    return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" };
  } };
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: "verified", spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity, state: "allocated", createdAt: 0 };
  const ctx: RoleContext = { task: { taskId: "t", targetRepo: dir, goal: "inspect" }, role: "builder", identity, autonomy: autonomyForTier("verified"), workspace, priorResults: [], engine };

  const result = await createBuilder({ governedExec: exec, parentCtx: PARENT_CTX })(ctx);
  assert.deepEqual(gitCalls[0]?.args, ["status", "--short", "--branch"], "git_status ran through governed exec");
  const detail = result.detail as { neutralizedCount: number };
  assert.ok(detail.neutralizedCount >= 1, "git output went through the neutralization chokepoint");
});
