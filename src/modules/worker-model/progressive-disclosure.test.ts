/**
 * Phase 2: progressive disclosure — scout emits structured findings (path/lines) +
 * a deterministic structure brief; the builder shows the BRIEF first (titles only)
 * and drills into one finding on demand via the scout_detail tool.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
import { createBuilder } from "./builder.js";
import type { RoleContext, RoleEngine, RoleResult } from "./contract.js";
import { scout, type ScoutFinding, type ScoutFileEntry } from "./scout.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-progdisc-"));

// ── scout: structured findings + brief + structure ──────────────────────────

const SCOUT_IDENTITY: AgentIdentity = { agentId: "w", functionalRole: "scout", trustTier: "probation", spawnedFrom: "p" };

function scoutCtx(dir: string, content: string): RoleContext {
  const workspace: WorkspaceHandle = {
    id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: dir, identity: SCOUT_IDENTITY, state: "allocated", createdAt: 0,
  };
  return {
    task: { taskId: "t", targetRepo: dir, goal: "investigate" },
    role: "scout", identity: SCOUT_IDENTITY, autonomy: autonomyForTier("probation"), workspace, priorResults: [],
    engine: {
      invokeModel: async (): Promise<ModelResponse> => ({
        contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
        content, finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
        latencyMs: 1, fellBack: false, attempts: [],
      }),
      neutralizeUntrusted: (c, ctx) => coreNeutralize(c, ctx),
    },
  };
}

test("scout: a finding with a path:line reference is parsed into structured path + lines", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.ts"), "export const x = 1;\nexport const y = 2;\n");
  const result = await scout(scoutCtx(dir, "- a.ts:2 — y should be renamed\n- general note with no file"));
  const detail = result.detail as { findings: ScoutFinding[]; brief: string; structure: ScoutFileEntry[] };
  assert.equal(detail.findings.length, 2);
  assert.equal(detail.findings[0]?.path, "a.ts");
  assert.deepEqual(detail.findings[0]?.lines, [2, 2]);
  // The second finding has no path reference.
  assert.equal(detail.findings[1]?.path, undefined);
});

test("scout: the brief lists scanned files with line counts (deterministic structure)", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "big.ts"), Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  writeFileSync(join(dir, "readme.md"), "# hi\n");
  const result = await scout(scoutCtx(dir, "- src/big.ts:1 — the big file"));
  const detail = result.detail as { brief: string; structure: ScoutFileEntry[] };
  assert.match(detail.brief, /Repository structure/);
  assert.match(detail.brief, /src\/big\.ts \(30 lines\)/);
  assert.ok(detail.structure.some((e) => e.path === "src/big.ts" && e.lines === 30));
});

// ── builder: brief-first injection + scout_detail drill-down ─────────────────

const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }), now: () => 1000,
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
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
const lengthResp = (): ModelResponse => ({ ...base(), content: "", finishReason: "length" });
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

function mockEngine(responses: ModelResponse[]) {
  const requests: ModelRequest[] = [];
  let i = 0;
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)]; i += 1; return r ?? lengthResp(); },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  return { engine, requests };
}

function makeBuilderCtx(dir: string, tier: TrustTier, engine: RoleEngine, priorResults: RoleResult[]): RoleContext {
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: tier, spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = {
    id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: dir, identity, state: "allocated", createdAt: 0,
  };
  return { task: { taskId: "t-1", targetRepo: dir, goal: "do the thing" }, role: "builder", identity, autonomy: autonomyForTier(tier), workspace, priorResults, engine };
}

const scoutResult = (findings: ScoutFinding[], brief: string): RoleResult => ({
  role: "scout", outcome: "success", summary: `${findings.length} findings`, detail: { findings, brief, structure: [] },
});

test("builder: the prior-results block leads with the scout BRIEF + finding titles (not full detail)", async () => {
  const dir = tmp();
  const findings: ScoutFinding[] = [
    { title: "finding-1", detail: "THE-FULL-SECRET-DETAIL about config.ts", path: "config.ts", lines: [10, 12] },
  ];
  const { engine, requests } = mockEngine([lengthResp()]);
  await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX })(makeBuilderCtx(dir, "verified", engine, [scoutResult(findings, "Repository structure (1 file).")]));
  const priorMsg = (requests[0]?.messages ?? []).find((m) => m.untrusted === true && String(m.content).includes("SCOUT BRIEF"));
  assert.ok(priorMsg, "the brief is injected as part of the (untrusted) prior-results block");
  const text = String(priorMsg?.content);
  assert.match(text, /Repository structure/);
  assert.match(text, /\[1\] finding-1 \(config\.ts:10-12\)/, "titles + location, not the full detail");
  assert.doesNotMatch(text, /THE-FULL-SECRET-DETAIL/, "full finding detail is NOT dumped up front");
});

test("builder: scout_detail returns one finding's full detail, neutralized like any tool result", async () => {
  const dir = tmp();
  const findings: ScoutFinding[] = [
    { title: "finding-1", detail: "rename helo to hello in g.ts", path: "g.ts", lines: [1, 1] },
    { title: "finding-2", detail: "unrelated note" },
  ];
  const { engine, requests } = mockEngine([
    toolResp([call("scout_detail", { index: 1 })]),
    lengthResp(),
  ]);
  const result = await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX })(makeBuilderCtx(dir, "verified", engine, [scoutResult(findings, "brief")]));
  // The scout_detail result re-entered as an untrusted tool message carrying the full detail.
  const toolMsg = (requests[1]?.messages ?? []).find((m) => m.role === "tool" && String(m.content).includes("rename helo to hello"));
  assert.ok(toolMsg, "scout_detail expanded finding 1's full detail back into the loop");
  assert.equal(toolMsg?.untrusted, true, "drilled-in scout detail is neutralized untrusted");
  const detail = result.detail as { neutralizedCount: number };
  assert.ok(detail.neutralizedCount >= 1, "the scout_detail result went through the chokepoint");
});

test("builder: scout_detail with an out-of-range index reports the valid range", async () => {
  const dir = tmp();
  const findings: ScoutFinding[] = [{ title: "finding-1", detail: "only one" }];
  const { engine, requests } = mockEngine([
    toolResp([call("scout_detail", { index: 9 })]),
    lengthResp(),
  ]);
  await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX })(makeBuilderCtx(dir, "verified", engine, [scoutResult(findings, "brief")]));
  const toolMsg = (requests[1]?.messages ?? []).find((m) => m.role === "tool" && /No scout finding matches/.test(String(m.content)));
  assert.ok(toolMsg, "an out-of-range drill-down is reported, not a crash");
});

test("builder: with NO scout findings, scout_detail degrades gracefully", async () => {
  const dir = tmp();
  const { engine, requests } = mockEngine([
    toolResp([call("scout_detail", { index: 1 })]),
    lengthResp(),
  ]);
  await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX })(makeBuilderCtx(dir, "verified", engine, []));
  const toolMsg = (requests[1]?.messages ?? []).find((m) => m.role === "tool" && /No scout findings are available/.test(String(m.content)));
  assert.ok(toolMsg, "no scout → a clear 'none available' result, not a failure");
});
