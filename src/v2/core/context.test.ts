/**
 * THE CONTEXT AUTHORITY — unit coverage.
 *
 * The load-bearing assertions are about what the assembler refuses to do quietly:
 * overflow, guess a budget, let a source promote itself, or drop something without
 * writing down that it did.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelCapabilityFacts } from "./config.js";
import {
  CHARS_PER_TOKEN,
  CONTEXT_CATEGORIES,
  OVERHEAD_RESERVE_TOKENS,
  V2_CONTEXT_FAILURE_CODES,
  assembleContext,
  categoryPriority,
  deriveBudget,
  estimateTokens,
  manifestOf,
  sha256Text,
  type ContextAssemblyRequest,
  type ContextCandidate,
  type ContextSource,
} from "./context.js";
import { createSequentialIdFactory } from "./identity.js";
import { DEFAULT_SOURCE_POLICY, type SourceSnapshot, type SourceSnapshotReader } from "./source.js";

const ids = createSequentialIdFactory("ctx");
const RUN = ids.mint("run");
const TASK = ids.mint("task");
const DECISION = "d".repeat(64) as ContextAssemblyRequest["resolutionDecisionId"];

const caps = (contextWindow: number, provenance: ModelCapabilityFacts["provenance"] = "declared"): ModelCapabilityFacts => ({
  contextWindow,
  supportsTools: true,
  reasoningLevel: "medium",
  speedClass: "medium",
  provenance,
});

/** A snapshot reader that serves nothing — these tests inject candidates directly. */
function reader(snapshotId = "s".repeat(64)): SourceSnapshotReader {
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
  return { snapshot, read: async () => ({ ok: false, reason: "missing", detail: "not in this snapshot" }) };
}

const request = (over: Partial<ContextAssemblyRequest> = {}): ContextAssemblyRequest => ({
  runId: RUN,
  taskId: TASK,
  goal: "make the widget green",
  source: reader(),
  resolutionDecisionId: DECISION,
  capabilities: caps(100_000),
  ...over,
});

/** A source that offers exactly what it is told to, and reads nothing. */
function fakeSource(id: string, candidates: readonly Partial<ContextCandidate>[], omissions: ContextSource extends never ? never : never[] = []): ContextSource {
  return {
    id,
    collect: async () => ({
      candidates: candidates.map((c) => {
        const content = c.content ?? "x";
        return {
          category: c.category ?? "target_file",
          sourceId: id,
          origin: c.origin ?? "repository",
          content,
          originalBytes: c.originalBytes ?? Buffer.byteLength(content, "utf8"),
          truncated: c.truncated ?? false,
          observedSha256: c.observedSha256 ?? sha256Text(content),
          reason: c.reason ?? "offered by a test source",
          ...(c.path !== undefined ? { path: c.path } : {}),
        };
      }),
      omissions,
    }),
  };
}

async function assemble(sources: readonly ContextSource[], over: Partial<ContextAssemblyRequest> = {}) {
  return assembleContext(request(over), sources);
}

async function packageOf(sources: readonly ContextSource[], over: Partial<ContextAssemblyRequest> = {}) {
  const result = await assemble(sources, over);
  assert.ok(result.ok, `expected a package, got ${result.ok ? "" : result.failure.code}`);
  return result.package;
}

async function failureOf(sources: readonly ContextSource[], over: Partial<ContextAssemblyRequest> = {}) {
  const result = await assemble(sources, over);
  assert.equal(result.ok, false, "expected a context failure");
  assert.ok(!result.ok);
  return result.failure;
}

// ── budget ──────────────────────────────────────────────────────────────────

test("budget: token counts are labelled ESTIMATES, with the divisor recorded", () => {
  const derived = deriveBudget(caps(100_000));
  assert.ok(derived.ok);
  assert.equal(derived.budget.estimated, true);
  assert.equal(derived.budget.accounting, "estimated_chars_per_token");
  assert.equal(derived.budget.charsPerToken, CHARS_PER_TOKEN);
  assert.equal(estimateTokens("abcd".repeat(10)), 10, "the adopted chars/4 heuristic");
});

test("budget: an UNKNOWN model window fails rather than being guessed", () => {
  const derived = deriveBudget(undefined);
  assert.ok(!derived.ok);
  assert.equal(derived.failure.category, "context");
  assert.equal(derived.failure.code, V2_CONTEXT_FAILURE_CODES.modelCapabilityUnknown);
  assert.match(derived.failure.message, /without guessing/);
});

test("budget: reservations leave a smaller input budget than the window", () => {
  const derived = deriveBudget(caps(100_000));
  assert.ok(derived.ok);
  const b = derived.budget;
  assert.equal(b.reservedOverheadTokens, OVERHEAD_RESERVE_TOKENS);
  assert.ok(b.reservedCompletionTokens > 0);
  assert.equal(b.availableInputTokens, b.contextWindowTokens - b.reservedCompletionTokens - b.reservedOverheadTokens);
  assert.ok(b.availableInputTokens < b.contextWindowTokens);
});

test("budget: a window too small to reserve anything from fails explicitly", () => {
  const derived = deriveBudget(caps(1_000));
  assert.ok(!derived.ok);
  assert.equal(derived.failure.code, V2_CONTEXT_FAILURE_CODES.budgetUnusable);
});

test("budget: capability PROVENANCE rides into the budget", async () => {
  const pkg = await packageOf([], { capabilities: caps(100_000, "known") });
  assert.equal(pkg.budget.capabilityProvenance, "known");
});

// ── assembly + priority ─────────────────────────────────────────────────────

test("assembly: the operator's goal is always the first artifact", async () => {
  const pkg = await packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "A" }])]);
  assert.equal(pkg.artifacts[0]?.category, "task");
  assert.equal(pkg.artifacts[0]?.origin, "operator");
  assert.equal(pkg.artifacts[0]?.content, "make the widget green");
});

test("assembly: priority bands are the ONE ordering policy", async () => {
  assert.deepEqual([...CONTEXT_CATEGORIES], ["task", "repository_instructions", "target_file"]);
  const sources = [
    fakeSource("late", [{ category: "target_file", path: "z.ts", content: "Z" }]),
    fakeSource("early", [{ category: "repository_instructions", path: "AGENTS.md", content: "I" }]),
  ];
  const pkg = await packageOf(sources);
  assert.deepEqual(pkg.artifacts.map((a) => a.category), ["task", "repository_instructions", "target_file"]);
  assert.ok(categoryPriority("repository_instructions") < categoryPriority("target_file"));
});

test("assembly: within a band, the order candidates were offered is preserved", async () => {
  const pkg = await packageOf([
    fakeSource("s", [
      { category: "target_file", path: "first.ts", content: "1" },
      { category: "target_file", path: "second.ts", content: "2" },
    ]),
  ]);
  assert.deepEqual(pkg.artifacts.filter((a) => a.category === "target_file").map((a) => a.path), ["first.ts", "second.ts"]);
});

test("assembly: every consulted source is recorded, even one that offered nothing", async () => {
  const pkg = await packageOf([fakeSource("quiet", [])]);
  assert.deepEqual([...pkg.sourcesConsulted], ["task", "quiet"]);
});

// ── no silent overflow ──────────────────────────────────────────────────────

test("overflow: an artifact that does not fit is OMITTED and written down", async () => {
  // A 4k-token window leaves a small input budget; a huge file cannot fit.
  const huge = "x".repeat(200_000);
  const pkg = await packageOf([fakeSource("s", [{ category: "target_file", path: "huge.ts", content: huge }])], {
    capabilities: caps(8_192),
  });
  assert.equal(pkg.artifacts.some((a) => a.path === "huge.ts"), false, "it was not admitted");
  const omission = pkg.omissions.find((o) => o.path === "huge.ts");
  assert.ok(omission !== undefined, "and it was not silently dropped");
  assert.equal(omission.reason, "budget_exceeded");
  assert.equal(omission.estimatedTokens, estimateTokens(huge));
  assert.ok(pkg.estimatedInputTokens <= pkg.budget.availableInputTokens, "the package never exceeds its budget");
});

test("overflow: a later SMALL artifact still fits after a large one is skipped", async () => {
  const huge = "x".repeat(200_000);
  const pkg = await packageOf(
    [fakeSource("s", [
      { category: "target_file", path: "huge.ts", content: huge },
      { category: "target_file", path: "tiny.ts", content: "tiny" },
    ])],
    { capabilities: caps(8_192) },
  );
  assert.ok(pkg.artifacts.some((a) => a.path === "tiny.ts"), "first-fit continues past a skip");
  assert.equal(pkg.omissions.length, 1);
});

test("overflow: a goal that cannot fit FAILS — it is not quietly dropped", async () => {
  const failure = await failureOf([], { goal: "g".repeat(200_000), capabilities: caps(8_192) });
  assert.equal(failure.code, V2_CONTEXT_FAILURE_CODES.budgetExceeded);
  assert.match(failure.message, /task goal alone/);
});

test("overflow: source-level truncation and assembler omission are DIFFERENT records", async () => {
  const pkg = await packageOf([
    fakeSource("s", [{ category: "target_file", path: "big.ts", content: "abc", originalBytes: 99_999, truncated: true }]),
  ]);
  const artifact = pkg.artifacts.find((a) => a.path === "big.ts")!;
  assert.equal(artifact.truncated, true, "the SOURCE bounded it");
  assert.equal(artifact.originalBytes, 99_999, "and the original size is still recorded");
  assert.equal(pkg.omissions.length, 0, "truncation is not an omission");
});

// ── source discipline ───────────────────────────────────────────────────────

test("sources: a source that throws fails the run — it does not shrink the context", async () => {
  const broken: ContextSource = {
    id: "broken",
    collect: async () => {
      throw new Error("disk on fire");
    },
  };
  const failure = await failureOf([broken]);
  assert.equal(failure.code, V2_CONTEXT_FAILURE_CODES.sourceFailed);
  assert.equal(failure.detail?.source, "broken");
});

test("sources: source-reported omissions survive into the package", async () => {
  const reporting: ContextSource = {
    id: "reporting",
    collect: async () => ({
      candidates: [],
      omissions: [{ category: "target_file", sourceId: "reporting", path: "gone.ts", reason: "not_found", detail: "no such file" }],
    }),
  };
  const pkg = await packageOf([reporting]);
  assert.equal(pkg.omissions[0]?.reason, "not_found");
  assert.equal(pkg.omissions[0]?.path, "gone.ts");
});

// ── identity ────────────────────────────────────────────────────────────────

test("identity: the same inputs produce the same package id", async () => {
  const build = () => packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "A" }])]);
  assert.equal((await build()).packageId, (await build()).packageId);
});

test("identity: changing INCLUDED content changes the package id", async () => {
  const a = await packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "A" }])]);
  const b = await packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "B" }])]);
  assert.notEqual(a.packageId, b.packageId);
  assert.notEqual(a.artifacts[1]?.observedSha256, b.artifacts[1]?.observedSha256);
});

test("identity: changing the GOAL changes the package id", async () => {
  const a = await packageOf([]);
  const b = await packageOf([], { goal: "something else entirely" });
  assert.notEqual(a.packageId, b.packageId);
});

test("identity: changing the resolved model's window changes the package id", async () => {
  const a = await packageOf([]);
  const b = await packageOf([], { capabilities: caps(200_000) });
  assert.notEqual(a.packageId, b.packageId, "a different budget is a different authorization");
});

test("identity: a DIFFERENT resolution decision changes the package id", async () => {
  const a = await packageOf([]);
  const b = await packageOf([], { resolutionDecisionId: "e".repeat(64) as ContextAssemblyRequest["resolutionDecisionId"] });
  assert.notEqual(a.packageId, b.packageId);
});

test("identity: an omission is part of the identity — what was left out matters", async () => {
  const huge = "x".repeat(200_000);
  const withOmission = await packageOf([fakeSource("s", [{ category: "target_file", path: "huge.ts", content: huge }])], { capabilities: caps(8_192) });
  const without = await packageOf([], { capabilities: caps(8_192) });
  assert.notEqual(withOmission.packageId, without.packageId);
});

test("identity: a DIFFERENT source snapshot changes the package id", async () => {
  // The V2-006A binding: two packages assembled from different dirty states can never
  // collide merely because the artifacts they happened to include looked the same.
  const a = await packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "A" }])]);
  const b = await packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "A" }])], { source: reader("d".repeat(64)) });
  assert.notEqual(a.packageId, b.packageId);
  assert.equal(a.sourceSnapshotId, "s".repeat(64));
  assert.equal(b.sourceSnapshotId, "d".repeat(64));
});

test("identity: observed digests are raw SHA-256 of the bytes, comparable with the mutation core", () => {
  // Deliberately the same computation `core/workspace/file-state.ts` performs, so a
  // future mutation authority can compare an observation against context.
  assert.equal(sha256Text("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

// ── package hygiene ─────────────────────────────────────────────────────────

test("package: the result is frozen through and through", async () => {
  const pkg = await packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "A" }])]);
  assert.ok(Object.isFrozen(pkg));
  assert.ok(Object.isFrozen(pkg.artifacts));
  assert.ok(Object.isFrozen(pkg.artifacts[0]));
  assert.ok(Object.isFrozen(pkg.budget));
  assert.throws(() => {
    (pkg as { packageId: string }).packageId = "tampered";
  }, TypeError);
});

test("package: the published manifest carries provenance but not file BODIES", async () => {
  const pkg = await packageOf([fakeSource("s", [{ category: "target_file", path: "a.ts", content: "SECRET-LOOKING-BODY" }])]);
  const manifest = manifestOf(pkg);
  assert.equal(JSON.stringify(manifest).includes("SECRET-LOOKING-BODY"), false, "bodies are not republished");
  assert.equal(manifest.packageId, pkg.packageId, "identity is unaffected");
  const artifact = manifest.artifacts.find((a) => a.path === "a.ts")!;
  assert.equal(artifact.observedSha256, pkg.artifacts[1]?.observedSha256, "the state binding survives");
  assert.equal(artifact.bytes, pkg.artifacts[1]?.bytes);
});
