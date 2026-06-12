/**
 * Model capability harness — the routing that turns "this model failed the build" into
 * "this model is a patch generator, route it to the patchsmith lane". Covers the pure routing
 * ladder and the end-to-end executor classifying a noisy-tool model vs an unparseable-patch one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import {
  aggregateScorecard,
  type CapabilityMetrics,
  type HarnessFixture,
  type ModeObservation,
  routeFromMetrics,
  runCapabilityHarness,
} from "./capability-harness.js";
import type { RoleEngine } from "./contract.js";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "deepseek-v4-flash", provider: "deepseek", providerModelId: "deepseek-v4-flash",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const textResp = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });

/**
 * A fixture-aware engine: it answers based on `metadata.harnessMode`. `agent` returns whatever
 * `agentResp` gives; `patch`/`plan_patch`/`repair` return `patchResp`.
 */
function modeEngine(agentResp: ModelResponse, patchResp: ModelResponse): RoleEngine {
  return {
    invokeModel: async (req: ModelRequest) => {
      const mode = (req.metadata as { harnessMode?: string } | undefined)?.harnessMode;
      return mode === "agent" ? agentResp : patchResp;
    },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
}

/** A tiny single-file fixture with a hand-crafted oracle. */
const FIXTURE: HarnessFixture = {
  name: "set-v-to-2",
  goal: "Change v in src/f.ts from 1 to 2.",
  files: { "src/f.ts": "export const v = 1;\n" },
  targetFile: "src/f.ts",
  repairVerifierOutput: "CHECK RESULTS: FAILED\n[check: test] FAILED\n  error: v is not 2\n",
  targetTestPasses: (f) => /export const v = 2;/.test(f["src/f.ts"] ?? ""),
  fullVerificationPasses: (f) => /export const v = 2;/.test(f["src/f.ts"] ?? ""),
};

/** A clean, minimal diff that satisfies the fixture oracle. */
const GOOD_DIFF = "--- a/src/f.ts\n+++ b/src/f.ts\n@@ -1 +1 @@\n-export const v = 1;\n+export const v = 2;\n";

// ── pure routing ──

test("routeFromMetrics: reliable tool agent → agent_builder", () => {
  const m: CapabilityMetrics = base0({ tool_call_reliability: 0.9, schema_reliability: 0.8, patch_parseability: 0.9, diff_minimality: 0.9 });
  assert.equal(routeFromMetrics(m).role, "agent_builder");
});

test("routeFromMetrics: the plan's DeepSeek scorecard → patch_builder", () => {
  // The exact numbers from the plan: fails agent, viable patch generator.
  const m: CapabilityMetrics = base0({ tool_call_reliability: 0.3, schema_reliability: 0.5, patch_parseability: 0.9, diff_minimality: 0.8, repair_success_rate: 0.5, target_test_pass: 0.6, overclaiming_rate: 0.2 });
  const r = routeFromMetrics(m);
  assert.equal(r.role, "patch_builder");
  assert.match(r.reason, /patch generator/);
});

test("routeFromMetrics: only good at repair → repair_builder", () => {
  const m: CapabilityMetrics = base0({ tool_call_reliability: 0.1, schema_reliability: 0.1, patch_parseability: 0.4, diff_minimality: 0.2, repair_success_rate: 0.6 });
  assert.equal(routeFromMetrics(m).role, "repair_builder");
});

test("routeFromMetrics: nothing reliable → not_recommended", () => {
  const m: CapabilityMetrics = base0({});
  assert.equal(routeFromMetrics(m).role, "not_recommended");
});

// ── executor end-to-end ──

test("harness: a noisy-tool model that produces clean patches → patch_builder", async () => {
  // Agent mode: an UNKNOWN tool (noisy / invalid) on every call → tool_call_reliability 0.
  // Patch modes: a clean, minimal, applying diff → high parseability + minimality.
  const engine = modeEngine(toolResp([{ id: "c1", name: "frobnicate", arguments: "{}" }]), textResp(GOOD_DIFF));
  const card = await runCapabilityHarness({ model: "deepseek-v4-flash", engine, fixtures: [FIXTURE] });
  assert.equal(card.recommended_role, "patch_builder", `got ${card.recommended_role} (${card.routing_reason})`);
  assert.equal(card.tool_call_reliability, 0);
  assert.ok(card.patch_parseability >= 0.7, `parseability ${card.patch_parseability}`);
  assert.ok(card.diff_minimality >= 0.6, `minimality ${card.diff_minimality}`);
  assert.equal(card.full_verification_pass, 1, "the good patch passes the fixture oracle");
});

test("harness: a model that cannot produce diffs → not_recommended", async () => {
  // Agent mode: invalid tool. Patch modes: prose, never a diff → parseability 0.
  const engine = modeEngine(toolResp([{ id: "c1", name: "frobnicate", arguments: "{}" }]), textResp("Sure! Just change the 1 to a 2 in that file and you're all set."));
  const card = await runCapabilityHarness({ model: "word-salad-9000", engine, fixtures: [FIXTURE] });
  assert.equal(card.recommended_role, "not_recommended", `got ${card.recommended_role} (${card.routing_reason})`);
  assert.equal(card.patch_parseability, 0);
});

test("harness: a model that edits the forbidden test file does NOT get credit for the fix", async () => {
  const fixture: HarnessFixture = {
    name: "cheat",
    goal: "Make the test pass.",
    files: { "src/f.ts": "export const v = 1;\n", "src/f.test.ts": "if (v !== 2) throw new Error('x');\n" },
    targetFile: "src/f.ts",
    forbiddenFiles: ["src/f.test.ts"],
    repairVerifierOutput: "FAILED",
    targetTestPasses: () => true, // even if the oracle would pass...
    fullVerificationPasses: () => true,
  };
  // The model "fixes" it by editing the forbidden test.
  const cheatDiff = "--- a/src/f.test.ts\n+++ b/src/f.test.ts\n@@ -1 +1 @@\n-if (v !== 2) throw new Error('x');\n+if (false) throw new Error('x');\n";
  const engine = modeEngine(toolResp([{ id: "c1", name: "frobnicate", arguments: "{}" }]), textResp(cheatDiff));
  const card = await runCapabilityHarness({ model: "cheater", engine, fixtures: [fixture] });
  // Boundary violation → no target/full credit despite the passing oracle.
  assert.equal(card.test_boundary_respect, 0, "the boundary was violated");
  assert.equal(card.full_verification_pass, 0, "no credit for a fix that edits a forbidden file");
});

test("aggregateScorecard: metrics are the mean over DEFINED observations only", () => {
  const obs: ModeObservation[] = [
    { fixture: "a", mode: "patch", patchParseable: true, diffMinimal: true },
    { fixture: "b", mode: "patch", patchParseable: false },
    { fixture: "a", mode: "agent", toolCallValid: true, schemaValid: true },
  ];
  const card = aggregateScorecard("m", obs);
  assert.equal(card.patch_parseability, 0.5); // 1 of 2 defined
  assert.equal(card.diff_minimality, 1); // 1 of 1 defined (the false one is undefined → excluded)
  assert.equal(card.tool_call_reliability, 1);
});

/** Build a full metrics object with chosen overrides (everything else 0). */
function base0(over: Partial<CapabilityMetrics>): CapabilityMetrics {
  return {
    tool_call_reliability: 0, schema_reliability: 0, patch_parseability: 0, diff_minimality: 0,
    test_boundary_respect: 0, target_test_pass: 0, full_verification_pass: 0, repair_success_rate: 0,
    overclaiming_rate: 0, ...over,
  };
}
