/**
 * Fix 2 (audit): the check command set is configurable per target (IKBI_CHECKS),
 * NEVER model-chosen — and the builder's in-loop run_checks and the verifier resolve
 * the SAME set. Default stays pnpm for ikbi itself.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
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
import { parseChecksEnv, resolveChecks, type ChecksResolution } from "./checks.js";
import { createVerifier } from "./verifier.js";
import { createBuilder } from "./builder.js";
import type { RoleContext, RoleEngine } from "./contract.js";

const silent = () => pino({ level: "silent" });
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const ID: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: "verified", spawnedFrom: "parent-1" };

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

const NPM_CHECKS: ChecksResolution = { ok: true, checks: [{ name: "test", command: "npm", args: ["test"] }, { name: "typecheck", command: "npm", args: ["run", "typecheck"] }], source: "env" };

// ── parseChecksEnv (pure) ─────────────────────────────────────────────────────

test("parseChecksEnv: valid JSON → checks; unset → undefined; malformed → 'malformed'", () => {
  assert.equal(parseChecksEnv(undefined), undefined);
  assert.equal(parseChecksEnv("   "), undefined);
  assert.equal(parseChecksEnv("{not json"), "malformed");
  assert.equal(parseChecksEnv("[]"), "malformed", "empty array is not a usable set");
  assert.equal(parseChecksEnv('[{"name":"test"}]'), "malformed", "missing command/args");
  const ok = parseChecksEnv('[{"name":"test","command":"npm","args":["test"]}]');
  assert.ok(Array.isArray(ok));
  assert.deepEqual(ok, [{ name: "test", command: "npm", args: ["test"] }]);
});

test("resolveChecks: IKBI_CHECKS configures npm (not pnpm) for a target repo", () => {
  const wt = tmp("ikbi-checkscfg-");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "npm-target", scripts: { test: "node --test" } }));
  const env = { IKBI_CHECKS: '[{"name":"test","command":"npm","args":["test"]}]' } as unknown as NodeJS.ProcessEnv;
  const r = resolveChecks(wt, env);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.source, "env");
    assert.deepEqual(r.checks.map((c) => c.command), ["npm"], "runs npm, not pnpm");
  }
  // Default (no env) stays pnpm for ikbi itself.
  const def = resolveChecks(wt, {} as NodeJS.ProcessEnv);
  assert.equal(def.ok && def.checks[0]?.command, "pnpm");
});

test("resolveChecks: a malformed IKBI_CHECKS fails closed RED (never silently falls back)", () => {
  const wt = tmp("ikbi-checkscfg-bad-");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "x" }));
  const r = resolveChecks(wt, { IKBI_CHECKS: "garbage{" } as unknown as NodeJS.ProcessEnv);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /IKBI_CHECKS is malformed/);
});

// ── the verifier AND builder use the SAME resolved set ───────────────────────

test("verifier runs the CONFIGURED command set (npm), not the pnpm default", async () => {
  const wt = tmp("ikbi-verify-npm-");
  const exec = recordingExec();
  const ws: WorkspaceHandle = { id: "ws1", targetRepo: wt, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: wt, identity: ID, state: "allocated", createdAt: 0 };
  const ctx: RoleContext = {
    task: { taskId: "t", targetRepo: wt, goal: "g" }, role: "verifier", identity: ID, autonomy: autonomyForTier("verified"),
    workspace: ws, priorResults: [], engine: { invokeModel: async () => { throw new Error("no"); }, neutralizeUntrusted: () => { throw new Error("no"); } },
  };
  await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: async () => "diff --git a/x b/x\n+y\n", resolveChecks: () => NPM_CHECKS })(ctx);
  assert.ok(exec.calls.length >= 1);
  for (const c of exec.calls) assert.equal(c.command, "npm", "every verifier check ran via npm (the configured set)");
});

test("builder run_checks runs the SAME configured set (npm) the verifier uses", async () => {
  const wt = tmp("ikbi-build-npm-");
  const exec = recordingExec();
  const requests: unknown[] = [];
  let i = 0;
  const responses: ModelResponse[] = [
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("run_checks", {})] },
    { ...base(), content: "", finishReason: "tool_calls", toolCalls: [call("done", { successCondition: "met", filesReadBack: [], selfCheck: "ran the checks green", satisfied: true })] },
  ];
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)]!; i += 1; return r; },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  const ws: WorkspaceHandle = { id: "ws1", targetRepo: wt, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: wt, identity: ID, state: "allocated", createdAt: 0 };
  const ctx: RoleContext = {
    task: { taskId: "t", targetRepo: wt, goal: "g" }, role: "builder", identity: ID, autonomy: autonomyForTier("verified"), workspace: ws, priorResults: [], engine,
  };
  // Inject the SAME resolver the verifier got — proving builder run_checks and the verifier resolve identically.
  await createBuilder({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), resolveChecks: () => NPM_CHECKS })(ctx);
  assert.ok(exec.calls.length >= 1, "run_checks executed");
  for (const c of exec.calls) assert.equal(c.command, "npm", "builder run_checks used the SAME configured npm set");
});

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
