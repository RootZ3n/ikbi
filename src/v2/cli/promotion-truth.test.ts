/**
 * PROMOTION TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * THE ACCEPTANCE CRITERION FOR V2-011, proven through the real built CLI, a real socket and a
 * REAL git repository. A clean eligible candidate is verified, criticized, adjudicated,
 * authorized and PUBLISHED by a clean-ref CAS:
 *
 *     CLI → … → disposition(acceptable_for_promotion) → PROMOTION
 *         → commit(candidateTree, parent=base) → CAS main: base→commit → sync worktree
 *         → the EXACT candidate tree is authoritative → the run is ACCEPTED
 *
 * And the load-bearing SAFETY property: a DIRTY operator checkout is refused without touching
 * or committing the operator's uncommitted work. Target-moved and CAS-race refusals are proven
 * exhaustively at the unit level (`core/promotion.test.ts`) with a fake target, because a
 * blocking `spawnSync` cannot move the target ref mid-run.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { after, test } from "node:test";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderServer, type ScriptedTurn } from "./fake-provider-server.js";
import { initGitRepo } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const dirs: string[] = [];
const servers: FakeProviderServer[] = [];
after(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const WIDGET = "export const widget = 1;\n";
const WIDGET_2 = "export const widget = 2;\n";
const GREP_WIDGET_2 = `[{"name":"widget","command":"grep","args":["-q","widget = 2","src/widget.ts"]}]`;
const SATISFIED = JSON.stringify({ verdict: "satisfied", summary: "widget = 2 as requested.", defects: [] });

const EDIT_TO_2: readonly ScriptedTurn[] = [
  { toolCalls: [{ name: "read_file", args: { path: "src/widget.ts" } }] },
  { toolCalls: [{ name: "replace_file", args: { path: "src/widget.ts", content: WIDGET_2 }, observationFrom: "src/widget.ts" }] },
  { toolCalls: [{ name: "finish_candidate", args: { summary: "set widget to 2", believesComplete: true } }] },
];

async function provider(): Promise<FakeProviderServer> {
  const server = await startFakeOpenAIProvider({ script: EDIT_TO_2, criticResponse: SATISFIED });
  servers.push(server);
  return server;
}

function makeStateRoot(server: FakeProviderServer): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-pstate-"));
  dirs.push(root);
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify({
      providers: [{ id: "p1", kind: "openai-compatible", baseUrl: server.baseUrl, keyless: true }],
      models: [{ id: "m1", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p1", providerModelId: "m1-wire" }], capabilities: { context_window: 100000, supports_tools: true } }],
    }, null, 2),
  );
  return root;
}

function makeRepo(): string {
  const repo = initGitRepo({ "src/widget.ts": WIDGET });
  dirs.push(repo);
  return repo;
}

function runCli(root: string, server: FakeProviderServer, repo: string) {
  const cwd = mkdtempSync(join(tmpdir(), "ikbi-v2-pcwd-"));
  dirs.push(cwd);
  const res = spawnSync(process.execPath, [ENTRY, "v2", "build", "--allow-repo-wide", "set widget to 2 in src/widget.ts", "--repo", repo, "--json"], {
    cwd,
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
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-phome-")),
      IKBI_STATE_ROOT: root,
      IKBI_MODEL_DRIVER: "m1", IKBI_MODEL_BUILDER: "m1", IKBI_MODEL_CRITIC: "m1",
      IKBI_CHECKS: GREP_WIDGET_2,
      ...loopbackEgressEnv(server),
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function run() {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  const r = runCli(root, server, repo);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { server, root, repo, status: r.status, result: sessionFinalAttempt(r.stdout) };
}

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const headOf = (repo: string) => git(repo, "rev-parse", "HEAD");
const treeOf = (repo: string, ref: string) => git(repo, "rev-parse", `${ref}^{tree}`);
const statusOf = (repo: string) => git(repo, "status", "--porcelain");
const branchOf = (repo: string) => git(repo, "rev-parse", "--abbrev-ref", "HEAD");

test("promotion truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── THE ACCEPTANCE CRITERION ────────────────────────────────────────────────

test("promotion truth: a CLEAN eligible candidate is PUBLISHED — exact tree, atomic CAS, accepted", async () => {
  const { result, repo, status } = await run();
  const headBefore = result.receipt.sourceSnapshot!.headCommit;

  // The run is ACCEPTED and binds the promotion.
  assert.ok(result.outcome.kind === "accepted", `expected accepted: ${JSON.stringify(result.outcome)}`);
  assert.equal(result.outcome.promotionId, result.receipt.promotion!.promotionId);
  assert.equal(status, 0);

  const p = result.receipt.promotion!;
  // The EXACT candidate tree became authoritative.
  assert.equal(p.publishedTree, result.receipt.candidate!.treeId, "the published tree IS the candidate tree");
  assert.equal(p.strategy, "clean_ref_cas");
  assert.equal(p.beforeRef, headBefore, "the CAS started from the authorized base");
  assert.equal(p.degraded, false);

  // The target ref moved atomically to the publication commit, whose tree is the candidate tree.
  assert.equal(headOf(repo), p.afterRef, "HEAD is the landed publication commit");
  assert.equal(treeOf(repo, "HEAD"), result.receipt.candidate!.treeId, "and its tree is exactly the candidate tree");
  // The candidate bytes are present, and the checked-out worktree is clean after the sync.
  assert.equal(readFileSync(join(repo, "src", "widget.ts"), "utf8"), WIDGET_2, "the candidate's change is in the working tree");
  assert.equal(statusOf(repo), "", "the source checkout is clean");
  assert.equal(branchOf(repo), "main", "the operator is still on their own branch");
  // The publication commit is parented on the authorized base — a real one-commit advance.
  assert.equal(git(repo, "rev-parse", "HEAD~1"), headBefore, "the landed commit sits directly on the base");
});

// ── THE SAFETY PROPERTY — no surprise commit of operator dirt ─────────────────

test("promotion truth: a DIRTY operator checkout is REFUSED without committing the operator's work", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  // The operator has unrelated uncommitted work in the checkout.
  const dirt = "export const operatorWip = 42; // not ikbi's\n";
  writeFileSync(join(repo, "src", "wip.ts"), dirt);
  const headBefore = headOf(repo);
  const statusBefore = statusOf(repo);

  const r = runCli(root, server, repo);
  const result = sessionFinalAttempt(r.stdout);

  // The candidate is still eligible, but clean-ref CAS cannot publish a dirty source.
  assert.equal(result.receipt.disposition!.eligibleForPromotion, true, "the candidate IS eligible");
  assert.ok(result.outcome.kind === "withheld");
  assert.equal(result.outcome.reason, "unsupported_publication");
  assert.equal(result.receipt.evidence.promoted, false, "nothing was published");
  // NOTHING of the operator's world moved: HEAD, and the dirt, are exactly as they were.
  assert.equal(headOf(repo), headBefore, "the branch ref did not move");
  assert.equal(statusOf(repo), statusBefore, "the working tree is byte-identical — the dirt was not committed");
  assert.equal(readFileSync(join(repo, "src", "wip.ts"), "utf8"), dirt, "the operator's uncommitted work is untouched");
  assert.equal(r.status, 0, "withholding an unsupported publication is not an error");
});

// ── IDEMPOTENCY — no duplicate publication ───────────────────────────────────

test("promotion truth: a REPEATED build of the same candidate does not publish twice", async () => {
  // First run lands the candidate. Its edit (widget = 2) is now HEAD.
  const server1 = await provider();
  const root1 = makeStateRoot(server1);
  const repo = makeRepo();
  const first = sessionFinalAttempt(runCli(root1, server1, repo).stdout);
  assert.ok(first.outcome.kind === "accepted");
  const landedHead = headOf(repo);

  // A second, independent run against the now-updated repo: the builder makes the SAME edit,
  // so the candidate tree already equals the target tree — an idempotent already-published.
  const server2 = await provider();
  const root2 = makeStateRoot(server2);
  const second = sessionFinalAttempt(runCli(root2, server2, repo).stdout);

  assert.ok(second.outcome.kind === "accepted", "the truthful state is: this exact candidate tree is already landed");
  assert.equal(second.receipt.promotion!.idempotent, true, "detected as already-published — no second CAS");
  assert.equal(headOf(repo), landedHead, "HEAD did NOT move again — no duplicate commit");
  // The published tree the second run reports is the tree already on the target.
  assert.equal(second.receipt.promotion!.publishedTree, treeOf(repo, "HEAD"), "the authoritative tree is the candidate's, unchanged");
  assert.equal(second.receipt.promotion!.beforeRef, landedHead);
  assert.equal(second.receipt.promotion!.afterRef, landedHead, "before == after — nothing was re-published");
});

// ── NO MODEL / NO REVERIFY / NO REPAIR ───────────────────────────────────────

test("promotion truth: publication adds NO model call and NO check run", async () => {
  const { server, result } = await run();
  const completions = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  // Three builder turns + ONE critic call. Promotion is mechanical — it invokes nothing.
  assert.equal(completions.filter((r) => r.toolNames.length > 0).length, 3, "the builder's three turns");
  assert.equal(completions.filter((r) => r.toolNames.length === 0).length, 1, "the critic's one judgment — promotion adds none");
  assert.equal(result.receipt.evidence.invocations, 4, "three builder turns + one critic; publication is NOT an invocation");
  assert.equal(result.receipt.evidence.verificationsPerformed, 1, "verification ran once — promotion did not re-run it");
});

// ── receipt discipline ───────────────────────────────────────────────────────

test("promotion truth: the receipt records the publication without leaking prompts or file bodies", async () => {
  const { result } = await run();
  const serialized = JSON.stringify(result.receipt);
  assert.equal(serialized.includes("You are ikbi's critic"), false, "no critic system prompt");
  assert.ok(result.receipt.promotion !== undefined);
  assert.deepEqual(
    [...result.receipt.stagesEntered],
    ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition", "promotion"],
  );
  // The promotion binds the disposition that authorized it.
  assert.equal(result.receipt.promotion!.dispositionId, result.receipt.disposition!.dispositionId);
});

test("promotion truth: the human rendering states the landed publication", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  const cwd = mkdtempSync(join(tmpdir(), "ikbi-v2-prender-"));
  dirs.push(cwd);
  const res = spawnSync(process.execPath, [ENTRY, "v2", "build", "--allow-repo-wide", "set widget to 2 in src/widget.ts", "--repo", repo], {
    cwd,
    env: { PATH: process.env.PATH ?? "",
    // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
    // and must not depend on the operator's untracked `.env` to start.
    ...HERMETIC_DEV_KEY_ENV,
    HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-ph-")), IKBI_STATE_ROOT: root, IKBI_MODEL_DRIVER: "m1", IKBI_MODEL_BUILDER: "m1", IKBI_MODEL_CRITIC: "m1", IKBI_CHECKS: GREP_WIDGET_2, ...loopbackEgressEnv(server) },
    encoding: "utf8",
  });
  assert.match(res.stdout, /promotion {3}PUBLISHED · main · clean_ref_cas/);
  assert.match(res.stdout, /the exact candidate tree is now authoritative/);
  assert.match(res.stdout, /outcome {5}accepted — promoted/);
});
