/**
 * PRODUCTION REACHABILITY (in-process half).
 *
 * A feature is not done because a class exists and has unit tests — that is the
 * exact failure v2 is being built to stop repeating. So this suite asserts the
 * command is really wired into the CLI's dispatch registry (the same registry
 * `src/cli/index.ts` consults for every subcommand), and that driving the command
 * body produces output that could only have come from the canonical v2 lifecycle.
 *
 * The end-to-end half — real argv through the real built binary — is
 * `cli-subprocess.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { commands } from "../../cli/registry.js";
import type { ConfigurationSource } from "../core/config.js";
import type { InvocationTransport } from "../core/invocation.js";
import type { StateBoundMutationAuthority, V2WorkspaceRecord, WorkspaceAuthority } from "../core/workspace.js";
import { LIFECYCLE_STAGES } from "../core/lifecycle.js";
import type { V2RunResult } from "../core/result.js";
import { FIRST_UNIMPLEMENTED_STAGE } from "../core/run.js";
import { V2_BANNER, parseV2Args, renderRun, runV2Cli } from "./index.js";

/**
 * A hermetic configuration source. These tests are about CLI dispatch reaching the
 * spine; they must not read (or depend on) the operator's real ~/.ikbi state. The
 * subprocess suite covers the real production wiring.
 */
const hermeticConfiguration: ConfigurationSource = {
  load: async () => ({
    inventory: {
      providers: [
        { id: "alpha", introspectable: true, kind: "openai-compatible", baseUrl: "https://alpha.test/v1", credentialRequired: false, credentialPresent: false },
      ],
      models: [
        {
          id: "alpha-1",
          routes: [{ providerId: "alpha", providerModelId: "a1" }],
          capabilities: { contextWindow: 100_000, supportsTools: true, reasoningLevel: "medium", speedClass: "medium", provenance: "declared" },
        },
      ],
    },
    activeProfile: { kind: "none" },
    operatorDefaults: { models: [{ tier: "builder", modelId: "alpha-1", explicit: true }, { tier: "critic", modelId: "alpha-1", explicit: true }] },
  }),
};


/** A hermetic transport: no network, deterministic answer, echoes the wire model id. */
const fakeTransport: InvocationTransport = {
  send: async (input) => {
    // V2-009: the CRITIC call (no tools) gets a valid SATISFIED judgment; the builder call
    // (with tools) finishes immediately. This suite is about REACHABILITY of the spine.
    if (input.tools === undefined || input.tools.length === 0) {
      return { ok: true, response: { content: JSON.stringify({ verdict: "satisfied", summary: "ok", defects: [] }), finishReason: "stop", servedModelId: input.providerModelId, attempts: 1 } };
    }
    return {
      ok: true,
      response: {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "f1", name: "finish_candidate", arguments: JSON.stringify({ summary: "nothing asked of me", believesComplete: true }) }],
        servedModelId: input.providerModelId,
        attempts: 1,
      },
    };
  },
};

/** Hermetic workspace + mutation authorities: no git, no filesystem, no worktree. */
const fakeWorkspaces: WorkspaceAuthority = {
  allocate: async ({ runId, source }) => ({
    ok: true,
    workspace: {
      workspaceId: "ws_reach-00000001" as V2WorkspaceRecord["workspaceId"],
      runId,
      donorWorkspaceId: "donor-reach",
      source: {
        repositoryPath: source.repositoryRoot,
        baseBranch: "main",
        baseCommit: "c".repeat(40),
        baseTree: "t".repeat(40),
        sourceSnapshotId: source.snapshotId,
        materializedStateDigest: "m".repeat(64),
        materializedEntries: 0,
        startTree: "t".repeat(40),
      },
      path: "/scratch/reach",
      status: "allocated",
      allocatedAt: 1,
    },
  }),
  discard: async () => ({ kind: "discarded" }),
  retain: async (_r, reason) => ({ kind: "retained", reason }),
};

const fakeMutations: StateBoundMutationAuthority = {
  observe: async () => {
    throw new Error("no context artifact exists in these tests, so nothing should be observed");
  },
  read: async () => {
    throw new Error("no context artifact exists in these tests, so nothing should be read");
  },
  mutate: async () => {
    throw new Error("the production skeleton must never mutate");
  },
};

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    cwd: process.cwd(),
    configuration: hermeticConfiguration,
    // No context sources: the package is exactly the operator's goal, so these tests
    // stay about CLI dispatch rather than about this repository's files.
    contextSources: [] as const,
    transport: fakeTransport,
    workspaces: fakeWorkspaces,
    mutations: fakeMutations,
    // The builder seams, hermetic like the rest: this suite has no worktree to capture a
    // tree from. What the real ones do is `runtime/builder-tools.test.ts` and
    // `cli/builder-truth.test.ts`.
    buildTools: () => ({ execute: async () => ({ outcome: { kind: "rejected" as const, reason: "unknown_tool" as const, detail: "no tools here" } }) }),
    captureTree: async () => ({
      ok: true as const,
      tree: { treeId: "t".repeat(40), baseTreeId: "t".repeat(40), startTree: "t".repeat(40), materializedStateDigest: "m".repeat(64), changed: false },
    }),
    // V2-008: hermetic verification seams. The tree probe returns the SAME id captureTree
    // froze (no drift), and there are no checks → verdict no_checks. This suite is about
    // REACHABILITY of the spine, not about running real governed checks.
    checksSource: { resolve: async () => ({ ok: false as const, reason: "hermetic reachability suite: no checks" }) },
    checkRunner: { run: async () => ({ launched: false as const, timedOut: false, durationMs: 0, outputSha256: "0".repeat(64), outputExcerpt: "" }) },
    treeProbe: { treeOf: async () => "t".repeat(40) },
    candidateDiff: { diff: async (i: { candidateId: string; sourceSnapshotId: string; fromTree: string; toTree: string }) => ({ diffId: "d".repeat(64) as never, candidateId: i.candidateId as never, sourceSnapshotId: i.sourceSnapshotId as never, fromTree: i.fromTree, toTree: i.toTree, files: [], empty: true, truncated: false }) },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

test("reachability: `ikbi v2` is REGISTERED in the CLI dispatch registry", () => {
  const cmd = commands.get("v2");
  assert.ok(cmd !== undefined, "importing the v2 CLI registers the command");
  assert.equal(cmd!.category, "advanced", "v2 is experimental — it stays out of the default help");
  assert.match(cmd!.summary, /EXPERIMENTAL/);
  assert.match(cmd!.usage ?? "", /v2 build/);
});

test("reachability: v2 registers into the SAME registry v1 dispatches from", () => {
  // The shared, process-wide registrar rejects duplicates — so a successful second
  // registration attempt would mean this suite is talking to some other registry.
  assert.throws(
    () => commands.register({ name: "v2", summary: "duplicate", run: () => undefined }),
    /already registered/,
  );
  assert.ok(commands.all().some((c) => c.name === "v2"), "`ikbi help --advanced` will list it");
});

test("reachability: the command body enters the canonical lifecycle and reports it", async () => {
  const cap = capture();
  const code = await runV2Cli(["build", "add", "a", "thing"], cap);
  assert.equal(cap.err, V2_BANNER, "the experimental banner goes to stderr, not stdout");
  assert.match(
    cap.out,
    /stages\s+preflight -> model_resolution -> context -> candidate_strategy -> candidate_generation -> verification -> criticism$/m,
    "the run walked the whole implemented spine",
  );
  assert.match(cap.out, /not implemented/, "and said so truthfully");
  assert.notEqual(code, 0, "an unimplemented lifecycle is not a success");
});

test("reachability: the JSON surface carries the lifecycle journal + a counted receipt", async () => {
  const cap = capture();
  await runV2Cli(["build", "x", "--json"], cap);
  const result = JSON.parse(cap.out) as V2RunResult;
  // Only the real lifecycle produces this: a journal that starts at `pending`, enters
  // preflight, and ends at `terminal`. A CLI that shortcut past the spine could not.
  assert.equal(result.journal[0]?.from, "pending");
  assert.equal(result.journal[0]?.to, "preflight");
  assert.equal(result.journal.at(-1)?.to, "terminal");
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism"]);
  assert.equal(result.outcome.kind, "failed");
  assert.deepEqual(result.receipt.evidence, {
    // Configuration (V2-002) and route authorization (V2-003) happen — and nothing else.
    configurationResolved: true,
    sourceSnapshotCaptured: true,
    sourceSnapshots: 1,
    modelResolutionCompleted: true,
    // V2-009: builder AND critic roles are each resolved once.
    modelResolutions: 2,
    contextAssemblyCompleted: true,
    // FALSE, honestly: this run injects its own context sources, so no retrieval was
    // wired and none is claimed. A run only reports what it actually did.
    retrievalPerformed: false,
    contextPackages: 1,
    providerInvoked: true,
    // V2-009: the builder's finish turn AND the critic's one judgment.
    invocations: 2,
    workspacesAllocated: 1,
    observationsTaken: 0,
    mutationsApplied: 0,
    // V2-007: the builder finished having changed nothing — a legitimate no-change
    // candidate, and still verified by nothing.
    candidatesCreated: 1,
    candidateMutated: false,
    // V2-008: the candidate WAS verified (no_checks, hermetically).
    verificationsPerformed: 1,
    promotionsAttempted: 0,
    promoted: false,
    sourceRepositoryMutated: false,
  });
});

test("reachability: the CLI never claims a stage it did not run", async () => {
  const cap = capture();
  await runV2Cli(["build", "x", "--json"], cap);
  const result = JSON.parse(cap.out) as V2RunResult;
  for (const stage of LIFECYCLE_STAGES) {
    if (stage === "preflight" || stage === "model_resolution" || stage === "context" || stage === "candidate_strategy" || stage === "candidate_generation" || stage === "verification" || stage === "criticism") continue;
    assert.equal(result.receipt.stagesEntered.includes(stage), false, `never entered ${stage}`);
  }
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.detail?.missingStage, FIRST_UNIMPLEMENTED_STAGE);
});

test("reachability: an unknown v2 subcommand is refused, not silently built", async () => {
  const cap = capture();
  const code = await runV2Cli(["promote", "everything"], cap);
  assert.equal(code, 2);
  assert.equal(cap.out, "", "nothing was printed as if a run had happened");
  assert.match(cap.err, /unknown subcommand/);
});

test("reachability: a bad repo path fails preflight through the CLI", async () => {
  const cap = capture();
  const code = await runV2Cli(["build", "x", "--repo", "/nonexistent/ikbi-v2-probe"], cap);
  assert.notEqual(code, 0);
  assert.match(cap.out, /\[preflight\] no such path/);
});

test("reachability: argv parsing keeps multi-word goals and flags apart", () => {
  const args = parseV2Args(["build", "make", "the", "thing", "--repo", "/r", "--strategy", "tournament", "--json"], "/cwd");
  assert.equal(args.subcommand, "build");
  assert.equal(args.goal, "make the thing");
  assert.equal(args.repo, "/r");
  assert.equal(args.strategy, "tournament");
  assert.equal(args.json, true);
  assert.equal(parseV2Args(["build", "solo"], "/cwd").repo, "/cwd", "the repo defaults to the cwd");
});

test("reachability: the human rendering shows an AUTHORIZATION, not an invocation", async () => {
  const cap = capture();
  await runV2Cli(["build", "x"], cap);
  assert.match(cap.out, /resolved\s+builder -> alpha-1 via alpha/);
  assert.match(cap.out, /authorized, NOT invoked/);
  assert.match(cap.out, /invoked\s+builder -> alpha\/a1/);
  assert.match(cap.out, /provider_invoked=true/);
  assert.match(cap.out, /promoted=false/);
  assert.match(cap.out, /repo_mutated=false/);
  assert.ok(typeof renderRun === "function");
});
