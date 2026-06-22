/**
 * Tests for spec-artifact module — store, generation, and execution.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { SpecCardFields, SpecStep } from "./contract.js";
import { createSpec, getSpec, updateSpec, listSpecs } from "./store.js";
import { generateSpec, generateStructuredSpec, parseStructuredSpec } from "./index.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "spec-artifact-test-"));
}

const SAMPLE_STEPS: SpecStep[] = [
  { index: 1, goal: "Read the file" },
  { index: 2, goal: "Make the change" },
  { index: 3, goal: "Run tests" },
];

// ── Store ────────────────────────────────────────────────────────────────

test("createSpec and getSpec round-trip", () => {
  const dir = tmpDir();
  try {
    const spec = createSpec("Build a widget", SAMPLE_STEPS, dir);
    assert.ok(spec.id);
    assert.equal(spec.goal, "Build a widget");
    assert.equal(spec.status, "draft");
    assert.equal(spec.steps.length, 3);
    assert.ok(spec.createdAt);

    const fetched = getSpec(spec.id, dir);
    assert.deepEqual(fetched, spec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSpec returns undefined for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(getSpec("nonexistent", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSpec modifies fields", () => {
  const dir = tmpDir();
  try {
    const spec = createSpec("Goal", SAMPLE_STEPS, dir);
    const updated = updateSpec(spec.id, { status: "approved" }, dir);
    assert.ok(updated);
    assert.equal(updated!.status, "approved");
    assert.ok(updated!.updatedAt >= spec.updatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSpec returns undefined for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(updateSpec("nonexistent", { status: "approved" }, dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSpecs returns all specs", () => {
  const dir = tmpDir();
  try {
    createSpec("Goal A", SAMPLE_STEPS, dir);
    createSpec("Goal B", SAMPLE_STEPS, dir);
    const all = listSpecs(dir);
    assert.equal(all.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSpecs returns empty for new store", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(listSpecs(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSpecs returns newest first", () => {
  const dir = tmpDir();
  try {
    createSpec("First", SAMPLE_STEPS, dir);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin for a distinct timestamp */ }
    createSpec("Second", SAMPLE_STEPS, dir);
    const all = listSpecs(dir);
    assert.equal(all.length, 2);
    assert.equal(all[0]!.goal, "Second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Generation ───────────────────────────────────────────────────────────

test("generateSpec creates spec from goal", () => {
  const dir = tmpDir();
  try {
    const spec = generateSpec("Add authentication to the API", dir);
    assert.ok(spec.id);
    assert.equal(spec.goal, "Add authentication to the API");
    assert.equal(spec.status, "draft");
    assert.ok(spec.steps.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateSpec decomposes complex goals", () => {
  const dir = tmpDir();
  try {
    const spec = generateSpec("1. Add user model\n2. Create auth middleware\n3. Wire login endpoint", dir);
    assert.ok(spec.steps.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateSpec keeps simple goals as single step", () => {
  const dir = tmpDir();
  try {
    const spec = generateSpec("Fix the typo in README", dir);
    assert.equal(spec.steps.length, 1);
    assert.equal(spec.steps[0]!.index, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Spec lifecycle ───────────────────────────────────────────────────────

test("spec starts as draft", () => {
  const dir = tmpDir();
  try {
    const spec = createSpec("Goal", SAMPLE_STEPS, dir);
    assert.equal(spec.status, "draft");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec can transition through statuses", () => {
  const dir = tmpDir();
  try {
    const spec = createSpec("Goal", SAMPLE_STEPS, dir);
    updateSpec(spec.id, { status: "approved" }, dir);
    const approved = getSpec(spec.id, dir);
    assert.equal(approved!.status, "approved");

    updateSpec(spec.id, { status: "executing" }, dir);
    const executing = getSpec(spec.id, dir);
    assert.equal(executing!.status, "executing");

    updateSpec(spec.id, { status: "completed", output: "done" }, dir);
    const completed = getSpec(spec.id, dir);
    assert.equal(completed!.status, "completed");
    assert.equal(completed!.output, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec can store error on failure", () => {
  const dir = tmpDir();
  try {
    const spec = createSpec("Goal", SAMPLE_STEPS, dir);
    updateSpec(spec.id, { status: "failed", error: "build broke" }, dir);
    const failed = getSpec(spec.id, dir);
    assert.equal(failed!.status, "failed");
    assert.equal(failed!.error, "build broke");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec preserves steps after update", () => {
  const dir = tmpDir();
  try {
    const spec = createSpec("Goal", SAMPLE_STEPS, dir);
    updateSpec(spec.id, { status: "approved" }, dir);
    const updated = getSpec(spec.id, dir);
    assert.equal(updated!.steps.length, 3);
    assert.equal(updated!.steps[0]!.goal, "Read the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Structured spec cards ──────────────────────────────────────────────────

const CARD = [
  "PROJECT: payments-api",
  "GOAL: add idempotency keys to the charge endpoint",
  "SCOPE:",
  "  in: src/routes/charge.ts, src/lib/idempotency.ts",
  "  out: billing dashboard, refunds",
  "RULES:",
  "  - no new runtime dependencies",
  "  - keep all existing tests green",
  "OUTPUT: a passing build with a new idempotency test",
  "ON CONFLICT: abort and report",
].join("\n");

test("parseStructuredSpec extracts goal and all structured fields", () => {
  const parsed = parseStructuredSpec(CARD);
  assert.equal(parsed.goal, "add idempotency keys to the charge endpoint");
  assert.equal(parsed.project, "payments-api");
  assert.deepEqual(parsed.scope, {
    in: ["src/routes/charge.ts", "src/lib/idempotency.ts"],
    out: ["billing dashboard", "refunds"],
  });
  assert.deepEqual(parsed.rules, ["no new runtime dependencies", "keep all existing tests green"]);
  assert.equal(parsed.outputFormat, "a passing build with a new idempotency test");
  assert.equal(parsed.onConflict, "abort and report");
});

test("parseStructuredSpec falls back to whole input when no GOAL header", () => {
  const parsed = parseStructuredSpec("just fix the bug");
  assert.equal(parsed.goal, "just fix the bug");
  assert.equal(parsed.project, undefined);
  assert.equal(parsed.scope, undefined);
  assert.equal(parsed.rules, undefined);
});

test("createSpec stores structured card fields", () => {
  const dir = tmpDir();
  try {
    const extra: SpecCardFields = {
      project: "p",
      scope: { in: ["a"], out: ["b"] },
      rules: ["r1"],
      outputFormat: "ok",
      onConflict: "abort",
      corrections: ["corr-1"],
      maxCostUsd: 2.5,
      maxFilesChanged: 10,
    };
    const spec = createSpec("g", SAMPLE_STEPS, dir, extra);
    const fetched = getSpec(spec.id, dir);
    assert.equal(fetched!.project, "p");
    assert.deepEqual(fetched!.scope, { in: ["a"], out: ["b"] });
    assert.deepEqual(fetched!.rules, ["r1"]);
    assert.equal(fetched!.outputFormat, "ok");
    assert.equal(fetched!.onConflict, "abort");
    assert.deepEqual(fetched!.corrections, ["corr-1"]);
    assert.equal(fetched!.maxCostUsd, 2.5);
    assert.equal(fetched!.maxFilesChanged, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createSpec omits undefined card fields (no key: undefined leaks)", () => {
  const dir = tmpDir();
  try {
    const spec = createSpec("g", SAMPLE_STEPS, dir, { project: "only-project" });
    const fetched = getSpec(spec.id, dir);
    assert.equal(fetched!.project, "only-project");
    assert.equal("scope" in fetched!, false);
    assert.equal("maxCostUsd" in fetched!, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateStructuredSpec parses card, decomposes goal, attaches fields", () => {
  const dir = tmpDir();
  try {
    const spec = generateStructuredSpec(CARD, dir);
    assert.equal(spec.goal, "add idempotency keys to the charge endpoint");
    assert.equal(spec.project, "payments-api");
    assert.ok(spec.steps.length > 0);
    assert.deepEqual(spec.scope, {
      in: ["src/routes/charge.ts", "src/lib/idempotency.ts"],
      out: ["billing dashboard", "refunds"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateStructuredSpec merges non-text overrides (corrections/caps)", () => {
  const dir = tmpDir();
  try {
    const spec = generateStructuredSpec(CARD, dir, {
      corrections: ["corr-9"],
      maxCostUsd: 1.0,
      maxFilesChanged: 5,
    });
    assert.deepEqual(spec.corrections, ["corr-9"]);
    assert.equal(spec.maxCostUsd, 1.0);
    assert.equal(spec.maxFilesChanged, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateSpec (plain) attaches overrides without parsing sections", () => {
  const dir = tmpDir();
  try {
    const spec = generateSpec("GOAL: not parsed when plain", dir, { maxFilesChanged: 3 });
    // plain path does NOT strip the "GOAL:" prefix — it is treated as a literal goal
    assert.equal(spec.goal, "GOAL: not parsed when plain");
    assert.equal(spec.maxFilesChanged, 3);
    assert.equal(spec.project, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
