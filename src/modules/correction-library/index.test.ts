/**
 * Tests for the correction-library module — store CRUD, filtering, application
 * counters, store-dir creation, and route tests for all five endpoints.
 */

// Dev-key opt-in MUST be set before the server (config.ts reads it at module load). ESM
// hoists `import` statements above body code, so the server is NOT statically imported
// here — it is dynamically imported inside `withServer`, AFTER this assignment has run.
// This never weakens production: it only flips the explicit insecure-dev-keys opt-in that
// config already requires for a non-prod boot, and only when the harness has not set it.
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { CorrectionProposeInput } from "./contract.js";
import { CORRECTION_CATEGORIES, isCorrectionCategory } from "./contract.js";
import {
  createCorrection,
  getCorrection,
  listCorrections,
  approveCorrection,
  rejectCorrection,
  recordApplication,
} from "./store.js";
// Side-effect import: registers the correction-library routes EXACTLY ONCE (ESM caches
// the module, so the import-time `registerRoutes` call cannot run twice). node's test
// runner isolates each test file in its own process, so the registry holds only these
// routes (plus the core routes buildServer adds) — no cross-file pollution. This module
// does NOT load config, so it is safe to import statically (the server, which does load
// config, is imported dynamically in withServer after the dev-key opt-in above).
import "./index.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "correction-library-test-"));
}

function sample(overrides: Partial<CorrectionProposeInput> = {}): CorrectionProposeInput {
  return {
    category: "test_weakening",
    finding: "a test assertion was deleted",
    correction: "restore the deleted assertion",
    regression: "assert the assertion is present in the test file",
    ...overrides,
  };
}

// ── Contract guards ────────────────────────────────────────────────────────

test("CORRECTION_CATEGORIES contains the nine taxonomy entries", () => {
  assert.equal(CORRECTION_CATEGORIES.length, 9);
  assert.ok(CORRECTION_CATEGORIES.includes("verification_forgery"));
  assert.ok(CORRECTION_CATEGORIES.includes("custom"));
});

test("isCorrectionCategory accepts known and rejects unknown", () => {
  assert.equal(isCorrectionCategory("forbidden_file"), true);
  assert.equal(isCorrectionCategory("not_a_category"), false);
});

// ── Store CRUD ─────────────────────────────────────────────────────────────

test("createCorrection fills id/timestamps/counters and defaults approved=false", () => {
  const dir = tmpDir();
  try {
    const entry = createCorrection(sample(), dir);
    assert.ok(entry.id);
    assert.equal(entry.category, "test_weakening");
    assert.equal(entry.approved, false, "corrections are proposed, not auto-installed");
    assert.equal(entry.appliedCount, 0);
    assert.equal(entry.proposedBy, "system");
    assert.ok(entry.createdAt);
    assert.equal(entry.createdAt, entry.updatedAt);
    assert.equal(entry.lastAppliedAt, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createCorrection honors approved + proposedBy + sourceRunId", () => {
  const dir = tmpDir();
  try {
    const entry = createCorrection(
      sample({ approved: true, proposedBy: "operator", sourceRunId: "run-123" }),
      dir,
    );
    assert.equal(entry.approved, true);
    assert.equal(entry.proposedBy, "operator");
    assert.equal(entry.sourceRunId, "run-123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createCorrection creates the store directory if missing", () => {
  const dir = tmpDir();
  try {
    const nested = join(dir, "does", "not", "exist", "yet");
    assert.equal(existsSync(nested), false);
    createCorrection(sample(), nested);
    assert.equal(existsSync(nested), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createCorrection and getCorrection round-trip", () => {
  const dir = tmpDir();
  try {
    const entry = createCorrection(sample(), dir);
    const fetched = getCorrection(entry.id, dir);
    assert.deepEqual(fetched, entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getCorrection returns undefined for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(getCorrection("nonexistent", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCorrections returns empty array for new store", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(listCorrections(undefined, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCorrections returns newest first", () => {
  const dir = tmpDir();
  try {
    createCorrection(sample({ finding: "first" }), dir);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin for a distinct timestamp */ }
    createCorrection(sample({ finding: "second" }), dir);
    const all = listCorrections(undefined, dir);
    assert.equal(all.length, 2);
    assert.equal(all[0]!.finding, "second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Filtering ──────────────────────────────────────────────────────────────

test("listCorrections filters by category", () => {
  const dir = tmpDir();
  try {
    createCorrection(sample({ category: "test_weakening" }), dir);
    createCorrection(sample({ category: "forbidden_file" }), dir);
    createCorrection(sample({ category: "forbidden_file" }), dir);
    const forbidden = listCorrections({ category: "forbidden_file" }, dir);
    assert.equal(forbidden.length, 2);
    assert.ok(forbidden.every((c) => c.category === "forbidden_file"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCorrections filters by approved status", () => {
  const dir = tmpDir();
  try {
    createCorrection(sample({ approved: false }), dir);
    createCorrection(sample({ approved: true }), dir);
    const approved = listCorrections({ approved: true }, dir);
    assert.equal(approved.length, 1);
    assert.equal(approved[0]!.approved, true);
    const pending = listCorrections({ approved: false }, dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.approved, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCorrections combines category + approved filters", () => {
  const dir = tmpDir();
  try {
    createCorrection(sample({ category: "tool_limitation", approved: true }), dir);
    createCorrection(sample({ category: "tool_limitation", approved: false }), dir);
    createCorrection(sample({ category: "environment_missing", approved: true }), dir);
    const got = listCorrections({ category: "tool_limitation", approved: true }, dir);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.category, "tool_limitation");
    assert.equal(got[0]!.approved, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Approve / reject ──────────────────────────────────────────────────────

test("approveCorrection sets approved=true and bumps updatedAt", () => {
  const dir = tmpDir();
  try {
    const entry = createCorrection(sample(), dir);
    assert.equal(entry.approved, false);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const approved = approveCorrection(entry.id, dir);
    assert.ok(approved);
    assert.equal(approved!.approved, true);
    assert.ok(approved!.updatedAt >= entry.updatedAt);
    // persisted
    assert.equal(getCorrection(entry.id, dir)!.approved, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approveCorrection returns undefined for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(approveCorrection("nonexistent", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejectCorrection deletes the entry", () => {
  const dir = tmpDir();
  try {
    const entry = createCorrection(sample(), dir);
    assert.equal(rejectCorrection(entry.id, dir), true);
    assert.equal(getCorrection(entry.id, dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejectCorrection returns false for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(rejectCorrection("nonexistent", dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Application counter ───────────────────────────────────────────────────

test("recordApplication increments count and stamps lastAppliedAt", () => {
  const dir = tmpDir();
  try {
    const entry = createCorrection(sample(), dir);
    const once = recordApplication(entry.id, dir);
    assert.ok(once);
    assert.equal(once!.appliedCount, 1);
    assert.ok(once!.lastAppliedAt);
    const twice = recordApplication(entry.id, dir);
    assert.equal(twice!.appliedCount, 2);
    // persisted
    assert.equal(getCorrection(entry.id, dir)!.appliedCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordApplication returns undefined for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(recordApplication("nonexistent", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Routes (all five endpoints, via Fastify inject) ───────────────────────

type ServerApp = ReturnType<typeof import("../../server/index.js")["buildServer"]>;

async function withServer(fn: (app: ServerApp) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const prev = process.env.IKBI_CORRECTIONS_DIR;
  process.env.IKBI_CORRECTIONS_DIR = dir;
  // Dynamic import: config loads HERE (after the dev-key opt-in at the top of the file),
  // not at module-eval time. The module is cached, so buildServer is the same function
  // across tests; each call builds a fresh app from the (already-registered) routes.
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

test("POST /ikbi/corrections proposes a correction (201, approved=false)", async () => {
  await withServer(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/ikbi/corrections",
      payload: {
        category: "verification_forgery",
        finding: "verifier ran a stub script",
        correction: "require a real test runner",
        regression: "assert the test script invokes a known runner",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.id);
    assert.equal(body.category, "verification_forgery");
    assert.equal(body.approved, false);
    assert.equal(body.appliedCount, 0);
  });
});

test("POST /ikbi/corrections rejects an invalid body (400)", async () => {
  await withServer(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/ikbi/corrections",
      payload: { category: "not_a_category", finding: "x", correction: "y", regression: "z" },
    });
    assert.equal(res.statusCode, 400);

    const res2 = await app.inject({
      method: "POST",
      url: "/ikbi/corrections",
      payload: { category: "custom", finding: "x" },
    });
    assert.equal(res2.statusCode, 400);
  });
});

test("GET /ikbi/corrections lists all with count, and honors filters", async () => {
  await withServer(async (app) => {
    await app.inject({
      method: "POST",
      url: "/ikbi/corrections",
      payload: { category: "tool_limitation", finding: "a", correction: "b", regression: "c" },
    });
    const approveTarget = (
      await app.inject({
        method: "POST",
        url: "/ikbi/corrections",
        payload: { category: "forbidden_file", finding: "d", correction: "e", regression: "f" },
      })
    ).json();
    await app.inject({ method: "PATCH", url: `/ikbi/corrections/${approveTarget.id}/approve` });

    const all = await app.inject({ method: "GET", url: "/ikbi/corrections" });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().count, 2);
    assert.equal(all.json().corrections.length, 2);

    const byCat = await app.inject({ method: "GET", url: "/ikbi/corrections?category=forbidden_file" });
    assert.equal(byCat.json().count, 1);
    assert.equal(byCat.json().corrections[0].category, "forbidden_file");

    const approvedOnly = await app.inject({ method: "GET", url: "/ikbi/corrections?approved=true" });
    assert.equal(approvedOnly.json().count, 1);
    assert.equal(approvedOnly.json().corrections[0].approved, true);
  });
});

test("GET /ikbi/corrections/:id returns one (200) or 404", async () => {
  await withServer(async (app) => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/ikbi/corrections",
        payload: { category: "custom", finding: "a", correction: "b", regression: "c" },
      })
    ).json();
    const ok = await app.inject({ method: "GET", url: `/ikbi/corrections/${created.id}` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().id, created.id);

    const missing = await app.inject({ method: "GET", url: "/ikbi/corrections/nope" });
    assert.equal(missing.statusCode, 404);
  });
});

test("PATCH /ikbi/corrections/:id/approve approves (200) or 404", async () => {
  await withServer(async (app) => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/ikbi/corrections",
        payload: { category: "custom", finding: "a", correction: "b", regression: "c" },
      })
    ).json();
    const ok = await app.inject({ method: "PATCH", url: `/ikbi/corrections/${created.id}/approve` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().approved, true);

    const missing = await app.inject({ method: "PATCH", url: "/ikbi/corrections/nope/approve" });
    assert.equal(missing.statusCode, 404);
  });
});

test("DELETE /ikbi/corrections/:id rejects (200) or 404", async () => {
  await withServer(async (app) => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/ikbi/corrections",
        payload: { category: "custom", finding: "a", correction: "b", regression: "c" },
      })
    ).json();
    const ok = await app.inject({ method: "DELETE", url: `/ikbi/corrections/${created.id}` });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { deleted: true });

    const gone = await app.inject({ method: "GET", url: `/ikbi/corrections/${created.id}` });
    assert.equal(gone.statusCode, 404);

    const missing = await app.inject({ method: "DELETE", url: "/ikbi/corrections/nope" });
    assert.equal(missing.statusCode, 404);
  });
});
