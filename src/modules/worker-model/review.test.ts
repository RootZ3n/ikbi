/**
 * ikbi code-review engine tests — parsing, markdown rendering, and the mocked runner.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { formatReviewMarkdown, parseReview, runReview } from "./review.js";

function mockResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0",
    model: "test-model",
    provider: "test",
    providerModelId: "test-model",
    content,
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1,
    fellBack: false,
    attempts: [],
  };
}

test("parseReview: parses summary + comments", () => {
  const json = JSON.stringify({
    summary: "Solid structure; a couple of edge cases to harden.",
    comments: [
      { file: "src/a.ts", line: 10, severity: "high", category: "bug", comment: "null deref possible", suggestion: "guard x" },
      { file: "src/a.ts", severity: "praise", category: "readability", comment: "clear naming" },
    ],
  });
  const r = parseReview(json);
  assert.match(r.summary, /Solid structure/);
  assert.equal(r.comments.length, 2);
  assert.equal(r.comments[0]?.severity, "high");
  assert.equal(r.comments[0]?.suggestion, "guard x");
  assert.equal(r.comments[1]?.severity, "praise");
});

test("parseReview: strips markdown fences", () => {
  const r = parseReview("```json\n{\"summary\":\"ok\",\"comments\":[]}\n```");
  assert.equal(r.summary, "ok");
});

test("parseReview: non-JSON falls back to summary", () => {
  const r = parseReview("This code looks fine overall.");
  assert.match(r.summary, /looks fine/);
  assert.equal(r.comments.length, 0);
});

test("parseReview: invalid severity/category normalized to defaults", () => {
  const json = JSON.stringify({ summary: "s", comments: [{ file: "x.ts", severity: "nuclear", category: "vibes", comment: "hm" }] });
  const r = parseReview(json);
  assert.equal(r.comments[0]?.severity, "info");
  assert.equal(r.comments[0]?.category, "other");
});

test("formatReviewMarkdown: renders summary, counts, grouped comments", () => {
  const md = formatReviewMarkdown({
    model: "m",
    summary: "Good.",
    filesReviewed: ["src/a.ts"],
    comments: [
      { id: "1", file: "src/a.ts", line: 3, severity: "high", category: "bug", comment: "boom", suggestion: "fix it" },
      { id: "2", file: "src/a.ts", severity: "praise", category: "readability", comment: "nice" },
    ],
  });
  assert.match(md, /# Code Review/);
  assert.match(md, /## Summary/);
  assert.match(md, /## src\/a\.ts/);
  assert.match(md, /high.*\[bug\] src\/a\.ts:3 — boom/);
  assert.match(md, /Suggestion:_ fix it/);
});

test("runReview: reads files, invokes model, returns structured result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-review-"));
  writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
  let seenReq: ModelRequest | undefined;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    seenReq = req;
    return mockResponse(JSON.stringify({ summary: "fine", comments: [{ file: "a.ts", severity: "low", category: "quality", comment: "ok" }] }));
  };
  const res = await runReview({ repoPath: dir, files: [join(dir, "a.ts")], model: "m", invokeModel });
  assert.equal(res.error, undefined);
  assert.equal(res.summary, "fine");
  assert.equal(res.comments.length, 1);
  assert.deepEqual([...res.filesReviewed], ["a.ts"]);
  // The repo excerpts must ride as untrusted data, not the system prompt.
  assert.equal(seenReq?.messages?.[0]?.role, "system");
  assert.ok(seenReq?.messages?.some((m) => m.untrusted === true));
});

test("runReview: empty file set returns an explanatory error result", async () => {
  const res = await runReview({ repoPath: "/tmp", files: [], model: "m", invokeModel: async () => mockResponse("{}") });
  assert.notEqual(res.error, undefined);
  assert.equal(res.comments.length, 0);
});

test("runReview: a model throw is captured into error, not thrown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-review-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  const res = await runReview({ repoPath: dir, files: [join(dir, "a.ts")], model: "m", invokeModel: async () => { throw new Error("boom"); } });
  assert.match(res.error ?? "", /boom/);
});

test("runReview: diff is folded in as an untrusted message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-review-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  let count = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    count = req.messages?.length ?? 0;
    return mockResponse("{\"summary\":\"s\",\"comments\":[]}");
  };
  await runReview({ repoPath: dir, files: [join(dir, "a.ts")], model: "m", diff: "@@ -1 +1 @@\n-x\n+y", invokeModel });
  // system + diff + files = 3
  assert.equal(count, 3);
});
