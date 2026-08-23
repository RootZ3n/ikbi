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

import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderServer } from "./fake-provider-server.js";
import { commitFiles, headCommit, headTree, initGitRepo, writeFiles } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

const MARKER = "MARKER-workspace-observed-this";
const GOAL = "acknowledge src/widget.ts";

const PROVIDER: FakeProviderServer = await startFakeOpenAIProvider();
const dirs: string[] = [];
const extraServers: FakeProviderServer[] = [];

after(async () => {
  await PROVIDER.close();
  for (const server of extraServers) await server.close();
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
      // CONTAINMENT. A spawned child that inherits no TMPDIR falls back to the system temp directory, and every
      // fixture it makes there escapes the run root the wrapper cleans up. Forwarded explicitly
      // because this env is an allowlist — the child gets nothing that is not named here.
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      // THE GOVERNED TEMPORARY ROOT, forwarded explicitly. A child that resolved its own would
      // pick a different one (it sets its own IKBI_STATE_ROOT), and scratch would then scatter
      // across roots that no single wrapper cleans up.
      ...(process.env.IKBI_TEMP_ROOT !== undefined ? { IKBI_TEMP_ROOT: process.env.IKBI_TEMP_ROOT } : {}),
      ...(process.env.IKBI_TEMP_RUN_ID !== undefined ? { IKBI_TEMP_RUN_ID: process.env.IKBI_TEMP_RUN_ID } : {}),
      // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
      // and must not depend on the operator's untracked `.env` to start.
      ...HERMETIC_DEV_KEY_ENV,
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

/**
 * A provider that only ever talks — it never emits a tool call, so the builder nudges,
 * exhausts its turns and produces no candidate. Its own server, because this suite's
 * shared one deliberately finishes immediately.
 */
async function proseOnlyProvider(): Promise<FakeProviderServer> {
  const server = await startFakeOpenAIProvider({ content: "I am still thinking about it." });
  extraServers.push(server);
  return server;
}

/** Run the CLI against a specific provider rather than the suite's shared one. */
function v2RunAgainst(server: FakeProviderServer, root: string, repo: string, goal = GOAL) {
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify({ ...ROSTER, providers: [{ ...ROSTER.providers[0], baseUrl: server.baseUrl }] }, null, 2),
  );
  const res = spawnSync(process.execPath, [ENTRY, "v2", "build", "--allow-repo-wide", goal, "--repo", repo, "--json"], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-wscwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
      // and must not depend on the operator's untracked `.env` to start.
      ...HERMETIC_DEV_KEY_ENV,
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-wshome-")),
      IKBI_STATE_ROOT: root,
      IKBI_MODEL_DRIVER: "m1",
      IKBI_MODEL_BUILDER: "m1",
      IKBI_MODEL_CRITIC: "m1",
      ...loopbackEgressEnv(server),
    },
    encoding: "utf8",
  });
  assert.ok(res.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${res.stdout}\n---\n${res.stderr}`);
  return { result: sessionFinalAttempt(res.stdout) };
}

function v2Run(root: string, repo: string, goal = GOAL) {
  const r = runCli(root, ["v2", "build", "--allow-repo-wide", goal, "--repo", repo, "--json"]);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { result: sessionFinalAttempt(r.stdout), stdout: r.stdout, stderr: r.stderr, status: r.status };
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

  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition"]);
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
  assert.ok(result.outcome.kind === "withheld", "so the run stops for the ordinary reason");
});

test("workspace truth: an UNCOMMITTED source change no longer causes drift (V2-006A)", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  // This used to fail: context read the working tree while the workspace held HEAD.
  // Both now come from the one source snapshot, so the run proceeds normally.
  writeFiles(repo, { "src/widget.ts": "export const widget = 999; // uncommitted\n" });
  const { result } = v2Run(state, repo);
  assert.ok(result.outcome.kind === "withheld", "it stops for the ordinary reason");
  assert.equal(result.receipt.sourceSnapshot?.clean, false);
  assert.equal(result.receipt.workspace?.materializedEntries, 1, "the operator's edit was reproduced in isolation");
  assert.equal(result.receipt.evidence.mutationsApplied, 0, "and reproducing it is not a mutation");
});

test("workspace truth: committing that change makes the run proceed again", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  commitFiles(repo, { "src/widget.ts": "export const widget = 2;\n" }, "committed");
  const { result } = v2Run(state, repo);
  assert.ok(result.outcome.kind === "withheld", "the candidate is adjudicated and withheld");
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
  assert.equal(e.candidatesCreated, 1, "the builder finished, so a candidate exists — unverified");
  assert.equal(e.sourceRepositoryMutated, false);
  assert.equal(e.promoted, false);
  assert.equal(e.verificationsPerformed, 1, "V2-008: the candidate WAS verified (no_checks)");

  assert.equal(gitStatus(repo), before, "the source working tree is unchanged");
  assert.equal(headCommit(repo), head, "and so is HEAD");
  assert.ok(result.outcome.kind === "withheld", "adjudicated and withheld");
  assert.equal(result.receipt.stagesEntered.includes("promotion"), false, "stops before promotion");
});

test("workspace truth: the source repository gains no stray files or branches", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const filesBefore = readdirSync(repo).sort();
  v2Run(state, repo);
  assert.deepEqual(readdirSync(repo).sort(), filesBefore, "no scratch directory was created in the source repo");
});

// ── cleanup ─────────────────────────────────────────────────────────────────

test("workspace truth: the workspace is RETAINED once a candidate exists (V2-007)", () => {
  // Until a builder existed, a workspace was always discarded because nothing was ever
  // produced in one. A candidate is the only copy of the work the run just paid for, and
  // it is what verification will inspect — so retention is the honest disposition.
  const state = makeStateRoot();
  const { result } = v2Run(state, makeRepo());
  assert.equal(result.receipt.workspace?.disposition, "retained");
  assert.match(result.receipt.workspace?.dispositionDetail ?? "", /adjudicated withhold/);
  // RETENTION IS NOT PROMOTION.
  assert.equal(result.receipt.evidence.promoted, false);
  assert.equal(result.receipt.evidence.sourceRepositoryMutated, false);
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

test("workspace truth: a workspace with NO candidate never outlives its run", async () => {
  const state = makeStateRoot();
  // A model that never finishes: the builder exhausts its turns and no candidate exists,
  // so the half-built tree is not left behind.
  const { result } = await v2RunAgainst(await proseOnlyProvider(), state, makeRepo());
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "build");
  assert.equal(result.receipt.candidate, undefined);
  assert.equal(result.receipt.workspace?.disposition, "discarded");
});

// ── observations only where they are real ───────────────────────────────────

test("workspace truth: a repo with no instructions and no named target yields ZERO observations", () => {
  const state = makeStateRoot();
  const repo = initGitRepo({ "src/other.ts": "export const other = 1;\n" });
  dirs.push(repo);
  const { result } = v2Run(state, repo, "do something unnamed");
  assert.equal(result.receipt.evidence.workspacesAllocated, 1, "a workspace is still allocated");
  assert.equal(result.receipt.evidence.observationsTaken, 0, "but no probe file was invented to look at");
  assert.ok(result.outcome.kind === "withheld", "the candidate is adjudicated and withheld");
});

test("workspace truth: the human rendering states the source binding and the disposition", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const r = runCli(state, ["v2", "build", "--allow-repo-wide", GOAL, "--repo", repo]);
  assert.match(r.stdout, /workspace {3}ws_[\w-]+ \(donor [\w-]+\) · 1 observation\(s\) · retained/);
  assert.match(r.stdout, new RegExp(`materialized 0 source entries from the snapshot · base main @ ${headCommit(repo).slice(0, 12)}`));
});
