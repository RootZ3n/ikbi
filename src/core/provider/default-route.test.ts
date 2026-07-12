import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../config.js";
import { registerFetchGuard } from "./fetch-guard.js";
import type { FetchLike } from "./providers/openai-compatible.js";

// Building the provider registry constructs providers through the fail-closed fetch-guard seam; in
// production the network-egress floor registers a guard first. Mirror that, THEN dynamically import
// the provider index (whose module-level `registry` const builds at import). The stub throws if
// invoked — this test inspects model ROUTES, never performs network I/O.
const guardStub: FetchLike = async () => {
  throw new Error("egress guard stub: not exercised in this test");
};
registerFetchGuard(guardStub);

// REGRESSION: the default critic / mid-tier model (deepseek-v4-pro) used to be hardcoded to the
// MiniMax provider, whose key is a placeholder. Because --complexity large bumps the builder to the
// mid tier, EVERY large build died instantly with `minimax=permanent_error` whenever the roster file
// was absent — before a single line was written. The built-in default must route to the real DeepSeek
// endpoint (the proven route), never MiniMax.
test("default critic/mid-tier model routes to DeepSeek, never the MiniMax placeholder", async () => {
  const { buildDefaultRegistry } = await import("./index.js");
  const reg = buildDefaultRegistry(); // built-in defaults (no roster file in the test state root)
  const criticId = config.provider.defaultModels.critic;
  const spec = reg.getModel(criticId);
  assert.ok(spec !== undefined, `default critic model "${criticId}" is registered`);
  const providerIds = spec!.providers.map((p) => p.provider);
  assert.ok(providerIds.length > 0, "the critic model has at least one provider route");
  assert.ok(providerIds.includes("deepseek"), `critic routes to the real deepseek provider (got: ${providerIds.join(", ")})`);
  assert.ok(!providerIds.includes("minimax"), `critic never routes to the minimax placeholder (got: ${providerIds.join(", ")})`);
});
