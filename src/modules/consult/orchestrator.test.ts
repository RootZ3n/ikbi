/**
 * Tests for runConsult: retrieval → packet → ONE bounded frontier call. The provider and
 * retrieval are mocked (no network); the packet's slice reader runs for real against a temp
 * repo, so the prompt the model receives contains verbatim code.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runConsult } from "./orchestrator.js";
import type { ConsultDeps } from "./orchestrator.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { ModelTier, RosterModel } from "../model-router/index.js";
import type { ProjectRetrievalApi } from "../project-retrieval/index.js";

const IDENTITY = { agentId: "consult-1", functionalRole: "consultant", trustTier: "operator" as const, spawnedFrom: "parent" };

const TIER_ROSTERS: Readonly<Record<ModelTier, readonly RosterModel[]>> = {
  worker: [{ id: "deepseek-v4-flash", costPerMTok: 0.42 }],
  mid: [{ id: "mimo-v2.5-pro", costPerMTok: 1.305 }],
  frontier: [{ id: "sonnet-4.6", costPerMTok: 18 }, { id: "opus-4.8", costPerMTok: 30 }]
};

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ikbi-consult-orch-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), "export function check(token: string): boolean {\n  return token.length > 0;\n}\n");
  return root;
}

/** A mock provider that captures the request and returns a canned answer. */
function mockProvider(answer: string): { invokeModel: (request: ModelRequest) => Promise<ModelResponse>; seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  const invokeModel = async (request: ModelRequest): Promise<ModelResponse> => {
    seen.push(request);
    return {
      contractVersion: "1.0.0",
      model: request.model,
      provider: "mock",
      providerModelId: request.model,
      content: answer,
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      cost: { usd: 0.01 },
      latencyMs: 1,
      fellBack: false,
      attempts: []
    } as unknown as ModelResponse;
  };
  return { invokeModel, seen };
}

/** A mock retrieval that returns the given paths as the ranked selection. */
function mockRetrieval(paths: string[], lowConfidence = false): ProjectRetrievalApi {
  return {
    retrieve: async () => ({
      mode: "index",
      files: paths.map((p, i) => ({ path: p, bytes: 100, score: 10 - i, reasons: ["goal-path-match" as const], why: "test" })),
      seeds: [],
      totalBytes: 100,
      truncatedByBudget: false,
      lowConfidence,
      receipts: []
    })
  };
}

test("advise: retrieval → packet → one frontier call; returns the model's plan", async () => {
  const root = await makeRepo();
  try {
    const prov = mockProvider("ROOT CAUSE: token check is too weak.\n1. Validate signature in src/auth.ts:1-3");
    const deps: ConsultDeps = { invokeModel: prov.invokeModel, retrieval: mockRetrieval(["src/auth.ts"]), tierRosters: TIER_ROSTERS };
    const result = await runConsult(
      { repoRoot: root, question: "why does auth accept empty tokens?", mode: "advise", identity: IDENTITY, failingChecks: "FAIL auth.test.ts" },
      deps
    );

    assert.equal(prov.seen.length, 1, "exactly one frontier call");
    assert.equal(prov.seen[0]!.tools, undefined, "no tools — not an agentic loop");
    assert.equal(result.tier, "frontier");
    assert.equal(result.modelId, "sonnet-4.6", "cheapest-sufficient frontier by roster order");
    assert.match(result.answer, /ROOT CAUSE/);

    // the prompt carries VERBATIM code from the repo, not a summary
    const userMsg = prov.seen[0]!.messages!.find((m) => m.role === "user")!.content;
    assert.match(userMsg, /export function check/);
    assert.match(userMsg, /FAIL auth\.test\.ts/, "exact failing checks included");
    assert.equal(result.packet.evidence.slices.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patch mode sets propose_patch authority and a larger token budget", async () => {
  const root = await makeRepo();
  try {
    const prov = mockProvider("--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-...");
    const deps: ConsultDeps = { invokeModel: prov.invokeModel, retrieval: mockRetrieval(["src/auth.ts"]), tierRosters: TIER_ROSTERS };
    const result = await runConsult({ repoRoot: root, question: "fix it", mode: "patch", identity: IDENTITY }, deps);
    assert.equal(result.packet.mode, "patch");
    assert.equal(result.packet.constraints.advisorAuthority, "propose_patch");
    assert.ok((prov.seen[0]!.maxTokens ?? 0) >= 2000, "patch gets a larger output cap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--model override forces a specific frontier model", async () => {
  const root = await makeRepo();
  try {
    const prov = mockProvider("plan");
    const deps: ConsultDeps = { invokeModel: prov.invokeModel, retrieval: mockRetrieval(["src/auth.ts"]), tierRosters: TIER_ROSTERS };
    const result = await runConsult({ repoRoot: root, question: "q", mode: "advise", identity: IDENTITY, modelOverride: "opus-4.8" }, deps);
    assert.equal(result.modelId, "opus-4.8");
    assert.equal(prov.seen[0]!.model, "opus-4.8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("low-confidence retrieval is surfaced in the result", async () => {
  const root = await makeRepo();
  try {
    const prov = mockProvider("plan");
    const deps: ConsultDeps = { invokeModel: prov.invokeModel, retrieval: mockRetrieval(["src/auth.ts"], true), tierRosters: TIER_ROSTERS };
    const result = await runConsult({ repoRoot: root, question: "q", mode: "advise", identity: IDENTITY }, deps);
    assert.equal(result.retrieval.lowConfidence, true);
    assert.equal(result.retrieval.files, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
