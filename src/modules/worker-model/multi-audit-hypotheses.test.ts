/**
 * multi-audit — hypothesis labeling, receipt metadata, and path confidence.
 * (lab-trust sprint, Phase 4) Multi-model audit output must never be mistaken for
 * verified proof.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import {
  AUDIT_LIMITATIONS,
  buildAuditMetadata,
  formatComparisonReport,
  runMultiAudit,
  type ComparisonResult,
} from "./multi-audit.js";

function makeResponse(content: string, costUsd = 0.001): ModelResponse {
  return {
    contractVersion: "1.1.0",
    model: "test-model",
    provider: "test",
    providerModelId: "test-model",
    content,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    cost: { usd: costUsd, promptUsd: 0, cachedUsd: 0, completionUsd: costUsd, rate: { promptPerMTok: 0.5, completionPerMTok: 0.5 } },
    latencyMs: 100,
    fellBack: false,
    attempts: [],
  };
}

function makeTempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-audit-hyp-"));
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(dir, name);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

// ── labeling: hypotheses, not facts ──────────────────────────────────────────

test("formatComparisonReport labels output as unverified hypotheses, agreement not proof, contradictions possible", () => {
  const result: ComparisonResult = {
    models: [
      { model: "m-a", findings: [{ title: "f1", detail: "thing", path: "src/a.ts" }], durationMs: 100, cost: 0.001 },
      { model: "m-b", findings: [{ title: "f1", detail: "thing", path: "src/a.ts" }], durationMs: 200, cost: 0.002 },
    ],
    agreement: [{ file: "src/a.ts", title: "thing", modelATitle: "thing", modelBTitle: "thing" }],
    unique: { "m-a": [], "m-b": [] },
    contradictions: [],
    summary: "x",
  };
  const report = formatComparisonReport(result);
  assert.match(report, /UNVERIFIED HYPOTHES/i);
  assert.match(report, /MODEL AGREEMENT/);
  assert.match(report, /NOT proof/i);
  assert.match(report, /POSSIBLE CONTRADICTIONS/);
  assert.match(report, /LIMITATIONS:/);
  // Must NOT present agreement as fact/truth.
  assert.doesNotMatch(report, /CONFIRMED (?:AGREEMENT|FACT)/i);
});

test("AUDIT_LIMITATIONS states findings are hypotheses, not facts", () => {
  assert.match(AUDIT_LIMITATIONS, /hypothes/i);
  assert.match(AUDIT_LIMITATIONS, /not verified facts/i);
});

// ── receipt metadata ─────────────────────────────────────────────────────────

test("buildAuditMetadata carries comparison metadata + limitations + verified:false", () => {
  const result: ComparisonResult = {
    models: [
      { model: "m-a", findings: [{ title: "f1", detail: "a" }], durationMs: 120, cost: 0.003 },
      { model: "m-b", findings: [{ title: "f2", detail: "b" }, { title: "f3", detail: "c" }], durationMs: 340, cost: 0.006 },
    ],
    agreement: [],
    unique: { "m-a": [{ title: "f1", detail: "a" }], "m-b": [{ title: "f2", detail: "b" }, { title: "f3", detail: "c" }] },
    contradictions: [],
    summary: "x",
    comparisonMethod: "jaccard",
    similarityThreshold: 0.3,
    limitations: AUDIT_LIMITATIONS,
  };
  const meta = buildAuditMetadata(result);
  assert.equal(meta.verified, false);
  assert.equal(meta.findingClass, "model_hypothesis");
  assert.deepEqual(meta.modelsCompared, ["m-a", "m-b"]);
  assert.equal(meta.costPerModelUsd["m-a"], 0.003);
  assert.equal(meta.timingPerModelMs["m-b"], 340);
  assert.equal(meta.findingsPerModel["m-b"], 2);
  assert.equal(meta.agreements, 0);
  assert.equal(meta.uniqueFindings, 3);
  assert.equal(meta.possibleContradictions, 0);
  assert.equal(meta.similarityThreshold, 0.3);
  assert.match(meta.limitations, /hypothes/i);
  assert.equal(meta.allModelsSucceeded, true);
});

test("buildAuditMetadata marks allModelsSucceeded false and records the error when a model fails", () => {
  const result: ComparisonResult = {
    models: [
      { model: "m-a", findings: [{ title: "f1", detail: "a" }], durationMs: 120, cost: 0.003 },
      { model: "m-b", findings: [], durationMs: 10, error: "timeout" },
    ],
    agreement: [],
    unique: { "m-a": [{ title: "f1", detail: "a" }] },
    contradictions: [],
    summary: "x",
  };
  const meta = buildAuditMetadata(result);
  assert.equal(meta.allModelsSucceeded, false);
  assert.equal(meta.modelErrors["m-b"], "timeout");
  assert.equal(meta.costPerModelUsd["m-b"], null);
});

// ── one model failing → other model's findings still reported, no consensus ──

test("runMultiAudit: one model failing still reports the other's findings without claiming consensus", async () => {
  const repo = makeTempRepo({ "src/a.ts": "export const x = 1;\n" });
  let call = 0;
  const invokeModel = async (_req: ModelRequest): Promise<ModelResponse> => {
    call += 1;
    if (call === 1) return makeResponse("- src/a.ts:1 — x is exported and could be validated");
    throw new Error("model-b exploded");
  };
  const result = await runMultiAudit({ repoPath: repo, models: ["m-a", "m-b"], invokeModel });
  const report = formatComparisonReport(result);
  // The surviving model's finding is present.
  assert.ok(Object.values(result.unique).some((u) => u.length > 0), "surviving model's findings reported");
  // No agreement can be claimed.
  assert.equal(result.agreement.length, 0);
  assert.match(report, /model\(s\) failed/i);
  assert.match(report, /WITHOUT consensus/i);
  const meta = buildAuditMetadata(result);
  assert.equal(meta.allModelsSucceeded, false);
});

// ── path extraction + confidence ─────────────────────────────────────────────

test("runMultiAudit sets pathConfidence: exact for a real file, inferred for a hallucinated path, missing for none", async () => {
  const repo = makeTempRepo({ "src/real.ts": "export const r = 1;\n" });
  const invokeModel = async (_req: ModelRequest): Promise<ModelResponse> =>
    makeResponse(
      [
        "- `src/real.ts:5` — real file referenced with backticks and line",
        "- src/ghost.ts:9 — a path that does not exist in the repo",
        "- a general observation with no file reference at all",
      ].join("\n"),
    );
  const result = await runMultiAudit({ repoPath: repo, models: ["only"], invokeModel });
  const findings = result.unique["only"]!;
  const byConfidence = (c: string) => findings.filter((f) => f.pathConfidence === c);
  assert.equal(byConfidence("exact").length, 1, "real.ts resolves exact");
  assert.equal(byConfidence("exact")[0]!.path, "src/real.ts");
  assert.equal(byConfidence("inferred").length, 1, "ghost.ts is inferred (not validated)");
  assert.equal(byConfidence("missing").length, 1, "no-path finding is missing");
});
