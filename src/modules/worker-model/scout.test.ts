import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { scout, type ScoutFinding } from "./scout.js";
import type { RoleContext } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "scout", trustTier: "probation", spawnedFrom: "parent-1" };

function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0",
    model: "mimo-v2.5",
    provider: "mimo",
    providerModelId: "mimo-v2.5",
    content,
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1,
    fellBack: false,
    attempts: [],
  };
}

function makeCtx(dir: string, impl: (req: ModelRequest) => Promise<ModelResponse>) {
  const calls: ModelRequest[] = [];
  const workspace: WorkspaceHandle = {
    id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: dir, identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  const ctx: RoleContext = {
    task: { taskId: "t-1", targetRepo: dir, goal: "investigate the config" },
    role: "scout",
    identity: IDENTITY,
    autonomy: autonomyForTier("probation"),
    workspace,
    priorResults: [],
    engine: {
      invokeModel: async (req) => {
        calls.push(req);
        return impl(req);
      },
      neutralizeUntrusted: () => {
        throw new Error("scout must not neutralize untrusted content (Pass-A constraint)");
      },
    },
  };
  return { ctx, calls };
}

test("scout returns success with structured findings + filesScanned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-scout-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  writeFileSync(join(dir, "b.md"), "# notes");
  const { ctx, calls } = makeCtx(dir, async () => modelResponse("- finding one\n- finding two"));

  const result = await scout(ctx);
  assert.equal(result.outcome, "success");
  const detail = result.detail as { findings: ScoutFinding[]; filesScanned: number };
  assert.equal(detail.findings.length, 2);
  assert.equal(detail.findings[0]?.detail, "finding one");
  assert.equal(detail.filesScanned, 2);
  assert.equal(calls.length, 1, "called the model once");
});

test("scout passes ctx.identity on the model request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-scout-"));
  writeFileSync(join(dir, "a.ts"), "x");
  const { ctx, calls } = makeCtx(dir, async () => modelResponse("- f"));
  await scout(ctx);
  assert.equal(calls[0]?.identity, ctx.identity, "the spawned role identity rides the request (same reference)");
});

test("scout bounds its scan — it does NOT read the whole tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-scout-"));
  for (let i = 0; i < 120; i += 1) writeFileSync(join(dir, `f${i}.ts`), `export const v${i} = ${i};`);
  const { ctx } = makeCtx(dir, async () => modelResponse("- f"));
  const result = await scout(ctx);
  const detail = result.detail as { filesScanned: number };
  assert.ok(detail.filesScanned > 0, "scanned something");
  assert.ok(detail.filesScanned < 120, `bounded scan (${detail.filesScanned} < 120)`);
});

test("scout does not mutate the workspace (read-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-scout-"));
  writeFileSync(join(dir, "a.ts"), "x");
  const before = readdirSync(dir).sort();
  const { ctx } = makeCtx(dir, async () => modelResponse("- f"));
  await scout(ctx);
  assert.deepEqual(readdirSync(dir).sort(), before, "no files created/removed in the workspace");
});

test("a model error becomes outcome:failure, not a throw past the boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-scout-"));
  writeFileSync(join(dir, "a.ts"), "x");
  const { ctx } = makeCtx(dir, async () => {
    throw new Error("provider exploded");
  });
  const result = await scout(ctx);
  assert.equal(result.outcome, "failure");
  assert.match(result.summary ?? "", /provider exploded/);
});
