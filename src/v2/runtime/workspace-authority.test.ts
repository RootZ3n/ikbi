/**
 * THE WORKSPACE + STATE-BOUND MUTATION AUTHORITIES — hostile integration coverage.
 *
 * Real git repositories, real worktrees, real files. The load-bearing assertions are
 * refusals: a stale observation never overwrites, an observation from one workspace never
 * authorizes a write in another, and nothing escapes the workspace by any route.
 *
 * Capability: git (registered in scripts/test-runner.sh).
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { after, test } from "node:test";

import { pino } from "pino";

import { LockManager } from "../../core/substrate/lock.js";
import { DocumentStore } from "../../core/substrate/store.js";
import type { WorkspaceRecord } from "../../core/workspace/contract.js";
import { WorkspaceManager } from "../../core/workspace/manager.js";
import { createSequentialIdFactory } from "../core/identity.js";
import type { V2RunId, V2WorkspaceId } from "../core/identity.js";
import {
  V2_WORKSPACE_FAILURE_CODES,
  observationDigest,
  type StateBoundMutationAuthority,
  type V2WorkspaceRecord,
  type WorkspaceAuthority,
} from "../core/workspace.js";
import { commitFiles, headCommit, headTree, initGitRepo } from "../cli/fixture-repo.js";
import { createProductionWorkspaceAuthorities } from "./workspace-authority.js";
import { createSourceSnapshotAuthority } from "./source-snapshot.js";

const silent = () => pino({ level: "silent" });
const ids = createSequentialIdFactory("wsx");
const RUN = ids.mint("run");

const scratch: string[] = [];
const repos: string[] = [];

after(() => {
  for (const dir of [...scratch, ...repos]) rmSync(dir, { recursive: true, force: true });
});

/** A REAL WorkspaceManager over a fresh scratch root, plus the v2 authorities over it. */
function authorities(): { workspaces: WorkspaceAuthority; mutations: StateBoundMutationAuthority; sources: ReturnType<typeof createSourceSnapshotAuthority> } {
  const root = join(tmpdir(), `ikbi-v2-ws-${randomBytes(8).toString("hex")}`);
  scratch.push(root);
  const locks = new LockManager({ logger: silent(), defaultTimeoutMs: 5_000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent(), fsync: false });
  const manager = new WorkspaceManager({ root, max: 16, locks, store, logger: silent() });
  const wsIds = createSequentialIdFactory(`w${scratch.length}`);
  // Each set of authorities gets its OWN snapshot authority, so a workspace is always
  // materialized from bytes captured by the same component that will verify them.
  const sources = createSourceSnapshotAuthority();
  const built = createProductionWorkspaceAuthorities({
    manager,
    mintWorkspaceId: () => wsIds.mint("workspace"),
    capturedBytes: (id) => sources.capturedBytes(id),
  });
  return { ...built, sources };
}

function repo(files: Readonly<Record<string, string>> = {}): string {
  const r = initGitRepo(files);
  repos.push(r);
  return r;
}

/** Capture the source snapshot, then allocate a workspace materialized from it. */
async function allocate(
  a: { workspaces: WorkspaceAuthority; sources: ReturnType<typeof createSourceSnapshotAuthority> },
  repoPath: string,
  runId: V2RunId = RUN,
): Promise<V2WorkspaceRecord> {
  const captured = await a.sources.capture({ repoPath });
  assert.ok(captured.ok, `capture failed: ${captured.ok ? "" : captured.failure.message}`);
  const result = await a.workspaces.allocate({ runId, source: captured.reader.snapshot });
  assert.ok(result.ok, `allocation failed: ${result.ok ? "" : result.failure.message}`);
  return result.workspace;
}

const sha = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const bytes = (text: string): Uint8Array => Buffer.from(text, "utf8");

async function observe(a: { mutations: StateBoundMutationAuthority }, ws: V2WorkspaceRecord, path: string, runId: V2RunId = RUN) {
  const result = await a.mutations.observe({ runId, workspace: ws, path });
  assert.ok(result.ok, `observe failed: ${result.ok ? "" : result.failure.message}`);
  return result.observation;
}

// ── allocation + source binding ─────────────────────────────────────────────

test("workspace: allocation binds the EXACT source commit and tree, not a branch name", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "export const a = 1;\n" });
  const ws = await allocate(a, source);
  assert.equal(ws.source.baseCommit, headCommit(source));
  assert.equal(ws.source.baseTree, headTree(source));
  assert.equal(ws.source.repositoryPath, source);
  assert.equal(ws.runId, RUN);
  assert.equal(ws.status, "allocated");
  assert.notEqual(ws.path, source, "the workspace is a separate directory");
});

test("workspace: the binding stays TRUE after the source repository moves on", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "one\n" });
  const ws = await allocate(a, source);
  const originalTree = headTree(source);
  commitFiles(source, { "src/a.ts": "two\n" }, "moved on");
  assert.notEqual(headTree(source), originalTree, "the source really moved");
  assert.equal(ws.source.baseTree, originalTree, "the workspace still names what it was cut from");
});

test("workspace: two workspaces from the SAME source get distinct identities", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "same\n" });
  const first = await allocate(a, source);
  const second = await allocate(a, source);
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.notEqual(first.donorWorkspaceId, second.donorWorkspaceId);
  assert.notEqual(first.path, second.path);
  assert.equal(first.source.baseTree, second.source.baseTree, "while naming the same source state");
});

test("workspace: discard removes the worktree and leaves the source untouched", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "keep\n" });
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" });
  const ws = await allocate(a, source);
  const disposition = await a.workspaces.discard(ws);
  assert.equal(disposition.kind, "discarded");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }), before);
  assert.equal(readFileSync(join(source, "src/a.ts"), "utf8"), "keep\n");
});

// ── observation ─────────────────────────────────────────────────────────────

test("observation: a regular file's digest equals an independent SHA-256 of its bytes", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "export const a = 1;\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  assert.equal(obs.state.kind, "regular");
  assert.equal(obs.state.contentSha256, sha("export const a = 1;\n"));
  assert.equal(obs.state.byteLength, Buffer.byteLength("export const a = 1;\n"));
  assert.equal(obs.workspaceId, ws.workspaceId);
  assert.equal(obs.runId, RUN);
});

test("observation: missing / empty / directory are DIFFERENT states, not one 'no content'", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "empty.txt": "", "dir/inner.txt": "x" }));
  assert.equal((await observe(a, ws, "nope.txt")).state.kind, "missing");
  // An empty committed file: git keeps it, so the worktree has a zero-byte regular file.
  assert.equal((await observe(a, ws, "empty.txt")).state.kind, "empty");
  assert.equal((await observe(a, ws, "dir")).state.kind, "directory");
});

test("observation: identity is WORKSPACE-SCOPED — same bytes, different observation", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "identical\n" });
  const first = await allocate(a, source);
  const second = await allocate(a, source);
  const one = await observe(a, first, "src/a.ts");
  const two = await observe(a, second, "src/a.ts");
  assert.equal(one.state.contentSha256, two.state.contentSha256, "the CONTENT is identical");
  assert.notEqual(one.observationId, two.observationId, "the OBSERVATION is not");
});

test("observation: the identity is the content address of workspace + path + state", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "abc\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  assert.equal(obs.observationId, observationDigest({ workspaceId: ws.workspaceId, path: "src/a.ts", state: obs.state }));
});

// ── mutation: the happy paths ───────────────────────────────────────────────

test("mutation: replace against a fresh observation applies and reports the new state", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "old\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "replace", content: bytes("new\n") } });
  assert.ok(result.ok, result.ok ? "" : result.failure.message);
  assert.equal(result.record.before.contentSha256, sha("old\n"));
  assert.equal(result.record.after.contentSha256, sha("new\n"));
  assert.equal(result.record.changed, true);
  assert.equal(readFileSync(join(ws.path, "src/a.ts"), "utf8"), "new\n");
});

test("mutation: create against a MISSING observation applies", async () => {
  const a = authorities();
  const ws = await allocate(a, repo());
  const obs = await observe(a, ws, "src/new.ts");
  assert.equal(obs.state.kind, "missing");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "create", content: bytes("fresh\n") } });
  assert.ok(result.ok, result.ok ? "" : result.failure.message);
  assert.equal(result.record.before.kind, "missing");
  assert.equal(result.record.after.kind, "regular");
  assert.equal(result.record.after.contentSha256, sha("fresh\n"));
});

test("mutation: delete against an existing observation leaves a MISSING state", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/gone.ts": "bye\n" }));
  const obs = await observe(a, ws, "src/gone.ts");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "delete" } });
  assert.ok(result.ok, result.ok ? "" : result.failure.message);
  assert.equal(result.record.after.kind, "missing");
  assert.equal(result.record.changed, true);
});

test("mutation: a BYTE-IDENTICAL replace is applied and recorded with changed:false", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "same\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "replace", content: bytes("same\n") } });
  assert.ok(result.ok, result.ok ? "" : result.failure.message);
  assert.equal(result.record.changed, false, "an idempotent write is not a change");
  assert.equal(result.record.before.contentSha256, result.record.after.contentSha256);
});

// ── compare-and-swap ────────────────────────────────────────────────────────

test("CAS: a STALE observation is refused and the other writer's bytes survive", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "original\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  // Somebody else changed the file after we looked.
  writeFileSync(join(ws.path, "src/a.ts"), "SOMEONE-ELSES-WORK\n");

  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "replace", content: bytes("ours\n") } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_WORKSPACE_FAILURE_CODES.staleObservation);
  assert.equal(readFileSync(join(ws.path, "src/a.ts"), "utf8"), "SOMEONE-ELSES-WORK\n", "the edit did not land");
  // Evidence is IDENTITIES, never contents.
  assert.equal(result.failure.detail?.expectedSha256, sha("original\n"));
  assert.equal(result.failure.detail?.actualSha256, sha("SOMEONE-ELSES-WORK\n"));
  assert.equal(JSON.stringify(result.failure).includes("SOMEONE-ELSES-WORK"), false, "no file content leaks into the failure");
});

test("CAS: a creation RACE is refused — observed missing, someone created it", async () => {
  const a = authorities();
  const ws = await allocate(a, repo());
  const obs = await observe(a, ws, "src/race.ts");
  mkdirSync(join(ws.path, "src"), { recursive: true });
  writeFileSync(join(ws.path, "src/race.ts"), "THEIRS\n");

  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "create", content: bytes("OURS\n") } });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_WORKSPACE_FAILURE_CODES.staleObservation);
  assert.equal(readFileSync(join(ws.path, "src/race.ts"), "utf8"), "THEIRS\n");
});

test("CAS: a delete race is refused rather than deleting someone's newer file", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "v1\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  writeFileSync(join(ws.path, "src/a.ts"), "v2\n");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "delete" } });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_WORKSPACE_FAILURE_CODES.staleObservation);
  assert.equal(readFileSync(join(ws.path, "src/a.ts"), "utf8"), "v2\n");
});

// ── binding ─────────────────────────────────────────────────────────────────

test("binding: an observation from workspace A cannot mutate workspace B", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "identical\n" });
  const first = await allocate(a, source);
  const second = await allocate(a, source);
  const obsInFirst = await observe(a, first, "src/a.ts");

  const result = await a.mutations.mutate({ runId: RUN, workspace: second, observation: obsInFirst, operation: { kind: "replace", content: bytes("x\n") } });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_WORKSPACE_FAILURE_CODES.workspaceMismatch);
  assert.equal(readFileSync(join(second.path, "src/a.ts"), "utf8"), "identical\n", "B is untouched");
  assert.match(result.failure.message, /identical bytes are not identical authority/);
});

test("binding: a FOREIGN run id is refused", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "x\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  const foreign = ids.mint("run") as V2RunId;
  const result = await a.mutations.mutate({ runId: foreign, workspace: ws, observation: obs, operation: { kind: "replace", content: bytes("y\n") } });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_WORKSPACE_FAILURE_CODES.runMismatch);
});

test("binding: a FABRICATED observation this authority never took is refused", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "x\n" }));
  const real = await observe(a, ws, "src/a.ts");
  const forged = { ...real, observationId: ("f".repeat(64) as typeof real.observationId) };
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: forged, operation: { kind: "replace", content: bytes("y\n") } });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_WORKSPACE_FAILURE_CODES.unknownObservation);
});

// ── confinement ─────────────────────────────────────────────────────────────

test("confinement: traversal and absolute paths are refused at OBSERVE", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "x\n" }));
  for (const path of ["../escape.txt", "src/../../escape.txt", "/etc/passwd"]) {
    const result = await a.mutations.observe({ runId: RUN, workspace: ws, path });
    assert.equal(result.ok, false, `${path} was not refused`);
    assert.ok(!result.ok);
    assert.equal(result.failure.code, V2_WORKSPACE_FAILURE_CODES.pathEscapesWorkspace);
  }
});

test("confinement: a symlink ESCAPING the workspace cannot be written through", async () => {
  const a = authorities();
  const outside = repo({ "secret.txt": "OUTSIDE-ORIGINAL\n" });
  const ws = await allocate(a, repo({ "src/a.ts": "x\n" }));
  symlinkSync(join(outside, "secret.txt"), join(ws.path, "link.txt"));

  const observed = await a.mutations.observe({ runId: RUN, workspace: ws, path: "link.txt" });
  if (observed.ok) {
    // If the core allows OBSERVING it, the state must be `symlink` — never the target's
    // content — and a write must still not reach outside.
    assert.equal(observed.observation.state.kind, "symlink");
    const result = await a.mutations.mutate({
      runId: RUN,
      workspace: ws,
      observation: observed.observation,
      operation: { kind: "replace", content: bytes("OVERWRITTEN\n") },
    });
    assert.equal(result.ok, false, "a symlink out of the workspace is not a writable target");
  }
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "OUTSIDE-ORIGINAL\n", "the outside file is untouched");
});

test("confinement: a PARENT-directory symlink escape cannot be written through", async () => {
  const a = authorities();
  const outside = repo({ "nested/target.txt": "OUTSIDE-ORIGINAL\n" });
  const ws = await allocate(a, repo({ "src/a.ts": "x\n" }));
  symlinkSync(join(outside, "nested"), join(ws.path, "linkdir"));

  const observed = await a.mutations.observe({ runId: RUN, workspace: ws, path: "linkdir/target.txt" });
  assert.equal(observed.ok, false, "a symlinked ancestor is refused");
  assert.ok(!observed.ok);
  assert.equal(observed.failure.code, V2_WORKSPACE_FAILURE_CODES.pathEscapesWorkspace);
  assert.equal(readFileSync(join(outside, "nested/target.txt"), "utf8"), "OUTSIDE-ORIGINAL\n");
});

test("confinement: a DIRECTORY is not a writable target", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "dir/inner.txt": "x" }));
  const obs = await observe(a, ws, "dir");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "replace", content: bytes("y\n") } });
  assert.equal(result.ok, false, "a directory cannot be replaced with file bytes");
});

// ── isolation from the source repository ────────────────────────────────────

test("isolation: mutating the workspace NEVER touches the source repository", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "SOURCE\n" });
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" });
  const head = headCommit(source);

  const ws = await allocate(a, source);
  const obs = await observe(a, ws, "src/a.ts");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "replace", content: bytes("WORKSPACE-ONLY\n") } });
  assert.ok(result.ok);

  assert.equal(readFileSync(join(source, "src/a.ts"), "utf8"), "SOURCE\n", "the source file is unchanged");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }), before);
  assert.equal(headCommit(source), head);
  assert.equal(readFileSync(join(ws.path, "src/a.ts"), "utf8"), "WORKSPACE-ONLY\n", "only the workspace changed");
});

test("isolation: a workspace's observation matches the CONTEXT artifact hash of the same bytes", async () => {
  // The reconciliation a future builder must perform: what the model saw
  // (ContextArtifact.observedSha256) against what the mutation authority sees here.
  const content = "export const widget = 1;\n";
  const a = authorities();
  const ws = await allocate(a, repo({ "src/widget.ts": content }));
  const obs = await observe(a, ws, "src/widget.ts");
  assert.equal(obs.state.contentSha256, sha(content), "the same computation the context assembler performs");
});

test("isolation: two workspaces mutate independently", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "base\n" });
  const first = await allocate(a, source);
  const second = await allocate(a, source);

  const obs = await observe(a, first, "src/a.ts");
  assert.ok((await a.mutations.mutate({ runId: RUN, workspace: first, observation: obs, operation: { kind: "replace", content: bytes("first\n") } })).ok);

  assert.equal(readFileSync(join(first.path, "src/a.ts"), "utf8"), "first\n");
  assert.equal(readFileSync(join(second.path, "src/a.ts"), "utf8"), "base\n", "the sibling candidate is unaffected");
  assert.equal(readFileSync(join(source, "src/a.ts"), "utf8"), "base\n");
});

test("workspace: a mutation record is content-addressed and frozen", async () => {
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "x\n" }));
  const obs = await observe(a, ws, "src/a.ts");
  const result = await a.mutations.mutate({ runId: RUN, workspace: ws, observation: obs, operation: { kind: "replace", content: bytes("y\n") } });
  assert.ok(result.ok);
  assert.ok(Object.isFrozen(result.record));
  assert.equal(result.record.observationId, obs.observationId, "the record names the capability that authorized it");
  assert.equal(result.record.workspaceId, ws.workspaceId as V2WorkspaceId);
  assert.match(result.record.mutationId, /^[0-9a-f]{64}$/);
});

// ── V2-016A/M3 cross-audit: a RETAINED workspace is still reclaimable on disk ──

test("V2-016A/M3: retain keeps the worktree AND the live handle, so a later discard REALLY reclaims it", async () => {
  const { existsSync } = await import("node:fs");
  const a = authorities();
  const ws = await allocate(a, repo({ "src/a.ts": "x\n" }));
  assert.ok(existsSync(ws.path), "the worktree exists after allocation");

  // RETAIN — the donor keeps the worktree on disk; the v2 adapter KEEPS the live handle (M3 fix).
  const retained = await a.workspaces.retain(ws, "superseded attempt");
  assert.equal(retained.kind, "retained");
  assert.ok(existsSync(ws.path), "retain does NOT delete the worktree (kept for inspection)");

  // DISCARD LATER — this must ACTUALLY reclaim the worktree from disk (the M3 bug: it failed with
  // 'no live handle'). Now it succeeds and the directory is gone.
  const discarded = await a.workspaces.discard(ws);
  assert.equal(discarded.kind, "discarded", `discard must reclaim a retained workspace, got ${JSON.stringify(discarded)}`);
  assert.equal(existsSync(ws.path), false, "the superseded worktree was really removed from disk");
});

test("V2-016A/M3: a workspace can be retained and then discarded across a REAL 2-workspace session shape", async () => {
  const a = authorities();
  const source = repo({ "src/a.ts": "x\n" });
  const { existsSync } = await import("node:fs");
  // Two attempts' worktrees; the first is superseded (retained then reclaimed), the second kept.
  const superseded = await allocate(a, source);
  const final = await allocate(a, source);
  await a.workspaces.retain(superseded, "superseded");
  await a.workspaces.retain(final, "final — verified");
  // Session cleanup reclaims ONLY the superseded one.
  assert.equal((await a.workspaces.discard(superseded)).kind, "discarded");
  assert.equal(existsSync(superseded.path), false, "superseded worktree reclaimed");
  assert.ok(existsSync(final.path), "the final attempt's worktree is preserved on disk");
});
