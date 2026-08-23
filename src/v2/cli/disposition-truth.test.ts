/**
 * DISPOSITION TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * THE ACCEPTANCE CRITERION FOR V2-010, proven through the real built CLI and a real socket.
 * A candidate is built, verified deterministically, critiqued semantically, then ADJUDICATED:
 *
 *     CLI → … → candidate → verification → criticism → DISPOSITION
 *         → the ONE lawful decision (acceptable_for_promotion / withhold / reject / quarantine)
 *         → terminate BEFORE promotion — nothing is promoted, the source is unchanged
 *
 * The load-bearing proofs: PASS+satisfied is ELIGIBLE but withheld (never promoted); a passing
 * verifier cannot erase a concrete critic defect; a happy critic cannot override deterministic
 * red; and no model, check, repair or promotion runs during or after adjudication.
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
/** A check that PASSES iff the candidate set widget = 2. */
const GREP_WIDGET_2 = `[{"name":"widget","command":"grep","args":["-q","widget = 2","src/widget.ts"]}]`;
/** A check that always FAILS — the candidate is verified RED. */
const ALWAYS_FAIL = `[{"name":"nope","command":"grep","args":["-q","this string is absent","src/widget.ts"]}]`;
/** A check whose binary is NOT on the governed allowlist — it cannot launch ⇒ infrastructure_failure. */
const DENIED_BINARY = `[{"name":"forbidden","command":"definitely-not-a-real-allowlisted-binary","args":[]}]`;

const EDIT_TO_2: readonly ScriptedTurn[] = [
  { toolCalls: [{ name: "read_file", args: { path: "src/widget.ts" } }] },
  { toolCalls: [{ name: "replace_file", args: { path: "src/widget.ts", content: WIDGET_2 }, observationFrom: "src/widget.ts" }] },
  { toolCalls: [{ name: "finish_candidate", args: { summary: "set widget to 2", believesComplete: true } }] },
];

const SATISFIED = JSON.stringify({ verdict: "satisfied", summary: "widget = 2 as requested.", defects: [] });
const INDETERMINATE = JSON.stringify({ verdict: "indeterminate", summary: "not enough signal to be sure.", defects: [] });
const DEFECTS = JSON.stringify({
  verdict: "defects_found",
  summary: "satisfies the grep but not the intent",
  defects: [{ category: "incomplete_implementation", severity: "major", description: "the value is hard-coded, not derived as the goal asked", paths: ["src/widget.ts"] }],
});

async function provider(criticResponse: string): Promise<FakeProviderServer> {
  const server = await startFakeOpenAIProvider({ script: EDIT_TO_2, criticResponse });
  servers.push(server);
  return server;
}

function makeStateRoot(server: FakeProviderServer): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-dstate-"));
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

function runCli(root: string, server: FakeProviderServer, repo: string, checks?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "ikbi-v2-dcwd-"));
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
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-dhome-")),
      IKBI_STATE_ROOT: root,
      IKBI_MODEL_DRIVER: "m1",
      IKBI_MODEL_BUILDER: "m1",
      IKBI_MODEL_CRITIC: "m1",
      IKBI_RECOVERY_MAX_ATTEMPTS: "1",
      ...(checks !== undefined ? { IKBI_CHECKS: checks } : {}),
      ...loopbackEgressEnv(server),
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function run(criticResponse: string, checks?: string) {
  const server = await provider(criticResponse);
  const root = makeStateRoot(server);
  const repo = makeRepo();
  const r = runCli(root, server, repo, checks);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { server, root, repo, status: r.status, stdout: r.stdout, result: sessionFinalAttempt(r.stdout) };
}

const headOf = (repo: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const statusOf = (repo: string) => execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });

test("disposition truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── THE ACCEPTANCE CRITERION ────────────────────────────────────────────────

test("disposition truth: PASS + SATISFIED ⇒ ELIGIBLE, but withheld and NOT promoted", async () => {
  const { result, repo } = await run(SATISFIED, GREP_WIDGET_2);
  // The disposition is acceptable_for_promotion; on a CLEAN repo V2-011 then PUBLISHES it, so
  // the run is accepted and the operator's file now holds the candidate's change.
  const d = result.receipt.disposition!;
  assert.equal(d.decision, "acceptable_for_promotion");
  assert.equal(d.primaryReason, "acceptable");
  assert.equal(d.eligibleForPromotion, true);
  assert.equal(d.requiresRecovery, false);
  assert.ok(result.outcome.kind === "accepted");
  assert.equal(result.receipt.evidence.promoted, true);
  assert.equal(result.receipt.stagesEntered.includes("promotion"), true);
  assert.equal(readFileSync(join(repo, "src", "widget.ts"), "utf8"), WIDGET_2, "the candidate's change landed on the operator's file");
});

test("disposition truth: GREEN + DEFECTS_FOUND ⇒ WITHHOLD — a passing verifier cannot erase a defect", async () => {
  const { result } = await run(DEFECTS, GREP_WIDGET_2);
  assert.equal(result.receipt.verification!.verdict, "pass", "deterministic checks are GREEN");
  const d = result.receipt.disposition!;
  assert.equal(d.decision, "withhold");
  assert.equal(d.primaryReason, "critic_defects");
  assert.equal(d.eligibleForPromotion, false);
  assert.ok(result.outcome.kind === "withheld");
});

test("disposition truth: RED + SATISFIED ⇒ REJECT — a happy critic cannot override deterministic red", async () => {
  const { result } = await run(SATISFIED, ALWAYS_FAIL);
  assert.equal(result.receipt.verification!.verdict, "fail", "deterministic checks are RED");
  assert.equal(result.receipt.critic!.verdict, "satisfied", "yet the critic is satisfied");
  const d = result.receipt.disposition!;
  assert.equal(d.decision, "reject", "deterministic red wins");
  assert.equal(d.primaryReason, "verification_failed");
  assert.equal(d.eligibleForPromotion, false);
  assert.ok(result.outcome.kind === "rejected");
  assert.equal(result.outcome.reason, "verification_red");
});

test("disposition truth: NO_CHECKS + SATISFIED ⇒ WITHHOLD (no deterministic evidence)", async () => {
  const { result } = await run(SATISFIED); // no IKBI_CHECKS
  assert.equal(result.receipt.verification!.verdict, "no_checks");
  const d = result.receipt.disposition!;
  assert.equal(d.decision, "withhold");
  assert.equal(d.primaryReason, "no_checks");
  assert.equal(d.eligibleForPromotion, false, "semantic approval is not deterministic verification");
  assert.ok(result.outcome.kind === "withheld");
});

test("disposition truth: PASS + INDETERMINATE ⇒ WITHHOLD under the safe default", async () => {
  const { result } = await run(INDETERMINATE, GREP_WIDGET_2);
  const d = result.receipt.disposition!;
  assert.equal(d.decision, "withhold");
  assert.equal(d.primaryReason, "critic_indeterminate");
  assert.equal(d.eligibleForPromotion, false);
});

test("disposition truth: INFRASTRUCTURE_FAILURE ⇒ QUARANTINE, flagged for recovery", async () => {
  const { result } = await run(SATISFIED, DENIED_BINARY);
  assert.equal(result.receipt.verification!.verdict, "infrastructure_failure", "the check could not launch");
  const d = result.receipt.disposition!;
  assert.equal(d.decision, "quarantine");
  assert.equal(d.primaryReason, "verification_infrastructure_failure");
  assert.equal(d.requiresRecovery, true, "an infra failure is a recovery condition, not an ordinary defect");
  assert.equal(d.eligibleForPromotion, false);
  assert.ok(result.outcome.kind === "quarantined");
});

// ── nothing is promoted, nothing is repaired, no extra model call ────────────

test("disposition truth: adjudication makes NO extra model call and NO extra check run", async () => {
  const { server } = await run(SATISFIED, GREP_WIDGET_2);
  const completions = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  // Three builder turns + ONE critic call. Disposition is PURE — it invokes nothing.
  const builderTurns = completions.filter((r) => r.toolNames.length > 0);
  const criticTurns = completions.filter((r) => r.toolNames.length === 0);
  assert.equal(builderTurns.length, 3, "the builder's three turns");
  assert.equal(criticTurns.length, 1, "the critic's one judgment — and adjudication adds none");
});

test("disposition truth: an ELIGIBLE candidate on a clean repo is PUBLISHED — HEAD moves to the candidate", async () => {
  const server = await provider(SATISFIED);
  const root = makeStateRoot(server);
  const repo = makeRepo();
  const headBefore = headOf(repo);
  const r = runCli(root, server, repo, GREP_WIDGET_2);
  const result = sessionFinalAttempt(r.stdout);
  assert.equal(result.receipt.disposition!.eligibleForPromotion, true, "the candidate IS eligible");
  assert.ok(result.outcome.kind === "accepted");
  assert.notEqual(headOf(repo), headBefore, "HEAD moved — the candidate was published");
  assert.equal(headOf(repo), result.receipt.promotion!.afterRef, "HEAD is exactly the landed publication commit");
  assert.equal(statusOf(repo).trim(), "", "and the checked-out worktree is clean after the sync");
  assert.equal(r.status, 0, "an accepted publication is exit 0");
});

// ── the record is bound and the receipt is honest ────────────────────────────

test("disposition truth: the record BINDS the exact candidate, verification, critic and policy", async () => {
  const { result } = await run(SATISFIED, GREP_WIDGET_2);
  const d = result.receipt.disposition!;
  assert.equal(d.candidateId, result.receipt.candidate!.candidateId);
  assert.equal(d.candidateTreeId, result.receipt.candidate!.treeId);
  assert.equal(d.verificationId, result.receipt.verification!.verificationId);
  assert.equal(d.criticId, result.receipt.critic!.criticId);
  assert.match(d.dispositionId, /^[0-9a-f]{64}$/);
  assert.match(d.policyId, /^[0-9a-f]{64}$/);
});

test("disposition truth: the receipt records the decision without leaking prompts or file bodies", async () => {
  const { result } = await run(SATISFIED, GREP_WIDGET_2);
  const serialized = JSON.stringify(result.receipt);
  assert.equal(serialized.includes("You are ikbi's critic"), false, "no critic system prompt");
  assert.equal(serialized.includes("export const widget = 2"), false, "no candidate file body");
  assert.ok(result.receipt.disposition !== undefined);
  assert.deepEqual(
    [...result.receipt.stagesEntered],
    ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition", "promotion"],
  );
});

test("disposition truth: the human rendering states the decision and the landed publication", async () => {
  const server = await provider(SATISFIED);
  const root = makeStateRoot(server);
  const repo = makeRepo();
  const cwd = mkdtempSync(join(tmpdir(), "ikbi-v2-drender-"));
  dirs.push(cwd);
  const res = spawnSync(process.execPath, [ENTRY, "v2", "build", "--allow-repo-wide", "set widget to 2 in src/widget.ts", "--repo", repo], {
    cwd,
    env: { PATH: process.env.PATH ?? "",
    // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
    // and must not depend on the operator's untracked `.env` to start.
    ...HERMETIC_DEV_KEY_ENV,
    HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-dh-")), IKBI_STATE_ROOT: root, IKBI_MODEL_DRIVER: "m1", IKBI_MODEL_BUILDER: "m1", IKBI_MODEL_CRITIC: "m1",
      IKBI_RECOVERY_MAX_ATTEMPTS: "1", IKBI_CHECKS: GREP_WIDGET_2, ...loopbackEgressEnv(server) },
    encoding: "utf8",
  });
  assert.match(res.stdout, /disposition ELIGIBLE FOR PROMOTION · acceptable/);
  assert.match(res.stdout, /promotion {3}PUBLISHED · /);
  assert.match(res.stdout, /the exact candidate tree is now authoritative/);
  assert.match(res.stdout, /promoted=true/);
});
