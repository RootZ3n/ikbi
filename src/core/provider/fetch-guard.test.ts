import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  EgressGuardMissingError,
  hasFetchGuard,
  registerFetchGuard,
  resetFetchGuardForTests,
  resolveFetchGuard,
} from "./fetch-guard.js";
import { createDeepseekProvider, createMimoProvider, createOpenRouterProvider } from "./providers/index.js";
import { type FetchLike, OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ModelRegistry } from "./registry.js";

// Every test starts with NO guard registered (the fail-closed precondition).
beforeEach(resetFetchGuardForTests);

const mimoCfg = { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "k" };
const orCfg = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", referer: undefined, title: undefined };
const deepseekCfg = { baseUrl: "https://api.deepseek.com/v1", apiKey: "k" };
const stubFetch: FetchLike = async () => {
  throw new Error("stub");
};

test("resolveFetchGuard throws EgressGuardMissingError when no guard is registered", () => {
  assert.equal(hasFetchGuard(), false);
  assert.throws(() => resolveFetchGuard(), EgressGuardMissingError);
});

test("construction site 1 — createMimoProvider fails closed with no guard", () => {
  assert.throws(() => createMimoProvider(mimoCfg), EgressGuardMissingError);
});

test("construction site 2 — createOpenRouterProvider fails closed with no guard", () => {
  assert.throws(() => createOpenRouterProvider(orCfg), EgressGuardMissingError);
});

test("construction site 2b — createDeepseekProvider fails closed with no guard", () => {
  assert.throws(() => createDeepseekProvider(deepseekCfg), EgressGuardMissingError);
});

test("construction site 3 — roster provider entry (parseProviderEntry) fails closed with no guard", () => {
  const reg = new ModelRegistry();
  assert.throws(
    () =>
      reg.applyRoster({
        providers: [{ id: "extra", kind: "openai-compatible", baseUrl: "https://x/v1", apiKey: "k" }],
        models: [
          {
            id: "m",
            role: "scout",
            cost: { promptPerMTok: 0.1, completionPerMTok: 0.2 },
            providers: [{ provider: "extra", providerModelId: "vendor/m" }],
          },
        ],
      }),
    EgressGuardMissingError,
  );
});

test("an explicit fetchImpl still wins — no guard needed (tests' path preserved)", () => {
  assert.doesNotThrow(() => new OpenAICompatibleProvider({ id: "x", baseUrl: "https://x", apiKey: "k", fetchImpl: stubFetch }));
  assert.doesNotThrow(() => createMimoProvider(mimoCfg, stubFetch));
  assert.doesNotThrow(() => createOpenRouterProvider(orCfg, stubFetch));
  assert.doesNotThrow(() => createDeepseekProvider(deepseekCfg, stubFetch));
});

test("the deepseek provider registers with id \"deepseek\" and is listed", () => {
  registerFetchGuard(stubFetch);
  const reg = new ModelRegistry({ providers: [createDeepseekProvider(deepseekCfg)] });
  assert.equal(reg.getProvider("deepseek")?.id, "deepseek");
  assert.ok(reg.listProviders().some((p) => p.id === "deepseek"));
});

test("once a guard is registered, construction resolves it (no throw)", () => {
  registerFetchGuard(stubFetch);
  assert.equal(hasFetchGuard(), true);
  assert.equal(resolveFetchGuard(), stubFetch);
  assert.doesNotThrow(() => createMimoProvider(mimoCfg));
});
