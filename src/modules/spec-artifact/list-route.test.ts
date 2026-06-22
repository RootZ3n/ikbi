/**
 * Codex HIGH-3: the dashboard calls GET /ikbi/spec, which previously had no server route.
 * This verifies the list route now exists, returns {specs, count}, and reflects listSpecs().
 */

// Dev-key opt-in MUST be set before the server (config reads it at module load). See index.test.ts.
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

// Side-effect import: registers the spec-artifact routes (ESM-cached → once per process).
import "./index.js";
import { resolveStoreDir } from "./store.js";
import { join } from "node:path";

type ServerApp = ReturnType<typeof import("../../server/index.js")["buildServer"]>;

async function withServer(fn: (app: ServerApp) => Promise<void>): Promise<void> {
  const { buildServer } = await import("../../server/index.js");
  const app = buildServer();
  await app.ready();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("HIGH-3: GET /ikbi/spec returns {specs, count} (the list route exists)", async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: "GET", url: "/ikbi/spec" });
    assert.equal(res.statusCode, 200, "the list route is registered (no longer 404)");
    const body = res.json();
    assert.ok(Array.isArray(body.specs), "responds with a specs array");
    assert.equal(body.count, body.specs.length, "count matches the list length");
  });
});

test("HIGH-3: a generated spec appears in GET /ikbi/spec (route reflects listSpecs)", async () => {
  await withServer(async (app) => {
    const created = (
      await app.inject({ method: "POST", url: "/ikbi/spec/generate", payload: { goal: "list-route coverage spec" } })
    ).json();
    assert.ok(created.id, "a spec was generated");

    const list = (await app.inject({ method: "GET", url: "/ikbi/spec" })).json();
    assert.ok(list.specs.some((s: { id: string }) => s.id === created.id), "the generated spec is in the list");

    // Cleanup: drop the spec file we created so the shared default store does not accumulate cruft.
    rmSync(join(resolveStoreDir(), `${created.id}.json`), { force: true });
  });
});
