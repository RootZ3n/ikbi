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
import type { ContextSource } from "./context.js";
import type { InvocationTransport } from "./invocation.js";
import type { StateBoundMutationAuthority, V2WorkspaceRecord, WorkspaceAuthority } from "./workspace.js";
import { observationDigest } from "./workspace.js";
import type { SourceSnapshot, SourceSnapshotAuthority, SourceSnapshotReader } from "./source.js";
import { DEFAULT_SOURCE_POLICY } from "./source.js";
import { V2_001_FAILURE_CODES } from "./failure.js";
import { createSequentialIdFactory, isV2Id } from "./identity.js";
import { LIFECYCLE_STAGES } from "./lifecycle.js";
import { exitCodeForOutcome } from "./result.js";
import { IMPLEMENTED_THROUGH_STAGE, MAX_GOAL_LENGTH, planFor, preflight, runV2Build, type RepoProbe } from "./run.js";
import type { PromotionTarget, PublicationOutcome } from "./promotion.js";

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
      models: [
        {
          id: "alpha-1",
          routes: [{ providerId: "alpha", providerModelId: "a1" }],
          // A KNOWN window: without capability facts the context budget cannot be
          // derived, which is its own (separately tested) failure.
          capabilities: { contextWindow: 100_000, supportsTools: true, reasoningLevel: "medium", speedClass: "medium", provenance: "declared" },
        },
      ],
    },
    activeProfile: { kind: "none" },
    operatorDefaults: { models: [{ tier: "builder", modelId: "alpha-1", explicit: true }, { tier: "critic", modelId: "alpha-1", explicit: true }] },
  }),
};

/** No context sources: the package then contains exactly the operator's goal. */
const noSources: readonly ContextSource[] = [];


/**
 * A transport that records what it was asked to send and answers deterministically.
 * It reaches no network — these tests are about the SPINE.
 */
function fakeTransport(over: { servedModelId?: string | null; attempts?: number } = {}) {
  const sent: { providerId: string; providerModelId: string; messages: readonly { role: string; content: string }[] }[] = [];
  const transport: InvocationTransport = {
    send: async (input) => {
      sent.push({ providerId: input.providerId, providerModelId: input.providerModelId, messages: input.messages });
      // V2-009: the CRITIC call carries no tools — serve a valid SATISFIED judgment so the
      // spine reaches its stop point (disposition). The builder call (with tools) finishes
      // immediately, as before.
      if (input.tools === undefined || input.tools.length === 0) {
        return {
          ok: true,
          response: {
            content: JSON.stringify({ verdict: "satisfied", summary: "the candidate satisfies the task", defects: [] }),
            finishReason: "stop",
            ...(over.servedModelId === null ? {} : { servedModelId: over.servedModelId ?? input.providerModelId }),
            usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
            attempts: over.attempts ?? 1,
          },
        };
      }
      return {
        ok: true,
        response: {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "f1", name: "finish_candidate", arguments: JSON.stringify({ summary: "nothing to change", believesComplete: true }) },
          ],
          ...(over.servedModelId === null ? {} : { servedModelId: over.servedModelId ?? input.providerModelId }),
          usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
          attempts: over.attempts ?? 1,
        },
      };
    },
  };
  return { transport, sent };
}

/** An in-memory source snapshot: a clean HEAD with a configurable set of readable files. */
function fakeSources(files: Readonly<Record<string, string>> = {}, snapshotId = "s".repeat(64)) {
  const snapshot = {
    snapshotId: snapshotId as SourceSnapshot["snapshotId"],
    repositoryRoot: "/repo",
    headCommit: "c".repeat(40),
    headTree: "t".repeat(40),
    clean: true,
    policy: DEFAULT_SOURCE_POLICY,
    entries: [],
    exclusions: [],
    counts: { modified: 0, deleted: 0, untrackedIncluded: 0, excluded: 0 },
    capturedAt: 1,
  } satisfies SourceSnapshot;
  const reader: SourceSnapshotReader = {
    snapshot,
    list: async () => Object.keys(files).sort(),
    read: async (path) => {
      const content = files[path];
      if (content === undefined) return { ok: false, reason: "missing", detail: "not in the snapshot" };
      return { ok: true, content, byteLength: Buffer.byteLength(content), contentSha256: `sha-${path}`, origin: "snapshot_delta" };
    },
  };
  const authority: SourceSnapshotAuthority = { capture: async () => ({ ok: true, reader }) };
  return { authority, reader, snapshot };
}

/**
 * In-memory workspace + mutation authorities. These tests are about the SPINE; the real
 * authorities have their own integration suite against real git worktrees.
 */
function fakeWorkspaces(over: { discardFails?: boolean; retainFails?: boolean } = {}) {
  const allocated: V2WorkspaceRecord[] = [];
  const dispositions: string[] = [];
  const authority: WorkspaceAuthority = {
    allocate: async ({ runId, source: sourceSnapshot }) => {
      const workspace: V2WorkspaceRecord = {
        workspaceId: `ws_fake-${allocated.length + 1}0000000` as V2WorkspaceRecord["workspaceId"],
        runId,
        donorWorkspaceId: `donor-${allocated.length + 1}`,
        source: {
          repositoryPath: "/repo",
          baseBranch: "main",
          baseCommit: "c".repeat(40),
          baseTree: "t".repeat(40),
          sourceSnapshotId: sourceSnapshot.snapshotId,
          materializedStateDigest: "m".repeat(64),
          startTree: "t".repeat(40),
          materializedEntries: 0,
        },
        path: `/scratch/${allocated.length + 1}`,
        status: "allocated",
        allocatedAt: 1,
      };
      allocated.push(workspace);
      return { ok: true, workspace };
    },
    discard: async () => {
      dispositions.push("discard");
      return over.discardFails === true
        ? { kind: "failed", attempted: "discard", detail: "worktree busy" }
        : { kind: "discarded" };
    },
    retain: async (_r, reason) => {
      dispositions.push("retain");
      return over.retainFails === true ? { kind: "failed", attempted: "retain", detail: "worktree busy" } : { kind: "retained", reason };
    },
  };
  return { authority, allocated, dispositions };
}

/** An observation authority whose observed hash is configurable, to exercise drift. */
function fakeMutations(sha: string | undefined = undefined) {
  const observed: string[] = [];
  const authority: StateBoundMutationAuthority = {
    observe: async ({ runId, workspace, path }) => {
      observed.push(path);
      const state = { kind: "regular" as const, contentSha256: sha ?? "matching", byteLength: 3, symlinkTarget: null };
      return {
        ok: true,
        observation: {
          observationId: observationDigest({ workspaceId: workspace.workspaceId, path, state }),
          runId,
          workspaceId: workspace.workspaceId,
          path,
          state,
          observedAt: 1,
        },
      };
    },
    read: async ({ runId, workspace, path }) => {
      const state = { kind: "regular" as const, contentSha256: sha ?? "matching", byteLength: 3, symlinkTarget: null };
      observed.push(path);
      return {
        ok: true,
        observation: {
          observationId: observationDigest({ workspaceId: workspace.workspaceId, path, state }),
          runId,
          workspaceId: workspace.workspaceId,
          path,
          state,
          observedAt: 1,
        },
        content: "abc",
      };
    },
    mutate: async () => {
      throw new Error("this suite's builder never writes");
    },
  };
  return { authority, observed };
}

function deps(
  probe: RepoProbe,
  configuration: ConfigurationSource = workingConfiguration,
  contextSources: readonly ContextSource[] = noSources,
  transport: InvocationTransport = fakeTransport().transport,
  workspaces: WorkspaceAuthority = fakeWorkspaces().authority,
  mutations: StateBoundMutationAuthority = fakeMutations().authority,
  sources: SourceSnapshotAuthority = fakeSources().authority,
  publisher?: PromotionTarget,
) {
  let tick = 0;
  return {
    ids: createSequentialIdFactory("run"),
    now: () => (tick += 1),
    probe,
    configuration,
    contextSources,
    transport,
    workspaces,
    mutations,
    sources,
    // V2-007: the builder needs a tool executor and a way to address the resulting tree.
    // This suite drives the SPINE, so both are hermetic — the real ones are proven in
    // `runtime/builder-tools.test.ts` and `cli/builder-truth.test.ts`.
    buildTools: () => ({ execute: async () => ({ outcome: { kind: "rejected" as const, reason: "unknown_tool" as const, detail: "no tools in this suite" } }) }),
    // V2-007A: the boundary is required but never exercised here — this suite's fake
    // builders finish immediately or only nudge, so no tool result carries a payload.
    untrustedBoundary: { wrap: (i: { content: string }) => i.content },
    // V2-008: verification runs on the produced candidate. Hermetic seams — the tree
    // probe returns the SAME id captureTree froze (no drift, no mutation), one check that
    // launches and passes. The real governed path is proven in `cli/verification-truth`.
    checksSource: { resolve: async () => ({ ok: true as const, source: "default" as const, checks: [{ name: "test", command: "faketest", args: [] }] }) },
    checkRunner: { run: async () => ({ launched: true as const, exitCode: 0, timedOut: false, durationMs: 1, outputSha256: "0".repeat(64), outputExcerpt: "" }) },
    treeProbe: { treeOf: async () => "tree".repeat(10) },
    // V2-009: the critic diffs the candidate. Hermetic — no git; an empty model-caused
    // diff. The real governed path is proven in `cli/critic-truth.test.ts`.
    candidateDiff: { diff: async (i: { candidateId: string; sourceSnapshotId: string; fromTree: string; toTree: string }) => ({ diffId: "d".repeat(64) as never, candidateId: i.candidateId as never, sourceSnapshotId: i.sourceSnapshotId as never, fromTree: i.fromTree, toTree: i.toTree, files: [], empty: true, truncated: false }) },
    captureTree: async () => ({
      ok: true as const,
      tree: { treeId: "tree".repeat(10), baseTreeId: "t".repeat(40), startTree: "tree".repeat(10), materializedStateDigest: "m".repeat(64), changed: false },
    }),
    // V2-011: the publication target. Hermetic — the default LANDS the exact candidate tree.
    // The real clean-ref CAS is proven in `cli/promotion-truth.test.ts`.
    publisher: publisher ?? fakePublisher(),
  };
}

/**
 * A hermetic publication target. The default answers a CLEAN, unmoved target and LANDS the
 * candidate tree; overrides drive the refusal/conflict paths without a real repository.
 */
function fakePublisher(over: Partial<{
  liveHead: string | undefined;
  liveTree: string;
  checkout: { checkedOutPath?: string; clean: boolean };
  publish: PublicationOutcome;
}> = {}): PromotionTarget {
  return {
    repositoryIdentity: async () => "/repo/A/.git",
    liveHead: async () => ("liveHead" in over ? over.liveHead : "c".repeat(40)),
    treeOfCommit: async () => over.liveTree ?? "live".repeat(10),
    targetCheckout: async () => over.checkout ?? { clean: true },
    publish: async () => over.publish ?? { kind: "landed", beforeRef: "c".repeat(40), afterCommit: "p".repeat(40), publishedTree: "tree".repeat(10), worktreeSynced: false, stashed: false, journalIntentStatus: "written", journalLandedStatus: "written", postCas: { verified: true, observedRef: "p".repeat(40), observedTree: "tree".repeat(10) } },
  };
}

test("run: a valid request mints task + run identities and enters the lifecycle", async () => {
  const result = await runV2Build({ goal: "add a health endpoint", repoPath: "/repo" }, deps(goodRepo));
  assert.ok(isV2Id("task", result.taskId));
  assert.ok(isV2Id("run", result.runId));
  assert.ok(isV2Id("receipt", result.receipt.receiptId));
  assert.deepEqual([...result.receipt.stagesEntered], ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition", "promotion"]);
  assert.equal(result.journal[0]?.from, "pending");
  assert.equal(result.journal[0]?.to, "preflight");
  assert.equal(result.journal.at(-1)?.to, "terminal");
});

test("run: a clean eligible candidate is ADJUDICATED, PUBLISHED and ACCEPTED", async () => {
  // Default deps: verification PASSES, the critic is SATISFIED, the disposition is
  // acceptable_for_promotion, the source is clean and the (hermetic) publisher LANDS the exact
  // candidate tree — so the run is ACCEPTED and binds the promotion.
  const result = await runV2Build({ goal: "do a thing", repoPath: "/repo" }, deps(goodRepo));
  assert.ok(result.outcome.kind === "accepted");
  assert.equal(result.outcome.candidateId, result.receipt.candidate!.candidateId);
  assert.equal(result.outcome.promotionId, result.receipt.promotion!.promotionId);
  assert.equal(result.receipt.disposition?.decision, "acceptable_for_promotion");
  assert.equal(result.receipt.promotion?.publishedTree, "tree".repeat(10), "the EXACT candidate tree landed");
  assert.equal(result.receipt.promotion?.strategy, "clean_ref_cas");
  assert.equal(result.receipt.stagesEntered.includes("promotion"), true, "the whole spine ran");
  assert.equal(result.receipt.evidence.promoted, true);
  assert.equal(IMPLEMENTED_THROUGH_STAGE, "promotion");
});

test("run: an ACCEPTED run reports exactly what happened, counted", async () => {
  const result = await runV2Build({ goal: "build the whole product", repoPath: "/repo" }, deps(goodRepo));
  const e = result.receipt.evidence;
  assert.equal(e.modelResolutionCompleted, true, "a route WAS authorized");
  assert.equal(e.modelResolutions, 2, "V2-009: builder AND critic roles are each resolved once");
  assert.equal(e.contextAssemblyCompleted, true, "context WAS assembled");
  assert.equal(e.contextPackages, 1, "exactly one package");
  assert.equal(e.providerInvoked, true, "a model IS invoked");
  assert.equal(e.invocations, 2, "V2-009: builder + critic — promotion adds NO model call");
  assert.equal(e.workspacesAllocated, 1, "one isolated workspace");
  assert.equal(e.mutationsApplied, 0, "this builder wrote nothing — and says so");
  assert.equal(e.candidateMutated, false);
  assert.equal(e.candidatesCreated, 1, "the builder finished, so there is a candidate");
  assert.equal(e.verificationsPerformed, 1, "V2-008: the produced candidate WAS verified");
  assert.equal(e.promotionsAttempted, 1, "V2-011: one publication landed");
  assert.equal(e.promoted, true, "the candidate was published");
  assert.equal(e.sourceRepositoryMutated, true, "an accepted run changes the operator's repository");
});

test("run: a no-change candidate is LEGITIMATE — 'no diff' is not the builder's to fail", async () => {
  const result = await runV2Build({ goal: "check something", repoPath: "/repo" }, deps(goodRepo));
  const candidate = result.receipt.candidate!;
  assert.equal(candidate.mutations, 0);
  assert.deepEqual([...candidate.changedPaths], []);
  assert.equal(candidate.changed, false);
  assert.equal(candidate.claimBelievesComplete, true, "the builder's belief, recorded as a claim");
  // A no-change candidate is still a real candidate: verified, adjudicated, and (clean +
  // eligible) published like any other.
  assert.ok(result.outcome.kind === "accepted");
  assert.equal(result.receipt.disposition?.candidateId, candidate.candidateId);
});

test("run: the spine never claims to have reached a stage it did not run", async () => {
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo));
  const implemented = new Set<string>(["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition", IMPLEMENTED_THROUGH_STAGE]);
  for (const stage of LIFECYCLE_STAGES) {
    if (implemented.has(stage)) continue;
    assert.equal(result.receipt.stagesEntered.includes(stage), false, `"${stage}" was never entered`);
  }
});

test("run: each authorized route is sent EXACTLY as authorized — builder then critic", async () => {
  const fake = fakeTransport();
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, fake.transport));
  // Two outbound attempts: the builder's finish turn, then the critic's judgment. No retry.
  assert.equal(fake.sent.length, 2, "one builder call, one critic call — no retry, no fallback");
  for (const sent of fake.sent) {
    assert.equal(sent.providerId, "alpha");
    assert.equal(sent.providerModelId, "a1", "the WIRE id from the decision, not the logical id");
  }
  assert.equal(result.receipt.resolution?.modelId, "alpha-1");
  assert.equal(result.invocations.length, 2);
  assert.equal(result.invocations[0]?.identity.requestedRole, "builder");
  assert.equal(result.invocations[1]?.identity.requestedRole, "critic", "the critic invocation is role-tagged critic");
});

test("run: a failure BEFORE the wire is not counted as an invocation", async () => {
  const refusing: InvocationTransport = {
    send: async () => ({
      ok: false,
      failure: { code: "invocation.provider_not_available", message: "no such provider", providerId: "alpha", attempts: 0 },
    }),
  };
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, refusing));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "provider");
  assert.equal(result.receipt.evidence.providerInvoked, false, "intention is not an invocation");
  assert.equal(result.receipt.evidence.invocations, 0);
  assert.equal(result.invocations[0], undefined);
});

test("run: a failure that REACHED the wire IS counted as an invocation", async () => {
  const failing: InvocationTransport = {
    send: async () => ({
      ok: false,
      failure: { code: "invocation.transport_failure", message: "connection reset", providerId: "alpha", attempts: 1 },
    }),
  };
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, failing));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.receipt.evidence.providerInvoked, true, "a provider WAS contacted");
  assert.equal(result.receipt.evidence.invocations, 1);
  assert.equal(result.invocations[0], undefined, "but there is no successful record");
});

test("run: the context package is bound to the run, task and the resolution it was sized by", async () => {
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo));
  const ctx = result.context!;
  assert.equal(ctx.runId, result.runId);
  assert.equal(ctx.taskId, result.taskId);
  assert.equal(ctx.resolutionDecisionId, result.decision!.decisionId, "sized by the route that was authorized");
  assert.equal(ctx.budget.contextWindowTokens, 100_000);
  assert.equal(ctx.budget.estimated, true, "token counts are labelled as estimates");
  assert.equal(ctx.artifacts.length, 1, "no sources were supplied, so only the goal is present");
  assert.equal(ctx.artifacts[0]?.category, "task");
});

test("run: a model with NO known window fails context truthfully rather than guessing", async () => {
  const unclassified: ConfigurationSource = {
    load: async () => ({
      inventory: {
        providers: [{ id: "alpha", introspectable: true, kind: "openai-compatible", baseUrl: "https://alpha.test/v1", credentialRequired: false, credentialPresent: false }],
        models: [{ id: "mystery", routes: [{ providerId: "alpha", providerModelId: "m" }] }],
      },
      activeProfile: { kind: "none" },
      operatorDefaults: { models: [{ tier: "builder", modelId: "mystery", explicit: true }, { tier: "critic", modelId: "mystery", explicit: true }] },
    }),
  };
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, unclassified));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "context");
  assert.equal(result.outcome.failure.code, "context.model_capability_unknown");
  assert.equal(result.context, undefined, "no package is invented for an unknown budget");
  assert.equal(result.receipt.evidence.contextAssemblyCompleted, false);
  assert.deepEqual([...result.receipt.stagesEntered], ["preflight", "model_resolution", "context"], "the stage really ran and really refused");
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
    assert.ok(result.outcome.kind === "accepted", `${candidateStrategy} passes preflight and publishes`);
    assert.equal(result.receipt.disposition?.decision, "acceptable_for_promotion", `${candidateStrategy} reaches disposition`);
    // Every strategy runs the SAME builder controller, executor and mutation authority.
    // `single` is the only one that generates today; shadow/tournament are accepted at
    // preflight and take the single path until they have their own slice.
    assert.equal(result.receipt.evidence.candidatesCreated, 1, `${candidateStrategy} used the one canonical generator`);
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

test("run: an ACCEPTED run is exit 0", async () => {
  const result = await runV2Build({ goal: "go", repoPath: "/repo" }, deps(goodRepo));
  assert.ok(result.outcome.kind === "accepted");
  assert.equal(exitCodeForOutcome(result.outcome), 0);
});

test("run: a MOVED target refuses publication — withheld, nothing landed", async () => {
  // Uses the production RepoProbe against ikbi's own checkout, and a publisher whose live head
  // has advanced past the authorized base: promotion REFUSES (no auto-merge), so nothing is
  // published and the operator's repository is not mutated.
  const staleTarget = fakePublisher({ liveHead: "moved".repeat(8) });
  const result = await runV2Build(
    { goal: "inspect ikbi itself", repoPath: process.cwd() },
    // Everything wired EXCEPT the probe, so the production RepoProbe is the one used.
    (({ probe: _omitted, ...rest }) => rest)(deps(goodRepo, workingConfiguration, noSources, fakeTransport().transport, fakeWorkspaces().authority, fakeMutations().authority, fakeSources().authority, staleTarget)),
  );
  assert.ok(result.outcome.kind === "withheld");
  assert.equal(result.outcome.reason, "target_moved", "no auto-merge — recovery must re-verify");
  assert.equal(result.receipt.evidence.promoted, false);
  assert.equal(result.receipt.evidence.sourceRepositoryMutated, false);
});

// ── workspace strategy (V2-006) ─────────────────────────────────────────────

test("run: exactly ONE workspace is allocated, bound to the run and the source tree", async () => {
  const ws = fakeWorkspaces();
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, fakeTransport().transport, ws.authority));
  assert.equal(ws.allocated.length, 1, "the SINGLE strategy allocates one workspace");
  assert.equal(ws.allocated[0]?.runId, result.runId);
  assert.equal(result.receipt.workspace?.baseTree, "t".repeat(40), "the exact source tree is recorded");
  assert.equal(result.receipt.workspace?.baseCommit, "c".repeat(40));
});

test("run: the workspace is RETAINED once a candidate exists — verification needs it", async () => {
  const ws = fakeWorkspaces();
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, fakeTransport().transport, ws.authority));
  assert.deepEqual(ws.dispositions, ["retain"], "a candidate is retained even after publication — for undo/audit");
  assert.equal(result.receipt.workspace?.disposition, "retained");
  assert.match(result.receipt.workspace?.dispositionDetail ?? "", /adjudicated acceptable_for_promotion/);
  // The publication landed (hermetic). The workspace is still retained — deleting evidence
  // before an undo/audit trail exists is not this slice's job.
  assert.equal(result.receipt.evidence.promoted, true);
  assert.equal(result.outcome.kind, "accepted");
});

test("run: a generation that FAILS discards its workspace — no leak, no half-tree kept", async () => {
  const ws = fakeWorkspaces();
  // A transport that never lets the builder finish: the loop exhausts its turns.
  const stubborn: InvocationTransport = {
    send: async (input) => ({ ok: true, response: { content: "I am thinking about it.", finishReason: "stop", attempts: 1, servedModelId: input.providerModelId } }),
  };
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, stubborn, ws.authority));
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "build");
  assert.equal(result.receipt.candidate, undefined, "no candidate is claimed");
  assert.deepEqual(ws.dispositions, ["discard"], "and the half-edited tree is not left behind");
});

test("run: a cleanup that FAILS is reported as failed, never as if it worked", async () => {
  // A successful build RETAINS, so a retention that could not complete is the cleanup
  // failure this path now has to report honestly.
  const ws = fakeWorkspaces({ retainFails: true });
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, fakeTransport().transport, ws.authority));
  assert.equal(result.receipt.workspace?.disposition, "failed");
  assert.match(result.receipt.workspace?.dispositionDetail ?? "", /retain failed: worktree busy/);
});

test("run: a DISCARD that fails on a failed build is reported as failed too", async () => {
  const ws = fakeWorkspaces({ discardFails: true });
  const stubborn: InvocationTransport = {
    send: async (input) => ({ ok: true, response: { content: "hmm", finishReason: "stop", attempts: 1, servedModelId: input.providerModelId } }),
  };
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo, workingConfiguration, noSources, stubborn, ws.authority));
  assert.equal(result.receipt.workspace?.disposition, "failed");
  assert.match(result.receipt.workspace?.dispositionDetail ?? "", /discard failed: worktree busy/);
});

test("run: a context artifact is RE-OBSERVED in the workspace before it could be trusted", async () => {
  const source: ContextSource = {
    id: "fixture",
    collect: async () => ({
      candidates: [
        {
          category: "target_file",
          sourceId: "fixture",
          path: "src/widget.ts",
          origin: "repository",
          content: "abc",
          originalBytes: 3,
          truncated: false,
          observedSha256: "matching",
          reason: "the goal names this file",
        },
      ],
      omissions: [],
    }),
  };
  const mut = fakeMutations("matching");
  const result = await runV2Build(
    { goal: "edit src/widget.ts", repoPath: "/repo" },
    deps(goodRepo, workingConfiguration, [source], fakeTransport().transport, fakeWorkspaces().authority, mut.authority),
  );
  assert.deepEqual(mut.observed, ["src/widget.ts"], "the artifact a builder would edit");
  assert.equal(result.receipt.evidence.observationsTaken, 1);
  assert.equal(result.receipt.workspace?.observations, 1);
  assert.ok(result.outcome.kind === "accepted", "and the run adjudicates, publishes and completes normally");
});

test("run: workspace bytes that DIFFER from the context artifact fail — context is not rebuilt", async () => {
  const source: ContextSource = {
    id: "fixture",
    collect: async () => ({
      candidates: [
        {
          category: "target_file",
          sourceId: "fixture",
          path: "src/widget.ts",
          origin: "repository",
          content: "abc",
          originalBytes: 3,
          truncated: false,
          observedSha256: "what-the-model-saw",
          reason: "the goal names this file",
        },
      ],
      omissions: [],
    }),
  };
  const result = await runV2Build(
    { goal: "edit src/widget.ts", repoPath: "/repo" },
    deps(goodRepo, workingConfiguration, [source], fakeTransport().transport, fakeWorkspaces().authority, fakeMutations("what-is-actually-there").authority),
  );
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "mutation");
  assert.equal(result.outcome.failure.code, "workspace.context_artifact_drift");
  assert.equal(result.outcome.failure.detail?.contextSha256, "what-the-model-saw");
  assert.equal(result.outcome.failure.detail?.workspaceSha256, "what-is-actually-there");
});

test("run: a package with no rebindable artifact yields ZERO observations, not a probe file", async () => {
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo));
  assert.equal(result.receipt.evidence.observationsTaken, 0, "nothing was invented to look at");
  assert.equal(result.receipt.workspace?.observations, 0);
});

test("run: the workspace is cleaned up even when the run FAILS", async () => {
  const ws = fakeWorkspaces();
  const drifting: ContextSource = {
    id: "fixture",
    collect: async () => ({
      candidates: [
        { category: "target_file", sourceId: "fixture", path: "a.ts", origin: "repository", content: "a", originalBytes: 1, truncated: false, observedSha256: "one", reason: "r" },
      ],
      omissions: [],
    }),
  };
  const result = await runV2Build(
    { goal: "edit a.ts", repoPath: "/repo" },
    deps(goodRepo, workingConfiguration, [drifting], fakeTransport().transport, ws.authority, fakeMutations("two").authority),
  );
  assert.ok(result.outcome.kind === "failed");
  assert.deepEqual(ws.dispositions, ["discard"], "an allocated workspace never outlives its run");
});

// ── source snapshot (V2-006A) ───────────────────────────────────────────────

test("run: exactly ONE source snapshot is captured, in preflight", async () => {
  const result = await runV2Build({ goal: "x", repoPath: "/repo" }, deps(goodRepo));
  assert.equal(result.receipt.evidence.sourceSnapshotCaptured, true);
  assert.equal(result.receipt.evidence.sourceSnapshots, 1);
  assert.equal(result.receipt.sourceSnapshot?.clean, true);
  assert.equal(result.receipt.sourceSnapshot?.headCommit, "c".repeat(40));
});

test("run: the context package is BOUND to the run's source snapshot", async () => {
  const src = fakeSources({});
  const result = await runV2Build(
    { goal: "x", repoPath: "/repo" },
    deps(goodRepo, workingConfiguration, noSources, fakeTransport().transport, fakeWorkspaces().authority, fakeMutations().authority, src.authority),
  );
  assert.equal(result.context?.sourceSnapshotId, src.snapshot.snapshotId);
});

test("run: the workspace materializes THE SAME snapshot context came from", async () => {
  const src = fakeSources({});
  const ws = fakeWorkspaces();
  const result = await runV2Build(
    { goal: "x", repoPath: "/repo" },
    deps(goodRepo, workingConfiguration, noSources, fakeTransport().transport, ws.authority, fakeMutations().authority, src.authority),
  );
  assert.equal(ws.allocated[0]?.source.sourceSnapshotId, src.snapshot.snapshotId);
  assert.equal(result.receipt.workspace?.sourceSnapshotId, result.context?.sourceSnapshotId, "one source reality, end to end");
});

test("run: a capture failure stops the run before any model resolution", async () => {
  const failing: SourceSnapshotAuthority = {
    capture: async () => ({
      ok: false,
      failure: { category: "preflight", code: "preflight.source_snapshot_failed", message: "no git here", retryable: false },
    }),
  };
  const result = await runV2Build(
    { goal: "x", repoPath: "/repo" },
    deps(goodRepo, workingConfiguration, noSources, fakeTransport().transport, fakeWorkspaces().authority, fakeMutations().authority, failing),
  );
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "preflight.source_snapshot_failed");
  assert.deepEqual([...result.receipt.stagesEntered], ["preflight"], "nothing downstream ran");
  assert.equal(result.receipt.evidence.sourceSnapshotCaptured, false);
});
