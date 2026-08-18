/**
 * CONTEXT TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * The hostile test for the class of defect this project keeps finding: a subsystem that
 * exists, has tests, and that production quietly ignores.
 *
 * A fixture repository carries three uniquely-marked files — an AGENTS.md, a source file
 * the goal names, and an unrelated file nothing should look at. The REAL `ikbi v2 build`
 * binary runs against it, and the emitted manifest must show exactly the artifacts the
 * priority policy says, each bound to the exact bytes on disk. Then each marker is
 * changed in turn and the package identity must move — or not — accordingly.
 *
 * It fails if repository instructions never reach the assembler, if the CLI fabricates a
 * package, if an unrelated file is silently swept in, if the package is not bound to the
 * resolution that sized it, or if anything overflows without saying so.
 *
 * No model is invoked and nothing is written.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { V2RunResult } from "../core/result.js";
import { loopbackEgressEnv, startFakeOpenAIProvider } from "./fake-provider-server.js";
import { initGitRepo } from "./fixture-repo.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

const MARKER_A = "MARKER-A-repository-instructions";
const MARKER_B = "MARKER-B-the-file-the-goal-names";
const MARKER_C = "MARKER-C-nothing-should-read-this";

const GOAL = "make src/widget.ts do the thing";

/** One keyless provider and one model with a DECLARED window, so the budget is factual. */
const PROVIDER = await startFakeOpenAIProvider();
after(() => PROVIDER.close());

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

const roots: string[] = [];
const repos: string[] = [];

function makeStateRoot(roster: unknown = ROSTER): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-ctxstate-"));
  roots.push(root);
  writeFileSync(join(root, "providers.json"), JSON.stringify(roster, null, 2));
  return root;
}

/** A git repository carrying the three markers. */
function makeRepo(over: Partial<Record<"agents" | "widget" | "unrelated", string>> = {}): string {
  // A REAL git repository with everything COMMITTED: V2-006 allocates a worktree from
  // HEAD and re-observes the context artifact there, so an uncommitted file would be
  // (correctly) reported as drift.
  const repo = initGitRepo({
    "AGENTS.md": over.agents ?? `# conventions\n${MARKER_A}\n`,
    "src/widget.ts": over.widget ?? `export const widget = "${MARKER_B}";\n`,
    "src/unrelated.ts": over.unrelated ?? `export const other = "${MARKER_C}";\n`,
  });
  repos.push(repo);
  return repo;
}

function runCli(stateRoot: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-ctxcwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-ctxhome-")),
      IKBI_STATE_ROOT: stateRoot,
      // Pin the operator layer at the fixture model so the budget is this suite's, not
      // this machine's. No profile is involved.
      IKBI_MODEL_DRIVER: "m1",
      IKBI_MODEL_BUILDER: "m1",
      IKBI_MODEL_CRITIC: "m1",
      ...loopbackEgressEnv(PROVIDER),
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function v2Run(stateRoot: string, repo: string, goal = GOAL): { result: V2RunResult; stdout: string; stderr: string; status: number | null } {
  const r = runCli(stateRoot, ["v2", "build", goal, "--repo", repo, "--json"]);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { result: JSON.parse(r.stdout) as V2RunResult, stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const sha = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const artifactAt = (result: V2RunResult, path: string) => result.context?.artifacts.find((a) => a.path === path);

after(() => {
  for (const dir of [...roots, ...repos]) rmSync(dir, { recursive: true, force: true });
});

test("context truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── THE hostile test ────────────────────────────────────────────────────────

test("context truth: the package contains exactly what the policy says, bound to real bytes", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const { result } = v2Run(state, repo);
  const ctx = result.context!;

  // Priority order: the goal, then repository instructions, then the named file.
  assert.deepEqual(ctx.artifacts.map((a) => a.category), ["task", "repository_instructions", "target_file"]);
  assert.deepEqual(ctx.artifacts.map((a) => a.path ?? "(task)"), ["(task)", "AGENTS.md", "src/widget.ts"]);

  // Each artifact names the EXACT bytes on disk — this is the state binding.
  assert.equal(artifactAt(result, "AGENTS.md")?.observedSha256, sha(`# conventions\n${MARKER_A}\n`));
  assert.equal(artifactAt(result, "src/widget.ts")?.observedSha256, sha(`export const widget = "${MARKER_B}";\n`));

  // The unrelated file was never looked at — not admitted, and not omitted either,
  // because no source ever offered it.
  assert.equal(ctx.artifacts.some((a) => a.path === "src/unrelated.ts"), false);
  assert.equal(ctx.omissions.some((o) => o.path === "src/unrelated.ts"), false);

  // Bodies are not republished into the manifest.
  for (const marker of [MARKER_A, MARKER_B, MARKER_C]) {
    assert.equal(JSON.stringify(ctx).includes(marker), false, `${marker} was reproduced into the manifest`);
  }
});

test("context truth: changing the INSTRUCTIONS marker changes the package identity", () => {
  const state = makeStateRoot();
  const before = v2Run(state, makeRepo()).result.context!.packageId;
  const after_ = v2Run(state, makeRepo({ agents: `# conventions\n${MARKER_A}-CHANGED\n` })).result.context!.packageId;
  assert.notEqual(before, after_);
});

test("context truth: changing the TARGET FILE marker changes the package identity", () => {
  const state = makeStateRoot();
  const before = v2Run(state, makeRepo()).result.context!.packageId;
  const after_ = v2Run(state, makeRepo({ widget: `export const widget = "${MARKER_B}-CHANGED";\n` })).result.context!.packageId;
  assert.notEqual(before, after_);
});

test("context truth: changing an UNSELECTED file does NOT change the package identity", () => {
  const state = makeStateRoot();
  const before = v2Run(state, makeRepo()).result.context!.packageId;
  const after_ = v2Run(state, makeRepo({ unrelated: `export const other = "${MARKER_C}-CHANGED";\n` })).result.context!.packageId;
  assert.equal(before, after_, "context identity reflects what was included, not what exists");
});

test("context truth: REMOVING a source's contribution changes the accounting truthfully", () => {
  const state = makeStateRoot();
  const withInstructions = v2Run(state, makeRepo()).result.context!;
  // A repo with no AGENTS.md: the artifact disappears, and it is not recorded as an
  // omission — an optional instruction file that simply is not there was never dropped.
  const repo = makeRepo();
  rmSync(join(repo, "AGENTS.md"));
  const without = v2Run(state, repo).result.context!;
  assert.equal(without.artifacts.some((a) => a.path === "AGENTS.md"), false);
  assert.equal(without.omissions.some((o) => o.path === "AGENTS.md"), false);
  assert.notEqual(withInstructions.packageId, without.packageId);
  assert.equal(without.artifacts.length, withInstructions.artifacts.length - 1);
});

test("context truth: a goal naming a file the repo LACKS records an omission", () => {
  const state = makeStateRoot();
  const { result } = v2Run(state, makeRepo(), "rewrite src/ghost.ts entirely");
  const omission = result.context?.omissions.find((o) => o.path === "src/ghost.ts");
  assert.ok(omission !== undefined, "the builder must be told the goal names a missing file");
  assert.equal(omission.reason, "not_found");
});

// ── identity + binding ──────────────────────────────────────────────────────

test("context truth: the package is bound to the run, task and the resolution that sized it", () => {
  const state = makeStateRoot();
  const { result } = v2Run(state, makeRepo());
  const ctx = result.context!;
  assert.equal(ctx.runId, result.runId);
  assert.equal(ctx.taskId, result.taskId);
  assert.equal(ctx.resolutionDecisionId, result.decision!.decisionId);
  assert.equal(ctx.budget.contextWindowTokens, 100_000, "the budget came from the resolved model's declared window");
  assert.equal(ctx.budget.estimated, true);
  assert.equal(ctx.packageId, result.receipt.context!.packageId);
});

test("context truth: the same repository and task reproduce the same package id across processes", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  assert.equal(v2Run(state, repo).result.context!.packageId, v2Run(state, repo).result.context!.packageId);
});

test("context truth: a different model window changes the budget and the package id", () => {
  const repo = makeRepo();
  const narrow = makeStateRoot({
    ...ROSTER,
    models: [{ ...ROSTER.models[0], capabilities: { context_window: 32000, supports_tools: true } }],
  });
  const wide = makeStateRoot();
  const a = v2Run(narrow, repo).result.context!;
  const b = v2Run(wide, repo).result.context!;
  assert.notEqual(a.budget.availableInputTokens, b.budget.availableInputTokens);
  assert.notEqual(a.packageId, b.packageId, "a different budget is a different authorization");
});

test("context truth: an UNCLASSIFIED model fails context rather than guessing a budget", () => {
  const state = makeStateRoot({
    providers: ROSTER.providers,
    models: [{ id: "m1", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p1", providerModelId: "m1-wire" }] }],
  });
  const { result, status } = v2Run(state, makeRepo());
  assert.notEqual(status, 0);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "context");
  assert.equal(result.outcome.failure.code, "context.model_capability_unknown");
  assert.equal(result.context, undefined, "no package is invented");
  assert.equal(result.receipt.evidence.contextAssemblyCompleted, false);
});

// ── no silent overflow ──────────────────────────────────────────────────────

test("context truth: an oversized repository file is OMITTED with a recorded reason", () => {
  // A tiny window plus a large instruction file: the file cannot fit, and the run must
  // say so rather than quietly shipping a smaller context.
  const state = makeStateRoot({
    ...ROSTER,
    models: [{ ...ROSTER.models[0], capabilities: { context_window: 4000, supports_tools: true } }],
  });
  const repo = makeRepo({ agents: `${MARKER_A}\n${"padding ".repeat(3000)}` });
  const { result } = v2Run(state, repo);
  const ctx = result.context!;
  const omission = ctx.omissions.find((o) => o.path === "AGENTS.md");
  assert.ok(omission !== undefined, "the omission is recorded");
  assert.equal(omission.reason, "budget_exceeded");
  assert.ok((omission.estimatedTokens ?? 0) > 0);
  assert.ok(ctx.estimatedInputTokens <= ctx.budget.availableInputTokens, "the package never exceeds its budget");
});

test("context truth: a file over the byte cap is truncated, flagged, and still state-bound", () => {
  const state = makeStateRoot();
  const body = `${MARKER_A}\n${"z".repeat(20_000)}`;
  const repo = makeRepo({ agents: body });
  const artifact = artifactAt(v2Run(state, repo).result, "AGENTS.md")!;
  assert.equal(artifact.truncated, true);
  assert.equal(artifact.originalBytes, Buffer.byteLength(body, "utf8"));
  assert.ok(artifact.bytes < artifact.originalBytes);
  assert.equal(artifact.observedSha256, sha(body), "the digest names the whole observed file");
});

// ── safety + boundaries ─────────────────────────────────────────────────────

test("context truth: a symlink escaping the repository is refused and recorded", () => {
  const state = makeStateRoot();
  const outside = mkdtempSync(join(tmpdir(), "ikbi-v2-ctxout-"));
  repos.push(outside);
  writeFileSync(join(outside, "secret.md"), "OUTSIDE-SECRET-CONTENT");
  const repo = makeRepo();
  rmSync(join(repo, "AGENTS.md"));
  symlinkSync(join(outside, "secret.md"), join(repo, "AGENTS.md"));
  const { result, stdout } = v2Run(state, repo);
  assert.equal(stdout.includes("OUTSIDE-SECRET-CONTENT"), false, "nothing outside the repository was read");
  const omission = result.context?.omissions.find((o) => o.path === "AGENTS.md");
  assert.equal(omission?.reason, "outside_repository");
});

test("context truth: exactly ONE package, exactly one invocation, and nothing written", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const before = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  const { result } = v2Run(state, repo);
  assert.equal(result.receipt.evidence.contextPackages, 1);
  assert.equal(result.receipt.evidence.contextAssemblyCompleted, true);
  assert.equal(result.receipt.evidence.providerInvoked, true, "V2-005: the route was really called");
  assert.equal(result.receipt.evidence.invocations, 1);
  assert.equal(result.receipt.evidence.candidatesCreated, 0);
  assert.equal(result.receipt.evidence.repositoryMutated, false);
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "invocation", "candidate_strategy"]);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout, before.stdout, "the repo is untouched");
});

test("context truth: the sources consulted are named, and they are the production two", () => {
  const state = makeStateRoot();
  const { result } = v2Run(state, makeRepo());
  assert.deepEqual([...result.context!.sourcesConsulted], ["task", "repository_instructions", "goal_target_files"]);
});
