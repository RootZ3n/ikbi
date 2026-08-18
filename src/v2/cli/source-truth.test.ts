/**
 * SOURCE TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * The headline: a DIRTY repository is no longer an ambiguity. Through the real built CLI,
 * with uncommitted work in the source checkout, ikbi must show that one source state to
 * the model, start the candidate workspace from the same one, leave the operator's
 * checkout untouched, and never call reproducing their existing work a mutation.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { V2RunResult } from "../core/result.js";
import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderServer } from "./fake-provider-server.js";
import { initGitRepo, writeFiles } from "./fixture-repo.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
const GOAL = "acknowledge src/a.ts";

const PROVIDER: FakeProviderServer = await startFakeOpenAIProvider();
const dirs: string[] = [];

after(async () => {
  await PROVIDER.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ROSTER = {
  providers: [{ id: "p1", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true }],
  models: [
    {
      id: "m1",
      role: "builder",
      cost: { promptPerMTok: 0, completionPerMTok: 0 },
      providers: [{ provider: "p1", providerModelId: "m1-wire" }],
      capabilities: { context_window: 100000, supports_tools: true },
    },
  ],
};

function makeStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-srcstate-"));
  dirs.push(root);
  writeFileSync(join(root, "providers.json"), JSON.stringify(ROSTER, null, 2));
  return root;
}

/** A committed repository: AGENTS.md plus `src/a.ts` containing "A". */
function makeRepo(files: Readonly<Record<string, string>> = {}): string {
  const repo = initGitRepo({ "AGENTS.md": "# conventions\nBe terse.\n", "src/a.ts": 'export const a = "A";\n', ...files });
  dirs.push(repo);
  return repo;
}

function runCli(root: string, args: readonly string[]) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-srccwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-srchome-")),
      IKBI_STATE_ROOT: root,
      IKBI_MODEL_DRIVER: "m1",
      IKBI_MODEL_BUILDER: "m1",
      IKBI_MODEL_CRITIC: "m1",
      ...loopbackEgressEnv(PROVIDER),
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function v2Run(root: string, repo: string, goal = GOAL) {
  const r = runCli(root, ["v2", "build", goal, "--repo", repo, "--json"]);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { result: JSON.parse(r.stdout) as V2RunResult, stdout: r.stdout, status: r.status };
}

const sha = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const gitStatus = (repo: string): string => execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
const artifactAt = (result: V2RunResult, path: string) => result.context?.artifacts.find((a) => a.path === path);

test("source truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── clean, unchanged ────────────────────────────────────────────────────────

test("source truth: a CLEAN repository behaves exactly as before", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const { result } = v2Run(state, repo);

  assert.equal(result.receipt.evidence.sourceSnapshotCaptured, true);
  assert.equal(result.receipt.evidence.sourceSnapshots, 1);
  assert.equal(result.receipt.sourceSnapshot?.clean, true);
  assert.equal(result.receipt.workspace?.materializedEntries, 0, "a clean worktree already matches HEAD");
  assert.equal(result.receipt.evidence.mutationsApplied, 0);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented", "it stops for the ordinary reason");
  assert.equal(gitStatus(repo), "", "the source is untouched");
});

// ── THE headline: a dirty tracked file ──────────────────────────────────────

test("source truth: a DIRTY tracked file flows end to end — context, workspace, no drift", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const dirty = 'export const a = "B-uncommitted";\n';
  writeFiles(repo, { "src/a.ts": dirty });

  const { result } = v2Run(state, repo);

  // 1. The snapshot records what the OPERATOR sees, not what is committed.
  const snap = result.receipt.sourceSnapshot!;
  assert.equal(snap.clean, false);
  assert.equal(snap.counts.modified, 1);

  // 2. The context artifact carries the dirty bytes.
  assert.equal(artifactAt(result, "src/a.ts")?.observedSha256, sha(dirty), "the model was shown B");

  // 3. Context and workspace agree on ONE source reality.
  assert.equal(result.context?.sourceSnapshotId, snap.snapshotId);
  assert.equal(result.receipt.workspace?.sourceSnapshotId, snap.snapshotId);
  assert.equal(result.receipt.workspace?.materializedEntries, 1, "the delta was reproduced in isolation");

  // 4. The workspace observation hashed the SAME bytes — the drift failure is gone.
  assert.equal(result.receipt.evidence.observationsTaken, 1);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented", "no context_artifact_drift");

  // 5. Reproducing the operator's own work is NOT a model mutation.
  assert.equal(result.receipt.evidence.mutationsApplied, 0);
  assert.equal(result.receipt.evidence.candidatesCreated, 0);
  assert.equal(result.receipt.evidence.repositoryMutated, false);

  // 6. And the operator's checkout is exactly as they left it.
  assert.equal(execFileSync("cat", [join(repo, "src/a.ts")], { encoding: "utf8" }), dirty);
  assert.match(gitStatus(repo), /^ M src\/a\.ts$/m, "still dirty, still theirs");
});

test("source truth: the dirty snapshot id DIFFERS from the clean one at the same HEAD", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const clean = v2Run(state, repo).result.receipt.sourceSnapshot!;
  writeFiles(repo, { "src/a.ts": 'export const a = "B";\n' });
  const dirty = v2Run(state, repo).result.receipt.sourceSnapshot!;

  assert.equal(clean.headCommit, dirty.headCommit, "the same commit");
  assert.notEqual(clean.snapshotId, dirty.snapshotId, "but a different source state");
});

test("source truth: two runs over two dirty states get different snapshots AND bindings", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  writeFiles(repo, { "src/a.ts": 'export const a = "B";\n' });
  const first = v2Run(state, repo).result;
  writeFiles(repo, { "src/a.ts": 'export const a = "C";\n' });
  const second = v2Run(state, repo).result;

  assert.notEqual(first.receipt.sourceSnapshot?.snapshotId, second.receipt.sourceSnapshot?.snapshotId);
  assert.notEqual(first.receipt.workspace?.sourceSnapshotId, second.receipt.workspace?.sourceSnapshotId);
  assert.equal(first.receipt.workspace?.baseCommit, second.receipt.workspace?.baseCommit, "same ancestry, different starting state");
});

// ── deletion / untracked / ignored ──────────────────────────────────────────

test("source truth: a DELETED tracked file is absent from the run's source", () => {
  const state = makeStateRoot();
  const repo = makeRepo({ "src/doomed.ts": "export const doomed = 1;\n" });
  rmSync(join(repo, "src/doomed.ts"));

  const { result } = v2Run(state, repo, "acknowledge src/doomed.ts");
  assert.equal(result.receipt.sourceSnapshot?.counts.deleted, 1);
  // The goal names it, so context tried — and truthfully found it absent.
  assert.equal(result.context?.omissions.find((o) => o.path === "src/doomed.ts")?.reason, "not_found");
  assert.equal(result.receipt.evidence.mutationsApplied, 0);
});

test("source truth: an UNTRACKED source file is part of the run and reaches the workspace", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const body = 'export const fresh = "NEW-UNTRACKED";\n';
  writeFiles(repo, { "src/new.ts": body });

  const { result } = v2Run(state, repo, "acknowledge src/new.ts");
  assert.equal(result.receipt.sourceSnapshot?.counts.untrackedIncluded, 1);
  assert.equal(artifactAt(result, "src/new.ts")?.observedSha256, sha(body), "uncommitted new work is not invisible");
  assert.equal(result.receipt.workspace?.materializedEntries, 1);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented", "and it re-observed cleanly in the workspace");
});

test("source truth: an IGNORED file is neither snapshotted nor materialized", () => {
  const state = makeStateRoot();
  const repo = makeRepo({ ".gitignore": "dist/\n" });
  writeFiles(repo, { "dist/junk.js": "generated\n" });

  const { result } = v2Run(state, repo);
  assert.equal(result.receipt.sourceSnapshot?.clean, true, "build debris does not make a checkout dirty");
  assert.equal(result.receipt.workspace?.materializedEntries, 0, "and it is not copied into isolation");
});

test("source truth: HEAD=A, index=B, working tree=C — the run sees C", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  writeFiles(repo, { "src/a.ts": 'export const a = "B";\n' });
  execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
  const seen = 'export const a = "C";\n';
  writeFiles(repo, { "src/a.ts": seen });

  const { result } = v2Run(state, repo);
  assert.equal(artifactAt(result, "src/a.ts")?.observedSha256, sha(seen), "what the operator sees, not what is staged");
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented", "and the workspace agrees");
});

// ── boundaries ──────────────────────────────────────────────────────────────

test("source truth: materialization is NOT counted as a mutation, however dirty the source", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  writeFiles(repo, {
    "src/a.ts": 'export const a = "modified";\n',
    "src/added.ts": "export const added = 1;\n",
    "src/second.ts": "export const second = 2;\n",
  });

  const { result } = v2Run(state, repo);
  assert.equal(result.receipt.workspace?.materializedEntries, 3, "three source entries reproduced");
  const e = result.receipt.evidence;
  assert.equal(e.mutationsApplied, 0, "and zero mutations");
  assert.equal(e.candidatesCreated, 0);
  assert.equal(e.repositoryMutated, false);
});

test("source truth: exactly ONE snapshot, and the whole spine agrees on it", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  writeFiles(repo, { "src/a.ts": 'export const a = "B";\n' });
  const { result } = v2Run(state, repo);

  const id = result.receipt.sourceSnapshot!.snapshotId;
  assert.equal(result.receipt.evidence.sourceSnapshots, 1);
  assert.equal(result.context?.sourceSnapshotId, id, "context came from it");
  assert.equal(result.receipt.workspace?.sourceSnapshotId, id, "the workspace was materialized from it");
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "invocation", "candidate_strategy"]);
});

test("source truth: the human rendering states the snapshot and what was materialized", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  writeFiles(repo, { "src/a.ts": 'export const a = "B";\n' });
  const r = runCli(state, ["v2", "build", GOAL, "--repo", repo]);
  assert.match(r.stdout, /snapshot {4}[0-9a-f]{64} · dirty @ [0-9a-f]{12} · \+1 modified, 0 deleted, 0 untracked/);
  assert.match(r.stdout, /materialized 1 source entry from the snapshot/);
});
