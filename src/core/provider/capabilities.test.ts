import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptMaxTokens, FALLBACK_CAPABILITIES, getCapabilities } from "./capabilities.js";
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
  assert.equal(c.supports_tools, false, "the reasoner family is non-tool");
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
        capabilities: { context_window: 2_048, supports_tools: false, reasoning_level: "low", speed_class: "fast" },
      },
    ],
  });
  const override = reg.capabilitiesFor("local-tiny");
  assert.equal(override?.context_window, 2_048);
  assert.equal(override?.supports_tools, false);
  const resolved = getCapabilities("local-tiny", override);
  assert.equal(resolved.context_window, 2_048);
  assert.equal(resolved.supports_tools, false);
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

test("capabilitiesFor is undefined for a model without an override (defaults still resolve)", () => {
  const reg = new ModelRegistry();
  reg.applyRoster({
    models: [{ id: "plain", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p", providerModelId: "plain" }] }],
  });
  assert.equal(reg.capabilitiesFor("plain"), undefined);
  // resolution still works off the family/fallback table.
  assert.ok(getCapabilities("plain").context_window > 0);
});
