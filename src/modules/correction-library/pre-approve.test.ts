/**
 * Codex LOW-1: POST /ikbi/corrections must NEVER pre-approve. The `approved` field in the
 * request body is ignored — a proposed correction is always approved=false (propose-then-approve).
 */

// Dev-key opt-in MUST be set before the server (config reads it at module load). See index.test.ts.
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Side-effect import: registers the correction-library routes (ESM-cached → once per process).
import "./index.js";

type ServerApp = ReturnType<typeof import("../../server/index.js")["buildServer"]>;

async function withServer(fn: (app: ServerApp) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "correction-pre-approve-"));
  const prev = process.env.IKBI_CORRECTIONS_DIR;
  process.env.IKBI_CORRECTIONS_DIR = dir;
  const { buildServer } = await import("../../server/index.js");
  const app = buildServer();
  await app.ready();
  try {
    await fn(app);
  } finally {
    await app.close();
    if (prev === undefined) delete process.env.IKBI_CORRECTIONS_DIR;
    else process.env.IKBI_CORRECTIONS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("LOW-1: POST with approved:true → response has approved:false (cannot pre-approve)", async () => {
  await withServer(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/ikbi/corrections",
      payload: {
        category: "verification_forgery",
        finding: "verifier ran a stub script",
        correction: "require a real test runner",
        regression: "assert the test script invokes a known runner",
        approved: true, // attempt to pre-approve — MUST be ignored
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.approved, false, "the approved field from the body is ignored; corrections are proposed");

    // And it is genuinely not approved in the store (the approved=true filter excludes it).
    const approvedOnly = await app.inject({ method: "GET", url: "/ikbi/corrections?approved=true" });
    assert.equal(approvedOnly.json().count, 0, "no pre-approved correction was persisted");
  });
});
