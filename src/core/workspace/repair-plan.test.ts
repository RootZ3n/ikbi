import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { labTempDir as tmpdir } from "../temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import type { WorkspaceHandle } from "./contract.js";
import { sha256Bytes, type FileState } from "./file-state.js";
import {
  applyRepairPlan,
  createRepairPlan,
  createRepairPlanFromSnapshot,
  importRepairPlan,
  repairFailure,
  RepairMutationError,
  restoreRepairMutation,
  restoreRepairMutations,
} from "./repair-plan.js";
import { createWorkspaceMutationSession, type MutationSessionBinding } from "./mutation-session.js";

interface Fixture {
  readonly root: string;
  readonly targetRepo: string;
  readonly workspace: WorkspaceHandle;
}

async function fixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `ikbi-repair-${name}-`));
  const targetRepo = await mkdtemp(join(tmpdir(), `ikbi-repair-target-${name}-`));
  return {
    root,
    targetRepo,
    workspace: {
      id: `repair-workspace-${name}`,
      targetRepo,
      baseBranch: "main",
      baseRef: "base",
      scratchBranch: `ikbi/ws/repair-${name}`,
      path: root,
      identity: { agentId: "repair-test", functionalRole: "fixer", trustTier: "verified" },
      state: "allocated",
      createdAt: Date.now(),
    },
  };
}

async function dispose(f: Fixture): Promise<void> {
  await rm(f.root, { recursive: true, force: true });
  await rm(f.targetRepo, { recursive: true, force: true });
}

function binding(f: Fixture, generationId = "generation-1", assertActive?: () => void): MutationSessionBinding {
  return {
    sessionId: `repair-session-${generationId}`,
    workspaceId: f.workspace.id,
    candidateId: "candidate-repair",
    generationId,
    actor: "model",
    cause: "model",
    attemptId: "attempt-repair",
    role: "fixer",
    validatedIdentity: "repair-test",
    ...(assertActive === undefined ? {} : { assertActive }),
  };
}

function stateFor(bytes: Uint8Array): FileState {
  return {
    kind: bytes.byteLength === 0 ? "empty" : "regular",
    byteLength: bytes.byteLength,
    sha256: sha256Bytes(bytes),
    symlinkTarget: null,
    mode: null,
  };
}

test("an exact repair plan replaces observed bytes and returns typed before/after proof", async () => {
  const f = await fixture("replace");
  try {
    await writeFile(join(f.root, "a.txt"), Buffer.from("before\n"));
    const session = await createWorkspaceMutationSession(f.workspace, binding(f));
    const observed = await session.observeBytes("a.txt");
    const plan = createRepairPlan({
      session,
      producingAttemptId: "attempt-repair",
      producingRole: "fixer",
      files: [{ path: "a.txt", operation: "replace", afterBytes: Buffer.from("after\n") }],
    });
    const applied = await applyRepairPlan(session, plan);
    assert.equal(applied.mutationApplied, true);
    assert.equal(applied.mutations[0]!.mutation.operationId, plan.operationId);
    assert.equal(applied.mutations[0]!.mutation.before.sha256, observed.observation.sha256);
    assert.equal(applied.mutations[0]!.mutation.after.sha256, sha256Bytes(Buffer.from("after\n")));
    assert.deepEqual(await readFile(join(f.root, "a.txt")), Buffer.from("after\n"));
    assert.equal(session.hasObservation("a.txt"), false);
  } finally {
    await dispose(f);
  }
});

test("a stale repair plan refuses unrelated drift and leaves the file untouched", async () => {
  const f = await fixture("stale");
  try {
    await writeFile(join(f.root, "a.txt"), Buffer.from("anchor\nother-before\n"));
    const session = await createWorkspaceMutationSession(f.workspace, binding(f));
    await session.observeBytes("a.txt");
    const plan = createRepairPlan({
      session,
      producingAttemptId: "attempt-repair",
      producingRole: "fixer",
      files: [{ path: "a.txt", operation: "replace", afterBytes: Buffer.from("changed\nother-before\n") }],
    });
    await writeFile(join(f.root, "a.txt"), Buffer.from("anchor\nother-after\n"));
    await assert.rejects(applyRepairPlan(session, plan), (error: unknown) => {
      assert.ok(error instanceof RepairMutationError);
      assert.equal(error.code, "STALE_REPAIR");
      return true;
    });
    assert.deepEqual(await readFile(join(f.root, "a.txt")), Buffer.from("anchor\nother-after\n"));
  } finally {
    await dispose(f);
  }
});

test("a stale member prevents every file in a repair batch from changing", async () => {
  const f = await fixture("batch");
  try {
    await writeFile(join(f.root, "one.txt"), "one-before\n");
    await writeFile(join(f.root, "two.txt"), "two-before\n");
    const session = await createWorkspaceMutationSession(f.workspace, binding(f));
    await session.observeBytes("one.txt");
    await session.observeBytes("two.txt");
    const plan = createRepairPlan({
      session,
      producingAttemptId: "attempt-repair",
      producingRole: "consult",
      files: [
        { path: "one.txt", operation: "replace", afterBytes: Buffer.from("one-after\n") },
        { path: "two.txt", operation: "replace", afterBytes: Buffer.from("two-after\n") },
      ],
    });
    await writeFile(join(f.root, "two.txt"), "two-human-edit\n");
    await assert.rejects(applyRepairPlan(session, plan), (error: unknown) => {
      assert.ok(error instanceof RepairMutationError);
      assert.equal(error.code, "STALE_REPAIR");
      return true;
    });
    assert.deepEqual(await readFile(join(f.root, "one.txt"), "utf8"), "one-before\n");
    assert.deepEqual(await readFile(join(f.root, "two.txt"), "utf8"), "two-human-edit\n");
  } finally {
    await dispose(f);
  }
});

test("repair restore requires the exact mutation after-state", async () => {
  const f = await fixture("restore");
  try {
    await writeFile(join(f.root, "a.txt"), "before\n");
    const session = await createWorkspaceMutationSession(f.workspace, binding(f));
    await session.observeBytes("a.txt");
    const plan = createRepairPlan({
      session,
      producingAttemptId: "attempt-repair",
      producingRole: "fixer",
      files: [{ path: "a.txt", operation: "replace", afterBytes: Buffer.from("repair\n") }],
    });
    const applied = await applyRepairPlan(session, plan);
    const restored = await restoreRepairMutation(session, applied.mutations[0]!);
    assert.equal(restored.mutation.after.sha256, sha256Bytes(Buffer.from("before\n")));
    assert.deepEqual(await readFile(join(f.root, "a.txt"), "utf8"), "before\n");

    await session.observeBytes("a.txt");
    const appliedAgain = await session.replaceBytes("a.txt", Buffer.from("repair-again\n"));
    await writeFile(join(f.root, "a.txt"), "newer-human-edit\n");
    await assert.rejects(restoreRepairMutation(session, appliedAgain), (error: unknown) => {
      assert.ok(error instanceof RepairMutationError);
      assert.equal(error.code, "REPAIR_RESTORE_STALE");
      return true;
    });
    assert.deepEqual(await readFile(join(f.root, "a.txt"), "utf8"), "newer-human-edit\n");
  } finally {
    await dispose(f);
  }
});

test("repair restore recreates a file after an exact delete", async () => {
  const f = await fixture("restore-delete");
  try {
    await writeFile(join(f.root, "a.txt"), "before-delete\n");
    const session = await createWorkspaceMutationSession(f.workspace, binding(f));
    await session.observeBytes("a.txt");
    const plan = createRepairPlan({
      session,
      producingAttemptId: "attempt-repair",
      producingRole: "rescue",
      files: [{ path: "a.txt", operation: "delete", afterBytes: null }],
    });
    const applied = await applyRepairPlan(session, plan);
    assert.equal(applied.mutations[0]!.mutation.after.kind, "missing");
    await restoreRepairMutation(session, applied.mutations[0]!);
    assert.deepEqual(await readFile(join(f.root, "a.txt"), "utf8"), "before-delete\n");
  } finally {
    await dispose(f);
  }
});

test("multi-file repair restore validates every after-state before restoring any file", async () => {
  const f = await fixture("restore-batch");
  try {
    await writeFile(join(f.root, "one.txt"), "one-before\n");
    await writeFile(join(f.root, "two.txt"), "two-before\n");
    const session = await createWorkspaceMutationSession(f.workspace, binding(f));
    await session.observeBytes("one.txt");
    await session.observeBytes("two.txt");
    const plan = createRepairPlan({
      session,
      producingAttemptId: "attempt-repair",
      producingRole: "fixer",
      files: [
        { path: "one.txt", operation: "replace", afterBytes: Buffer.from("one-repair\n") },
        { path: "two.txt", operation: "replace", afterBytes: Buffer.from("two-repair\n") },
      ],
    });
    const applied = await applyRepairPlan(session, plan);
    await writeFile(join(f.root, "two.txt"), "two-human\n");
    await assert.rejects(restoreRepairMutations(session, [...applied.mutations].reverse()), (error: unknown) => {
      assert.ok(error instanceof RepairMutationError);
      assert.equal(error.code, "REPAIR_RESTORE_STALE");
      return true;
    });
    assert.equal(await readFile(join(f.root, "one.txt"), "utf8"), "one-repair\n");
    assert.equal(await readFile(join(f.root, "two.txt"), "utf8"), "two-human\n");
  } finally {
    await dispose(f);
  }
});

test("source-bound tournament import requires an unchanged destination base", async () => {
  const source = await fixture("source");
  const destination = await fixture("destination");
  try {
    const before = Buffer.from("base\n");
    const after = Buffer.from("winner\n");
    await writeFile(join(destination.root, "a.txt"), before);
    const sourcePlan = createRepairPlanFromSnapshot({
      sourceWorkspaceId: source.workspace.id,
      sourceCandidateId: "winner-candidate",
      sourceGenerationId: "winner-generation",
      producingAttemptId: "winner-attempt",
      producingRole: "tournament-replay-source",
      files: [{
        path: "a.txt",
        operation: "replace",
        before: stateFor(before),
        beforeBytes: before,
        afterBytes: after,
      }],
    });
    const session = await createWorkspaceMutationSession(destination.workspace, binding(destination, "target-generation"));
    const imported = await importRepairPlan(session, sourcePlan, { targetGenerationId: "target-generation" });
    assert.equal(imported.targetGenerationId, "target-generation");
    assert.deepEqual(await readFile(join(destination.root, "a.txt"), "utf8"), "winner\n");

    await writeFile(join(destination.root, "a.txt"), "later-edit\n");
    const staleDestination = await createWorkspaceMutationSession(destination.workspace, binding(destination, "target-generation-2"));
    await assert.rejects(importRepairPlan(staleDestination, sourcePlan, { targetGenerationId: "target-generation-2" }), (error: unknown) => {
      assert.ok(error instanceof RepairMutationError);
      assert.equal(error.code, "TOURNAMENT_BASE_DIVERGED");
      return true;
    });
    assert.deepEqual(await readFile(join(destination.root, "a.txt"), "utf8"), "later-edit\n");
  } finally {
    await dispose(source);
    await dispose(destination);
  }
});

test("a revoked repair generation fails closed before writing", async () => {
  const f = await fixture("revoked");
  try {
    await writeFile(join(f.root, "a.txt"), "before\n");
    let active = true;
    const session = await createWorkspaceMutationSession(f.workspace, binding(f, "revoked-generation", () => {
      if (!active) throw new Error("generation revoked");
    }));
    await session.observeBytes("a.txt");
    const plan = createRepairPlan({
      session,
      producingAttemptId: "attempt-repair",
      producingRole: "rescue",
      files: [{ path: "a.txt", operation: "replace", afterBytes: Buffer.from("after\n") }],
    });
    active = false;
    await assert.rejects(applyRepairPlan(session, plan), (error: unknown) => {
      assert.ok(error instanceof RepairMutationError);
      assert.equal(error.code, "REPAIR_GENERATION_REVOKED");
      return true;
    });
    assert.deepEqual(await readFile(join(f.root, "a.txt"), "utf8"), "before\n");
    const projected = repairFailure(new RepairMutationError("REPAIR_GENERATION_REVOKED", "generation revoked"), { session, plan });
    assert.equal(projected.mutationApplied, false);
    assert.equal(projected.partialMutation, false);
  } finally {
    await dispose(f);
  }
});
