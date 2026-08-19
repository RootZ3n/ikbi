/**
 * V2-016 — LIVE ROUTE TRUTH.
 *
 * Reproduces the cutover routing debts against the SHIPPED canonical catalog, and proves the
 * operator's real daily-driver config resolves to exact real routes. INVENTORY IS FACT: preference
 * never invents a route, so a model with no declared route on a given box is truthfully unselectable
 * rather than papered over with a fallback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanonicalCatalog } from "./model-catalog.js";
import { capabilityFacts } from "./provider-inventory.js";
import { buildRuntimeModelPolicy } from "../core/config.js";
import { resolveModelRoute } from "../core/resolver.js";
import type { ProviderFactsInput } from "../core/config.js";

/** A provider facts row; `ready` toggles whether its credential is present. */
function provider(id: string, ready: boolean): ProviderFactsInput {
  return { id, introspectable: true, kind: "openai-compatible", baseUrl: `https://${id}`, credentialRequired: true, credentialPresent: ready };
}

function policyFor(providers: readonly ProviderFactsInput[], roles: { driver: string; critic: string; explicit: boolean }) {
  const inventory = buildCanonicalCatalog({ providers, rosterModels: [], capabilitiesFor: (id) => capabilityFacts(id) });
  const built = buildRuntimeModelPolicy({
    inventory,
    activeProfile: { kind: "none" },
    operatorDefaults: {
      models: [
        { tier: "driver", modelId: roles.driver, explicit: roles.explicit },
        { tier: "builder", modelId: roles.driver, explicit: roles.explicit },
        { tier: "critic", modelId: roles.critic, explicit: roles.explicit },
      ],
    },
  });
  if (!built.ok) throw new Error(`policy build failed: ${built.failure.code}`);
  return built.policy;
}

const resolve = (policy: ReturnType<typeof policyFor>, role: string) =>
  resolveModelRoute(policy, { runId: "run_seed-00000001" as never, policyId: policy.policyId, role: role as never });

// ── the reproduced debt ───────────────────────────────────────────────────────

test("route truth (reproduced debt): the shipped mimo defaults are UNSELECTABLE on a deepseek-only box", () => {
  // The default builder is mimo-v2.5, which routes only to [mimo, openrouter]. With only DeepSeek
  // credentialed, that is genuinely unavailable — a TRUTHFUL no_selectable_route, not a bug to mask.
  const policy = policyFor([provider("deepseek", true), provider("mimo", false), provider("openrouter", false)], { driver: "mimo-v2.5", critic: "mimo-v2.5-pro", explicit: false });
  const builder = resolve(policy, "builder");
  assert.equal(builder.ok, false);
  if (!builder.ok) assert.equal(builder.failure.code, "resolution.no_selectable_route");
});

// ── the remediation: the real intended daily-driver config resolves EXACTLY ─────

test("route truth: the DeepSeek daily-driver config resolves builder + critic to exact real routes", () => {
  // deepseek-chat (builder) and deepseek-reasoner (critic) are real DeepSeek models with native
  // tools; on a credentialed DeepSeek box both resolve to their exact wire ids, one decision each.
  const policy = policyFor([provider("deepseek", true)], { driver: "deepseek-chat", critic: "deepseek-reasoner", explicit: true });

  const builder = resolve(policy, "builder");
  assert.ok(builder.ok, "builder resolves");
  assert.equal(builder.decision.providerId, "deepseek");
  assert.equal(builder.decision.providerModelId, "deepseek-chat", "the WIRE id is exactly the DeepSeek model — no served-route fiction");
  assert.equal(builder.decision.modelId, "deepseek-chat");

  const critic = resolve(policy, "critic");
  assert.ok(critic.ok, "critic resolves");
  assert.equal(critic.decision.providerId, "deepseek");
  assert.equal(critic.decision.providerModelId, "deepseek-reasoner");
  // Exactly one decision per role — no fallback chain walked to a second route.
  assert.equal(builder.decision.routeOrdinal, 0);
  assert.equal(critic.decision.routeOrdinal, 0);
});
