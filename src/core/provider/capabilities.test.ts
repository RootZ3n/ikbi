import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adaptMaxTokens,
  FALLBACK_CAPABILITIES,
  findUnclassifiedModels,
  getCapabilities,
  isModelClassified,
} from "./capabilities.js";
import { ModelRegistry } from "./registry.js";

// ── getCapabilities: known ids, family patterns, fallback ───────────────────

test("getCapabilities resolves a known model id exactly", () => {
  const c = getCapabilities("mimo-v2.5");
  assert.equal(c.context_window, 32_768);
  assert.equal(c.supports_tools, true);
  assert.equal(c.speed_class, "fast");
});

test("getCapabilities resolves an unknown member of a known family by pattern", () => {
  const c = getCapabilities("deepseek-reasoner-lite-v9");
  assert.equal(c.supports_tools, true, "DeepSeek V4+ reasoner family supports tools");
  assert.equal(c.reasoning_level, "high");
});

test("getCapabilities falls back conservatively for a wholly unknown model", () => {
  const c = getCapabilities("some-brand-new-llm-xyz");
  assert.deepEqual(c, FALLBACK_CAPABILITIES);
});

test("getCapabilities layers a partial override on top of the resolved base", () => {
  const c = getCapabilities("mimo-v2.5", { context_window: 4_096, reasoning_level: "low" });
  assert.equal(c.context_window, 4_096, "override wins");
  assert.equal(c.reasoning_level, "low", "override wins");
  assert.equal(c.supports_tools, true, "un-overridden field keeps the base value");
  assert.equal(c.speed_class, "fast", "un-overridden field keeps the base value");
});

test("getCapabilities ignores an empty/invalid override", () => {
  const c = getCapabilities("mimo-v2.5", {});
  assert.deepEqual(c, getCapabilities("mimo-v2.5"));
});

// ── adaptMaxTokens: clamp to the window ─────────────────────────────────────

test("adaptMaxTokens clamps a big budget down for a small-context model", () => {
  const small = getCapabilities("llama-3-8b"); // family fallback: 8192 window
  assert.equal(adaptMaxTokens(12_288, small), 4_096, "half of 8192");
});

test("adaptMaxTokens leaves a budget that already fits a large window", () => {
  const big = getCapabilities("mimo-v2.5"); // 32768 window → ceiling 16384
  assert.equal(adaptMaxTokens(12_288, big), 12_288);
});

test("adaptMaxTokens never goes below the floor", () => {
  const tiny = getCapabilities("x", { context_window: 100 });
  assert.equal(adaptMaxTokens(12_288, tiny), 512, "floor honored even for a tiny window");
});

// ── roster override via ModelSpec.capabilities ──────────────────────────────

test("a roster ModelSpec can declare a capabilities override, parsed and resolvable", () => {
  const reg = new ModelRegistry();
  reg.applyRoster({
    models: [
      {
        id: "local-tiny",
        cost: { promptPerMTok: 0, completionPerMTok: 0 },
        providers: [{ provider: "p", providerModelId: "local-tiny" }],
        capabilities: { context_window: 2_048, supports_tools: false, supports_thinking: true, reasoning_level: "low", speed_class: "fast" },
      },
    ],
  });
  const override = reg.capabilitiesFor("local-tiny");
  assert.equal(override?.context_window, 2_048);
  assert.equal(override?.supports_tools, false);
  assert.equal(override?.supports_thinking, true);
  const resolved = getCapabilities("local-tiny", override);
  assert.equal(resolved.context_window, 2_048);
  assert.equal(resolved.supports_tools, false);
  assert.equal(resolved.supports_thinking, true);
});

test("the roster rejects an invalid capability field (fail loud)", () => {
  const reg = new ModelRegistry();
  assert.throws(
    () =>
      reg.applyRoster({
        models: [
          {
            id: "bad",
            cost: { promptPerMTok: 0, completionPerMTok: 0 },
            providers: [{ provider: "p", providerModelId: "bad" }],
            capabilities: { reasoning_level: "galaxy-brain" },
          },
        ],
      }),
    /reasoning_level must be one of/,
  );
});

// ── silent-degradation guard: isModelClassified / findUnclassifiedModels ────

test("isModelClassified is true for exact-table and family-pattern ids, false for unknowns", () => {
  assert.equal(isModelClassified("mimo-v2.5"), true, "exact table");
  assert.equal(isModelClassified("opus-4.8"), true, "frontier logical id via family pattern");
  assert.equal(isModelClassified("deepseek-anything"), true, "family pattern");
  assert.equal(isModelClassified("some-brand-new-llm-xyz"), false, "wholly unknown");
});

test("findUnclassifiedModels flags an unknown id with no override (the silent-8k bug)", () => {
  const flagged = findUnclassifiedModels([{ id: "mystery-model-v1" }]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]!.id, "mystery-model-v1");
  assert.equal(flagged[0]!.contextWindow, FALLBACK_CAPABILITIES.context_window, "resolves to the 8k fallback");
});

test("findUnclassifiedModels does NOT flag classified frontier logical ids", () => {
  // opus-4.8 / sonnet-4.6 don't contain 'claude' but are classified by family pattern.
  assert.deepEqual(findUnclassifiedModels([{ id: "opus-4.8" }, { id: "sonnet-4.6" }]), []);
});

test("findUnclassifiedModels treats an explicit window/tools override as intentional (not flagged)", () => {
  // An operator running a genuine small local model declares it — that's not the bug.
  const models = [
    { id: "local-tiny", capabilities: { context_window: 8_192, supports_tools: false } },
    { id: "local-toolless", capabilities: { supports_tools: false } },
  ];
  assert.deepEqual(findUnclassifiedModels(models), []);
});

test("findUnclassifiedModels still flags an unknown id whose override touches neither window nor tools", () => {
  // A partial override that doesn't address the degraded fields is NOT intentional config.
  const flagged = findUnclassifiedModels([{ id: "mystery-v2", capabilities: { reasoning_level: "high" } }]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]!.id, "mystery-v2");
});

test("capabilitiesFor is undefined for a model without an override (defaults still resolve)", () => {
  const reg = new ModelRegistry();
  reg.applyRoster({
    models: [{ id: "plain", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p", providerModelId: "plain" }] }],
  });
  assert.equal(reg.capabilitiesFor("plain"), undefined);
  // resolution still works off the family/fallback table.
  assert.ok(getCapabilities("plain").context_window > 0);
});
