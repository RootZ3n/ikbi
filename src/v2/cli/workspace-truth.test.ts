/**
 * WORKSPACE TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * Through the real built CLI: one isolated workspace is allocated, bound to the exact
 * source commit and tree, the context artifact is re-observed inside it through the
 * canonical state-bound authority, nothing is written, and the workspace is discarded.
 *
 * The point of this suite is the NEGATIVE half. A workspace existing is not a candidate
 * existing, an observation is not a mutation, and the receipt has to keep saying so.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { V2RunResult } from "../core/result.js";
import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderServer } from "./fake-provider-server.js";
import { commitFiles, headCommit, headTree, initGitRepo, writeFiles } from "./fixture-repo.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

const MARKER = "MARKER-workspace-observed-this";
const GOAL = "acknowledge src/widget.ts";

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
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-wsstate-"));
  dirs.push(root);
  writeFileSync(join(root, "providers.json"), JSON.stringify(ROSTER, null, 2));
  return root;
}

function makeRepo(files: Readonly<Record<string, string>> = {}): string {
  const repo = initGitRepo({
    "AGENTS.md": `# conventions\n${MARKER}\n`,
    "src/widget.ts": "export const widget = 1;\n",
    ...files,
  });
  dirs.push(repo);
  return repo;
}

function runCli(root: string, args: readonly string[]) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-wscwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-wshome-")),
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
  return { result: JSON.parse(r.stdout) as V2RunResult, stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const gitStatus = (repo: string): string => execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });

test("workspace truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── allocation + binding ────────────────────────────────────────────────────

test("workspace truth: candidate_strategy allocates ONE workspace bound to the run and source", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const { result } = v2Run(state, repo);

  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "invocation", "candidate_strategy"]);
  assert.equal(result.receipt.evidence.workspacesAllocated, 1, "the SINGLE strategy allocates exactly one");

  const ws = result.receipt.workspace!;
  assert.equal(ws.baseCommit, headCommit(repo), "the exact source commit");
  assert.equal(ws.baseTree, headTree(repo), "and the exact source tree");
  assert.equal(ws.baseBranch, "main");
  assert.ok(ws.donorWorkspaceId.length > 0, "the donor id is carried so `ikbi workspace ls` can find it");
});

test("workspace truth: the context artifact is RE-OBSERVED in the workspace and matches", () => {
  const state = makeStateRoot();
  const { result } = v2Run(state, makeRepo());
  assert.equal(result.receipt.evidence.observationsTaken, 1);
  assert.equal(result.receipt.workspace?.observations, 1);
  // The observation succeeded, which means the workspace bytes equalled the bytes the
  // context package recorded — the reconciliation a future builder depends on.
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented", "so the run stops for the ordinary reason");
});

test("workspace truth: an UNCOMMITTED source change is reported as context drift, not papered over", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  // The context assembler reads the WORKING TREE; the workspace is a worktree at HEAD.
  // An uncommitted edit makes those disagree, and v2 refuses rather than silently
  // rebuilding context against whatever is in the workspace.
  writeFiles(repo, { "src/widget.ts": "export const widget = 999; // uncommitted\n" });
  const { result } = v2Run(state, repo);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "mutation");
  assert.equal(result.outcome.failure.code, "workspace.context_artifact_drift");
  assert.equal(result.outcome.failure.detail?.path, "src/widget.ts");
});

test("workspace truth: committing that change makes the run proceed again", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  commitFiles(repo, { "src/widget.ts": "export const widget = 2;\n" }, "committed");
  const { result } = v2Run(state, repo);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented");
  assert.equal(result.receipt.workspace?.baseCommit, headCommit(repo), "bound to the NEW head");
});

// ── nothing was produced ────────────────────────────────────────────────────

test("workspace truth: a workspace is NOT a candidate, and NOTHING was written", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const before = gitStatus(repo);
  const head = headCommit(repo);

  const { result } = v2Run(state, repo);
  const e = result.receipt.evidence;
  assert.equal(e.workspacesAllocated, 1);
  assert.equal(e.observationsTaken, 1);
  assert.equal(e.mutationsApplied, 0, "the production skeleton performs NO mutation");
  assert.equal(e.candidatesCreated, 0, "a workspace existing is not a candidate existing");
  assert.equal(e.repositoryMutated, false);
  assert.equal(e.promoted, false);
  assert.equal(e.verificationsPerformed, 0);

  assert.equal(gitStatus(repo), before, "the source working tree is unchanged");
  assert.equal(headCommit(repo), head, "and so is HEAD");
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.detail?.missingStage, "candidate_generation");
});

test("workspace truth: the source repository gains no stray files or branches", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const filesBefore = readdirSync(repo).sort();
  v2Run(state, repo);
  assert.deepEqual(readdirSync(repo).sort(), filesBefore, "no scratch directory was created in the source repo");
});

// ── cleanup ─────────────────────────────────────────────────────────────────

test("workspace truth: the workspace is DISCARDED at the normal stop", () => {
  const state = makeStateRoot();
  const { result } = v2Run(state, makeRepo());
  assert.equal(result.receipt.workspace?.disposition, "discarded", "nothing useful was produced, so nothing is kept");
  assert.equal(result.receipt.workspace?.dispositionDetail, undefined);
});

test("workspace truth: the worktree is really gone from disk afterwards", () => {
  const state = makeStateRoot();
  v2Run(state, makeRepo());
  // The donor manager keeps worktrees under <stateRoot>/workspaces. After a discard the
  // scratch directory must not still be holding a checkout.
  const scratch = join(state, "workspaces");
  const leftovers = existsSync(scratch)
    ? readdirSync(scratch).filter((entry) => entry !== "registry" && existsSync(join(scratch, entry, "AGENTS.md")))
    : [];
  assert.deepEqual(leftovers, [], "a discarded workspace leaves no checkout behind");
});

test("workspace truth: a FAILING run still cleans up its workspace", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  writeFiles(repo, { "src/widget.ts": "uncommitted drift\n" });
  const { result } = v2Run(state, repo);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "workspace.context_artifact_drift");
  assert.equal(result.receipt.workspace?.disposition, "discarded", "an allocated workspace never outlives its run");
});

// ── observations only where they are real ───────────────────────────────────

test("workspace truth: a repo with no instructions and no named target yields ZERO observations", () => {
  const state = makeStateRoot();
  const repo = initGitRepo({ "src/other.ts": "export const other = 1;\n" });
  dirs.push(repo);
  const { result } = v2Run(state, repo, "do something unnamed");
  assert.equal(result.receipt.evidence.workspacesAllocated, 1, "a workspace is still allocated");
  assert.equal(result.receipt.evidence.observationsTaken, 0, "but no probe file was invented to look at");
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented");
});

test("workspace truth: the human rendering states the source binding and the disposition", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const r = runCli(state, ["v2", "build", GOAL, "--repo", repo]);
  assert.match(r.stdout, /workspace {3}ws_[\w-]+ \(donor [\w-]+\) · 1 observation\(s\) · discarded/);
  assert.match(r.stdout, new RegExp(`source {6}main @ ${headCommit(repo).slice(0, 12)} · tree ${headTree(repo).slice(0, 12)}`));
});
