import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { labTempDir as tmpdir } from "../temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import type { WorkspaceHandle } from "./contract.js";
import { sha256Bytes } from "./file-state.js";
import { MutationError, STALE_MUTATION } from "./mutation.js";
import { createWorkspaceMutationSession, type MutationSessionBinding } from "./mutation-session.js";

async function workspace(): Promise<{ readonly root: string; readonly target: string; readonly handle: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), "ikbi-session-ws-"));
  const target = await mkdtemp(join(tmpdir(), "ikbi-session-target-"));
  const handle: WorkspaceHandle = {
    id: `session-${randomBytes(6).toString("hex")}`,
    targetRepo: target,
    baseBranch: "main",
    baseRef: "test",
    scratchBranch: "ikbi/ws/test",
    path: root,
    identity: { agentId: "session-test", functionalRole: "builder", trustTier: "verified" },
    state: "allocated",
    createdAt: Date.now(),
  };
  return { root, target, handle };
}

async function cleanup(f: { root: string; target: string }): Promise<void> {
  await rm(f.root, { recursive: true, force: true });
  await rm(f.target, { recursive: true, force: true });
}

function binding(handle: WorkspaceHandle, sessionId: string, generationId = "generation-1"): MutationSessionBinding {
  return {
    sessionId,
    workspaceId: handle.id,
    candidateId: "candidate-1",
    generationId,
    actor: "model",
    cause: "model",
    requestId: "request-1",
    attemptId: "attempt-1",
    role: "builder",
    validatedIdentity: "session-test",
  };
}

function assertCode(error: unknown, code: string): void {
  assert.ok(error instanceof MutationError);
  assert.equal(error.code, code);
}

test("session-bound create, replace, delete, and observation consumption", async () => {
  const f = await workspace();
  try {
    const session = await createWorkspaceMutationSession(f.handle, binding(f.handle, "session-create"));
    await writeFile(join(f.root, "empty.txt"), Buffer.alloc(0));
    const empty = await session.observeBytes("empty.txt");
    assert.equal(empty.observation.kind, "empty");
    assert.equal(empty.observation.byteLength, 0);
    assert.equal(empty.observation.sha256, sha256Bytes(Buffer.alloc(0)));
    const emptyReplacement = await session.replaceText("empty.txt", () => "now non-empty");
    assert.equal(emptyReplacement.mutation.before.kind, "empty");
    assert.equal(emptyReplacement.mutation.before.byteLength, 0);

    const missing = await session.observeBytes("new.txt");
    assert.equal(missing.observation.kind, "missing");
    const created = await session.createBytes("new.txt", Buffer.from("first\n"));
    assert.equal(created.mutation.before.kind, "missing");
    assert.equal(created.mutation.after.sha256, sha256Bytes(Buffer.from("first\n")));
    assert.equal(session.hasObservation("new.txt"), false);
    assert.deepEqual(await readFile(join(f.root, "new.txt")), Buffer.from("first\n"));

    await session.readText("new.txt", 1_000);
    const replaced = await session.replaceText("new.txt", (text) => text.replace("first", "second"));
    assert.equal(replaced.mutation.before.sha256, sha256Bytes(Buffer.from("first\n")));
    assert.equal(replaced.mutation.after.sha256, sha256Bytes(Buffer.from("second\n")));
    assert.equal(session.hasObservation("new.txt"), false);
    assert.deepEqual(await readFile(join(f.root, "new.txt")), Buffer.from("second\n"));

    await session.observeBytes("new.txt");
    const deleted = await session.deleteFile("new.txt");
    assert.equal(deleted.mutation.kind, "delete");
    assert.equal(deleted.mutation.after.kind, "missing");
    assert.equal(session.hasObservation("new.txt"), false);
  } finally {
    await cleanup(f);
  }
});

test("truncated reads and summaries do not authorize whole-file replacement", async () => {
  const f = await workspace();
  try {
    await writeFile(join(f.root, "large.txt"), "0123456789\n");
    const session = await createWorkspaceMutationSession(f.handle, binding(f.handle, "session-truncated"));
    const read = await session.readText("large.txt", 3);
    assert.equal(read.complete, false);
    assert.equal(session.hasObservation("large.txt"), false);
    await assert.rejects(session.writeText("large.txt", "clobber\n"), (error: unknown) => {
      assertCode(error, "MUTATION_VALIDATION");
      return true;
    });
    assert.deepEqual(await readFile(join(f.root, "large.txt")), Buffer.from("0123456789\n"));
  } finally {
    await cleanup(f);
  }
});

test("unrelated divergence is stale even when an intended region still matches", async () => {
  const f = await workspace();
  try {
    await writeFile(join(f.root, "stale.txt"), "anchor\nother-before\n");
    const session = await createWorkspaceMutationSession(f.handle, binding(f.handle, "session-stale"));
    await session.readText("stale.txt", 1_000);
    await writeFile(join(f.root, "stale.txt"), "anchor\nother-after\n");
    await assert.rejects(
      session.replaceText("stale.txt", (text) => text.replace("anchor", "changed")),
      (error: unknown) => {
        assertCode(error, STALE_MUTATION);
        return true;
      },
    );
    assert.deepEqual(await readFile(join(f.root, "stale.txt")), Buffer.from("anchor\nother-after\n"));
  } finally {
    await cleanup(f);
  }
});

test("multi-file session edits validate all observations before any file changes", async () => {
  const f = await workspace();
  try {
    await writeFile(join(f.root, "one.txt"), "one-before\n");
    await writeFile(join(f.root, "two.txt"), "two-before\n");
    const session = await createWorkspaceMutationSession(f.handle, binding(f.handle, "session-batch"));
    await session.readText("one.txt", 1_000);
    await session.readText("two.txt", 1_000);
    await writeFile(join(f.root, "two.txt"), "two-diverged\n");
    await assert.rejects(
      session.applyTextBatch([
        { path: "one.txt", transform: (text) => `${text}one-after\n` },
        { path: "two.txt", transform: (text) => `${text}two-after\n` },
      ]),
      (error: unknown) => {
        assertCode(error, STALE_MUTATION);
        return true;
      },
    );
    assert.deepEqual(await readFile(join(f.root, "one.txt")), Buffer.from("one-before\n"));
    assert.deepEqual(await readFile(join(f.root, "two.txt")), Buffer.from("two-diverged\n"));
  } finally {
    await cleanup(f);
  }
});

test("two sessions observing the same bytes allow exactly one concurrent replacement", async () => {
  const f = await workspace();
  try {
    await writeFile(join(f.root, "race.txt"), "base\n");
    const first = await createWorkspaceMutationSession(f.handle, binding(f.handle, "session-race-one"));
    const second = await createWorkspaceMutationSession(f.handle, binding(f.handle, "session-race-two"));
    await Promise.all([first.readText("race.txt", 1_000), second.readText("race.txt", 1_000)]);
    const results = await Promise.allSettled([
      first.replaceText("race.txt", () => "one\n"),
      second.replaceText("race.txt", () => "two\n"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected);
    assertCode(rejected.reason, STALE_MUTATION);
    const final = await readFile(join(f.root, "race.txt"), "utf8");
    assert.ok(final === "one\n" || final === "two\n");
  } finally {
    await cleanup(f);
  }
});

test("session identity cannot be constructed for another workspace or generation", async () => {
  const first = await workspace();
  const second = await workspace();
  try {
    await assert.rejects(
      createWorkspaceMutationSession(second.handle, binding(first.handle, "wrong-workspace")),
      (error: unknown) => {
        assertCode(error, "MUTATION_VALIDATION");
        return true;
      },
    );
    await writeFile(join(first.root, "generation.txt"), "before\n");
    const session = await createWorkspaceMutationSession(first.handle, binding(first.handle, "generation-one", "generation-one"));
    await session.readText("generation.txt", 1_000);
    const otherGeneration = await createWorkspaceMutationSession(first.handle, binding(first.handle, "generation-two", "generation-two"));
    await assert.rejects(otherGeneration.replaceText("generation.txt", () => "wrong\n"), (error: unknown) => {
      assertCode(error, "MUTATION_VALIDATION");
      return true;
    });
    assert.deepEqual(await readFile(join(first.root, "generation.txt")), Buffer.from("before\n"));
  } finally {
    await cleanup(first);
    await cleanup(second);
  }
});
