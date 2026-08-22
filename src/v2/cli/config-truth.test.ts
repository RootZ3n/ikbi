/**
 * CONFIGURATION TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * This suite exists because of a specific, verified v1 defect: `ikbi profile use <name>`
 * wrote an active-profile pointer, printed `export IKBI_MODEL_*` instructions, and was
 * read by NOTHING on any build path. The feature passed its own tests and did nothing.
 *
 * So the test does not ask whether a class works. It arranges two distinguishable
 * providers and two profiles, activates one through the REAL `ikbi profile use` command
 * in a subprocess, runs the REAL `ikbi v2 build` binary in another subprocess, and
 * asserts the runtime policy it reports is the one the operator selected — then flips
 * the selection and asserts the policy moved with it.
 *
 * It fails if the pointer is ignored, if stale environment variables win, if the CLI
 * and the runtime read different configuration, or if activation is once again nothing
 * but shell advice. No IKBI_MODEL_* variable is ever exported.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { V2RunResult } from "../core/result.js";
import { loopbackEgressEnv, startFakeOpenAIProvider } from "./fake-provider-server.js";
import { initGitRepo } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
/**
 * A small COMMITTED fixture repository. V2-006 allocates a worktree from HEAD and
 * re-observes a context artifact there, so pointing these suites at the ikbi checkout
 * would make them fail whenever the operator has an uncommitted CLAUDE.md — a real
 * behavior, but not what these suites are about.
 */
const REPO = initGitRepo({ "AGENTS.md": "# fixture conventions\nBe terse.\n", "src/widget.ts": "export const widget = 1;\n" });

/** A key that must never appear in any v2 output. Planted in a provider AND a profile. */
const PLANTED_SECRET = "sk-live-V2SHOULDNEVERPRINTTHIS";

/** Two keyless providers with one model each — the minimum needed to tell A from B. */
const PROVIDER = await startFakeOpenAIProvider();
after(() => PROVIDER.close());

const ROSTER = {
  providers: [
    // A REAL local endpoint: every run in this suite performs a real HTTP invocation
    // against a protocol-faithful server (V2-005), so these tests still prove the
    // configuration facts they were written for while exercising the whole spine.
    { id: "alpha", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true },
    { id: "beta", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true },
    // A provider that DOES carry a credential, so the redaction assertion is meaningful.
    { id: "keyed", kind: "openai-compatible", baseUrl: "https://keyed.test/v1", apiKey: PLANTED_SECRET },
  ],
  models: [
    // A DECLARED context window: the context budget is derived from capability facts,
    // and an unclassified model would (correctly) fail rather than be guessed at.
    { id: "alpha-1", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "alpha", providerModelId: "a1" }], capabilities: { context_window: 100000, supports_tools: true } },
    { id: "beta-1", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "beta", providerModelId: "b1" }], capabilities: { context_window: 100000, supports_tools: true } },
  ],
};

const profile = (name: string, model: string, provider: string, extra: Record<string, unknown> = {}) => ({
  name,
  roles: {
    builder: { provider, model },
    critic: { provider, model },
  },
  ...extra,
});

const roots: string[] = [];

/** A fully isolated ikbi state root. The operator's real ~/.ikbi is never touched. */
function makeStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-config-"));
  roots.push(root);
  mkdirSync(join(root, "profiles"), { recursive: true });
  writeFileSync(join(root, "providers.json"), JSON.stringify(ROSTER, null, 2));
  writeProfile(root, profile("prof-alpha", "alpha-1", "alpha"));
  writeProfile(root, profile("prof-beta", "beta-1", "beta"));
  return root;
}

function writeProfile(root: string, doc: Record<string, unknown>): void {
  writeFileSync(join(root, "profiles", `${String(doc.name)}.json`), JSON.stringify(doc, null, 2));
}

/**
 * Run the built CLI against an isolated state root.
 *
 * NOTE WHAT IS NOT IN THIS ENVIRONMENT: no IKBI_MODEL_DRIVER, no IKBI_MODEL_BUILDER,
 * no IKBI_MODEL_CRITIC. If v2 only observed a profile through exported variables, every
 * assertion below would fail.
 */
function runCli(root: string, args: readonly string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
    // and must not depend on the operator's untracked `.env` to start.
    ...HERMETIC_DEV_KEY_ENV,
    HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-home-")),
    IKBI_STATE_ROOT: root,
    ...loopbackEgressEnv(PROVIDER),
  };
  // THE BASE environment exports no model variables — that is what makes every
  // profile-switching assertion in this suite meaningful. A test that deliberately
  // exercises the operator-configuration LAYER passes them through `extraEnv`.
  for (const key of Object.keys(base)) {
    assert.equal(key.startsWith("IKBI_MODEL_"), false, "the base test environment exports no model variables");
  }
  const env: Record<string, string> = { ...base, ...extraEnv };
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-cwd-")),
    env,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function v2Run(root: string, args: readonly string[] = [], extraEnv: Record<string, string> = {}): { result: V2RunResult; stdout: string; stderr: string; status: number | null } {
  const r = runCli(root, ["v2", "build", "a configuration probe", "--repo", REPO, "--json", ...args], extraEnv);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { result: sessionFinalAttempt(r.stdout), stdout: r.stdout, stderr: r.stderr, status: r.status };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("config truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── THE test ────────────────────────────────────────────────────────────────

test("config truth: `profile use` changes what a v2 build actually sees — no exports", () => {
  const root = makeStateRoot();

  // The operator chooses a strategy, through the real activation command.
  const activateA = runCli(root, ["profile", "use", "prof-alpha"]);
  assert.equal(activateA.status, 0, `activation failed:\n${activateA.stdout}\n${activateA.stderr}`);

  const runA = v2Run(root);
  assert.equal(runA.result.receipt.configuration?.profile, "prof-alpha", "v2 observed the operator's selection");
  assert.equal(runA.result.receipt.configuration?.profileSource, "active_profile");
  assert.equal(runA.result.policy?.rolePreferences.find((p) => p.role === "builder")?.modelId, "alpha-1");

  // The operator changes their mind. Nothing else changes — no shell, no env, no flags.
  const activateB = runCli(root, ["profile", "use", "prof-beta"]);
  assert.equal(activateB.status, 0, `activation failed:\n${activateB.stdout}\n${activateB.stderr}`);

  const runB = v2Run(root);
  assert.equal(runB.result.receipt.configuration?.profile, "prof-beta", "v2 observed the NEW selection");
  assert.equal(runB.result.policy?.rolePreferences.find((p) => p.role === "builder")?.modelId, "beta-1");

  // The policy identity moved with the configuration — this is what a receipt records.
  assert.notEqual(
    runA.result.receipt.configuration?.policyId,
    runB.result.receipt.configuration?.policyId,
    "switching strategy must change the runtime policy identity",
  );
  // The machine's capabilities did not change, so the inventory digest must NOT move.
  assert.equal(
    runA.result.receipt.configuration?.inventoryDigest,
    runB.result.receipt.configuration?.inventoryDigest,
    "provider availability is independent of the operator's strategy",
  );
});

test("config truth: re-running the SAME configuration reproduces the SAME policy id", () => {
  const root = makeStateRoot();
  assert.equal(runCli(root, ["profile", "use", "prof-alpha"]).status, 0);
  const first = v2Run(root).result.receipt.configuration?.policyId;
  const second = v2Run(root).result.receipt.configuration?.policyId;
  assert.equal(first, second, "configuration identity is content-addressed, not per-run");
});

test("config truth: `--profile` overrides the standing selection for one run only", () => {
  const root = makeStateRoot();
  assert.equal(runCli(root, ["profile", "use", "prof-alpha"]).status, 0);

  const overridden = v2Run(root, ["--profile", "prof-beta"]).result;
  assert.equal(overridden.receipt.configuration?.profile, "prof-beta");
  assert.equal(overridden.receipt.configuration?.profileSource, "run_override");

  const afterwards = v2Run(root).result;
  assert.equal(afterwards.receipt.configuration?.profile, "prof-alpha", "the standing pointer was not rewritten");
});

// ── truthful failure ────────────────────────────────────────────────────────

test("config truth: an active pointer at a missing profile FAILS preflight", () => {
  const root = makeStateRoot();
  writeFileSync(join(root, "active-profile"), "vanished\n");
  const { result, status } = v2Run(root);
  assert.notEqual(status, 0);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "preflight");
  assert.equal(result.outcome.failure.code, "preflight.active_profile_unresolvable");
  assert.equal(result.policy, undefined, "no policy is invented for a broken selection");
  assert.equal(result.receipt.evidence.configurationResolved, false);
});

test("config truth: a profile naming a model this machine cannot route FAILS", () => {
  // Simulates the roster changing after activation: the pointer is valid, the profile
  // parses, and the strategy is nonetheless no longer coherent.
  const root = makeStateRoot();
  assert.equal(runCli(root, ["profile", "use", "prof-alpha"]).status, 0);
  writeProfile(root, profile("prof-alpha", "model-that-does-not-exist", "alpha"));
  const { result } = v2Run(root);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "preflight.profile_model_not_in_inventory");
});

test("config truth: a broken selection is NEVER silently swapped for a working one", () => {
  const root = makeStateRoot();
  writeFileSync(join(root, "active-profile"), "vanished\n");
  const { result, stdout } = v2Run(root);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(stdout.includes("prof-alpha"), false, "no other profile was substituted");
  assert.equal(stdout.includes("prof-beta"), false);
});

test("config truth: a missing pointer is the documented NO-PROFILE rule, not a failure", () => {
  const root = makeStateRoot();
  // ONE deliberate exception to this suite's no-exports rule: with no profile the
  // operator layer supplies the builder model, and on this machine that would be
  // whatever the INSTALL-ROOT `.env` prefers — an endpoint this test cannot reach.
  // Pinning it keeps the assertion about the no-profile RULE rather than about this
  // machine's provider setup. Every other test here still exports nothing.
  const { result } = v2Run(root, [], { IKBI_MODEL_DRIVER: "alpha-1", IKBI_MODEL_BUILDER: "alpha-1", IKBI_MODEL_CRITIC: "alpha-1" });
  assert.equal(result.receipt.configuration?.profile, null, "no profile selected");
  assert.equal(result.receipt.configuration?.profileSource, "none");
  assert.ok(result.outcome.kind === "withheld", "the run adjudicates and stops for the ordinary reason");
  // With no profile, the operator/builtin layer still supplies role preferences, so a
  // future resolver is never handed an empty policy just because nothing was selected.
  assert.ok((result.policy?.rolePreferences.length ?? 0) > 0);
  assert.ok(result.policy?.rolePreferences.every((p) => p.source === "builtin_default" || p.source === "operator_env"));
});

test("config truth: inheritance is resolved BEFORE validation", () => {
  const root = makeStateRoot();
  // `derived` inherits its critic from `prof-alpha` and overrides only the builder.
  writeProfile(root, { name: "derived", extends: "prof-alpha", roles: { builder: { provider: "beta", model: "beta-1" } } });
  assert.equal(runCli(root, ["profile", "use", "derived"]).status, 0);
  const { result } = v2Run(root);
  const roles = result.policy?.rolePreferences ?? [];
  assert.equal(result.receipt.configuration?.profile, "derived");
  assert.equal(roles.find((p) => p.role === "builder")?.modelId, "beta-1", "the child's override");
  assert.equal(roles.find((p) => p.role === "critic")?.modelId, "alpha-1", "inherited from the parent");
  assert.deepEqual([...(result.policy?.profile?.inheritanceChain ?? [])], ["derived", "prof-alpha"]);
});

// ── boundaries this slice must not cross ────────────────────────────────────

test("config truth: configuration, resolution, context and invocation all really run", () => {
  const root = makeStateRoot();
  assert.equal(runCli(root, ["profile", "use", "prof-alpha"]).status, 0);
  const { result } = v2Run(root);
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition"]);
  assert.equal(result.receipt.evidence.configurationResolved, true);
  assert.equal(result.receipt.evidence.modelResolutionCompleted, true, "a route was authorized");
  assert.equal(result.receipt.evidence.contextAssemblyCompleted, true, "context was assembled");
  assert.equal(result.receipt.evidence.providerInvoked, true, "and the authorized route was really called");
  assert.equal(result.receipt.evidence.invocations, 2, "V2-009: builder + critic");
  assert.ok(result.outcome.kind === "withheld", "the candidate is adjudicated and withheld — nothing promoted");
  assert.equal(result.receipt.stagesEntered.includes("promotion"), false, "and the run stops before promotion");
});

test("config truth: configuration never mutates state — the pointer and repo are untouched", () => {
  const root = makeStateRoot();
  assert.equal(runCli(root, ["profile", "use", "prof-alpha"]).status, 0);
  const before = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout;
  v2Run(root);
  v2Run(root, ["--profile", "prof-beta"]);
  assert.equal(runCli(root, ["profile", "current"]).stdout.includes("prof-alpha"), true, "v2 did not rewrite the pointer");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout, before, "repo untouched");
});

// ── secrets ─────────────────────────────────────────────────────────────────

test("config truth: no credential reaches v2 output, from a provider OR a profile", () => {
  const root = makeStateRoot();
  writeProfile(root, {
    ...profile("prof-alpha", "alpha-1", "alpha"),
    parameters: { OPENAI_API_KEY: PLANTED_SECRET, temperature: 0.2 },
  });
  assert.equal(runCli(root, ["profile", "use", "prof-alpha"]).status, 0);
  const { result, stdout, stderr } = v2Run(root);
  assert.equal(stdout.includes(PLANTED_SECRET), false, "the planted key leaked to stdout");
  assert.equal(stderr.includes(PLANTED_SECRET), false, "the planted key leaked to stderr");
  assert.equal(JSON.stringify(result).includes(PLANTED_SECRET), false, "the planted key leaked into the result");
  assert.equal(result.policy?.profile?.parameters.OPENAI_API_KEY, "[redacted]");
  // And the human rendering is clean too.
  const human = runCli(root, ["v2", "build", "probe", "--repo", REPO]);
  assert.equal(human.stdout.includes(PLANTED_SECRET), false);
  assert.equal(human.stderr.includes(PLANTED_SECRET), false);
});

test("config truth: readiness is reported as CONFIGURED, never as reachable", () => {
  const root = makeStateRoot();
  const { result } = v2Run(root);
  const alpha = result.policy?.inventory.providers.find((p) => p.id === "alpha");
  const keyed = result.policy?.inventory.providers.find((p) => p.id === "keyed");
  assert.equal(alpha?.readiness, "keyless");
  assert.equal(keyed?.readiness, "configured", "a key is present — nothing was contacted to learn that");
  assert.equal(JSON.stringify(result).includes("reachable"), false, "v2 makes no reachability claim");
});
