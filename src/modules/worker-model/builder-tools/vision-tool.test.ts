import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentIdentity, ModelRequest, ModelResponse } from "../../../core/provider/contract.js";
import { runVisionAnalyze, visionAnalyzeTool, type VisionDeps } from "./vision-tool.js";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "ikbi-vision-")));
const IDENTITY: AgentIdentity = { agentId: "w", functionalRole: "builder", trustTier: "verified", spawnedFrom: "p" };
// A 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.2.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

/** Build VisionDeps with a scripted model that records the request it saw. */
function deps(dir: string, response: ModelResponse): { deps: VisionDeps; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    deps: {
      invokeModel: async (req) => { requests.push(req); return response; },
      identity: IDENTITY,
      model: "mimo-v2.5",
      worktreeReal: dir,
    },
  };
}

test("the tool declares image_url + question as required", () => {
  assert.equal(visionAnalyzeTool.name, "vision_analyze");
  assert.deepEqual(visionAnalyzeTool.parameters.required, ["image_url", "question"]);
});

test("a LOCAL image is base64-encoded into a data-URL multimodal message", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "shot.png"), Buffer.from(PNG_B64, "base64"));
  const { deps: d, requests } = deps(dir, stop("A 1x1 transparent pixel."));
  const out = await runVisionAnalyze(d, { image_url: "shot.png", question: "what is this?" });
  assert.equal(out, "A 1x1 transparent pixel.");
  // The request carried ONE multimodal user message: text part + a data:image/png;base64 part.
  const userMsg = requests[0]?.messages?.find((m) => m.role === "user");
  assert.ok(userMsg?.parts, "user message carries multimodal parts");
  assert.equal(userMsg?.content, "what is this?", "content holds the question as the text fallback");
  const parts = userMsg!.parts!;
  assert.deepEqual(parts[0], { type: "text", text: "what is this?" });
  assert.equal(parts[1]?.type, "image_url");
  assert.ok((parts[1] as { image_url: { url: string } }).image_url.url.startsWith(`data:image/png;base64,${PNG_B64.slice(0, 8)}`));
});

test("a REMOTE http(s) url is passed through verbatim (the provider fetches it)", async () => {
  const dir = tmp();
  const { deps: d, requests } = deps(dir, stop("a chart"));
  await runVisionAnalyze(d, { image_url: "https://example.com/chart.png", question: "describe" });
  const parts = requests[0]?.messages?.find((m) => m.role === "user")?.parts;
  assert.equal((parts?.[1] as { image_url: { url: string } }).image_url.url, "https://example.com/chart.png");
});

test("a path escaping the worktree is rejected (confinement), no model call", async () => {
  const dir = tmp();
  const { deps: d, requests } = deps(dir, stop("should not happen"));
  const out = await runVisionAnalyze(d, { image_url: "../../etc/secret.png", question: "?" });
  assert.match(out, /ERROR:.*escapes the worktree/);
  assert.equal(requests.length, 0, "no model call on a rejected path");
});

test("an unsupported extension is rejected with the supported list", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "notes.txt"), "hi");
  const { deps: d } = deps(dir, stop("x"));
  const out = await runVisionAnalyze(d, { image_url: "notes.txt", question: "?" });
  assert.match(out, /unsupported image type ".txt".*supported:/);
});

test("missing image_url or question is a clear error", async () => {
  const dir = tmp();
  const { deps: d } = deps(dir, stop("x"));
  assert.match(await runVisionAnalyze(d, { question: "?" }), /requires a non-empty 'image_url'/);
  assert.match(await runVisionAnalyze(d, { image_url: "https://x/y.png" }), /requires a non-empty 'question'/);
});

test("a non-http(s), non-local scheme (e.g. file:) is rejected", async () => {
  const dir = tmp();
  const { deps: d, requests } = deps(dir, stop("x"));
  const out = await runVisionAnalyze(d, { image_url: "file:///etc/passwd", question: "?" });
  assert.match(out, /unsupported image source/);
  assert.equal(requests.length, 0);
});
