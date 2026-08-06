import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ToolCall } from "../../core/provider/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { sha256Bytes } from "../../core/workspace/file-state.js";
import { createWorkspaceMutationSession, type MutationSessionLike } from "../../core/workspace/mutation-session.js";
import { executeTool, type ToolExecutorDeps } from "./tool-executor.js";

async function fixture(): Promise<{ readonly root: string; readonly target: string; readonly handle: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), "ikbi-executor-ws-"));
  const target = await mkdtemp(join(tmpdir(), "ikbi-executor-target-"));
  return {
    root,
    target,
    handle: {
      id: `executor-${randomBytes(6).toString("hex")}`,
      targetRepo: target,
      baseBranch: "main",
      baseRef: "test",
      scratchBranch: "ikbi/ws/executor",
      path: root,
      identity: { agentId: "executor-test", functionalRole: "builder", trustTier: "verified" },
      state: "allocated",
      createdAt: Date.now(),
    },
  };
}

async function cleanup(f: { root: string; target: string }): Promise<void> {
  await rm(f.root, { recursive: true, force: true });
  await rm(f.target, { recursive: true, force: true });
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${name}-${randomBytes(4).toString("hex")}`, name, arguments: JSON.stringify(args) } as ToolCall;
}

async function session(f: { handle: WorkspaceHandle }, id: string, generationId = "generation-1"): Promise<MutationSessionLike> {
  return createWorkspaceMutationSession(f.handle, {
    sessionId: id,
    workspaceId: f.handle.id,
    candidateId: "candidate-1",
    generationId,
    actor: "model",
    cause: "model",
    requestId: "request-1",
    attemptId: "attempt-1",
    role: "builder",
    validatedIdentity: "executor-test",
  });
}

function deps(root: string, mutationSession: MutationSessionLike): ToolExecutorDeps {
  return { worktreeReal: root, agentId: "executor-test", mutationSession };
}

test("bound executor uses a complete read for an exact write and returns disk proofs", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "edit.txt"), "before\n");
    const s = await session(f, "executor-write");
    const read = await executeTool(deps(f.root, s), call("read_file", { path: "edit.txt" }));
    assert.equal(read.ok, true);
    assert.equal(read.observed, true);
    assert.equal(read.completeObservation, true);
    const result = await executeTool(deps(f.root, s), call("write_file", { path: "edit.txt", content: "after\n" }));
    assert.equal(result.ok, true);
    assert.equal(result.wrote, "edit.txt");
    assert.equal(result.before, "before\n");
    assert.equal(result.after, "after\n");
    assert.equal(result.mutationError, undefined);
    assert.equal(sha256Bytes(Buffer.from(result.after ?? "")), sha256Bytes(await readFile(join(f.root, "edit.txt"))));
  } finally {
    await cleanup(f);
  }
});

test("bound executor refuses existing-file writes without observation and reports stable stale errors", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "stale.txt");
    await writeFile(path, "anchor\nunchanged-region\n");
    const s = await session(f, "executor-stale");
    const noObservation = await executeTool(deps(f.root, s), call("write_file", { path: "stale.txt", content: "blind\n" }));
    assert.equal(noObservation.ok, false);
    assert.equal(noObservation.mutationError?.code, "MUTATION_VALIDATION");
    assert.match(noObservation.output, /mutationApplied.*false/);
    assert.deepEqual(await readFile(path), Buffer.from("anchor\nunchanged-region\n"));

    await executeTool(deps(f.root, s), call("read_file", { path: "stale.txt" }));
    await writeFile(path, "anchor\nchanged-unrelated-region\n");
    const stale = await executeTool(deps(f.root, s), call("patch", { path: "stale.txt", old_string: "anchor", new_string: "changed" }));
    assert.equal(stale.ok, false);
    assert.equal(stale.mutationError?.code, "STALE_MUTATION");
    assert.equal(stale.mutationError?.mutationApplied, false);
    assert.match(stale.output, /Re-read the file and regenerate the edit/);
    assert.deepEqual(await readFile(path), Buffer.from("anchor\nchanged-unrelated-region\n"));
  } finally {
    await cleanup(f);
  }
});

test("truncated and binary reads cannot authorize textual mutation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "large.txt"), "0123456789\n");
    await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 255, 1, 128]));
    const s = await session(f, "executor-read-shapes");
    // The executor's production cap is large, so exercise the session cap directly for the
    // truncation authority and use the executor for the binary path.
    const truncated = await s.readText("large.txt", 3);
    assert.equal(truncated.complete, false);
    const noAuthority = await executeTool(deps(f.root, s), call("write_file", { path: "large.txt", content: "nope\n" }));
    assert.equal(noAuthority.ok, false);
    assert.equal(noAuthority.mutationError?.code, "MUTATION_VALIDATION");

    const binary = await executeTool(deps(f.root, s), call("read_file", { path: "binary.bin" }));
    assert.equal(binary.ok, false);
    assert.equal(binary.mutationError?.code, "MUTATION_VALIDATION");
    assert.deepEqual(await readFile(join(f.root, "binary.bin")), Buffer.from([0, 255, 1, 128]));
  } finally {
    await cleanup(f);
  }
});

test("bound multi-edit validates stale state before changing the target", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "multi.txt");
    await writeFile(path, "one\ntwo\n");
    const s = await session(f, "executor-multi");
    await executeTool(deps(f.root, s), call("read_file", { path: "multi.txt" }));
    await writeFile(path, "one\nexternal\n");
    const result = await executeTool(deps(f.root, s), call("multi_edit", {
      path: "multi.txt",
      edits: [{ find: "one", replace: "ONE" }, { find: "two", replace: "TWO" }],
    }));
    assert.equal(result.ok, false);
    assert.equal(result.mutationError?.code, "STALE_MUTATION");
    assert.deepEqual(await readFile(path), Buffer.from("one\nexternal\n"));
  } finally {
    await cleanup(f);
  }
});

test("create race is bound to observed missing state and exactly one writer succeeds", async () => {
  const f = await fixture();
  try {
    const first = await session(f, "executor-create-one");
    const second = await session(f, "executor-create-two");
    const results = await Promise.all([
      executeTool(deps(f.root, first), call("write_file", { path: "race.txt", content: "one\n" })),
      executeTool(deps(f.root, second), call("write_file", { path: "race.txt", content: "two\n" })),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const rejected = results.find((result) => !result.ok)!;
    assert.equal(rejected.mutationError?.code, "STALE_MUTATION");
    assert.equal(rejected.mutationError?.mutationApplied, false);
  } finally {
    await cleanup(f);
  }
});

test("bound executor rejects path escape with a typed confinement result", async () => {
  const f = await fixture();
  try {
    const s = await session(f, "executor-confinement");
    const result = await executeTool(deps(f.root, s), call("write_file", { path: "../outside.txt", content: "nope" }));
    assert.equal(result.ok, false);
    assert.equal(result.mutationError?.code, "MUTATION_CONFINEMENT");
    assert.equal(result.mutationError?.mutationApplied, false);
    assert.equal(result.mutationError?.workspaceId, f.handle.id);
  } finally {
    await cleanup(f);
  }
});

test("executor conformance: a bound writer uses the injected mutation session and never the legacy writer", async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const binding = {
      sessionId: "executor-injected",
      workspaceId: f.handle.id,
      candidateId: "candidate-1",
      generationId: "generation-1",
      actor: "model" as const,
      cause: "model" as const,
    };
    const fakeSession = {
      binding,
      hasObservation: () => true,
      currentObservation: () => undefined,
      observeBytes: async () => { throw new Error("not used"); },
      readText: async () => { throw new Error("not used"); },
      discardObservation: () => undefined,
      writeText: async (path: string, content: string) => {
        calls.push(`writeText:${path}:${content}`);
        return {
          mutation: {
            operationId: "operation-1",
            observationId: "observation-1",
            workspaceId: f.handle.id,
            candidateId: "candidate-1",
            generationId: "generation-1",
            actor: "model" as const,
            cause: "model" as const,
            path,
            kind: "create" as const,
            before: { kind: "missing" as const, byteLength: null, sha256: null, symlinkTarget: null, mode: null },
            after: { kind: "regular" as const, byteLength: Buffer.byteLength(content), sha256: sha256Bytes(Buffer.from(content)), symlinkTarget: null, mode: 0o600 },
          },
          beforeBytes: Buffer.alloc(0),
          afterBytes: Buffer.from(content),
        };
      },
      replaceText: async () => { throw new Error("not used"); },
      replaceBytes: async () => { throw new Error("not used"); },
      applyTextBatch: async () => { throw new Error("not used"); },
      createBytes: async () => { throw new Error("not used"); },
      deleteFile: async () => { throw new Error("not used"); },
      previewText: async () => { throw new Error("not used"); },
      previewWrite: async () => { throw new Error("not used"); },
    } as unknown as MutationSessionLike;
    const result = await executeTool({ worktreeReal: f.root, agentId: "executor-test", mutationSession: fakeSession }, call("write_file", { path: "injected.txt", content: "bound\n" }));
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["writeText:injected.txt:bound\n"]);
    assert.equal(existsSync(join(f.root, "injected.txt")), false, "the legacy direct writer was not reached");
  } finally {
    await cleanup(f);
  }
});

test("listing, search, glob, and diff output do not create write authority", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "listed.txt");
    await writeFile(path, "ground truth\n");
    const s = await session(f, "executor-read-only-results");
    for (const name of ["list_dir", "search_files", "glob", "git_diff"]) {
      await executeTool(deps(f.root, s), call(name, name === "search_files" ? { pattern: "ground" } : { path: "." }));
      const result = await executeTool(deps(f.root, s), call("write_file", { path: "listed.txt", content: "must-refuse\n" }));
      assert.equal(result.ok, false, `${name} did not establish write authority`);
      assert.equal(result.mutationError?.code, "MUTATION_VALIDATION");
    }
    assert.deepEqual(await readFile(path), Buffer.from("ground truth\n"));
  } finally {
    await cleanup(f);
  }
});

test("notebook edit uses the retained exact notebook bytes and stale refusal", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "notes.ipynb");
    const notebook = `${JSON.stringify({ cells: [{ cell_type: "markdown", metadata: {}, source: ["before\n"] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`;
    await writeFile(path, notebook);
    const s = await session(f, "executor-notebook");
    await executeTool(deps(f.root, s), call("read_file", { path: "notes.ipynb" }));
    const edited = await executeTool(deps(f.root, s), call("notebook_edit", { path: "notes.ipynb", operation: "edit", cell_index: 0, source: "after" }));
    assert.equal(edited.ok, true);
    assert.equal(edited.wrote, "notes.ipynb");
    const after = await readFile(path, "utf8");
    assert.equal(JSON.parse(after).cells[0].source[0], "after");

    await executeTool(deps(f.root, s), call("read_file", { path: "notes.ipynb" }));
    await writeFile(path, after.replace("after", "external"));
    const stale = await executeTool(deps(f.root, s), call("notebook_edit", { path: "notes.ipynb", operation: "edit", cell_index: 0, source: "should-not-land" }));
    assert.equal(stale.ok, false);
    assert.equal(stale.mutationError?.code, "STALE_MUTATION");
  } finally {
    await cleanup(f);
  }
});
