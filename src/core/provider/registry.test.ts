import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelProvider, ProviderInvocation, ProviderResult } from "./contract.js";
import { registerFetchGuard } from "./fetch-guard.js";
import type { FetchLike } from "./providers/openai-compatible.js";
import { ModelRegistry, type ModelSpec } from "./registry.js";

// applyRoster constructs OpenAICompatibleProvider for roster provider entries via
// the fail-closed fetch-guard seam. In production the network-egress floor
// registers a guard first; mirror that here. The stub throws if invoked — these
// tests assert roster parsing/declaration, not network I/O.
const guardStub: FetchLike = async () => {
  throw new Error("egress guard stub: not exercised in this test");
};
registerFetchGuard(guardStub);

const dummyProvider = (id: string): ModelProvider => ({
  id,
  invoke: async (_inv: ProviderInvocation): Promise<ProviderResult> => ({
    content: "",
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  }),
});

const sampleModel: ModelSpec = {
  id: "mimo-v2.5",
  role: "driver",
  cost: { promptPerMTok: 0.3, completionPerMTok: 0.9 },
  providers: [{ provider: "mimo", providerModelId: "mimo-v2.5" }],
};

test("init seeds models and providers; read path works", () => {
  const reg = new ModelRegistry({ models: [sampleModel], providers: [dummyProvider("mimo")] });
  assert.equal(reg.listModels().length, 1);
  assert.equal(reg.getModel("mimo-v2.5")?.role, "driver");
  assert.equal(reg.getProvider("mimo")?.id, "mimo");
  assert.equal(reg.getModel("absent"), undefined);
});

test("update path: upsert / remove models & providers (config-driven roster)", () => {
  const reg = new ModelRegistry();
  reg.upsertModel(sampleModel);
  assert.equal(reg.listModels().length, 1);
  reg.upsertModel({ ...sampleModel, role: "primary" }); // upsert overwrites
  assert.equal(reg.getModel("mimo-v2.5")?.role, "primary");
  assert.equal(reg.removeModel("mimo-v2.5"), true);
  assert.equal(reg.removeModel("mimo-v2.5"), false);

  reg.registerProvider(dummyProvider("openrouter"));
  assert.equal(reg.listProviders().length, 1);
  assert.equal(reg.removeProvider("openrouter"), true);
  assert.equal(reg.listProviders().length, 0);
});

test("applyRoster upserts models and declares providers from data", () => {
  const reg = new ModelRegistry();
  const applied = reg.applyRoster({
    providers: [{ id: "extra", kind: "openai-compatible", baseUrl: "https://x/v1", apiKey: "k" }],
    models: [
      {
        id: "custom-model",
        role: "scout",
        cost: { promptPerMTok: 0.1, completionPerMTok: 0.2 },
        providers: [{ provider: "extra", providerModelId: "vendor/custom" }],
      },
    ],
  });
  assert.deepEqual(applied, { models: 1, providers: 1 });
  assert.equal(reg.getModel("custom-model")?.role, "scout");
  assert.equal(reg.getProvider("extra")?.id, "extra");
});

test("applyRoster rejects malformed documents (fail loud)", () => {
  assert.throws(() => new ModelRegistry().applyRoster(42));
  assert.throws(() => new ModelRegistry().applyRoster({ models: "nope" }));
  assert.throws(() => new ModelRegistry().applyRoster({ models: [{ id: "x" }] })); // missing cost/providers
  assert.throws(() =>
    new ModelRegistry().applyRoster({ models: [{ id: "x", cost: { promptPerMTok: 1, completionPerMTok: 1 }, providers: [] }] }),
  ); // empty provider chain
  assert.throws(() =>
    new ModelRegistry().applyRoster({ providers: [{ id: "p", kind: "weird", baseUrl: "u" }] }),
  ); // unsupported kind
});

test("per-route cost is accepted; a route with neither route- nor model-cost is rejected", () => {
  const reg = new ModelRegistry();
  // Route-level cost, no model-level cost: valid.
  reg.applyRoster({
    models: [
      {
        id: "split-cost",
        providers: [
          { provider: "mimo", providerModelId: "m", cost: { promptPerMTok: 0.3, completionPerMTok: 0.9, cachedPromptPerMTok: 0.03 } },
          { provider: "openrouter", providerModelId: "m", cost: { promptPerMTok: 0.5, completionPerMTok: 1.2 } },
        ],
      },
    ],
  });
  const m = reg.getModel("split-cost");
  assert.equal(m?.providers[0]?.cost?.cachedPromptPerMTok, 0.03);
  assert.equal(m?.providers[1]?.cost?.promptPerMTok, 0.5);

  // No cost anywhere -> rejected (every route must resolve to a rate).
  assert.throws(() =>
    new ModelRegistry().applyRoster({
      models: [{ id: "no-cost", providers: [{ provider: "mimo", providerModelId: "m" }] }],
    }),
  );
});

test("loadRosterFile is a no-op when the file is absent", () => {
  const reg = new ModelRegistry();
  const applied = reg.loadRosterFile("/nonexistent/ikbi-roster-does-not-exist.json");
  assert.deepEqual(applied, { models: 0, providers: 0 });
});
