import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The orchestrator imports provider-backed singletons; register the egress guard first,
// matching the production barrel and the existing worker-model tests.
import "../egress/index.js";

import { runGit } from "../../core/workspace/git.js";
import { decidePromotability } from "./adjudication/core.js";
import type { SafetyAssessment } from "./adjudication/contract.js";
import { computeWorktreeWorkProduct } from "./orchestrator.js";

interface FixtureRepo {
  readonly path: string;
  readonly baseRef: string;
}

const NO_VETO: SafetyAssessment = {
  externalInjection: false,
  effectiveBreach: false,
  refuted: false,
  killed: false,
  driftBlocked: false,
};

function gitOutput(repo: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function fixtureRepo(label: string, value: string): Promise<FixtureRepo> {
  const path = await mkdtemp(join(tmpdir(), `ikbi-adj-repo-${label}-`));
  await runGit(path, ["init", "--quiet"]);
  await runGit(path, ["config", "user.email", "adjudication-test@ikbi.local"]);
  await runGit(path, ["config", "user.name", "ikbi adjudication test"]);
  await mkdir(join(path, "src"));
  await writeFile(join(path, "src", "value.txt"), "base\n");
  await runGit(path, ["add", "-A"]);
  await runGit(path, ["commit", "--quiet", "-m", "base"]);
  const baseRef = (await runGit(path, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(path, "src", "value.txt"), `${value}\n`);
  return { path, baseRef };
}

function expectedTree(repo: FixtureRepo): string {
  const tempDir = mkdtempSync(join(tmpdir(), "ikbi-adj-expected-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(tempDir, "index") };
  try {
    gitOutput(repo.path, ["add", "-A"], env);
    return gitOutput(repo.path, ["write-tree"], env).trim();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function adjudicationArtifacts(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("ikbi-adj-")));
}

/**
 * `tmpdir()` is a SHARED, PROCESS-GLOBAL namespace. `mkdtemp` names are random, so a set
 * difference cannot tell OUR leak apart from another concurrently-running test process's
 * IN-FLIGHT `ikbi-adj-*` directory — which is created and removed inside one adjudication.
 * Asserting on the raw difference made this test fail whenever the suite's scheduling happened
 * to overlap another orchestrator test with this one.
 *
 * The contract being pinned is that no artifact SURVIVES, and surviving is a property of time:
 * a real leak persists forever, another process's transient disappears. So we poll for a bounded
 * settle window and require the leaked set to become empty. A genuine leak still fails — it never
 * clears — and the assertion no longer depends on which other tests happen to be running.
 */
async function assertNoNewArtifacts(before: Set<string>, label: string): Promise<void> {
  const leakedNow = (): string[] => [...adjudicationArtifacts()].filter((name) => !before.has(name));
  let leaked = leakedNow();
  for (let waited = 0; leaked.length > 0 && waited < 5_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    leaked = leakedNow();
  }
  assert.deepEqual(leaked, [], `${label}: no temporary adjudication index, lock, or directory survives`);
}

async function removeRepos(repos: readonly FixtureRepo[]): Promise<void> {
  for (const repo of repos) await rm(repo.path, { recursive: true, force: true });
}

test("source conformance: adjudication index identity is not derived from taskId alone", async () => {
  const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "orchestrator.ts");
  const source = await readFile(sourcePath, "utf8");
  assert.doesNotMatch(source, /ikbi-adj-\$\{taskId\}\.index/, "the retired shared taskId-only index path must not return");
  assert.match(source, /mkdtempSync\(join\(tmpdir\(\), ["']ikbi-adj-/);
  assert.match(source, /const tempIndexPath = join\(tempDir, ["']index["']\)/);
});

test("same taskId and same repository compute concurrently without sharing an index", async () => {
  const repo = await fixtureRepo("same-repo", "same-repo-result");
  const before = adjudicationArtifacts();
  try {
    const expected = expectedTree(repo);
    const products = await Promise.all([
      computeWorktreeWorkProduct(repo.path, repo.baseRef, "reusable-task"),
      computeWorktreeWorkProduct(repo.path, repo.baseRef, "reusable-task"),
    ]);
    assert.deepEqual(products.map((product) => product.treeHash), [expected, expected]);
    assert.ok(products.every((product) => product.nonEmpty));
    await assertNoNewArtifacts(before, "same repository concurrency");
  } finally {
    await removeRepos([repo]);
  }
});

test("same taskId across repositories returns each repository's independent tree hash", async () => {
  const repos = await Promise.all([
    fixtureRepo("repo-a", "repo-a-result"),
    fixtureRepo("repo-b", "repo-b-result"),
  ]);
  const before = adjudicationArtifacts();
  try {
    const expected = repos.map(expectedTree);
    const products = await Promise.all(repos.map((repo) => computeWorktreeWorkProduct(repo.path, repo.baseRef, "same-task-different-repo")));
    assert.deepEqual(products.map((product) => product.treeHash), expected);
    assert.notEqual(products[0]!.treeHash, products[1]!.treeHash);
    await assertNoNewArtifacts(before, "cross-repository concurrency");
  } finally {
    await removeRepos(repos);
  }
});

test("a stale taskId-derived index is ignored by a new computation", async () => {
  const repo = await fixtureRepo("stale", "fresh-result");
  const stalePath = join(tmpdir(), "ikbi-adj-stale-task.index");
  try {
    await writeFile(stalePath, "this is not a git index\n");
    const withStaleIndex = adjudicationArtifacts();
    const product = await computeWorktreeWorkProduct(repo.path, repo.baseRef, "stale-task");
    assert.equal(product.treeHash, expectedTree(repo));
    assert.equal(product.nonEmpty, true);
    await assertNoNewArtifacts(withStaleIndex, "stale index isolation");
    assert.ok(adjudicationArtifacts().has("ikbi-adj-stale-task.index"), "the unrelated stale artifact was not selected or rewritten");
  } finally {
    await rm(stalePath, { force: true });
    await removeRepos([repo]);
  }
});

test("failed adjudication cleans its unique index directory without masking the Git failure", async () => {
  const repo = await fixtureRepo("failure-cleanup", "failure-result");
  const before = adjudicationArtifacts();
  try {
    await assert.rejects(
      computeWorktreeWorkProduct(repo.path, "not-a-real-base-ref", "failed-cleanup-task"),
      /git|fatal|bad object|unknown revision/i,
    );
    await assertNoNewArtifacts(before, "failed adjudication cleanup");
  } finally {
    await removeRepos([repo]);
  }
});

test("high-concurrency same-taskId adjudications preserve every repository work product", async () => {
  const repos = await Promise.all(Array.from({ length: 8 }, (_, i) => fixtureRepo(`high-${i}`, `high-concurrency-${i}`)));
  const before = adjudicationArtifacts();
  try {
    const expected = repos.map(expectedTree);
    const products = await Promise.all(
      repos.map((repo) => computeWorktreeWorkProduct(repo.path, repo.baseRef, "high-concurrency-task")),
    );
    assert.deepEqual(products.map((product) => product.treeHash), expected);
    assert.equal(new Set(products.map((product) => product.treeHash)).size, repos.length);
    assert.ok(products.every((product) => product.nonEmpty));
    await assertNoNewArtifacts(before, "high concurrency");
  } finally {
    await removeRepos(repos);
  }
});

test("promotion recommendation remains bound to the work product tree hash", async () => {
  const repo = await fixtureRepo("promotion-binding", "promotion-result");
  try {
    const product = await computeWorktreeWorkProduct(repo.path, repo.baseRef, "promotion-binding-task");
    const green = { verdict: "pass" as const, testEvidence: "executed" as const, treeHash: product.treeHash };
    const authorized = decidePromotability(product, green, NO_VETO, { pass: true });
    assert.deepEqual(authorized, { action: "promote", treeHash: product.treeHash, reason: "verified-green" });
    const stale = decidePromotability(product, { ...green, treeHash: "different-tree" }, NO_VETO, { pass: true });
    assert.deepEqual(stale, { action: "retain", reason: "adjudication-incomplete" });
  } finally {
    await removeRepos([repo]);
  }
});
