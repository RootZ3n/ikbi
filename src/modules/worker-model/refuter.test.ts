/**
 * Tests for the REFUTER role — the deterministic refutation checklist, the RoleFn
 * adapter, and the finding→correction proposal mapping.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { RoleContext, RoleResult } from "./contract.js";
import {
  runRefutation,
  createRefuter,
  proposalFromFinding,
  parseDiffFiles,
  type RefutationInput,
  type RefuterFinding,
} from "./refuter.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "refuter", trustTier: "verified", spawnedFrom: "parent-1" };

// A clean diff: a real source file gains a function, no test/manifest/forbidden changes.
const CLEAN_DIFF = [
  "diff --git a/src/server.ts b/src/server.ts",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -1,1 +1,3 @@",
  "+export function health() {",
  "+  return { ok: true };",
  "+}",
  "",
].join("\n");

function baseInput(overrides: Partial<RefutationInput> = {}): RefutationInput {
  return {
    goal: "add a health endpoint",
    diffText: CLEAN_DIFF,
    filesClaimed: [],
    fileExists: () => true,
    verifierVerdict: "pass",
    verifierTestEvidence: "executed",
    ...overrides,
  };
}

function find(findings: readonly RefuterFinding[], check: string): RefuterFinding {
  const f = findings.find((x) => x.check === check);
  assert.ok(f, `expected a finding for check "${check}"`);
  return f!;
}

// ── parseDiffFiles ──────────────────────────────────────────────────────────

test("parseDiffFiles splits added/removed per file", () => {
  const files = parseDiffFiles(CLEAN_DIFF);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.file, "src/server.ts");
  assert.equal(files[0]!.added.length, 3);
  assert.equal(files[0]!.removed.length, 0);
});

// ── Clean build ──────────────────────────────────────────────────────────────

test("clean build is NOT refuted (every check survives)", () => {
  const result = runRefutation(baseInput());
  assert.equal(result.refuted, false);
  assert.equal(result.findings.length, 9);
  assert.match(result.feedback, /not refuted/);
  // no critical failures
  assert.equal(result.findings.some((f) => !f.passed && f.severity === "critical"), false);
});

// ── Weakened tests ────────────────────────────────────────────────────────────

test("weakened tests → refuted with a critical finding", () => {
  const diff = [
    "diff --git a/src/auth.test.ts b/src/auth.test.ts",
    "--- a/src/auth.test.ts",
    "+++ b/src/auth.test.ts",
    "@@ -1,4 +1,1 @@",
    "-  assert.equal(login(user), true);",
    "-  assert.equal(logout(user), true);",
    "-  expect(token).toBe('abc');",
    "+  // assertions removed",
    "",
  ].join("\n");
  const result = runRefutation(baseInput({ diffText: diff }));
  assert.equal(result.refuted, true);
  const f = find(result.findings, "tests_not_weakened");
  assert.equal(f.passed, false);
  assert.equal(f.severity, "critical");
  assert.match(f.evidence, /assertions/);
});

// ── Stub script ───────────────────────────────────────────────────────────────

test("test script swapped for a stub → refuted (verification forgery)", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -2,1 +2,1 @@",
    '-    "test": "vitest run",',
    '+    "test": "echo no tests && exit 0",',
    "",
  ].join("\n");
  const result = runRefutation(baseInput({ diffText: diff }));
  assert.equal(result.refuted, true);
  const f = find(result.findings, "verification_real");
  assert.equal(f.passed, false);
  assert.equal(f.severity, "critical");
});

test("expected manifest change (stub→real) is NOT refuted", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -2,1 +2,1 @@",
    '-    "test": "echo \\"no test specified\\" && exit 1",',
    '+    "test": "vitest run",',
    "",
  ].join("\n");
  const result = runRefutation(baseInput({ diffText: diff }));
  assert.equal(result.refuted, false);
  assert.equal(find(result.findings, "verification_real").passed, true);
  assert.equal(find(result.findings, "manifest_change_expected").passed, true);
});

// ── Forbidden file ────────────────────────────────────────────────────────────

test("forbidden file change → refuted", () => {
  const diff = [
    "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
    "--- a/.github/workflows/ci.yml",
    "+++ b/.github/workflows/ci.yml",
    "@@ -1,1 +1,1 @@",
    "-on: push",
    "+on: workflow_dispatch",
    "",
  ].join("\n");
  const result = runRefutation(baseInput({ diffText: diff, protectedPaths: [".github/workflows"] }));
  assert.equal(result.refuted, true);
  const f = find(result.findings, "no_forbidden_files");
  assert.equal(f.passed, false);
  assert.equal(f.severity, "critical");
});

// ── Other critical checks ─────────────────────────────────────────────────────

test("claimed file that does not exist → refuted (source mismatch)", () => {
  const result = runRefutation(baseInput({ filesClaimed: ["src/ghost.ts"], fileExists: () => false }));
  assert.equal(result.refuted, true);
  assert.equal(find(result.findings, "source_matches_claims").passed, false);
});

test("green verdict with no real test evidence → refuted", () => {
  const result = runRefutation(baseInput({ verifierVerdict: "pass", verifierTestEvidence: "zero" }));
  assert.equal(result.refuted, true);
  const f = find(result.findings, "tests_actually_run");
  assert.equal(f.passed, false);
  assert.equal(f.severity, "critical");
});

test("committed merge-conflict markers → refuted", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,1 +1,5 @@",
    "+<<<<<<< HEAD",
    "+export const a = 1;",
    "+=======",
    "+export const a = 2;",
    "+>>>>>>> branch",
    "",
  ].join("\n");
  const result = runRefutation(baseInput({ diffText: diff }));
  assert.equal(result.refuted, true);
  assert.equal(find(result.findings, "no_silent_conflicts").passed, false);
});

test("model spec-match=false → refuted via result_matches_spec", () => {
  const result = runRefutation(baseInput({ specMatch: { matched: false, evidence: "change is unrelated to the goal" } }));
  assert.equal(result.refuted, true);
  const f = find(result.findings, "result_matches_spec");
  assert.equal(f.passed, false);
  assert.equal(f.severity, "critical");
});

test("missing receipts is a warning, not a refutation", () => {
  const result = runRefutation(baseInput({ receiptsPresent: false }));
  assert.equal(result.refuted, false);
  const f = find(result.findings, "receipts_present");
  assert.equal(f.passed, false);
  assert.equal(f.severity, "warning");
});

// ── Finding → correction proposal ─────────────────────────────────────────────

test("proposalFromFinding maps a refuted check to a PROPOSED correction", () => {
  const finding: RefuterFinding = {
    check: "tests_not_weakened",
    passed: false,
    evidence: "test assertions were removed: src/auth.test.ts (-3/+0 assertions)",
    severity: "critical",
  };
  const proposal = proposalFromFinding(finding, "run-42");
  assert.equal(proposal.category, "test_weakening");
  assert.equal(proposal.approved, false, "corrections are proposed, not auto-installed");
  assert.equal(proposal.proposedBy, "system");
  assert.equal(proposal.sourceRunId, "run-42");
  assert.match(proposal.finding, /tests_not_weakened/);
  assert.ok(proposal.correction.length > 0);
  assert.ok(proposal.regression.length > 0);
});

test("proposalFromFinding category mapping covers all checks", () => {
  const cases: Record<string, string> = {
    tests_actually_run: "verification_forgery",
    source_matches_claims: "suspicious_pattern",
    tests_not_weakened: "test_weakening",
    no_forbidden_files: "forbidden_file",
    verification_real: "verification_forgery",
    manifest_change_expected: "expected_manifest_change",
    result_matches_spec: "suspicious_pattern",
    no_silent_conflicts: "conflict_resolution",
    receipts_present: "environment_missing",
  };
  for (const [check, category] of Object.entries(cases)) {
    const proposal = proposalFromFinding({ check, passed: false, evidence: "e", severity: "critical" });
    assert.equal(proposal.category, category, `${check} → ${category}`);
  }
});

// ── RoleFn adapter ────────────────────────────────────────────────────────────

function makeWorkspace(): WorkspaceHandle {
  const path = mkdtempSync(join(tmpdir(), "ikbi-refuter-"));
  return {
    id: "ws1", targetRepo: path, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path, identity: IDENTITY, state: "allocated", createdAt: 0,
  };
}

function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

function makeCtx(priorResults: RoleResult[], workspace = makeWorkspace()): RoleContext {
  return {
    task: { taskId: "t-1", targetRepo: workspace.path, goal: "add a health endpoint" },
    role: "refuter",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace,
    priorResults,
    engine: {
      invokeModel: async (_req: ModelRequest) => modelResponse("{}"),
      neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    },
  };
}

test("createRefuter RoleFn: clean build survives", async () => {
  const role = createRefuter({ diff: async () => CLEAN_DIFF });
  const ctx = makeCtx([
    { role: "builder", outcome: "success", detail: { filesWritten: [] } },
    { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
  ]);
  const result = await role(ctx);
  assert.equal(result.role, "refuter");
  assert.equal(result.outcome, "success");
  assert.equal((result.detail as { refuted: boolean }).refuted, false);
  assert.match(result.summary!, /SURVIVED/);
});

test("createRefuter RoleFn: weakened tests refutes the build", async () => {
  const diff = [
    "diff --git a/src/auth.test.ts b/src/auth.test.ts",
    "--- a/src/auth.test.ts",
    "+++ b/src/auth.test.ts",
    "@@ -1,2 +1,1 @@",
    "-  assert.equal(login(user), true);",
    "-  expect(token).toBe('abc');",
    "+  // removed",
    "",
  ].join("\n");
  const role = createRefuter({ diff: async () => diff });
  const ctx = makeCtx([
    { role: "builder", outcome: "success", detail: { filesWritten: [] } },
    { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
  ]);
  const result = await role(ctx);
  assert.equal((result.detail as { refuted: boolean }).refuted, true);
  assert.match(result.summary!, /REFUTED/);
});

test("createRefuter RoleFn: missing claimed file refutes (real disk check)", async () => {
  const ws = makeWorkspace();
  // builder claims a file it never wrote
  const role = createRefuter({ diff: async () => CLEAN_DIFF });
  const ctx = makeCtx(
    [
      { role: "builder", outcome: "success", detail: { filesWritten: ["src/ghost.ts"] } },
      { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
    ],
    ws,
  );
  const result = await role(ctx);
  assert.equal((result.detail as { refuted: boolean }).refuted, true);
});

test("createRefuter RoleFn: claimed file that exists on disk survives", async () => {
  const ws = makeWorkspace();
  writeFileSync(join(ws.path, "real.ts"), "export const ok = true;\n", "utf8");
  const role = createRefuter({ diff: async () => CLEAN_DIFF });
  const ctx = makeCtx(
    [
      { role: "builder", outcome: "success", detail: { filesWritten: ["real.ts"] } },
      { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
    ],
    ws,
  );
  const result = await role(ctx);
  assert.equal((result.detail as { refuted: boolean }).refuted, false);
});

// ── Semantic mode (HIGH-3) ──────────────────────────────────────────────────

test("HIGH-3: semantic off (default) — result_matches_spec uses heuristic, passes when diff exists", async () => {
  // Without semantic:true, check #7 falls through to the trivial heuristic that
  // passes whenever any diff is present — even if the diff is off-target.
  const role = createRefuter({ diff: async () => CLEAN_DIFF });
  const ctx = makeCtx([
    { role: "builder", outcome: "success", detail: { filesWritten: [] } },
    { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
  ]);
  const result = await role(ctx);
  const detail = result.detail as { refuted: boolean; findings: RefuterFinding[] };
  assert.equal(detail.refuted, false, "should not be refuted with heuristic mode");
  const f = detail.findings.find((x) => x.check === "result_matches_spec");
  assert.ok(f, "result_matches_spec finding exists");
  assert.equal(f!.passed, true, "heuristic passes when diff exists");
  assert.match(f!.evidence, /not semantically evaluated/i, "evidence says heuristic was used");
});

test("HIGH-3: semantic on — invokes model for result_matches_spec", async () => {
  let modelCalled = false;
  const ctx: RoleContext = {
    task: { taskId: "t-semantic", targetRepo: "/tmp/fake", goal: "add a health endpoint" },
    role: "refuter",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: makeWorkspace(),
    priorResults: [
      { role: "builder", outcome: "success", detail: { filesWritten: [] } },
      { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
    ],
    engine: {
      invokeModel: async (_req: ModelRequest) => {
        modelCalled = true;
        return modelResponse('{"matched": true, "evidence": "health endpoint matches goal"}');
      },
      neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    },
  };
  const role = createRefuter({ diff: async () => CLEAN_DIFF, semantic: true });
  const result = await role(ctx);
  assert.equal(modelCalled, true, "model should be invoked when semantic=true");
  const detail = result.detail as { refuted: boolean; findings: RefuterFinding[] };
  const f = detail.findings.find((x) => x.check === "result_matches_spec");
  assert.ok(f, "result_matches_spec finding exists");
  assert.equal(f!.passed, true, "model said matched=true");
  assert.equal(f!.evidence, "health endpoint matches goal", "uses model evidence");
});

test("HIGH-3: semantic mode catches off-target builds (model says matched=false)", async () => {
  // A builder that reformatted a README instead of fixing an auth bug.
  // With semantic mode, the model should catch this as off-target.
  const offTargetDiff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,3 +1,3 @@",
    "-# My Project",
    "+# My Project ",
    " Some description",
    " More text",
    "",
  ].join("\n");

  const ctx: RoleContext = {
    task: { taskId: "t-offtarget", targetRepo: "/tmp/fake", goal: "fix the authentication bug in login endpoint" },
    role: "refuter",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: makeWorkspace(),
    priorResults: [
      { role: "builder", outcome: "success", detail: { filesWritten: [] } },
      { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
    ],
    engine: {
      invokeModel: async (_req: ModelRequest) =>
        modelResponse('{"matched": false, "evidence": "README reformatting does not fix the auth bug"}'),
      neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    },
  };
  const role = createRefuter({ diff: async () => offTargetDiff, semantic: true });
  const result = await role(ctx);
  const detail = result.detail as { refuted: boolean; findings: RefuterFinding[] };
  assert.equal(detail.refuted, true, "off-target build should be refuted in semantic mode");
  const f = detail.findings.find((x) => x.check === "result_matches_spec");
  assert.ok(f, "result_matches_spec finding exists");
  assert.equal(f!.passed, false, "model said matched=false");
  assert.equal(f!.severity, "critical", "mismatch is critical severity");
  assert.match(f!.evidence, /README.*auth bug/i, "evidence explains the mismatch");
});

test("HIGH-3: semantic model failure falls through to heuristic gracefully", async () => {
  // If the model throws, #7 should fall through to the deterministic heuristic.
  const ctx: RoleContext = {
    task: { taskId: "t-fallback", targetRepo: "/tmp/fake", goal: "add a health endpoint" },
    role: "refuter",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: makeWorkspace(),
    priorResults: [
      { role: "builder", outcome: "success", detail: { filesWritten: [] } },
      { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
    ],
    engine: {
      invokeModel: async () => { throw new Error("model unavailable"); },
      neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    },
  };
  const role = createRefuter({ diff: async () => CLEAN_DIFF, semantic: true });
  const result = await role(ctx);
  const detail = result.detail as { refuted: boolean; findings: RefuterFinding[] };
  // Should fall through to heuristic (passes when diff exists)
  const f = detail.findings.find((x) => x.check === "result_matches_spec");
  assert.ok(f, "result_matches_spec finding exists");
  assert.equal(f!.passed, true, "falls through to heuristic when model fails");
  assert.match(f!.evidence, /not semantically evaluated/i, "heuristic fallback evidence");
});
