/**
 * ikbi worker-model — verifier ladder mode (IKBI_VERIFY=ladder) wiring tests.
 *
 * Pure/in-memory: fake governed-exec + injected project-index data; no disk, no spawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OperationContext } from "../../core/identity/index.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import type { FileEntry, PackageEntry, ProjectIndexData } from "../project-index/index.js";
import { createVerifier, parseChangedFiles, DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS } from "./verifier.js";
import { workingTreePlanningDiff } from "./checks.js";
import type { RoleContext } from "./contract.js";

const PCTX = {} as unknown as OperationContext;

function file(path: string, opts: { isTest?: boolean } = {}): FileEntry {
  return { path, lang: "ts", size: 50, mtimeMs: 0, hash: "h", isTest: opts.isTest ?? false };
}
function pkg(root: string, scripts: Record<string, string>): PackageEntry {
  return { root, name: root || "root", manager: "pnpm", scripts };
}
function mkData(p: Partial<ProjectIndexData>): ProjectIndexData {
  return { version: 1, repoPath: "/wt", repoHash: "h", files: p.files ?? [], packages: p.packages ?? [], imports: p.imports ?? [], fileToTests: p.fileToTests ?? {}, truncated: p.truncated ?? false };
}
function diffOf(files: string[]): string {
  return files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new`).join("\n");
}
function fakeGovernedExec(responder: (req: ExecRequest) => ExecResult = () => ({ executed: true, exitCode: 0, stdoutTail: "", stderrTail: "" })) {
  const calls: ExecRequest[] = [];
  return { calls, exec: { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return responder(req); } } };
}
function makeCtx(worktree: string): RoleContext {
  return {
    workspace: { id: "ws1", targetRepo: worktree, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: worktree, identity: { agentId: "w" }, state: "allocated", createdAt: 0 },
    task: { taskId: "t-1", targetRepo: worktree, goal: "g" },
    role: "verifier",
    identity: { agentId: "w", functionalRole: "verifier", trustTier: "trusted" },
    engine: { invokeModel: async () => { throw new Error("unused"); }, neutralizeUntrusted: ((c: string) => c) as never },
  } as unknown as RoleContext;
}
const detail = (r: { detail?: unknown }) => r.detail as Record<string, unknown>;

test("parseChangedFiles extracts paths from a unified diff", () => {
  assert.deepEqual(parseChangedFiles(diffOf(["packages/a/src/foo.ts", "tsconfig.json"])), ["packages/a/src/foo.ts", "tsconfig.json"]);
});

test("workingTreePlanningDiff includes relevant untracked files with synthetic diff headers", async () => {
  const d = await workingTreePlanningDiff(
    async (args) => {
      if (args.includes("diff")) return "";
      if (args.includes("ls-files")) return "packages/a/src/new.ts\n";
      return "";
    },
    "/wt",
    "base",
  );
  assert.deepEqual(parseChangedFiles(d), ["packages/a/src/new.ts"]);
});

test("default (no IKBI_VERIFY) → legacy verification UNCHANGED (no scope stamp)", async () => {
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["src/x.ts"]), env: {} });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "success");
  assert.equal(detail(r).verdict, "pass");
  assert.equal(detail(r).verificationScope, undefined, "legacy result is not scope-stamped");
  assert.equal(r.summary, "all checks passed");
  assert.equal(ge.calls.length, 2, "ran the 2 legacy VERIFIER_CHECKS");
});

test("ladder: local change runs nearest + package, NOT full; scope=impact", async () => {
  const data = mkData({
    packages: [pkg("packages/a", { test: "vitest run", build: "tsc -p ." })],
    files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })],
    fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] },
  });
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder" }, index: { refresh: async () => ({ data }) } });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "success");
  assert.equal(detail(r).verificationScope, "impact");
  const stages = detail(r).stagesRun as string[];
  assert.ok(stages.includes("nearest-tests") && stages.includes("package-checks"));
  assert.ok(!stages.includes("full"), "no full stage for a local change");
  assert.match(r.summary ?? "", /scope "impact"/);
});

test("ladder: uncommitted source edit from planningDiff reaches planVerification", async () => {
  const data = mkData({
    packages: [pkg("packages/a", { test: "vitest run" })],
    files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })],
    fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] },
  });
  const ge = fakeGovernedExec();
  let seenChanged: readonly string[] = [];
  const v = createVerifier({
    governedExec: ge.exec,
    parentCtx: PCTX,
    diff: async () => "", // script-integrity package.json subset can be empty
    planningDiff: async () => diffOf(["packages/a/src/foo.ts"]),
    env: { IKBI_VERIFY: "ladder" },
    index: { refresh: async () => ({ data }) },
    plan: (req) => {
      seenChanged = req.changedFiles;
      return {
        status: "ok" as const,
        blocked: false,
        blockReasons: [],
        scope: "impact" as const,
        escalateToFull: false,
        escalationReasons: [],
        affectedPackages: ["packages/a"],
        affectedTests: [],
        neutralPackages: [],
        stubScripts: [],
        stages: [{ stage: "package-checks", tasks: [{ package: "packages/a", cwd: "packages/a", name: "test", command: "pnpm", args: ["test"], scope: "package", reason: "test" }] }],
        receipts: [],
      };
    },
  });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "success");
  assert.deepEqual(seenChanged, ["packages/a/src/foo.ts"]);
});

test("ladder: shared config change (tsconfig) escalates to full", async () => {
  const data = mkData({ packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/a", { test: "vitest" })], files: [file("tsconfig.json"), file("packages/a/src/foo.ts")] });
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["tsconfig.json", "packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder" }, index: { refresh: async () => ({ data }) } });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "success");
  assert.equal(detail(r).verificationScope, "full");
  assert.ok((detail(r).stagesRun as string[]).includes("full"));
});

test("ladder: a BLOCKED plan fails verification and runs no checks", async () => {
  const data = mkData({ packages: [pkg("packages/a", {})], files: [file("packages/a/src/foo.ts")] }); // neutral, no root → blocked
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder" }, index: { refresh: async () => ({ data }) } });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "failure");
  assert.equal(detail(r).blocked, true);
  assert.match(r.summary ?? "", /BLOCKED/);
  assert.equal(ge.calls.length, 0, "no checks executed for a blocked plan");
});

test("ladder: a failed nearest test FAILS FAST (no package/full) and surfaces triage", async () => {
  const data = mkData({
    packages: [pkg("packages/a", { test: "vitest run", build: "tsc -p ." })],
    files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })],
    fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] },
  });
  let n = 0;
  const ge = fakeGovernedExec(() => {
    n += 1;
    return n === 1 ? { executed: true, exitCode: 1, stdoutTail: "TAP version 13\nnot ok 1 - boom\n", stderrTail: "" } : { executed: true, exitCode: 0, stdoutTail: "", stderrTail: "" };
  });
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder" }, index: { refresh: async () => ({ data }) } });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "failure");
  assert.equal(ge.calls.length, 1, "stopped after the first failed task (no package/full)");
  assert.equal((detail(r).failedAt as { stage: string }).stage, "nearest-tests");
  const triage = detail(r).triage as Array<{ failures: string[] }>;
  assert.ok(triage[0]?.failures.includes("boom"), "triage failure name surfaced");
});

test("ladder: IKBI_CHECK_TIMEOUT_MS is passed to governed-exec (separate from role timeout)", async () => {
  const data = mkData({ packages: [pkg("packages/a", { test: "vitest" })], files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })], fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] } });
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder", IKBI_CHECK_TIMEOUT_MS: "600000" }, index: { refresh: async () => ({ data }) } });
  await v(makeCtx("/wt"));
  assert.ok(ge.calls.length > 0);
  assert.equal(ge.calls[0]?.timeoutMs, 600_000, "the per-call check timeout is forwarded");
  assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 600_000, "default check timeout is the large budget");
});

test("ladder: a neutral package does not create a vacuous green — it forces full", async () => {
  const data = mkData({ packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/a", {})], files: [file("packages/a/src/foo.ts")] });
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder" }, index: { refresh: async () => ({ data }) } });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "success");
  assert.equal(detail(r).verificationScope, "full", "neutral affected package escalated to full (not a scoped green)");
  assert.ok((detail(r).neutralPackages as string[]).includes("packages/a"));
  assert.ok((detail(r).stagesRun as string[]).includes("full"), "a full check actually ran");
  assert.ok(ge.calls.length >= 1, "the full check executed");
});

test("ladder (Fix 2): a non-blocked plan that runs ZERO checks fails closed — no vacuous green", async () => {
  const ge = fakeGovernedExec();
  // injected planner result: not blocked, but empty stages (planner-invariant violation simulated)
  const emptyPlan = {
    status: "ok" as const, blocked: false, blockReasons: [], scope: "impact" as const,
    escalateToFull: false, escalationReasons: [], affectedPackages: [], affectedTests: [],
    neutralPackages: [], stubScripts: [], stages: [], receipts: ["fake: empty non-blocked plan"],
  };
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["src/x.ts"]), env: { IKBI_VERIFY: "ladder" }, index: { refresh: async () => ({ data: mkData({}) }) }, plan: () => emptyPlan });
  const r = await v(makeCtx("/wt"));
  assert.equal(r.outcome, "failure");
  assert.match(r.summary ?? "", /no verification checks ran/);
  assert.equal(ge.calls.length, 0, "nothing executed");
});

test("ladder (Fix 4): IKBI_CHECK_TIMEOUT_MS is clamped below the setTimeout overflow", async () => {
  const data = mkData({ packages: [pkg("packages/a", { test: "vitest" })], files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })], fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] } });
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder", IKBI_CHECK_TIMEOUT_MS: "999999999999999" }, index: { refresh: async () => ({ data }) } });
  await v(makeCtx("/wt"));
  assert.equal(ge.calls[0]?.timeoutMs, MAX_CHECK_TIMEOUT_MS, "huge value clamped to the safe max");
});

test("ladder (Fix 4): an invalid IKBI_CHECK_TIMEOUT_MS falls back to the default", async () => {
  const data = mkData({ packages: [pkg("packages/a", { test: "vitest" })], files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })], fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] } });
  const ge = fakeGovernedExec();
  const v = createVerifier({ governedExec: ge.exec, parentCtx: PCTX, diff: async () => diffOf(["packages/a/src/foo.ts"]), env: { IKBI_VERIFY: "ladder", IKBI_CHECK_TIMEOUT_MS: "nonsense" }, index: { refresh: async () => ({ data }) } });
  await v(makeCtx("/wt"));
  assert.equal(ge.calls[0]?.timeoutMs, DEFAULT_CHECK_TIMEOUT_MS, "invalid value → default");
});
