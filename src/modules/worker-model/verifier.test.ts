import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import type { ProjectIndexData } from "../project-index/index.js";
import { createVerifier, detectScriptMutation, detectShellOutMutation, extractGoalFiles, type CheckResult } from "./verifier.js";
import type { RoleContext, RoleResult } from "./contract.js";

const silent = () => pino({ level: "silent" });
const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "verifier", trustTier: "verified", spawnedFrom: "parent-1" };
const WS_PATH = "/workspace/ws1";

/** A real validated OperationContext (governed-exec is faked, but the wiring is real). */
function makeParentCtx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
}

function makeCtx() {
  let invokeCalls = 0;
  const ws: WorkspaceHandle = {
    id: "ws1", targetRepo: WS_PATH, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: WS_PATH, identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  const ctx: RoleContext = {
    task: { taskId: "t-1", targetRepo: WS_PATH, goal: "verify" },
    role: "verifier",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: ws,
    priorResults: [],
    engine: {
      invokeModel: async () => { invokeCalls += 1; throw new Error("verifier must never call invokeModel"); },
      neutralizeUntrusted: () => { throw new Error("verifier must not neutralize"); },
    },
  };
  return { ctx, invokeCalls: () => invokeCalls };
}

/** A fake governed executor recording every run() and answering per the supplied handler. */
function execStub(handler: (command: string, args: readonly string[]) => ExecResult) {
  const calls: ExecRequest[] = [];
  const governedExec = {
    run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return handler(req.command, req.args); },
  };
  return { governedExec, calls };
}

/** No diff source declared as "no mutation" by default (clean diff). */
const cleanDiff = async () => "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

// ── LAYER 1: GOVERNED EXECUTION (not raw spawnSync) ──────────────────────────

test("LAYER 1: the verifier routes EVERY check through governed-exec (command/args/cwd), maps results", async () => {
  const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }));
  const { ctx, invokeCalls } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);

  assert.equal(result.outcome, "success");
  assert.equal(exec.calls.length, 2, "governed-exec ran once per fixed check (NOT raw spawnSync)");
  assert.deepEqual(exec.calls.map((c) => c.command), ["pnpm", "pnpm"]);
  assert.deepEqual(exec.calls[0]?.args, ["tsc", "--noEmit"]);
  assert.deepEqual(exec.calls[1]?.args, ["test"]);
  for (const c of exec.calls) assert.equal(c.cwd, WS_PATH, "each check runs in the workspace path");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "pass");
  assert.equal(detail.checks.length, 2);
  assert.equal(invokeCalls(), 0, "verifier is deterministic — never calls invokeModel");
});

test("LAYER 1: a failing governed check (non-zero exit) → outcome:failure", async () => {
  const exec = execStub((_cmd, args) => args.includes("test") ? { executed: true, exitCode: 1, stdoutTail: "1 failing" } : { executed: true, exitCode: 0 });
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);

  assert.equal(result.outcome, "failure");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "fail");
  assert.ok(detail.checks.find((c) => c.exitCode !== 0 && /test/.test(c.command)), "the failed test check is recorded");
});

// ── LAYER 1: DENIED → FAIL-CLOSED (never a silent pass) ──────────────────────

test("LAYER 1 denied: a non-allowlisted / gate-denied check FAILS CLOSED (not a pass, not a crash)", async () => {
  const exec = execStub((cmd) => ({ executed: false, denied: true, reason: `binary "${cmd}" is not on the allowlist` }));
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);

  assert.equal(result.outcome, "failure", "a denied governed check is fail-closed, NOT a silent pass");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "fail");
  for (const c of detail.checks) {
    assert.notEqual(c.exitCode, 0, "a denied check is non-zero");
    assert.match(c.outputTail, /DENIED/);
    assert.match(c.outputTail, /ALLOWLIST/, "the operator opt-in is surfaced");
  }
});

// ── LAYER 1: DRY-RUN → explicit verdict (not a false pass) ───────────────────

test("LAYER 1 dry-run: governed-exec executes nothing → a dry-run verdict, NOT a pass", async () => {
  const exec = execStub((cmd) => ({ executed: false, reason: `dry-run: would exec ${cmd}` }));
  const { ctx } = makeCtx();
  const dryCtx = beginOperation(makeParentCtx().identity, { requestId: "req-1", dryRun: true });
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: dryCtx, diff: cleanDiff })(ctx);

  assert.notEqual(result.outcome, "success", "a dry-run that executed nothing is NOT a pass");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "dry-run", "the dry-run case is explicitly handled");
});

// ── LAYER 2: SCRIPT-MUTATION REJECTED (the headline security test) ───────────

test("LAYER 2 ATTACK: a builder that rewrote package.json's test script → verification UNTRUSTED, script NOT run", async () => {
  // The diff shows the builder changing the "test" script to a no-op that always passes.
  const attackDiff = async () =>
    [
      "diff --git a/package.json b/package.json",
      "index 1111111..2222222 100644",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,7 +5,7 @@",
      '   \"scripts\": {',
      '-    \"test\": \"node --test\",',
      '+    \"test\": \"echo all good && exit 0\",',
      '     \"build\": \"tsc\"',
      "   },",
    ].join("\n");
  const exec = execStub(() => { throw new Error("governed-exec must NOT run the mutated check"); });
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: attackDiff })(ctx);

  assert.equal(result.outcome, "failure", "a mutated-scripts build CANNOT pass verification (fail-closed)");
  const detail = result.detail as { verdict: string; reason?: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "untrusted");
  assert.match(result.summary ?? "", /untrusted/);
  assert.match(detail.reason ?? "", /script/);
  assert.equal(exec.calls.length, 0, "the mutated script was NEVER executed as a trusted check");
});

// ── LAYER 2: CLEAN DIFF (incl. dependency bump) → proceeds normally ──────────

test("LAYER 2 clean: a code change / dependency bump (no scripts change) → the governed checks run, no false-positive", async () => {
  const depBump = async () =>
    [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -20,7 +20,7 @@",
      '   \"dependencies\": {',
      '-    \"lodash\": \"^4.17.20\",',
      '+    \"lodash\": \"^4.17.21\",',
      "   }",
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1 +1 @@",
      "-export const x = 1;",
      "+export const x = 2;",
    ].join("\n");
  const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: depBump })(ctx);

  assert.equal(result.outcome, "success", "a legitimate build (no scripts change) verifies normally");
  assert.equal(exec.calls.length, 2, "both governed checks ran — no false-positive untrusted");
});

// ── LAYER 2: GUARD MANDATORY — diff-not-wired & diff-throws fail CLOSED ───────

test("LAYER 2 no-diff: a verifier built WITHOUT a diff source fails CLOSED (untrusted, zero governed-exec calls)", async () => {
  // The script-integrity guard is mandatory: with no diff to inspect, the verifier
  // cannot prove the builder didn't rewrite the test script → it must NOT verify.
  const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "would-pass" }));
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx() })(ctx); // NO diff dep

  assert.equal(result.outcome, "failure", "a missing integrity guard fails closed, NOT open");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "untrusted");
  assert.deepEqual(detail.checks, [], "no checks ran");
  assert.match(result.summary ?? "", /script-integrity guard unavailable/);
  assert.equal(exec.calls.length, 0, "the governed checks NEVER ran on the no-diff path (no governed-exec call)");
});

test("LAYER 2 diff-throws: an unreadable workspace diff fails CLOSED (untrusted) — regression", async () => {
  const exec = execStub(() => { throw new Error("governed-exec must NOT run when integrity is unprovable"); });
  const { ctx } = makeCtx();
  const throwingDiff = async () => { throw new Error("git diff failed"); };
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: throwingDiff })(ctx);

  assert.equal(result.outcome, "failure");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "untrusted");
  assert.match(result.summary ?? "", /diff unavailable/);
  assert.equal(exec.calls.length, 0, "no governed check ran when the diff could not be read");
});

// ── LAYER 2: detectScriptMutation unit coverage ──────────────────────────────

test("detectScriptMutation: flags test/build/tsc + the scripts key; ignores deps and non-package files", () => {
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n-    \"test\": \"node --test\",\n+    \"test\": \"echo hi\",").mutated, true, "test script change flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n+    \"build\": \"tsc -p .\",").mutated, true, "build script add flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n-    \"pretest\": \"x\",").mutated, true, "pretest hook removal flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n+  \"scripts\": {\n+    \"foo\": \"bar\"\n+  },").mutated, true, "adding the scripts object flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n-    \"lodash\": \"^4.17.20\",\n+    \"lodash\": \"^4.17.21\",").mutated, false, "a dependency bump is NOT a scripts change");
  assert.equal(detectScriptMutation("diff --git a/src/test-helper.ts b/src/test-helper.ts\n+const test = 1;").mutated, false, "a non-package.json file is not flagged");
  assert.equal(detectScriptMutation("").mutated, false, "an empty diff is clean");
});

// ── ISSUE 1: JSON-SEMANTIC script-integrity (full-context diffs) ─────────────

test("ISSUE-1 false-positive killed: a dependency literally named \"build\" bumped → NOT flagged", () => {
  // A FULL-context package.json diff: only a dependency named "build" changes its version. The
  // line-scan would match the guarded key "build"; the semantic pass sees it lives under
  // dependencies, scripts are unchanged → clean.
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,9 +1,9 @@",
    " {",
    '   "name": "app",',
    '   "scripts": {',
    '     "test": "node --test"',
    "   },",
    '   "dependencies": {',
    '-    "build": "^1.0.0"',
    '+    "build": "^1.1.0"',
    "   }",
    " }",
  ].join("\n");
  assert.equal(detectScriptMutation(diff).mutated, false, "a dep named 'build' bumped is NOT a scripts mutation");
});

test("ISSUE-1 false-negative killed: a separate-line \"test\":/\"echo pass\" rewrite is STILL flagged", () => {
  // The builder formats the test script with key and value on SEPARATE lines to dodge the
  // key/value line-scan. The semantic pass parses both sides → the resolved scripts.test changed.
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,5 +1,6 @@",
    " {",
    '   "scripts": {',
    '-    "test": "node --test"',
    '+    "test":',
    '+      "echo pass"',
    "   }",
    " }",
  ].join("\n");
  assert.equal(detectScriptMutation(diff).mutated, true, "separate-line key/value formatting cannot bypass the semantic compare");
});

test("ISSUE-1 actual script change (full diff) → flagged", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,5 +1,5 @@",
    " {",
    '   "scripts": {',
    '-    "test": "node --test"',
    '+    "test": "echo pass && exit 0"',
    "   }",
    " }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, true, "rewriting the test command is flagged");
  assert.match(r.reason ?? "", /test/);
});

test("ISSUE-1 semantic clean: a full-context diff changing only a non-guarded script is NOT flagged", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,5 +1,5 @@",
    " {",
    '   "scripts": {',
    '     "test": "node --test",',
    '-    "start": "node old.js"',
    '+    "start": "node new.js"',
    "   }",
    " }",
  ].join("\n");
  assert.equal(detectScriptMutation(diff).mutated, false, "changing a non-guarded 'start' script is not a verification mutation");
});

// ── ISSUE 5: verbose >8MB output must not false-RED (verifier streams its checks) ─

test("ISSUE-5: the verifier routes checks through the streaming path (onOutput set) so a verbose passing suite is not a false RED", async () => {
  // The buffered execFile throws ENOBUFS past maxBuffer (→ exit 1 → false RED). The streaming path
  // caps capture without killing, preserving the real exit code. The verifier must opt into it by
  // passing onOutput on every governed check.
  let everyCheckStreamed = true;
  const governedExec = {
    run: async (req: ExecRequest): Promise<ExecResult> => {
      if (req.onOutput === undefined) everyCheckStreamed = false;
      // A verbose-but-passing check: huge output, bounded tail, real exit 0 (streaming semantics).
      return { executed: true, exitCode: 0, stdoutTail: "…tail of an 8MB+ run\n", stderrTail: "" };
    },
  };
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);
  assert.equal(everyCheckStreamed, true, "every governed check sets onOutput → the streaming (bounded, no-kill) path is used");
  assert.equal(result.outcome, "success", "a verbose passing suite verifies GREEN — no ENOBUFS-induced false RED");
});

// ── DETERMINISM (regression) ─────────────────────────────────────────────────

test("verifier never invokes the model (asserted via the engine spy)", async () => {
  const exec = execStub(() => ({ executed: true, exitCode: 0 }));
  const { ctx, invokeCalls } = makeCtx();
  await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);
  assert.equal(invokeCalls(), 0);
});

test("P0/A6: detectScriptMutation flags a SUBPACKAGE package.json test-script change (not just root)", () => {
  const diff = [
    "diff --git a/packages/a/package.json b/packages/a/package.json",
    "--- a/packages/a/package.json",
    "+++ b/packages/a/package.json",
    "@@ -3,3 +3,3 @@",
    '-    "test": "vitest run",',
    '+    "test": "echo pass",',
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, true, "a subpackage test-script change is caught → verification fails closed");
});

test("P0/T1: detectScriptMutation guards the extended script keys (lint/check/e2e/coverage)", () => {
  for (const key of ["lint", "check", "e2e", "coverage", "typecheck"]) {
    const diff = `diff --git a/package.json b/package.json\n-    "${key}": "real",\n+    "${key}": "echo pass",`;
    assert.equal(detectScriptMutation(diff).mutated, true, `${key} script change flagged`);
  }
});

// ── P0 Fix 1: the script-integrity guard inspects the WORKING-TREE diff, not the empty committed range
import { execFileSync as _execFileSync } from "node:child_process";
import { mkdtempSync as _mkdtempSync, mkdirSync as _mkdirSync, writeFileSync as _writeFileSync, rmSync as _rmSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";
import { captureStreamedStdout, committedPackageJsonDiff, workingTreePackageJsonDiff } from "./checks.js";

test("P0/Fix1: working-tree diff catches an UNCOMMITTED package.json rewrite (root + subpackage); committed range is empty", async () => {
  const repo = _mkdtempSync(_join(_tmpdir(), "ikbi-si-"));
  try {
    const git = (args: string[]): string => _execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "t@example.com"]);
      git(["config", "user.name", "t"]);
      _writeFileSync(_join(repo, "package.json"), `${JSON.stringify({ name: "r", scripts: { test: "vitest run" } }, null, 2)}\n`);
      _mkdirSync(_join(repo, "packages", "a"), { recursive: true });
      _writeFileSync(_join(repo, "packages", "a", "package.json"), `${JSON.stringify({ name: "a", scripts: { test: "vitest run" } }, null, 2)}\n`);
      git(["add", "-A"]);
      git(["commit", "-qm", "base"]);
    } catch {
      return; // git unavailable → skip (the unit detectScriptMutation tests still cover the parser)
    }
    const base = git(["rev-parse", "HEAD"]).trim();
    // builder rewrites BOTH test scripts in the WORKING TREE, uncommitted (root → stub; subpackage → narrowed)
    _writeFileSync(_join(repo, "package.json"), `${JSON.stringify({ name: "r", scripts: { test: "echo pass" } }, null, 2)}\n`);
    _writeFileSync(_join(repo, "packages", "a", "package.json"), `${JSON.stringify({ name: "a", scripts: { test: "vitest run only-passing.test.ts" } }, null, 2)}\n`);

    // the OLD source (committed base..scratch range) is EMPTY at verify time
    assert.equal(git(["diff", `${base}..HEAD`]).trim(), "", "committed range is empty before the build commit (the old bug)");
    // the FIX: the working-tree diff sees the uncommitted rewrites
    const wt = await workingTreePackageJsonDiff(async (args) => git([...args]), repo, base);
    assert.ok(/echo pass/.test(wt), "root rewrite visible");
    assert.ok(/only-passing/.test(wt), "subpackage rewrite visible");
    assert.equal(detectScriptMutation(wt).mutated, true, "→ script-integrity fails closed at verify time");
  } finally {
    _rmSync(repo, { recursive: true, force: true });
  }
});

test("C2: a COMMITTED package.json scripts mutation visible only with FULL context is detected (3-line range misses it)", async () => {
  const repo = _mkdtempSync(_join(_tmpdir(), "ikbi-si-committed-"));
  try {
    const git = (args: string[]): string => _execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    // The script value sits on its OWN line (separate from the "test": key). With a 3-line-context
    // diff the changed value line has no key on it, so the line-scan can't match a guarded key AND
    // the reconstructed fragment isn't whole-JSON-parseable — the mutation slips through. Only a
    // full-context diff lets the JSON-semantic parser reconstruct the file and compare scripts.test.
    const base = [
      "{",
      '  "name": "r",',
      '  "version": "1.0.0",',
      '  "description": "x",',
      '  "private": true,',
      '  "scripts": {',
      '    "lint": "eslint .",',
      '    "test":',
      '      "vitest run",',
      '    "build": "tsc"',
      "  },",
      '  "dependencies": {',
      '    "a": "1",',
      '    "b": "2"',
      "  }",
      "}",
      "",
    ].join("\n");
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "t@example.com"]);
      git(["config", "user.name", "t"]);
      _writeFileSync(_join(repo, "package.json"), base);
      git(["add", "-A"]);
      git(["commit", "-qm", "base"]);
    } catch {
      return; // git unavailable → skip (the unit detectScriptMutation tests still cover the parser)
    }
    const baseRef = git(["rev-parse", "HEAD"]).trim();
    // builder COMMITS a rewrite of the test script value (vitest run → echo pass) on a scratch branch
    git(["checkout", "-q", "-b", "ikbi/ws/scratch"]);
    _writeFileSync(_join(repo, "package.json"), base.replace('      "vitest run",', '      "echo pass",'));
    git(["add", "-A"]);
    git(["commit", "-qm", "rewrite test"]);

    // The DEFAULT 3-line committed range (what workspaces.diff produces) does NOT surface the key on a
    // changed line and isn't whole-JSON-parseable → the guard MISSES it (the bug).
    const threeLine = git(["diff", `${baseRef}..ikbi/ws/scratch`]);
    assert.ok(/echo pass/.test(threeLine), "the 3-line diff still contains the changed value line");
    assert.equal(detectScriptMutation(threeLine).mutated, false, "the weaker line-scan misses the committed mutation at 3-line context (the bug)");

    // The FIX: full-context committed package.json diff → the JSON-semantic parser catches it.
    const full = await committedPackageJsonDiff(async (args) => git([...args]), baseRef, "ikbi/ws/scratch");
    assert.equal(detectScriptMutation(full).mutated, true, "full-context committed package.json diff flags the scripts mutation (the fix)");
  } finally {
    _rmSync(repo, { recursive: true, force: true });
  }
});

// ── C3: detectShellOutMutation — a guarded script that shells out to a build-modified file ──────
function withPkg(scripts: Record<string, string>, body: (workspacePath: string) => void): void {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-shellout-"));
  try {
    _writeFileSync(_join(dir, "package.json"), `${JSON.stringify({ name: "r", scripts }, null, 2)}\n`);
    body(dir);
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
}

test('C3: "test": "bash ./test.sh" + test.sh modified in the diff → flagged', () => {
  withPkg({ test: "bash ./test.sh" }, (dir) => {
    const diff = "diff --git a/test.sh b/test.sh\n--- a/test.sh\n+++ b/test.sh\n@@ -1 +1 @@\n-pnpm vitest run\n+exit 0\n";
    const r = detectShellOutMutation(diff, dir);
    assert.equal(r.mutated, true, "rewriting the file the test script shells out to forges a passing signal");
    assert.match(r.reason ?? "", /test\.sh/);
  });
});

test('C3: "test": "bash ./test.sh" + test.sh NOT modified → clean', () => {
  withPkg({ test: "bash ./test.sh" }, (dir) => {
    const diff = "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
    assert.equal(detectShellOutMutation(diff, dir).mutated, false, "an unrelated source change does not touch the shelled-out file");
  });
});

test('C3: "test": "node --test" (no file reference) → clean', () => {
  withPkg({ test: "node --test" }, (dir) => {
    const diff = "diff --git a/test.sh b/test.sh\n--- a/test.sh\n+++ b/test.sh\n@@ -1 +1 @@\n-x\n+exit 0\n";
    assert.equal(detectShellOutMutation(diff, dir).mutated, false, "a bare runner with only flags references no file");
  });
});

test('C3: "test": "node scripts/test.js" + scripts/test.js modified → flagged (nested path)', () => {
  withPkg({ test: "node scripts/test.js" }, (dir) => {
    const diff = "diff --git a/scripts/test.js b/scripts/test.js\n--- a/scripts/test.js\n+++ b/scripts/test.js\n@@ -1 +1 @@\n-process.exit(run())\n+process.exit(0)\n";
    const r = detectShellOutMutation(diff, dir);
    assert.equal(r.mutated, true, "a nested shell-out target counts");
    assert.match(r.reason ?? "", /scripts\/test\.js/);
  });
});

test('C3: "test": "node --test engine/ledger.test.ts" + ledger.test.ts modified → clean (editing tests is the build)', () => {
  withPkg({ test: "node --test engine/ledger.test.ts" }, (dir) => {
    const diff = "diff --git a/engine/ledger.test.ts b/engine/ledger.test.ts\n--- a/engine/ledger.test.ts\n+++ b/engine/ledger.test.ts\n@@ -1 +1,2 @@\n test('x', () => {});\n+test('y', () => {});\n";
    assert.equal(detectShellOutMutation(diff, dir).mutated, false, "a directly-named test file is normal build output, not a neutered shell-out helper");
  });
});

test('C3: a NON-test helper named test.sh stays guarded even alongside the test-file carve-out', () => {
  withPkg({ test: "bash ./test.sh && node --test app.spec.ts" }, (dir) => {
    const diff = "diff --git a/test.sh b/test.sh\n--- a/test.sh\n+++ b/test.sh\n@@ -1 +1 @@\n-pnpm vitest run\n+exit 0\n";
    const r = detectShellOutMutation(diff, dir);
    assert.equal(r.mutated, true, "the .sh helper is still a shell-out target (only .test./.spec. files are exempt)");
    assert.match(r.reason ?? "", /test\.sh/);
  });
});

test("C3: no package.json in the workspace → clean (nothing to inspect)", () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-shellout-empty-"));
  try {
    assert.equal(detectShellOutMutation("diff --git a/test.sh b/test.sh\n+exit 0\n", dir).mutated, false);
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex-1: a >2000-char working-tree diff with the mutation in the first 500 chars is NOT truncated away", async () => {
  // The integrity diff is read through governed-exec, whose ExecResult retains only the bounded
  // last-~2000-char `stdoutTail`. A package.json scripts mutation at the TOP of a larger diff would be
  // dropped from that tail before the parser runs. The streaming capture keeps the WHOLE diff.
  const mutationHunk =
    "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n" +
    '@@ -2,3 +2,3 @@\n   "scripts": {\n-    "test": "vitest run",\n+    "test": "echo ok",\n';
  const filler = Array.from({ length: 200 }, (_, i) => `   "dep-${i}": "^1.0.0",`).join("\n"); // unrelated context, > 2000 chars
  const fullDiff = `${mutationHunk}${filler}\n`;
  assert.ok(fullDiff.length > 2000, "the diff exceeds the stdoutTail bound");
  assert.ok(fullDiff.indexOf('"test": "echo ok"') < 500, "the mutation is in the first 500 chars");

  // A governed-exec that STREAMS the full diff via onOutput (as the spawn path does) but whose
  // ExecResult retains only the bounded TAIL — exactly the production truncation that hid the bug.
  const TAIL = 2000;
  const fakeRun = async (onOutput: (chunk: string, stream: "stdout" | "stderr") => void): Promise<ExecResult> => {
    onOutput(fullDiff, "stdout");
    return { executed: true, exitCode: 0, stdoutTail: fullDiff.slice(fullDiff.length - TAIL), stderrTail: "" };
  };

  // The OLD wiring read only `stdoutTail` → the mutation is gone; the streaming capture preserves it.
  const truncated = (await fakeRun(() => {})).stdoutTail ?? "";
  assert.equal(detectScriptMutation(truncated).mutated, false, "the truncated tail no longer contains the mutation (the bug)");
  const captured = await captureStreamedStdout(fakeRun);
  assert.equal(detectScriptMutation(captured).mutated, true, "the full streamed capture still flags the mutation (the fix)");
});

test("P0/Fix1: a non-stub NARROWED test script is caught by detectScriptMutation", () => {
  const diff = 'diff --git a/package.json b/package.json\n-    "test": "vitest run",\n+    "test": "vitest run only-passing.test.ts",';
  assert.equal(detectScriptMutation(diff).mutated, true, "narrowing a real test command is a guarded-script change");
});

test("P0/Fix1: a package.json change OUTSIDE guarded scripts does NOT false-trip", () => {
  const diff = 'diff --git a/package.json b/package.json\n-    "lodash": "^4.17.20",\n+    "lodash": "^4.17.21",';
  assert.equal(detectScriptMutation(diff).mutated, false, "a dependency bump is not a script mutation");
});

// ── L4: greenfield tsconfig.json ──────────────────────────────────────────────

test("L4: greenfield tsconfig.json with 'new file mode' is NOT flagged for weakening keys", () => {
  const diff = [
    "diff --git a/tsconfig.json b/tsconfig.json",
    "new file mode 100644",
    "index 0000000..abc1234",
    "--- /dev/null",
    "+++ b/tsconfig.json",
    '+  "compilerOptions": {',
    '+    "strict": true,',
    '+    "skipLibCheck": true,',
    '+    "target": "ES2022"',
    "+  }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, false, "new file tsconfig with skipLibCheck should NOT be flagged — can't weaken what didn't exist");
});

test("L4: greenfield tsconfig.json with '--- /dev/null' (untracked) is NOT flagged for weakening keys", () => {
  const diff = [
    "diff --git a/tsconfig.json b/tsconfig.json",
    "--- /dev/null",
    "+++ b/tsconfig.json",
    '+  "compilerOptions": {',
    '+    "skipLibCheck": true',
    "+  }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, false, "untracked new tsconfig with skipLibCheck should NOT be flagged");
});

test("L4: MODIFIED tsconfig.json with weakening key IS still flagged", () => {
  const diff = [
    "diff --git a/tsconfig.json b/tsconfig.json",
    "--- a/tsconfig.json",
    "+++ b/tsconfig.json",
    '-  "skipLibCheck": false,',
    '+  "skipLibCheck": true,',
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, true, "changing skipLibCheck on an existing tsconfig IS a mutation");
});

test("L4: 'new file mode' detection sets isNewFile for guarded config files too", () => {
  // A new vitest.config.ts should NOT be flagged (can't weaken what didn't exist)
  const diff = [
    "diff --git a/vitest.config.ts b/vitest.config.ts",
    "new file mode 100644",
    "index 0000000..abc1234",
    "--- /dev/null",
    "+++ b/vitest.config.ts",
    "+export default { test: { include: ['**/*.test.ts'] } }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, false, "new vitest.config.ts should NOT be flagged");
});

// ── ISSUE 3: stub-script detector runs in LEGACY mode ────────────────────────

/** Build a verifier ctx whose workspace points at a real on-disk directory. */
function ctxAt(dir: string): RoleContext {
  const { ctx } = makeCtx();
  (ctx.workspace as { path: string }).path = dir;
  return ctx;
}

test("ISSUE-3 legacy: a stub test script ('echo ok') fails closed even though the checks exit 0", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-stub-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "echo ok" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "failure", "a no-op test script is not meaningful verification (legacy parity with the ladder)");
    const detail = result.detail as { verdict: string; reason?: string };
    assert.equal(detail.verdict, "fail");
    assert.match(result.summary ?? "", /stub test script/);
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("ISSUE-3 legacy: a --passWithNoTests test script is a stub → fails closed", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-stub2-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest --passWithNoTests" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "failure", "--passWithNoTests is a trivially-green stub");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("ISSUE-3 legacy: a REAL test script ('node --test') passes the stub guard", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-real-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "success", "a real test script is not flagged as a stub");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

// ── M6: the stub guard scans subpackages + test-lifecycle hooks, not just root "test" ──

test("M6: a SUBPACKAGE stub test script fails closed even when the root test is real", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-stub-sub-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "root", scripts: { test: "pnpm -r test" } }));
    _mkdirSync(_join(dir, "packages", "a"), { recursive: true });
    _writeFileSync(_join(dir, "packages", "a", "package.json"), JSON.stringify({ name: "a", scripts: { test: "echo ok" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "failure", "a stub test in a subpackage is a vacuous green the root-only guard missed");
    assert.match(result.summary ?? "", /stub test script/);
    assert.match(result.summary ?? "", /packages\/a\/package\.json/, "the offending subpackage is named");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("M6: a lifecycle-hook no-op ('pretest':'exit 0') fails closed even when 'test' is real", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-stub-hook-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { pretest: "exit 0", test: "node --test" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "failure", "a no-op planted on the test lifecycle is not meaningful verification");
    assert.match(result.summary ?? "", /stub pretest script/);
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("M6 (Codex): a setup hook ('pretest':'echo preparing') is NOT flagged — only HARD no-ops neuter the lifecycle", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-hook-setup-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { pretest: "echo preparing", test: "node --test" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "success", "an echo setup hook is legitimate work, not a stub that suppresses the real test");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("M6: a real monorepo (root + subpackage both real) is NOT falsely flagged", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-real-mono-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "root", scripts: { test: "pnpm -r test" } }));
    _mkdirSync(_join(dir, "packages", "a"), { recursive: true });
    _writeFileSync(_join(dir, "packages", "a", "package.json"), JSON.stringify({ name: "a", scripts: { test: "vitest run" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "success", "real test scripts in every package are not flagged");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

// ── ISSUE 4: the quality-gate wiring inside the verifier (checks pass → quality runs) ─

/** A verifier ctx at `dir` whose prior builder result declares the given written files. */
function ctxWithBuilt(dir: string, filesWritten: string[]): RoleContext {
  const ctx = ctxAt(dir);
  const builder: RoleResult = { role: "builder", outcome: "success", summary: "built", detail: { filesWritten } };
  (ctx as { priorResults: readonly RoleResult[] }).priorResults = [builder];
  return ctx;
}

test("ISSUE-4 quality gate: checks pass but a written STUB file → outcome failure", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-q-stub-"));
  try {
    _mkdirSync(_join(dir, "src"), { recursive: true });
    _writeFileSync(_join(dir, "src", "feature.ts"), "// TODO: implement this later\n");
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxWithBuilt(dir, ["src/feature.ts"]));
    assert.equal(result.outcome, "failure", "a stub file fails the post-check quality gate");
    const detail = result.detail as { verdict: string; qualityIssues?: { kind: string }[] };
    assert.equal(detail.verdict, "fail");
    assert.ok(detail.qualityIssues?.some((i) => i.kind === "stub_file"), "the stub_file quality issue is recorded");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("ISSUE-4 quality gate: checks pass but a written EMPTY file → outcome failure", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-q-empty-"));
  try {
    _mkdirSync(_join(dir, "src"), { recursive: true });
    _writeFileSync(_join(dir, "src", "empty.ts"), ""); // 0 bytes
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxWithBuilt(dir, ["src/empty.ts"]));
    assert.equal(result.outcome, "failure", "an empty file fails the post-check quality gate");
    const detail = result.detail as { qualityIssues?: { kind: string }[] };
    assert.ok(detail.qualityIssues?.some((i) => i.kind === "empty_file"), "the empty_file quality issue is recorded");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("ISSUE-4 quality gate: checks pass but a file written into node_modules → outcome failure", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-q-loc-"));
  try {
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxWithBuilt(dir, ["node_modules/evil/index.ts"]));
    assert.equal(result.outcome, "failure", "a write into a blocked directory fails the quality gate");
    const detail = result.detail as { qualityIssues?: { kind: string }[] };
    assert.ok(detail.qualityIssues?.some((i) => i.kind === "bad_location"), "the bad_location quality issue is recorded");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("ISSUE-4 quality gate: checks pass and a VALID written file → outcome success", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-q-ok-"));
  try {
    _mkdirSync(_join(dir, "src"), { recursive: true });
    _writeFileSync(_join(dir, "src", "good.ts"), "export const x = 1;\nexport function add(a: number, b: number) { return a + b; }\n");
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxWithBuilt(dir, ["src/good.ts"]));
    assert.equal(result.outcome, "success", "a real, non-empty, well-located file passes the quality gate");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

// ── Codex-3: the post-check quality gate ALSO fires in LADDER mode ────────────
// The ISSUE-4 tests above only cover legacy mode; the ladder path has its own quality wiring
// (runs after all runnable tasks pass). These exercise it with the SAME stub/empty/bad-location
// priorResults, asserting the gate fails the scope-stamped ladder green.

/** A LADDER-mode verifier whose injected plan yields one runnable (passing) check, so the post-check
 *  quality gate runs against the builder's prior filesWritten exactly as it does in legacy mode. */
function ladderQualityVerifier(exec: ReturnType<typeof execStub>) {
  const data: ProjectIndexData = { version: 1, repoPath: "/wt", repoHash: "h", files: [], packages: [], imports: [], fileToTests: {}, truncated: false };
  return createVerifier({
    governedExec: exec.governedExec,
    parentCtx: makeParentCtx(),
    diff: cleanDiff,
    env: { IKBI_VERIFY: "ladder" },
    index: { refresh: async () => ({ data }) },
    // One runnable task at the worktree root (cwd "") — the faked exec passes it, so control reaches
    // the quality gate. Mirrors the inline plan shape used by the ladder wiring tests.
    plan: () => ({
      status: "ok" as const, blocked: false, blockReasons: [], scope: "impact" as const,
      escalateToFull: false, escalationReasons: [], affectedPackages: [], affectedTests: [],
      neutralPackages: [], stubScripts: [],
      stages: [{ stage: "package-checks", tasks: [{ package: "", cwd: "", name: "test", command: "pnpm", args: ["test"], scope: "package", reason: "test" }] }],
      receipts: [],
    }),
  });
}

test("Codex-3 ladder quality gate: checks pass but a written STUB file → outcome failure", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-lq-stub-"));
  try {
    _mkdirSync(_join(dir, "src"), { recursive: true });
    _writeFileSync(_join(dir, "src", "feature.ts"), "// TODO: implement this later\n");
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await ladderQualityVerifier(exec)(ctxWithBuilt(dir, ["src/feature.ts"]));
    assert.equal(result.outcome, "failure", "a stub file fails the ladder post-check quality gate");
    const detail = result.detail as { verdict: string; verificationMode?: string; verificationScope?: string; qualityIssues?: { kind: string }[] };
    assert.equal(detail.verdict, "fail");
    assert.equal(detail.verificationMode, "ladder", "the failure is recorded as a ladder-mode result");
    assert.equal(detail.verificationScope, "impact", "the ladder quality failure keeps its scope stamp");
    assert.ok(detail.qualityIssues?.some((i) => i.kind === "stub_file"), "the stub_file quality issue is recorded");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex-3 ladder quality gate: checks pass but a written EMPTY file → outcome failure", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-lq-empty-"));
  try {
    _mkdirSync(_join(dir, "src"), { recursive: true });
    _writeFileSync(_join(dir, "src", "empty.ts"), ""); // 0 bytes
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await ladderQualityVerifier(exec)(ctxWithBuilt(dir, ["src/empty.ts"]));
    assert.equal(result.outcome, "failure", "an empty file fails the ladder post-check quality gate");
    const detail = result.detail as { qualityIssues?: { kind: string }[] };
    assert.ok(detail.qualityIssues?.some((i) => i.kind === "empty_file"), "the empty_file quality issue is recorded");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex-3 ladder quality gate: checks pass but a file written into node_modules → outcome failure", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-lq-loc-"));
  try {
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await ladderQualityVerifier(exec)(ctxWithBuilt(dir, ["node_modules/evil/index.ts"]));
    assert.equal(result.outcome, "failure", "a write into a blocked directory fails the ladder quality gate");
    const detail = result.detail as { qualityIssues?: { kind: string }[] };
    assert.ok(detail.qualityIssues?.some((i) => i.kind === "bad_location"), "the bad_location quality issue is recorded");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex-3 ladder quality gate: checks pass and a VALID written file → scope-stamped success", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-lq-ok-"));
  try {
    _mkdirSync(_join(dir, "src"), { recursive: true });
    _writeFileSync(_join(dir, "src", "good.ts"), "export const x = 1;\nexport function add(a: number, b: number) { return a + b; }\n");
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await ladderQualityVerifier(exec)(ctxWithBuilt(dir, ["src/good.ts"]));
    assert.equal(result.outcome, "success", "a real, non-empty, well-located file passes the ladder quality gate");
    const detail = result.detail as { verdict: string; verificationScope?: string };
    assert.equal(detail.verdict, "pass");
    assert.equal(detail.verificationScope, "impact", "a ladder green is scope-stamped");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fix 1: extractGoalFiles + detectShellOutMutation exclusion ────────────────────────────────

test("Fix1: extractGoalFiles — basic file extraction from goal", () => {
  const files = extractGoalFiles("Fix the failing test in test.js. The assertion is wrong.");
  assert.ok(files.has("test.js"), "plain test.js extracted from goal");
  assert.equal(files.size, 1);
});

test("Fix1: extractGoalFiles — multiple files in goal", () => {
  const files = extractGoalFiles("Fix add() in src/math.ts and the test in test.js");
  assert.ok(files.has("src/math.ts"), "path with separator extracted");
  assert.ok(files.has("test.js"), "plain filename extracted");
});

test("Fix1: extractGoalFiles — no files in goal", () => {
  const files = extractGoalFiles("Fix the add function so it returns the correct sum");
  assert.equal(files.size, 0, "no file-like tokens means empty set");
});

test("Fix1: extractGoalFiles — trailing period stripped", () => {
  const files = extractGoalFiles("Fix test.js. It produces wrong output.");
  assert.ok(files.has("test.js"), "trailing period is stripped from the filename");
});

test("Fix1: detectShellOutMutation — goal-excluded file NOT flagged", () => {
  withPkg({ test: "node --test test.js" }, (dir) => {
    const diff = "diff --git a/test.js b/test.js\n--- a/test.js\n+++ b/test.js\n@@ -1 +1 @@\n-assert.equal(mod(7,2), 0)\n+assert.equal(mod(7,2), 1)\n";
    // Without exclusion → flagged
    const flagged = detectShellOutMutation(diff, dir);
    assert.equal(flagged.mutated, true, "without exclusion the modification is flagged");
    // With goal-derived exclusion → clean
    const clean = detectShellOutMutation(diff, dir, new Set(["test.js"]));
    assert.equal(clean.mutated, false, "goal target file is excluded from shell-out mutation detection");
  });
});

test("Fix1: detectShellOutMutation — non-goal file still flagged even when exclusion set present", () => {
  withPkg({ test: "bash ./test.sh && node --test test.js" }, (dir) => {
    const diff = "diff --git a/test.sh b/test.sh\n--- a/test.sh\n+++ b/test.sh\n@@ -1 +1 @@\n-pnpm vitest run\n+exit 0\n";
    // test.js is in exclusion set but test.sh is not — test.sh still flagged
    const r = detectShellOutMutation(diff, dir, new Set(["test.js"]));
    assert.equal(r.mutated, true, "a non-excluded shell-out helper is still guarded");
    assert.match(r.reason ?? "", /test\.sh/);
  });
});

// ── Fix A / Fix D: createVerifier e2e — goal-derived exclusion constrained to test files ─────────
// These tests prove the FULL PATH: createVerifier() extracts ctx.task.goal → filters to test files
// only (Fix A) → passes exclusion to detectShellOutMutation → verification proceeds correctly.

test("FIX-D e2e: createVerifier — goal naming a .test.ts file does NOT cause untrusted (editing tests is the build)", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-goal-e2e-test-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "r", scripts: { test: "node --test engine/ledger.test.ts" } }));
    const diff = "diff --git a/engine/ledger.test.ts b/engine/ledger.test.ts\n--- a/engine/ledger.test.ts\n+++ b/engine/ledger.test.ts\n@@ -1 +1,2 @@\n test('x', () => {});\n+test('y', () => {});\n";
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const ctx = ctxAt(dir);
    (ctx.task as { goal: string }).goal = "Fix the failing assertion in engine/ledger.test.ts";
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: async () => diff })(ctx);
    const detail = (result.detail ?? {}) as Record<string, unknown>;
    assert.notEqual(detail.verdict, "untrusted", "modifying a .test.ts file named in the goal must NOT trigger untrusted");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("FIX-D / Fix A e2e: createVerifier — goal naming a NON-test shell helper STILL causes untrusted (helpers stay guarded)", async () => {
  // The goal mentions test-runner.sh — a shell helper, not a .test./.spec. file.
  // Fix A: the goal-derived exclusion only applies to test files, so this helper remains guarded.
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-goal-e2e-sh-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "r", scripts: { test: "bash ./test-runner.sh" } }));
    const diff = "diff --git a/test-runner.sh b/test-runner.sh\n--- a/test-runner.sh\n+++ b/test-runner.sh\n@@ -1 +1 @@\n-pnpm vitest run\n+exit 0\n";
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const ctx = ctxAt(dir);
    // goal names the shell helper — but it's not a .test./.spec. file → Fix A keeps it guarded
    (ctx.task as { goal: string }).goal = "Fix test-runner.sh to use the new framework";
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: async () => diff })(ctx);
    const detail = (result.detail ?? {}) as Record<string, unknown>;
    assert.equal(detail.verdict, "untrusted", "a non-test shell helper mentioned in the goal must remain guarded (Fix A)");
    assert.match(result.summary ?? "", /untrusted/);
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});
