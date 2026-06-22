/**
 * Tests for job-cards module — store CRUD, builtins, runner, guardrails.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { JobCard } from "./contract.js";
import { type RunnerDeps } from "./runner.js";
import { listCards, getCard, createCard, updateCard, deleteCard, listRuns, createRun, updateRun } from "./store.js";
import { BUILTINS, getBuiltin } from "./builtins.js";
import { runCard } from "./runner.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "job-cards-test-"));
}

// ── Builtins ─────────────────────────────────────────────────────────────

test("BUILTINS contains 8 cards", () => {
  assert.equal(BUILTINS.length, 8);
});

test("all builtins have required fields", () => {
  for (const card of BUILTINS) {
    assert.ok(card.id.startsWith("builtin-"), `id should start with builtin-: ${card.id}`);
    assert.ok(card.name.length > 0, "name should be non-empty");
    assert.ok(card.goalTemplate.length > 0, "goalTemplate should be non-empty");
    assert.ok(["read-only", "write-gated", "write-auto"].includes(card.accessPolicy));
    assert.ok(["required", "optional", "skip"].includes(card.verification));
    assert.ok(["on-failure", "never", "always"].includes(card.rollback));
    assert.ok(["once", "loop"].includes(card.schedule));
    assert.ok(card.guardrails.maxFilesChanged >= 0);
  }
});

test("getBuiltin returns correct card", () => {
  const card = getBuiltin("builtin-repo-gardener");
  assert.ok(card);
  assert.equal(card!.name, "Repo Gardener");
  assert.equal(card!.accessPolicy, "write-gated");
});

test("getBuiltin returns undefined for unknown id", () => {
  assert.equal(getBuiltin("builtin-nonexistent"), undefined);
});

test("read-only builtins have maxFilesChanged = 0", () => {
  const readOnly = BUILTINS.filter((c) => c.accessPolicy === "read-only");
  assert.ok(readOnly.length > 0);
  for (const card of readOnly) {
    assert.equal(card.guardrails.maxFilesChanged, 0);
  }
});

test("write-gated builtins have requireCleanWorktree = true", () => {
  const writeGated = BUILTINS.filter((c) => c.accessPolicy === "write-gated");
  assert.ok(writeGated.length > 0);
  for (const card of writeGated) {
    assert.equal(card.guardrails.requireCleanWorktree, true);
  }
});

// ── Store CRUD ───────────────────────────────────────────────────────────

test("listCards returns empty array for new store", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(listCards(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createCard and getCard round-trip", () => {
  const dir = tmpDir();
  try {
    const card = createCard({
      name: "Test Card",
      description: "A test",
      goalTemplate: "Do something",
      accessPolicy: "read-only",
      guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
      verification: "skip",
      rollback: "never",
      schedule: "once",
      minTrustTier: "provisional",
    }, dir);
    assert.ok(card.id);
    assert.equal(card.name, "Test Card");
    assert.ok(card.createdAt);

    const fetched = getCard(card.id, dir);
    assert.deepEqual(fetched, card);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCards returns created cards", () => {
  const dir = tmpDir();
  try {
    createCard({
      name: "Card A",
      description: "",
      goalTemplate: "goal A",
      accessPolicy: "read-only",
      guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
      verification: "skip",
      rollback: "never",
      schedule: "once",
      minTrustTier: "provisional",
    }, dir);
    createCard({
      name: "Card B",
      description: "",
      goalTemplate: "goal B",
      accessPolicy: "read-only",
      guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
      verification: "skip",
      rollback: "never",
      schedule: "once",
      minTrustTier: "provisional",
    }, dir);

    const all = listCards(dir);
    assert.equal(all.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateCard modifies fields", () => {
  const dir = tmpDir();
  try {
    const card = createCard({
      name: "Original",
      description: "desc",
      goalTemplate: "goal",
      accessPolicy: "read-only",
      guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
      verification: "skip",
      rollback: "never",
      schedule: "once",
      minTrustTier: "provisional",
    }, dir);

    const updated = updateCard(card.id, { name: "Updated" }, dir);
    assert.ok(updated);
    assert.equal(updated!.name, "Updated");
    assert.equal(updated!.goalTemplate, "goal");
    assert.ok(updated!.updatedAt >= card.updatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateCard returns undefined for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(updateCard("nonexistent", { name: "X" }, dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteCard removes the card", () => {
  const dir = tmpDir();
  try {
    const card = createCard({
      name: "To Delete",
      description: "",
      goalTemplate: "goal",
      accessPolicy: "read-only",
      guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
      verification: "skip",
      rollback: "never",
      schedule: "once",
      minTrustTier: "provisional",
    }, dir);

    assert.equal(deleteCard(card.id, dir), true);
    assert.equal(getCard(card.id, dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteCard returns false for missing id", () => {
  const dir = tmpDir();
  try {
    assert.equal(deleteCard("nonexistent", dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Run history ──────────────────────────────────────────────────────────

test("createRun and listRuns round-trip", () => {
  const dir = tmpDir();
  try {
    const run = createRun("card-1", dir);
    assert.ok(run.id);
    assert.equal(run.cardId, "card-1");
    assert.equal(run.status, "pending");

    const runs = listRuns("card-1", dir);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.id, run.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateRun modifies status", () => {
  const dir = tmpDir();
  try {
    const run = createRun("card-1", dir);
    const updated = updateRun("card-1", run.id, { status: "running" }, dir);
    assert.ok(updated);
    assert.equal(updated!.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateRun returns undefined for missing run", () => {
  const dir = tmpDir();
  try {
    assert.equal(updateRun("card-1", "nonexistent", { status: "failed" }, dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns returns newest first", () => {
  const dir = tmpDir();
  try {
    createRun("card-1", dir);
    // Small delay to ensure different timestamps
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const run2 = createRun("card-1", dir);
    const runs = listRuns("card-1", dir);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.id, run2.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns returns empty for card with no runs", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(listRuns("nonexistent", dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Runner ───────────────────────────────────────────────────────────────

function mockDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    executeGoal: async () => ({ output: "done", filesChanged: [], success: true }),
    getChangedFiles: () => [],
    isWorktreeClean: () => true,
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function testCard(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: "test-card",
    name: "Test",
    description: "",
    goalTemplate: "Do something",
    accessPolicy: "read-only",
    guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
    verification: "skip",
    rollback: "never",
    schedule: "once",
    minTrustTier: "provisional",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("runner executes successfully with read-only card", async () => {
  const dir = tmpDir();
  try {
    const result = await runCard(testCard(), {}, mockDeps(), dir);
    assert.equal(result.run.status, "passed");
    assert.equal(result.verificationPassed, true);
    assert.equal(result.output, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner fails when worktree guardrail violated", async () => {
  const dir = tmpDir();
  try {
    const card = testCard({
      guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: true },
    });
    const deps = mockDeps({ isWorktreeClean: () => false });
    const result = await runCard(card, {}, deps, dir);
    assert.equal(result.run.status, "failed");
    assert.match(result.run.error!, /worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner fails when max files changed exceeded", async () => {
  const dir = tmpDir();
  try {
    const card = testCard({
      accessPolicy: "write-gated",
      guardrails: { maxFilesChanged: 3, protectedPaths: [], requireCleanWorktree: false },
    });
    const deps = mockDeps({
      getChangedFiles: () => ["a.ts", "b.ts", "c.ts", "d.ts"],
    });
    const result = await runCard(card, {}, deps, dir);
    assert.equal(result.run.status, "failed");
    assert.match(result.run.error!, /Guardrail violation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner fails when protected path is modified", async () => {
  const dir = tmpDir();
  try {
    const card = testCard({
      accessPolicy: "write-gated",
      guardrails: { maxFilesChanged: 10, protectedPaths: [".env"], requireCleanWorktree: false },
    });
    const deps = mockDeps({
      getChangedFiles: () => [".env"],
    });
    const result = await runCard(card, {}, deps, dir);
    assert.equal(result.run.status, "failed");
    assert.match(result.run.error!, /protected path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner substitutes variables in goal template", async () => {
  const dir = tmpDir();
  try {
    let capturedGoal = "";
    const card = testCard({ goalTemplate: "Fix {{module}} in {{file}}" });
    const deps = mockDeps({
      executeGoal: async (goal: string) => {
        capturedGoal = goal;
        return { output: "ok", filesChanged: [], success: true };
      },
    });
    await runCard(card, { module: "auth", file: "src/auth.ts" }, deps, dir);
    assert.equal(capturedGoal, "Fix auth in src/auth.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner marks run as failed when executeGoal throws", async () => {
  const dir = tmpDir();
  try {
    const deps = mockDeps({
      executeGoal: async () => { throw new Error("boom"); },
    });
    const result = await runCard(testCard(), {}, deps, dir);
    assert.equal(result.run.status, "failed");
    assert.match(result.run.error!, /boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner marks run as failed when executeGoal returns success=false", async () => {
  const dir = tmpDir();
  try {
    const deps = mockDeps({
      executeGoal: async () => ({ output: "partial", filesChanged: [], success: false }),
    });
    const result = await runCard(testCard(), {}, deps, dir);
    assert.equal(result.run.status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner with verification=required and success=true passes verification", async () => {
  const dir = tmpDir();
  try {
    const card = testCard({ verification: "required" });
    const result = await runCard(card, {}, mockDeps(), dir);
    assert.equal(result.verificationPassed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner with verification=required and success=false fails verification", async () => {
  const dir = tmpDir();
  try {
    const card = testCard({ verification: "required" });
    const deps = mockDeps({
      executeGoal: async () => ({ output: "fail", filesChanged: [], success: false }),
    });
    const result = await runCard(card, {}, deps, dir);
    assert.equal(result.verificationPassed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
