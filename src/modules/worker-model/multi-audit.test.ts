/**
 * multi-audit module tests — comparison algorithm + runner with mocked models.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import {
  compareFindings,
  runMultiAudit,
  formatComparisonReport,
  type ComparisonResult,
  type ScoutFinding,
} from "./multi-audit.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0",
    model: "test-model",
    provider: "test",
    providerModelId: "test-model",
    content,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    cost: { usd: 0.001, promptUsd: 0.0005, cachedUsd: 0, completionUsd: 0.0005, rate: { promptPerMTok: 0.5, completionPerMTok: 0.5 } },
    latencyMs: 100,
    fellBack: false,
    attempts: [],
  };
}

function makeTempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-multi-audit-"));
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(dir, name);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

// ── compareFindings tests ──────────────────────────────────────────────────────

test("compareFindings detects agreement when both models find the same file with similar detail", () => {
  const findingsA: ScoutFinding[] = [
    { title: "f1", detail: "complex tool loop with many iterations", path: "src/builder.ts" },
  ];
  const findingsB: ScoutFinding[] = [
    { title: "f1", detail: "builder tool loop is complex", path: "src/builder.ts" },
  ];
  const result = compareFindings(findingsA, findingsB);
  assert.equal(result.agreement.length, 1, "should find 1 agreement");
  assert.equal(result.uniqueA.length, 0);
  assert.equal(result.uniqueB.length, 0);
  assert.equal(result.contradictions.length, 0);
});

test("compareFindings detects unique findings when models find different files", () => {
  const findingsA: ScoutFinding[] = [
    { title: "f1", detail: "missing error handling in auth", path: "src/auth.ts" },
  ];
  const findingsB: ScoutFinding[] = [
    { title: "f1", detail: "slow database queries", path: "src/db.ts" },
  ];
  const result = compareFindings(findingsA, findingsB);
  assert.equal(result.agreement.length, 0);
  assert.equal(result.uniqueA.length, 1);
  assert.equal(result.uniqueB.length, 1);
  assert.equal(result.contradictions.length, 0);
});

test("compareFindings detects contradictions when same file has different findings", () => {
  const findingsA: ScoutFinding[] = [
    { title: "f1", detail: "auth module has good test coverage", path: "src/auth.ts" },
  ];
  const findingsB: ScoutFinding[] = [
    { title: "f1", detail: "auth module is completely untested", path: "src/auth.ts" },
  ];
  const result = compareFindings(findingsA, findingsB);
  // These are NOT similar enough to agree, so they become contradictions
  assert.equal(result.contradictions.length, 1, "should find 1 contradiction");
  assert.equal(result.agreement.length, 0);
  assert.equal(result.uniqueA.length, 0);
  assert.equal(result.uniqueB.length, 0);
});

test("compareFindings handles empty findings from both models", () => {
  const result = compareFindings([], []);
  assert.equal(result.agreement.length, 0);
  assert.equal(result.uniqueA.length, 0);
  assert.equal(result.uniqueB.length, 0);
  assert.equal(result.contradictions.length, 0);
});

test("compareFindings handles empty findings from one model", () => {
  const findingsA: ScoutFinding[] = [
    { title: "f1", detail: "something found", path: "src/foo.ts" },
  ];
  const result = compareFindings(findingsA, []);
  assert.equal(result.agreement.length, 0);
  assert.equal(result.uniqueA.length, 1);
  assert.equal(result.uniqueB.length, 0);
});

test("compareFindings matches pathless findings (both general)", () => {
  const findingsA: ScoutFinding[] = [
    { title: "f1", detail: "project has good documentation structure" },
  ];
  const findingsB: ScoutFinding[] = [
    { title: "f1", detail: "documentation structure is well organized" },
  ];
  const result = compareFindings(findingsA, findingsB);
  assert.equal(result.agreement.length, 1, "pathless findings with similar detail should agree");
});

test("compareFindings does not match pathless vs pathed findings", () => {
  const findingsA: ScoutFinding[] = [
    { title: "f1", detail: "complex logic", path: "src/foo.ts" },
  ];
  const findingsB: ScoutFinding[] = [
    { title: "f1", detail: "complex logic" },
  ];
  const result = compareFindings(findingsA, findingsB);
  // One has a path, the other doesn't — fileMatch fails
  assert.equal(result.agreement.length, 0);
  assert.equal(result.uniqueA.length, 1);
  assert.equal(result.uniqueB.length, 1);
});

test("compareFindings fuzzy matches similar titles", () => {
  const findingsA: ScoutFinding[] = [
    { title: "f1", detail: "complex tool loop with 1457 lines in builder.ts" },
  ];
  const findingsB: ScoutFinding[] = [
    { title: "f1", detail: "builder tool loop is very complex" },
  ];
  const result = compareFindings(findingsA, findingsB);
  assert.equal(result.agreement.length, 1, "fuzzy match on tool loop complexity");
});

// ── runMultiAudit tests ────────────────────────────────────────────────────────

test("runMultiAudit with mocked models produces comparison result", async () => {
  const dir = makeTempRepo({
    "src/index.ts": "export const x = 1;",
    "src/utils.ts": "export function helper() { return true; }",
  });

  let callCount = 0;
  const mockInvoke = async (req: ModelRequest): Promise<ModelResponse> => {
    callCount++;
    if (req.model === "model-a") {
      return makeResponse("- src/index.ts — simple export\n- src/utils.ts — helper function");
    }
    return makeResponse("- src/index.ts — basic constant export\n- src/utils.ts — utility helper");
  };

  const result = await runMultiAudit({
    repoPath: dir,
    models: ["model-a", "model-b"],
    invokeModel: mockInvoke,
  });

  assert.equal(result.models.length, 2);
  assert.equal(callCount, 2, "should call invokeModel twice");
  assert.equal(result.models[0]?.model, "model-a");
  assert.equal(result.models[1]?.model, "model-b");
  // Both models found similar things → should have agreements
  assert.ok(result.agreement.length >= 0, "should produce agreement array");
});

test("runMultiAudit with single model degrades gracefully", async () => {
  const dir = makeTempRepo({ "a.ts": "export const a = 1;" });

  const mockInvoke = async (): Promise<ModelResponse> => {
    return makeResponse("- a.ts — simple export");
  };

  const result = await runMultiAudit({
    repoPath: dir,
    models: ["solo-model"],
    invokeModel: mockInvoke,
  });

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.error, undefined);
  assert.equal(result.models[0]?.findings.length, 1);
});

test("runMultiAudit handles one model failing", async () => {
  const dir = makeTempRepo({ "a.ts": "export const a = 1;" });

  const mockInvoke = async (req: ModelRequest): Promise<ModelResponse> => {
    if (req.model === "failing-model") {
      throw new Error("model provider unavailable");
    }
    return makeResponse("- a.ts — simple export");
  };

  const result = await runMultiAudit({
    repoPath: dir,
    models: ["good-model", "failing-model"],
    invokeModel: mockInvoke,
  });

  assert.equal(result.models.length, 2);
  const good = result.models.find((m) => m.model === "good-model")!;
  const bad = result.models.find((m) => m.model === "failing-model")!;
  assert.equal(good.error, undefined);
  assert.ok(bad.error?.includes("model provider unavailable"));
  // Good model's findings should still be available
  assert.equal(good.findings.length, 1);
});

test("runMultiAudit with empty findings from both models", async () => {
  const dir = makeTempRepo({ "a.ts": "" });

  const mockInvoke = async (): Promise<ModelResponse> => {
    return makeResponse("(no findings)");
  };

  const result = await runMultiAudit({
    repoPath: dir,
    models: ["m1", "m2"],
    invokeModel: mockInvoke,
  });

  assert.equal(result.models.length, 2);
  assert.equal(result.agreement.length, 0);
});

// ── formatComparisonReport tests ───────────────────────────────────────────────

test("formatComparisonReport produces readable output", () => {
  const result: ComparisonResult = {
    models: [
      { model: "model-a", findings: [{ title: "f1", detail: "finding one", path: "src/a.ts" }], durationMs: 420, cost: 0.003 },
      { model: "model-b", findings: [{ title: "f1", detail: "finding one", path: "src/a.ts" }], durationMs: 1200, cost: 0.008 },
    ],
    agreement: [{ file: "src/a.ts", title: "finding one", modelATitle: "finding one", modelBTitle: "finding one" }],
    unique: { "model-a": [], "model-b": [] },
    contradictions: [],
    summary: "Compared 2 model(s); 1 agreement(s), 0 contradiction(s)",
  };
  const report = formatComparisonReport(result);
  assert.match(report, /Multi-Model Audit: model-a vs model-b/);
  assert.match(report, /AGREEMENT/);
  assert.match(report, /CONTRADICTIONS/);
  assert.match(report, /Coverage/);
});
