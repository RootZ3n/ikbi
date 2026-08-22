/**
 * RETRIEVAL TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * THE ACCEPTANCE CRITERION: through the real built CLI, a task that names no filename
 * still causes ikbi to see the relevant code. Everything else here guards the ways that
 * could be true dishonestly — by re-reading a mutable working tree, by crowding out what
 * the operator actually named, by smuggling in a second model call, or by claiming a
 * retrieval that did not happen.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { V2RunResult } from "../core/result.js";
import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderServer } from "./fake-provider-server.js";
import { initGitRepo, writeFiles } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

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

/**
 * A repository where the RELEVANT file is never named by any goal below, and the
 * distractors are plausible-looking neighbours rather than empty filler.
 */
const REPO_FILES: Readonly<Record<string, string>> = {
  "src/session-token.ts": "export function refreshSessionToken(now: number): number {\n  return now + 3600;\n}\n",
  "src/session-token.test.ts": "import { refreshSessionToken } from './session-token.js';\nrefreshSessionToken(0);\n",
  "src/app.ts": "import { refreshSessionToken } from './session-token.js';\nexport const app = refreshSessionToken;\n",
  "src/colours.ts": "export const palette = ['red', 'green'];\n",
  "src/geometry.ts": "export const area = (w: number, h: number) => w * h;\n",
  "docs/deployment.md": "# deployment\nRun the deploy script.\n",
  "pnpm-lock.yaml": "lockfileVersion: 9\npackages:\n  session-token: {}\n",
};

function makeStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-retstate-"));
  dirs.push(root);
  writeFileSync(join(root, "providers.json"), JSON.stringify(ROSTER, null, 2));
  return root;
}

function makeRepo(extra: Readonly<Record<string, string>> = {}): string {
  const repo = initGitRepo({ ...REPO_FILES, ...extra });
  dirs.push(repo);
  return repo;
}

function runCli(root: string, args: readonly string[]) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-retcwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
      // and must not depend on the operator's untracked `.env` to start.
      ...HERMETIC_DEV_KEY_ENV,
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-rethome-")),
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

function v2Run(root: string, repo: string, goal: string) {
  const r = runCli(root, ["v2", "build", goal, "--repo", repo, "--json"]);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return sessionFinalAttempt(r.stdout);
}

const retrievedPaths = (result: V2RunResult): string[] =>
  (result.context?.artifacts ?? []).filter((a) => a.category === "retrieved_repository_evidence").map((a) => a.path ?? "");

const allPaths = (result: V2RunResult): string[] => (result.context?.artifacts ?? []).map((a) => a.path ?? "(task)");

test("retrieval truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── THE ACCEPTANCE CRITERION ────────────────────────────────────────────────

test("retrieval truth: A TASK NEED NOT NAME A FILENAME for ikbi to see the relevant code", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "make the session token refresh one hour later");
  const retrieved = retrievedPaths(result);
  assert.ok(retrieved.includes("src/session-token.ts"), `the relevant file was not found; retrieved: ${retrieved.join(", ")}`);
  assert.equal(result.receipt.evidence.retrievalPerformed, true);
  // And it really was discovery, not the goal naming a path.
  assert.equal(result.receipt.retrieval!.top[0]?.path, "src/session-token.ts");
});

test("retrieval truth: irrelevant files stay out — this is not 'send the whole repository'", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "make the session token refresh one hour later");
  const retrieved = retrievedPaths(result);
  assert.equal(retrieved.includes("src/colours.ts"), false);
  assert.equal(retrieved.includes("src/geometry.ts"), false);
  assert.equal(retrieved.includes("pnpm-lock.yaml"), false, "a lockfile is never evidence");
});

test("retrieval truth: the caller and the colocated test come along with the subject", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "make the session token refresh one hour later");
  const retrieved = retrievedPaths(result);
  assert.ok(retrieved.includes("src/app.ts"), "the caller is relevant though the goal never mentions it");
  assert.ok(retrieved.includes("src/session-token.test.ts"), "and so is the test that pins its behaviour");
});

// ── retrieval never outranks what the operator named ────────────────────────

test("retrieval truth: a NAMED target still outranks everything retrieved", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "edit src/colours.ts to add blue for the session token palette");
  const paths = allPaths(result);
  const named = paths.indexOf("src/colours.ts");
  const firstRetrieved = paths.findIndex((p) => retrievedPaths(result).includes(p));
  assert.ok(named >= 0, "the named file is present");
  assert.ok(firstRetrieved === -1 || named < firstRetrieved, "and it is admitted before any guess");
});

test("retrieval truth: a file the operator NAMED is never sent twice", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "update src/session-token.ts so the session token refreshes later");
  const paths = allPaths(result);
  assert.equal(
    paths.filter((p) => p === "src/session-token.ts").length,
    1,
    `paid for the same file twice: ${paths.join(", ")}`,
  );
  const target = result.context!.artifacts.find((a) => a.path === "src/session-token.ts")!;
  assert.equal(target.category, "target_file", "and it is carried in the band the operator earned, not the guess band");
});

test("retrieval truth: repository instructions are still the higher band", () => {
  const result = v2Run(makeStateRoot(), makeRepo({ "AGENTS.md": "# conventions\nUse tabs.\n" }), "refresh the session token");
  const paths = allPaths(result);
  const instructions = paths.indexOf("AGENTS.md");
  assert.ok(instructions >= 0);
  assert.ok(instructions < paths.indexOf("src/session-token.ts"), "conventions come before discovered evidence");
});

// ── bound to the snapshot, not to the working tree ──────────────────────────

test("retrieval truth: it sees UNCOMMITTED work — the operator's real state", () => {
  const repo = makeRepo();
  writeFiles(repo, { "src/session-token.ts": "// TODO: the refresh window is wrong\nexport function refreshSessionToken() {}\n" });
  const result = v2Run(makeStateRoot(), repo, "fix the session token refresh window");
  const artifact = result.context!.artifacts.find((a) => a.path === "src/session-token.ts");
  assert.ok(artifact !== undefined, "the dirty file is still discoverable");
  assert.equal(result.receipt.sourceSnapshot!.clean, false);
});

test("retrieval truth: an UNTRACKED file is discoverable", () => {
  const repo = makeRepo();
  writeFiles(repo, { "src/session-token-v2.ts": "export function refreshSessionTokenV2() {}\n" });
  const result = v2Run(makeStateRoot(), repo, "refresh the session token");
  assert.ok(retrievedPaths(result).includes("src/session-token-v2.ts"), "brand-new work is part of the source state");
});

test("retrieval truth: a DELETED file is not resurrected", () => {
  const repo = makeRepo();
  execFileSync("git", ["rm", "-q", "src/session-token.test.ts"], { cwd: repo });
  const result = v2Run(makeStateRoot(), repo, "refresh the session token");
  assert.equal(retrievedPaths(result).includes("src/session-token.test.ts"), false, "a deleted file is not source");
  assert.ok(retrievedPaths(result).includes("src/session-token.ts"), "while the rest is still found");
});

test("retrieval truth: a GIT-IGNORED file is never retrieved", () => {
  const repo = makeRepo({ ".gitignore": "src/generated/\n" });
  writeFiles(repo, { "src/generated/session-token.ts": "export const generatedSessionToken = 1;\n" });
  const result = v2Run(makeStateRoot(), repo, "refresh the session token");
  assert.equal(
    retrievedPaths(result).some((p) => p.startsWith("src/generated/")),
    false,
    "git's ignore rules are the exclusion policy",
  );
});

// ── determinism ─────────────────────────────────────────────────────────────

test("retrieval truth: the same repository and goal retrieve the same files, in the same order", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const a = v2Run(state, repo, "refresh the session token");
  const b = v2Run(state, repo, "refresh the session token");
  assert.deepEqual(retrievedPaths(b), retrievedPaths(a));
  assert.equal(b.receipt.retrieval!.retrievalId, a.receipt.retrieval!.retrievalId);
  assert.equal(b.receipt.context!.packageId, a.receipt.context!.packageId, "and the whole package is identical");
});

test("retrieval truth: editing the source between runs changes the retrieval identity", () => {
  const state = makeStateRoot();
  const repo = makeRepo();
  const before = v2Run(state, repo, "refresh the session token");
  writeFiles(repo, { "src/session-token.ts": "export function refreshSessionToken() { return 42; }\n" });
  const after_ = v2Run(state, repo, "refresh the session token");
  assert.notEqual(after_.receipt.retrieval!.retrievalId, before.receipt.retrieval!.retrievalId);
});

// ── no model, no mutation, no second call ───────────────────────────────────

test("retrieval truth: retrieval introduces NO extra model call", async () => {
  const before = (await PROVIDER.received()).length;
  const result = v2Run(makeStateRoot(), makeRepo(), "refresh the session token");
  // Retrieval adds NO model call: the two calls are the builder and the critic, exactly as
  // without retrieval. (Retrieval is deterministic — it never invokes a model.)
  assert.equal((await PROVIDER.received()).length - before, 2, "builder + critic, and retrieval added neither");
  assert.equal(result.receipt.evidence.invocations, 2, "and the receipt counts both");
});

test("retrieval truth: retrieval writes nothing and promotes nothing", () => {
  const repo = makeRepo();
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  const result = v2Run(makeStateRoot(), repo, "refresh the session token");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), before);
  const e = result.receipt.evidence;
  assert.equal(e.mutationsApplied, 0);
  assert.equal(e.candidatesCreated, 1);
  assert.equal(e.sourceRepositoryMutated, false);
  assert.equal(e.promoted, false);
});

// ── the receipt tells the truth about it ────────────────────────────────────

test("retrieval truth: the receipt ACCOUNTS for what was searched, matched and admitted", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "refresh the session token");
  const r = result.receipt.retrieval!;
  assert.ok(r.examined >= Object.keys(REPO_FILES).length - 1, "every enumerated source path is accounted for");
  assert.ok(r.matched >= r.offered, "nothing is admitted that did not match");
  assert.equal(r.offered, retrievedPaths(result).length, "the count equals the artifacts actually carried");
  assert.equal(r.sourceSnapshotId, result.receipt.sourceSnapshot!.snapshotId, "bound to the state it searched");
  assert.ok(r.top.every((entry) => entry.reasons.length > 0), "every ranked file states WHY");
});

test("retrieval truth: the receipt carries NO file content", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "refresh the session token");
  const serialized = JSON.stringify(result.receipt);
  assert.equal(serialized.includes("refreshSessionToken"), false, "a receipt reports about source, it does not reproduce it");
});

test("retrieval truth: a goal with no usable terms retrieves nothing, and says so", () => {
  const result = v2Run(makeStateRoot(), makeRepo(), "do it");
  assert.deepEqual(retrievedPaths(result), []);
  assert.equal(result.receipt.evidence.retrievalPerformed, true, "retrieval RAN");
  assert.equal(result.receipt.retrieval!.offered, 0, "and honestly found nothing worth offering");
});

test("retrieval truth: the human rendering states the retrieval account", () => {
  const r = runCli(makeStateRoot(), ["v2", "build", "refresh the session token", "--repo", makeRepo()]);
  assert.match(r.stdout, /retrieval {3}v2\.deterministic\.\d+ · examined \d+ source file\(s\), \d+ matched, \d+ admitted/);
  assert.match(r.stdout, /\+ retrieved_repository_evidence +src\/session-token\.ts/);
});
