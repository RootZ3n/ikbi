/**
 * THE BUILDER TOOL EXECUTOR — against a REAL git worktree and the REAL mutation core.
 *
 * These are the tests that make "state-bound editing" mean something. The hostile ones
 * change a file on disk BETWEEN the read and the write — which is exactly the situation a
 * compare-and-swap exists for — and assert that the external bytes survive and the model
 * is told the truth.
 *
 * Capability: git (registered in scripts/test-runner.sh).
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { createProductionWorkspaceAuthorities } from "./workspace-authority.js";
import { createSourceSnapshotAuthority } from "./source-snapshot.js";
import { buildMutationScope, type MutationScope } from "../core/mutation-scope.js";
import { createBuilderToolExecutor } from "./builder-tools.js";
import { TOOL_CREATE_FILE, TOOL_DELETE_FILE, TOOL_READ_FILE, TOOL_REPLACE_FILE, type ToolOutcome } from "../core/tools.js";
import { createSequentialIdFactory } from "../core/identity.js";
import { initGitRepo } from "../cli/fixture-repo.js";
import type { V2ObservationDigest } from "../core/identity.js";
import type { V2WorkspaceRecord } from "../core/workspace.js";

/** The widest scope, built through the real authority so the harness cannot fake one. */
const REPO_WIDE_SCOPE = (() => {
  const built = buildMutationScope({ repoWide: true });
  if (!built.ok) throw new Error("repo-wide scope must build");
  return built.scope;
})();

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A real repository, a real worktree, and the real state-bound core over it. */
async function fixture(
  files: Readonly<Record<string, string>> = { "src/a.ts": "export const a = 1;\n" },
  scope: MutationScope = REPO_WIDE_SCOPE,
) {
  const repo = initGitRepo(files);
  dirs.push(repo);

  const ids = createSequentialIdFactory("bt");
  const runId = ids.mint("run");
  const sources = createSourceSnapshotAuthority();
  const captured = await sources.capture({ repoPath: repo });
  assert.ok(captured.ok, "snapshot capture failed");

  const { workspaces: manager } = await import("../../core/workspace/index.js");
  const { workspaces, mutations } = createProductionWorkspaceAuthorities({
    manager,
    mintWorkspaceId: () => ids.mint("workspace"),
    capturedBytes: (id) => sources.capturedBytes(id),
  });
  const allocated = await workspaces.allocate({ runId, source: captured.reader.snapshot, label: "test" });
  assert.ok(allocated.ok, allocated.ok ? "" : allocated.failure.message);
  const workspace: V2WorkspaceRecord = allocated.workspace;
  dirs.push(workspace.path);

  const observations: string[] = [];
  const applied: { mutationId: string; path: string }[] = [];
  const executor = createBuilderToolExecutor({
    runId,
    workspace,
    mutations,
    // Explicit repository-wide authority: this harness exercises the observe→CAS→mutate
    // machinery, and the scope gate has its own suites. Stated, never defaulted.
    mutationScope: scope,
    onObservation: (o) => observations.push(o.path),
    onMutation: (m) => applied.push({ mutationId: m.mutationId, path: m.path }),
  });

  const read = (path: string) => executor.execute({ ok: true, name: TOOL_READ_FILE, path });
  const inWorkspace = (path: string) => join(workspace.path, ...path.split("/"));

  return { repo, workspace, executor, read, observations, applied, inWorkspace, workspaces };
}

const observationOf = (outcome: ToolOutcome): V2ObservationDigest => {
  assert.equal(outcome.kind, "observed");
  return (outcome as { observationId: string }).observationId as V2ObservationDigest;
};

// ── reading is observing ────────────────────────────────────────────────────

test("executor: read_file returns the content AND an observation for that exact state", async () => {
  const f = await fixture();
  const { outcome } = await f.read("src/a.ts");
  assert.equal(outcome.kind, "observed");
  const observed = outcome as Extract<ToolOutcome, { kind: "observed" }>;
  assert.equal(observed.content, "export const a = 1;\n");
  assert.equal(observed.state, "regular");
  assert.ok(observed.observationId.length > 0);
  assert.deepEqual(f.observations, ["src/a.ts"], "and the run was told, so it lands on the ledger");
});

test("executor: reading a MISSING path still yields an observation — that is how creation works", async () => {
  const f = await fixture();
  const { outcome } = await f.read("src/brand-new.ts");
  assert.equal(outcome.kind, "observed");
  const observed = outcome as Extract<ToolOutcome, { kind: "observed" }>;
  assert.equal(observed.state, "missing");
  assert.equal(observed.content, undefined);
  assert.ok(observed.observationId.length > 0, "an anchor for a file that does not exist yet");
});

test("executor: a path that ESCAPES the workspace is refused before any I/O", async () => {
  const f = await fixture();
  const { outcome } = await f.read("../../../etc/passwd");
  assert.equal(outcome.kind, "refused");
  assert.deepEqual(f.observations, [], "nothing was even observed");
});

// ── writing requires observing ──────────────────────────────────────────────

test("executor: replace_file with a fresh observation applies, and reports both hashes", async () => {
  const f = await fixture();
  const observationId = observationOf((await f.read("src/a.ts")).outcome);
  const { outcome, mutation } = await f.executor.execute({
    ok: true,
    name: TOOL_REPLACE_FILE,
    path: "src/a.ts",
    observationId,
    content: "export const a = 2;\n",
  });
  assert.equal(outcome.kind, "applied");
  const done = outcome as Extract<ToolOutcome, { kind: "applied" }>;
  assert.equal(done.changed, true);
  assert.notEqual(done.beforeSha256, done.afterSha256);
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "export const a = 2;\n");
  assert.equal(mutation?.path, "src/a.ts");
  assert.deepEqual(f.applied.map((m) => m.path), ["src/a.ts"]);
});

test("executor: create_file against a MISSING observation creates the file", async () => {
  const f = await fixture();
  const observationId = observationOf((await f.read("src/new.ts")).outcome);
  const { outcome } = await f.executor.execute({ ok: true, name: TOOL_CREATE_FILE, path: "src/new.ts", observationId, content: "export const n = 1;\n" });
  assert.equal(outcome.kind, "applied");
  assert.equal(readFileSync(f.inWorkspace("src/new.ts"), "utf8"), "export const n = 1;\n");
});

test("executor: delete_file with a fresh observation removes the file", async () => {
  const f = await fixture();
  const observationId = observationOf((await f.read("src/a.ts")).outcome);
  const { outcome } = await f.executor.execute({ ok: true, name: TOOL_DELETE_FILE, path: "src/a.ts", observationId });
  assert.equal(outcome.kind, "applied");
  assert.equal((await f.read("src/a.ts")).outcome.kind === "observed" && ((await f.read("src/a.ts")).outcome as { state: string }).state, "missing");
});

test("executor: an INVENTED observationId is refused — an id is not a capability to forge", async () => {
  const f = await fixture();
  const { outcome, mutation } = await f.executor.execute({
    ok: true,
    name: TOOL_REPLACE_FILE,
    path: "src/a.ts",
    observationId: ("f".repeat(64) as V2ObservationDigest),
    content: "hacked\n",
  });
  assert.equal(outcome.kind, "refused");
  assert.equal((outcome as { code: string }).code, "mutation.unknown_observation");
  assert.equal(mutation, undefined);
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "export const a = 1;\n", "the file is untouched");
});

test("executor: an observation from ANOTHER FILE cannot authorize this one", async () => {
  const f = await fixture({ "src/a.ts": "A\n", "src/b.ts": "B\n" });
  const observationId = observationOf((await f.read("src/b.ts")).outcome);
  const { outcome } = await f.executor.execute({ ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts", observationId, content: "hacked\n" });
  assert.equal(outcome.kind, "refused");
  assert.equal((outcome as { code: string }).code, "mutation.observation_path_mismatch");
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "A\n");
});

// ── THE STATE-BOUND PROOF ───────────────────────────────────────────────────

test("STATE-BOUND: a write against a STALE observation is refused and the file survives", async () => {
  const f = await fixture();
  const observationId = observationOf((await f.read("src/a.ts")).outcome);

  // Somebody else changes the file after the model looked at it. This is the whole point.
  writeFileSync(f.inWorkspace("src/a.ts"), "export const a = 999; // written by someone else\n");

  const { outcome, mutation } = await f.executor.execute({
    ok: true,
    name: TOOL_REPLACE_FILE,
    path: "src/a.ts",
    observationId,
    content: "export const a = 2;\n",
  });

  assert.equal(outcome.kind, "refused", "the compare-and-swap held");
  assert.equal((outcome as { code: string }).code, "mutation.stale_observation");
  assert.equal(mutation, undefined, "and no mutation was recorded");
  assert.equal(
    readFileSync(f.inWorkspace("src/a.ts"), "utf8"),
    "export const a = 999; // written by someone else\n",
    "THE EXTERNAL BYTES SURVIVED — the model's edit did not overwrite work it never saw",
  );
});

test("STATE-BOUND: the refusal tells the model both states, so it can reason about them", async () => {
  const f = await fixture();
  const observationId = observationOf((await f.read("src/a.ts")).outcome);
  writeFileSync(f.inWorkspace("src/a.ts"), "changed underneath\n");
  const { outcome } = await f.executor.execute({ ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts", observationId, content: "x\n" });
  const refused = outcome as Extract<ToolOutcome, { kind: "refused" }>;
  assert.ok(refused.expectedSha256 !== undefined && refused.expectedSha256 !== null, "what it thought was there");
  assert.ok(refused.actualSha256 !== undefined, "and what is actually there");
  assert.notEqual(refused.expectedSha256, refused.actualSha256);
});

test("STATE-BOUND: infrastructure does NOT retry — a fresh read is the model's own decision", async () => {
  const f = await fixture();
  const first = observationOf((await f.read("src/a.ts")).outcome);
  writeFileSync(f.inWorkspace("src/a.ts"), "external\n");

  const refused = await f.executor.execute({ ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts", observationId: first, content: "mine\n" });
  assert.equal(refused.outcome.kind, "refused");
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "external\n", "nothing was silently re-applied");

  // Now the MODEL decides to look again. That is reasoning, not a retry.
  const second = observationOf((await f.read("src/a.ts")).outcome);
  assert.notEqual(second, first, "a different state is a different observation");
  const applied = await f.executor.execute({ ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts", observationId: second, content: "mine\n" });
  assert.equal(applied.outcome.kind, "applied", "and with a current anchor the write lands");
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "mine\n");
});

test("STATE-BOUND: an observation cannot be REUSED for a second write", async () => {
  const f = await fixture();
  const observationId = observationOf((await f.read("src/a.ts")).outcome);
  const first = await f.executor.execute({ ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts", observationId, content: "one\n" });
  assert.equal(first.outcome.kind, "applied");
  // The file is now what the FIRST write made it, so the original anchor is stale.
  const second = await f.executor.execute({ ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts", observationId, content: "two\n" });
  assert.equal(second.outcome.kind, "refused");
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "one\n");
});

// ── the source repository is never touched ──────────────────────────────────

test("executor: every edit lands in the WORKSPACE and never in the source repository", async () => {
  const f = await fixture();
  const observationId = observationOf((await f.read("src/a.ts")).outcome);
  await f.executor.execute({ ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts", observationId, content: "edited\n" });
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "edited\n");
  assert.equal(readFileSync(join(f.repo, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the operator's file is untouched");
});

// ── the operator mutation scope, enforced at the write ──────────────────────

/** Build a narrow scope through the real authority. */
function narrow(request: { allowPaths?: string[]; allowTrees?: string[] }): MutationScope {
  const built = buildMutationScope(request);
  if (!built.ok) throw new Error(`scope must build: ${built.detail}`);
  return built.scope;
}

test("SCOPE: a write to a path OUTSIDE the scope is refused and the file on disk is untouched", async () => {
  const f = await fixture(
    { "src/a.ts": "export const a = 1;\n", "README.md": "# original\n" },
    narrow({ allowTrees: ["src"] }),
  );

  const observed = await f.read("README.md");
  // Reading is NOT restricted — a builder must be able to understand the repository it is
  // changing. Only the WRITE is an exercise of authority.
  assert.equal(observed.outcome.kind, "observed");

  const { outcome } = await f.executor.execute({
    ok: true, name: TOOL_REPLACE_FILE, path: "README.md",
    observationId: observationOf(observed.outcome), content: "# rewritten\n",
  });

  assert.equal(outcome.kind, "refused");
  const refused = outcome as Extract<ToolOutcome, { kind: "refused" }>;
  assert.equal(refused.code, "mutation.out_of_scope");
  assert.match(refused.detail, /outside this run's authorized mutation scope/);
  assert.match(refused.detail, /src\/\*\*/, "the refusal tells the model what it MAY change");
  assert.equal(readFileSync(f.inWorkspace("README.md"), "utf8"), "# original\n", "nothing was written");
  assert.deepEqual(f.applied, [], "and no mutation reached the ledger");
});

test("SCOPE: a write INSIDE the scope still applies normally", async () => {
  const f = await fixture({ "src/a.ts": "export const a = 1;\n" }, narrow({ allowTrees: ["src"] }));
  const observed = await f.read("src/a.ts");
  const { outcome } = await f.executor.execute({
    ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts",
    observationId: observationOf(observed.outcome), content: "export const a = 2;\n",
  });
  assert.equal(outcome.kind, "applied");
  assert.equal(readFileSync(f.inWorkspace("src/a.ts"), "utf8"), "export const a = 2;\n");
});

test("SCOPE: create, modify and delete are each gated, and the refusal names the operation", async () => {
  const f = await fixture(
    { "src/a.ts": "a\n", "docs/keep.md": "keep\n" },
    narrow({ allowPaths: ["src/a.ts"] }),
  );

  // CREATE outside scope.
  const missing = await f.read("docs/new.md");
  const created = await f.executor.execute({
    ok: true, name: TOOL_CREATE_FILE, path: "docs/new.md",
    observationId: observationOf(missing.outcome), content: "new\n",
  });
  assert.equal(created.outcome.kind, "refused");
  assert.equal((created.outcome as { code: string }).code, "mutation.out_of_scope");

  // DELETE outside scope.
  const keep = await f.read("docs/keep.md");
  const deleted = await f.executor.execute({
    ok: true, name: TOOL_DELETE_FILE, path: "docs/keep.md", observationId: observationOf(keep.outcome),
  });
  assert.equal(deleted.outcome.kind, "refused");
  assert.equal(readFileSync(f.inWorkspace("docs/keep.md"), "utf8"), "keep\n", "the file survives a refused delete");

  // MODIFY inside scope still works, so the gate is not simply refusing everything.
  const a = await f.read("src/a.ts");
  const ok = await f.executor.execute({
    ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts",
    observationId: observationOf(a.outcome), content: "b\n",
  });
  assert.equal(ok.outcome.kind, "applied");
});

test("SCOPE: an exact-file grant does not extend to its siblings", async () => {
  const f = await fixture(
    { "src/a.ts": "a\n", "src/b.ts": "b\n" },
    narrow({ allowPaths: ["src/a.ts"] }),
  );
  const b = await f.read("src/b.ts");
  const { outcome } = await f.executor.execute({
    ok: true, name: TOOL_REPLACE_FILE, path: "src/b.ts",
    observationId: observationOf(b.outcome), content: "changed\n",
  });
  assert.equal(outcome.kind, "refused");
  assert.equal(readFileSync(f.inWorkspace("src/b.ts"), "utf8"), "b\n");
});

test("SCOPE: the model cannot escape by SPELLING a path differently", async () => {
  const f = await fixture(
    { "src/a.ts": "a\n", "secrets.txt": "top secret\n" },
    narrow({ allowTrees: ["src"] }),
  );
  // Each of these normalizes to something outside `src/`, or cannot be normalized at all.
  for (const attempt of ["src/../secrets.txt", "./secrets.txt", "src/./../secrets.txt"]) {
    const observed = await f.read(attempt);
    if (observed.outcome.kind !== "observed") continue; // confinement refused it even earlier
    const { outcome } = await f.executor.execute({
      ok: true, name: TOOL_REPLACE_FILE, path: attempt,
      observationId: observationOf(observed.outcome), content: "owned\n",
    });
    assert.equal(outcome.kind, "refused", attempt);
  }
  assert.equal(readFileSync(f.inWorkspace("secrets.txt"), "utf8"), "top secret\n", "the out-of-scope file is intact");
});

test("SCOPE: a refused write does not consume the observation — the model can still work in scope", async () => {
  const f = await fixture(
    { "src/a.ts": "a\n", "out.txt": "out\n" },
    narrow({ allowTrees: ["src"] }),
  );
  const out = await f.read("out.txt");
  const refused = await f.executor.execute({
    ok: true, name: TOOL_REPLACE_FILE, path: "out.txt",
    observationId: observationOf(out.outcome), content: "x\n",
  });
  assert.equal(refused.outcome.kind, "refused");

  const a = await f.read("src/a.ts");
  const applied = await f.executor.execute({
    ok: true, name: TOOL_REPLACE_FILE, path: "src/a.ts",
    observationId: observationOf(a.outcome), content: "still working\n",
  });
  assert.equal(applied.outcome.kind, "applied", "a scope refusal is not a fatal error for the loop");
});

test("SCOPE: repo-wide authority permits what a narrow scope refuses", async () => {
  const files = { "src/a.ts": "a\n", "README.md": "# original\n" };
  const wide = await fixture(files, REPO_WIDE_SCOPE);
  const observed = await wide.read("README.md");
  const { outcome } = await wide.executor.execute({
    ok: true, name: TOOL_REPLACE_FILE, path: "README.md",
    observationId: observationOf(observed.outcome), content: "# rewritten\n",
  });
  assert.equal(outcome.kind, "applied", "the same write the narrow scope refused");
});
