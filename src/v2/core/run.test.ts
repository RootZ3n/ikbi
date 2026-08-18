/**
 * The canonical run function — the production spine.
 *
 * The central assertions here are the NEGATIVE ones: a skeleton run must not claim
 * a provider was called, a candidate was made, verification happened, or anything
 * was promoted. Slice 001 exists partly to make those claims impossible from day
 * one, so a later slice cannot quietly regress into optimistic reporting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConfigurationSource } from "./config.js";
import { V2_001_FAILURE_CODES } from "./failure.js";
import { createSequentialIdFactory, isV2Id } from "./identity.js";
import { LIFECYCLE_STAGES } from "./lifecycle.js";
import { exitCodeForOutcome } from "./result.js";
import { FIRST_UNIMPLEMENTED_STAGE, IMPLEMENTED_THROUGH_STAGE, MAX_GOAL_LENGTH, planFor, preflight, runV2Build, type RepoProbe } from "./run.js";

/** A probe that answers "yes, a healthy git repo" without touching a filesystem. */
const goodRepo: RepoProbe = { inspect: () => ({ exists: true, isDirectory: true, hasGitDir: true }) };
const missingRepo: RepoProbe = { inspect: () => ({ exists: false, isDirectory: false, hasGitDir: false }) };
const fileNotDir: RepoProbe = { inspect: () => ({ exists: true, isDirectory: false, hasGitDir: false }) };
const notGit: RepoProbe = { inspect: () => ({ exists: true, isDirectory: true, hasGitDir: false }) };

/**
 * A configuration source that observes an empty machine: no providers, no models, no
 * profile, no operator defaults. Used for the cases that must fail BEFORE resolution.
 */
const emptyConfiguration: ConfigurationSource = {
  load: async () => ({
    inventory: { providers: [], models: [] },
    activeProfile: { kind: "none" },
    operatorDefaults: { models: [] },
  }),
};

/**
 * The smallest machine on which the builder role can actually be authorized: one keyless
 * provider, one model routed through it, and an operator default naming that model.
 * These tests are about the SPINE, so configuration is held at its most boring — the
 * configuration boundary and the resolver each have their own suite.
 */
const workingConfiguration: ConfigurationSource = {
  load: async () => ({
    inventory: {
      providers: [
        { id: "alpha", introspectable: true, kind: "openai-compatible", baseUrl: "https://alpha.test/v1", credentialRequired: false, credentialPresent: false },
      ],
      models: [{ id: "alpha-1", routes: [{ providerId: "alpha", providerModelId: "a1" }] }],
    },
    activeProfile: { kind: "none" },
    operatorDefaults: { models: [{ tier: "builder", modelId: "alpha-1", explicit: true }] },
  }),
};

function deps(probe: RepoProbe, configuration: ConfigurationSource = workingConfiguration) {
  let tick = 0;
  return { ids: createSequentialIdFactory("run"), now: () => (tick += 1), probe, configuration };
}

test("run: a valid request mints task + run identities and enters the lifecycle", async () => {
  const result = await runV2Build({ goal: "add a health endpoint", repoPath: "/repo" }, deps(goodRepo));
  assert.ok(isV2Id("task", result.taskId));
  assert.ok(isV2Id("run", result.runId));
  assert.ok(isV2Id("receipt", result.receipt.receiptId));
  assert.deepEqual([...result.receipt.stagesEntered], ["preflight", "model_resolution"]);
  assert.equal(result.journal[0]?.from, "pending");
  assert.equal(result.journal[0]?.to, "preflight");
  assert.equal(result.journal.at(-1)?.to, "terminal");
});

test("run: the skeleton STOPS truthfully — not_implemented, naming the missing stage", async () => {
  const result = await runV2Build({ goal: "do a thing", repoPath: "/repo" }, deps(goodRepo));
  assert.equal(result.outcome.kind, "failed");
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented");
  assert.equal(result.outcome.failure.code, V2_001_FAILURE_CODES.stageNotImplemented);
  assert.equal(result.outcome.failure.stage, IMPLEMENTED_THROUGH_STAGE);
  assert.equal(result.outcome.failure.detail?.missingStage, FIRST_UNIMPLEMENTED_STAGE);
  assert.equal(result.outcome.failure.retryable, false, "re-running does not make an unimplemented stage exist");
});

test("run: NO FAKE SUCCESS — the receipt reports zero work, counted not asserted", async () => {
  const result = await runV2Build({ goal: "build the whole product", repoPath: "/repo" }, deps(goodRepo));
  const e = result.receipt.evidence;
  assert.equal(e.modelResolutionCompleted, true, "a route WAS authorized");
  assert.equal(e.modelResolutions, 1, "exactly one");
  assert.equal(e.providerInvoked, false, "no model was invoked");
  assert.equal(e.invocations, 0);
  assert.equal(e.candidatesCreated, 0, "no candidate was created");
  assert.equal(e.verificationsPerformed, 0, "nothing was verified");
  assert.equal(e.promotionsAttempted, 0);
  assert.equal(e.promoted, false, "nothing was promoted");
  assert.equal(e.repositoryMutated, false, "the repository was not touched");
});

test("run: the skeleton never claims to have reached a stage it did not run", async () => {
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo));
  const implemented = new Set<string>(["preflight", IMPLEMENTED_THROUGH_STAGE]);
  for (const stage of LIFECYCLE_STAGES) {
    if (implemented.has(stage)) continue;
    assert.equal(result.receipt.stagesEntered.includes(stage), false, `"${stage}" was never entered`);
  }
});

test("run: an AUTHORIZATION is not an invocation — no InvocationId is minted", async () => {
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo));
  assert.ok(result.decision !== undefined, "a route was authorized");
  assert.equal(result.receipt.evidence.providerInvoked, false);
  assert.equal(result.receipt.evidence.invocations, 0, "no V2InvocationId exists — nothing was invoked");
  assert.equal(result.receipt.resolution?.modelId, "alpha-1");
  assert.equal(result.receipt.resolution?.providerId, "alpha");
});

test("run: a role with NO configured preference fails truthfully at resolution", async () => {
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, emptyConfiguration));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "resolution");
  assert.equal(result.outcome.failure.code, "resolution.role_not_configured");
  assert.equal(result.outcome.failure.stage, "model_resolution");
  assert.equal(result.decision, undefined, "no decision is invented for a failed resolution");
  assert.equal(result.receipt.evidence.modelResolutionCompleted, false);
  assert.deepEqual([...result.receipt.stagesEntered], ["preflight", "model_resolution"], "the stage really ran and really refused");
});

test("run: an empty goal fails as a TASK error, inside the lifecycle", async () => {
  const result = await runV2Build({ goal: "   ", repoPath: "/repo" }, deps(goodRepo));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "task");
  assert.equal(result.outcome.failure.code, V2_001_FAILURE_CODES.goalEmpty);
  assert.deepEqual([...result.receipt.stagesEntered], ["preflight"], "even a rejected request goes through the machine");
});

test("run: an oversized goal is rejected as input, not attempted as a build", async () => {
  const result = await runV2Build({ goal: "x".repeat(MAX_GOAL_LENGTH + 1), repoPath: "/repo" }, deps(goodRepo));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, V2_001_FAILURE_CODES.goalTooLong);
});

test("run: preflight fails closed on every unusable repository shape", async () => {
  const cases: readonly [RepoProbe, string][] = [
    [missingRepo, V2_001_FAILURE_CODES.repoMissing],
    [fileNotDir, V2_001_FAILURE_CODES.repoNotDirectory],
    [notGit, V2_001_FAILURE_CODES.repoNotGit],
  ];
  for (const [probe, code] of cases) {
    const result = await runV2Build({ goal: "go", repoPath: "/repo" }, deps(probe));
    assert.ok(result.outcome.kind === "failed");
    assert.equal(result.outcome.failure.category, "preflight");
    assert.equal(result.outcome.failure.code, code);
  }
});

test("run: an unknown candidate strategy is refused rather than defaulted", async () => {
  const result = await runV2Build({ goal: "go", repoPath: "/repo", candidateStrategy: "competitive" }, deps(goodRepo));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, V2_001_FAILURE_CODES.strategyUnknown);
});

test("run: shadow and tournament are ACCEPTED strategies and reach the same stop point", async () => {
  for (const candidateStrategy of ["single", "shadow", "tournament"] as const) {
    const result = await runV2Build({ goal: "go", repoPath: "/repo", candidateStrategy }, deps(goodRepo));
    assert.ok(result.outcome.kind === "failed");
    assert.equal(result.outcome.failure.category, "not_implemented", `${candidateStrategy} passes preflight`);
    assert.equal(result.receipt.evidence.candidatesCreated, 0, `${candidateStrategy} produced nothing (nothing runs yet)`);
  }
});

test("run: preflight normalizes a relative repo path to absolute", () => {
  const checked = preflight({ goal: "g", repoPath: "some/where" }, goodRepo);
  assert.ok(checked.ok);
  assert.ok(checked.task.repoPath.startsWith("/"), `expected an absolute path, got ${checked.task.repoPath}`);
  assert.equal(checked.task.candidateStrategy, "single", "the default strategy is single");
});

test("run: the resolved strategy plan keeps multi-candidate strategies multi-candidate", () => {
  const shadow = preflight({ goal: "g", repoPath: "/repo", candidateStrategy: "shadow" }, goodRepo);
  assert.ok(shadow.ok);
  assert.ok(planFor(shadow.task).maxCandidates > 1);
  const single = preflight({ goal: "g", repoPath: "/repo" }, goodRepo);
  assert.ok(single.ok);
  assert.equal(planFor(single.task).maxCandidates, 1);
});

test("run: a not_implemented stop is a non-zero exit — it is not success", async () => {
  const result = await runV2Build({ goal: "go", repoPath: "/repo" }, deps(goodRepo));
  assert.notEqual(exitCodeForOutcome(result.outcome), 0);
});

test("run: the real (unstubbed) probe accepts THIS repository and still refuses to build", async () => {
  // Uses the production RepoProbe against ikbi's own checkout: proves the default
  // path is wired, and that even a perfectly good repo yields no build in this slice.
  const result = await runV2Build({ goal: "inspect ikbi itself", repoPath: process.cwd() }, { configuration: workingConfiguration });
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "not_implemented");
  assert.equal(result.receipt.evidence.repositoryMutated, false);
});
